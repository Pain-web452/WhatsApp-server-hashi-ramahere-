const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const makeWASocket =
  require("@whiskeysockets/baileys").default;

const {
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const AUTH_DIR = path.join(
  __dirname,
  "auth_info_baileys"
);

let sock = null;
let isConnected = false;
let pairingCode = null;
let currentPhone = null;
let reconnecting = false;

let sentCount = 0;
let failedCount = 0;

let jsonLoaded = false;
let loadedJson = null;

const clients = new Set();

function log(message) {
  const text =
    `[${new Date().toLocaleTimeString()}] ${message}`;

  console.log(text);

  broadcast({
    type: "log",
    message: text
  });
}

function broadcast(data) {
  const payload =
    `data: ${JSON.stringify(data)}\n\n`;

  for (const client of clients) {
    try {
      client.write(payload);
    } catch (e) {
      clients.delete(client);
    }
  }
}

/* ==========================================
   SSE
========================================== */

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write("\n");

  clients.add(res);

  res.write(
    `data: ${JSON.stringify({
      type: "status",
      connected: isConnected,
      pairingCode,
      sentCount,
      failedCount,
      jsonLoaded
    })}\n\n`
  );

  req.on("close", () => {
    clients.delete(res);
  });
});

/* ==========================================
   DASHBOARD
========================================== */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "dashboard.html")
  );
});

/* ==========================================
   WHATSAPP CONNECT
========================================== */

async function startWhatsApp() {
  if (sock || reconnecting) {
    return;
  }

  reconnecting = true;

  try {
    fs.mkdirSync(AUTH_DIR, {
      recursive: true
    });

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,

      printQRInTerminal: false,

      browser: [
        "RK RAJA XWD",
        "Chrome",
        "1.0.0"
      ],

      generateHighQualityLinkPreview: false
    });

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          log("WhatsApp pairing screen ready.");
        }

        if (connection === "open") {
          isConnected = true;
          pairingCode = null;

          log("WhatsApp connected successfully.");

          broadcast({
            type: "status",
            connected: true,
            pairingCode: null,
            sentCount,
            failedCount,
            jsonLoaded
          });
        }

        if (connection === "close") {
          isConnected = false;

          const statusCode =
            new Boom(
              lastDisconnect?.error
            )?.output?.statusCode;

          const loggedOut =
            statusCode ===
            DisconnectReason.loggedOut;

          sock = null;

          broadcast({
            type: "status",
            connected: false,
            pairingCode,
            sentCount,
            failedCount,
            jsonLoaded
          });

          if (loggedOut) {
            log(
              "WhatsApp logged out. Pair again."
            );
          } else {
            log(
              "Connection closed. Reconnecting..."
            );

            setTimeout(() => {
              startWhatsApp();
            }, 3000);
          }
        }
      }
    );

  } catch (err) {
    console.error(err);

    sock = null;

    log(
      "WhatsApp start error: " +
      err.message
    );
  } finally {
    reconnecting = false;
  }
}

/* ==========================================
   PAIRING CODE
========================================== */

app.post("/api/pair", async (req, res) => {
  try {
    let phone = String(
      req.body.phone || ""
    ).replace(/\D/g, "");

    if (!phone) {
      return res.status(400).json({
        error:
          "WhatsApp phone number required."
      });
    }

    if (phone.length < 8) {
      return res.status(400).json({
        error:
          "Valid international number enter karo."
      });
    }

    currentPhone = phone;

    if (!sock) {
      await startWhatsApp();
    }

    /*
      Baileys pairing code requires
      an active socket and an unregistered
      WhatsApp account.
    */

    if (
      sock &&
      !sock.authState?.creds?.registered
    ) {
      try {
        const code =
          await sock.requestPairingCode(
            phone
          );

        pairingCode = code;

        log(
          `Pairing code generated for ${phone}`
        );

        broadcast({
          type: "pairing",
          code,
          phone
        });

        return res.json({
          success: true,
          code,
          phone
        });
      } catch (err) {
        console.error(err);

        return res.status(500).json({
          error:
            "Pairing code generate nahi hua: " +
            err.message
        });
      }
    }

    if (
      sock &&
      sock.authState?.creds?.registered
    ) {
      return res.json({
        success: true,
        connected: isConnected,
        message:
          "WhatsApp session already registered."
      });
    }

    return res.status(500).json({
      error:
        "WhatsApp socket ready nahi hai."
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error:
        err.message ||
        "Pairing failed."
    });
  }
});

/* ==========================================
   STATUS
========================================== */

