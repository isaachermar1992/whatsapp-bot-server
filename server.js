// server.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let currentQR = null;
let isConnected = false;
let phoneInfo = null;

async function startWhatsApp() {
const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

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
    console.log("QR GENERADO como base64");
  }

  if (connection === "open") {
    console.log("CONECTADO a WhatsApp");
    isConnected = true;
    currentQR = null;
    phoneInfo = sock.user;
  }

  if (connection === "close") {
    isConnected = false;
    phoneInfo = null;
    const code = lastDisconnect?.error?.output?.statusCode;
    console.log("CONEXION CERRADA - codigo:", code);

    if (code !== DisconnectReason.loggedOut) {
      console.log("REINICIANDO...");
      setTimeout(startWhatsApp, 3000);
    } else {
      console.log("SESION CERRADA - escanea QR de nuevo");
      currentQR = null;
      setTimeout(startWhatsApp, 3000);
    }
  }
});
}

// Endpoints que la app necesita
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
return res.json({ error: "QR no disponible aún, espera unos segundos", connected: false });
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
  res.json({ ok: true });
} catch (e) {
  res.json({ ok: false, error: e.message });
}
});

app.post("/restart", (req, res) => {
if (sock) sock.end();
startWhatsApp();
res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
console.log("Server running on port", PORT);
startWhatsApp();
});
