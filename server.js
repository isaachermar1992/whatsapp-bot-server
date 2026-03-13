const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");
const pino = require("pino");

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let currentQR = null;
let isConnected = false;
let phoneInfo = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 8;
const AUTH_DIR = "./auth_info";

const logger = pino({ level: "silent" });

function clearAuthState() {
  console.log("LIMPIANDO SESION...");
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    console.log("SESION LIMPIADA");
  } catch (e) {
    console.error("Error limpiando sesion:", e.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWhatsApp() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log("Usando WA version:", version.join("."));

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      version,
      logger,
      browser: ["WhatsApp Bot", "Chrome", "1.0.0"],
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("QR RECIBIDO");
        try {
          currentQR = await QRCode.toDataURL(qr);
          console.log("QR GENERADO como data URL");
        } catch (e) {
          console.error("Error generando QR:", e.message);
        }
        reconnectAttempts = 0;
      }

      if (connection === "open") {
        console.log("CONECTADO a WhatsApp!");
        isConnected = true;
        currentQR = null;
        phoneInfo = sock.user;
        reconnectAttempts = 0;
        console.log("Usuario:", phoneInfo?.id, phoneInfo?.name);
      }

      if (connection === "close") {
        isConnected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.message || "unknown";
        console.log("CONEXION CERRADA - codigo:", code, "razon:", reason);

        if (code === DisconnectReason.loggedOut || code === 401) {
          console.log("SESION CERRADA/INVALIDA - limpiando...");
          clearAuthState();
          phoneInfo = null;
          currentQR = null;
          reconnectAttempts = 0;
          await sleep(5000);
          startWhatsApp();
        } else if (code === 405) {
          console.log("ERROR 405 - sesion corrupta, limpiando...");
          clearAuthState();
          phoneInfo = null;
          currentQR = null;
          reconnectAttempts++;

          if (reconnectAttempts > 3) {
            const delay = Math.min(30000, 10000 * reconnectAttempts);
            console.log("Demasiados 405 - esperando", delay / 1000, "s...");
            await sleep(delay);
          } else {
            await sleep(5000);
          }

          if (reconnectAttempts <= MAX_RECONNECT) {
            startWhatsApp();
          } else {
            console.log("MAXIMO REINTENTOS - esperando 2 minutos...");
            reconnectAttempts = 0;
            await sleep(120000);
            startWhatsApp();
          }
        } else if (code === 515 || code === 408 || code === 503) {
          console.log("Error temporal, reconectando...");
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          console.log("Esperando", delay / 1000, "s...");
          await sleep(delay);
          if (reconnectAttempts <= MAX_RECONNECT) {
            startWhatsApp();
          } else {
            console.log("MAXIMO REINTENTOS - limpiando y esperando...");
            clearAuthState();
            reconnectAttempts = 0;
            await sleep(60000);
            startWhatsApp();
          }
        } else {
          reconnectAttempts++;
          if (reconnectAttempts <= MAX_RECONNECT) {
            const delay = Math.min(3000 * reconnectAttempts, 30000);
            console.log("Reconectando en", delay / 1000, "s... (intento", reconnectAttempts, ")");
            await sleep(delay);
            startWhatsApp();
          } else {
            console.log("MAXIMO REINTENTOS - esperando 2 minutos...");
            clearAuthState();
            reconnectAttempts = 0;
            await sleep(120000);
            startWhatsApp();
          }
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const sender = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        if (text) {
          console.log("MENSAJE de", sender, ":", text.substring(0, 100));
        }
      }
    });
  } catch (error) {
    console.error("ERROR FATAL iniciando WhatsApp:", error.message);
    reconnectAttempts++;
    const delay = Math.min(10000 * reconnectAttempts, 60000);
    console.log("Reintentando en", delay / 1000, "s...");
    await sleep(delay);
    if (reconnectAttempts <= MAX_RECONNECT) {
      startWhatsApp();
    } else {
      console.log("Demasiados errores fatales - esperando 3 minutos...");
      reconnectAttempts = 0;
      await sleep(180000);
      startWhatsApp();
    }
  }
}

app.get("/", (req, res) => {
  res.json({ status: "ok", connected: isConnected, uptime: process.uptime() });
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.json({ connected: true });
  }
  if (currentQR) {
    return res.json({ qr: currentQR, connected: false });
  }
  return res.json({ error: "QR no disponible, espera unos segundos...", connected: false });
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    phoneNumber: phoneInfo?.id?.split(":")[0] || null,
    name: phoneInfo?.name || null,
    reconnectAttempts,
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
    console.log("MENSAJE ENVIADO a", jid);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error enviando:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    clearAuthState();
    isConnected = false;
    phoneInfo = null;
    currentQR = null;
    res.json({ ok: true });
    setTimeout(startWhatsApp, 3000);
  } catch (e) {
    clearAuthState();
    isConnected = false;
    res.json({ ok: false, error: e.message });
    setTimeout(startWhatsApp, 3000);
  }
});

app.post("/restart", async (req, res) => {
  try {
    if (sock) {
      sock.end(undefined);
    }
  } catch (_) {}
  clearAuthState();
  isConnected = false;
  phoneInfo = null;
  currentQR = null;
  reconnectAttempts = 0;
  res.json({ ok: true, message: "Reiniciando..." });
  await sleep(2000);
  startWhatsApp();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  startWhatsApp();
});
