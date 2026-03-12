const makeWASocket = require("@whiskeysockets/baileys").default
const { useMultiFileAuthState } = require("@whiskeysockets/baileys")
const QRCode = require("qrcode")

async function startBot() {

    const { state, saveCreds } = await useMultiFileAuthState("sessions")

    const sock = makeWASocket({
        auth: state
    })

    sock.ev.on("connection.update", async (update) => {

        const { connection, qr } = update

        if(qr){
            console.log("QR RECIBIDO")

            const qrImage = await QRCode.toString(qr,{type:"terminal"})
            console.log(qrImage)
        }

        if(connection === "open"){
            console.log("✅ WHATSAPP CONECTADO")
        }

        if(connection === "close"){
            console.log("⚠️ Conexión cerrada, reconectando...")
            startBot()
        }

    })

    sock.ev.on("creds.update", saveCreds)
}

startBot()
