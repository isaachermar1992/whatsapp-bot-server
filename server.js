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

let sock = null;
let currentQR = null;
let isConnected = false;
let phoneInfo = null;
let reconnectAttempts = 0;
let isStarting = false;
const MAX_RECONNECT = 5;
const AUTH_DIR = "./auth_info";

const logger = pino({ level: "silent" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

const botConfig = {
  enabled: true,
  model: "gpt-4o",
  temperature: 0.7,
  systemPrompt: process.env.BOT_SYSTEM_PROMPT || "Eres un asistente virtual amable y profesional de una empresa mexicana. Responde de manera clara, concisa y en español. Si no sabes algo, dilo honestamente. Usa emojis moderadamente.",
  welcomeMessage: process.env.BOT_WELCOME_MESSAGE || "¡Hola! 👋 Soy un asistente virtual. ¿En qué puedo ayudarte?",
};

const conversationHistory = new Map();
const MAX_HISTORY = 20;
const processedMessages = new Set();

function clearAuthState() {
  console.log("[SERVER] Limpiando sesion...");
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    console.log("[SERVER] Sesion limpiada");
  } catch (e) {
    console.error("[SERVER] Error limpiando sesion:", e.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAIResponse(sender, message) {
  if (!openai.apiKey) {
    console.log("[BOT] No OpenAI API key configured");
    return "Lo siento, el bot no está configurado correctamente. Contacta al administrador.";
  }

  try {
    let history = conversationHistory.get(sender) || [];

    history.push({ role: "user", content: message });

    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }

    conversationHistory.set(sender, history);

    const messages = [
      { role: "system", content: botConfig.systemPrompt },
      ...history,
    ];

    console.log("[BOT] Generando respuesta para", sender.split("@")[0]);
    console.log("[BOT] Modelo:", botConfig.model);
    console.log("[BOT] API Key (primeros 8 chars):", openai.apiKey ? openai.apiKey.substring(0, 8) + "..." : "NONE");
    console.log("[BOT] Mensajes en historial:", messages.length);

    const completion = await openai.chat.completions.create({
      model: botConfig.model,
      messages,
      temperature: botConfig.temperature,
      max_tokens: 500,
    });

    console.log("[BOT] OpenAI response received, choices:", completion.choices?.length);

    const reply = completion.choices[0]?.message?.content;

    if (reply) {
      history.push({ role: "assistant", content: reply });
      conversationHistory.set(sender, history);
      console.log("[BOT] Respuesta generada:", reply.substring(0, 80) + "...");
    } else {
      console.error("[BOT] OpenAI devolvio respuesta vacia. Full response:", JSON.stringify(completion).substring(0, 500));
      return "Disculpa, no pude procesar tu mensaje. Intenta de nuevo.";
    }

    return reply;
  } catch (error) {
    console.error("[BOT] Error OpenAI completo:", error.message);
    console.error("[BOT] Error tipo:", error.constructor?.name);
    console.error("[BOT] Error status:", error.status || "N/A");
    console.error("[BOT] Error code:", error.code || "N/A");
    if (error.response) {
      console.error("[BOT] Error response data:", JSON.stringify(error.response.data || {}).substring(0, 500));
    }
    return "Lo siento, ocurrió un error al procesar tu mensaje. Intenta de nuevo en un momento.";
  }
}

async function startWhatsApp() {
  if (isStarting) {
    console.log("[SERVER] Ya se esta iniciando, ignorando...");
    return;
  }

  isStarting = true;

  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log("[SERVER] WA version:", version.join("."));

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      version,
      logger,
      browser: ["WA Bot Server", "Chrome", "22.0"],
      connectTimeoutMs: 60000,
      qrTimeout: 40000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 500,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[SERVER] QR recibido - generando imagen...");
        try {
          currentQR = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          console.log("[SERVER] QR generado OK");
        } catch (e) {
          console.error("[SERVER] Error generando QR:", e.message);
        }
      }

      if (connection === "open") {
        console.log("[SERVER] ✅ CONECTADO a WhatsApp!");
        isConnected = true;
        isStarting = false;
        currentQR = null;
        phoneInfo = sock.user;
        reconnectAttempts = 0;
        console.log("[SERVER] Usuario:", phoneInfo?.id, phoneInfo?.name);
      }

      if (connection === "close") {
        isConnected = false;
        isStarting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.message || "unknown";
        console.log("[SERVER] Conexion cerrada - codigo:", code, "razon:", reason);

        if (code === DisconnectReason.loggedOut || code === 401) {
          console.log("[SERVER] Sesion cerrada por el usuario");
          clearAuthState();
          phoneInfo = null;
          currentQR = null;
          reconnectAttempts = 0;
          await sleep(5000);
          startWhatsApp();
        } else if (code === 405) {
          console.log("[SERVER] Error 405 - sesion corrupta");
          clearAuthState();
          phoneInfo = null;
          currentQR = null;
          reconnectAttempts++;

          const delay = Math.min(15000 + (reconnectAttempts * 10000), 120000);
          console.log("[SERVER] Esperando", delay / 1000, "s antes de reiniciar (intento", reconnectAttempts, ")");
          await sleep(delay);

          if (reconnectAttempts <= MAX_RECONNECT) {
            startWhatsApp();
          } else {
            console.log("[SERVER] Maximo reintentos 405 alcanzado. Esperando 5 minutos...");
            reconnectAttempts = 0;
            await sleep(300000);
            startWhatsApp();
          }
        } else if (code === 515 || code === 408 || code === 503) {
          console.log("[SERVER] Error temporal, reconectando...");
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 60000);
          await sleep(delay);
          if (reconnectAttempts <= MAX_RECONNECT) {
            startWhatsApp();
          } else {
            console.log("[SERVER] Maximo reintentos alcanzado. Limpiando...");
            clearAuthState();
            reconnectAttempts = 0;
            await sleep(60000);
            startWhatsApp();
          }
        } else {
          reconnectAttempts++;
          if (reconnectAttempts <= MAX_RECONNECT) {
            const delay = Math.min(5000 * reconnectAttempts, 60000);
            console.log("[SERVER] Reconectando en", delay / 1000, "s (intento", reconnectAttempts, ")");
            await sleep(delay);
            startWhatsApp();
          } else {
            console.log("[SERVER] Maximo reintentos. Esperando 3 minutos...");
            clearAuthState();
            reconnectAttempts = 0;
            await sleep(180000);
            startWhatsApp();
          }
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log("[MSG] messages.upsert tipo:", type, "cantidad:", messages.length);

      for (const msg of messages) {
        console.log("[MSG] Raw key:", JSON.stringify(msg.key));
        console.log("[MSG] fromMe:", msg.key.fromMe, "hasMessage:", !!msg.message);
        if (msg.message) {
          console.log("[MSG] Tipos de mensaje:", Object.keys(msg.message).join(", "));
        }

        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const msgId = msg.key.id;
        if (processedMessages.has(msgId)) {
          console.log("[MSG] Mensaje ya procesado:", msgId);
          continue;
        }
        processedMessages.add(msgId);

        if (processedMessages.size > 1000) {
          const entries = Array.from(processedMessages);
          entries.slice(0, 500).forEach((id) => processedMessages.delete(id));
        }

        const sender = msg.key.remoteJid;
        if (!sender || sender.endsWith("@g.us") || sender === "status@broadcast") {
          console.log("[MSG] Ignorado - sender:", sender);
          continue;
        }

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

        if (!text.trim()) {
          console.log("[MSG] Sin texto extraible del mensaje");
          continue;
        }

        console.log("[MSG] De:", sender.split("@")[0], "Texto:", text.substring(0, 100));

        if (botConfig.enabled && openai.apiKey) {
          try {
            await sock.readMessages([msg.key]);
          } catch (_) {}

          try {
            await sock.sendPresenceUpdate("composing", sender);
          } catch (_) {}

          const reply = await getAIResponse(sender, text);

          try {
            await sock.sendPresenceUpdate("paused", sender);
          } catch (_) {}

          if (reply && sock && isConnected) {
            try {
              console.log("[MSG] Intentando enviar respuesta a", sender.split("@")[0], "- longitud:", reply.length);
              await sock.sendMessage(sender, { text: reply });
              console.log("[MSG] ✅ Respuesta enviada exitosamente a", sender.split("@")[0]);
            } catch (e) {
              console.error("[MSG] ❌ Error enviando respuesta:", e.message);
              console.error("[MSG] Error stack:", e.stack?.substring(0, 300));
            }
          } else {
            console.error("[MSG] No se pudo enviar - reply:", !!reply, "sock:", !!sock, "connected:", isConnected);
          }
        }
      }
    });
  } catch (error) {
    console.error("[SERVER] ERROR FATAL:", error.message);
    isStarting = false;
    reconnectAttempts++;
    const delay = Math.min(15000 * reconnectAttempts, 120000);
    console.log("[SERVER] Reintentando en", delay / 1000, "s...");
    await sleep(delay);
    if (reconnectAttempts <= MAX_RECONNECT) {
      startWhatsApp();
    } else {
      console.log("[SERVER] Demasiados errores fatales. Esperando 5 minutos...");
      reconnectAttempts = 0;
      await sleep(300000);
      startWhatsApp();
    }
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    connected: isConnected,
    uptime: Math.floor(process.uptime()),
    botEnabled: botConfig.enabled,
    hasOpenAI: !!openai.apiKey,
  });
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, qr: null });
  }
  if (currentQR) {
    return res.json({ qr: currentQR, connected: false });
  }
  return res.json({ qr: null, connected: false, message: "Esperando QR... intenta en unos segundos" });
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    phoneNumber: phoneInfo?.id?.split(":")[0] || null,
    name: phoneInfo?.name || null,
    reconnectAttempts,
    botEnabled: botConfig.enabled,
    hasOpenAI: !!openai.apiKey,
  });
});

