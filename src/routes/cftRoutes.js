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
            cu.name AS created_by_name, su.name AS submitted_by_name
     FROM cft_sheets cs
     LEFT JOIN projects p ON p.id = cs.project_id
     LEFT JOIN project_items pi ON pi.id = cs.project_item_id
     LEFT JOIN users cu ON cu.id = cs.created_by
     LEFT JOIN users su ON su.id = cs.submitted_by
     WHERE cs.id=?`, [id]);
  if (!s) return null;
  const [rows] = await db.query('SELECT * FROM cft_rows WHERE sheet_id=? ORDER BY row_type, sort_order, id', [id]);
  s.rows = rows;
  s.totals = computeTotals(rows);
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
      `SELECT cs.id, cs.sheet_no, cs.status, cs.wood_type, cs.created_at,
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
      if (s.status === 'submitted') {
        await conn.rollback();
        return res.status(400).json({ message: 'Sheet is submitted and locked. Ask an admin to reopen it.' });
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

// ══ SUBMIT / REOPEN / DELETE ═════════════════════════════════════════════════
router.post('/cft-sheets/:id/submit', auth, adminOrPermission('cft', 'write'),
  auditLog('UPDATE', 'CFTSheet'), async (req, res) => {
    const db = await getPool();
    try {
      const [[s]] = await db.query('SELECT * FROM cft_sheets WHERE id=?', [req.params.id]);
      if (!s) return res.status(404).json({ message: 'CFT sheet not found' });
      if (s.status === 'submitted') return res.status(400).json({ message: 'Already submitted' });
      const [[{ c }]] = await db.query('SELECT COUNT(*) c FROM cft_rows WHERE sheet_id=?', [s.id]);
      if (!c) return res.status(400).json({ message: 'Add at least one row before submitting' });
      await db.query("UPDATE cft_sheets SET status='submitted', submitted_by=?, submitted_at=NOW() WHERE id=?", [req.user.id, s.id]);
      res.json({ message: 'CFT sheet submitted and locked' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

router.post('/cft-sheets/:id/reopen', auth, adminOnly, auditLog('UPDATE', 'CFTSheet'), async (req, res) => {
  const db = await getPool();
  try {
    const [[s]] = await db.query('SELECT * FROM cft_sheets WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ message: 'CFT sheet not found' });
    if (s.status !== 'submitted') return res.status(400).json({ message: 'Sheet is not submitted' });
    await db.query("UPDATE cft_sheets SET status='draft', updated_by=? WHERE id=?", [req.user.id, s.id]);
    res.json({ message: 'CFT sheet reopened for editing' });
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

module.exports = router;
