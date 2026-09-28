const express = require("express");
const path = require("path");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// RK RAJA XWD — CONFIG
// =====================================================

// Render Environment Variable se number lena recommended hai.
// Example: 919876543210
const PHONE_NUMBER = process.env.PHONE_NUMBER || "";

const AUTH_DIR = path.join(__dirname, "auth_info_baileys");

let pairingCode = null;
let isConnected = false;
let isConnecting = false;
let sseClients = [];
let socketInstance = null;
let reconnectTimer = null;

let logs = [
    "[SYSTEM] RK RAJA XWD dashboard initialized",
    "[SYSTEM] Waiting for WhatsApp connection..."
];

// =====================================================
// LOGGING
// =====================================================

function addLog(message) {
    const time = new Date().toLocaleTimeString("en-IN", {
        hour12: false
    });

    const line = `[${time}] ${message}`;

    console.log(line);

    logs.push(line);

    if (logs.length > 80) {
        logs.shift();
    }

    broadcastState();
}

// =====================================================
// SSE
// =====================================================

app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const payload = {
        code: pairingCode,
        connected: isConnected,
        connecting: isConnecting,
        logs
    };

    res.write(`data: ${JSON.stringify(payload)}\n\n`);

    sseClients.push(res);

    req.on("close", () => {
        sseClients = sseClients.filter(client => client !== res);
    });
});

function broadcastState() {
    const payload = JSON.stringify({
        code: pairingCode,
        connected: isConnected,
        connecting: isConnecting,
        logs
    });

    sseClients.forEach(client => {
        try {
            client.write(`data: ${payload}\n\n`);
        } catch (_) {}
    });
}

// =====================================================
// DASHBOARD
// =====================================================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/health", (req, res) => {
    res.json({
        status: "online",
        project: "RK RAJA XWD",
        whatsappConnected: isConnected,
        serverTime: new Date().toISOString()
    });
});

// =====================================================
// WHATSAPP CONNECTION
// =====================================================

async function connectToWhatsApp() {
    if (isConnecting) return;

    isConnecting = true;
    broadcastState();

    try {
        addLog("[BAILEYS] Loading authentication state...");

        const { state, saveCreds } =
            await useMultiFileAuthState(AUTH_DIR);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ["RK RAJA XWD", "Chrome", "1.0.0"],
            markOnlineOnConnect: false
        });

        socketInstance = sock;

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            // -------------------------------------------------
            // REQUEST PAIRING CODE
            // -------------------------------------------------

            if (
                qr &&
                !sock.authState?.creds?.registered
            ) {
                if (!PHONE_NUMBER) {
                    addLog(
                        "[ERROR] PHONE_NUMBER environment variable is missing."
                    );
                    addLog(
                        "[INFO] Render → Environment → PHONE_NUMBER add karo."
                    );

                    isConnecting = false;
                    broadcastState();
                    return;
                }

                try {
                    const cleanNumber =
                        PHONE_NUMBER.replace(/[^\d]/g, "");

                    if (cleanNumber.length < 8) {
                        addLog("[ERROR] PHONE_NUMBER invalid hai.");
                        return;
                    }

                    addLog("[WHATSAPP] Requesting pairing code...");

                    const code =
                        await sock.requestPairingCode(cleanNumber);

                    pairingCode = code;

                    addLog(
                        `[WHATSAPP] Pairing code generated: ${code}`
                    );

                    broadcastState();
                } catch (error) {
                    addLog(
                        `[ERROR] Pairing code failed: ${error.message}`
                    );
                }
            }

            // -------------------------------------------------
            // CONNECTED
            // -------------------------------------------------

            if (connection === "open") {
                isConnected = true;
                isConnecting = false;
                pairingCode = null;

                addLog("[SUCCESS] WhatsApp connection opened.");
                addLog("[SYSTEM] RK RAJA XWD is ONLINE.");

                broadcastState();
            }

            // -------------------------------------------------
            // CLOSED
            // -------------------------------------------------

            if (connection === "close") {
                isConnected = false;
                isConnecting = false;

                const statusCode =
                    lastDisconnect?.error instanceof Boom
                        ? lastDisconnect.error.output.statusCode
                        : null;

                const loggedOut =
                    statusCode === DisconnectReason.loggedOut;

                pairingCode = null;

                if (loggedOut) {
                    addLog(
                        "[WHATSAPP] Logged out. Authentication required again."
                    );
                    broadcastState();
                    return;
                }

                addLog(
                    "[WHATSAPP] Connection closed. Reconnecting..."
                );

                broadcastState();

                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                }

                reconnectTimer = setTimeout(() => {
                    connectToWhatsApp();
                }, 5000);
            }
        });

    } catch (error) {
        isConnecting = false;
        isConnected = false;

        addLog(
            `[FATAL] WhatsApp startup error: ${error.message}`
        );

        broadcastState();

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
        }

        reconnectTimer = setTimeout(() => {
            connectToWhatsApp();
        }, 10000);
    }
}

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log("========================================");
    console.log("       RK RAJA XWD SERVER");
    console.log("========================================");
    console.log(`PORT: ${PORT}`);

    addLog(`[SERVER] Listening on port ${PORT}`);
    addLog("[SERVER] Dashboard ready.");

    connectToWhatsApp();
});
