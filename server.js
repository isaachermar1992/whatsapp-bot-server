const express = require("express")
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys")
const QRCode = require("qrcode")

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000

let qrCode = null
let sock = null

async function startBot() {

  const { state, saveCreds } = await useMultiFileAuthState("./session")

  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true
  })

  sock.ev.on("connection.update", async (update) => {

    const { connection, qr } = update

    if (qr) {
      console.log("QR RECIBIDO")
      qrCode = await QRCode.toDataURL(qr)
      console.log("QR GENERADO")
    }

    if (connection === "open") {
      console.log("WHATSAPP CONECTADO")
    }

    if (connection === "close") {
      console.log("CONEXION CERRADA - REINICIANDO")
      setTimeout(startBot, 5000)
    }

  })

  sock.ev.on("creds.update", saveCreds)

}

startBot()

/* endpoint para que la app obtenga el QR */

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

/* endpoint para ver el QR en navegador */

app.get("/qr", (req, res) => {

  if (!qrCode) {
    return res.send("QR aun no generado")
  }

  res.send(`
    <h2>Escanea el QR</h2>
    <img src="${qrCode}" width="300"/>
  `)

})

app.listen(PORT, () => {
  console.log("Server running on port", PORT)
})
