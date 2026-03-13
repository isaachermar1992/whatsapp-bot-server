const express = require("express")
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys")
const QRCode = require("qrcode")

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000

let sock = null
let qrCode = null
let connected = false
let openaiKey = null

async function startBot() {

const { state, saveCreds } = await useMultiFileAuthState("./auth")
const { version } = await fetchLatestBaileysVersion()

sock = makeWASocket({
version,
auth: state,
browser: ["Ubuntu", "Chrome", "20.0.04"]
})

sock.ev.on("connection.update", async (update) => {

const { connection, qr } = update

if (qr) {
qrCode = await QRCode.toDataURL(qr)
}

if (connection === "open") {
connected = true
console.log("WHATSAPP CONECTADO")
}

if (connection === "close") {
connected = false
console.log("Reconectando...")
setTimeout(startBot, 5000)
}

})

sock.ev.on("creds.update", saveCreds)

}

startBot()

/* ---------------- API PARA LA APP ---------------- */

/* obtener QR */

app.get("/whatsapp/connect", (req, res) => {

if (!qrCode) {
return res.json({
status: "generating"
})
}

res.json({
status: "pending",
qr: qrCode
})

})

/* estado del whatsapp */

app.get("/whatsapp/status", (req, res) => {

res.json({
connected: connected
})

})

/* enviar mensaje */

app.post("/messages", async (req, res) => {

try {

const { to, message } = req.body

await sock.sendMessage(to + "@s.whatsapp.net", {
text: message
})

res.json({
status: "sent"
})

} catch (error) {

res.status(500).json({
error: "message failed"
})

}

})

/* guardar api key openai */

app.post("/settings/openai", (req, res) => {

openaiKey = req.body.key

res.json({
saved: true
})

})

app.listen(PORT, () => {
console.log("Server running on port", PORT)
})
