const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const QRCode = require("qrcode")

async function startBot() {

const { state, saveCreds } = await useMultiFileAuthState("./auth")

const sock = makeWASocket({
auth: state,
printQRInTerminal: false
})

sock.ev.on("connection.update", async (update) => {

const { connection, qr } = update

if (qr) {

console.log("ESCANEA ESTE QR CON WHATSAPP")

const qrCode = await QRCode.toString(qr, { type: "terminal" })

console.log(qrCode)

}

if (connection === "open") {
console.log("✅ BOT CONECTADO")
}

if (connection === "close") {
console.log("⚠️ Conexión cerrada, reconectando...")
setTimeout(startBot, 5000)
}

})

sock.ev.on("creds.update", saveCreds)

}

startBot()