app.get("/api/status", (req, res) => {
  res.json({
    connected: isConnected,
    pairingCode,
    phone: currentPhone,
    sentCount,
    failedCount,
    jsonLoaded
  });
});

/* ==========================================
   JSON PASTE
========================================== */

app.post(
  "/api/json/paste",
  (req, res) => {
    try {
      const raw =
        typeof req.body.json === "string"
          ? req.body.json.trim()
          : "";

      if (!raw) {
        return res.status(400).json({
          error: "JSON paste karo."
        });
      }

      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return res.status(400).json({
          error:
            "Invalid JSON format."
        });
      }

      loadedJson = parsed;
      jsonLoaded = true;

      log("JSON pasted successfully.");

      broadcast({
        type: "json",
        loaded: true
      });

      res.json({
        success: true
      });

    } catch (err) {
      res.status(500).json({
        error: err.message
      });
    }
  }
);

/* ==========================================
   JSON UPLOAD
========================================== */

app.post(
  "/api/json/upload",
  upload.single("jsonFile"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            "JSON file select karo."
        });
      }

      const raw =
        req.file.buffer.toString("utf8");

      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return res.status(400).json({
          error:
            "Uploaded file valid JSON nahi hai."
        });
      }

      loadedJson = parsed;
      jsonLoaded = true;

      log(
        `JSON uploaded: ${req.file.originalname}`
      );

      broadcast({
        type: "json",
        loaded: true
      });

      res.json({
        success: true,
        filename:
          req.file.originalname
      });

    } catch (err) {
      res.status(500).json({
        error: err.message
      });
    }
  }
);

/* ==========================================
   CLEAR JSON
========================================== */

app.post(
  "/api/json/clear",
  (req, res) => {
    loadedJson = null;
    jsonLoaded = false;

    log("Loaded JSON cleared.");

    broadcast({
      type: "json",
      loaded: false
    });

    res.json({
      success: true
    });
  }
);

/* ==========================================
   TXT FILE
========================================== */

app.post(
  "/api/txt/upload",
  upload.single("txtFile"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            "TXT file select karo."
        });
      }

      const text =
        req.file.buffer.toString("utf8");

      const lines =
        text
          .split(/\r?\n/)
          .map(x => x.trim())
          .filter(Boolean);

      log(
        `TXT loaded: ${req.file.originalname} (${lines.length} lines)`
      );

      res.json({
        success: true,
        filename:
          req.file.originalname,
        lines: lines.length
      });

    } catch (err) {
      res.status(500).json({
        error: err.message
      });
    }
  }
);

/* ==========================================
   SEND MESSAGE
========================================== */

app.post(
  "/api/message",
  async (req, res) => {
    try {
      if (!sock || !isConnected) {
        return res.status(400).json({
          error:
            "WhatsApp connected nahi hai."
        });
      }

      const recipient =
        String(
          req.body.recipient || ""
        ).trim();

      const hereName =
        String(
          req.body.hereName || ""
        ).trim();

      const message =
        String(
          req.body.message || ""
        ).trim();

      if (!recipient) {
        return res.status(400).json({
          error:
            "Group UID ya WhatsApp number required hai."
        });
      }

      if (!message) {
        return res.status(400).json({
          error:
            "Message required hai."
        });
      }

      let jid = recipient;

      /*
        Group:
        120363xxxx@g.us

        Personal number:
        919876543210
      */

      if (!jid.includes("@")) {
        const digits =
          jid.replace(/\D/g, "");

        if (!digits) {
          return res.status(400).json({
            error:
              "Valid number/Group UID enter karo."
          });
        }

        jid =
          `${digits}@s.whatsapp.net`;
      }

      let finalMessage =
        message;

      if (hereName) {
        finalMessage =
          `${hereName}\n\n${message}`;
      }

      await sock.sendMessage(
        jid,
        {
          text: finalMessage
        }
      );

      sentCount++;

      log(
        `Message sent -> ${jid}`
      );

      broadcast({
        type: "message_sent",
        recipient: jid,
        hereName,
        sentCount
      });

      res.json({
        success: true,
        recipient: jid,
        message:
          "Message sent successfully."
      });

    } catch (err) {
      failedCount++;

      log(
        "Message failed: " +
        err.message
      );

      broadcast({
        type: "message_failed",
        failedCount
      });

      res.status(500).json({
        error:
          err.message ||
          "Message send failed."
      });
    }
  }
);

/* ==========================================
   HEALTH
========================================== */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connected: isConnected
  });
});

/* ==========================================
   START SERVER
========================================== */

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log(
      `RK RAJA XWD running on port ${PORT}`
    );

    await startWhatsApp();
  }
);
