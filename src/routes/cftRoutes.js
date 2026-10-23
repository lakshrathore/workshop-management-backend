// ── CFT (Solid Wood Issue Sheet) Routes (NEW FILE — Phase 6) ─────────────────
// Mounted in server.js at /api. routes/index.js is NOT modified.
//
// Formula (FIXED, per Q7): CFT = L × W × T × 0.00000003528  (per piece) × qty
// Offcut (FIXED 30%, NOT configurable per Q7):
//   Total Required CFT = Total Demand CFT + 30% offcut
//   Difference         = Total Issue CFT − Total Required CFT
//   Net Difference     = Difference − Total Return CFT
//   Positive = excess ; Negative = shortage  (labelled in the response)
// No final values are hard-coded — everything is computed from row inputs.
//
// No approval workflow (not in the client's approval list). Submit = finalize
// & lock; admin can Reopen. Permission key 'cft':
//   read = View/Print · write = Add/Edit/Submit · delete = Delete draft
//   reopen = admin only.

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOnly, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');
const { imgUpload } = require('../services/cloudinaryStorage');
const { createApprovalRequest } = require('../services/approvalService');

const CFT_CONSTANT = 0.00000003528; // fixed conversion constant (mm³ → CFT)
const OFFCUT_PERCENT = 30;          // fixed, not configurable
const ROW_TYPES = ['demand', 'issue', 'return'];
const r4 = n => Math.round((Number(n) || 0) * 10000) / 10000; // 4-dp rounding

function rowCft(row) {
  const L = Number(row.length) || 0, W = Number(row.width) || 0, T = Number(row.thickness) || 0;
  const qty = Number(row.qty) || 0;
  const gross = L * W * T * CFT_CONSTANT;      // per piece
  return { gross_cft: r4(gross), net_cft: r4(gross * qty) };
}

// Compute all totals from stored rows (never hard-coded)
function computeTotals(rows) {
  const sum = t => rows.filter(r => r.row_type === t).reduce((a, r) => a + (Number(r.net_cft) || 0), 0);
  const demand = r4(sum('demand'));
  const issue = r4(sum('issue'));
  const ret = r4(sum('return'));
  const offcut = r4(demand * OFFCUT_PERCENT / 100);
  const required = r4(demand + offcut);
  const difference = r4(issue - required);
  const netDifference = r4(difference - ret);
  return {
    total_demand_cft: demand, offcut_cft: offcut, total_required_cft: required,
    total_issue_cft: issue, total_return_cft: ret,
    difference, net_difference: netDifference,
    net_label: netDifference > 0 ? 'excess' : netDifference < 0 ? 'shortage' : 'balanced',
  };
}

