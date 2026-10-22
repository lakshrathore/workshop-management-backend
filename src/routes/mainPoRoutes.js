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

function normalizeItem(it, idx) {
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
    qty: Number(it.qty) > 0 ? Number(it.qty) : 1,
    remark: it.remark || null,
    sort_order: idx,
  };
}

async function loadPo(db, id) {
  const [[po]] = await db.query(
    `SELECT mp.*, p.project_id AS linked_project_code, p.name AS linked_project_name,
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
      `SELECT mp.id, mp.po_no, mp.project_name, mp.client_name, mp.pmc_name, mp.order_date,
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

    const manual = readPoNo(req.body);
    if (manual.error) return res.status(400).json({ message: manual.error });
    if (manual.value && await poNoTaken(conn, manual.value))
      return res.status(400).json({ message: `Manufacturing Order No. "${manual.value}" is already used` });

    await conn.beginTransaction();
    const poNo = manual.value || await nextFreeAutoPoNo(conn);
    const b = req.body;
    const [r] = await conn.query(
      `INSERT INTO main_pos (po_no, project_name, client_name, pmc_name, order_date, timelines, remarks, status, created_by)
       VALUES (?,?,?,?,?,?,?,'draft',?)`,
      [poNo, b.project_name.trim(), b.client_name || null, b.pmc_name || null,
       b.order_date || null, b.timelines || null, b.remarks || null, req.user.id]);
    const poId = r.insertId;

    for (let i = 0; i < items.length; i++) {
      const it = normalizeItem(items[i], i);
      await conn.query(
        `INSERT INTO main_po_items (main_po_id, s_no, area, proto_code, product_name, product_size, finishes_note,
           is_paint_finish, is_fabric_finish, is_metal_finish, size_length, size_width, size_thickness, qty, remark, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [poId, it.s_no, it.area, it.proto_code, it.product_name, it.product_size, it.finishes_note,
         it.is_paint_finish, it.is_fabric_finish, it.is_metal_finish,
         it.size_length, it.size_width, it.size_thickness, it.qty, it.remark, it.sort_order]);
    }
    await conn.commit();
    res.json({ id: poId, po_no: poNo, message: 'Main PO saved as draft' });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
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
    const [existing] = await conn.query('SELECT id FROM main_po_items WHERE main_po_id=?', [po.id]);
    const keepIds = items.filter(i => i.id).map(i => Number(i.id));
    const removeIds = existing.map(e => e.id).filter(id => !keepIds.includes(id));
    if (removeIds.length) {
      // image records cascade; delete Cloudinary assets best-effort
      const [imgs] = await conn.query('SELECT public_id FROM main_po_item_images WHERE main_po_item_id IN (?)', [removeIds]);
      await conn.query('DELETE FROM main_po_items WHERE id IN (?) AND main_po_id=?', [removeIds, po.id]);
      for (const im of imgs) { if (im.public_id) deleteFile(im.public_id).catch(() => {}); }
    }
    for (let i = 0; i < items.length; i++) {
      const it = normalizeItem(items[i], i);
      if (!it.product_name) { await conn.rollback(); return res.status(400).json({ message: 'Every item row needs a Product Name' }); }
      if (it.id && keepIds.includes(Number(it.id))) {
        await conn.query(
          `UPDATE main_po_items SET s_no=?, area=?, proto_code=?, product_name=?, product_size=?, finishes_note=?,
             is_paint_finish=?, is_fabric_finish=?, is_metal_finish=?, size_length=?, size_width=?, size_thickness=?,
             qty=?, remark=?, sort_order=? WHERE id=? AND main_po_id=?`,
          [it.s_no, it.area, it.proto_code, it.product_name, it.product_size, it.finishes_note,
           it.is_paint_finish, it.is_fabric_finish, it.is_metal_finish, it.size_length, it.size_width,
           it.size_thickness, it.qty, it.remark, it.sort_order, it.id, po.id]);
      } else {
        await conn.query(
          `INSERT INTO main_po_items (main_po_id, s_no, area, proto_code, product_name, product_size, finishes_note,
             is_paint_finish, is_fabric_finish, is_metal_finish, size_length, size_width, size_thickness, qty, remark, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [po.id, it.s_no, it.area, it.proto_code, it.product_name, it.product_size, it.finishes_note,
           it.is_paint_finish, it.is_fabric_finish, it.is_metal_finish,
           it.size_length, it.size_width, it.size_thickness, it.qty, it.remark, it.sort_order]);
      }
    }
    await conn.commit();
    res.json({ message: 'Main PO updated' });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    // Two people saving the same number at once: the unique key catches it
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: 'This Manufacturing Order No. is already used' });
    console.error('Main PO update error:', err.message);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
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
      if (!['draft', 'rejected'].includes(po.status))
        return res.status(400).json({ message: `Cannot add images to a ${po.status} Main PO` });
      const [[item]] = await db.query('SELECT id FROM main_po_items WHERE id=? AND main_po_id=?',
        [req.params.itemId, req.params.id]);
      if (!item) return res.status(404).json({ message: 'Item row not found on this Main PO' });
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
      `SELECT im.*, mp.status FROM main_po_item_images im
       JOIN main_po_items i ON i.id = im.main_po_item_id
       JOIN main_pos mp ON mp.id = i.main_po_id
       WHERE im.id=?`, [req.params.imageId]);
    if (!img) return res.status(404).json({ message: 'Image not found' });
    if (!['draft', 'rejected'].includes(img.status))
      return res.status(400).json({ message: `Cannot delete images from a ${img.status} Main PO` });
    await db.query('DELETE FROM main_po_item_images WHERE id=?', [img.id]);
    if (img.public_id) deleteFile(img.public_id).catch(() => {});
    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
