// ── MAIN PO Routes (NEW FILE — Phase 1) ──────────────────────────────────────
// Mounted in server.js at /api. The existing routes/index.js is NOT modified.
// Permission model (menu_key 'main_po'):
//   read  = View / Print          write = Add / Submit own
//   edit  = Edit draft/rejected   delete = Delete draft
//   Approve/Reject = admin only, via the EXISTING /api/approvals endpoints.

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');
const { moReferenceUpload, deleteFile } = require('../services/cloudinaryStorage');
const { createApprovalRequest } = require('../services/approvalService');
const { generateSeriesNumber } = require('../services/projectNumbering');
const proto = require('../services/protoCodes');
const { insertProjectItemFromMo } = require('../services/mainPoApproval');

// ── helpers ──────────────────────────────────────────────────────────────────
const flag = v => (v === 1 || v === '1' || v === true || String(v).toUpperCase() === 'YES') ? 1 : 0;

function validateHeader(body) {
  if (!body.project_name || !String(body.project_name).trim()) return 'Project Name is required';
  return null;
}

// Manufacturing Order No. is typed by the user. Returns { value } (null = not sent) or { error }.
function readPoNo(body) {
  if (body.po_no === undefined || body.po_no === null) return { value: null };
  const v = String(body.po_no).replace(/\s+/g, ' ').trim();
  if (!v) return { error: 'Manufacturing Order No. is required' };
  if (v.length > 50) return { error: 'Manufacturing Order No. can be at most 50 characters' };
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(v))
    return { error: 'Manufacturing Order No. can use letters, numbers, space and - _ / .' };
  return { value: v };
}

// Automatic number (only used when a screen sends no number). Typed numbers can
// make the series land on one that exists, so step forward until it is free.
async function nextFreeAutoPoNo(db) {
  let candidate = await generateSeriesNumber(db, {
    prefixKey: 'main_po_prefix', startKey: 'main_po_start_number',
    defaultPrefix: 'MPO', table: 'main_pos', column: 'po_no',
  });
  for (let i = 0; i < 1000 && await poNoTaken(db, candidate); i++) {
    candidate = candidate.replace(/(\d+)$/, d => String(Number(d) + 1));
  }
  return candidate;
}

async function poNoTaken(db, poNo, exceptId = null) {
  const [[row]] = await db.query(
    `SELECT id FROM main_pos WHERE po_no = ? ${exceptId ? 'AND id <> ?' : ''} LIMIT 1`,
    exceptId ? [poNo, exceptId] : [poNo]);
  return !!row;
}

// Qty of the row that needs Paint / Fabric finish. Off → null. Empty → the whole Qty.
// Must be more than 0 and not more than the row's Qty.
function finishQty(it, on, value, qty, label, idx) {
  if (!on) return null;
  if (value === '' || value === null || value === undefined) return qty;
  const n = Number(value);
  const who = `Row ${idx + 1}${it.product_name ? ` (${String(it.product_name).trim()})` : ''}`;
  const bad = msg => { const e = new Error(`${who}: ${msg}`); e.status = 400; return e; };
  if (!Number.isFinite(n) || n <= 0) throw bad(`${label} quantity must be more than 0`);
  if (n > qty + 1e-9) throw bad(`${label} quantity (${n}) can't be more than the item Qty (${qty})`);
  return Math.round(n * 100) / 100;
}

function normalizeItem(it, idx) {
  const qty = Number(it.qty) > 0 ? Number(it.qty) : 1;
  return {
    id: it.id || null,
    s_no: idx + 1,
    area: it.area || null,
    proto_code: it.proto_code || null,
    product_name: (it.product_name || '').trim(),
    product_size: it.product_size || null,
    finishes_note: it.finishes_note || null,
    is_paint_finish: flag(it.is_paint_finish),
    is_fabric_finish: flag(it.is_fabric_finish),
    is_metal_finish: flag(it.is_metal_finish),
    size_length: it.size_length || null,
    size_width: it.size_width || null,
    size_thickness: it.size_thickness || null,
    qty,
    paint_qty: finishQty(it, flag(it.is_paint_finish), it.paint_qty, qty, 'Paint Finish', idx),
    fabric_qty: finishQty(it, flag(it.is_fabric_finish), it.fabric_qty, qty, 'Fabric Finish', idx),
    remark: it.remark || null,
    sort_order: idx,
  };
}

