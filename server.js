// server.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let currentQR = null;
let isConnected = false;
let phoneInfo = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
const AUTH_DIR = "./auth_info";

function clearAuthState() {
console.log("LIMPIANDO SESION CORRUPTA...");
try {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log("SESION LIMPIADA");
  }
} catch (e) {
  console.error("Error limpiando sesion:", e.message);
}
}

async function startWhatsApp() {
const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

sock = makeWASocket({
  auth: state,
  printQRInTerminal: false,
});

sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    console.log("QR RECIBIDO");
    currentQR = await QRCode.toDataURL(qr);
    console.log("QR GENERADO");
    reconnectAttempts = 0;
  }

  if (connection === "open") {
    console.log("CONECTADO a WhatsApp");
    isConnected = true;
    currentQR = null;
    phoneInfo = sock.user;
    reconnectAttempts = 0;
  }

  if (connection === "close") {
    isConnected = false;
    phoneInfo = null;
    const code = lastDisconnect?.error?.output?.statusCode;
    console.log("CONEXION CERRADA - codigo:", code);

    if (code === 405 || code === 401 || code === 403) {
      console.log("SESION INVALIDA - limpiando y reiniciando...");
      clearAuthState();
      reconnectAttempts = 0;
      setTimeout(startWhatsApp, 5000);
    } else if (code !== DisconnectReason.loggedOut) {
      reconnectAttempts++;
      if (reconnectAttempts > MAX_RECONNECT) {
        console.log("MAXIMO DE REINTENTOS - limpiando sesion...");
        clearAuthState();
        reconnectAttempts = 0;
      }
      const delay = Math.min(3000 * reconnectAttempts, 30000);
      console.log("REINICIANDO en", delay / 1000, "segundos...");
      setTimeout(startWhatsApp, delay);
    } else {
      console.log("SESION CERRADA por usuario");
      clearAuthState();
      setTimeout(startWhatsApp, 5000);
    }
  }
});
}

app.get("/", (req, res) => {
res.json({ status: "ok", connected: isConnected });
});

app.get("/qr", (req, res) => {
if (isConnected) {
  return res.json({ connected: true });
}
if (currentQR) {
  return res.json({ qr: currentQR, connected: false });
}
return res.json({ error: "QR no disponible aun, espera unos segundos", connected: false });
});

app.get("/status", (req, res) => {
res.json({
  connected: isConnected,
  phoneNumber: phoneInfo?.id?.split(":")[0] || null,
  name: phoneInfo?.name || null,
});
});

app.post("/disconnect", async (req, res) => {
try {
  if (sock) await sock.logout();
  clearAuthState();
  res.json({ ok: true });
} catch (e) {
  res.json({ ok: false, error: e.message });
}
});

app.post("/restart", (req, res) => {
if (sock) sock.end();
clearAuthState();
startWhatsApp();
res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
console.log("Server running on port", PORT);
startWhatsApp();
});
