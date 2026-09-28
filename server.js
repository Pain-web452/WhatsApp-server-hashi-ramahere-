const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const app = express();

const PORT = process.env.PORT || 3000;

const AUTH_DIR = path.join(
  __dirname,
  "auth_info_baileys"
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

app.use(
  express.json({
    limit: "5mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);


/* ==========================================
   GLOBAL STATE
========================================== */

let sock = null;

let isConnected = false;

let pairingCode = null;

let currentPhone = null;

let reconnecting = false;

let pairingRequested = false;

let sentCount = 0;

let failedCount = 0;

let jsonLoaded = false;

let loadedJson = null;

const clients = new Set();


/* ==========================================
   LOGGING
========================================== */

function log(message) {

  const text =
    `[${new Date().toLocaleTimeString()}] ${message}`;

  console.log(text);

  broadcast({
    type: "log",
    message: text
  });
}


/* ==========================================
   SSE BROADCAST
========================================== */

function broadcast(data) {

  const payload =
    `data: ${JSON.stringify(data)}\n\n`;

  for (const client of clients) {

    try {

      client.write(payload);

    } catch (err) {

      clients.delete(client);

    }
  }
}


/* ==========================================
   EVENTS
========================================== */

app.get(
  "/events",
  (req, res) => {

    res.setHeader(
      "Content-Type",
      "text/event-stream"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    res.flushHeaders();

    clients.add(res);

    res.write(
      `data: ${JSON.stringify({
        type: "status",
        connected: isConnected,
        pairingCode,
        phone: currentPhone,
        sentCount,
        failedCount,
        jsonLoaded
      })}\n\n`
    );

    req.on(
      "close",
      () => {
        clients.delete(res);
      }
    );
  }
);


/* ==========================================
   DASHBOARD
========================================== */

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "dashboard.html"
      )
    );
  }
);


/* ==========================================
   WHATSAPP CONNECTION
========================================== */

async function startWhatsApp() {

  if (reconnecting) {
    return;
  }

  if (sock) {
    return;
  }

  reconnecting = true;

  try {

    fs.mkdirSync(
      AUTH_DIR,
      {
        recursive: true
      }
    );

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        AUTH_DIR
      );


    /* --------------------------------------
       GET CURRENT WHATSAPP WEB VERSION
    -------------------------------------- */

    let waVersion = null;

    try {

      if (
        typeof fetchLatestWaWebVersion ===
        "function"
      ) {

        const latest =
          await fetchLatestWaWebVersion();

        if (
          latest &&
          Array.isArray(latest.version)
        ) {

          waVersion =
            latest.version;

          log(
            "Live WhatsApp Web version: " +
            waVersion.join(".")
          );

        }

      } else {

        log(
          "fetchLatestWaWebVersion unavailable; using Baileys default version."
        );

      }

    } catch (versionError) {

      log(
        "Could not fetch live WA Web version: " +
        versionError.message
      );

    }


    /* --------------------------------------
       SOCKET OPTIONS
    -------------------------------------- */

    const socketOptions = {

      auth: state,

      printQRInTerminal: false,

      /*
        WEB_BROWSER identity.
        Desktop identity avoid kar rahe hain.
      */

      browser: [
        "RK RAJA XWD",
        "Chrome",
        "1.0.0"
      ],

      generateHighQualityLinkPreview:
        false,

      syncFullHistory:
        false,

      markOnlineOnConnect:
        false
    };


    /*
      Current WhatsApp Web version
      available ho to explicitly use karo.
    */

    if (waVersion) {

      socketOptions.version =
        waVersion;
    }


    log(
      "Starting WhatsApp socket..."
    );


    sock =
      makeWASocket(
        socketOptions
      );


    /* --------------------------------------
       SAVE CREDENTIALS
    -------------------------------------- */

    sock.ev.on(
      "creds.update",
      saveCreds
    );


    /* --------------------------------------
       CONNECTION UPDATE
    -------------------------------------- */

    sock.ev.on(
      "connection.update",
      async (update) => {

        const {
          connection,
          lastDisconnect
        } = update;


        /* ==============================
           OPEN
        ============================== */

        if (
          connection === "open"
        ) {

          isConnected = true;

          pairingCode = null;

          pairingRequested =
            false;

          log(
            "WhatsApp connected successfully."
          );

          broadcast({
            type: "status",

            connected: true,

            pairingCode: null,

            phone: currentPhone,

            sentCount,

            failedCount,

            jsonLoaded
          });

          return;
        }


        /* ==============================
           CLOSE
        ============================== */

        if (
          connection === "close"
        ) {

          isConnected = false;

          const statusCode =
            new Boom(
              lastDisconnect?.error
            )?.output?.statusCode;


          log(
            `WhatsApp connection closed. Status: ${statusCode || "unknown"}`
          );


          broadcast({
            type: "status",

            connected: false,

            pairingCode,

            phone: currentPhone,

            sentCount,

            failedCount,

            jsonLoaded
          });


          sock = null;


          /* ------------------------------
             LOGGED OUT
          ------------------------------ */

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {

            pairingCode = null;

            pairingRequested =
              false;

            log(
              "WhatsApp logged out. Fresh pairing required."
            );

            return;
          }


          /* ------------------------------
             RESTART REQUIRED
          ------------------------------ */

          if (
            statusCode ===
            DisconnectReason.restartRequired
          ) {

            log(
              "WhatsApp requested restart. Restarting socket..."
            );

          } else {

            log(
              "Connection lost. Reconnecting..."
            );
          }


          setTimeout(
            () => {

              startWhatsApp();

            },
            3000
          );
        }

      }
    );


  } catch (error) {

    console.error(
      "WhatsApp start error:",
      error
    );

    sock = null;

    isConnected = false;

    log(
      "WhatsApp start error: " +
      error.message
    );

    setTimeout(
      () => {
        startWhatsApp();
      },
      5000
    );

  } finally {

    reconnecting = false;
  }
}


