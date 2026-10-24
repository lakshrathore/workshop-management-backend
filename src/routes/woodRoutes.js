// ── WOOD STOCK: Wood Type master, Wood Inward, Transfers, stock dashboard and reports ──
// Mounted in server.js at /api. Uses the CFT permission ('cft'):
//   read = view lists and reports   write = add   edit = edit   delete = delete
//
// Stock is kept per wood type + thickness category. Every wood has its configured
// thicknesses (25, 38, 50 mm …) plus "ALL CFT" — a separate category for wood whose
// board sizes are unknown (CFT typed directly, never split into the other thicknesses).
//
// Stock movements (one list used by every report, so their totals always agree):
//   Opening balance  wood_inwards.entry_type='opening'          + stock
//   Inward           wood_inwards.entry_type='inward'           + stock
//   Return           cft_rows.row_type='return'  (CFT sheet)    + stock
//   Outward (Issue)  cft_rows.row_type='issue'   (CFT sheet)    − stock
//   Transfer         wood_transfers: − from one category, + to another (wood total unchanged)
// Demand never moves stock. Only approved CFT sheets (and sheets locked under the old
// "Submit & Lock") count; a sheet can only be edited as a draft, and reopening it takes
// it out of stock until it is approved again — so an edited sheet is never counted twice.
// Movements are read from the documents themselves, so editing a document can never
// leave a duplicate movement behind. Negative stock is allowed but shown as a warning.
// Negative stock: Settings → "Allow negative wood stock" (cft_allow_negative_stock = yes / no).
// With No, any change that takes a wood + thickness below zero on any date is refused.
// Date of a CFT movement = approval date (else submit date, else created date).
// CFT = L × W × T × 0.00000003528 per piece × qty (services/cftMath.js — same as CFT sheets).

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');
const { generateSeriesNumber } = require('../services/projectNumbering');
const { r4, rowCft } = require('../services/cftMath');

const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const dims = v => Math.round(num(v) * 1000) / 1000;
const text = (v, len) => { const s = String(v ?? '').trim(); return s ? s.slice(0, len) : null; };
const ymd = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const woodKey = s => String(s || '').trim().toLowerCase();
const labelKey = s => String(s || '').trim().toLowerCase();
const fail = (res, code, message) => res.status(code).json({ message });
const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

// Thickness category of a row: 'ALL' (ALL CFT) or the thickness in mm as text ('38')
const tKey = (isAll, t) => (isAll ? 'ALL' : String(dims(t)));
const tLabel = (isAll, t) => (isAll ? 'ALL CFT' : `${dims(t)} mm`);
const keyLabel = k => (k === 'ALL' ? 'ALL CFT' : `${dims(k)} mm`);
const parseKey = k => (String(k).toUpperCase() === 'ALL' ? { all: 1, t: 0 } : { all: 0, t: dims(k) });

// ═════════════════════════ WOOD TYPE MASTER ═════════════════════════════════
function cleanSizes(list) {
  return (Array.isArray(list) ? list : []).map((s, i) => ({
    label: text(s.label, 255), length: dims(s.length), width: dims(s.width), thickness: dims(s.thickness), sort_order: i,
  })).filter(s => s.label || s.length || s.width || s.thickness);
}

async function woodUsage(db, ids) {
  if (!ids.length) return new Map();
  const [s] = await db.query('SELECT wood_type_id AS id, COUNT(*) c FROM cft_sheets WHERE wood_type_id IN (?) GROUP BY wood_type_id', [ids]);
  const [w] = await db.query(
    `SELECT COALESCE(r.wood_type_id, wi.wood_type_id) AS id, COUNT(DISTINCT wi.id) c
       FROM wood_inward_rows r JOIN wood_inwards wi ON wi.id = r.inward_id
      WHERE COALESCE(r.wood_type_id, wi.wood_type_id) IN (?) GROUP BY COALESCE(r.wood_type_id, wi.wood_type_id)`, [ids]);
  const [t] = await db.query('SELECT wood_type_id AS id, COUNT(*) c FROM wood_transfers WHERE wood_type_id IN (?) GROUP BY wood_type_id', [ids]);
  const m = new Map(ids.map(id => [id, { sheets: 0, inwards: 0, transfers: 0 }]));
  s.forEach(r => { m.get(r.id).sheets = Number(r.c); });
  w.forEach(r => { if (m.has(r.id)) m.get(r.id).inwards = Number(r.c); });
  t.forEach(r => { m.get(r.id).transfers = Number(r.c); });
  return m;
}

// Thicknesses of a wood that stock entries use (these can be made inactive, not removed)
async function usedThicknesses(db, woodId) {
  const [rows] = await db.query(
    `SELECT DISTINCT r.thickness AS t FROM wood_inward_rows r JOIN wood_inwards wi ON wi.id = r.inward_id
      WHERE COALESCE(r.wood_type_id, wi.wood_type_id) = ? AND r.is_all_cft = 0 AND r.thickness > 0
     UNION SELECT DISTINCT r.thickness FROM cft_rows r JOIN cft_sheets cs ON cs.id = r.sheet_id
      WHERE cs.wood_type_id = ? AND r.row_type IN ('issue','return') AND r.is_all_cft = 0 AND r.thickness > 0
     UNION SELECT from_thickness FROM wood_transfers WHERE wood_type_id = ? AND from_all = 0
     UNION SELECT to_thickness FROM wood_transfers WHERE wood_type_id = ? AND to_all = 0`, [woodId, woodId, woodId, woodId]);
  return new Set(rows.map(r => dims(r.t)));
}

async function thicknessesOf(db, ids) {
  if (!ids.length) return [];
  const [rows] = await db.query('SELECT * FROM wood_type_thicknesses WHERE wood_type_id IN (?) ORDER BY thickness', [ids]);
  return rows.map(r => ({ ...r, thickness: dims(r.thickness), is_active: r.is_active ? 1 : 0 }));
}

