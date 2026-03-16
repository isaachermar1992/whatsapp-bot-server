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
  timeout: 30000,
  maxRetries: 0,
});

const defaultBotConfig = {
  enabled: true,
  model: "gpt-4o",
  temperature: 0.7,
  systemPrompt: process.env.BOT_SYSTEM_PROMPT || "Eres un asistente virtual amable y profesional de una empresa mexicana. Responde de manera clara, concisa y en español. Si no sabes algo, dilo honestamente. Usa emojis moderadamente.",
  welcomeMessage: process.env.BOT_WELCOME_MESSAGE || "¡Hola! 👋 Soy un asistente virtual. ¿En qué puedo ayudarte?",
};

const sessions = new Map();
const MAX_SESSIONS = 20;
const MAX_RECONNECT = 5;
const MAX_NETWORK_RECONNECT = 15;
const FALLBACK_WA_VERSION = [2, 3000, 1015901307];
const MAX_HISTORY = 15;
const MAX_QR_ATTEMPTS = 5;
const MAX_PROCESSED_MESSAGES = 500;
const CLEANUP_THRESHOLD = 300;
const DISABLED_CONTACTS_FILE = "./disabled_contacts.json";

function loadDisabledContactsFromFile() {
  try {
    if (fs.existsSync(DISABLED_CONTACTS_FILE)) {
      const data = fs.readFileSync(DISABLED_CONTACTS_FILE, "utf8");
      const parsed = JSON.parse(data);
      console.log("[PERSIST] Loaded disabled contacts from file:", JSON.stringify(parsed));
      return parsed;
    }
  } catch (e) {
    console.error("[PERSIST] Error loading disabled contacts:", e.message);
  }
  return {};
}

function saveDisabledContactsToFile() {
  try {
    const allDisabled = {};
    for (const [sid, session] of sessions.entries()) {
      if (session.disabledContacts.size > 0) {
        allDisabled[sid] = Array.from(session.disabledContacts);
      }
    }
    fs.writeFileSync(DISABLED_CONTACTS_FILE, JSON.stringify(allDisabled, null, 2));
    console.log("[PERSIST] Saved disabled contacts to file:", JSON.stringify(allDisabled));
  } catch (e) {
    console.error("[PERSIST] Error saving disabled contacts:", e.message);
  }
}

function restoreDisabledContactsForSession(sessionId, session) {
  try {
    const allDisabled = loadDisabledContactsFromFile();
    if (allDisabled[sessionId] && Array.isArray(allDisabled[sessionId])) {
      for (const phone of allDisabled[sessionId]) {
        session.disabledContacts.add(phone);
      }
      console.log(`[PERSIST][${sessionId}] Restored ${session.disabledContacts.size} disabled contacts from file`);
    }
  } catch (e) {
    console.error(`[PERSIST][${sessionId}] Error restoring disabled contacts:`, e.message);
  }
}

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
      reconnectLocked: false,
      qrAttempts: 0,
      conversationHistory: new Map(),
      processedMessages: new Set(),
      botConfig: { ...defaultBotConfig },
      disabledContacts: new Set(),
      authDir: `./auth_info_${sessionId}`,
    });
    restoreDisabledContactsForSession(sessionId, sessions.get(sessionId));
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

const botConfigBackup = new Map();

function backupBotConfig(sessionId, config) {
  if (config && config.systemPrompt && config.systemPrompt !== defaultBotConfig.systemPrompt) {
    botConfigBackup.set(sessionId, { ...config });
    console.log(`[CONFIG][${sessionId}] Bot config backed up (prompt: ${config.systemPrompt.length} chars)`);
  }
}

function restoreBotConfig(sessionId, session) {
  const backup = botConfigBackup.get(sessionId);
  if (backup && backup.systemPrompt && backup.systemPrompt !== defaultBotConfig.systemPrompt) {
    if (!session.botConfig.systemPrompt || session.botConfig.systemPrompt === defaultBotConfig.systemPrompt) {
      session.botConfig = { ...backup };
      console.log(`[CONFIG][${sessionId}] Bot config restored from backup (prompt: ${backup.systemPrompt.length} chars)`);
    }
  }
}