/* ==========================================
   PAIRING CODE
========================================== */

app.post(
  "/api/pair",
  async (req, res) => {

    try {

      let phone =
        String(
          req.body.phone || ""
        ).replace(
          /\D/g,
          ""
        );


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


      /* ----------------------------------
         START SOCKET
      ---------------------------------- */

      if (!sock) {

        await startWhatsApp();

      }


      /*
        Socket initialization asynchronous
        ho sakta hai, isliye thoda wait.
      */

      let attempts = 0;

      while (
        !sock &&
        attempts < 20
      ) {

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              500
            )
        );

        attempts++;
      }


      if (!sock) {

        return res.status(503).json({
          error:
            "WhatsApp socket ready nahi hua. Thodi der baad try karo."
        });
      }


      /* ----------------------------------
         ALREADY CONNECTED
      ---------------------------------- */

      if (isConnected) {

        return res.json({

          success: true,

          connected: true,

          message:
            "WhatsApp already connected."
        });
      }


      /* ----------------------------------
         CHECK AUTH STATE
      ---------------------------------- */

      if (
        sock.authState &&
        sock.authState.creds &&
        sock.authState.creds.registered
      ) {

        return res.json({

          success: true,

          connected: false,

          message:
            "Existing WhatsApp session found. Reconnecting..."
        });
      }


      /* ----------------------------------
         REQUEST PAIRING CODE
      ---------------------------------- */

      if (
        typeof sock.requestPairingCode !==
        "function"
      ) {

        return res.status(500).json({
          error:
            "This Baileys version does not support pairing code."
        });
      }


      pairingRequested = true;


      log(
        "Requesting fresh pairing code..."
      );


      const code =
        await sock.requestPairingCode(
          phone
        );


      pairingCode = code;


      log(
        "PAIRING CODE GENERATED: " +
        code
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


    } catch (error) {

      console.error(
        "Pairing error:",
        error
      );


      pairingCode = null;


      log(
        "Pairing error: " +
        error.message
      );


      return res.status(500).json({

        error:
          error.message ||
          "Pairing code generate nahi hua."
      });
    }
  }
);


/* ==========================================
   STATUS
========================================== */

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      connected:
        isConnected,

      pairingCode,

      phone:
        currentPhone,

      sentCount,

      failedCount,

      jsonLoaded
    });
  }
);


/* ==========================================
   JSON PASTE
========================================== */

app.post(
  "/api/json/paste",
  (req, res) => {

    try {

      const raw =
        typeof req.body.json ===
        "string"
          ? req.body.json.trim()
          : "";


      if (!raw) {

        return res.status(400).json({
          error:
            "JSON paste karo."
        });
      }


      let parsed;

      try {

        parsed =
          JSON.parse(raw);

      } catch (error) {

        return res.status(400).json({
          error:
            "Invalid JSON format."
        });
      }


      loadedJson =
        parsed;

      jsonLoaded =
        true;


      log(
        "JSON pasted successfully."
      );


      broadcast({

        type: "json",

        loaded: true
      });


      res.json({
        success: true
      });


    } catch (error) {

      res.status(500).json({
        error:
          error.message
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
        req.file.buffer.toString(
          "utf8"
        );


      let parsed;

      try {

        parsed =
          JSON.parse(raw);

      } catch (error) {

        return res.status(400).json({
          error:
            "Uploaded file valid JSON nahi hai."
        });
      }


      loadedJson =
        parsed;

      jsonLoaded =
        true;


      log(
        "JSON uploaded: " +
        req.file.originalname
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


    } catch (error) {

      res.status(500).json({
        error:
          error.message
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

    loadedJson =
      null;

    jsonLoaded =
      false;


    log(
      "Loaded JSON cleared."
    );


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
   TXT UPLOAD
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
        req.file.buffer.toString(
          "utf8"
        );


      const lines =
        text
          .split(/\r?\n/)
          .map(
            line =>
              line.trim()
          )
          .filter(Boolean);


      log(
        `TXT loaded: ${req.file.originalname} (${lines.length} lines)`
      );


      res.json({

        success: true,

        filename:
          req.file.originalname,

        lines:
          lines.length
      });


    } catch (error) {

      res.status(500).json({
        error:
          error.message
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

      if (
        !sock ||
        !isConnected
      ) {

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


      let jid =
        recipient;


      /*
        Group UID:
        120363xxxx@g.us

        Personal number:
        919876543210
      */

      if (
        !jid.includes("@")
      ) {

        const digits =
          jid.replace(
            /\D/g,
            ""
          );


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
          text:
            finalMessage
        }
      );


      sentCount++;


      log(
        `Message sent -> ${jid}`
      );


      broadcast({

        type:
          "message_sent",

        recipient:
          jid,

        hereName,

        sentCount
      });


      res.json({

        success:
          true,

        recipient:
          jid,

        message:
          "Message sent successfully."
      });


    } catch (error) {

      failedCount++;


      log(
        "Message failed: " +
        error.message
      );


      broadcast({

        type:
          "message_failed",

        failedCount
      });


      res.status(500).json({

        error:
          error.message ||
          "Message send failed."
      });
    }
  }
);


/* ==========================================
   HEALTH
========================================== */

app.get(
  "/health",
  (req, res) => {

    res.json({

      status:
        "ok",

      connected:
        isConnected
    });
  }
);


/* ==========================================
   SERVER START
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
