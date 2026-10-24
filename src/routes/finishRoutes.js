// ── FINISH MODULE Routes (NEW FILE — Phase 2: Paint / Fabric / Metal) ────────
// Mounted in server.js at /api. routes/index.js is NOT modified.
//
// Model: one finish sheet per (main_po, finish_type). Rows auto-populate from
// main_po_items where the matching flag = YES. Base product data is read LIVE
// from the Main PO item (single source of truth, never copied); only
// finish-specific fields are stored in finish_entries.
//
// No approval workflow (per client spec): Submit = finalize & lock; admin can
// Reopen. Permission key 'finish':
//   read = View / Print · write = Add / Save / Submit · edit = Edit / delete images

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOnly, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');
const { moReferenceUpload, deleteFile } = require('../services/cloudinaryStorage');

const FINISH_TYPES = ['paint', 'fabric', 'metal'];
const FLAG_COL = { paint: 'is_paint_finish', fabric: 'is_fabric_finish', metal: 'is_metal_finish' };
// Qty of a row that needs this finish (Paint / Fabric can be part of the row's Qty)
const FINISH_QTY_SQL = { paint: 'COALESCE(paint_qty, qty)', fabric: 'COALESCE(fabric_qty, qty)', metal: 'qty' };
const MATERIAL_TYPES = ['sheet', 'pipe', 'pipe_material', 'other'];

function validType(req, res, next) {
  if (!FINISH_TYPES.includes(req.params.type)) {
    return res.status(400).json({ message: `Invalid finish type. Use: ${FINISH_TYPES.join(', ')}` });
  }
  next();
}

async function getSheet(db, mainPoId, type) {
  const [[sheet]] = await db.query(
    'SELECT * FROM finish_sheets WHERE main_po_id=? AND finish_type=?', [mainPoId, type]);
  return sheet || null;
}

// Full sheet payload: PO header + flagged items joined with entries + images
async function loadSheetPayload(db, mainPoId, type) {
  const [[po]] = await db.query(
    `SELECT mp.id, mp.po_no, mp.project_name, mp.client_name, mp.pmc_name, mp.order_date,
            mp.timelines, mp.status AS po_status, p.project_id AS linked_project_code
     FROM main_pos mp LEFT JOIN projects p ON p.id = mp.project_id WHERE mp.id=?`, [mainPoId]);
  if (!po) return null;

  const sheet = await getSheet(db, mainPoId, type);
  const [items] = await db.query(
    `SELECT id, s_no, area, proto_code, product_name, product_size, qty, ${FINISH_QTY_SQL[type]} AS finish_qty,
            size_length, size_width, size_thickness, finishes_note
     FROM main_po_items WHERE main_po_id=? AND ${FLAG_COL[type]}=1 ORDER BY sort_order, id`, [mainPoId]);

  let entries = [], entryImages = [], refImages = [];
  if (sheet) {
    [entries] = await db.query('SELECT * FROM finish_entries WHERE sheet_id=?', [sheet.id]);
    const entryIds = entries.map(e => e.id);
    if (entryIds.length) {
      [entryImages] = await db.query(
        'SELECT * FROM finish_entry_images WHERE entry_id IN (?) ORDER BY sort_order, id', [entryIds]);
    }
  }
  const itemIds = items.map(i => i.id);
  if (itemIds.length) {
    [refImages] = await db.query(
      'SELECT * FROM main_po_item_images WHERE main_po_item_id IN (?) ORDER BY sort_order, id', [itemIds]);
  }

  // Each item: `entry` = the qty WITH this finish; `rest_entry` = the rest WITHOUT it
  // (only when Paint / Fabric covers part of the item's Qty).
  const shape = (entry, qty) => entry ? {
    ...entry,
    images: entryImages.filter(im => im.entry_id === entry.id && im.image_type === 'finish'),
    sample_images: entryImages.filter(im => im.entry_id === entry.id && im.image_type === 'sample'),
    // Fabric total is authoritative server-side: that part's qty × per-item qty
    total_qty: type === 'fabric'
      ? Number(((Number(qty) || 0) * (Number(entry.per_item_fabric_qty) || 0)).toFixed(2))
      : null,
  } : null;
  const rows = items.map(it => {
    const restQty = type === 'metal' ? 0 : Math.round(((Number(it.qty) || 0) - (Number(it.finish_qty) || 0)) * 100) / 100;
    const find = part => entries.find(e => e.main_po_item_id === it.id && (e.part || 'with') === part) || null;
    return {
      item: { ...it, rest_qty: restQty > 0 ? restQty : 0, ref_images: refImages.filter(r => r.main_po_item_id === it.id) },
      entry: shape(find('with'), it.finish_qty),
      rest_entry: restQty > 0 ? shape(find('without'), restQty) : null,
    };
  });

  return {
    po,
    finish_type: type,
    sheet: sheet || { status: 'draft', not_created: true },
    rows,
  };
}

