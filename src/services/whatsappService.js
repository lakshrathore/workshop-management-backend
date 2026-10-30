// ── WhatsApp Service (Baileys, self-hosted) ──────────────────────────────────
// Keeps one WhatsApp Web connection open from the server and sends text
// messages through it. Linked once by scanning a QR code in
// Settings → WhatsApp (the QR comes from getWhatsAppStatus()).
//
// Session keys live in the `whatsapp_auth` DB table (same shape as Baileys'
// useMultiFileAuthState, just stored in MySQL) because Railway wipes the disk
// on every deploy — a folder would force a re-scan after each deploy.
//
// Only ONE server may hold the session. Local dev shares the live DB, so the
// service only starts on Railway, or when WHATSAPP_ENABLED=true is set.
// WHATSAPP_ENABLED=false turns it off everywhere.
//
// Nothing here ever throws into callers: sending returns { sent, reason }.

const QRCode = require('qrcode');
const { getPool } = require('../database');

const MAX_QUEUE = 20;                    // messages held while disconnected
const QUEUE_MAX_AGE_MS = 30 * 60 * 1000; // drop queued alerts older than 30 min

let baileys = null;          // ESM module, loaded with dynamic import()
let sock = null;
let status = 'disabled';     // disabled | starting | qr | waiting_for_scan | connected | reconnecting | logged_out | error
let lastQr = null;           // data: URL of the current QR code
let lastError = null;
let connectedAs = null;      // linked WhatsApp number
let reconnectTimer = null;
let reconnectDelay = 5000;
const queue = [];

// Copies of recently sent messages. When a phone can't decrypt a message it
// shows "Waiting for this message" and asks us to resend; Baileys can only do
// that through getMessage(), so we keep the last messages for a while.
const SENT_CACHE_MAX = 300;
const SENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const sentMessages = new Map(); // id -> { message, at }

function rememberSent(msg) {
  if (!msg?.key?.id || !msg.message) return;
  sentMessages.set(msg.key.id, { message: msg.message, at: Date.now() });
  if (sentMessages.size > SENT_CACHE_MAX) sentMessages.delete(sentMessages.keys().next().value);
}

async function getMessage(key) {
  const hit = key?.id && sentMessages.get(key.id);
  if (!hit) return undefined;
  if (Date.now() - hit.at > SENT_CACHE_TTL_MS) { sentMessages.delete(key.id); return undefined; }
  return hit.message;
}

// Retry counters per message (Baileys expects a get/set/del cache object).
const retryCounts = new Map();
const msgRetryCounterCache = {
  get: (k) => retryCounts.get(k),
  set: (k, v) => { retryCounts.set(k, v); if (retryCounts.size > 1000) retryCounts.delete(retryCounts.keys().next().value); return true; },
  del: (k) => retryCounts.delete(k),
  flushAll: () => retryCounts.clear(),
};

// Minimal silent logger (Baileys requires one; keep only warnings/errors).
// ── Diagnostics (shown in Settings → WhatsApp Alerts) ─────────────────────────
// Last Baileys warnings/errors, and the delivery status of recent sends.
const recentLogs = [];   // { at, level, text }
const recentSends = [];  // { id, to, kind, name, at, status, error }
const STATUS_NAMES = { 0: 'error', 1: 'pending', 2: 'server', 3: 'delivered', 4: 'read', 5: 'played' };

function describeLog(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try {
      const o = a && typeof a === 'object' ? { ...a } : a;
      if (o && o.err) o.err = o.err.message || String(o.err);
      if (o && o.error) o.error = o.error.message || String(o.error);
      return JSON.stringify(o);
    } catch { return String(a); }
  }).join(' ').slice(0, 400);
}

function pushLog(level, args) {
  recentLogs.push({ at: new Date().toISOString(), level, text: describeLog(args) });
  if (recentLogs.length > 30) recentLogs.shift();
}

function trackSend(msg, to, kind, name) {
  if (!msg?.key?.id) return;
  recentSends.unshift({ id: msg.key.id, to, kind, name: name || null, at: new Date().toISOString(), status: 'sent' });
  if (recentSends.length > 20) recentSends.pop();
}

function updateSendStatus(id, status) {
  const item = recentSends.find((s) => s.id === id);
  if (!item) return;
  const order = ['error', 'pending', 'sent', 'server', 'delivered', 'read', 'played'];
  if (order.indexOf(status) > order.indexOf(item.status) || status === 'error') item.status = status;
}

// Baileys logger: keep warnings/errors for the diagnostics panel (and Railway logs).
const logger = {
  level: 'warn',
  child() { return logger; },
  trace() {}, debug() {}, info() {},
  warn(...a) { pushLog('warn', a); if (process.env.WHATSAPP_DEBUG) console.warn('[whatsapp]', ...a); },
  error(...a) { pushLog('error', a); console.error('[whatsapp]', describeLog(a)); },
  fatal(...a) { pushLog('fatal', a); console.error('[whatsapp] fatal', describeLog(a)); },
};