// Proto Codes for the rows being saved on an order (create / edit / add later).
//  auto   → rows that already have a saved code keep it; every new row gets the
//           next code of the series (typed codes are ignored)
//  manual → the typed codes, with no code twice on the order
// `rows` are normalized items; `savedCodes` = Map(itemId → code already in the DB);
// `otherCodes` = codes on the order that are not part of `rows`.
async function applyProtoCodes(conn, mode, rows, savedCodes = new Map(), otherCodes = []) {
  if (proto.modeOf(mode) === 'auto') {
    const needs = rows.filter(r => !(r.id && savedCodes.get(Number(r.id))));
    const codes = await proto.takeCodes(conn, needs.length);
    rows.forEach(r => { if (r.id && savedCodes.get(Number(r.id))) r.proto_code = savedCodes.get(Number(r.id)); });
    needs.forEach((r, i) => { r.proto_code = codes[i]; });
    return;
  }
  rows.forEach(r => { r.proto_code = proto.cleanCode(r.proto_code) || null; });
  if (mode === 'manual') proto.checkManualCodes(rows.map(r => r.proto_code), otherCodes);
}

const ITEM_COLS = `main_po_id, s_no, area, proto_code, product_name, product_size, finishes_note,
  is_paint_finish, is_fabric_finish, is_metal_finish, size_length, size_width, size_thickness, qty, remark, sort_order,
  paint_qty, fabric_qty`;
const itemVals = (poId, it) => [poId, it.s_no, it.area, it.proto_code, it.product_name, it.product_size, it.finishes_note,
  it.is_paint_finish, it.is_fabric_finish, it.is_metal_finish, it.size_length, it.size_width, it.size_thickness,
  it.qty, it.remark, it.sort_order, it.paint_qty, it.fabric_qty];

async function loadPo(db, id) {
  const [[po]] = await db.query(
    `SELECT mp.*, p.project_id AS linked_project_code, p.name AS linked_project_name,
            p.proto_mode AS project_proto_mode,
            cu.name AS created_by_name, su.name AS submitted_by_name,
            au.name AS approved_by_name, ru.name AS rejected_by_name
     FROM main_pos mp
     LEFT JOIN projects p  ON p.id = mp.project_id
     LEFT JOIN users cu ON cu.id = mp.created_by
     LEFT JOIN users su ON su.id = mp.submitted_by
     LEFT JOIN users au ON au.id = mp.approved_by
     LEFT JOIN users ru ON ru.id = mp.rejected_by
     WHERE mp.id=?`, [id]);
  if (!po) return null;
  const [items] = await db.query(
    'SELECT * FROM main_po_items WHERE main_po_id=? ORDER BY sort_order, id', [id]);
  const itemIds = items.map(i => i.id);
  let images = [];
  if (itemIds.length) {
    [images] = await db.query(
      'SELECT * FROM main_po_item_images WHERE main_po_item_id IN (?) ORDER BY sort_order, id', [itemIds]);
  }
  po.items = items.map(it => ({ ...it, images: images.filter(im => im.main_po_item_id === it.id) }));
  return po;
}

