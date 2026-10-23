// ── QUOTATIONS against a Manufacturing Order ─────────────────────────────────
// Mounted in server.js at /api. Permission key 'quotations':
//   read = View/Print   write = Add / Revise / mark Sent·Accepted·Rejected
//   edit = Edit draft   delete = Delete draft
//
// One quotation number (QT-26-1001) can have revisions: Rev 0, Rev 1, … A new
// revision copies the previous one; the older revision is kept as 'revised'.
// Only one revision of a number can be 'accepted'. No approval step.
// Amount = rate × qty per row → subtotal − discount → + GST % = total.

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');
const { generateSeriesNumber } = require('../services/projectNumbering');

const STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'revised'];
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = (v, max = 1e12) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
const text = (v, len) => { const s = String(v ?? '').trim(); return s ? s.slice(0, len) : null; };
const dateOrNull = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it, i) => {
    const qty = num(it.qty, 1e9);
    const rate = num(it.rate);
    return {
      main_po_item_id: parseInt(it.main_po_item_id, 10) || null,
      proto_code: text(it.proto_code, 100),
      item_name: text(it.item_name, 255) || '',
      description: text(it.description, 2000),
      area: text(it.area, 100),
      size: text(it.size, 255),
      finishes: text(it.finishes, 500),
      unit: text(it.unit, 20) || 'pcs',
      qty, rate, amount: r2(qty * rate), sort_order: i,
    };
  });
}

// Totals are always worked out here from the rows (never trusted from the page)
function totalsOf(items, b) {
  const subtotal = r2(items.reduce((a, it) => a + it.amount, 0));
  const discount = Math.min(subtotal, r2(num(b.discount_amount)));
  const gstPercent = Math.min(100, num(b.gst_percent));
  const taxable = r2(subtotal - discount);
  const gst = r2(taxable * gstPercent / 100);
  return { subtotal, discount_amount: discount, gst_percent: gstPercent, taxable_amount: taxable, gst_amount: gst, total_amount: r2(taxable + gst) };
}

function readHeader(b) {
  return {
    client_name: text(b.client_name, 255),
    client_address: text(b.client_address, 1000),
    client_gstin: text(b.client_gstin, 30),
    client_phone: text(b.client_phone, 30),
    quote_date: dateOrNull(b.quote_date) || (() => { const x = new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; })(),
    valid_until: dateOrNull(b.valid_until),
    gst_type: b.gst_type === 'inter' ? 'inter' : 'intra',
    subject: text(b.subject, 255),
    notes: text(b.notes, 4000),
    terms: text(b.terms, 4000),
  };
}

function validate(items) {
  if (!items.length) return 'Add at least one item';
  if (items.some(it => !it.item_name)) return 'Every row needs an item name';
  return null;
}

async function loadQuotation(db, id) {
  const [[q]] = await db.query(
    `SELECT q.*, mp.po_no, mp.project_name AS mo_project_name, mp.status AS mo_status, mp.project_id,
            p.name AS project_name, p.project_id AS project_code,
            cu.name AS created_by_name, uu.name AS updated_by_name
       FROM quotations q
       LEFT JOIN main_pos mp ON mp.id = q.main_po_id
       LEFT JOIN projects p ON p.id = mp.project_id
       LEFT JOIN users cu ON cu.id = q.created_by
       LEFT JOIN users uu ON uu.id = q.updated_by
      WHERE q.id=?`, [id]);
  if (!q) return null;
  const [items] = await db.query('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY sort_order, id', [id]);
  // First reference image of the linked MO row (for the screen and the print)
  const moIds = items.map(i => i.main_po_item_id).filter(Boolean);
  let imgs = [];
  if (moIds.length) {
    [imgs] = await db.query(
      'SELECT main_po_item_id, image_path FROM main_po_item_images WHERE main_po_item_id IN (?) ORDER BY sort_order, id', [moIds]);
  }
  q.items = items.map(it => ({ ...it, images: imgs.filter(im => im.main_po_item_id === it.main_po_item_id).slice(0, 1) }));
  const [revs] = await db.query(
    'SELECT id, revision, status, total_amount, quote_date, updated_at FROM quotations WHERE quote_no=? ORDER BY revision', [q.quote_no]);
  q.revisions = revs;
  return q;
}