app.post("/send", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp no conectado" });
  }
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: "Falta number o message" });
  }
  try {
    const jid = number.includes("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log("[API] Mensaje enviado a", jid);
    res.json({ ok: true });
  } catch (e) {
    console.error("[API] Error enviando:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/bot/config", (req, res) => {
  const { enabled, systemPrompt, welcomeMessage, model, temperature } = req.body;
  if (typeof enabled === "boolean") botConfig.enabled = enabled;
  if (systemPrompt) botConfig.systemPrompt = systemPrompt;
  if (welcomeMessage) botConfig.welcomeMessage = welcomeMessage;
  if (model) botConfig.model = model;
  if (typeof temperature === "number") botConfig.temperature = temperature;
  console.log("[API] Bot config actualizada:", JSON.stringify(botConfig).substring(0, 200));
  res.json({ ok: true, config: botConfig });
});

app.get("/bot/config", (req, res) => {
  res.json(botConfig);
});

app.post("/disconnect", async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
  } catch (_) {}
  clearAuthState();
  isConnected = false;
  phoneInfo = null;
  currentQR = null;
  conversationHistory.clear();
  res.json({ ok: true });
  setTimeout(startWhatsApp, 3000);
});

app.get("/test-ai", async (req, res) => {
  try {
    console.log("[TEST] Probando OpenAI...");
    console.log("[TEST] API Key presente:", !!openai.apiKey);
    console.log("[TEST] API Key (primeros 8):", openai.apiKey ? openai.apiKey.substring(0, 8) + "..." : "NONE");
    console.log("[TEST] Modelo:", botConfig.model);

    if (!openai.apiKey) {
      return res.json({ ok: false, error: "No API key configured", apiKey: false });
    }

    const start = Date.now();
    const completion = await openai.chat.completions.create({
      model: botConfig.model,
      messages: [
        { role: "system", content: "Responde solo: OK" },
        { role: "user", content: "Test" },
      ],
      max_tokens: 10,
    });
    const elapsed = Date.now() - start;

    const reply = completion.choices[0]?.message?.content;
    console.log("[TEST] Respuesta:", reply, "en", elapsed, "ms");

    res.json({
      ok: true,
      reply,
      model: botConfig.model,
      elapsed: elapsed + "ms",
      apiKeyPrefix: openai.apiKey.substring(0, 8) + "...",
    });
  } catch (error) {
    console.error("[TEST] Error:", error.message);
    res.json({
      ok: false,
      error: error.message,
      status: error.status || null,
      code: error.code || null,
      type: error.constructor?.name,
    });
  }
});