router.get('/wood-types', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const [types] = await db.query(
      `SELECT wt.*, cu.name AS created_by_name, uu.name AS updated_by_name
         FROM wood_types wt LEFT JOIN users cu ON cu.id = wt.created_by LEFT JOIN users uu ON uu.id = wt.updated_by
        ${req.query.active === '1' ? 'WHERE wt.is_active = 1' : ''} ORDER BY wt.name`);
    const ids = types.map(t => t.id);
    let sizes = [];
    if (ids.length) [sizes] = await db.query('SELECT * FROM wood_type_sizes WHERE wood_type_id IN (?) ORDER BY sort_order, id', [ids]);
    const thick = await thicknessesOf(db, ids);
    const usage = await woodUsage(db, ids);
    // Older CFT sheets typed a wood name by hand — offered too, so reports can filter by it
    const [legacy] = await db.query(
      "SELECT DISTINCT TRIM(wood_type) AS name FROM cft_sheets WHERE wood_type_id IS NULL AND COALESCE(TRIM(wood_type),'')<>''");
    const known = new Set(types.map(t => woodKey(t.name)));
    res.json({
      rows: types.map(t => ({
        ...t, sizes: sizes.filter(s => s.wood_type_id === t.id),
        thicknesses: thick.filter(x => x.wood_type_id === t.id).map(x => ({ thickness: x.thickness, is_active: x.is_active })),
        usage: usage.get(t.id),
      })),
      legacy_names: legacy.map(l => l.name).filter(n => !known.has(woodKey(n))),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

async function saveWoodType(req, res, id) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    const name = text(b.name, 150);
    if (!name) return fail(res, 400, 'Enter the wood name');
    const sizes = cleanSizes(b.sizes);
    if (sizes.some(s => !s.length || !s.width || !s.thickness)) return fail(res, 400, 'Every size needs L, W and T (mm) above 0');
    // Thickness categories: [{ thickness, is_active }] (absent = leave the list as it is)
    let thick = null;
    if (Array.isArray(b.thicknesses)) {
      const seen = new Map();
      for (const x of b.thicknesses) {
        const t = dims(x && typeof x === 'object' ? x.thickness : x);
        if (!(t > 0)) return fail(res, 400, 'Every thickness must be above 0 mm');
        seen.set(t, x && typeof x === 'object' && x.is_active !== undefined ? (truthy(x.is_active) ? 1 : 0) : 1);
      }
      thick = [...seen.entries()].sort((p, q) => p[0] - q[0]);
    }
    const [[dup]] = await conn.query('SELECT id FROM wood_types WHERE LOWER(TRIM(name)) = ? AND id <> ?', [woodKey(name), id || 0]);
    if (dup) return fail(res, 400, `Wood "${name}" already exists`);
    await conn.beginTransaction();
    if (id) {
      const [[wt]] = await conn.query('SELECT id, name FROM wood_types WHERE id=? FOR UPDATE', [id]);
      if (!wt) { await conn.rollback(); return fail(res, 404, 'Wood type not found'); }
      await conn.query('UPDATE wood_types SET name=?, remarks=?, is_active=?, updated_by=? WHERE id=?',
        [name, text(b.remarks, 500), b.is_active === false || b.is_active === 0 ? 0 : 1, req.user.id, id]);
      // CFT sheets keep the wood name as text too — keep it in step with a rename
      if (wt.name !== name) await conn.query('UPDATE cft_sheets SET wood_type=? WHERE wood_type_id=?', [name, id]);
      await conn.query('DELETE FROM wood_type_sizes WHERE wood_type_id=?', [id]);
    } else {
      const [r] = await conn.query('INSERT INTO wood_types (name, remarks, is_active, created_by, updated_by) VALUES (?,?,1,?,?)',
        [name, text(b.remarks, 500), req.user.id, req.user.id]);
      id = r.insertId;
    }
    for (const s of sizes) {
      await conn.query('INSERT INTO wood_type_sizes (wood_type_id, label, length, width, thickness, sort_order) VALUES (?,?,?,?,?,?)',
        [id, s.label, s.length, s.width, s.thickness, s.sort_order]);
    }
    if (thick) {
      const keep = new Set(thick.map(([t]) => t));
      sizes.forEach(s => keep.add(s.thickness));        // a standard size's T stays in the list
      const [cur] = await conn.query('SELECT thickness FROM wood_type_thicknesses WHERE wood_type_id=?', [id]);
      const removed = cur.map(c => dims(c.thickness)).filter(t => !keep.has(t));
      if (removed.length) {
        const used = await usedThicknesses(conn, id);
        const blocked = removed.filter(t => used.has(t));
        if (blocked.length) {
          await conn.rollback();
          return fail(res, 400, `${blocked.map(t => `${t} mm`).join(', ')} ${blocked.length > 1 ? 'are' : 'is'} used in stock entries and can't be removed — mark ${blocked.length > 1 ? 'them' : 'it'} inactive instead.`);
        }
        await conn.query('DELETE FROM wood_type_thicknesses WHERE wood_type_id=? AND thickness IN (?)', [id, removed]);
      }
      for (let i = 0; i < thick.length; i++) {
        await conn.query(
          `INSERT INTO wood_type_thicknesses (wood_type_id, thickness, is_active, sort_order) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE is_active = VALUES(is_active), sort_order = VALUES(sort_order)`, [id, thick[i][0], thick[i][1], i]);
      }
    }
    for (const s of sizes) {
      await conn.query('INSERT IGNORE INTO wood_type_thicknesses (wood_type_id, thickness, is_active, sort_order) VALUES (?,?,1,999)', [id, s.thickness]);
    }
    await conn.commit();
    res.json({ id, message: `Wood type "${name}" saved` });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
}
router.post('/wood-types', auth, adminOrPermission('cft', 'write'), auditLog('CREATE', 'WoodType'), (req, res) => saveWoodType(req, res, null));
router.put('/wood-types/:id', auth, adminOrPermission('cft', 'edit'), auditLog('UPDATE', 'WoodType'), (req, res) => saveWoodType(req, res, Number(req.params.id)));

router.delete('/wood-types/:id', auth, adminOrPermission('cft', 'delete'), auditLog('DELETE', 'WoodType'), async (req, res) => {
  const db = await getPool();
  try {
    const id = Number(req.params.id);
    const [[wt]] = await db.query('SELECT id, name FROM wood_types WHERE id=?', [id]);
    if (!wt) return fail(res, 404, 'Wood type not found');
    const u = (await woodUsage(db, [id])).get(id);
    if (u.sheets || u.inwards || u.transfers) {
      return fail(res, 400, `"${wt.name}" is used in ${u.sheets} CFT sheet(s), ${u.inwards} inward entr${u.inwards === 1 ? 'y' : 'ies'} and ${u.transfers} transfer(s) — it can't be deleted. Mark it inactive instead.`);
    }
    await db.query('DELETE FROM wood_types WHERE id=?', [id]);   // sizes and thicknesses cascade
    res.json({ message: `Wood type "${wt.name}" deleted` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Thickness list per wood id: Map(id → Set of thickness numbers), active or not
async function thicknessMap(db, ids) {
  const m = new Map(ids.map(id => [id, new Set()]));
  (await thicknessesOf(db, ids)).forEach(x => m.get(x.wood_type_id)?.add(x.thickness));
  return m;
}

// ═════════════════════════ WOOD INWARD ══════════════════════════════════════
// Row: wood, thickness category (ALL CFT or a thickness of that wood), optional label / L / W / Qty.
// With L, W and Qty the CFT is calculated; otherwise the billed CFT is typed (direct_cft = 1).
function cleanRows(list, defaultWood) {
  return (Array.isArray(list) ? list : []).map((r, i) => {
    const isAll = truthy(r.is_all_cft);
    const row = {
      wood_type_id: parseInt(r.wood_type_id, 10) || defaultWood || null, is_all_cft: isAll ? 1 : 0,
      label: text(r.label, 255), length: isAll ? 0 : dims(r.length), width: isAll ? 0 : dims(r.width),
      thickness: isAll ? 0 : dims(r.thickness), qty: Math.round(num(r.qty) * 100) / 100, sort_order: i,
    };
    const calc = !isAll && row.length > 0 && row.width > 0 && row.thickness > 0 && row.qty > 0;
    if (calc) return { ...row, ...rowCft(row), direct_cft: 0 };
    const per = !isAll && row.length > 0 && row.width > 0 && row.thickness > 0 ? rowCft({ ...row, qty: 1 }).gross_cft : 0;
    return { ...row, gross_cft: per, net_cft: r4(num(r.cft ?? r.net_cft)), direct_cft: 1 };
  }).filter(r => r.label || r.length || r.width || r.qty || r.net_cft > 0);
}

async function loadInward(db, id) {
  const [[w]] = await db.query(
    `SELECT wi.*, DATE_FORMAT(wi.inward_date, '%Y-%m-%d') AS inward_date, DATE_FORMAT(wi.invoice_date, '%Y-%m-%d') AS invoice_date,
            wt.name AS wood_name, cu.name AS created_by_name, uu.name AS updated_by_name
       FROM wood_inwards wi JOIN wood_types wt ON wt.id = wi.wood_type_id
       LEFT JOIN users cu ON cu.id = wi.created_by LEFT JOIN users uu ON uu.id = wi.updated_by
      WHERE wi.id=?`, [id]);
  if (!w) return null;
  const [rows] = await db.query(
    `SELECT r.*, COALESCE(r.wood_type_id, ?) AS wood_type_id, wt.name AS wood_name
       FROM wood_inward_rows r LEFT JOIN wood_types wt ON wt.id = COALESCE(r.wood_type_id, ?)
      WHERE r.inward_id=? ORDER BY r.sort_order, r.id`, [w.wood_type_id, w.wood_type_id, id]);
  w.rows = rows.map(r => ({ ...r, thickness_label: tLabel(r.is_all_cft, r.thickness) }));
  return w;
}

router.get('/wood-inwards', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const where = [], args = [];
    if (ymd(req.query.from)) { where.push('wi.inward_date >= ?'); args.push(req.query.from); }
    if (ymd(req.query.to)) { where.push('wi.inward_date <= ?'); args.push(req.query.to); }
    const woodF = parseInt(req.query.wood_type_id, 10);
    if (woodF) {
      where.push('(wi.wood_type_id = ? OR EXISTS (SELECT 1 FROM wood_inward_rows x WHERE x.inward_id = wi.id AND x.wood_type_id = ?))');
      args.push(woodF, woodF);
    }
    if (['inward', 'opening'].includes(req.query.entry_type)) { where.push('wi.entry_type = ?'); args.push(req.query.entry_type); }
    const [rows] = await db.query(
      `SELECT wi.id, wi.inward_no, wi.entry_type, DATE_FORMAT(wi.inward_date, '%Y-%m-%d') AS inward_date, wi.reference, wi.remarks,
              wi.supplier_name, wi.invoice_no, DATE_FORMAT(wi.invoice_date, '%Y-%m-%d') AS invoice_date, wi.truck_no,
              wi.total_qty, wi.total_cft, wi.wood_type_id, cu.name AS created_by_name, wi.created_at, wi.updated_at,
              COALESCE((SELECT GROUP_CONCAT(DISTINCT xw.name ORDER BY xw.name SEPARATOR ', ')
                          FROM wood_inward_rows x JOIN wood_types xw ON xw.id = COALESCE(x.wood_type_id, wi.wood_type_id)
                         WHERE x.inward_id = wi.id), wt.name) AS wood_name,
              (SELECT COUNT(*) FROM wood_inward_rows r WHERE r.inward_id = wi.id) AS row_count
         FROM wood_inwards wi JOIN wood_types wt ON wt.id = wi.wood_type_id LEFT JOIN users cu ON cu.id = wi.created_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY wi.inward_date DESC, wi.id DESC`, args);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/wood-inwards/:id', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const w = await loadInward(db, req.params.id);
    if (!w) return fail(res, 404, 'Inward entry not found');
    res.json(w);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

async function saveInward(req, res, id) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    const date = ymd(b.inward_date);
    if (!date) return fail(res, 400, 'Enter the inward date');
    const rows = cleanRows(b.rows, parseInt(b.wood_type_id, 10) || null);
    if (!rows.length) return fail(res, 400, 'Add at least one row');
    const woodIds = [...new Set(rows.map(r => r.wood_type_id).filter(Boolean))];
    const headWood = parseInt(b.wood_type_id, 10) || rows[0].wood_type_id;
    if (!headWood || rows.some(r => !r.wood_type_id)) return fail(res, 400, 'Choose the wood type for every row');
    const [found] = await conn.query('SELECT id, name FROM wood_types WHERE id IN (?)', [[...new Set([headWood, ...woodIds])]]);
    const names = new Map(found.map(w => [w.id, w.name]));
    if (!names.has(headWood) || woodIds.some(w => !names.has(w))) return fail(res, 400, 'Wood type not found');
    const tm = await thicknessMap(conn, woodIds);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.is_all_cft) {
        if (!(r.thickness > 0)) return fail(res, 400, `Row ${i + 1}: choose the thickness`);
        if (!tm.get(r.wood_type_id)?.has(r.thickness)) return fail(res, 400, `Row ${i + 1}: ${r.thickness} mm is not a thickness of ${names.get(r.wood_type_id)} — add it in Wood Types first`);
      }
      if (!(r.net_cft > 0)) return fail(res, 400, `Row ${i + 1}: enter L, W and Qty, or type the billed CFT`);
    }
    const entryType = b.entry_type === 'opening' ? 'opening' : 'inward';
    const supplier = text(b.supplier_name, 255), invoiceNo = text(b.invoice_no, 100);
    // The same supplier invoice can only be entered once
    if (invoiceNo) {
      const [[dupInv]] = await conn.query(
        `SELECT inward_no FROM wood_inwards WHERE LOWER(TRIM(invoice_no)) = ? AND LOWER(TRIM(COALESCE(supplier_name,''))) = ? AND id <> ? LIMIT 1`,
        [invoiceNo.toLowerCase(), (supplier || '').toLowerCase(), id || 0]);
      if (dupInv) return fail(res, 400, `Invoice ${invoiceNo}${supplier ? ` from ${supplier}` : ''} is already entered as ${dupInv.inward_no}`);
    }
    const planned = rows.map((r, i) => ({ src: 'inw', doc_id: id || 'new', row_id: `p${i}`, kind: entryType, date, wood_name: names.get(r.wood_type_id),
      is_all_cft: r.is_all_cft, thickness: r.thickness, net_cft: r.net_cft, qty: r.qty, label: r.label }));
    const blocked = await stockGuard(conn, { remove: m => m.src === 'inw' && id && m.doc_id === id, add: planned });
    if (blocked) return fail(res, 400, blocked);
    const totalQty = Math.round(rows.reduce((a, r) => a + r.qty, 0) * 100) / 100;
    const totalCft = r4(rows.reduce((a, r) => a + r.net_cft, 0));
    const head = [entryType, date, headWood, text(b.reference, 255), text(b.remarks, 2000), supplier, invoiceNo,
      ymd(b.invoice_date), text(b.truck_no, 50), totalQty, totalCft];

    await conn.beginTransaction();
    let inwardNo;
    if (id) {
      const [[cur]] = await conn.query('SELECT id, inward_no FROM wood_inwards WHERE id=? FOR UPDATE', [id]);
      if (!cur) { await conn.rollback(); return fail(res, 404, 'Inward entry not found'); }
      inwardNo = cur.inward_no;
      await conn.query(
        `UPDATE wood_inwards SET entry_type=?, inward_date=?, wood_type_id=?, reference=?, remarks=?, supplier_name=?, invoice_no=?,
           invoice_date=?, truck_no=?, total_qty=?, total_cft=?, updated_by=? WHERE id=?`, [...head, req.user.id, id]);
      await conn.query('DELETE FROM wood_inward_rows WHERE inward_id=?', [id]);
    } else {
      await conn.query("SELECT setting_value FROM app_settings WHERE setting_key='wood_inward_prefix' FOR UPDATE");
      inwardNo = await generateSeriesNumber(conn, {
        prefixKey: 'wood_inward_prefix', startKey: 'wood_inward_start_number', defaultPrefix: 'WIN', table: 'wood_inwards', column: 'inward_no',
      });
      for (let i = 0; i < 1000; i++) {
        const [[taken]] = await conn.query('SELECT id FROM wood_inwards WHERE inward_no=?', [inwardNo]);
        if (!taken) break;
        inwardNo = inwardNo.replace(/(\d+)$/, d => String(Number(d) + 1));
      }
      const [r] = await conn.query(
        `INSERT INTO wood_inwards (inward_no, entry_type, inward_date, wood_type_id, reference, remarks, supplier_name, invoice_no,
           invoice_date, truck_no, total_qty, total_cft, created_by, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [inwardNo, ...head, req.user.id, req.user.id]);
      id = r.insertId;
    }
    for (const row of rows) {
      await conn.query(
        `INSERT INTO wood_inward_rows (inward_id, wood_type_id, is_all_cft, direct_cft, label, length, width, thickness, qty, gross_cft, net_cft, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, row.wood_type_id, row.is_all_cft, row.direct_cft, row.label, row.length, row.width, row.thickness, row.qty, row.gross_cft, row.net_cft, row.sort_order]);
    }
    await conn.commit();
    res.json({ id, inward_no: inwardNo, message: `${entryType === 'opening' ? 'Opening balance' : 'Inward'} ${inwardNo} saved` });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
}
router.post('/wood-inwards', auth, adminOrPermission('cft', 'write'), auditLog('CREATE', 'WoodInward'), (req, res) => saveInward(req, res, null));
router.put('/wood-inwards/:id', auth, adminOrPermission('cft', 'edit'), auditLog('UPDATE', 'WoodInward'), (req, res) => saveInward(req, res, Number(req.params.id)));
router.delete('/wood-inwards/:id', auth, adminOrPermission('cft', 'delete'), auditLog('DELETE', 'WoodInward'), async (req, res) => {
  const db = await getPool();
  try {
    const [[w]] = await db.query('SELECT id, inward_no FROM wood_inwards WHERE id=?', [req.params.id]);
    if (!w) return fail(res, 404, 'Inward entry not found');
    const blocked = await stockGuard(db, { remove: m => m.src === 'inw' && m.doc_id === w.id });
    if (blocked) return fail(res, 400, `${w.inward_no} can't be deleted. ${blocked}`);
    await db.query('DELETE FROM wood_inwards WHERE id=?', [w.id]);   // rows cascade
    res.json({ message: `${w.inward_no} deleted` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ═════════════════════════ STOCK MOVEMENTS ══════════════════════════════════
// Every stock movement, oldest first. `f` narrows by wood / size / thickness category
// (+ exclude_sheet: leave one CFT sheet out, to show the stock available to it).
async function loadMovements(db, f = {}) {
  const [inw] = await db.query(
    `SELECT 'inw' AS src, r.id AS row_id, wi.id AS doc_id, wi.inward_no AS ref_no, wi.entry_type AS kind,
            DATE_FORMAT(wi.inward_date, '%Y-%m-%d') AS date, wt.name AS wood_name,
            r.label, r.length, r.width, r.thickness, r.qty, r.net_cft, r.is_all_cft,
            CONCAT_WS(' · ', NULLIF(wi.supplier_name,''), IF(COALESCE(wi.invoice_no,'')<>'', CONCAT('Inv ', wi.invoice_no), NULL),
                      NULLIF(wi.truck_no,''), NULLIF(wi.reference,'')) AS note,
            cu.name AS by_name, wi.created_at AS entered_at,
            NULL AS project_id, NULL AS project_name, NULL AS project_code
       FROM wood_inward_rows r JOIN wood_inwards wi ON wi.id = r.inward_id
       JOIN wood_types wt ON wt.id = COALESCE(r.wood_type_id, wi.wood_type_id)
       LEFT JOIN users cu ON cu.id = wi.created_by
      WHERE r.qty > 0 OR r.net_cft > 0`);
  const [cft] = await db.query(
    `SELECT 'cft' AS src, r.id AS row_id, cs.id AS doc_id, cs.sheet_no AS ref_no,
            IF(r.row_type = 'issue', 'outward', 'return') AS kind,
            DATE_FORMAT(COALESCE(cs.approved_at, cs.submitted_at, cs.created_at), '%Y-%m-%d') AS date,
            COALESCE(wt.name, NULLIF(TRIM(cs.wood_type), ''), '(no wood type)') AS wood_name,
            r.label, r.length, r.width, r.thickness, r.qty, r.net_cft, r.is_all_cft, pi.item_name AS note,
            COALESCE(au.name, su.name, cu.name) AS by_name, COALESCE(cs.approved_at, cs.submitted_at, cs.created_at) AS entered_at,
            p.id AS project_id, p.name AS project_name, p.project_id AS project_code
       FROM cft_rows r JOIN cft_sheets cs ON cs.id = r.sheet_id
       LEFT JOIN wood_types wt ON wt.id = cs.wood_type_id
       LEFT JOIN projects p ON p.id = cs.project_id
       LEFT JOIN project_items pi ON pi.id = cs.project_item_id
       LEFT JOIN users au ON au.id = cs.approved_by LEFT JOIN users su ON su.id = cs.submitted_by LEFT JOIN users cu ON cu.id = cs.created_by
      WHERE r.row_type IN ('issue','return') AND (r.qty > 0 OR r.net_cft > 0) AND cs.status IN ('approved','submitted')`);
  const [trf] = await db.query(
    `SELECT t.*, DATE_FORMAT(t.transfer_date, '%Y-%m-%d') AS date, wt.name AS wood_name, cu.name AS by_name
       FROM wood_transfers t JOIN wood_types wt ON wt.id = t.wood_type_id LEFT JOIN users cu ON cu.id = t.created_by
      WHERE t.cft > 0`);
  const trfMoves = trf.flatMap(t => {
    const route = `${tLabel(t.from_all, t.from_thickness)} → ${tLabel(t.to_all, t.to_thickness)}`;
    const base = { src: 'trf', doc_id: t.id, ref_no: t.transfer_no, date: t.date, wood_name: t.wood_name, label: route,
      length: 0, width: 0, qty: 0, net_cft: t.cft, note: t.remarks, by_name: t.by_name, entered_at: t.created_at,
      project_id: null, project_name: null, project_code: null };
    return [
      { ...base, row_id: `${t.id}o`, kind: 'transfer_out', thickness: t.from_thickness, is_all_cft: t.from_all },
      { ...base, row_id: `${t.id}i`, kind: 'transfer_in', thickness: t.to_thickness, is_all_cft: t.to_all },
    ];
  });
  let list = [...inw, ...cft, ...trfMoves].map(toMove);
  if (f.wood) list = list.filter(m => woodKey(m.wood_name) === woodKey(f.wood));
  if (f.label) list = list.filter(m => labelKey(m.label).includes(labelKey(f.label)));
  for (const [k, col] of [['l', 'length'], ['w', 'width'], ['t', 'thickness']]) {
    if (f[k] !== undefined && f[k] !== '' && Number.isFinite(Number(f[k]))) list = list.filter(m => m[col] === Number(f[k]));
  }
  if (f.bucket) list = list.filter(m => m.bucket === (String(f.bucket).toUpperCase() === 'ALL' ? 'ALL' : String(dims(f.bucket))));
  if (f.exclude_sheet) list = list.filter(m => !(m.src === 'cft' && m.doc_id === Number(f.exclude_sheet)));
  return sortMoves(list);
}

// One stock movement (from the documents above, or a planned one for the negative-stock check)
function toMove(m) {
  const isAll = !!Number(m.is_all_cft);
  const bkey = tKey(isAll, m.thickness);
  const label = m.src === 'trf' ? m.label : isAll ? (m.label ? `${m.label} · ALL CFT` : 'ALL CFT') : m.label;
  return {
    ...m, label, length: Number(m.length) || 0, width: Number(m.width) || 0, thickness: isAll ? 0 : Number(m.thickness) || 0,
    qty: Number(m.qty) || 0, cft: Number(m.net_cft) || 0, is_all: isAll, bucket: bkey, bucket_label: keyLabel(bkey),
    sign: m.kind === 'outward' || m.kind === 'transfer_out' ? -1 : 1,
    dim_key: m.src === 'trf' ? `${woodKey(m.wood_name)}|trf|${bkey}`
      : isAll ? `${woodKey(m.wood_name)}|all|${labelKey(m.label)}`
        : `${woodKey(m.wood_name)}|${labelKey(m.label)}|${Number(m.length)}|${Number(m.width)}|${Number(m.thickness)}`,
  };
}
// Same day: stock coming in counts before stock going out
const KIND_ORDER = { opening: 0, inward: 1, return: 2, transfer_in: 3, transfer_out: 4, outward: 5 };
function sortMoves(list) {
  return list.sort((a, b) => a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || String(a.doc_id).localeCompare(String(b.doc_id), undefined, { numeric: true })
    || String(a.row_id).localeCompare(String(b.row_id), undefined, { numeric: true }));
}

// ── Negative-stock guard ──
async function allowNegative(db) {
  const [[s]] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='cft_allow_negative_stock'");
  return String(s?.setting_value || 'no').trim().toLowerCase() === 'yes';
}
const todayYmd = async db => { const [[r]] = await db.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d') AS d"); return r.d; };
// Lowest running balance per wood + thickness: Map(key → { min, date, wood_name, label })
function lowestBalances(moves) {
  const run = new Map(), low = new Map();
  for (const m of sortMoves([...moves])) {
    const k = `${woodKey(m.wood_name)}|${m.bucket}`;
    const bal = r4((run.get(k) || 0) + m.sign * m.cft);
    run.set(k, bal);
    const cur = low.get(k);
    if (!cur || bal < cur.min) low.set(k, { min: bal, date: m.date, wood_name: m.wood_name, label: m.bucket_label });
  }
  return low;
}
// Refuses a change when negative stock is not allowed. `remove` picks movements the change takes
// away (an edited / deleted document), `add` lists the movements it creates.
// Stock that was already below zero before the change only blocks it if it gets worse.
async function stockGuard(db, { remove = () => false, add = [] } = {}) {
  if (await allowNegative(db)) return null;
  const before = await loadMovements(db);
  const after = [...before.filter(m => !remove(m)), ...add.map(toMove)];
  const was = lowestBalances(before), now = lowestBalances(after);
  const bad = [];
  for (const [k, x] of now) {
    if (x.min >= -0.00005) continue;
    const prev = was.get(k);
    if (prev && x.min >= prev.min - 0.00005) continue;
    bad.push(x);
  }
  if (!bad.length) return null;
  return `Not enough stock — ${bad.map(x => `${x.wood_name} ${x.label} would go to ${x.min.toFixed(4)} CFT on ${x.date}`).join('; ')}. Negative stock is off in Settings.`;
}
const readFilters = q => ({ wood: q.wood || '', label: q.label || '', l: q.l, w: q.w, t: q.t, bucket: q.bucket || '' });

// Closing stock per wood+size (for the negative-stock warning and "current stock")
function stockByDim(moves) {
  const m = new Map();
  for (const x of moves) {
    if (!m.has(x.dim_key)) m.set(x.dim_key, { wood_name: x.wood_name, label: x.label, length: x.length, width: x.width, thickness: x.thickness, qty: 0, cft: 0 });
    const g = m.get(x.dim_key); g.qty += x.sign * x.qty; g.cft += x.sign * x.cft;
  }
  for (const g of m.values()) { g.qty = Math.round(g.qty * 100) / 100; g.cft = r4(g.cft); }
  return m;
}

// Closing CFT per thickness category of one wood: { '38': 120.5, ALL: 40 }
function stockByBucket(moves, wood) {
  const out = {};
  for (const m of moves) {
    if (wood && woodKey(m.wood_name) !== woodKey(wood)) continue;
    out[m.bucket] = r4((out[m.bucket] || 0) + m.sign * m.cft);
  }
  return out;
}

// ── DETAILED CFT REPORT (stock ledger by size) ──
// Opening / closing follow the wood + size filters; type and reference only narrow the rows shown.
router.get('/wood-stock/ledger', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const q = req.query;
    const from = ymd(q.from), to = ymd(q.to);
    const all = await loadMovements(db, readFilters(q));
    const upto = all.filter(m => !to || m.date <= to);
    const before = upto.filter(m => from && m.date < from);
    const period = upto.filter(m => !from || m.date >= from);
    const opening = r4(before.reduce((a, m) => a + m.sign * m.cft, 0));
    const openingQty = Math.round(before.reduce((a, m) => a + m.sign * m.qty, 0) * 100) / 100;
    let bal = opening;
    let rows = period.map(m => {
      bal = r4(bal + m.sign * m.cft);
      return {
        key: `${m.src}-${m.row_id}`, date: m.date, kind: m.kind, ref_no: m.ref_no, doc_id: m.doc_id, src: m.src,
        wood_name: m.wood_name, label: m.label, length: m.length, width: m.width, thickness: m.thickness, bucket: m.bucket_label,
        in_qty: m.sign > 0 ? m.qty : 0, out_qty: m.sign < 0 ? m.qty : 0,
        in_cft: m.sign > 0 ? m.cft : 0, out_cft: m.sign < 0 ? m.cft : 0,
        closing_cft: bal, negative: bal < 0, note: m.note, project_name: m.project_name, project_code: m.project_code,
      };
    });
    const sum = k => r4(period.filter(m => m.kind === k).reduce((a, m) => a + m.cft, 0));
    const sumQ = k => Math.round(period.filter(m => m.kind === k).reduce((a, m) => a + m.qty, 0) * 100) / 100;
    const summary = {
      opening_cft: opening, opening_qty: openingQty,
      opening_entries_cft: sum('opening'), inward_cft: sum('inward'), return_cft: sum('return'), outward_cft: sum('outward'),
      transfer_in_cft: sum('transfer_in'), transfer_out_cft: sum('transfer_out'),
      opening_entries_qty: sumQ('opening'), inward_qty: sumQ('inward'), return_qty: sumQ('return'), outward_qty: sumQ('outward'),
    };
    summary.closing_cft = r4(opening + summary.opening_entries_cft + summary.inward_cft + summary.return_cft
      + summary.transfer_in_cft - summary.transfer_out_cft - summary.outward_cft);
    if (['inward', 'outward', 'return', 'opening', 'transfer_in', 'transfer_out'].includes(q.type)) rows = rows.filter(r => r.kind === q.type);
    if (q.ref) rows = rows.filter(r => String(r.ref_no || '').toLowerCase().includes(String(q.ref).toLowerCase()));
    const negative = [...stockByDim(upto.filter(m => m.src !== 'trf')).values()].filter(g => g.cft < 0 || g.qty < 0);
    res.json({ summary, rows, negative, shown: rows.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── STOCK DASHBOARD: one card per wood type, one row per thickness category ──
// ?from=&to=&wood=<name>&bucket=<'ALL'|thickness>
// Opening = stock before From (+ opening-balance entries dated inside the period);
// Closing = Opening + Inward + Return + Transfer In − Transfer Out − Outward.
const ZERO = () => ({ opening: 0, inward: 0, outward: 0, return: 0, transfer_in: 0, transfer_out: 0, closing: 0 });
function addMove(st, m, inPeriod) {
  if (!inPeriod) { st.opening += m.sign * m.cft; return; }
  if (m.kind === 'opening') st.opening += m.cft;
  else if (m.kind === 'inward') st.inward += m.cft;
  else if (m.kind === 'return') st.return += m.cft;
  else if (m.kind === 'outward') st.outward += m.cft;
  else if (m.kind === 'transfer_in') st.transfer_in += m.cft;
  else if (m.kind === 'transfer_out') st.transfer_out += m.cft;
}
const MOVE_KEYS = Object.keys(ZERO());
function finish(st) {
  for (const k of MOVE_KEYS) st[k] = r4(st[k]);
  st.closing = r4(st.opening + st.inward + st.return + st.transfer_in - st.transfer_out - st.outward);
  return st;
}
const bucketSort = (a, b) => (a.key === 'ALL') - (b.key === 'ALL') || Number(a.key) - Number(b.key);

router.get('/wood-stock/thickness-summary', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const q = req.query;
    const from = ymd(q.from), to = ymd(q.to);
    const bucketF = q.bucket ? (String(q.bucket).toUpperCase() === 'ALL' ? 'ALL' : String(dims(q.bucket))) : '';
    const moves = (await loadMovements(db, {})).filter(m => !to || m.date <= to);
    const [types] = await db.query('SELECT id, name, is_active FROM wood_types ORDER BY name');
    const thick = await thicknessesOf(db, types.map(t => t.id));
    const woods = new Map();   // woodKey → { wood_name, wood_type_id, is_active, in_master, buckets: Map }
    const ensureWood = (name, extra = {}) => {
      const k = woodKey(name);
      if (!woods.has(k)) woods.set(k, { wood_name: name, wood_type_id: null, is_active: 1, in_master: false, buckets: new Map(), ...extra });
      return woods.get(k);
    };
    const ensureBucket = (w, key, inMaster = false, active = 1) => {
      if (!w.buckets.has(key)) w.buckets.set(key, { key, label: keyLabel(key), in_master: inMaster || key === 'ALL', is_active: active, moved: false, ...ZERO() });
      return w.buckets.get(key);
    };
    for (const t of types) {
      const w = ensureWood(t.name, { wood_type_id: t.id, is_active: t.is_active ? 1 : 0, in_master: true });
      thick.filter(x => x.wood_type_id === t.id).forEach(x => ensureBucket(w, String(x.thickness), true, x.is_active));
      ensureBucket(w, 'ALL', true);
    }
    for (const m of moves) {
      const w = ensureWood(m.wood_name);
      const b = ensureBucket(w, m.bucket);
      b.moved = true;
      addMove(b, m, !from || m.date >= from);
    }
    let list = [...woods.values()]
      .filter(w => !q.wood || woodKey(w.wood_name) === woodKey(q.wood))
      .filter(w => w.is_active || [...w.buckets.values()].some(b => b.moved))
      .map(w => {
        let buckets = [...w.buckets.values()].map(finish)
          .filter(b => b.is_active || b.moved)
          .sort(bucketSort);
        if (bucketF) buckets = buckets.filter(b => b.key === bucketF);
        const totals = finish(buckets.reduce((t, b) => { Object.keys(t).forEach(k => { t[k] += b[k]; }); return t; }, ZERO()));
        return { wood_name: w.wood_name, wood_type_id: w.wood_type_id, is_active: w.is_active, in_master: w.in_master,
          buckets: buckets.map(({ moved, ...b }) => b), totals };
      })
      .filter(w => w.buckets.length)
      .sort((a, b) => b.in_master - a.in_master || a.wood_name.localeCompare(b.wood_name));
    const totals = finish(list.reduce((t, w) => { Object.keys(t).forEach(k => { t[k] += w.totals[k]; }); return t; }, ZERO()));
    res.json({ woods: list, totals });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Ledger of one wood + thickness category, with running balance ──
router.get('/wood-stock/thickness-ledger', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const q = req.query;
    if (!q.wood || !q.bucket) return fail(res, 400, 'Choose the wood and thickness');
    const from = ymd(q.from), to = ymd(q.to);
    const moves = (await loadMovements(db, { wood: q.wood, bucket: q.bucket })).filter(m => !to || m.date <= to);
    const st = ZERO();
    moves.filter(m => from && m.date < from).forEach(m => addMove(st, m, false));
    const opening = r4(st.opening);
    let bal = opening;
    const rows = moves.filter(m => !from || m.date >= from).map(m => {
      addMove(st, m, true);
      bal = r4(bal + m.sign * m.cft);
      return {
        key: `${m.src}-${m.row_id}`, date: m.date, kind: m.kind, ref_no: m.ref_no, src: m.src, doc_id: m.doc_id,
        label: m.label, length: m.length, width: m.width, thickness: m.thickness, qty: m.qty,
        in_cft: m.sign > 0 ? m.cft : 0, out_cft: m.sign < 0 ? m.cft : 0, balance: bal, negative: bal < 0,
        note: m.note, project_name: m.project_name, project_code: m.project_code, by_name: m.by_name, entered_at: m.entered_at,
      };
    });
    res.json({ wood: q.wood, bucket: String(q.bucket).toUpperCase() === 'ALL' ? 'ALL' : String(dims(q.bucket)), label: keyLabel(parseKey(q.bucket).all ? 'ALL' : String(dims(q.bucket))),
      opening_cft: opening, summary: finish(st), rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Stock available per thickness of one wood (CFT sheet Issue rows, transfers) ──
// ?wood_type_id= | ?wood=  &exclude_sheet=<CFT sheet id>  &as_of=YYYY-MM-DD
router.get('/wood-stock/available', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    let wood = String(req.query.wood || '');
    if (parseInt(req.query.wood_type_id, 10)) {
      const [[wt]] = await db.query('SELECT name FROM wood_types WHERE id=?', [parseInt(req.query.wood_type_id, 10)]);
      if (!wt) return fail(res, 404, 'Wood type not found');
      wood = wt.name;
    }
    if (!wood) return fail(res, 400, 'Choose the wood');
    const asOf = ymd(req.query.as_of);
    const moves = (await loadMovements(db, { wood, exclude_sheet: req.query.exclude_sheet }))
      .filter(m => !asOf || m.date <= asOf)
      .filter(m => !(m.src === 'trf' && req.query.exclude_transfer && m.doc_id === Number(req.query.exclude_transfer)));
    res.json({ wood, buckets: stockByBucket(moves) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ═════════════════════════ TRANSFERS between thickness categories ═══════════════
const transferRow = t => ({
  ...t, cft: Number(t.cft), from_key: tKey(t.from_all, t.from_thickness), to_key: tKey(t.to_all, t.to_thickness),
  from_label: tLabel(t.from_all, t.from_thickness), to_label: tLabel(t.to_all, t.to_thickness),
});

router.get('/wood-transfers', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const where = [], args = [];
    if (ymd(req.query.from)) { where.push('t.transfer_date >= ?'); args.push(req.query.from); }
    if (ymd(req.query.to)) { where.push('t.transfer_date <= ?'); args.push(req.query.to); }
    if (parseInt(req.query.wood_type_id, 10)) { where.push('t.wood_type_id = ?'); args.push(parseInt(req.query.wood_type_id, 10)); }
    const [rows] = await db.query(
      `SELECT t.*, DATE_FORMAT(t.transfer_date, '%Y-%m-%d') AS transfer_date, wt.name AS wood_name, cu.name AS created_by_name, uu.name AS updated_by_name
         FROM wood_transfers t JOIN wood_types wt ON wt.id = t.wood_type_id
         LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN users uu ON uu.id = t.updated_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.transfer_date DESC, t.id DESC`, args);
    res.json(rows.map(transferRow));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

async function saveTransfer(req, res, id) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    const date = ymd(b.transfer_date);
    if (!date) return fail(res, 400, 'Enter the transfer date');
    const woodId = parseInt(b.wood_type_id, 10);
    if (!woodId) return fail(res, 400, 'Choose the wood type');
    const [[wt]] = await conn.query('SELECT id, name FROM wood_types WHERE id=?', [woodId]);
    if (!wt) return fail(res, 400, 'Wood type not found');
    if (!b.from_key || !b.to_key) return fail(res, 400, 'Choose the From and To thickness');
    const fromK = parseKey(b.from_key), toK = parseKey(b.to_key);
    const list = (await thicknessMap(conn, [woodId])).get(woodId);
    for (const [k, side] of [[fromK, 'From'], [toK, 'To']]) {
      if (!k.all && !(k.t > 0 && list.has(k.t))) return fail(res, 400, `${side}: ${k.t} mm is not a thickness of ${wt.name}`);
    }
    if (fromK.all === toK.all && fromK.t === toK.t) return fail(res, 400, 'From and To must be different thicknesses');
    const cft = r4(num(b.cft));
    if (!(cft > 0)) return fail(res, 400, 'Enter the CFT to transfer');
    const base = { src: 'trf', doc_id: id || 'new', date, wood_name: wt.name, net_cft: cft, label: 'Transfer' };
    const blocked = await stockGuard(conn, {
      remove: m => m.src === 'trf' && id && m.doc_id === id,
      add: [{ ...base, row_id: 'po', kind: 'transfer_out', is_all_cft: fromK.all, thickness: fromK.t },
            { ...base, row_id: 'pi', kind: 'transfer_in', is_all_cft: toK.all, thickness: toK.t }],
    });
    if (blocked) return fail(res, 400, blocked);

    await conn.beginTransaction();
    let no;
    const vals = [date, woodId, fromK.all, fromK.t, toK.all, toK.t, cft, text(b.remarks, 2000)];
    if (id) {
      const [[cur]] = await conn.query('SELECT id, transfer_no FROM wood_transfers WHERE id=? FOR UPDATE', [id]);
      if (!cur) { await conn.rollback(); return fail(res, 404, 'Transfer not found'); }
      no = cur.transfer_no;
      await conn.query(
        `UPDATE wood_transfers SET transfer_date=?, wood_type_id=?, from_all=?, from_thickness=?, to_all=?, to_thickness=?, cft=?, remarks=?, updated_by=? WHERE id=?`,
        [...vals, req.user.id, id]);
    } else {
      await conn.query("SELECT setting_value FROM app_settings WHERE setting_key='wood_transfer_prefix' FOR UPDATE");
      no = await generateSeriesNumber(conn, {
        prefixKey: 'wood_transfer_prefix', startKey: 'wood_transfer_start_number', defaultPrefix: 'WTR', table: 'wood_transfers', column: 'transfer_no',
      });
      for (let i = 0; i < 1000; i++) {
        const [[taken]] = await conn.query('SELECT id FROM wood_transfers WHERE transfer_no=?', [no]);
        if (!taken) break;
        no = no.replace(/(\d+)$/, d => String(Number(d) + 1));
      }
      const [r] = await conn.query(
        `INSERT INTO wood_transfers (transfer_no, transfer_date, wood_type_id, from_all, from_thickness, to_all, to_thickness, cft, remarks, created_by, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [no, ...vals, req.user.id, req.user.id]);
      id = r.insertId;
    }
    await conn.commit();
    // Negative stock is allowed, but say so
    const moves = (await loadMovements(pool, { wood: wt.name })).filter(m => m.date <= date);
    const left = stockByBucket(moves)[tKey(fromK.all, fromK.t)] || 0;
    res.json({
      id, transfer_no: no, message: `Transfer ${no} saved`,
      warning: left < 0 ? `${wt.name} ${tLabel(fromK.all, fromK.t)} is now ${left.toFixed(4)} CFT (below zero) on ${date}` : null,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
}
router.post('/wood-transfers', auth, adminOrPermission('cft', 'write'), auditLog('CREATE', 'WoodTransfer'), (req, res) => saveTransfer(req, res, null));
router.put('/wood-transfers/:id', auth, adminOrPermission('cft', 'edit'), auditLog('UPDATE', 'WoodTransfer'), (req, res) => saveTransfer(req, res, Number(req.params.id)));
router.delete('/wood-transfers/:id', auth, adminOrPermission('cft', 'delete'), auditLog('DELETE', 'WoodTransfer'), async (req, res) => {
  const db = await getPool();
  try {
    const [[t]] = await db.query('SELECT id, transfer_no FROM wood_transfers WHERE id=?', [req.params.id]);
    if (!t) return fail(res, 404, 'Transfer not found');
    const blocked = await stockGuard(db, { remove: m => m.src === 'trf' && m.doc_id === t.id });
    if (blocked) return fail(res, 400, `${t.transfer_no} can't be deleted. ${blocked}`);
    await db.query('DELETE FROM wood_transfers WHERE id=?', [t.id]);
    res.json({ message: `${t.transfer_no} deleted` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── WOOD CFT USAGE DASHBOARD ──
router.get('/wood-stock/usage', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const q = req.query;
    const from = ymd(q.from), to = ymd(q.to);
    const all = await loadMovements(db, readFilters(q));
    const upto = all.filter(m => !to || m.date <= to);
    const projectId = parseInt(q.project_id, 10) || null;
    const sheetQ = String(q.sheet || '').trim().toLowerCase();
    // Usage = CFT sheet issues/returns in the period (project / sheet filters apply here)
    const period = upto.filter(m => !from || m.date >= from);
    const use = period.filter(m => m.src === 'cft'
      && (!projectId || m.project_id === projectId)
      && (!sheetQ || String(m.ref_no).toLowerCase().includes(sheetQ)));
    const stock = stockByDim(upto);   // stock is not tied to a project
    const cftOf = (list, k) => r4(list.filter(m => m.kind === k).reduce((a, m) => a + m.cft, 0));
    const qtyOf = (list, k) => Math.round(list.filter(m => m.kind === k).reduce((a, m) => a + m.qty, 0) * 100) / 100;

    const group = keyFn => {
      const m = new Map();
      for (const x of use) {
        const k = keyFn(x);
        if (!m.has(k)) m.set(k, { items: [], first: x });
        m.get(k).items.push(x);
      }
      return m;
    };
    const stats = items => {
      const issued = cftOf(items, 'outward'), returned = cftOf(items, 'return');
      return { issued_qty: qtyOf(items, 'outward'), issued_cft: issued, returned_qty: qtyOf(items, 'return'), returned_cft: returned, net_cft: r4(issued - returned) };
    };
    const stockForWood = w => r4([...stock.values()].filter(g => woodKey(g.wood_name) === woodKey(w)).reduce((a, g) => a + g.cft, 0));

    const byWood = [...group(x => woodKey(x.wood_name)).values()].map(({ items, first }) => ({
      wood_name: first.wood_name, ...stats(items), current_stock_cft: stockForWood(first.wood_name),
    })).sort((a, b) => b.net_cft - a.net_cft);
    const byDim = [...group(x => x.dim_key).values()].map(({ items, first }) => ({
      wood_name: first.wood_name, label: first.label, length: first.length, width: first.width, thickness: first.thickness,
      ...stats(items), current_stock_cft: stock.get(first.dim_key)?.cft ?? 0,
    })).sort((a, b) => b.net_cft - a.net_cft);

    // Sheet-wise: issue/return from the movements; demand from the sheet (shown, never counted as stock)
    const sheetGroups = group(x => x.doc_id);
    const sheetIds = [...sheetGroups.keys()];
    let demand = new Map();
    if (sheetIds.length) {
      const [d] = await db.query('SELECT id, total_demand_cft FROM cft_sheets WHERE id IN (?)', [sheetIds]);
      demand = new Map(d.map(r => [r.id, Number(r.total_demand_cft)]));
    }
    const bySheet = [...sheetGroups.entries()].map(([id, { items, first }]) => ({
      sheet_id: id, sheet_no: first.ref_no, date: first.date, wood_name: first.wood_name,
      project_name: first.project_name, project_code: first.project_code, item_name: first.note,
      demand_cft: demand.get(id) || 0, issue_cft: cftOf(items, 'outward'), return_cft: cftOf(items, 'return'),
      net_cft: r4(cftOf(items, 'outward') - cftOf(items, 'return')),
    })).sort((a, b) => b.date.localeCompare(a.date) || b.sheet_id - a.sheet_id);

    const useSet = new Set(use);
    const months = new Map();
    for (const x of period) {
      const k = x.date.slice(0, 7);
      if (!months.has(k)) months.set(k, { month: k, inward: 0, issued: 0, returned: 0 });
      const g = months.get(k);
      if (x.src === 'inw') g.inward += x.cft;
      else if (useSet.has(x)) { if (x.kind === 'outward') g.issued += x.cft; else g.returned += x.cft; }
    }
    const byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
      .map(g => ({ ...g, inward: r4(g.inward), issued: r4(g.issued), returned: r4(g.returned), net: r4(g.issued - g.returned) }));

    const inwardPeriod = period.filter(m => m.src === 'inw');
    res.json({
      cards: {
        inward_cft: cftOf(inwardPeriod, 'inward'), opening_entries_cft: cftOf(inwardPeriod, 'opening'),
        issued_cft: cftOf(use, 'outward'), returned_cft: cftOf(use, 'return'),
        net_cft: r4(cftOf(use, 'outward') - cftOf(use, 'return')),
        closing_stock_cft: r4([...stock.values()].reduce((a, g) => a + g.cft, 0)),
        wood_types_used: new Set(use.filter(m => m.kind === 'outward').map(m => woodKey(m.wood_name))).size,
        sheets: sheetIds.length,
      },
      by_wood: byWood, by_dimension: byDim, by_sheet: bySheet, by_month: byMonth,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
module.exports.loadMovements = loadMovements;
module.exports.stockByBucket = stockByBucket;
module.exports.thicknessMap = thicknessMap;
module.exports.tKey = tKey;
module.exports.tLabel = tLabel;
module.exports.stockGuard = stockGuard;
module.exports.allowNegative = allowNegative;
module.exports.todayYmd = todayYmd;