// ── LIST ─────────────────────────────────────────────────────────────────────
router.get('/main-pos', auth, adminOrPermission('main_po', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const { status } = req.query;
    const where = [];
    const params = [];
    if (status && status !== 'all') { where.push('mp.status=?'); params.push(status); }
    const [rows] = await db.query(
      `SELECT mp.id, mp.po_no, mp.project_name, mp.client_name, mp.pmc_name, mp.order_date, mp.proto_mode,
              mp.timelines, mp.status, mp.project_id, mp.created_at, mp.rejected_reason,
              p.project_id AS linked_project_code,
              cu.name AS created_by_name,
              (SELECT COUNT(*) FROM main_po_items i WHERE i.main_po_id = mp.id) AS item_count
       FROM main_pos mp
       LEFT JOIN projects p ON p.id = mp.project_id
       LEFT JOIN users cu ON cu.id = mp.created_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY mp.id DESC`, params);
    const [counts] = await db.query(
      "SELECT status, COUNT(*) AS c FROM main_pos GROUP BY status");
    res.json({ rows, counts });
  } catch (err) {
    console.error('Main PO list error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── DETAIL ───────────────────────────────────────────────────────────────────
// Next Proto Codes of the Settings series (preview only — saving assigns the real ones)
router.get('/main-pos/proto-preview', auth, adminOrPermission('main_po', 'read'), async (req, res) => {
  try {
    const db = await getPool();
    const count = Math.max(1, Math.min(200, parseInt(req.query.count, 10) || 1));
    res.json(await proto.previewCodes(db, count));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/main-pos/:id', auth, adminOrPermission('main_po', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const po = await loadPo(db, req.params.id);
    if (!po) return res.status(404).json({ message: 'Main PO not found' });
    res.json(po);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── CREATE (draft) ───────────────────────────────────────────────────────────
router.post('/main-pos', auth, adminOrPermission('main_po', 'write'), auditLog('CREATE', 'MainPO'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const err = validateHeader(req.body);
    if (err) return res.status(400).json({ message: err });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    for (const it of items) {
      if (!it.product_name || !String(it.product_name).trim())
        return res.status(400).json({ message: 'Every item row needs a Product Name' });
    }

    // Proto Code mode is chosen once, when the order is created
    const protoMode = proto.readMode(req.body.proto_mode);
    if (!protoMode) return res.status(400).json({ message: 'Choose Manual or Automatic Proto Code for this order' });

    const manual = readPoNo(req.body);
    if (manual.error) return res.status(400).json({ message: manual.error });
    if (manual.value && await poNoTaken(conn, manual.value))
      return res.status(400).json({ message: `Manufacturing Order No. "${manual.value}" is already used` });

    await conn.beginTransaction();
    const poNo = manual.value || await nextFreeAutoPoNo(conn);
    const b = req.body;
    const rows = items.map((it, i) => normalizeItem({ ...it, id: null }, i));
    await applyProtoCodes(conn, protoMode, rows);
    const [r] = await conn.query(
      `INSERT INTO main_pos (po_no, project_name, client_name, pmc_name, order_date, timelines, remarks, status, created_by, proto_mode)
       VALUES (?,?,?,?,?,?,?,'draft',?,?)`,
      [poNo, b.project_name.trim(), b.client_name || null, b.pmc_name || null,
       b.order_date || null, b.timelines || null, b.remarks || null, req.user.id, protoMode]);
    const poId = r.insertId;

    for (const it of rows) {
      await conn.query(`INSERT INTO main_po_items (${ITEM_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, itemVals(poId, it));
    }
    await conn.commit();
    res.json({ id: poId, po_no: poNo, message: 'Main PO saved as draft' });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    if (err.status) return res.status(err.status).json({ message: err.message });
    // Two people saving the same number at once: the unique key catches it
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: 'This Manufacturing Order No. is already used' });
    console.error('Main PO create error:', err.message);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── UPDATE (draft / rejected only; upsert rows so images survive) ────────────
router.put('/main-pos/:id', auth, adminOrPermission('main_po', 'edit'), auditLog('UPDATE', 'MainPO'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const err = validateHeader(req.body);
    if (err) return res.status(400).json({ message: err });

    await conn.beginTransaction();
    const [[po]] = await conn.query('SELECT * FROM main_pos WHERE id=? FOR UPDATE', [req.params.id]);
    if (!po) { await conn.rollback(); return res.status(404).json({ message: 'Main PO not found' }); }
    if (!['draft', 'rejected'].includes(po.status)) {
      await conn.rollback();
      return res.status(400).json({ message: `Cannot edit a ${po.status} Main PO. Approved/submitted POs are locked.` });
    }

    const b = req.body;
    const manual = readPoNo(b);
    if (manual.error) { await conn.rollback(); return res.status(400).json({ message: manual.error }); }
    const poNo = manual.value || po.po_no;
    if (poNo !== po.po_no && await poNoTaken(conn, poNo, po.id)) {
      await conn.rollback();
      return res.status(400).json({ message: `Manufacturing Order No. "${poNo}" is already used` });
    }
    await conn.query(
      `UPDATE main_pos SET po_no=?, project_name=?, client_name=?, pmc_name=?, order_date=?, timelines=?, remarks=?, updated_by=?
       WHERE id=?`,
      [poNo, b.project_name.trim(), b.client_name || null, b.pmc_name || null, b.order_date || null,
       b.timelines || null, b.remarks || null, req.user.id, po.id]);

    const items = Array.isArray(b.items) ? b.items : [];
    const [existing] = await conn.query('SELECT id, proto_code FROM main_po_items WHERE main_po_id=?', [po.id]);
    const keepIds = items.filter(i => i.id).map(i => Number(i.id));
    // The mode chosen at creation stays; it is never switched by an edit
    const rows = items.map((it, i) => normalizeItem(it, i));
    for (const it of rows) {
      if (!it.product_name) { await conn.rollback(); return res.status(400).json({ message: 'Every item row needs a Product Name' }); }
      if (it.id && !keepIds.includes(Number(it.id))) it.id = null;
      if (it.id && !existing.some(e => e.id === Number(it.id))) it.id = null;   // not a row of this order
    }
    await applyProtoCodes(conn, po.proto_mode, rows, new Map(existing.map(e => [e.id, e.proto_code])));
    const removeIds = existing.map(e => e.id).filter(id => !keepIds.includes(id));
    if (removeIds.length) {
      // image records cascade; delete Cloudinary assets best-effort
      const [imgs] = await conn.query('SELECT public_id FROM main_po_item_images WHERE main_po_item_id IN (?)', [removeIds]);
      await conn.query('DELETE FROM main_po_items WHERE id IN (?) AND main_po_id=?', [removeIds, po.id]);
      for (const im of imgs) { if (im.public_id) deleteFile(im.public_id).catch(() => {}); }
    }
    for (const it of rows) {
      if (it.id) {
        await conn.query(
          `UPDATE main_po_items SET s_no=?, area=?, proto_code=?, product_name=?, product_size=?, finishes_note=?,
             is_paint_finish=?, is_fabric_finish=?, is_metal_finish=?, size_length=?, size_width=?, size_thickness=?,
             qty=?, remark=?, sort_order=?, paint_qty=?, fabric_qty=? WHERE id=? AND main_po_id=?`,
          [it.s_no, it.area, it.proto_code, it.product_name, it.product_size, it.finishes_note,
           it.is_paint_finish, it.is_fabric_finish, it.is_metal_finish, it.size_length, it.size_width,
           it.size_thickness, it.qty, it.remark, it.sort_order, it.paint_qty, it.fabric_qty, it.id, po.id]);
      } else {
        await conn.query(`INSERT INTO main_po_items (${ITEM_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, itemVals(po.id, it));
      }
    }
    await conn.commit();
    res.json({ message: 'Main PO updated' });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    if (err.status) return res.status(err.status).json({ message: err.message });
    // Two people saving the same number at once: the unique key catches it
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: 'This Manufacturing Order No. is already used' });
    console.error('Main PO update error:', err.message);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── ADD ITEMS to an approved order (the customer ordered more) ──────────────
// Existing rows stay locked. New rows follow the order's Proto Code mode.
// transfer=true → the new rows also become items of the linked Project (only
// these rows; nothing else in the Project is touched). transfer=false → they
// stay on the order and can be transferred later.
router.post('/main-pos/:id/add-items', auth, adminOrPermission('main_po', 'edit'), auditLog('UPDATE', 'MainPO'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ message: 'Add at least one new item row' });
    for (const it of items) {
      if (!it.product_name || !String(it.product_name).trim())
        return res.status(400).json({ message: 'Every item row needs a Product Name' });
    }
    const transfer = req.body.transfer === true || req.body.transfer === 1 || req.body.transfer === '1';

    await conn.beginTransaction();
    const [[po]] = await conn.query('SELECT * FROM main_pos WHERE id=? FOR UPDATE', [req.params.id]);
    if (!po) { await conn.rollback(); return res.status(404).json({ message: 'Manufacturing Order not found' }); }
    if (po.status !== 'approved' || !po.project_id) {
      await conn.rollback();
      return res.status(400).json({ message: 'Only an approved Manufacturing Order with a Project can take extra items. Use Edit on a draft.' });
    }
    const [[project]] = await conn.query('SELECT id, project_id FROM projects WHERE id=?', [po.project_id]);
    if (!project) { await conn.rollback(); return res.status(400).json({ message: 'The linked Project no longer exists' }); }

    const [existing] = await conn.query('SELECT proto_code, sort_order FROM main_po_items WHERE main_po_id=?', [po.id]);
    const base = existing.reduce((m, e) => Math.max(m, Number(e.sort_order) + 1), existing.length);
    const rows = items.map((it, i) => normalizeItem({ ...it, id: null }, base + i));
    const [projItems] = await conn.query('SELECT proto_code FROM project_items WHERE project_id=?', [project.id]);
    await applyProtoCodes(conn, po.proto_mode, rows, new Map(), [...existing.map(e => e.proto_code), ...projItems.map(p => p.proto_code)]);

    const added = [];
    for (const it of rows) {
      const [r] = await conn.query(
        `INSERT INTO main_po_items (${ITEM_COLS}, added_after_approval) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, itemVals(po.id, it));
      it.id = r.insertId;
      added.push({ id: it.id, proto_code: it.proto_code, product_name: it.product_name });
    }
    let transferred = 0;
    if (transfer) {
      for (const it of rows) { await insertProjectItemFromMo(conn, project.id, it); transferred++; }
    }
    await conn.query('UPDATE main_pos SET updated_by=? WHERE id=?', [req.user.id, po.id]);
    await conn.commit();
    res.json({
      added, transferred, project_id: project.id, project_code: project.project_id,
      message: transferred
        ? `${transferred} new item(s) added to Project ${project.project_id}. Please complete chain setting and other required configurations.`
        : `${added.length} new item(s) saved on the Manufacturing Order (not added to the Project).`,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('Main PO add-items error:', err.message);
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// Transfer order rows that are not in the Project yet (e.g. saved earlier with "No")
router.post('/main-pos/:id/transfer-items', auth, adminOrPermission('main_po', 'edit'), auditLog('UPDATE', 'MainPO'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[po]] = await conn.query('SELECT * FROM main_pos WHERE id=? FOR UPDATE', [req.params.id]);
    if (!po) { await conn.rollback(); return res.status(404).json({ message: 'Manufacturing Order not found' }); }
    if (po.status !== 'approved' || !po.project_id) {
      await conn.rollback();
      return res.status(400).json({ message: 'This Manufacturing Order has no Project yet' });
    }
    const [[project]] = await conn.query('SELECT id, project_id FROM projects WHERE id=?', [po.project_id]);
    if (!project) { await conn.rollback(); return res.status(400).json({ message: 'The linked Project no longer exists' }); }
    const ids = (Array.isArray(req.body.item_ids) ? req.body.item_ids : []).map(Number).filter(Boolean);
    const [pending] = await conn.query(
      `SELECT * FROM main_po_items WHERE main_po_id=? AND project_item_id IS NULL ${ids.length ? 'AND id IN (?)' : ''}
       ORDER BY sort_order, id FOR UPDATE`, ids.length ? [po.id, ids] : [po.id]);
    if (!pending.length) { await conn.rollback(); return res.status(400).json({ message: 'No items left to transfer — they are already in the Project' }); }
    if (po.proto_mode === 'manual') {
      const [projItems] = await conn.query('SELECT proto_code FROM project_items WHERE project_id=?', [project.id]);
      proto.checkManualCodes(pending.map(p => p.proto_code), projItems.map(p => p.proto_code));
    }
    for (const it of pending) await insertProjectItemFromMo(conn, project.id, it);
    await conn.commit();
    res.json({
      transferred: pending.length, project_id: project.id, project_code: project.project_id,
      message: `${pending.length} item(s) added to Project ${project.project_id}. Please complete chain setting and other required configurations.`,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    if (err.status) return res.status(err.status).json({ message: err.message });
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// ── DELETE (draft only) ──────────────────────────────────────────────────────
router.delete('/main-pos/:id', auth, adminOrPermission('main_po', 'delete'), auditLog('DELETE', 'MainPO'), async (req, res) => {
  const db = await getPool();
  try {
    const [[po]] = await db.query('SELECT * FROM main_pos WHERE id=?', [req.params.id]);
    if (!po) return res.status(404).json({ message: 'Main PO not found' });
    if (po.status !== 'draft') return res.status(400).json({ message: 'Only draft Main POs can be deleted' });
    const [imgs] = await db.query(
      `SELECT im.public_id FROM main_po_item_images im
       JOIN main_po_items i ON i.id = im.main_po_item_id WHERE i.main_po_id=?`, [po.id]);
    await db.query('DELETE FROM main_pos WHERE id=?', [po.id]); // items + images cascade
    for (const im of imgs) { if (im.public_id) deleteFile(im.public_id).catch(() => {}); }
    res.json({ message: 'Main PO deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── SUBMIT → existing approval framework (mandatory, no admin bypass) ────────
router.post('/main-pos/:id/submit', auth, adminOrPermission('main_po', 'write'), auditLog('UPDATE', 'MainPO'), async (req, res) => {
  const db = await getPool();
  try {
    const [[po]] = await db.query('SELECT * FROM main_pos WHERE id=?', [req.params.id]);
    if (!po) return res.status(404).json({ message: 'Main PO not found' });
    if (req.user.role !== 'admin' && po.created_by !== req.user.id)
      return res.status(403).json({ message: 'Only the creator or an admin can submit this Main PO' });
    if (!['draft', 'rejected'].includes(po.status))
      return res.status(400).json({ message: `Main PO is already ${po.status}` });

    const [[{ c: itemCount }]] = await db.query('SELECT COUNT(*) AS c FROM main_po_items WHERE main_po_id=?', [po.id]);
    if (!itemCount) return res.status(400).json({ message: 'Add at least one item row before submitting' });

    const [[pending]] = await db.query(
      "SELECT id FROM approvals WHERE type='MAIN_PO' AND related_id=? AND status='PENDING' LIMIT 1", [po.id]);
    if (pending) return res.status(400).json({ message: 'This Main PO is already pending approval' });

    // Snapshot for the Approvals inbox display
    const snapshot = {
      po_no: po.po_no, project_name: po.project_name, client_name: po.client_name,
      pmc_name: po.pmc_name, order_date: po.order_date, item_count: itemCount,
    };
    await createApprovalRequest({ type: 'MAIN_PO', userId: req.user.id, requestData: snapshot, relatedId: po.id });
    await db.query(
      "UPDATE main_pos SET status='submitted', submitted_by=?, submitted_at=NOW(), rejected_by=NULL, rejected_at=NULL, rejected_reason=NULL WHERE id=?",
      [req.user.id, po.id]);
    res.json({ message: 'Main PO submitted for approval. It will appear in the Approvals inbox.' });
  } catch (err) {
    console.error('Main PO submit error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── ITEM IMAGES ──────────────────────────────────────────────────────────────
router.post('/main-pos/:id/items/:itemId/images', auth, adminOrPermission('main_po', 'write'),
  moReferenceUpload.array('images', 10), async (req, res) => {
    const db = await getPool();
    try {
      const [[po]] = await db.query('SELECT status FROM main_pos WHERE id=?', [req.params.id]);
      if (!po) return res.status(404).json({ message: 'Main PO not found' });
      const [[item]] = await db.query('SELECT id, added_after_approval FROM main_po_items WHERE id=? AND main_po_id=?',
        [req.params.itemId, req.params.id]);
      if (!item) return res.status(404).json({ message: 'Item row not found on this Main PO' });
      // Approved orders are locked, except rows added after approval
      if (!['draft', 'rejected'].includes(po.status) && !(po.status === 'approved' && item.added_after_approval))
        return res.status(400).json({ message: `Cannot add images to a ${po.status} Main PO` });
      if (!req.files || !req.files.length) return res.status(400).json({ message: 'No images received' });

      const saved = [];
      for (let i = 0; i < req.files.length; i++) {
        const f = req.files[i];
        const [r] = await db.query(
          `INSERT INTO main_po_item_images (main_po_item_id, image_path, public_id, caption, sort_order, uploaded_by)
           VALUES (?,?,?,?,?,?)`,
          [item.id, f.path, f.filename || f.public_id || null, req.body.caption || null, i, req.user.id]);
        saved.push({ id: r.insertId, image_path: f.path });
      }
      res.json({ message: `${saved.length} image(s) uploaded`, images: saved });
    } catch (err) {
      console.error('Main PO image upload error:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

router.delete('/main-pos/item-images/:imageId', auth, adminOrPermission('main_po', 'edit'), async (req, res) => {
  const db = await getPool();
  try {
    const [[img]] = await db.query(
      `SELECT im.*, mp.status, i.added_after_approval FROM main_po_item_images im
       JOIN main_po_items i ON i.id = im.main_po_item_id
       JOIN main_pos mp ON mp.id = i.main_po_id
       WHERE im.id=?`, [req.params.imageId]);
    if (!img) return res.status(404).json({ message: 'Image not found' });
    if (!['draft', 'rejected'].includes(img.status) && !(img.status === 'approved' && img.added_after_approval))
      return res.status(400).json({ message: `Cannot delete images from a ${img.status} Main PO` });
    await db.query('DELETE FROM main_po_item_images WHERE id=?', [img.id]);
    if (img.public_id) deleteFile(img.public_id).catch(() => {});
    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
