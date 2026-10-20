// ── PAYROLL Routes (NEW FILE — Phase 4) ──────────────────────────────────────
// Mounted in server.js at /api. routes/index.js is NOT modified.
//
// FULLY SEPARATE from Workers (users). Payroll employees live in their own
// table; users.hourly_rate and worker_time_logs are never touched.
//
// Client rules (Q9 + Q10 + permissions):
//  * OT via configured window: normal_start/end, ot_start/end (admin config).
//  * Each employee has normal + overtime hourly rates.
//  * No overnight shifts (out_time must be after in_time, same day).
//  * Overlap rejected server-side; back-to-back (in == previous out) allowed.
//  * WORKERS MUST NEVER SEE RATES/AMOUNTS — redacted server-side for any
//    non-admin caller. Amount/report screens are admin-only.
//
// Permission key 'payroll':
//   read  = View employees + time entries (NO amounts unless admin) + Print
//   write = Add/Edit/Import employee + Enter time
//   edit  = (reserved) ; delete = Delete employee/time entry
//   View Payroll amounts + Reports = ADMIN ONLY (strict redaction).

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOnly, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');

// ── settings helpers ─────────────────────────────────────────────────────────
const SETTING_KEYS = {
  normal_start: 'payroll_normal_start', normal_end: 'payroll_normal_end',
  ot_start: 'payroll_ot_start', ot_end: 'payroll_ot_end',
};
const DEFAULTS = { normal_start: '09:00', normal_end: '18:00', ot_start: '18:00', ot_end: '23:59' };

async function getPayrollSettings(db) {
  const [rows] = await db.query(
    'SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?,?,?,?)',
    Object.values(SETTING_KEYS));
  const map = {};
  rows.forEach(r => { map[r.setting_key] = r.setting_value; });
  return {
    normal_start: map[SETTING_KEYS.normal_start] || DEFAULTS.normal_start,
    normal_end: map[SETTING_KEYS.normal_end] || DEFAULTS.normal_end,
    ot_start: map[SETTING_KEYS.ot_start] || DEFAULTS.ot_start,
    ot_end: map[SETTING_KEYS.ot_end] || DEFAULTS.ot_end,
  };
}

