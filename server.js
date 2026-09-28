/**
 * RK RAJA XWD WhatsApp Dashboard - Server
 * Attempts to handle companion_reg_refresh for pairing code fix
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  Browsers,
  delay
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------
// SSE Setup
// ---------------------------------------------------------------
let sseClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => {
    try {
      client.res.write(payload);
    } catch (e) {}
  });
}

function log(message, type = 'info') {
  const entry = { time: new Date().toISOString(), type, message };
  broadcast('terminal', entry);
  console.log(`[${type}] ${message}`);
}

// ---------------------------------------------------------------
// Global State
// ---------------------------------------------------------------
let sock = null;
let connectionStatus = 'disconnected';
let pairingCode = null;
let isLoggedOut = false;
let reconnectTimer = null;
let currentVersion = null;

// ---------------------------------------------------------------
// Normalize Phone Number
// ---------------------------------------------------------------
function normalisePhoneNumber(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '');
}

// ---------------------------------------------------------------
// Fetch Latest WhatsApp Web Version
// ---------------------------------------------------------------
async function resolveWaVersion() {
  try {
    const { version } = await fetchLatestWaWebVersion({});
    if (version && Array.isArray(version) && version.length === 3) {
      log(`WhatsApp Web version resolved: ${version.join('.')}`, 'success');
      return version;
    }
    throw new Error('Invalid version format');
  } catch (err) {
    log(`Could not fetch latest WA Web version: ${err.message}. Using Baileys default.`, 'warn');
    return undefined;
  }
}

// ---------------------------------------------------------------
// Wait for Socket Ready
// ---------------------------------------------------------------
function waitForSocketOpen(sockInstance) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Socket connection timed out. Please try again.'));
    }, 30000);

    const onUpdate = (update) => {
      if (update.connection === 'connecting' || update.qr) {
        clearTimeout(timeout);
        sockInstance.ev.off('connection.update', onUpdate);
        resolve();
      }
    };
    sockInstance.ev.on('connection.update', onUpdate);
  });
}

// ---------------------------------------------------------------
// Create Socket
// ---------------------------------------------------------------
async function createSocket() {
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.end(undefined);
    } catch (e) {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = currentVersion || await resolveWaVersion();
  currentVersion = version;

  log(`Creating WhatsApp socket (version: ${version ? version.join('.') : 'default'})`, 'info');

  // Attach trace-level logger to see protocol exchanges
  const logger = pino({ level: 'trace' });

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryDelayMs: 2000,
    maxRetries: 5,
    logger: logger, // Enable trace logging
    getMessage: async () => undefined
  });

  sock.ev.on('creds.update', saveCreds);

  // ---------------------------------------------------------------
  // Handle raw notifications (for companion_reg_refresh)
  // ---------------------------------------------------------------
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('QR received (ignoring, using pairing code).', 'info');
    }

    if (connection === 'connecting') {
      connectionStatus = 'connecting';
      broadcast('status', { status: 'connecting' });
      log('Connecting to WhatsApp…', 'info');
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      isLoggedOut = false;
      pairingCode = null;
      broadcast('status', { status: 'open' });
      broadcast('pairing', { code: null });
      log('✅ WhatsApp connected successfully!', 'success');

      try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map((g) => ({
          id: g.id,
          subject: g.subject
        }));
        broadcast('groups', groupList);
        log(`Loaded ${groupList.length} groups.`, 'info');
      } catch (e) {
        log(`Could not fetch groups: ${e.message}`, 'warn');
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'unknown';

      connectionStatus = 'close';
      broadcast('status', { status: 'close', reason });

      if (statusCode === DisconnectReason.loggedOut) {
        isLoggedOut = true;
        log('❌ Logged out. Fresh pairing required.', 'error');
        broadcast('status', { status: 'loggedOut' });
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        log('Restart required. Reconnecting…', 'warn');
        broadcast('status', { status: 'restartRequired' });
        scheduleReconnect();
        return;
      }

      log(`Connection closed (${reason}). Reconnecting in 5s…`, 'warn');
      broadcast('status', { status: 'reconnecting' });
      scheduleReconnect();
    }
  });

  return sock;
}

// ---------------------------------------------------------------
// Auto Reconnect
// ---------------------------------------------------------------
function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (isLoggedOut) return;
    log('Attempting automatic reconnect…', 'info');
    try {
      await createSocket();
    } catch (e) {
      log(`Reconnect failed: ${e.message}. Retrying in 10s…`, 'error');
      scheduleReconnect();
    }
  }, 5000);
}

// ---------------------------------------------------------------
// SSE Endpoint
// ---------------------------------------------------------------
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client = { res };
  sseClients.push(client);

  res.write(`event: status\ndata: ${JSON.stringify({ status: connectionStatus })}\n\n`);
  if (pairingCode) {
    res.write(`event: pairing\ndata: ${JSON.stringify({ code: pairingCode })}\n\n`);
  }

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== client);
  });
});

// ---------------------------------------------------------------
// Pairing Endpoint
// ---------------------------------------------------------------
app.post('/api/pair', async (req, res) => {
  try {
    const rawNumber = req.body.number || req.body.phone || '';
    const number = normalisePhoneNumber(rawNumber);

    if (!number || number.length < 7) {
      return res.status(400).json({ error: 'Invalid phone number. Include country code (digits only).' });
    }

    if (fs.existsSync(AUTH_DIR)) {
      const { state } = await useMultiFileAuthState(AUTH_DIR);
      if (state.creds.registered && !isLoggedOut) {
         return res.status(400).json({ error: 'Already paired. Logout first or delete auth_info_baileys.' });
      }
    }

    isLoggedOut = false;
    currentVersion = await resolveWaVersion();

    await createSocket();
    if (!sock) throw new Error('Socket not created');

    await waitForSocketOpen(sock);

    log(`Requesting pairing code for ${number}…`, 'info');
    const code = await sock.requestPairingCode(number);

    if (!code) throw new Error('No pairing code returned');

    pairingCode = code;
    broadcast('pairing', { code });
    log(`🔑 Pairing code generated: ${code}`, 'success');

    // IMPORTANT: Wait for pair-success or timeout
    log('Waiting for phone to confirm pairing…', 'info');

    // Set a timeout to detect if pairing never completes
    const pairingTimeout = setTimeout(() => {
      log('❌ Pairing timeout. The code may have been rejected. Check terminal for details.', 'error');
      broadcast('pairing', { code: null, error: 'Pairing timeout' });
    }, 120000); // 2 minutes

    // Check if connection opens within the timeout
    const checkInterval = setInterval(() => {
      if (connectionStatus === 'open') {
        clearTimeout(pairingTimeout);
        clearInterval(checkInterval);
        log('✅ Pairing confirmed by phone!', 'success');
      }
    }, 2000);

    res.json({ success: true, code, phone: number });
  } catch (err) {
    log(`Pairing failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message || 'Failed to generate pairing code' });
  }
});

// ---------------------------------------------------------------
// Manual Reconnect Endpoint
// ---------------------------------------------------------------
app.post('/api/reconnect', async (req, res) => {
  try {
    isLoggedOut = false;
    await createSocket();
    res.json({ success: true, message: 'Reconnect initiated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------
// Logout Endpoint
// ---------------------------------------------------------------
app.post('/api/logout', async (req, res) => {
  try {
    isLoggedOut = true;
    if (sock) await sock.logout();
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = 'loggedOut';
    broadcast('status', { status: 'loggedOut' });
    log('Logged out and auth cleared.', 'warn');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------
// Send Message Endpoint (Same as before)
// ---------------------------------------------------------------
app.post('/api/send', upload.fields([
  { name: 'txtFile', maxCount: 1 },
  { name: 'jsonFile', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!sock || connectionStatus !== 'open') {
      return res.status(400).json({ error: 'WhatsApp not connected. Please pair first.' });
    }

    const hereName = req.body.hereName || '';
    const lastName = req.body.lastName || '';
    const recipient = req.body.recipient || '';
    const sendTime = req.body.sendTime || '0';
    const messages = [];

    if (req.files?.txtFile?.[0]) {
      const text = req.files.txtFile[0].buffer.toString('utf-8');
      text.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed) messages.push(trimmed);
      });
    }

    if (req.files?.jsonFile?.[0]) {
      try {
        const jsonText = req.files.jsonFile[0].buffer.toString('utf-8');
        const parsed = JSON.parse(jsonText);
        if (Array.isArray(parsed)) {
          parsed.forEach((item) => {
            if (typeof item === 'string') messages.push(item);
            else if (item && item.message) messages.push(item.message);
            else messages.push(JSON.stringify(item));
          });
        }
      } catch (e) {
        log(`JSON parse error: ${e.message}`, 'error');
      }
    }

    if (req.body.jsonPaste) {
      try {
        const parsed = JSON.parse(req.body.jsonPaste);
        if (Array.isArray(parsed)) {
          parsed.forEach((item) => {
            if (typeof item === 'string') messages.push(item);
            else if (item && item.message) messages.push(item.message);
            else messages.push(JSON.stringify(item));
          });
        }
      } catch (e) {
        log(`JSON paste parse error: ${e.message}`, 'error');
      }
    }

    if (messages.length === 0) {
      return res.status(400).json({ error: 'No messages found in TXT or JSON.' });
    }

    let jid = recipient.trim();
    if (!jid) return res.status(400).json({ error: 'Recipient required.' });

    if (!jid.includes('@')) {
      const digits = normalisePhoneNumber(jid);
      if (!digits) return res.status(400).json({ error: 'Invalid recipient number.' });
      jid = `${digits}@s.whatsapp.net`;
    }

    const delayMs = parseInt(sendTime, 10) * 1000 || 0;

    log(`Starting send: ${messages.length} message(s) to ${jid}`, 'info');

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < messages.length; i++) {
      let finalMessage = messages[i];

      if (hereName || lastName) {
        finalMessage = `${hereName} ${finalMessage} ${lastName}`.trim();
      }

      try {
        await sock.sendMessage(jid, { text: finalMessage });
        sent++;
        broadcast('sent', { count: sent });
        log(`✅ Sent [${i + 1}/${messages.length}]: ${finalMessage}`, 'success');
      } catch (e) {
        failed++;
        broadcast('failed', { count: failed });
        log(`❌ Failed [${i + 1}]: ${e.message}`, 'error');
      }

      if (delayMs > 0 && i < messages.length - 1) {
        await delay(delayMs);
      }
    }

    log(`Send complete. Sent: ${sent}, Failed: ${failed}`, sent > 0 ? 'success' : 'error');
    res.json({ success: true, sent, failed, total: messages.length });
  } catch (err) {
    log(`Send error: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Serve Dashboard
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ---------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 RK RAJA XWD dashboard running on http://0.0.0.0:${PORT}`);
  log('Server started. Waiting for pairing…', 'info');
});