async function callOpenAIWithRetry(activeClient, params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const completion = await activeClient.chat.completions.create(
        params,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      return completion;
    } catch (error) {
      const isAbort = error.name === "AbortError" || error.message?.includes("aborted") || error.message?.includes("abort");
      const isTimeout = error.message?.includes("timeout") || error.message?.includes("ETIMEDOUT") || error.code === "ETIMEDOUT";
      const isRetryable = isAbort || isTimeout || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 429;
      
      console.error(`[BOT] OpenAI attempt ${attempt + 1}/${maxRetries + 1} failed:`, error.message, "retryable:", isRetryable);
      
      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }
      
      const delay = (attempt + 1) * 2000;
      console.log(`[BOT] Reintentando en ${delay}ms...`);
      await sleep(delay);
    }
  }
}

async function getAIResponse(session, sender, message) {
  const sessionApiKey = session.botConfig.apiKey || null;
  const globalApiKey = process.env.OPENAI_API_KEY || "";
  const activeApiKey = sessionApiKey || globalApiKey;

  if (!activeApiKey) {
    console.log("[BOT] No OpenAI API key configured (neither session nor global)");
    return "Lo siento, el bot no está configurado correctamente. Contacta al administrador.";
  }

  const activeClient = sessionApiKey
    ? new OpenAI({ apiKey: sessionApiKey, timeout: 30000, maxRetries: 0 })
    : openai;

  try {
    let history = session.conversationHistory.get(sender) || [];
    history.push({ role: "user", content: message });

    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }

    session.conversationHistory.set(sender, history);

    const systemPrompt = session.botConfig.systemPrompt || defaultBotConfig.systemPrompt;

    if (systemPrompt === defaultBotConfig.systemPrompt) {
      console.log("[BOT] ⚠️ WARNING: Using DEFAULT prompt, custom prompt may not have been synced!");
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
    ];

    console.log("[BOT] Generando respuesta para", sender.split("@")[0]);
    console.log("[BOT] Modelo:", session.botConfig.model);
    console.log("[BOT] System prompt (", systemPrompt.length, "chars):", systemPrompt.substring(0, 300) + (systemPrompt.length > 300 ? "..." : ""));
    console.log("[BOT] Historial:", history.length, "mensajes");
    console.log("[BOT] Usando API key:", sessionApiKey ? "del bot (custom)" : "global del servidor");

    const completion = await callOpenAIWithRetry(activeClient, {
      model: session.botConfig.model || "gpt-4o",
      messages,
      temperature: session.botConfig.temperature ?? 0.7,
      max_tokens: 2048,
    });

    const reply = completion.choices[0]?.message?.content;

    if (reply) {
      history.push({ role: "assistant", content: reply });
      session.conversationHistory.set(sender, history);
      console.log("[BOT] Respuesta generada (", reply.length, "chars):", reply.substring(0, 200));
    } else {
      console.error("[BOT] OpenAI devolvió respuesta vacía. Choices:", JSON.stringify(completion.choices));
      return "Disculpa, no pude procesar tu mensaje. Intenta de nuevo.";
    }

    return reply;
  } catch (error) {
    console.error("[BOT] Error OpenAI COMPLETO:", error.message);
    console.error("[BOT] Error tipo:", error.constructor?.name);
    console.error("[BOT] Error status:", error.status || "N/A");
    console.error("[BOT] Error code:", error.code || "N/A");
    if (error.message?.includes("401") || error.message?.includes("Incorrect API key")) {
      return "Error: La API key de OpenAI no es válida. Verifica la configuración.";
    }
    if (error.message?.includes("429") || error.message?.includes("Rate limit")) {
      return "El servicio está saturado. Intenta de nuevo en un momento.";
    }
    if (error.name === "AbortError" || error.message?.includes("aborted") || error.message?.includes("abort")) {
      console.error("[BOT] ⚠️ Request fue abortado/timeout después de reintentos");
      return "La respuesta tardó demasiado. Intenta de nuevo en un momento.";
    }
    if (error.message?.includes("timeout") || error.message?.includes("ETIMEDOUT")) {
      return "La respuesta tardó demasiado. Intenta de nuevo.";
    }
    return "Lo siento, ocurrió un error al procesar tu mensaje. Intenta de nuevo en un momento.";
  }
}

function destroySocket(session) {
  if (session.sock) {
    try { session.sock.ev.removeAllListeners(); } catch (_) {}
    try { session.sock.ws.close(); } catch (_) {}
    try { session.sock.end(undefined); } catch (_) {}
    session.sock = null;
  }
}