let libraryVersion = null;
function baileysVersion() {
  if (libraryVersion) return libraryVersion;
  try {
    const pkg = require('path').join(__dirname, '../../node_modules/@whiskeysockets/baileys/package.json');
    libraryVersion = JSON.parse(require('fs').readFileSync(pkg, 'utf8')).version;
  } catch { libraryVersion = 'unknown'; }
  return libraryVersion;
}

function isEnabledForThisServer() {
  const flag = (process.env.WHATSAPP_ENABLED || '').toLowerCase();
  if (flag === 'false' || flag === '0') return false;
  if (flag === 'true' || flag === '1') return true;
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME);
}

// ── Phone numbers ───────────────────────────────────────────────────────────
// Accepts "+91 98765-43210", "098765 43210", "9876543210", "919876543210".
// Returns digits with country code (e.g. "919876543210"), or null if invalid.
function formatPhoneNumber(input) {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);           // 0091...
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1); // 09876...
  if (digits.length === 10) {
    if (!/^[6-9]/.test(digits)) return null; // Indian mobiles start with 6–9
    digits = `91${digits}`;
  }
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

// ── DB-backed auth state (drop-in for useMultiFileAuthState) ──────────────────
async function useDbAuthState() {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  const db = await getPool();

  const read = async (id) => {
    const [[row]] = await db.query('SELECT data FROM whatsapp_auth WHERE id=?', [id]);
    return row ? JSON.parse(row.data, BufferJSON.reviver) : null;
  };
  const write = (id, value) => db.query(
    'INSERT INTO whatsapp_auth (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data=VALUES(data)',
    [id, JSON.stringify(value, BufferJSON.replacer)],
  );
  const remove = (id) => db.query('DELETE FROM whatsapp_auth WHERE id=?', [id]);

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          }));
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              tasks.push(value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

async function clearSession() {
  const db = await getPool();
  await db.query('DELETE FROM whatsapp_auth');
}

// ── Connection ────────────────────────────────────────────────────────────────
function scheduleReconnect(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { connect().catch(onFatal); }, delay);
}

function onFatal(err) {
  status = 'error';
  lastError = err.message;
  console.error('❌ [whatsapp] error:', err.message);
  scheduleReconnect(60000);
}

async function connect() {
  const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;
  const { state, saveCreds } = await useDbAuthState();

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use bundled version */ }

  if (sock) { try { sock.ev.removeAllListeners(); sock.end(undefined); } catch { /* ignore */ } }

  sock = makeWASocket({
    auth: state,
    logger,
    ...(version ? { version } : {}),
    browser: Browsers.ubuntu('MOJI Factory Alerts'),
    markOnlineOnConnect: false,   // don't hide the admin's phone notifications
    syncFullHistory: false,
    getMessage,              // lets Baileys resend when a phone couldn't decrypt
    msgRetryCounterCache,
  });

  sock.ev.on('creds.update', saveCreds);

  // Delivery ticks for the diagnostics list.
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates || []) {
      if (key?.fromMe && update?.status !== undefined) updateSendStatus(key.id, STATUS_NAMES[update.status] || String(update.status));
    }
  });
  sock.ev.on('message-receipt.update', (receipts) => {
    for (const { key, receipt } of receipts || []) {
      if (!key?.fromMe) continue;
      if (receipt?.readTimestamp) updateSendStatus(key.id, 'read');
      else if (receipt?.receiptTimestamp) updateSendStatus(key.id, 'delivered');
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status = 'qr';
      lastQr = await QRCode.toDataURL(qr, { margin: 1, width: 280 }).catch(() => null);
    }

    if (connection === 'open') {
      status = 'connected';
      lastQr = null;
      lastError = null;
      reconnectDelay = 5000;
      connectedAs = (sock.user?.id || '').split(':')[0].split('@')[0] || null;
      console.log(`✅ [whatsapp] connected${connectedAs ? ` as +${connectedAs}` : ''}`);
      flushQueue();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const wasShowingQr = status === 'qr';
      connectedAs = null;
      if (code === DisconnectReason.restartRequired) {
        // Normal right after a QR scan: WhatsApp asks for a fresh connection.
        status = 'starting';
        scheduleReconnect(500);
      } else if (wasShowingQr && code !== DisconnectReason.loggedOut) {
        // Nobody scanned the QR in time. Stop here instead of generating QR codes
        // forever; the Settings page restarts it when someone opens it.
        status = 'waiting_for_scan';
        lastQr = null;
      } else if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: wipe keys and show a fresh QR.
        console.warn('⚠️ [whatsapp] logged out — new QR scan needed');
        status = 'logged_out';
        await clearSession().catch(() => {});
        scheduleReconnect(2000);
      } else if (code === DisconnectReason.connectionReplaced) {
        // Another server took the session (e.g. during a deploy overlap).
        // Back off instead of fighting over it.
        console.warn('⚠️ [whatsapp] session opened elsewhere — retrying in 2 min');
        status = 'reconnecting';
        scheduleReconnect(120000);
      } else {
        status = 'reconnecting';
        lastError = lastDisconnect?.error?.message || null;
        scheduleReconnect(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      }
    }
  });
}

