const express = require("express");
const path = require("path");
const multer = require("multer");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 2 * 1024 * 1024
    }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

let sock = null;
let pairingCode = null;
let connected = false;
let connecting = false;
let phoneNumber = "";
let jsonLoaded = false;

let sentCount = 0;
let failedCount = 0;

let logs = [];

function log(message) {
    const time = new Date().toLocaleTimeString("en-IN", {
        hour12: false
    });

    const line = `[${time}] ${message}`;

    console.log(line);

    logs.push(line);

    if (logs.length > 100) {
        logs.shift();
    }

    broadcast();
}

const clients = [];

function broadcast() {
    const data = JSON.stringify({
        connected,
        connecting,
        pairingCode,
        jsonLoaded,
        sentCount,
        failedCount,
        logs
    });

    clients.forEach(res => {
        try {
            res.write(`data: ${data}\n\n`);
        } catch (_) {}
    });
}

app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.flushHeaders();

    clients.push(res);

    res.write(
        `data: ${JSON.stringify({
            connected,
            connecting,
            pairingCode,
            jsonLoaded,
            sentCount,
            failedCount,
            logs
        })}\n\n`
    );

    req.on("close", () => {
        const index = clients.indexOf(res);

        if (index !== -1) {
            clients.splice(index, 1);
        }
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "dashboard.html"));
});

/* =====================================================
   PAIRING CODE
===================================================== */

app.post("/api/pair", async (req, res) => {
    try {
        let number = String(req.body.phone || "");

        number = number.replace(/[^\d]/g, "");

        if (number.length < 8) {
            return res.status(400).json({
                ok: false,
                error: "Invalid phone number"
            });
        }

        phoneNumber = number;

        log("[AUTH] Pairing request received.");

        if (!sock) {
            await startWhatsApp();
        }

        if (!sock) {
            return res.status(500).json({
                ok: false,
                error: "WhatsApp socket unavailable"
            });
        }

        if (sock.authState?.creds?.registered) {
            return res.json({
                ok: true,
                connected: connected,
                message: "Existing WhatsApp session found."
            });
        }

        log("[AUTH] Requesting pairing code...");

        const code = await sock.requestPairingCode(number);

        pairingCode = code;

        log("[AUTH] Pairing code generated.");

        broadcast();

        res.json({
            ok: true,
            code
        });

    } catch (error) {
        log("[ERROR] Pairing failed.");

        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

/* =====================================================
   JSON PASTE
===================================================== */

app.post("/api/json/paste", (req, res) => {
    try {
        const raw = String(req.body.json || "").trim();

        if (!raw) {
            return res.status(400).json({
                ok: false,
                error: "JSON empty hai."
            });
        }

        const parsed = JSON.parse(raw);

        if (
            parsed === null ||
            typeof parsed !== "object"
        ) {
            return res.status(400).json({
                ok: false,
                error: "Valid JSON object/array required."
            });
        }

        jsonLoaded = true;

        log("[JSON] JSON validated successfully.");

        broadcast();

        res.json({
            ok: true,
            message: "JSON loaded successfully."
        });

    } catch (error) {
        res.status(400).json({
            ok: false,
            error: "Invalid JSON."
        });
    }
});

/* =====================================================
   JSON FILE UPLOAD
===================================================== */

app.post(
    "/api/json/upload",
    upload.single("jsonFile"),
    (req, res) => {

        try {
            if (!req.file) {
                return res.status(400).json({
                    ok: false,
                    error: "JSON file select karo."
                });
            }

            const text =
                req.file.buffer.toString("utf8");

            const parsed = JSON.parse(text);

            if (
                parsed === null ||
                typeof parsed !== "object"
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Invalid JSON structure."
                });
            }

            jsonLoaded = true;

            log(
                `[JSON] File loaded: ${req.file.originalname}`
            );

            broadcast();

            res.json({
                ok: true,
                message: "JSON file validated successfully."
            });

        } catch (error) {

            res.status(400).json({
                ok: false,
                error: "File me valid JSON nahi hai."
            });
        }
    }
);

/* =====================================================
   CLEAR JSON STATUS
===================================================== */

app.post("/api/json/clear", (req, res) => {

    jsonLoaded = false;

    log("[JSON] JSON status cleared.");

    broadcast();

    res.json({
        ok: true
    });
});

/* =====================================================
   SEND SINGLE MESSAGE
===================================================== */

app.post("/api/message", async (req, res) => {

    try {

        if (!connected || !sock) {
            return res.status(400).json({
                ok: false,
                error: "WhatsApp connected nahi hai."
            });
        }

        let recipient =
            String(req.body.recipient || "")
                .replace(/[^\d@g.-]/g, "");

        const message =
            String(req.body.message || "").trim();

        const header =
            String(req.body.header || "").trim();

        if (!recipient) {
            return res.status(400).json({
                ok: false,
                error: "Recipient / Group UID required."
            });
        }

        if (!message) {
            return res.status(400).json({
                ok: false,
                error: "Message required."
            });
        }

        let jid = recipient;

        /*
         * Normal phone number:
         * 919876543210
         *
         * Group JID:
         * 1234567890-123456789@g.us
         */

        if (!jid.includes("@")) {
            jid = `${jid}@s.whatsapp.net`;
        }

        const finalMessage =
            header
                ? `${header}\n\n${message}`
                : message;

        await sock.sendMessage(jid, {
            text: finalMessage
        });

        sentCount++;

        log("[MESSAGE] Message sent.");

        broadcast();

        res.json({
            ok: true,
            message: "Message sent."
        });

    } catch (error) {

        failedCount++;

        log("[MESSAGE] Sending failed.");

        broadcast();

        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

/* =====================================================
   WHATSAPP
===================================================== */

async function startWhatsApp() {

    if (connecting) return;

    connecting = true;

    broadcast();

    try {

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            path.join(__dirname, "auth_info_baileys")
        );

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: [
                "RK RAJA XWD",
                "Chrome",
                "1.0.0"
            ]
        });

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        sock.ev.on(
            "connection.update",
            async update => {

                const {
                    connection,
                    lastDisconnect
                } = update;

                if (connection === "open") {

                    connected = true;
                    connecting = false;
                    pairingCode = null;

                    log(
                        "[WHATSAPP] Connection ONLINE."
                    );

                    broadcast();
                }

                if (connection === "close") {

                    connected = false;
                    connecting = false;
                    pairingCode = null;

                    const code =
                        lastDisconnect?.error instanceof Boom
                            ? lastDisconnect.error.output.statusCode
                            : null;

                    if (
                        code ===
                        DisconnectReason.loggedOut
                    ) {

                        log(
                            "[WHATSAPP] Session logged out."
                        );

                        sock = null;

                    } else {

                        log(
                            "[WHATSAPP] Connection closed. Reconnecting..."
                        );

                        sock = null;

                        setTimeout(() => {
                            startWhatsApp();
                        }, 5000);
                    }

                    broadcast();
                }
            }
        );

        log(
            "[BAILEYS] Authentication state loaded."
        );

        connecting = false;

        broadcast();

    } catch (error) {

        connecting = false;
        sock = null;

        log(
            "[ERROR] WhatsApp startup failed."
        );

        broadcast();

        setTimeout(() => {
            startWhatsApp();
        }, 10000);
    }
}

/* =====================================================
   START
===================================================== */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `RK RAJA XWD running on port ${PORT}`
        );

        log("[SERVER] Dashboard ready.");

        startWhatsApp();
    }
);