async function insertItems(conn, quotationId, items) {
  for (const it of items) {
    await conn.query(
      `INSERT INTO quotation_items (quotation_id, main_po_item_id, proto_code, item_name, description, area, size, finishes,
         unit, qty, rate, amount, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [quotationId, it.main_po_item_id, it.proto_code, it.item_name, it.description, it.area, it.size, it.finishes,
       it.unit, it.qty, it.rate, it.amount, it.sort_order]);
  }
}

// ── LIST (latest revision of each number by default) ───────────────────────
router.get('/quotations', auth, adminOrPermission('quotations', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const where = [], args = [];
    if (req.query.all_revisions !== '1') where.push('q.revision = (SELECT MAX(q2.revision) FROM quotations q2 WHERE q2.quote_no = q.quote_no)');
    if (STATUSES.includes(req.query.status)) { where.push('q.status=?'); args.push(req.query.status); }
    if (parseInt(req.query.main_po_id, 10)) { where.push('q.main_po_id=?'); args.push(parseInt(req.query.main_po_id, 10)); }
    const [rows] = await db.query(
      `SELECT q.id, q.quote_no, q.revision, q.status, q.client_name, q.quote_date, q.valid_until, q.total_amount, q.subject,
              q.main_po_id, mp.po_no, COALESCE(p.name, mp.project_name) AS project_name, p.project_id AS project_code,
              q.created_at, q.updated_at, cu.name AS created_by_name,
              (SELECT COUNT(*) FROM quotation_items qi WHERE qi.quotation_id = q.id) AS item_count
         FROM quotations q
         LEFT JOIN main_pos mp ON mp.id = q.main_po_id
         LEFT JOIN projects p ON p.id = mp.project_id
         LEFT JOIN users cu ON cu.id = q.created_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY q.id DESC`, args);
    const [counts] = await db.query(
      `SELECT status, COUNT(*) c FROM quotations q
        WHERE q.revision = (SELECT MAX(q2.revision) FROM quotations q2 WHERE q2.quote_no = q.quote_no) GROUP BY status`);
    res.json({ rows, counts });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Manufacturing Orders to pick from (works with the quotations permission alone)
router.get('/quotations/mo-options', auth, adminOrPermission('quotations', 'write'), async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(
      `SELECT mp.id, mp.po_no, COALESCE(p.name, mp.project_name) AS project_name, p.project_id AS project_code,
              mp.client_name, mp.status,
              (SELECT COUNT(*) FROM main_po_items i WHERE i.main_po_id = mp.id) AS item_count,
              (SELECT COUNT(DISTINCT q.quote_no) FROM quotations q WHERE q.main_po_id = mp.id) AS quote_count
         FROM main_pos mp LEFT JOIN projects p ON p.id = mp.project_id
        ORDER BY mp.id DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Prefill a new quotation from a Manufacturing Order (rows, client, finishes)
router.get('/quotations/from-mo/:moId', auth, adminOrPermission('quotations', 'write'), async (req, res) => {
  const db = await getPool();
  try {
    const [[mo]] = await db.query(
      `SELECT mp.*, p.name AS linked_project_name, p.project_id AS linked_project_code, p.client_name AS project_client
         FROM main_pos mp LEFT JOIN projects p ON p.id = mp.project_id WHERE mp.id=?`, [req.params.moId]);
    if (!mo) return res.status(404).json({ message: 'Manufacturing Order not found' });
    const [items] = await db.query('SELECT * FROM main_po_items WHERE main_po_id=? ORDER BY sort_order, id', [mo.id]);
    // Rates from the latest quotation of this MO, if any (so a second quote starts from the last prices)
    const [[lastQ]] = await db.query('SELECT id FROM quotations WHERE main_po_id=? ORDER BY id DESC LIMIT 1', [mo.id]);
    let lastRates = new Map();
    if (lastQ) {
      const [lr] = await db.query('SELECT main_po_item_id, rate FROM quotation_items WHERE quotation_id=?', [lastQ.id]);
      lastRates = new Map(lr.filter(r => r.main_po_item_id).map(r => [r.main_po_item_id, Number(r.rate)]));
    }
    const ids = items.map(i => i.id);
    let imgs = [];
    if (ids.length) [imgs] = await db.query('SELECT main_po_item_id, image_path FROM main_po_item_images WHERE main_po_item_id IN (?) ORDER BY sort_order, id', [ids]);
    const finishesOf = it => [it.is_paint_finish && 'Paint', it.is_fabric_finish && 'Fabric', it.is_metal_finish && 'Metal'].filter(Boolean).join(', ');
    const dims = it => (it.size_length || it.size_width || it.size_thickness)
      ? `L ${Number(it.size_length) || '—'} × W ${Number(it.size_width) || '—'} × T ${Number(it.size_thickness) || '—'} mm` : '';
    res.json({
      main_po_id: mo.id, po_no: mo.po_no, mo_status: mo.status,
      project_name: mo.linked_project_name || mo.project_name, project_code: mo.linked_project_code || null,
      client_name: mo.client_name || mo.project_client || '',
      subject: `Quotation for ${mo.linked_project_name || mo.project_name}`,
      items: items.map(it => ({
        main_po_item_id: it.id, proto_code: it.proto_code || '', item_name: it.product_name, area: it.area || '',
        size: it.product_size || dims(it), finishes: [finishesOf(it), it.finishes_note].filter(Boolean).join(' · '),
        description: it.remark || '', unit: 'pcs', qty: Number(it.qty) || 1, rate: lastRates.get(it.id) || 0,
        images: imgs.filter(im => im.main_po_item_id === it.id).slice(0, 1),
      })),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/quotations/:id', auth, adminOrPermission('quotations', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const q = await loadQuotation(db, req.params.id);
    if (!q) return res.status(404).json({ message: 'Quotation not found' });
    res.json(q);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── CREATE ───────────────────────────────────────────────────────────────────
router.post('/quotations', auth, adminOrPermission('quotations', 'write'), auditLog('CREATE', 'Quotation'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    const moId = parseInt(b.main_po_id, 10);
    if (!moId) return res.status(400).json({ message: 'Choose the Manufacturing Order this quotation is for' });
    const [[mo]] = await conn.query('SELECT id FROM main_pos WHERE id=?', [moId]);
    if (!mo) return res.status(400).json({ message: 'Manufacturing Order not found' });
    const items = cleanItems(b.items);
    const err = validate(items);
    if (err) return res.status(400).json({ message: err });
    const h = readHeader(b);
    const t = totalsOf(items, b);

    await conn.beginTransaction();
    // Serialise numbering so two saves never get the same number
    await conn.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('quotation_prefix','QT')");
    await conn.query("SELECT setting_value FROM app_settings WHERE setting_key='quotation_prefix' FOR UPDATE");
    let quoteNo = await generateSeriesNumber(conn, {
      prefixKey: 'quotation_prefix', startKey: 'quotation_start_number', defaultPrefix: 'QT', table: 'quotations', column: 'quote_no',
    });
    for (let i = 0; i < 1000; i++) {
      const [[taken]] = await conn.query('SELECT id FROM quotations WHERE quote_no=? LIMIT 1', [quoteNo]);
      if (!taken) break;
      quoteNo = quoteNo.replace(/(\d+)$/, d => String(Number(d) + 1));
    }
    const [r] = await conn.query(
      `INSERT INTO quotations (quote_no, revision, main_po_id, status, client_name, client_address, client_gstin, client_phone,
         quote_date, valid_until, gst_type, subject, notes, terms, subtotal, discount_amount, gst_percent, taxable_amount,
         gst_amount, total_amount, created_by, updated_by)
       VALUES (?,0,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [quoteNo, moId, h.client_name, h.client_address, h.client_gstin, h.client_phone, h.quote_date, h.valid_until,
       h.gst_type, h.subject, h.notes, h.terms, t.subtotal, t.discount_amount, t.gst_percent, t.taxable_amount,
       t.gst_amount, t.total_amount, req.user.id, req.user.id]);
    await insertItems(conn, r.insertId, items);
    await conn.commit();
    res.json({ id: r.insertId, quote_no: quoteNo, message: `Quotation ${quoteNo} saved as draft` });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// ── UPDATE (draft only) ──────────────────────────────────────────────────────
router.put('/quotations/:id', auth, adminOrPermission('quotations', 'edit'), auditLog('UPDATE', 'Quotation'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[q]] = await conn.query('SELECT * FROM quotations WHERE id=? FOR UPDATE', [req.params.id]);
    if (!q) { await conn.rollback(); return res.status(404).json({ message: 'Quotation not found' }); }
    if (q.status !== 'draft') {
      await conn.rollback();
      return res.status(400).json({ message: `This quotation is ${q.status} and locked. Use Revise to change prices.` });
    }
    const b = req.body || {};
    const items = cleanItems(b.items);
    const err = validate(items);
    if (err) { await conn.rollback(); return res.status(400).json({ message: err }); }
    const h = readHeader(b);
    const t = totalsOf(items, b);
    await conn.query(
      `UPDATE quotations SET client_name=?, client_address=?, client_gstin=?, client_phone=?, quote_date=?, valid_until=?,
         gst_type=?, subject=?, notes=?, terms=?, subtotal=?, discount_amount=?, gst_percent=?, taxable_amount=?,
         gst_amount=?, total_amount=?, updated_by=? WHERE id=?`,
      [h.client_name, h.client_address, h.client_gstin, h.client_phone, h.quote_date, h.valid_until, h.gst_type,
       h.subject, h.notes, h.terms, t.subtotal, t.discount_amount, t.gst_percent, t.taxable_amount, t.gst_amount,
       t.total_amount, req.user.id, q.id]);
    await conn.query('DELETE FROM quotation_items WHERE quotation_id=?', [q.id]);
    await insertItems(conn, q.id, items);
    await conn.commit();
    res.json({ message: 'Quotation saved' });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// ── STATUS: sent / accepted / rejected / back to draft ───────────────────────
router.post('/quotations/:id/status', auth, adminOrPermission('quotations', 'write'), auditLog('UPDATE', 'Quotation'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const to = req.body?.status;
    const allowed = { draft: ['sent'], sent: ['accepted', 'rejected', 'draft'], rejected: ['sent'], accepted: ['sent'] };
    await conn.beginTransaction();
    const [[q]] = await conn.query('SELECT * FROM quotations WHERE id=? FOR UPDATE', [req.params.id]);
    if (!q) { await conn.rollback(); return res.status(404).json({ message: 'Quotation not found' }); }
    if (q.status === 'revised') { await conn.rollback(); return res.status(400).json({ message: 'This is an old revision. Open the latest one.' }); }
    if (!(allowed[q.status] || []).includes(to)) {
      await conn.rollback();
      return res.status(400).json({ message: `Can't change a ${q.status} quotation to ${to}` });
    }
    if (to === 'accepted') {
      const [[other]] = await conn.query(
        "SELECT revision FROM quotations WHERE quote_no=? AND status='accepted' AND id<>? LIMIT 1", [q.quote_no, q.id]);
      if (other) { await conn.rollback(); return res.status(400).json({ message: `Rev ${other.revision} of ${q.quote_no} is already accepted` }); }
    }
    const reason = to === 'rejected' ? text(req.body?.reason, 1000) : null;
    await conn.query(
      `UPDATE quotations SET status=?, updated_by=?,
         sent_at = IF(?='sent' AND sent_at IS NULL, NOW(), sent_at),
         decided_at = IF(? IN ('accepted','rejected'), NOW(), IF(?='sent', NULL, decided_at)),
         reject_reason = IF(?='rejected', ?, IF(?='sent', NULL, reject_reason))
       WHERE id=?`,
      [to, req.user.id, to, to, to, to, reason, to, q.id]);
    await conn.commit();
    const label = { sent: 'marked as sent', accepted: 'marked as accepted', rejected: 'marked as rejected', draft: 'moved back to draft' }[to];
    res.json({ message: `Quotation ${label}` });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// ── REVISE: copy the latest revision as a new draft ──────────────────────────
router.post('/quotations/:id/revise', auth, adminOrPermission('quotations', 'write'), auditLog('CREATE', 'Quotation'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[q]] = await conn.query('SELECT * FROM quotations WHERE id=? FOR UPDATE', [req.params.id]);
    if (!q) { await conn.rollback(); return res.status(404).json({ message: 'Quotation not found' }); }
    const [[latest]] = await conn.query('SELECT MAX(revision) AS r FROM quotations WHERE quote_no=?', [q.quote_no]);
    if (q.revision !== latest.r) { await conn.rollback(); return res.status(400).json({ message: 'Revise the latest revision' }); }
    if (q.status === 'draft') { await conn.rollback(); return res.status(400).json({ message: 'This revision is still a draft — just edit it' }); }
    if (q.status === 'accepted') { await conn.rollback(); return res.status(400).json({ message: 'This quotation is accepted. Mark it as sent again first if prices must change.' }); }
    const rev = q.revision + 1;
    const [r] = await conn.query(
      `INSERT INTO quotations (quote_no, revision, main_po_id, status, client_name, client_address, client_gstin, client_phone,
         quote_date, valid_until, gst_type, subject, notes, terms, subtotal, discount_amount, gst_percent, taxable_amount,
         gst_amount, total_amount, created_by, updated_by)
       SELECT quote_no, ?, main_po_id, 'draft', client_name, client_address, client_gstin, client_phone,
         CURDATE(), valid_until, gst_type, subject, notes, terms, subtotal, discount_amount, gst_percent, taxable_amount,
         gst_amount, total_amount, ?, ? FROM quotations WHERE id=?`,
      [rev, req.user.id, req.user.id, q.id]);
    await conn.query(
      `INSERT INTO quotation_items (quotation_id, main_po_item_id, proto_code, item_name, description, area, size, finishes,
         unit, qty, rate, amount, sort_order)
       SELECT ?, main_po_item_id, proto_code, item_name, description, area, size, finishes, unit, qty, rate, amount, sort_order
         FROM quotation_items WHERE quotation_id=?`, [r.insertId, q.id]);
    await conn.query("UPDATE quotations SET status='revised', updated_by=? WHERE id=?", [req.user.id, q.id]);
    await conn.commit();
    res.json({ id: r.insertId, revision: rev, message: `${q.quote_no} Rev ${rev} created as draft` });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// ── DELETE (draft only; deleting a draft revision brings the previous one back) ─
router.delete('/quotations/:id', auth, adminOrPermission('quotations', 'delete'), auditLog('DELETE', 'Quotation'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[q]] = await conn.query('SELECT * FROM quotations WHERE id=? FOR UPDATE', [req.params.id]);
    if (!q) { await conn.rollback(); return res.status(404).json({ message: 'Quotation not found' }); }
    if (q.status !== 'draft') { await conn.rollback(); return res.status(400).json({ message: 'Only a draft can be deleted' }); }
    await conn.query('DELETE FROM quotations WHERE id=?', [q.id]);   // items cascade
    if (q.revision > 0) {
      await conn.query("UPDATE quotations SET status='sent' WHERE quote_no=? AND revision=? AND status='revised'", [q.quote_no, q.revision - 1]);
    }
    await conn.commit();
    res.json({ message: 'Draft deleted' });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

module.exports = router;
