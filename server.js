const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys")
const QRCode = require("qrcode")

async function startBot() {

const { state, saveCreds } = await useMultiFileAuthState("./auth")

const { version } = await fetchLatestBaileysVersion()

const sock = makeWASocket({
version,
auth: state,
browser: ["Ubuntu", "Chrome", "20.0.04"]
})

sock.ev.on("connection.update", async (update) => {

const { connection, qr } = update

if (qr) {

console.log("ESCANEA ESTE QR")

const qrTerminal = await QRCode.toString(qr, { type: "terminal" })

console.log(qrTerminal)

}

if (connection === "open") {

console.log("✅ WHATSAPP CONECTADO")

}

if (connection === "close") {

console.log("⚠️ Reconectando en 5 segundos")

setTimeout(startBot, 5000)

}

})

sock.ev.on("creds.update", saveCreds)

}

startBot()