// ── LIST: Main POs that have at least one item flagged for each type ────────
router.get('/finish-sheets', auth, adminOrPermission('finish', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const { type } = req.query;
    if (type && !FINISH_TYPES.includes(type)) return res.status(400).json({ message: 'Invalid type' });
    const results = {};
    for (const t of (type ? [type] : FINISH_TYPES)) {
      const [rows] = await db.query(
        `SELECT mp.id AS main_po_id, mp.po_no, mp.project_name, mp.client_name, mp.status AS po_status,
                p.project_id AS linked_project_code,
                COUNT(i.id) AS flagged_items,
                SUM(${FINISH_QTY_SQL[t].replace(/(paint_qty|fabric_qty|qty)/g, 'i.$1')}) AS finish_qty,
                SUM(i.qty) AS total_qty,
                fs.id AS sheet_id, fs.status AS sheet_status, fs.submitted_at,
                (SELECT COUNT(DISTINCT fe.main_po_item_id) FROM finish_entries fe WHERE fe.sheet_id = fs.id) AS filled_entries
         FROM main_pos mp
         JOIN main_po_items i ON i.main_po_id = mp.id AND i.${FLAG_COL[t]} = 1
         LEFT JOIN projects p ON p.id = mp.project_id
         LEFT JOIN finish_sheets fs ON fs.main_po_id = mp.id AND fs.finish_type = ?
         GROUP BY mp.id, fs.id
         ORDER BY mp.id DESC`, [t]);
      results[t] = rows;
    }
    res.json(results);
  } catch (err) {
    console.error('Finish list error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── GET one sheet ────────────────────────────────────────────────────────────
router.get('/main-pos/:id/finish/:type', auth, adminOrPermission('finish', 'read'), validType, async (req, res) => {
  const db = await getPool();
  try {
    const payload = await loadSheetPayload(db, req.params.id, req.params.type);
    if (!payload) return res.status(404).json({ message: 'Main PO not found' });
    res.json(payload);
  } catch (err) {
    console.error('Finish get error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── SAVE (upsert sheet + entries) ────────────────────────────────────────────
router.put('/main-pos/:id/finish/:type', auth, adminOrPermission('finish', 'write'), validType,
  auditLog('UPDATE', 'FinishSheet'), async (req, res) => {
    const pool = await getPool();
    const conn = await pool.getConnection();
    const { id: mainPoId, type } = req.params;
    try {
      await conn.beginTransaction();
      const [[po]] = await conn.query('SELECT id FROM main_pos WHERE id=?', [mainPoId]);
      if (!po) { await conn.rollback(); return res.status(404).json({ message: 'Main PO not found' }); }

      let [[sheet]] = await conn.query(
        'SELECT * FROM finish_sheets WHERE main_po_id=? AND finish_type=? FOR UPDATE', [mainPoId, type]);
      if (sheet && sheet.status === 'submitted') {
        await conn.rollback();
        return res.status(400).json({ message: 'This finish sheet is submitted and locked. Ask an admin to reopen it.' });
      }
      if (!sheet) {
        const [r] = await conn.query(
          `INSERT INTO finish_sheets (main_po_id, finish_type, status, remarks, created_by)
           VALUES (?,?,'draft',?,?)`,
          [mainPoId, type, req.body.remarks || null, req.user.id]);
        sheet = { id: r.insertId };
      } else {
        await conn.query('UPDATE finish_sheets SET remarks=?, updated_by=? WHERE id=?',
          [req.body.remarks ?? sheet.remarks, req.user.id, sheet.id]);
      }

      const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
      for (const e of entries) {
        const itemId = Number(e.main_po_item_id);
        if (!itemId) continue;
        // Entry must map to an item on THIS PO with the matching flag
        const [[item]] = await conn.query(
          `SELECT id, qty AS item_qty, ${FINISH_QTY_SQL[type]} AS qty FROM main_po_items WHERE id=? AND main_po_id=? AND ${FLAG_COL[type]}=1`,
          [itemId, mainPoId]);
        if (!item) { await conn.rollback(); return res.status(400).json({ message: `Item ${itemId} is not a ${type}-finish item of this Main PO` }); }
        // 'with' = qty with this finish, 'without' = the rest of the item's Qty
        const part = e.part === 'without' ? 'without' : 'with';
        if (part === 'without') {
          if (type === 'metal') continue;
          item.qty = Math.round(((Number(item.item_qty) || 0) - (Number(item.qty) || 0)) * 100) / 100;
          if (!(item.qty > 0)) continue;          // finish now covers the whole Qty — nothing without it
        }

        const common = { remark: e.remark || null };
        let fields = {}, err = null;
        if (type === 'paint') {
          fields = { paint_finish_name: e.paint_finish_name || null };
        } else if (type === 'fabric') {
          const per = e.per_item_fabric_qty === '' || e.per_item_fabric_qty == null ? null : Number(e.per_item_fabric_qty);
          if (per != null && (isNaN(per) || per < 0)) err = 'Per-item fabric qty must be a positive number';
          fields = {
            fabric_name: e.fabric_name || null,
            per_item_fabric_qty: per,
            total_qty: per != null ? Number(((Number(item.qty) || 0) * per).toFixed(2)) : null, // server-computed
            fabric_unit: e.fabric_unit || 'MTR',
          };
        } else { // metal
          const mt = e.material_type || null;
          if (mt && !MATERIAL_TYPES.includes(mt)) err = 'Invalid material type';
          fields = {
            material_type: mt,
            material_other: e.material_other || null,
            metal_finish_details: e.metal_finish_details || null,
            size_length: e.size_length || null,
            size_width: e.size_width || null,
            size_thickness: e.size_thickness || null,
            size_other: e.size_other || null,
          };
        }
        if (err) { await conn.rollback(); return res.status(400).json({ message: err }); }

        const data = { ...fields, ...common };
        const cols = Object.keys(data);
        const vals = Object.values(data);
        const [[found]] = await conn.query(
          "SELECT id FROM finish_entries WHERE sheet_id=? AND main_po_item_id=? AND COALESCE(part,'with')=? LIMIT 1",
          [sheet.id, itemId, part]);
        if (found) {
          await conn.query(`UPDATE finish_entries SET ${cols.map(c => `${c}=?`).join(',')} WHERE id=?`, [...vals, found.id]);
        } else {
          await conn.query(
            `INSERT INTO finish_entries (sheet_id, main_po_item_id, part, ${cols.join(',')})
             VALUES (?,?,?,${cols.map(() => '?').join(',')})`,
            [sheet.id, itemId, part, ...vals]);
        }
      }

      await conn.commit();
      res.json({ message: 'Finish sheet saved' });
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* noop */ }
      console.error('Finish save error:', err.message);
      res.status(500).json({ message: err.message });
    } finally {
      conn.release();
    }
  });

// ── SUBMIT (finalize & lock — no approval workflow for Finish) ───────────────
router.post('/main-pos/:id/finish/:type/submit', auth, adminOrPermission('finish', 'write'), validType,
  auditLog('UPDATE', 'FinishSheet'), async (req, res) => {
    const db = await getPool();
    try {
      const sheet = await getSheet(db, req.params.id, req.params.type);
      if (!sheet) return res.status(400).json({ message: 'Save the finish sheet before submitting' });
      if (sheet.status === 'submitted') return res.status(400).json({ message: 'Already submitted' });
      await db.query(
        "UPDATE finish_sheets SET status='submitted', submitted_by=?, submitted_at=NOW() WHERE id=?",
        [req.user.id, sheet.id]);
      res.json({ message: 'Finish sheet submitted and locked' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

// ── REOPEN (admin only) ──────────────────────────────────────────────────────
router.post('/main-pos/:id/finish/:type/reopen', auth, adminOnly, validType,
  auditLog('UPDATE', 'FinishSheet'), async (req, res) => {
    const db = await getPool();
    try {
      const sheet = await getSheet(db, req.params.id, req.params.type);
      if (!sheet) return res.status(404).json({ message: 'Finish sheet not found' });
      if (sheet.status !== 'submitted') return res.status(400).json({ message: 'Sheet is not submitted' });
      await db.query(
        "UPDATE finish_sheets SET status='draft', updated_by=? WHERE id=?", [req.user.id, sheet.id]);
      res.json({ message: 'Finish sheet reopened for editing' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

// ── ENTRY IMAGES (finish images + fabric sample images) ──────────────────────
// Entry must exist first (save the sheet), mirroring the Main PO image flow.
router.post('/finish-entries/:entryId/images', auth, adminOrPermission('finish', 'write'),
  moReferenceUpload.array('images', 10), async (req, res) => {
    const db = await getPool();
    try {
      const [[entry]] = await db.query(
        `SELECT fe.id, fs.status FROM finish_entries fe
         JOIN finish_sheets fs ON fs.id = fe.sheet_id WHERE fe.id=?`, [req.params.entryId]);
      if (!entry) return res.status(404).json({ message: 'Finish entry not found. Save the sheet first.' });
      if (entry.status === 'submitted')
        return res.status(400).json({ message: 'Sheet is submitted and locked' });
      const imageType = req.body.image_type === 'sample' ? 'sample' : 'finish';
      if (!req.files || !req.files.length) return res.status(400).json({ message: 'No images received' });
      const saved = [];
      for (let i = 0; i < req.files.length; i++) {
        const f = req.files[i];
        const [r] = await db.query(
          `INSERT INTO finish_entry_images (entry_id, image_type, image_path, public_id, caption, sort_order, uploaded_by)
           VALUES (?,?,?,?,?,?,?)`,
          [entry.id, imageType, f.path, f.filename || f.public_id || null, req.body.caption || null, i, req.user.id]);
        saved.push({ id: r.insertId, image_path: f.path, image_type: imageType });
      }
      res.json({ message: `${saved.length} image(s) uploaded`, images: saved });
    } catch (err) {
      console.error('Finish image upload error:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

router.delete('/finish-entry-images/:imageId', auth, adminOrPermission('finish', 'edit'), async (req, res) => {
  const db = await getPool();
  try {
    const [[img]] = await db.query(
      `SELECT im.*, fs.status FROM finish_entry_images im
       JOIN finish_entries fe ON fe.id = im.entry_id
       JOIN finish_sheets fs ON fs.id = fe.sheet_id
       WHERE im.id=?`, [req.params.imageId]);
    if (!img) return res.status(404).json({ message: 'Image not found' });
    if (img.status === 'submitted') return res.status(400).json({ message: 'Sheet is submitted and locked' });
    await db.query('DELETE FROM finish_entry_images WHERE id=?', [img.id]);
    if (img.public_id) deleteFile(img.public_id).catch(() => {});
    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
