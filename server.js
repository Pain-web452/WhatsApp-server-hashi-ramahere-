/**
 * RK RAJA XWD WhatsApp Dashboard - Server
 * Fixes pairing code flow using fetchLatestWaWebVersion
 * Keeps all existing dashboard features intact.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Boom = require('@hapi/boom');

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

// ---------------------------------------------------------------
// Multer setup (memory storage – files are read directly)
// ---------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------
// SSE (Server-Sent Events) – live terminal & status
// ---------------------------------------------------------------
let sseClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => {
    try {
      client.res.write(payload);
    } catch (e) {
      // client disconnected – ignore
    }
  });
}

function log(message, type = 'info') {
  const entry = {
    time: new Date().toISOString(),
    type,
    message
  };
  broadcast('terminal', entry);
  console.log(`[${type}] ${message}`);
}

// ---------------------------------------------------------------
// Global WhatsApp socket state
// ---------------------------------------------------------------
let sock = null;
let connectionStatus = 'disconnected';
let pairingCode = null;
let isLoggedOut = false;
let reconnectTimer = null;
let currentPhoneNumber = null;
let currentVersion = null;

// ---------------------------------------------------------------
// Phone number normalisation
// ---------------------------------------------------------------
function normalisePhoneNumber(raw) {
  if (!raw) return '';
  // Remove everything that is not a digit
  return String(raw).replace(/\D/g, '');
}

// ---------------------------------------------------------------
// Resolve latest WhatsApp Web version safely
// ---------------------------------------------------------------
async function resolveWaVersion() {
  try {
    const { version } = await fetchLatestWaWebVersion({});
    if (version && Array.isArray(version) && version.length === 3) {
      log(`WhatsApp Web version resolved: ${version.join('.')}`, 'success');
      return version;
    }
    throw new Error('Invalid version format returned');
  } catch (err) {
    log(`Could not fetch latest WA Web version: ${err.message}. Using Baileys default.`, 'warn');
    return undefined; // let Baileys use its own default
  }
}

// ---------------------------------------------------------------
// Create / recreate the WhatsApp socket
// ---------------------------------------------------------------
async function createSocket() {
  // Clean up old socket listeners if any
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.end(undefined);
    } catch (e) {
      // ignore
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = currentVersion || await resolveWaVersion();
  currentVersion = version;

  log(`Creating WhatsApp socket (version: ${version ? version.join('.') : 'default'})`, 'info');

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'), // canonical label for pairing
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryDelayMs: 2000,
    maxRetries: 5,
    getMessage: async () => undefined
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('QR received (pairing code mode – ignoring QR).', 'info');
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

      // Send list of groups / contacts after connection
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
        // Do NOT auto-reconnect
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        log('Restart required. Reconnecting…', 'warn');
        broadcast('status', { status: 'restartRequired' });
        scheduleReconnect();
        return;
      }

      // Any other unexpected close → reconnect
      log(`Connection closed (${reason}). Reconnecting in 5s…`, 'warn');
      broadcast('status', { status: 'reconnecting' });
      scheduleReconnect();
    }
  });

  return sock;
}

// ---------------------------------------------------------------
// Schedule automatic reconnect
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
// SSE endpoint – live terminal & events
// ---------------------------------------------------------------
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client = { res };
  sseClients.push(client);

  // Send current status immediately
  res.write(`event: status\ndata: ${JSON.stringify({ status: connectionStatus })}\n\n`);
  if (pairingCode) {
    res.write(`event: pairing\ndata: ${JSON.stringify({ code: pairingCode })}\n\n`);
  }

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== client);
  });
});

// ---------------------------------------------------------------
// Pairing code endpoint
// ---------------------------------------------------------------
app.post('/api/pair', async (req, res) => {
  try {
    const rawNumber = req.body.number || req.body.phone || '';
    const number = normalisePhoneNumber(rawNumber);

    if (!number || number.length < 7) {
      return res.status(400).json({ error: 'Invalid phone number. Include country code (digits only).' });
    }

    if (isLoggedOut) {
      // Clear old auth on fresh pairing request
      isLoggedOut = false;
    }

    // Always create a fresh socket for pairing to avoid stale state
    // (Do not delete existing auth if already registered)
    const { state } = await useMultiFileAuthState(AUTH_DIR);
    if (state.creds.registered) {
      return res.status(400).json({
        error: 'Already paired. Use the connected session or delete auth_info_baileys to re-pair.'
      });
    }

    currentPhoneNumber = number;
    currentVersion = await resolveWaVersion();

    // Build the socket (will be used for pairing)
    await createSocket();

    if (!sock) {
      throw new Error('Socket not created');
    }

    // Wait until the socket is in "connecting" or "qr" state before requesting pairing code
    let waited = 0;
    while (waited < 15000 && connectionStatus === 'disconnected') {
      await delay(300);
      waited += 300;
    }

    log(`Requesting pairing code for ${number}…`, 'info');
    const code = await sock.requestPairingCode(number);

    if (!code) {
      throw new Error('No pairing code returned');
    }

    pairingCode = code;
    broadcast('pairing', { code });
    log(`🔑 Pairing code generated: ${code}`, 'success');

    res.json({ success: true, code, phone: number });
  } catch (err) {
    log(`Pairing failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message || 'Failed to generate pairing code' });
  }
});

// ---------------------------------------------------------------
// Reconnect endpoint (manual)
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
// Logout endpoint
// ---------------------------------------------------------------
app.post('/api/logout', async (req, res) => {
  try {
    isLoggedOut = true;
    if (sock) {
      await sock.logout();
    }
    // Clear auth folder
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
// Send message endpoint (TXT / JSON)
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

    // --- TXT file (line-by-line) ---
    if (req.files?.txtFile?.[0]) {
      const text = req.files.txtFile[0].buffer.toString('utf-8');
      text.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed) messages.push(trimmed);
      });
    }

    // --- JSON paste / file ---
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

    // --- JSON pasted in body ---
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

    // Build recipient JID
    let jid = recipient.trim();
    if (!jid) return res.status(400).json({ error: 'Recipient (group UID or number) is required.' });

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

      // Apply hereName and lastName: "hereName + message + lastName"
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
// Serve dashboard
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ---------------------------------------------------------------
// Start server
// ---------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 RK RAJA XWD dashboard running on http://0.0.0.0:${PORT}`);
  log('Server started. Waiting for pairing…', 'info');
});
