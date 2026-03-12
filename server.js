const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys")
const QRCode = require("qrcode")

async function startBot() {

const { state, saveCreds } = await useMultiFileAuthState("auth")

const sock = makeWASocket({
auth: state
})

sock.ev.on("connection.update", async (update) => {

const { connection, lastDisconnect, qr } = update

if(qr){
console.log("📱 ESCANEA ESTE QR:")
const qrImage = await QRCode.toString(qr, { type: "terminal" })
console.log(qrImage)
}

if(connection === "open"){
console.log("✅ WhatsApp conectado")
}

if(connection === "close"){
const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
console.log("⚠️ Conexión cerrada, reconectando...", shouldReconnect)

if(shouldReconnect){
startBot()
}
}

})

sock.ev.on("creds.update", saveCreds)

}

startBot()