async function safeReconnect(sessionId, delayMs) {
  const session = getSession(sessionId);
  if (session.reconnectLocked) {
    console.log(`[SERVER][${sessionId}] Reconexion bloqueada (ya hay una en curso)`);
    return;
  }
  session.reconnectLocked = true;
  destroySocket(session);
  session.isConnected = false;
  session.isStarting = false;
  console.log(`[SERVER][${sessionId}] Esperando ${delayMs}ms antes de reconectar...`);
  await sleep(delayMs);
  session.reconnectLocked = false;
  startWhatsApp(sessionId);
}

async function startWhatsApp(sessionId) {
  if (!sessionId) sessionId = "default";
  const session = getSession(sessionId);

  if (session.isStarting || session.reconnectLocked) {
    console.log(`[SERVER][${sessionId}] Ya se esta iniciando o reconectando, ignorando...`);
    return;
  }

  session.isStarting = true;

  destroySocket(session);

  try {
    let version;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
      console.log(`[SERVER][${sessionId}] WA version (fetched):`, version.join("."));
    } catch (vErr) {
      version = FALLBACK_WA_VERSION;
      console.log(`[SERVER][${sessionId}] WA version fetch failed (${vErr.message}), using fallback:`, version.join("."));
    }

    const { state, saveCreds } = await useMultiFileAuthState(session.authDir);

    const sock = makeWASocket({
      auth: state,
      version,
      logger,
      browser: ["Chrome", "Chrome", "22.0"],
      connectTimeoutMs: 90000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: 90000,
      retryRequestDelayMs: 1000,
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 25000,
    });

    session.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      if (session.sock !== sock) {
        console.log(`[SERVER][${sessionId}] Evento de socket obsoleto, ignorando`);
        try { sock.ev.removeAllListeners(); } catch (_) {}
        try { sock.ws.close(); } catch (_) {}
        try { sock.end(undefined); } catch (_) {}
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.qrAttempts++;
        console.log(`[SERVER][${sessionId}] QR recibido (#${session.qrAttempts}/${MAX_QR_ATTEMPTS}) - generando imagen...`);

        if (session.qrAttempts > MAX_QR_ATTEMPTS) {
          console.log(`[SERVER][${sessionId}] Demasiados QR sin escanear, deteniendo sesion`);
          destroySocket(session);
          session.isStarting = false;
          session.reconnectLocked = false;
          session.currentQR = null;
          session.qrAttempts = 0;
          clearAuthState(session);
          return;
        }

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
        session.phoneInfo = sock.user;
        session.reconnectAttempts = 0;
        session.qrAttempts = 0;
        restoreBotConfig(sessionId, session);
        console.log(`[SERVER][${sessionId}] Usuario:`, session.phoneInfo?.id, session.phoneInfo?.name);
        console.log(`[SERVER][${sessionId}] Bot config: enabled=${session.botConfig.enabled} prompt=${(session.botConfig.systemPrompt || "").length}chars model=${session.botConfig.model}`);
      }

      if (connection === "close") {
        session.isConnected = false;
        session.isStarting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.message || "unknown";
        console.log(`[SERVER][${sessionId}] Conexion cerrada - codigo:`, code, "razon:", reason);

        if (session.manualDisconnect) {
          console.log(`[SERVER][${sessionId}] Desconexion manual, NO reconectando`);
          session.manualDisconnect = false;
          destroySocket(session);
          return;
        }

        if (code === 440) {
          console.log(`[SERVER][${sessionId}] Conflict detectado - esperando antes de reconectar`);
          session.reconnectAttempts++;
          if (session.reconnectAttempts > MAX_RECONNECT) {
            console.log(`[SERVER][${sessionId}] Demasiados conflictos, limpiando sesion y esperando 5 min`);
            clearAuthState(session);
            session.reconnectAttempts = 0;
            session.phoneInfo = null;
            await safeReconnect(sessionId, 300000);
          } else {
            const delay = Math.min(10000 * Math.pow(2, session.reconnectAttempts - 1), 120000);
            await safeReconnect(sessionId, delay);
          }
          return;
        }

        if (code === DisconnectReason.loggedOut || code === 401) {
          console.log(`[SERVER][${sessionId}] Sesion cerrada por el usuario`);
          clearAuthState(session);
          session.phoneInfo = null;
          session.currentQR = null;
          session.reconnectAttempts = 0;
          await safeReconnect(sessionId, 5000);
        } else if (code === 405) {
          clearAuthState(session);
          session.phoneInfo = null;
          session.currentQR = null;
          session.reconnectAttempts++;
          const delay = Math.min(15000 + (session.reconnectAttempts * 10000), 120000);
          await safeReconnect(sessionId, delay);
        } else if (code === 428) {
          console.log(`[SERVER][${sessionId}] QR timeout - sesion no escaneada`);
          session.qrAttempts++;
          if (session.qrAttempts > MAX_QR_ATTEMPTS) {
            console.log(`[SERVER][${sessionId}] Demasiados timeouts QR, deteniendo`);
            destroySocket(session);
            session.isStarting = false;
            session.reconnectLocked = false;
            session.currentQR = null;
            session.qrAttempts = 0;
            clearAuthState(session);
            return;
          }
          await safeReconnect(sessionId, 5000);
        } else if (code === 408) {
          session.reconnectAttempts++;
          console.log(`[SERVER][${sessionId}] Error de red (408) - intento ${session.reconnectAttempts}/${MAX_NETWORK_RECONNECT} (NO se borra auth)`);
          if (session.reconnectAttempts <= MAX_NETWORK_RECONNECT) {
            const delay = Math.min(15000 * session.reconnectAttempts, 180000);
            await safeReconnect(sessionId, delay);
          } else {
            console.log(`[SERVER][${sessionId}] Demasiados errores de red, pausando 5 minutos antes de reintentar`);
            session.reconnectAttempts = 0;
            await safeReconnect(sessionId, 300000);
          }
      } else if (code === 515 || code === 503) {
          session.reconnectAttempts++;
          const delay = Math.min(10000 * session.reconnectAttempts, 60000);
          if (session.reconnectAttempts <= MAX_RECONNECT) {
            await safeReconnect(sessionId, delay);
          } else {
            clearAuthState(session);
            session.reconnectAttempts = 0;
            await safeReconnect(sessionId, 60000);
          }
        } else {
          session.reconnectAttempts++;
          if (session.reconnectAttempts <= MAX_RECONNECT) {
            const delay = Math.min(10000 * session.reconnectAttempts, 60000);
            await safeReconnect(sessionId, delay);
          } else {
            clearAuthState(session);
            session.reconnectAttempts = 0;
            await safeReconnect(sessionId, 180000);
          }
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
      if (session.sock !== sock) return;
      console.log(`[MSG][${sessionId}] messages.upsert tipo:`, type, "cantidad:", msgs.length);

      for (const msg of msgs) {
        if (!msg.message) continue;

        const msgId = msg.key.id;
        if (session.processedMessages.has(msgId)) continue;
        session.processedMessages.add(msgId);

        if (session.processedMessages.size > MAX_PROCESSED_MESSAGES) {
          const entries = Array.from(session.processedMessages);
          entries.slice(0, CLEANUP_THRESHOLD).forEach((id) => session.processedMessages.delete(id));
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

        const senderPhone = sender.split("@")[0];
        const isFromMe = msg.key.fromMe === true;
        const textLower = text.trim().toLowerCase();

        console.log(`[MSG][${sessionId}] De:`, senderPhone, "fromMe:", isFromMe, "Texto:", text.substring(0, 100));

        // === KEYWORD COMMANDS ===

        // Client says "asesor" -> disable bot for this contact
        if (!isFromMe && textLower === "asesor") {
          console.log(`[CMD][${sessionId}] Cliente ${senderPhone} pidió ASESOR - desactivando bot`);
          session.disabledContacts.add(senderPhone);
          saveDisabledContactsToFile();
          try {
            await sock.sendMessage(sender, { text: "🧑‍💼 Te estamos conectando con un asesor humano. El bot ha sido desactivado para esta conversación." });
          } catch (e) {
            console.error(`[CMD][${sessionId}] Error enviando mensaje de asesor:`, e.message);
          }
          continue;
        }

        // Owner says "bot off" -> disable bot for this contact
        if (isFromMe && textLower === "bot off") {
          console.log(`[CMD][${sessionId}] Owner envió BOT OFF para contacto ${senderPhone} - desactivando bot`);
          session.disabledContacts.add(senderPhone);
          saveDisabledContactsToFile();
          console.log(`[CMD][${sessionId}] Bot desactivado para ${senderPhone}. Disabled set:`, Array.from(session.disabledContacts));
          continue;
        }

        // Owner says "bot on" -> re-enable bot for this contact
        if (isFromMe && textLower === "bot on") {
          console.log(`[CMD][${sessionId}] Owner envió BOT ON para contacto ${senderPhone} - reactivando bot`);
          session.disabledContacts.delete(senderPhone);
          saveDisabledContactsToFile();
          console.log(`[CMD][${sessionId}] Bot reactivado para ${senderPhone}. Disabled set:`, Array.from(session.disabledContacts));
          continue;
        }

        // Skip own messages for AI processing
        if (isFromMe) continue;

        // === DISABLED CHECK ===
        const isDisabledInMemory = session.disabledContacts.has(senderPhone) || session.disabledContacts.has(sender);
        
        let isDisabledInFile = false;
        try {
          const freshDisabled = loadDisabledContactsFromFile();
          if (freshDisabled[sessionId] && Array.isArray(freshDisabled[sessionId])) {
            isDisabledInFile = freshDisabled[sessionId].includes(senderPhone);
            session.disabledContacts = new Set(freshDisabled[sessionId]);
          }
        } catch (e) {
          console.error(`[MSG][${sessionId}] Error reading disabled file:`, e.message);
        }

        const isDisabled = isDisabledInMemory || isDisabledInFile || session.disabledContacts.has(senderPhone) || session.disabledContacts.has(sender);
        
        console.log(`[MSG][${sessionId}] === DISABLED CHECK for ${senderPhone} === inMemory=${isDisabledInMemory} inFile=${isDisabledInFile} final=${isDisabled} setSize=${session.disabledContacts.size} set=${JSON.stringify(Array.from(session.disabledContacts))}`);
        
        if (isDisabled) {
          console.log(`[MSG][${sessionId}] ❌ Bot DESACTIVADO para contacto ${senderPhone}, ignorando mensaje`);
          continue;
        }
        console.log(`[MSG][${sessionId}] ✅ Bot ACTIVO para contacto ${senderPhone}, procesando...`);

        const hasApiKey = session.botConfig.apiKey || openai.apiKey;
        if (session.botConfig.enabled && hasApiKey) {
          try { await sock.readMessages([msg.key]); } catch (_) {}
          try { await sock.sendPresenceUpdate("composing", sender); } catch (_) {}

          console.log(`[MSG][${sessionId}] Bot habilitado, generando respuesta...`);

          let reply = null;
          try {
            reply = await getAIResponse(session, sender, text);
          } catch (aiError) {
            console.error(`[MSG][${sessionId}] ❌ Error fatal en getAIResponse:`, aiError.message);
            reply = "Lo siento, ocurrió un error procesando tu mensaje.";
          }

          try { await sock.sendPresenceUpdate("paused", sender); } catch (_) {}

          if (reply && session.sock === sock && session.isConnected) {
            try {
              await sock.sendMessage(sender, { text: reply });
              console.log(`[MSG][${sessionId}] ✅ Respuesta enviada a`, sender.split("@")[0]);
            } catch (e) {
              console.error(`[MSG][${sessionId}] ❌ Error enviando:`, e.message);
              if (session.sock === sock && session.isConnected) {
                await sleep(3000);
                try {
                  await sock.sendMessage(sender, { text: reply });
                  console.log(`[MSG][${sessionId}] ✅ Reintento exitoso`);
                } catch (e2) {
                  console.error(`[MSG][${sessionId}] ❌ Reintento fallido:`, e2.message);
                }
              }
            }
          } else {
            console.error(`[MSG][${sessionId}] ❌ Socket cambió o desconectado, no se envió respuesta`);
          }
        }
      }
    });
  } catch (error) {
    console.error(`[SERVER][${sessionId}] ERROR FATAL:`, error.message);
    session.isStarting = false;
    session.reconnectAttempts++;
    if (session.reconnectAttempts <= MAX_RECONNECT) {
      const delay = Math.min(15000 * session.reconnectAttempts, 120000);
      await safeReconnect(sessionId, delay);
    } else {
      session.reconnectAttempts = 0;
      await safeReconnect(sessionId, 300000);
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
    maxSessions: MAX_SESSIONS,
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
  res.json({ sessions: sessionList, total: sessionList.length, maxSessions: MAX_SESSIONS });
});

app.post("/session/create", async (req, res) => {
  const sessionId = req.body.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId requerido" });
  }
  if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
    return res.status(429).json({ error: `Límite de ${MAX_SESSIONS} sesiones simultáneas alcanzado. Elimina una sesión antes de crear otra.`, maxSessions: MAX_SESSIONS, currentSessions: sessions.size });
  }
  const session = getSession(sessionId);
  if (!session.isConnected && !session.isStarting) {
    startWhatsApp(sessionId);
  }
  res.json({ ok: true, sessionId, currentSessions: sessions.size, maxSessions: MAX_SESSIONS });
});

