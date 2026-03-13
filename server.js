const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");
const pino = require("pino");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: "silent" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

const defaultBotConfig = {
  enabled: true,
  model: "gpt-4o",
  temperature: 0.7,
  systemPrompt: process.env.BOT_SYSTEM_PROMPT || "Eres un asistente virtual amable y profesional de una empresa mexicana. Responde de manera clara, concisa y en español. Si no sabes algo, dilo honestamente. Usa emojis moderadamente.",
  welcomeMessage: process.env.BOT_WELCOME_MESSAGE || "¡Hola! 👋 Soy un asistente virtual. ¿En qué puedo ayudarte?",
};

const sessions = new Map();
const MAX_RECONNECT = 5;
const MAX_HISTORY = 20;

function getSession(sessionId) {
  if (!sessionId) sessionId = "default";
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sock: null,
      currentQR: null,
      isConnected: false,
      phoneInfo: null,
      reconnectAttempts: 0,
      isStarting: false,
      conversationHistory: new Map(),
      processedMessages: new Set(),
      botConfig: { ...defaultBotConfig },
      authDir: `./auth_info_${sessionId}`,
    });
  }
  return sessions.get(sessionId);
}

function clearAuthState(session) {
  console.log(`[SERVER][${session.authDir}] Limpiando sesion...`);
  try {
    if (fs.existsSync(session.authDir)) {
      fs.rmSync(session.authDir, { recursive: true, force: true });
    }
    console.log(`[SERVER] Sesion limpiada`);
  } catch (e) {
    console.error(`[SERVER] Error limpiando sesion:`, e.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAIResponse(session, sender, message) {
  if (!openai.apiKey) {
    console.log("[BOT] No OpenAI API key configured");
    return "Lo siento, el bot no está configurado correctamente. Contacta al administrador.";
  }

  try {
    let history = session.conversationHistory.get(sender) || [];
    history.push({ role: "user", content: message });

    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }

    session.conversationHistory.set(sender, history);

    const messages = [
      { role: "system", content: session.botConfig.systemPrompt },
      ...history,
    ];

    console.log("[BOT] Generando respuesta para", sender.split("@")[0]);

    const completion = await openai.chat.completions.create({
      model: session.botConfig.model,
      messages,
      temperature: session.botConfig.temperature,
      max_tokens: 500,
    });

    const reply = completion.choices[0]?.message?.content;

    if (reply) {
      history.push({ role: "assistant", content: reply });
      session.conversationHistory.set(sender, history);
      console.log("[BOT] Respuesta generada:", reply.substring(0, 80) + "...");
    } else {
      return "Disculpa, no pude procesar tu mensaje. Intenta de nuevo.";
    }

    return reply;
  } catch (error) {
    console.error("[BOT] Error OpenAI:", error.message);
    return "Lo siento, ocurrió un error al procesar tu mensaje. Intenta de nuevo en un momento.";
  }
}

async function startWhatsApp(sessionId) {
  if (!sessionId) sessionId = "default";
  const session = getSession(sessionId);

  if (session.isStarting) {
    console.log(`[SERVER][${sessionId}] Ya se esta iniciando, ignorando...`);
    return;
  }

  session.isStarting = true;

  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[SERVER][${sessionId}] WA version:`, version.join("."));

    const { state, saveCreds } = await useMultiFileAuthState(session.authDir);

    session.sock = makeWASocket({
      auth: state,
      version,
      logger,
      browser: [`WA Bot ${sessionId}`, "Chrome", "22.0"],
      connectTimeoutMs: 60000,
      qrTimeout: 40000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 500,
      markOnlineOnConnect: false,
    });

    session.sock.ev.on("creds.update", saveCreds);

    session.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[SERVER][${sessionId}] QR recibido - generando imagen...`);
        try {
          session.currentQR = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          console.log(`[SERVER][${sessionId}] QR generado OK`);
        } catch (e) {
          console.error(`[SERVER][${sessionId}] Error generando QR:`, e.message);
        }
      }

      if (connection === "open") {
        console.log(`[SERVER][${sessionId}] ✅ CONECTADO a WhatsApp!`);
        session.isConnected = true;
        session.isStarting = false;
        session.currentQR = null;
        session.phoneInfo = session.sock.user;
        session.reconnectAttempts = 0;
        console.log(`[SERVER][${sessionId}] Usuario:`, session.phoneInfo?.id, session.phoneInfo?.name);
      }

      if (connection === "close") {
        session.isConnected = false;
        session.isStarting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.message || "unknown";
        console.log(`[SERVER][${sessionId}] Conexion cerrada - codigo:`, code, "razon:", reason);

        if (code === DisconnectReason.loggedOut || code === 401) {
          console.log(`[SERVER][${sessionId}] Sesion cerrada por el usuario`);
          clearAuthState(session);
          session.phoneInfo = null;
          session.currentQR = null;
          session.reconnectAttempts = 0;
          await sleep(5000);
          startWhatsApp(sessionId);
        } else if (code === 405) {
          clearAuthState(session);
          session.phoneInfo = null;
          session.currentQR = null;
          session.reconnectAttempts++;
          const delay = Math.min(15000 + (session.reconnectAttempts * 10000), 120000);
          await sleep(delay);
          if (session.reconnectAttempts <= MAX_RECONNECT) {
            startWhatsApp(sessionId);
          } else {
            session.reconnectAttempts = 0;
            await sleep(300000);
            startWhatsApp(sessionId);
          }
        } else if (code === 515 || code === 408 || code === 503) {
          session.reconnectAttempts++;
          const delay = Math.min(5000 * session.reconnectAttempts, 60000);
          await sleep(delay);
          if (session.reconnectAttempts <= MAX_RECONNECT) {
            startWhatsApp(sessionId);
          } else {
            clearAuthState(session);
            session.reconnectAttempts = 0;
            await sleep(60000);
            startWhatsApp(sessionId);
          }
        } else {
          session.reconnectAttempts++;
          if (session.reconnectAttempts <= MAX_RECONNECT) {
            const delay = Math.min(5000 * session.reconnectAttempts, 60000);
            await sleep(delay);
            startWhatsApp(sessionId);
          } else {
            clearAuthState(session);
            session.reconnectAttempts = 0;
            await sleep(180000);
            startWhatsApp(sessionId);
          }
        }
      }
    });

    session.sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
      console.log(`[MSG][${sessionId}] messages.upsert tipo:`, type, "cantidad:", msgs.length);

      for (const msg of msgs) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const msgId = msg.key.id;
        if (session.processedMessages.has(msgId)) continue;
        session.processedMessages.add(msgId);

        if (session.processedMessages.size > 1000) {
          const entries = Array.from(session.processedMessages);
          entries.slice(0, 500).forEach((id) => session.processedMessages.delete(id));
        }

        const sender = msg.key.remoteJid;
        if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast") continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.templateMessage?.hydratedTemplate?.hydratedContentText ||
          msg.message?.buttonsResponseMessage?.selectedDisplayText ||
          msg.message?.listResponseMessage?.title ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          "";

        if (!text.trim()) continue;

        console.log(`[MSG][${sessionId}] De:`, sender.split("@")[0], "Texto:", text.substring(0, 100));

        if (session.botConfig.enabled && openai.apiKey) {
          try { await session.sock.readMessages([msg.key]); } catch (_) {}
          try { await session.sock.sendPresenceUpdate("composing", sender); } catch (_) {}

          const reply = await getAIResponse(session, sender, text);

          try { await session.sock.sendPresenceUpdate("paused", sender); } catch (_) {}

          if (reply && session.sock && session.isConnected) {
            try {
              await session.sock.sendMessage(sender, { text: reply });
              console.log(`[MSG][${sessionId}] ✅ Respuesta enviada a`, sender.split("@")[0]);
            } catch (e) {
              console.error(`[MSG][${sessionId}] ❌ Error enviando:`, e.message);
            }
          }
        }
      }
    });
  } catch (error) {
    console.error(`[SERVER][${sessionId}] ERROR FATAL:`, error.message);
    session.isStarting = false;
    session.reconnectAttempts++;
    const delay = Math.min(15000 * session.reconnectAttempts, 120000);
    await sleep(delay);
    if (session.reconnectAttempts <= MAX_RECONNECT) {
      startWhatsApp(sessionId);
    } else {
      session.reconnectAttempts = 0;
      await sleep(300000);
      startWhatsApp(sessionId);
    }
  }
}