app.get("/conversations", (req, res) => {
  const conversations = [];
  for (const [sender, history] of conversationHistory.entries()) {
    const phone = sender.split("@")[0];
    const lastMsg = history[history.length - 1];
    conversations.push({
      id: sender,
      contactPhone: phone,
      contactName: phone,
      lastMessage: lastMsg?.content || "",
      lastMessageAt: new Date().toISOString(),
      messageCount: history.length,
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
  res.json({ conversations, total: conversations.length });
});

app.get("/logs", (req, res) => {
  res.json({
    connected: isConnected,
    botEnabled: botConfig.enabled,
    hasOpenAI: !!openai.apiKey,
    apiKeyPrefix: openai.apiKey ? openai.apiKey.substring(0, 8) + "..." : "NONE",
    model: botConfig.model,
    systemPromptLength: botConfig.systemPrompt?.length || 0,
    activeConversations: conversationHistory.size,
    processedMessages: processedMessages.size,
    phoneInfo: phoneInfo ? { id: phoneInfo.id, name: phoneInfo.name } : null,
  });
});

app.post("/restart", async (req, res) => {
  try {
    if (sock) {
      sock.end(undefined);
    }
  } catch (_) {}
  clearAuthState();
  isConnected = false;
  isStarting = false;
  phoneInfo = null;
  currentQR = null;
  reconnectAttempts = 0;
  conversationHistory.clear();
  res.json({ ok: true, message: "Reiniciando..." });
  await sleep(3000);
  startWhatsApp();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("[SERVER] Corriendo en puerto", PORT);
  console.log("[SERVER] OpenAI API key:", openai.apiKey ? "configurada ✅" : "NO configurada ❌");
  console.log("[SERVER] Bot:", botConfig.enabled ? "activo ✅" : "desactivado ❌");
  startWhatsApp();
});
