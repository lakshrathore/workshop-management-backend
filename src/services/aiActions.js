// ─────────────────────────────────────────────────────────────────────────────
//  "Ask Moji" — Phase 3: WRITE actions, always PROPOSE → CONFIRM → EXECUTE.
//
//  How it stays safe:
//   1. The model can only call propose_* tools. Those NEVER write. They validate the
//      parameters and return a signed, short-lived "action token" which the chat UI shows
//      as a card with Confirm / Cancel buttons.
//   2. Nothing happens until the human presses Confirm → POST /api/ai/confirm { token }.
//   3. Confirm re-validates, then replays the request against the app's OWN existing
//      endpoint, forwarding the user's own Authorization header. So every existing rule
//      still applies: role / permission checks, approval guard, audit log, notifications.
//      The AI layer contains no business logic of its own and no extra privileges.
//   4. The token is HMAC-signed, expires in 10 minutes, is bound to the user id + role,
//      and is single-use. Only the whitelisted actions below can ever be executed.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const axios = require('axios');

const SECRET = () => `${process.env.JWT_SECRET || 'workshop_secret_2024'}:ai-action:v1`;
const TTL_MS = 10 * 60 * 1000;

const text = (v, n) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const nonNeg = (v, max = 1e9) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null; };
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// ── token helpers ───────────────────────────────────────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sig = (s) => crypto.createHmac('sha256', SECRET()).update(s).digest('base64url');

function signAction(user, action, params) {
  const body = b64({ u: user.id, r: user.role, a: action, p: params, e: Date.now() + TTL_MS, n: crypto.randomBytes(8).toString('hex') });
  return `${body}.${sig(body)}`;
}