function getSessionId(req) {
  return req.query.session || req.body?.session || "default";
}

app.get("/", (req, res) => {
  const sessionList = [];
  for (const [id, s] of sessions.entries()) {
    sessionList.push({
      id,
      connected: s.isConnected,
      phone: s.phoneInfo?.id?.split(":")[0] || null,
      name: s.phoneInfo?.name || null,
      botEnabled: s.botConfig.enabled,
    });
  }
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    hasOpenAI: !!openai.apiKey,
    sessions: sessionList,
    totalSessions: sessions.size,
  });
});

app.get("/sessions", (req, res) => {
  const sessionList = [];
  for (const [id, s] of sessions.entries()) {
    sessionList.push({
      id,
      connected: s.isConnected,
      phoneNumber: s.phoneInfo?.id?.split(":")[0] || null,
      name: s.phoneInfo?.name || null,
      botEnabled: s.botConfig.enabled,
      hasOpenAI: !!openai.apiKey,
      activeConversations: s.conversationHistory.size,
    });
  }
  res.json({ sessions: sessionList, total: sessionList.length });
});

app.post("/session/create", async (req, res) => {
  const sessionId = req.body.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId requerido" });
  }
  const session = getSession(sessionId);
  if (!session.isConnected && !session.isStarting) {
    startWhatsApp(sessionId);
  }
  res.json({ ok: true, sessionId });
});

