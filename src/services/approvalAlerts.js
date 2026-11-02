// ── WhatsApp Approval Alerts ──────────────────────────────────────────────────
// Sends the admin a WhatsApp message whenever something needs approval.
//
// Wired into approvalService.createApprovalRequest(), which every approval flow
// already goes through (route guard: PROJECT / ITEM / CHALLAN / PO_STATUS, plus
// MAIN_PO, CFT, QUALITY_REPORT, CASHBOOK_ADVANCE, CASHBOOK_EXPENSE). New approval
// types get alerts automatically.
//
// Settings come from app_settings (Settings → WhatsApp), never from code:
//   admin_whatsapp_number                  one or more numbers, comma-separated
//                                          e.g. "919876543210,919812345678"
//   is_whatsapp_approval_alerts_enabled    '1' | '0'
//
// Fire-and-forget: nothing here can fail or slow down the request that
// created the approval.

const { getPool } = require('../database');
const { sendWhatsAppNotification, formatPhoneNumber } = require('./whatsappService');

const MODULE_LABELS = {
  PROJECT: 'New Project',
  ITEM: 'New Project Item',
  CHALLAN: 'Sale Challan',
  PO_STATUS: 'Purchase Order Status Change',
  SALE: 'Sale',
  MAIN_PO: 'Main PO / Manufacturing Order',
  CFT: 'CFT Sheet (Wood Issue)',
  QUALITY_REPORT: 'QC / Quality Report',
  CASHBOOK_ADVANCE: 'Cash Book – Advance',
  CASHBOOK_EXPENSE: 'Cash Book – Expense',
};

const MAX_ADMIN_NUMBERS = 10;

// "919876543210,919812345678" → ['919876543210', '919812345678']
function parseNumbers(value) {
  return [...new Set(String(value || '').split(/[,;\s]+/).map((n) => n.trim()).filter(Boolean))];
}

async function getAlertSettings() {
  const db = await getPool();
  const [rows] = await db.query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('admin_whatsapp_number','is_whatsapp_approval_alerts_enabled')",
  );
  const s = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  return {
    numbers: parseNumbers(s.admin_whatsapp_number),
    number: parseNumbers(s.admin_whatsapp_number)[0] || '', // first one (older callers)
    enabled: (s.is_whatsapp_approval_alerts_enabled ?? '1') !== '0',
  };
}

const clean = (v, max = 200) => {
  const text = String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/[*_~`]/g, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function formatTime(date = new Date()) {
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function buildApprovalMessage({ moduleName, actionTitle, workerName, referenceId, remarks, time }) {
  const line = '------------------------------------------';
  return [
    line,
    '🚨 *Factory Alert: Approval Required*',
    line,
    `📋 *Module:* ${clean(moduleName) || 'General'}${actionTitle ? ` – ${clean(actionTitle)}` : ''}`,
    `🆔 *Ref / Job No:* #${clean(referenceId) || '-'}`,
    `👤 *Submitted By:* ${clean(workerName) || 'Unknown'}`,
    `📝 *Notes:* ${clean(remarks, 300) || '-'}`,
    `🕒 *Time:* ${formatTime(time)}`,
    '',
    '👉 *Action:* Please log in to approve/reject.',
    line,
  ].join('\n');
}

// Public helper. Safe to call from anywhere: returns immediately, never throws.
function triggerApprovalAlert({ moduleName, actionTitle, workerName, referenceId, remarks } = {}) {
  setImmediate(async () => {
    try {
      const { numbers, enabled } = await getAlertSettings();
      if (!enabled || !numbers.length) return;
      const message = buildApprovalMessage({ moduleName, actionTitle, workerName, referenceId, remarks });
      // Every admin number gets the alert (one after another, to stay gentle with WhatsApp)
      for (const number of numbers) {
        const result = await sendWhatsAppNotification(number, message);
        if (!result.sent) console.warn(`[approval-alert] not sent to +${number} (${result.reason}) for ${moduleName} #${referenceId}`);
      }
    } catch (err) {
      console.warn('[approval-alert] failed:', err.message);
    }
  });
}

// Short human summary of an approval's data, per type (falls back to common fields).
function summarize(type, data = {}) {
  const d = data.body && typeof data.body === 'object' ? { ...data.body, ...data } : data;
  const money = (v) => (v !== undefined && v !== null && v !== '' ? `₹${Number(v).toLocaleString('en-IN')}` : '');
  const parts = {
    MAIN_PO: [d.po_no && `PO ${d.po_no}`, d.client_name, d.project_name],
    CFT: [d.sheet_no && `Sheet ${d.sheet_no}`, d.project_name, d.item_name, d.wood_type,
      d.total_issue_cft && `Issue ${d.total_issue_cft} CFT`],
    QUALITY_REPORT: [d.report_no && `Report ${d.report_no}`, d.client, d.sku && `SKU ${d.sku}`],
    CASHBOOK_ADVANCE: [d.worker && `Advance to ${d.worker}`, money(d.amount), d.particulars],
    CASHBOOK_EXPENSE: [d.ledger, money(d.amount), d.particulars],
    PO_STATUS: [d.status && `Change status to "${d.status}"`],
  }[type] || [d.name, d.item_name, d.title, d.challan_no, d.description, d.notes, d.remarks];
  return parts.filter(Boolean).map((p) => clean(p, 80)).join(' · ');
}

