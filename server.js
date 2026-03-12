const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const QRCode = require("qrcode")

async function startBot() {

const { state, saveCreds } = await useMultiFileAuthState("auth")

const sock = makeWASocket({
auth: state
})

sock.ev.on("connection.update", async (update) => {

const { connection, qr } = update

if (qr) {

console.log("ESCANEA ESTE QR")

QRCode.toString(qr, { type: "terminal" }, function (err, url) {
console.log(url)
})

}

if (connection === "open") {
console.log("BOT CONECTADO")
}

if (connection === "close") {
console.log("Reconectando...")
startBot()
}

})

sock.ev.on("creds.update", saveCreds)

}

startBot()