// Start once on server boot. Never throws; never blocks startup.
async function initWhatsApp() {
  if (!isEnabledForThisServer()) {
    status = 'disabled';
    console.log('ℹ️  [whatsapp] not started on this server (set WHATSAPP_ENABLED=true to enable)');
    return;
  }
  try {
    status = 'starting';
    baileys = await import('@whiskeysockets/baileys');
    await connect();
  } catch (err) {
    onFatal(err);
  }
}

// Unlink and show a new QR (Settings → "Unlink / re-scan").
async function resetWhatsAppSession() {
  if (!baileys) throw new Error('WhatsApp service is not running on this server');
  try { await sock?.logout(); } catch { /* already gone */ }
  await clearSession();
  status = 'starting';
  scheduleReconnect(1000);
}

function getWhatsAppStatus() {
  // Someone is looking at the Settings page: fetch a fresh QR if one expired.
  if (status === 'waiting_for_scan' && baileys) {
    status = 'starting';
    scheduleReconnect(0);
  }
  return {
    enabled_on_server: isEnabledForThisServer(),
    status,                       // see top of file
    connected: status === 'connected',
    connected_number: connectedAs,
    qr: status === 'qr' ? lastQr : null,
    queued: queue.length,
    error: lastError,
    library_version: baileysVersion(),
    recent_sends: recentSends,
    recent_logs: recentLogs.slice(-15).reverse(),
  };
}

// ── Sending ───────────────────────────────────────────────────────────────────
async function deliver(phone, message) {
  const jid = `${phone}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text: message });
  rememberSent(sent);
  trackSend(sent, phone, 'text');
}

function flushQueue() {
  const now = Date.now();
  while (queue.length) {
    const item = queue.shift();
    if (now - item.at > QUEUE_MAX_AGE_MS) continue;
    deliver(item.phone, item.message).catch((e) => console.warn('[whatsapp] queued send failed:', e.message));
  }
}

// Send a text message. Never throws. If WhatsApp is briefly disconnected the
// message is queued (max 20, 30 min) and sent on reconnect.
async function sendWhatsAppNotification(phoneNumber, message) {
  const phone = formatPhoneNumber(phoneNumber);
  if (!phone) return { sent: false, reason: 'invalid_number' };
  if (!message) return { sent: false, reason: 'empty_message' };
  if (status === 'disabled') return { sent: false, reason: 'service_disabled' };

  if (status !== 'connected' || !sock) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ phone, message, at: Date.now() });
    return { sent: false, reason: 'queued_until_connected' };
  }
  try {
    await deliver(phone, message);
    return { sent: true };
  } catch (err) {
    console.warn('[whatsapp] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

// ── Documents (PDF / Word / Excel) ────────────────────────────────────────────
const MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};
const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;

function mimeTypeFor(fileName, fallback) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return MIME_TYPES[ext] || fallback || 'application/octet-stream';
}

// Send a file to one number. Unlike alerts, documents are NOT queued: the user
// is waiting, so we report clearly instead. Never throws.
// fileSource: Buffer, or a URL/path string (https URL or local file path).
async function sendWhatsAppDocument(receiverPhone, fileSource, fileName, caption = '', mimeType) {
  const phone = formatPhoneNumber(receiverPhone);
  if (!phone) return { sent: false, reason: 'invalid_number' };
  if (status === 'disabled') return { sent: false, reason: 'service_disabled' };
  if (status !== 'connected' || !sock) return { sent: false, reason: 'not_connected' };

  let document;
  if (Buffer.isBuffer(fileSource)) document = fileSource;
  else if (typeof fileSource === 'string' && /^https:\/\//i.test(fileSource)) document = { url: fileSource };
  else if (typeof fileSource === 'string') document = require('fs').readFileSync(fileSource);
  else return { sent: false, reason: 'no_file' };
  if (Buffer.isBuffer(document) && document.length > MAX_DOCUMENT_BYTES) return { sent: false, reason: 'file_too_large' };

  try {
    const [check] = await sock.onWhatsApp(phone).catch(() => [null]);
    if (check && check.exists === false) return { sent: false, reason: 'not_on_whatsapp' };
    const jid = check?.jid || `${phone}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, {
      document,
      mimetype: mimeType || mimeTypeFor(fileName),
      fileName: fileName || 'document.pdf',
      caption: caption || undefined,
    });
    rememberSent(sent);
    trackSend(sent, phone, 'document', fileName);
    return { sent: true, phone };
  } catch (err) {
    console.warn('[whatsapp] document send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  initWhatsApp,
  sendWhatsAppNotification,
  sendWhatsAppDocument,
  mimeTypeFor,
  MIME_TYPES,
  formatPhoneNumber,
  getWhatsAppStatus,
  resetWhatsAppSession,
};