async function generateSheetNo(db) {
  let prefix = 'CFT';
  try {
    const [[s]] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='cft_prefix'");
    if (s?.setting_value) prefix = s.setting_value;
  } catch (e) { /* default */ }
  const year = new Date().getFullYear();
  const [last] = await db.query('SELECT sheet_no FROM cft_sheets ORDER BY id DESC LIMIT 1');
  let next = 1;
  if (last.length) { const m = last[0].sheet_no?.match(/(\d+)$/); if (m) next = parseInt(m[1]) + 1; }
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

async function loadSheet(db, id) {
  const [[s]] = await db.query(
    `SELECT cs.*, p.project_id AS project_code, p.name AS project_name,
            pi.item_name, pi.proto_code AS item_proto_code,
            cu.name AS created_by_name, su.name AS submitted_by_name, au.name AS approved_by_name
     FROM cft_sheets cs
     LEFT JOIN users au ON au.id = cs.approved_by
     LEFT JOIN projects p ON p.id = cs.project_id
     LEFT JOIN project_items pi ON pi.id = cs.project_item_id
     LEFT JOIN users cu ON cu.id = cs.created_by
     LEFT JOIN users su ON su.id = cs.submitted_by
     WHERE cs.id=?`, [id]);
  if (!s) return null;
  const [rows] = await db.query('SELECT * FROM cft_rows WHERE sheet_id=? ORDER BY row_type, sort_order, id', [id]);
  s.rows = rows;
  s.totals = computeTotals(rows);
  s.cutting_list_photos = parsePhotos(s.cutting_list_photos);
  const [workers] = await db.query(
    `SELECT w.worker_id, u.name AS worker_name, u.username, w.assigned_at, ab.name AS assigned_by_name,
            w.entered_in_tally, w.stock_journal_no, w.other_details, w.details_updated_at
       FROM cft_sheet_workers w
       JOIN users u ON u.id = w.worker_id
       LEFT JOIN users ab ON ab.id = w.assigned_by
      WHERE w.sheet_id=? ORDER BY u.name`, [id]);
  s.assigned_workers = workers;
  return s;
}

// Only drafts can be changed; everything after "Send for Approval" is locked
const isLocked = s => s.status !== 'draft';
const LOCK_MSG = {
  pending: 'This sheet is waiting for approval and is locked.',
  approved: 'This sheet is approved and locked. An admin can reopen it.',
  submitted: 'Sheet is submitted and locked. Ask an admin to reopen it.',
};

// Cutting list photos are stored as a JSON array of image URLs
const MAX_PHOTOS = 20;
function parsePhotos(v) {
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter(u => typeof u === 'string' && u) : []; }
  catch (e) { return []; }
}
// A submitted sheet is locked; only an admin can still change its photos
async function photoSheet(db, req, res) {
  const [[s]] = await db.query('SELECT id, status, cutting_list_photos FROM cft_sheets WHERE id=?', [req.params.id]);
  if (!s) { res.status(404).json({ message: 'CFT sheet not found' }); return null; }
  if (isLocked(s) && req.user.role !== 'admin') {
    res.status(400).json({ message: LOCK_MSG[s.status] || 'This sheet is locked.' }); return null;
  }
  return s;
}