app.get("/qr", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);

  if (session.isConnected) {
    return res.json({ connected: true, qr: null, sessionId });
  }

  if (!session.isStarting && !session.sock) {
    startWhatsApp(sessionId);
    return res.json({ qr: null, connected: false, sessionId, message: "Iniciando sesión... intenta en unos segundos" });
  }

  if (session.currentQR) {
    return res.json({ qr: session.currentQR, connected: false, sessionId });
  }

  return res.json({ qr: null, connected: false, sessionId, message: "Esperando QR... intenta en unos segundos" });
});

app.get("/status", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  res.json({
    connected: session.isConnected,
    phoneNumber: session.phoneInfo?.id?.split(":")[0] || null,
    name: session.phoneInfo?.name || null,
    reconnectAttempts: session.reconnectAttempts,
    botEnabled: session.botConfig.enabled,
    hasOpenAI: !!openai.apiKey,
    sessionId,
  });
});

app.post("/send", async (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);

  if (!session.isConnected || !session.sock) {
    return res.status(503).json({ error: "WhatsApp no conectado para esta sesión" });
  }
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: "Falta number o message" });
  }
  try {
    const jid = number.includes("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/bot/config", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  const { enabled, systemPrompt, welcomeMessage, model, temperature } = req.body;
  if (typeof enabled === "boolean") session.botConfig.enabled = enabled;
  if (systemPrompt) session.botConfig.systemPrompt = systemPrompt;
  if (welcomeMessage) session.botConfig.welcomeMessage = welcomeMessage;
  if (model) session.botConfig.model = model;
  if (typeof temperature === "number") session.botConfig.temperature = temperature;
  res.json({ ok: true, config: session.botConfig, sessionId });
});

app.get("/bot/config", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  res.json({ ...session.botConfig, sessionId });
});

