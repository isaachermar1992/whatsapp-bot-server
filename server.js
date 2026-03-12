const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys")

async function startBot() {

const { state, saveCreds } = await useMultiFileAuthState("sessions")

const sock = makeWASocket({
auth: state,
printQRInTerminal: true
})

sock.ev.on("connection.update", (update) => {

const { connection, lastDisconnect } = update

if (connection === "close") {

const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

console.log("conexión cerrada, reconectar:", shouldReconnect)

if (shouldReconnect) {
startBot()
}

}

if (connection === "open") {
console.log("WHATSAPP CONECTADO")
}

})

sock.ev.on("creds.update", saveCreds)

}

startBot()