app.get("/qr", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);

  if (session.isConnected) {
    return res.json({ connected: true, qr: null, sessionId });
  }

  if (!session.isStarting && !session.sock && !session.reconnectLocked) {
    session.qrAttempts = 0;
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
  const { enabled, systemPrompt, welcomeMessage, model, temperature, apiKey, disabledContacts } = req.body;
  if (typeof enabled === "boolean") session.botConfig.enabled = enabled;
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) session.botConfig.systemPrompt = systemPrompt;
  if (typeof welcomeMessage === "string") session.botConfig.welcomeMessage = welcomeMessage;
  if (model) session.botConfig.model = model;
  if (typeof temperature === "number") session.botConfig.temperature = temperature;
  if (typeof apiKey === "string" && apiKey.trim()) session.botConfig.apiKey = apiKey.trim();
  if (Array.isArray(disabledContacts)) {
    const previousContacts = Array.from(session.disabledContacts);
    session.disabledContacts.clear();
    for (const phone of disabledContacts) {
      const cleanPhone = String(phone).replace(/[^0-9]/g, "");
      if (cleanPhone) {
        session.disabledContacts.add(cleanPhone);
      }
    }
    saveDisabledContactsToFile();
    console.log(`[CONFIG][${sessionId}] disabledContacts updated via config: previous=${previousContacts.length} new=${session.disabledContacts.size}`);
  }
  backupBotConfig(sessionId, session.botConfig);
  console.log(`[CONFIG][${sessionId}] Bot config actualizada:`, {
    enabled: session.botConfig.enabled,
    model: session.botConfig.model,
    temperature: session.botConfig.temperature,
    promptLength: session.botConfig.systemPrompt?.length || 0,
    promptPreview: (session.botConfig.systemPrompt || "").substring(0, 100),
    welcomeLength: session.botConfig.welcomeMessage?.length || 0,
    hasCustomApiKey: !!session.botConfig.apiKey,
  });
  res.json({ ok: true, config: session.botConfig, sessionId });
});