app.post("/disconnect", async (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  try {
    if (session.sock) {
      await session.sock.logout();
    }
  } catch (_) {}
  clearAuthState(session);
  session.isConnected = false;
  session.isStarting = false;
  session.phoneInfo = null;
  session.currentQR = null;
  session.conversationHistory.clear();
  session.processedMessages.clear();
  res.json({ ok: true, sessionId });
  setTimeout(() => startWhatsApp(sessionId), 3000);
});

app.get("/conversations", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  const conversations = [];
  for (const [sender, history] of session.conversationHistory.entries()) {
    const phone = sender.split("@")[0];
    const lastMsg = history[history.length - 1];
    conversations.push({
      id: sender,
      contactPhone: phone,
      contactName: phone,
      lastMessage: lastMsg?.content || "",
      lastMessageAt: new Date().toISOString(),
      messageCount: history.length,
      sessionId,
      messages: history.map((m, i) => ({
        id: `${sender}_${i}`,
        content: m.content,
        sender: m.role === "user" ? "user" : "bot",
        timestamp: new Date().toISOString(),
        type: "text",
        isRead: true,
      })),
    });
  }
  conversations.sort((a, b) => b.messageCount - a.messageCount);
  res.json({ conversations, total: conversations.length, sessionId });
});

app.get("/conversations/all", (req, res) => {
  const allConversations = [];
  for (const [sessionId, session] of sessions.entries()) {
    for (const [sender, history] of session.conversationHistory.entries()) {
      const phone = sender.split("@")[0];
      const lastMsg = history[history.length - 1];
      allConversations.push({
        id: `${sessionId}_${sender}`,
        contactPhone: phone,
        contactName: phone,
        lastMessage: lastMsg?.content || "",
        lastMessageAt: new Date().toISOString(),
        messageCount: history.length,
        sessionId,
        messages: history.map((m, i) => ({
          id: `${sender}_${i}`,
          content: m.content,
          sender: m.role === "user" ? "user" : "bot",
          timestamp: new Date().toISOString(),
          type: "text",
          isRead: true,
        })),
      });
    }
  }
  allConversations.sort((a, b) => b.messageCount - a.messageCount);
  res.json({ conversations: allConversations, total: allConversations.length });
});

app.get("/test-ai", async (req, res) => {
  try {
    if (!openai.apiKey) {
      return res.json({ ok: false, error: "No API key configured", apiKey: false });
    }
    const start = Date.now();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Responde solo: OK" },
        { role: "user", content: "Test" },
      ],
      max_tokens: 10,
    });
    const elapsed = Date.now() - start;
    const reply = completion.choices[0]?.message?.content;
    res.json({ ok: true, reply, elapsed: elapsed + "ms" });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/logs", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  res.json({
    connected: session.isConnected,
    botEnabled: session.botConfig.enabled,
    hasOpenAI: !!openai.apiKey,
    model: session.botConfig.model,
    activeConversations: session.conversationHistory.size,
    processedMessages: session.processedMessages.size,
    phoneInfo: session.phoneInfo ? { id: session.phoneInfo.id, name: session.phoneInfo.name } : null,
    sessionId,
  });
});

app.post("/restart", async (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  try {
    if (session.sock) {
      session.sock.end(undefined);
    }
  } catch (_) {}
  clearAuthState(session);
  session.isConnected = false;
  session.isStarting = false;
  session.phoneInfo = null;
  session.currentQR = null;
  session.reconnectAttempts = 0;
  session.conversationHistory.clear();
  session.processedMessages.clear();
  res.json({ ok: true, sessionId, message: "Reiniciando..." });
  await sleep(3000);
  startWhatsApp(sessionId);
});

app.delete("/session/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  try {
    if (session.sock) {
      await session.sock.logout();
    }
  } catch (_) {}
  clearAuthState(session);
  sessions.delete(sessionId);
  res.json({ ok: true, sessionId, message: "Sesión eliminada" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("[SERVER] Corriendo en puerto", PORT);
  console.log("[SERVER] OpenAI API key:", openai.apiKey ? "configurada ✅" : "NO configurada ❌");
  console.log("[SERVER] Multi-session mode enabled");
  startWhatsApp("default");
});