// ══ LIST ═════════════════════════════════════════════════════════════════════
router.get('/cft-sheets', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const where = [], params = [];
    if (req.query.status && req.query.status !== 'all') { where.push('cs.status=?'); params.push(req.query.status); }
    if (req.query.project_id) { where.push('cs.project_id=?'); params.push(req.query.project_id); }
    const [rows] = await db.query(
      `SELECT cs.id, cs.sheet_no, cs.status, cs.wood_type, cs.created_at, cs.rejected_reason,
              (SELECT COUNT(*) FROM cft_sheet_workers w WHERE w.sheet_id = cs.id) AS assigned_count,
              cs.total_demand_cft, cs.total_issue_cft, cs.net_difference,
              p.project_id AS project_code, p.name AS project_name, pi.item_name, cu.name AS created_by_name
       FROM cft_sheets cs
       LEFT JOIN projects p ON p.id = cs.project_id
       LEFT JOIN project_items pi ON pi.id = cs.project_item_id
       LEFT JOIN users cu ON cu.id = cs.created_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY cs.id DESC`, params);
    const [counts] = await db.query('SELECT status, COUNT(*) c FROM cft_sheets GROUP BY status');
    res.json({ rows, counts });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/cft-sheets/:id', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const s = await loadSheet(db, req.params.id);
    if (!s) return res.status(404).json({ message: 'CFT sheet not found' });
    res.json(s);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ REPORT: status, approvals, Tally entries, who created / updated ═══════════
// ?from=&to= (sheet created) &project_id= &status=draft|pending|approved|rejected|submitted
// &tally=entered|not_entered|pending|not_assigned &worker_id= &q=
router.get('/cft-report', auth, adminOrPermission('cft', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const q = req.query;
    const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const where = [], args = [];
    if (date(q.from)) { where.push('DATE(cs.created_at) >= ?'); args.push(date(q.from)); }
    if (date(q.to)) { where.push('DATE(cs.created_at) <= ?'); args.push(date(q.to)); }
    if (parseInt(q.project_id, 10)) { where.push('cs.project_id = ?'); args.push(parseInt(q.project_id, 10)); }
    const [sheets] = await db.query(
      `SELECT cs.id, cs.sheet_no, cs.status, cs.wood_type, cs.remarks, cs.created_at, cs.updated_at,
              cs.submitted_at, cs.approved_at, cs.rejected_at, cs.rejected_reason,
              cs.total_demand_cft, cs.total_issue_cft, cs.total_return_cft, cs.net_difference,
              p.id AS project_id, p.name AS project_name, p.project_id AS project_code, pi.item_name,
              cu.name AS created_by_name, uu.name AS updated_by_name, su.name AS submitted_by_name, au.name AS approved_by_name
         FROM cft_sheets cs
         LEFT JOIN projects p ON p.id = cs.project_id
         LEFT JOIN project_items pi ON pi.id = cs.project_item_id
         LEFT JOIN users cu ON cu.id = cs.created_by
         LEFT JOIN users uu ON uu.id = cs.updated_by
         LEFT JOIN users su ON su.id = cs.submitted_by
         LEFT JOIN users au ON au.id = cs.approved_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY cs.id DESC`, args);
    const ids = sheets.map(s => s.id);
    let workers = [], decisions = [];
    if (ids.length) {
      [workers] = await db.query(
        `SELECT w.sheet_id, w.worker_id, u.name AS worker_name, w.assigned_at, ab.name AS assigned_by_name,
                w.entered_in_tally, w.stock_journal_no, w.other_details, w.details_updated_at
           FROM cft_sheet_workers w JOIN users u ON u.id = w.worker_id
           LEFT JOIN users ab ON ab.id = w.assigned_by
          WHERE w.sheet_id IN (?) ORDER BY u.name`, [ids]);
      [decisions] = await db.query(
        `SELECT related_id, status, COUNT(*) AS c FROM approvals
          WHERE type='CFT' AND related_id IN (?) GROUP BY related_id, status`, [ids]);
    }
    const tallyOf = list => {
      if (!list.length) return 'not_assigned';
      if (list.some(w => w.entered_in_tally === 'yes')) return 'entered';
      if (list.every(w => w.entered_in_tally === 'no')) return 'not_entered';
      return 'pending';
    };
    let rows = sheets.map(s => {
      const list = workers.filter(w => w.sheet_id === s.id);
      const count = st => Number((decisions.find(d => d.related_id === s.id && d.status === st) || {}).c || 0);
      return {
        ...s,
        // A draft carrying a reject reason = rejected and waiting for corrections
        report_status: s.status === 'draft' && s.rejected_reason ? 'rejected' : s.status,
        times_sent: count('APPROVED') + count('REJECTED') + count('PENDING'),
        times_rejected: count('REJECTED'),
        workers: list,
        tally_status: s.status === 'approved' || list.length ? tallyOf(list) : 'not_assigned',
        stock_journal_nos: [...new Set(list.map(w => w.stock_journal_no).filter(Boolean))],
      };
    });
    if (q.status) rows = rows.filter(r => r.report_status === q.status);
    if (q.tally) rows = rows.filter(r => r.tally_status === q.tally);
    if (parseInt(q.worker_id, 10)) rows = rows.filter(r => r.workers.some(w => w.worker_id === parseInt(q.worker_id, 10)));
    const words = String(q.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      rows = rows.filter(r => {
        const hay = [r.sheet_no, r.project_name, r.project_code, r.item_name, r.wood_type, r.created_by_name, r.updated_by_name,
          r.approved_by_name, r.rejected_reason, ...r.workers.flatMap(w => [w.worker_name, w.stock_journal_no, w.other_details])].join(' ').toLowerCase();
        return words.every(w => hay.includes(w));
      });
    }
    const n = f => rows.filter(f).length;
    res.json({
      rows,
      summary: {
        total: rows.length,
        draft: n(r => r.report_status === 'draft'),
        pending: n(r => r.report_status === 'pending'),
        approved: n(r => r.report_status === 'approved'),
        rejected: n(r => r.report_status === 'rejected'),
        submitted_old: n(r => r.report_status === 'submitted'),
        rejections_total: rows.reduce((a, r) => a + r.times_rejected, 0),
        tally_entered: n(r => r.tally_status === 'entered'),
        tally_not_entered: n(r => r.tally_status === 'not_entered'),
        tally_pending: n(r => r.tally_status === 'pending'),
        approved_not_assigned: n(r => r.status === 'approved' && !r.workers.length),
        worker_entries: rows.reduce((a, r) => a + r.workers.filter(w => w.entered_in_tally).length, 0),
      },
      workers: [...new Map(workers.map(w => [w.worker_id, { id: w.worker_id, name: w.worker_name }])).values()],
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ CREATE ═══════════════════════════════════════════════════════════════════
router.post('/cft-sheets', auth, adminOrPermission('cft', 'write'),
  auditLog('CREATE', 'CFTSheet'), async (req, res) => {
    const db = await getPool();
    try {
      const b = req.body;
      if (!b.project_id) return res.status(400).json({ message: 'Select a project' });
      const [[proj]] = await db.query('SELECT id FROM projects WHERE id=?', [b.project_id]);
      if (!proj) return res.status(400).json({ message: 'Project not found' });
      const sheetNo = await generateSheetNo(db);
      const [r] = await db.query(
        `INSERT INTO cft_sheets (sheet_no, project_id, project_item_id, wood_type, remarks, offcut_percent, status, created_by)
         VALUES (?,?,?,?,?,?,'draft',?)`,
        [sheetNo, b.project_id, b.project_item_id || null, b.wood_type || null, b.remarks || null, OFFCUT_PERCENT, req.user.id]);
      res.json({ id: r.insertId, sheet_no: sheetNo, message: 'CFT sheet created' });
    } catch (err) {
      console.error('CFT create error:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

// ══ UPDATE (header + rows upsert; recompute + store totals) ══════════════════
router.put('/cft-sheets/:id', auth, adminOrPermission('cft', 'write'),
  auditLog('UPDATE', 'CFTSheet'), async (req, res) => {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[s]] = await conn.query('SELECT * FROM cft_sheets WHERE id=? FOR UPDATE', [req.params.id]);
      if (!s) { await conn.rollback(); return res.status(404).json({ message: 'CFT sheet not found' }); }
      if (isLocked(s)) {
        await conn.rollback();
        return res.status(400).json({ message: LOCK_MSG[s.status] || 'This sheet is locked.' });
      }
      const b = req.body;
      await conn.query(
        'UPDATE cft_sheets SET wood_type=?, remarks=?, project_item_id=?, updated_by=? WHERE id=?',
        [b.wood_type ?? s.wood_type, b.remarks ?? s.remarks, b.project_item_id ?? s.project_item_id, req.user.id, s.id]);

      const rows = Array.isArray(b.rows) ? b.rows : [];
      // Validate
      for (const row of rows) {
        if (!ROW_TYPES.includes(row.row_type)) { await conn.rollback(); return res.status(400).json({ message: `Invalid row type: ${row.row_type}` }); }
      }
      // Replace-all strategy (rows are cheap; keeps ordering deterministic)
      await conn.query('DELETE FROM cft_rows WHERE sheet_id=?', [s.id]);
      const byType = {};
      for (const row of rows) {
        const { gross_cft, net_cft } = rowCft(row);
        byType[row.row_type] = (byType[row.row_type] || 0);
        await conn.query(
          `INSERT INTO cft_rows (sheet_id, row_type, label, length, width, thickness, qty, gross_cft, net_cft, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [s.id, row.row_type, row.label || null, Number(row.length) || 0, Number(row.width) || 0,
           Number(row.thickness) || 0, Number(row.qty) || 0, gross_cft, net_cft, byType[row.row_type]++]);
      }
      // Recompute + persist totals for auditability
      const [allRows] = await conn.query('SELECT * FROM cft_rows WHERE sheet_id=?', [s.id]);
      const t = computeTotals(allRows);
      await conn.query(
        `UPDATE cft_sheets SET total_demand_cft=?, offcut_cft=?, total_required_cft=?, total_issue_cft=?,
           total_return_cft=?, difference=?, net_difference=? WHERE id=?`,
        [t.total_demand_cft, t.offcut_cft, t.total_required_cft, t.total_issue_cft,
         t.total_return_cft, t.difference, t.net_difference, s.id]);
      await conn.commit();
      res.json({ message: 'CFT sheet saved', totals: t });
    } catch (err) {
      try { await conn.rollback(); } catch (e) {}
      console.error('CFT update error:', err.message);
      res.status(500).json({ message: err.message });
    } finally { conn.release(); }
  });

// ══ CUTTING LIST PHOTOS ══════════════════════════════════════════════════════
router.post('/cft-sheets/:id/photos', auth, adminOrPermission('cft', 'write'), (req, res, next) => {
  imgUpload.array('photos', 10)(req, res, err => {
    if (err) return res.status(400).json({ message: err.message || 'Photo upload failed' });
    next();
  });
}, async (req, res) => {
  const db = await getPool();
  try {
    const s = await photoSheet(db, req, res);
    if (!s) return;
    const added = (req.files || []).map(f => f.path || f.secure_url).filter(Boolean);
    if (!added.length) return res.status(400).json({ message: 'Choose a photo to upload' });
    const photos = [...parsePhotos(s.cutting_list_photos), ...added];
    if (photos.length > MAX_PHOTOS) return res.status(400).json({ message: `A sheet can have at most ${MAX_PHOTOS} photos` });
    await db.query('UPDATE cft_sheets SET cutting_list_photos=?, updated_by=? WHERE id=?', [JSON.stringify(photos), req.user.id, s.id]);
    res.json({ message: 'Photo uploaded', cutting_list_photos: photos });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/cft-sheets/:id/photos', auth, adminOrPermission('cft', 'write'), async (req, res) => {
  const db = await getPool();
  try {
    const s = await photoSheet(db, req, res);
    if (!s) return;
    const url = String(req.query.url || '');
    const photos = parsePhotos(s.cutting_list_photos).filter(u => u !== url);
    await db.query('UPDATE cft_sheets SET cutting_list_photos=?, updated_by=? WHERE id=?',
      [photos.length ? JSON.stringify(photos) : null, req.user.id, s.id]);
    res.json({ message: 'Photo removed', cutting_list_photos: photos });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ SUBMIT / REOPEN / DELETE ═════════════════════════════════════════════════
// Send for approval: locks the draft and puts it in the Approvals inbox (type CFT)
async function sendForApproval(req, res) {
  const db = await getPool();
  try {
    const [[s]] = await db.query(
      `SELECT cs.*, p.name AS project_name, p.project_id AS project_code, pi.item_name
         FROM cft_sheets cs LEFT JOIN projects p ON p.id = cs.project_id
         LEFT JOIN project_items pi ON pi.id = cs.project_item_id WHERE cs.id=?`, [req.params.id]);
    if (!s) return res.status(404).json({ message: 'CFT sheet not found' });
    if (s.status !== 'draft') return res.status(400).json({ message: LOCK_MSG[s.status] || `Sheet is ${s.status}` });
    const [[{ c }]] = await db.query('SELECT COUNT(*) c FROM cft_rows WHERE sheet_id=?', [s.id]);
    if (!c) return res.status(400).json({ message: 'Add at least one row before sending for approval' });
    const [[pending]] = await db.query(
      "SELECT id FROM approvals WHERE type='CFT' AND related_id=? AND status='PENDING' LIMIT 1", [s.id]);
    if (pending) return res.status(400).json({ message: 'This sheet is already waiting for approval' });
    await createApprovalRequest({
      type: 'CFT', userId: req.user.id, relatedId: s.id,
      requestData: {
        sheet_no: s.sheet_no, project_name: s.project_name, project_code: s.project_code, item_name: s.item_name,
        wood_type: s.wood_type, total_demand_cft: s.total_demand_cft, total_issue_cft: s.total_issue_cft,
        net_difference: s.net_difference, rows: c,
      },
    });
    await db.query(
      "UPDATE cft_sheets SET status='pending', submitted_by=?, submitted_at=NOW(), rejected_reason=NULL, rejected_at=NULL WHERE id=?",
      [req.user.id, s.id]);
    res.json({ message: 'CFT sheet sent for approval' });
  } catch (err) { res.status(500).json({ message: err.message }); }
}
router.post('/cft-sheets/:id/send-approval', auth, adminOrPermission('cft', 'write'), auditLog('UPDATE', 'CFTSheet'), sendForApproval);
router.post('/cft-sheets/:id/submit', auth, adminOrPermission('cft', 'write'), auditLog('UPDATE', 'CFTSheet'), sendForApproval);

// ══ ASSIGN an approved sheet to workers (multi-select) ══════════════════════════
router.get('/cft-sheets/:id/assignable-workers', auth, adminOrPermission('cft', 'edit'), async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(
      "SELECT id, name, username FROM users WHERE role='worker' AND (is_active=1 OR is_active IS NULL) ORDER BY name");
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Body { worker_ids: [..] } = the full list of workers for this sheet
router.put('/cft-sheets/:id/workers', auth, adminOrPermission('cft', 'edit'), auditLog('UPDATE', 'CFTSheet'), async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const ids = [...new Set((Array.isArray(req.body.worker_ids) ? req.body.worker_ids : []).map(Number).filter(n => n > 0))];
    await conn.beginTransaction();
    const [[s]] = await conn.query('SELECT id, status FROM cft_sheets WHERE id=? FOR UPDATE', [req.params.id]);
    if (!s) { await conn.rollback(); return res.status(404).json({ message: 'CFT sheet not found' }); }
    if (s.status !== 'approved') { await conn.rollback(); return res.status(400).json({ message: 'Only an approved sheet can be assigned to workers' }); }
    if (ids.length) {
      const [ok] = await conn.query("SELECT id FROM users WHERE role='worker' AND id IN (?)", [ids]);
      if (ok.length !== ids.length) { await conn.rollback(); return res.status(400).json({ message: 'Some selected users are not workers' }); }
    }
    const [current] = await conn.query(
      `SELECT w.worker_id, u.name, (w.entered_in_tally IS NOT NULL OR COALESCE(w.stock_journal_no,'')<>'' OR COALESCE(w.other_details,'')<>'') AS has_details
         FROM cft_sheet_workers w JOIN users u ON u.id = w.worker_id WHERE w.sheet_id=?`, [s.id]);
    // A worker who already filled in details stays, so their entry is not lost
    const keep = current.filter(c => !ids.includes(c.worker_id) && Number(c.has_details));
    if (keep.length) {
      await conn.rollback();
      return res.status(400).json({ message: `${keep.map(k => k.name).join(', ')} already entered Tally details on this sheet and can't be removed` });
    }
    const removeIds = current.map(c => c.worker_id).filter(id => !ids.includes(id));
    if (removeIds.length) await conn.query('DELETE FROM cft_sheet_workers WHERE sheet_id=? AND worker_id IN (?)', [s.id, removeIds]);
    for (const wid of ids) {
      await conn.query('INSERT IGNORE INTO cft_sheet_workers (sheet_id, worker_id, assigned_by) VALUES (?,?,?)', [s.id, wid, req.user.id]);
    }
    await conn.commit();
    res.json({ message: ids.length ? `Assigned to ${ids.length} worker(s)` : 'No workers assigned', worker_ids: ids });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// ══ ASSIGNED WORKER: read-only sheet + their own Tally details ════════════════
router.get('/cft-assigned', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(
      `SELECT cs.id, cs.sheet_no, cs.wood_type, cs.approved_at, cs.total_demand_cft, cs.total_issue_cft, cs.net_difference,
              p.name AS project_name, p.project_id AS project_code, pi.item_name,
              w.entered_in_tally, w.stock_journal_no, w.other_details, w.details_updated_at, w.assigned_at
         FROM cft_sheet_workers w
         JOIN cft_sheets cs ON cs.id = w.sheet_id
         LEFT JOIN projects p ON p.id = cs.project_id
         LEFT JOIN project_items pi ON pi.id = cs.project_item_id
        WHERE w.worker_id=? AND cs.status='approved'
        ORDER BY w.assigned_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

async function myAssignment(db, req) {
  const [[a]] = await db.query(
    `SELECT w.* FROM cft_sheet_workers w JOIN cft_sheets cs ON cs.id = w.sheet_id
      WHERE w.sheet_id=? AND w.worker_id=? AND cs.status='approved'`, [req.params.id, req.user.id]);
  return a || null;
}

router.get('/cft-assigned/:id', auth, async (req, res) => {
  const db = await getPool();
  try {
    const a = await myAssignment(db, req);
    if (!a) return res.status(404).json({ message: 'This CFT sheet is not assigned to you' });
    const s = await loadSheet(db, req.params.id);
    s.my_assignment = {
      entered_in_tally: a.entered_in_tally, stock_journal_no: a.stock_journal_no,
      other_details: a.other_details, details_updated_at: a.details_updated_at, assigned_at: a.assigned_at,
    };
    delete s.assigned_workers;   // a worker sees only their own entry
    res.json(s);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/cft-assigned/:id', auth, async (req, res) => {
  const db = await getPool();
  try {
    const a = await myAssignment(db, req);
    if (!a) return res.status(404).json({ message: 'This CFT sheet is not assigned to you' });
    const b = req.body || {};
    const tally = b.entered_in_tally === 'yes' || b.entered_in_tally === 'no' ? b.entered_in_tally : null;
    if (!tally) return res.status(400).json({ message: 'Choose Yes or No for "Entered in Tally"' });
    const sj = String(b.stock_journal_no ?? '').trim().slice(0, 100);
    if (tally === 'yes' && !sj) return res.status(400).json({ message: 'Enter the Stock Journal Number' });
    const other = String(b.other_details ?? '').trim().slice(0, 2000);
    await db.query(
      'UPDATE cft_sheet_workers SET entered_in_tally=?, stock_journal_no=?, other_details=?, details_updated_at=NOW() WHERE id=?',
      [tally, sj || null, other || null, a.id]);
    res.json({ message: 'Details saved' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/cft-sheets/:id/reopen', auth, adminOnly, auditLog('UPDATE', 'CFTSheet'), async (req, res) => {
  const db = await getPool();
  try {
    const [[s]] = await db.query('SELECT * FROM cft_sheets WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ message: 'CFT sheet not found' });
    if (!['submitted', 'approved'].includes(s.status))
      return res.status(400).json({ message: s.status === 'pending' ? 'Approve or reject it from the Approvals page' : 'Sheet is not locked' });
    await db.query("UPDATE cft_sheets SET status='draft', updated_by=? WHERE id=?", [req.user.id, s.id]);
    res.json({ message: 'CFT sheet reopened for editing. Send it for approval again when done.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/cft-sheets/:id', auth, adminOrPermission('cft', 'delete'),
  auditLog('DELETE', 'CFTSheet'), async (req, res) => {
    const db = await getPool();
    try {
      const [[s]] = await db.query('SELECT * FROM cft_sheets WHERE id=?', [req.params.id]);
      if (!s) return res.status(404).json({ message: 'CFT sheet not found' });
      if (s.status !== 'draft') return res.status(400).json({ message: 'Only draft sheets can be deleted' });
      await db.query('DELETE FROM cft_sheets WHERE id=?', [s.id]); // rows cascade
      res.json({ message: 'CFT sheet deleted' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// Expose constants so the UI can preview identical math client-side
router.get('/cft-config', auth, adminOrPermission('cft', 'read'), (req, res) => {
  res.json({ cft_constant: CFT_CONSTANT, offcut_percent: OFFCUT_PERCENT });
});

// ══ APPROVAL INTEGRATION (registered from server.js) ═════════════════════════
async function resolveCft(approval) {
  const db = await getPool();
  const id = approval.related_id;
  const [[s]] = await db.query('SELECT id, status FROM cft_sheets WHERE id=?', [id]);
  if (!s) throw new Error(`CFT sheet #${id} not found`);
  if (s.status === 'approved') return { id };                         // idempotent
  if (s.status !== 'pending') throw new Error(`CFT sheet is ${s.status}, cannot approve`);
  const [[apr]] = await db.query('SELECT approved_by FROM approvals WHERE id=?', [approval.id]);
  await db.query("UPDATE cft_sheets SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?",
    [apr?.approved_by || null, id]);
  return { id };
}

function registerCftApproval() {
  const { RESOLVERS } = require('../middleware/approvalResolvers');
  const { registerRejectHook } = require('../services/approvalHooks');
  RESOLVERS.CFT = resolveCft;
  // Reject → back to draft for corrections, with the reason shown on the sheet
  registerRejectHook('CFT', async (approval, adminId, reason) => {
    await (await getPool()).query(
      "UPDATE cft_sheets SET status='draft', rejected_reason=?, rejected_at=NOW() WHERE id=? AND status='pending'",
      [reason || 'Rejected', approval.related_id]);
  });
  console.log('✅ CFT approval resolver + reject hook registered');
}

module.exports = router;
module.exports.registerCftApproval = registerCftApproval;