// "HH:MM" -> minutes since midnight
const toMin = t => {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
// overlap length (minutes) of [a1,a2] with [b1,b2]
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

// Split a work interval into normal / OT minutes using the configured OT window.
// OT = overlap with [ot_start, ot_end]; Normal = total − OT (never loses time).
function splitMinutes(inMin, outMin, settings) {
  const total = outMin - inMin;
  const otS = toMin(settings.ot_start), otE = toMin(settings.ot_end);
  let ot = 0;
  if (otS != null && otE != null && otE > otS) ot = overlap(inMin, outMin, otS, otE);
  ot = Math.min(ot, total);
  return { total, normal: total - ot, ot };
}

const redactEmp = (e, isAdmin) => isAdmin ? e : (() => {
  const { hourly_rate, overtime_rate, ...rest } = e; return rest;
})();

// ══ SETTINGS ═════════════════════════════════════════════════════════════════
router.get('/payroll/settings', auth, adminOrPermission('payroll', 'read'), async (req, res) => {
  const db = await getPool();
  try { res.json(await getPayrollSettings(db)); }
  catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/payroll/settings', auth, adminOnly, auditLog('UPDATE', 'PayrollSettings'), async (req, res) => {
  const db = await getPool();
  try {
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const k of Object.keys(SETTING_KEYS)) {
      if (req.body[k] !== undefined) {
        if (!re.test(req.body[k])) return res.status(400).json({ message: `Invalid time for ${k} (use HH:MM)` });
        await db.query(
          'INSERT INTO app_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',
          [SETTING_KEYS[k], req.body[k]]);
      }
    }
    res.json({ message: 'Payroll settings saved', settings: await getPayrollSettings(db) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ EMPLOYEES ════════════════════════════════════════════════════════════════
router.get('/payroll/employees', auth, adminOrPermission('payroll', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const isAdmin = req.user.role === 'admin';
    const showInactive = req.query.all === '1';
    const [rows] = await db.query(
      `SELECT * FROM payroll_employees ${showInactive ? '' : 'WHERE is_active=1'} ORDER BY name`);
    res.json(rows.map(e => redactEmp(e, isAdmin)));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

function validateEmployee(b) {
  if (!b.emp_code || !String(b.emp_code).trim()) return 'Employee code is required';
  if (!b.name || !String(b.name).trim()) return 'Employee name is required';
  if (b.hourly_rate != null && (isNaN(Number(b.hourly_rate)) || Number(b.hourly_rate) < 0)) return 'Invalid normal hourly rate';
  if (b.overtime_rate != null && (isNaN(Number(b.overtime_rate)) || Number(b.overtime_rate) < 0)) return 'Invalid overtime rate';
  return null;
}

router.post('/payroll/employees', auth, adminOrPermission('payroll', 'write'),
  auditLog('CREATE', 'PayrollEmployee'), async (req, res) => {
    const db = await getPool();
    try {
      const err = validateEmployee(req.body);
      if (err) return res.status(400).json({ message: err });
      const b = req.body;
      const [r] = await db.query(
        `INSERT INTO payroll_employees (emp_code, name, department, designation, hourly_rate, overtime_rate, is_active, created_by)
         VALUES (?,?,?,?,?,?,1,?)`,
        [String(b.emp_code).trim(), String(b.name).trim(), b.department || null, b.designation || null,
         Number(b.hourly_rate) || 0, Number(b.overtime_rate) || 0, req.user.id]);
      res.json({ id: r.insertId, message: 'Employee added' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: 'An employee with this code already exists' });
      res.status(500).json({ message: err.message });
    }
  });

router.put('/payroll/employees/:id', auth, adminOrPermission('payroll', 'write'),
  auditLog('UPDATE', 'PayrollEmployee'), async (req, res) => {
    const db = await getPool();
    try {
      const err = validateEmployee({ ...req.body, emp_code: req.body.emp_code || 'x', name: req.body.name || 'x' });
      // only validate rate fields on edit if provided
      if (req.body.hourly_rate != null && (isNaN(Number(req.body.hourly_rate)) || Number(req.body.hourly_rate) < 0))
        return res.status(400).json({ message: 'Invalid normal hourly rate' });
      const [[emp]] = await db.query('SELECT * FROM payroll_employees WHERE id=?', [req.params.id]);
      if (!emp) return res.status(404).json({ message: 'Employee not found' });
      const b = req.body;
      await db.query(
        `UPDATE payroll_employees SET emp_code=?, name=?, department=?, designation=?, hourly_rate=?, overtime_rate=?, is_active=?, updated_by=? WHERE id=?`,
        [String(b.emp_code ?? emp.emp_code).trim(), String(b.name ?? emp.name).trim(),
         b.department ?? emp.department, b.designation ?? emp.designation,
         b.hourly_rate != null ? Number(b.hourly_rate) : emp.hourly_rate,
         b.overtime_rate != null ? Number(b.overtime_rate) : emp.overtime_rate,
         b.is_active != null ? (b.is_active ? 1 : 0) : emp.is_active, req.user.id, emp.id]);
      res.json({ message: 'Employee updated' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: 'An employee with this code already exists' });
      res.status(500).json({ message: err.message });
    }
  });

router.delete('/payroll/employees/:id', auth, adminOrPermission('payroll', 'delete'),
  auditLog('DELETE', 'PayrollEmployee'), async (req, res) => {
    const db = await getPool();
    try {
      const [[cnt]] = await db.query('SELECT COUNT(*) c FROM payroll_time_entries WHERE employee_id=?', [req.params.id]);
      if (cnt.c > 0) {
        // Preserve history — soft delete
        await db.query('UPDATE payroll_employees SET is_active=0 WHERE id=?', [req.params.id]);
        return res.json({ message: 'Employee has time entries — marked inactive to preserve payroll history' });
      }
      await db.query('DELETE FROM payroll_employees WHERE id=?', [req.params.id]);
      res.json({ message: 'Employee deleted' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// ── Bulk import (frontend parses CSV/XLSX → posts validated JSON rows) ───────
router.post('/payroll/employees/import', auth, adminOrPermission('payroll', 'write'),
  auditLog('CREATE', 'PayrollEmployeeImport'), async (req, res) => {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
      if (!rows.length) return res.status(400).json({ message: 'No rows to import' });

      // Pre-scan: within-file dupes + existing emp_codes
      const seen = new Set();
      const errors = [];
      const clean = [];
      const [existing] = await conn.query('SELECT emp_code FROM payroll_employees');
      const existingCodes = new Set(existing.map(e => String(e.emp_code)));
      rows.forEach((r, i) => {
        const line = i + 1;
        const code = String(r.emp_code || '').trim();
        const name = String(r.name || '').trim();
        if (!code || !name) { errors.push({ line, error: 'Missing emp_code or name' }); return; }
        if (seen.has(code)) { errors.push({ line, error: `Duplicate emp_code "${code}" within file` }); return; }
        if (existingCodes.has(code)) { errors.push({ line, error: `emp_code "${code}" already exists — skipped` }); return; }
        const hr = Number(r.hourly_rate) || 0, ot = Number(r.overtime_rate) || 0;
        if (hr < 0 || ot < 0) { errors.push({ line, error: 'Negative rate' }); return; }
        seen.add(code);
        clean.push({ emp_code: code, name, department: r.department || null, designation: r.designation || null, hourly_rate: hr, overtime_rate: ot });
      });

      if (!clean.length) return res.status(400).json({ message: 'No valid rows to import', errors, imported: 0 });

      await conn.beginTransaction();
      const [batch] = await conn.query(
        'INSERT INTO payroll_import_batches (imported_by, total_rows, imported_rows, skipped_rows) VALUES (?,?,?,?)',
        [req.user.id, rows.length, clean.length, rows.length - clean.length]);
      for (const c of clean) {
        await conn.query(
          `INSERT INTO payroll_employees (emp_code, name, department, designation, hourly_rate, overtime_rate, is_active, created_by, import_batch_id)
           VALUES (?,?,?,?,?,?,1,?,?)`,
          [c.emp_code, c.name, c.department, c.designation, c.hourly_rate, c.overtime_rate, req.user.id, batch.insertId]);
      }
      await conn.commit();
      res.json({ message: `Imported ${clean.length} of ${rows.length} employees`, imported: clean.length, skipped: rows.length - clean.length, errors, batch_id: batch.insertId });
    } catch (err) {
      try { await conn.rollback(); } catch (e) {}
      res.status(500).json({ message: err.message });
    } finally { conn.release(); }
  });

// ══ TIME ENTRIES ═════════════════════════════════════════════════════════════
router.get('/payroll/time-entries', auth, adminOrPermission('payroll', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const isAdmin = req.user.role === 'admin';
    const where = [], params = [];
    if (req.query.employee_id) { where.push('t.employee_id=?'); params.push(req.query.employee_id); }
    if (req.query.date) { where.push('t.entry_date=?'); params.push(req.query.date); }
    if (req.query.from) { where.push('t.entry_date>=?'); params.push(req.query.from); }
    if (req.query.to) { where.push('t.entry_date<=?'); params.push(req.query.to); }
    const [rows] = await db.query(
      `SELECT t.*, e.emp_code, e.name AS employee_name, e.department,
              e.hourly_rate, e.overtime_rate, p.project_id AS project_code, p.name AS project_name
       FROM payroll_time_entries t
       JOIN payroll_employees e ON e.id = t.employee_id
       LEFT JOIN projects p ON p.id = t.project_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.entry_date DESC, e.name, t.in_time`, params);
    res.json(rows.map(r => {
      const base = {
        ...r,
        normal_hours: Number((r.normal_minutes / 60).toFixed(2)),
        ot_hours: Number((r.ot_minutes / 60).toFixed(2)),
        total_hours: Number((r.total_minutes / 60).toFixed(2)),
      };
      if (isAdmin) {
        base.amount = Number(((r.normal_minutes / 60) * r.hourly_rate + (r.ot_minutes / 60) * r.overtime_rate).toFixed(2));
      } else {
        delete base.hourly_rate; delete base.overtime_rate; // redact
      }
      return base;
    }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/payroll/time-entries', auth, adminOrPermission('payroll', 'write'),
  auditLog('CREATE', 'PayrollTimeEntry'), async (req, res) => {
    const db = await getPool();
    try {
      const b = req.body;
      if (!b.employee_id) return res.status(400).json({ message: 'Select an employee' });
      if (!b.entry_date) return res.status(400).json({ message: 'Entry date is required' });
      const re = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!re.test(b.in_time || '') || !re.test(b.out_time || ''))
        return res.status(400).json({ message: 'In/Out time must be HH:MM (24h)' });
      const inMin = toMin(b.in_time), outMin = toMin(b.out_time);
      if (outMin <= inMin) return res.status(400).json({ message: 'Out time must be after In time (no overnight shifts in Phase 1)' });

      const [[emp]] = await db.query('SELECT id FROM payroll_employees WHERE id=? AND is_active=1', [b.employee_id]);
      if (!emp) return res.status(400).json({ message: 'Employee not found or inactive' });

      // Overlap check — same employee + date; back-to-back allowed (strict overlap)
      const [existing] = await db.query(
        'SELECT in_time, out_time FROM payroll_time_entries WHERE employee_id=? AND entry_date=?',
        [b.employee_id, b.entry_date]);
      for (const ex of existing) {
        const eIn = toMin(ex.in_time), eOut = toMin(ex.out_time);
        if (eIn < outMin && inMin < eOut) {
          return res.status(400).json({ message: `Overlaps an existing entry (${String(ex.in_time).slice(0,5)}–${String(ex.out_time).slice(0,5)}). Back-to-back is allowed, overlapping is not.` });
        }
      }

      const settings = await getPayrollSettings(db);
      const { total, normal, ot } = splitMinutes(inMin, outMin, settings);
      const [r] = await db.query(
        `INSERT INTO payroll_time_entries (employee_id, project_id, proto_code, entry_date, in_time, out_time,
           total_minutes, normal_minutes, ot_minutes, entered_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [b.employee_id, b.project_id || null, b.proto_code || null, b.entry_date, b.in_time, b.out_time,
         total, normal, ot, req.user.id]);
      res.json({ id: r.insertId, message: 'Time entry added', normal_hours: +(normal / 60).toFixed(2), ot_hours: +(ot / 60).toFixed(2) });
    } catch (err) {
      console.error('Time entry error:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

router.put('/payroll/time-entries/:id', auth, adminOrPermission('payroll', 'write'),
  auditLog('UPDATE', 'PayrollTimeEntry'), async (req, res) => {
    const db = await getPool();
    try {
      const [[row]] = await db.query('SELECT * FROM payroll_time_entries WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ message: 'Time entry not found' });
      const b = req.body;
      const re = /^([01]\d|2[0-3]):[0-5]\d$/;
      const inT = b.in_time || String(row.in_time).slice(0, 5);
      const outT = b.out_time || String(row.out_time).slice(0, 5);
      if (!re.test(inT) || !re.test(outT)) return res.status(400).json({ message: 'In/Out time must be HH:MM' });
      const inMin = toMin(inT), outMin = toMin(outT);
      if (outMin <= inMin) return res.status(400).json({ message: 'Out time must be after In time' });
      const entryDate = b.entry_date || row.entry_date;

      const [existing] = await db.query(
        'SELECT in_time, out_time FROM payroll_time_entries WHERE employee_id=? AND entry_date=? AND id<>?',
        [row.employee_id, entryDate, row.id]);
      for (const ex of existing) {
        if (toMin(ex.in_time) < outMin && inMin < toMin(ex.out_time))
          return res.status(400).json({ message: 'Overlaps an existing entry for this employee/date' });
      }
      const settings = await getPayrollSettings(db);
      const { total, normal, ot } = splitMinutes(inMin, outMin, settings);
      await db.query(
        `UPDATE payroll_time_entries SET project_id=?, proto_code=?, entry_date=?, in_time=?, out_time=?,
           total_minutes=?, normal_minutes=?, ot_minutes=? WHERE id=?`,
        [b.project_id ?? row.project_id, b.proto_code ?? row.proto_code, entryDate, inT, outT,
         total, normal, ot, row.id]);
      res.json({ message: 'Time entry updated' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

router.delete('/payroll/time-entries/:id', auth, adminOrPermission('payroll', 'delete'),
  auditLog('DELETE', 'PayrollTimeEntry'), async (req, res) => {
    const db = await getPool();
    try {
      await db.query('DELETE FROM payroll_time_entries WHERE id=?', [req.params.id]);
      res.json({ message: 'Time entry deleted' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// ══ PAYROLL REPORT (amounts) — ADMIN ONLY ════════════════════════════════════
router.get('/payroll/report', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const { from, to, employee_id } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'from and to dates are required' });
    const where = ['t.entry_date BETWEEN ? AND ?'];
    const params = [from, to];
    if (employee_id) { where.push('t.employee_id=?'); params.push(employee_id); }
    const [rows] = await db.query(
      `SELECT e.id AS employee_id, e.emp_code, e.name AS employee_name, e.department,
              e.hourly_rate, e.overtime_rate,
              SUM(t.normal_minutes) AS normal_minutes, SUM(t.ot_minutes) AS ot_minutes,
              SUM(t.total_minutes) AS total_minutes, COUNT(*) AS entry_count
       FROM payroll_time_entries t
       JOIN payroll_employees e ON e.id = t.employee_id
       WHERE ${where.join(' AND ')}
       GROUP BY e.id
       ORDER BY e.name`, params);
    const report = rows.map(r => {
      const nh = r.normal_minutes / 60, oh = r.ot_minutes / 60;
      const normalAmount = nh * r.hourly_rate, otAmount = oh * r.overtime_rate;
      return {
        employee_id: r.employee_id, emp_code: r.emp_code, employee_name: r.employee_name, department: r.department,
        hourly_rate: Number(r.hourly_rate), overtime_rate: Number(r.overtime_rate),
        normal_hours: +nh.toFixed(2), ot_hours: +oh.toFixed(2), total_hours: +((r.total_minutes) / 60).toFixed(2),
        normal_amount: +normalAmount.toFixed(2), ot_amount: +otAmount.toFixed(2),
        total_amount: +(normalAmount + otAmount).toFixed(2), entry_count: r.entry_count,
      };
    });
    const grand = report.reduce((a, r) => ({
      normal_hours: a.normal_hours + r.normal_hours, ot_hours: a.ot_hours + r.ot_hours,
      total_amount: a.total_amount + r.total_amount,
    }), { normal_hours: 0, ot_hours: 0, total_amount: 0 });
    res.json({ from, to, report, grand_total: {
      normal_hours: +grand.normal_hours.toFixed(2), ot_hours: +grand.ot_hours.toFixed(2),
      total_amount: +grand.total_amount.toFixed(2),
    } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