function verifyAction(token) {
  if (typeof token !== 'string' || token.length > 20000) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = sig(body);
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

// single-use: remember consumed nonces until they would have expired anyway
const used = new Map();
function consume(nonce) {
  const now = Date.now();
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  if (used.has(nonce)) return false;
  used.set(nonce, now + TTL_MS + 60000);
  return true;
}

// ── action registry ─────────────────────────────────────────────────────────
// validate(db, user, raw) → { error } | { params, title, lines }      (called when proposing AND again on confirm)
// request(user, params)   → { method, path, body }                    (replayed on the app's own API)
const ACTIONS = {
  client_create_ticket: {
    roles: ['client'],
    async validate(db, user, raw) {
      const subject = text(raw.subject, 150), message = text(raw.message, 2000);
      if (!subject || !message) return { error: 'Subject aur message dono chahiye.' };
      const priority = ['low', 'medium', 'high', 'urgent'].includes(raw.priority) ? raw.priority : 'medium';
      let projectId = null, projectName = null;
      if (raw.project_id) {
        const [[p]] = await db.query(
          `SELECT p.id, p.name FROM client_project_access cpa JOIN projects p ON p.id = cpa.project_id
            WHERE cpa.client_id = ? AND p.id = ? AND p.status <> 'deleted' AND p.is_ready = 1`, [user.id, posInt(raw.project_id)]);
        if (!p) return { error: 'Ye project aapke account me nahi mila.' };
        projectId = p.id; projectName = p.name;
      }
      return {
        params: { subject, message, priority, project_id: projectId },
        title: 'Naya support ticket banayein',
        lines: [`Subject: ${subject}`, `Message: ${message}`, `Priority: ${priority}`, projectName ? `Project: ${projectName}` : null].filter(Boolean),
      };
    },
    request: (user, p) => ({ method: 'post', path: '/client/tickets', body: { subject: p.subject, message: p.message, priority: p.priority, project_id: p.project_id } }),
  },

  client_ticket_reply: {
    roles: ['client'],
    async validate(db, user, raw) {
      const id = posInt(raw.ticket_id), message = text(raw.message, 2000);
      if (!id || !message) return { error: 'Ticket id aur message chahiye.' };
      const [[t]] = await db.query('SELECT id, subject FROM client_tickets WHERE id = ? AND client_id = ?', [id, user.id]);
      if (!t) return { error: 'Ye ticket aapke account me nahi mila.' };
      return { params: { ticket_id: id, message }, title: 'Ticket me message bhejein', lines: [`Ticket: ${t.subject}`, `Message: ${message}`] };
    },
    request: (user, p) => ({ method: 'post', path: `/client/tickets/${p.ticket_id}/messages`, body: { message: p.message } }),
  },

  admin_ticket_reply: {
    roles: ['admin'],
    async validate(db, user, raw) {
      const id = posInt(raw.ticket_id), message = text(raw.message, 2000);
      if (!id || !message) return { error: 'Ticket id aur message chahiye.' };
      const [[t]] = await db.query('SELECT ct.id, ct.subject, u.name AS client FROM client_tickets ct JOIN users u ON u.id = ct.client_id WHERE ct.id = ?', [id]);
      if (!t) return { error: 'Ticket nahi mila.' };
      return { params: { ticket_id: id, message }, title: 'Client ko reply bhejein', lines: [`Client: ${t.client}`, `Ticket: ${t.subject}`, `Reply: ${message}`] };
    },
    request: (user, p) => ({ method: 'post', path: `/admin/tickets/${p.ticket_id}/messages`, body: { message: p.message } }),
  },

  admin_ticket_status: {
    roles: ['admin'],
    async validate(db, user, raw) {
      const id = posInt(raw.ticket_id);
      const status = ['open', 'in_progress', 'resolved', 'closed'].includes(raw.status) ? raw.status : null;
      if (!id || !status) return { error: 'Ticket id aur valid status (open / in_progress / resolved / closed) chahiye.' };
      const [[t]] = await db.query('SELECT ct.id, ct.subject, ct.status, u.name AS client FROM client_tickets ct JOIN users u ON u.id = ct.client_id WHERE ct.id = ?', [id]);
      if (!t) return { error: 'Ticket nahi mila.' };
      return { params: { ticket_id: id, status }, title: 'Ticket status badlein', lines: [`Client: ${t.client}`, `Ticket: ${t.subject}`, `Status: ${t.status} → ${status}`] };
    },
    request: (user, p) => ({ method: 'patch', path: `/admin/tickets/${p.ticket_id}/status`, body: { status: p.status } }),
  },

  admin_quotation_draft: {
    roles: ['admin'],
    async validate(db, user, raw) {
      const poNo = text(raw.mo_number, 50);
      if (!poNo) return { error: 'Manufacturing Order number chahiye (e.g. MO-1001).' };
      const [[mo]] = await db.query('SELECT id, po_no, project_name, client_name FROM main_pos WHERE po_no = ?', [poNo]);
      if (!mo) return { error: `Manufacturing Order ${poNo} nahi mila.` };
      const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 60).map(it => ({
        item_name: text(it?.item_name, 255), qty: nonNeg(it?.qty, 1e6), rate: nonNeg(it?.rate),
        unit: text(it?.unit, 20) || 'pcs', size: text(it?.size, 255), description: text(it?.description, 500),
      }));
      if (!items.length) return { error: 'Kam se kam ek item chahiye.' };
      if (items.some(i => !i.item_name || i.qty === null || i.rate === null || i.qty <= 0)) {
        return { error: 'Har item ka naam, quantity (>0) aur rate chahiye. Rate user se pucho, khud mat bharo.' };
      }
      // Same default Terms & Conditions the quotation form fills in
      let terms = text(raw.terms, 4000);
      if (!terms) {
        try {
          const [[tt]] = await db.query('SELECT content FROM quotation_terms_templates WHERE is_default = 1 AND is_active = 1 ORDER BY id LIMIT 1');
          terms = text(tt?.content, 4000);
        } catch { terms = null; }
      }
      const gst = nonNeg(raw.gst_percent, 100) ?? 0, discount = nonNeg(raw.discount_amount) ?? 0;
      const subtotal = items.reduce((a, i) => a + i.qty * i.rate, 0);
      const taxable = subtotal - Math.min(discount, subtotal);
      const total = taxable + taxable * gst / 100;
      return {
        params: { main_po_id: mo.id, mo_number: mo.po_no, client_name: text(raw.client_name, 255) || mo.client_name || null, subject: text(raw.subject, 255), notes: text(raw.notes, 1000), terms, gst_percent: gst, discount_amount: discount, items },
        title: 'Quotation draft banayein',
        lines: [`Manufacturing Order: ${mo.po_no} (${mo.project_name || '—'})`, `Client: ${text(raw.client_name, 255) || mo.client_name || '—'}`,
          ...items.map(i => `• ${i.item_name} — ${i.qty} ${i.unit} × ${inr(i.rate)} = ${inr(i.qty * i.rate)}`),
          `GST ${gst}%${discount ? `, discount ${inr(discount)}` : ''} → Total ${inr(total)}`, 'Draft ke roop me save hoga (bhejna alag step hai).'],
      };
    },
    request: (user, p) => ({ method: 'post', path: '/quotations', body: {
      main_po_id: p.main_po_id, client_name: p.client_name, subject: p.subject, notes: p.notes, terms: p.terms,
      gst_percent: p.gst_percent, discount_amount: p.discount_amount,
      items: p.items.map(i => ({ item_name: i.item_name, qty: i.qty, rate: i.rate, unit: i.unit, size: i.size, description: i.description })),
    } }),
  },
};