app.get("/bot/config", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  res.json({ ...session.botConfig, sessionId });
});

app.post("/bot/contact/toggle", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  const { phone, enabled } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "phone requerido" });
  }
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  console.log(`[CONFIG][${sessionId}] Toggle bot for contact: ${cleanPhone} enabled=${enabled} (before: disabled set has ${session.disabledContacts.size} contacts:`, Array.from(session.disabledContacts), ")");
  if (enabled === false) {
    session.disabledContacts.add(cleanPhone);
    console.log(`[CONFIG][${sessionId}] ❌ Bot DESACTIVADO para contacto: ${cleanPhone}`);
  } else {
    session.disabledContacts.delete(cleanPhone);
    console.log(`[CONFIG][${sessionId}] ✅ Bot ACTIVADO para contacto: ${cleanPhone}`);
  }
  saveDisabledContactsToFile();
  console.log(`[CONFIG][${sessionId}] After toggle: disabled set (${session.disabledContacts.size}):`, Array.from(session.disabledContacts));
  res.json({ ok: true, phone: cleanPhone, botEnabled: enabled !== false, disabledContacts: Array.from(session.disabledContacts), sessionId });
});

app.post("/bot/contact/disabled/bulk", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  const { phones } = req.body;
  if (!Array.isArray(phones)) {
    return res.status(400).json({ error: "phones array requerido" });
  }
  if (phones.length === 0 && session.disabledContacts.size > 0) {
    console.log(`[CONFIG][${sessionId}] Bulk push with EMPTY array but session has ${session.disabledContacts.size} disabled contacts - IGNORING to prevent accidental clear`);
    return res.json({ ok: true, disabledContacts: Array.from(session.disabledContacts), sessionId, skipped: true });
  }
  const previousContacts = Array.from(session.disabledContacts);
  session.disabledContacts.clear();
  for (const phone of phones) {
    const cleanPhone = String(phone).replace(/[^0-9]/g, "");
    if (cleanPhone) {
      session.disabledContacts.add(cleanPhone);
    }
  }
  saveDisabledContactsToFile();
  console.log(`[CONFIG][${sessionId}] Bulk set disabled contacts: previous=${previousContacts.length} new=${session.disabledContacts.size}`);
  console.log(`[CONFIG][${sessionId}] Previous:`, previousContacts, "New:", Array.from(session.disabledContacts));
  res.json({ ok: true, disabledContacts: Array.from(session.disabledContacts), sessionId });
});