// Called by createApprovalRequest() after the approval row is saved.
// Admins approving their own requests (e.g. a Main PO they created) aren't alerted.
function alertForApprovalRequest({ type, userId, requestData, relatedId, approvalId }) {
  setImmediate(async () => {
    try {
      const db = await getPool();
      const [[user]] = await db.query('SELECT name, username, role FROM users WHERE id=?', [userId]);
      if (user && ['admin', 'superadmin'].includes(user.role)) return;
      triggerApprovalAlert({
        moduleName: MODULE_LABELS[type] || String(type || '').replace(/_/g, ' '),
        workerName: user?.name || user?.username || `User #${userId}`,
        referenceId: relatedId ? `${relatedId} (Approval #${approvalId})` : approvalId,
        remarks: summarize(type, requestData),
      });
    } catch (err) {
      console.warn('[approval-alert] lookup failed:', err.message);
    }
  });
}


// ══ Worker channel ════════════════════════════════════════════════════════════
// Two separate channels, never mixed:
//   admin  → approval-needed alerts, ONLY to the admin numbers in Settings
//   worker → "your request was approved", ONLY to that worker's own number
// Guards: a worker update is refused if the number is an admin number, and the
// Settings page refuses to save a worker's number as an admin number.

// Normalised phone → worker name, for every worker that has a phone saved.
async function getWorkerPhoneMap() {
  const db = await getPool();
  const [rows] = await db.query("SELECT name, phone FROM users WHERE role='worker' AND phone IS NOT NULL AND phone <> ''");
  const map = new Map();
  for (const r of rows) {
    const p = formatPhoneNumber(r.phone);
    if (p && !map.has(p)) map.set(p, r.name);
  }
  return map;
}

function buildWorkerApprovalMessage({ moduleName, referenceId, adminName, notes, time }) {
  const line = '------------------------------------------';
  return [
    line,
    '✅ *Request Approved*',
    line,
    `📋 *Module:* ${clean(moduleName) || 'General'}`,
    `🆔 *Ref:* #${clean(referenceId) || '-'}`,
    `👤 *Approved By:* ${clean(adminName) || 'Admin'}`,
    ...(clean(notes) ? [`📝 *Note:* ${clean(notes, 300)}`] : []),
    `🕒 *Time:* ${formatTime(time)}`,
    '',
    '👉 Your request has been approved. You can continue in the app.',
    line,
  ].join('\n');
}

// Send the worker their approval update. Returns { sent, reason, phone }.
// Never throws; never sends to an admin number or to an admin requester.
async function notifyWorkerOfApproval({ approvalId, phone, adminName, notes }) {
  try {
    const db = await getPool();
    const [[a]] = await db.query(
      `SELECT a.id, a.type, a.related_id, u.role AS user_role, u.phone AS user_phone
         FROM approvals a LEFT JOIN users u ON u.id = a.user_id WHERE a.id=?`, [approvalId]);
    if (!a) return { sent: false, reason: 'approval_not_found' };
    if (['admin', 'superadmin'].includes(a.user_role)) return { sent: false, reason: 'requester_is_admin' };

    const target = formatPhoneNumber(phone || a.user_phone);
    if (!target) return { sent: false, reason: phone ? 'invalid_number' : 'no_worker_number' };

    const { numbers: adminNumbers } = await getAlertSettings();
    if (adminNumbers.includes(target)) return { sent: false, reason: 'admin_number', phone: target };

    const message = buildWorkerApprovalMessage({
      moduleName: MODULE_LABELS[a.type] || String(a.type || '').replace(/_/g, ' '),
      referenceId: a.related_id ? `${a.related_id} (Approval #${a.id})` : a.id,
      adminName,
      notes,
    });
    const result = await sendWhatsAppNotification(target, message);
    return { ...result, phone: target };
  } catch (err) {
    console.warn('[worker-notify] failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { triggerApprovalAlert, alertForApprovalRequest, buildApprovalMessage, getAlertSettings, parseNumbers, MAX_ADMIN_NUMBERS, MODULE_LABELS,
  getWorkerPhoneMap, buildWorkerApprovalMessage, notifyWorkerOfApproval };