// Used by the propose_* tools. Pushes a card into ctx.actions and tells the model what to say.
async function propose(db, ctx, action, raw) {
  const def = ACTIONS[action];
  if (!ctx || !ctx.user || !Array.isArray(ctx.actions) || !def || !def.roles.includes(ctx.user.role)) return { error: 'Not allowed.' };
  const v = await def.validate(db, ctx.user, raw && typeof raw === 'object' ? raw : {});
  if (v.error) return { error: v.error };
  ctx.actions.push({ token: signAction(ctx.user, action, v.params), title: v.title, lines: v.lines });
  return { ok: true, note: 'Proposal user ko card ke roop me dikh gaya hai. Abhi KUCH SAVE/SEND NAHI hua — user ko bolo ki card par Confirm dabaye. Ye mat kaho ki kaam ho gaya.' };
}

// Confirm: verify → re-validate → replay on the app's own endpoint with the user's own token.
async function executeConfirmed(db, user, authHeader, token) {
  const t = verifyAction(token);
  if (!t) return { status: 400, message: 'Ye action valid nahi hai.' };
  if (t.e < Date.now()) return { status: 410, message: 'Ye request expire ho gayi (10 min). Dobara puchho.' };
  if (t.u !== user.id || t.r !== user.role) return { status: 403, message: 'Ye action aapke liye nahi hai.' };
  const def = ACTIONS[t.a];
  if (!def || !def.roles.includes(user.role)) return { status: 403, message: 'Not allowed.' };
  const v = await def.validate(db, user, t.p);          // data may have changed since the proposal
  if (v.error) return { status: 409, message: v.error };
  if (!consume(t.n)) return { status: 409, message: 'Ye action pehle hi ho chuka hai.' };

  const { method, path, body } = def.request(user, v.params);
  try {
    const r = await axios({
      method, url: `http://127.0.0.1:${process.env.PORT || 5000}/api${path}`, data: body, timeout: 20000,
      headers: { Authorization: authHeader, 'content-type': 'application/json' }, validateStatus: () => true,
    });
    if (r.status >= 200 && r.status < 300) return { status: 200, ok: true, message: r.data?.message || 'Ho gaya.', id: r.data?.id ?? null, quote_no: r.data?.quote_no };
    used.delete(t.n);                                     // failed → allow a retry with the same card
    return { status: r.status === 403 ? 403 : 422, message: r.data?.message || 'Action poora nahi ho paya.' };
  } catch (e) {
    used.delete(t.n);
    console.error('[ai-confirm] replay failed:', e.message);
    return { status: 502, message: 'Action poora nahi ho paya. Thodi der baad try karo.' };
  }
}

module.exports = { propose, executeConfirmed, ACTIONS, signAction, verifyAction };