app.get("/bot/contact/disabled", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  res.json({ disabledContacts: Array.from(session.disabledContacts), sessionId });
});

app.get("/bot/contact/check", (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  const phone = (req.query.phone || "").replace(/[^0-9]/g, "");
  if (!phone) {
    return res.status(400).json({ error: "phone query param required" });
  }
  const isDisabledInMemory = session.disabledContacts.has(phone);
  let isDisabledInFile = false;
  try {
    const fileData = loadDisabledContactsFromFile();
    if (fileData[sessionId] && Array.isArray(fileData[sessionId])) {
      isDisabledInFile = fileData[sessionId].includes(phone);
    }
  } catch (e) {
    console.error("[CHECK] Error reading file:", e.message);
  }
  console.log(`[CHECK][${sessionId}] Phone ${phone}: inMemory=${isDisabledInMemory} inFile=${isDisabledInFile} setSize=${session.disabledContacts.size}`);
  res.json({ phone, sessionId, isDisabled: isDisabledInMemory || isDisabledInFile, inMemory: isDisabledInMemory, inFile: isDisabledInFile, disabledSet: Array.from(session.disabledContacts) });
});

app.get("/bot/contact/disabled/all", (req, res) => {
  const allDisabled = [];
  for (const [sid, session] of sessions.entries()) {
    for (const phone of session.disabledContacts) {
      allDisabled.push({ phone, sessionId: sid });
    }
  }
  res.json({ disabledContacts: allDisabled });
});

app.post("/disconnect", async (req, res) => {
  const sessionId = getSessionId(req);
  const session = getSession(sessionId);
  session.manualDisconnect = true;
  try {
    if (session.sock) {
      await session.sock.logout();
    }
  } catch (_) {}
  destroySocket(session);
  clearAuthState(session);
  session.isConnected = false;
  session.isStarting = false;
  session.reconnectLocked = false;
  session.phoneInfo = null;
  session.currentQR = null;
  session.qrAttempts = 0;
  session.reconnectAttempts = 0;
  session.conversationHistory.clear();
  session.processedMessages.clear();
  res.json({ ok: true, sessionId });
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
      botDisabled: session.disabledContacts.has(phone),
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
        botDisabled: session.disabledContacts.has(phone),
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
  destroySocket(session);
  clearAuthState(session);
  session.isConnected = false;
  session.isStarting = false;
  session.reconnectLocked = false;
  session.phoneInfo = null;
  session.currentQR = null;
  session.reconnectAttempts = 0;
  session.qrAttempts = 0;
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
  destroySocket(session);
  clearAuthState(session);
  sessions.delete(sessionId);
  res.json({ ok: true, sessionId, message: "Sesión eliminada" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("[SERVER] Corriendo en puerto", PORT);
  console.log("[SERVER] OpenAI API key:", openai.apiKey ? "configurada ✅" : "NO configurada ❌");
  console.log(`[SERVER] Multi-session mode enabled (max ${MAX_SESSIONS} sessions)`);
  console.log(`[SERVER] Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`);
  startWhatsApp("default");

  setInterval(() => {
    const mem = process.memoryUsage();
    console.log(`[SERVER] Memory: heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB rss=${Math.round(mem.rss / 1024 / 1024)}MB sessions=${sessions.size}/${MAX_SESSIONS}`);
    for (const [sid, s] of sessions.entries()) {
      if (s.conversationHistory.size > 50) {
        const entries = Array.from(s.conversationHistory.entries());
        entries.sort((a, b) => a[1].length - b[1].length);
        const toRemove = entries.slice(0, entries.length - 50);
        for (const [key] of toRemove) {
          s.conversationHistory.delete(key);
        }
        console.log(`[SERVER][${sid}] Trimmed ${toRemove.length} old conversations`);
      }
    }
  }, 300000);
});
