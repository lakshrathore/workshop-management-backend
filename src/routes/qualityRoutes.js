// ── QUALITY REPORT Routes (NEW FILE — Phase 5) ───────────────────────────────
// Mounted in server.js at /api. routes/index.js is NOT modified.
//
// Workflow (client-confirmed Q6):
//   Draft → Assigned → (worker uploads images/data) → Submitted
//        → Admin Approves/Rejects → Final(Approved)/Locked  |  Rejected→rework
// Uses the EXISTING Approvals inbox (type QUALITY_REPORT). Worker cannot approve.
//
// Sections are dynamic. Admin can always add sections. An assigned worker can
// add sections ONLY if the report's can_add_sections flag is set (per Q10);
// otherwise the worker can only upload images/data into existing sections.
//
// Report number: configurable series QR-2026-0001 (Q10).
//
// Permission key 'quality_report':
//   read = View / Print · write = Create + Upload + Add data + Submit
//        (+ Add sections only when report.can_add_sections) · edit = Assign/configure
//   delete = Delete draft · Approve/Reject = admin only via Approvals.

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOnly, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');
const { moReferenceUpload, deleteFile } = require('../services/cloudinaryStorage');
const { createApprovalRequest } = require('../services/approvalService');

const INSPECTION_LEVELS = ['final', 'white_body'];

// Standard QC inspection checklist (printed form, section 2). Results are saved
// per key in quality_reports.checklist_json together with a label/criteria
// snapshot, so an old report always prints exactly what was inspected.
const QC_CHECKLIST = [
  { key: 'dimensions',  label: 'Dimensions / tolerance',          criteria: 'As approved drawing' },
  { key: 'material',    label: 'Material & component quality',    criteria: 'Approved specification' },
  { key: 'joinery',     label: 'Joinery / structural stability',  criteria: 'No loose joints / wobble' },
  { key: 'surface',     label: 'Surface / sanding quality',       criteria: 'Smooth, no visible defects' },
  { key: 'finish',      label: 'Paint / polish / finish',         criteria: 'Shade, sheen, uniformity' },
  { key: 'upholstery',  label: 'Fabric / upholstery / stitching', criteria: 'Code, alignment, neatness' },
  { key: 'hardware',    label: 'Hardware / fittings',             criteria: 'Correct fit and operation' },
  { key: 'edges',       label: 'Edges / corners / safety',        criteria: 'No sharp edges / burrs' },
  { key: 'function',    label: 'Functionality / leveling',        criteria: 'Stable, opens / closes well' },
  { key: 'cleanliness', label: 'Cleanliness / final appearance',  criteria: 'No stains, dents, scratches' },
  { key: 'packaging',   label: 'Labeling / packaging',            criteria: 'Correct label, safe packing' },
];
const CHECK_RESULTS = ['pass', 'fail', 'na'];
const INSPECTION_RESULTS = ['approved', 'rework', 'rejected'];

// Optional short note per checklist row (prints in the Remarks column)
const cleanRemark = v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, 200));

// Template + saved results → [{key,label,criteria,result|null,remark}]. Unanswered stays null
// (never defaulted to pass). Saved keys no longer in the template are kept.
function mergeChecklist(json) {
  let saved = [];
  try { saved = json ? JSON.parse(json) : []; } catch (e) { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  const byKey = new Map(saved.filter(s => s && s.key).map(s => [s.key, s]));
  const rows = QC_CHECKLIST.map(t => {
    const s = byKey.get(t.key);
    return { ...t, label: s?.label || t.label, criteria: s?.criteria || t.criteria,
             result: CHECK_RESULTS.includes(s?.result) ? s.result : null, remark: cleanRemark(s?.remark) };
  });
  for (const s of saved) {
    if (s?.key && !QC_CHECKLIST.some(t => t.key === s.key))
      rows.push({ key: s.key, label: s.label || s.key, criteria: s.criteria || '',
                  result: CHECK_RESULTS.includes(s.result) ? s.result : null, remark: cleanRemark(s.remark) });
  }
  return rows;
}

// Report series QR-2026-0001 (configurable prefix, full year, 4-digit pad)
async function generateReportNo(db) {
  let prefix = 'QR';
  try {
    const [[s]] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='qr_prefix'");
    if (s?.setting_value) prefix = s.setting_value;
  } catch (e) { /* default */ }
  const year = new Date().getFullYear();
  const [last] = await db.query(
    'SELECT report_no FROM quality_reports WHERE report_no IS NOT NULL ORDER BY id DESC LIMIT 1');
  let next = 1;
  if (last.length) { const m = last[0].report_no?.match(/(\d+)$/); if (m) next = parseInt(m[1]) + 1; }
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

async function loadReport(db, id) {
  const [[r]] = await db.query(
    `SELECT qr.*, p.project_id AS project_code, p.name AS project_name_live,
            pi.item_name, pi.proto_code AS item_proto_code,
            q.name AS qc_person_name, aw.name AS assigned_to_name,
            cu.name AS created_by_name, au.name AS approved_by_name, ru.name AS rejected_by_name
     FROM quality_reports qr
     LEFT JOIN projects p ON p.id = qr.project_id
     LEFT JOIN project_items pi ON pi.id = qr.project_item_id
     LEFT JOIN qc_persons q ON q.id = qr.qc_person_id
     LEFT JOIN users aw ON aw.id = qr.assigned_to
     LEFT JOIN users cu ON cu.id = qr.created_by
     LEFT JOIN users au ON au.id = qr.approved_by
     LEFT JOIN users ru ON ru.id = qr.rejected_by
     WHERE qr.id=?`, [id]);
  if (!r) return null;
  const [sections] = await db.query(
    'SELECT * FROM quality_report_sections WHERE report_id=? ORDER BY sort_order, id', [id]);
  const secIds = sections.map(s => s.id);
  let images = [];
  if (secIds.length) {
    [images] = await db.query(
      'SELECT * FROM quality_report_images WHERE section_id IN (?) ORDER BY sort_order, id', [secIds]);
  }
  r.sections = sections.map(s => ({ ...s, check_points: parseCheckPoints(s.check_points), images: images.filter(im => im.section_id === s.id) }));
  r.checklist = mergeChecklist(r.checklist_json);
  delete r.checklist_json;

  // Linked data for the printed form (read-only, best effort — missing links stay null)
  try {
    const [[linked]] = await db.query(
      `SELECT pi.quantity AS item_quantity, pi.unit AS item_unit, pi.source_main_po_item_id,
              mp.po_no AS main_po_no, mpi.finishes_note AS main_po_finishes_note
       FROM quality_reports qr
       LEFT JOIN projects p ON p.id = qr.project_id
       LEFT JOIN project_items pi ON pi.id = qr.project_item_id
       LEFT JOIN main_pos mp ON mp.id = p.source_main_po_id
       LEFT JOIN main_po_items mpi ON mpi.id = pi.source_main_po_item_id
       WHERE qr.id=?`, [id]);
    Object.assign(r, {
      item_quantity: linked?.item_quantity ?? null, item_unit: linked?.item_unit || null,
      main_po_no: linked?.main_po_no || null, main_po_finishes_note: linked?.main_po_finishes_note || null,
      finish_sheet_codes: [],
    });
    if (linked?.source_main_po_item_id) {
      const [fe] = await db.query(
        `SELECT fs.finish_type, fe.paint_finish_name, fe.fabric_name, fe.metal_finish_details
         FROM finish_entries fe JOIN finish_sheets fs ON fs.id = fe.sheet_id
         WHERE fe.main_po_item_id=? ORDER BY FIELD(fs.finish_type,'paint','fabric','metal')`, [linked.source_main_po_item_id]);
      r.finish_sheet_codes = fe
        .map(e => e.paint_finish_name || e.fabric_name || e.metal_finish_details)
        .filter(Boolean);
    }
  } catch (e) { /* linked tables missing on very old DBs — form just shows blanks */ }
  return r;
}

function canWorkerTouch(report, user) {
  return user.role === 'admin' || report.assigned_to === user.id;
}

// ══ QC PERSONS (small master) ════════════════════════════════════════════════
// Active workers in a "Quality…" / "QC" department are QC persons automatically.
// Make sure each one has a qc_persons row (reports store qc_persons.id) and return their user ids.
async function syncQcWorkers(db) {
  const [workers] = await db.query(
    `SELECT DISTINCT u.id, u.name, u.username FROM users u
       JOIN worker_departments wd ON wd.worker_id = u.id
       JOIN departments d ON d.id = wd.department_id
      WHERE u.is_active = 1 AND (LOWER(d.name) LIKE '%quality%' OR LOWER(d.name) IN ('qc', 'q.c', 'q c'))`);
  for (const w of workers) {
    const [[linked]] = await db.query('SELECT id FROM qc_persons WHERE user_id=? LIMIT 1', [w.id]);
    if (linked) {
      await db.query('UPDATE qc_persons SET is_active=1 WHERE id=?', [linked.id]);
      continue;
    }
    // Reuse a hand-added entry with the same name, otherwise create one
    const [[byName]] = await db.query('SELECT id FROM qc_persons WHERE name=? AND user_id IS NULL LIMIT 1', [w.name]);
    if (byName) { await db.query('UPDATE qc_persons SET user_id=?, is_active=1 WHERE id=?', [w.id, byName.id]); continue; }
    try {
      await db.query('INSERT INTO qc_persons (name, is_active, user_id) VALUES (?,1,?)', [w.name, w.id]);
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await db.query('INSERT IGNORE INTO qc_persons (name, is_active, user_id) VALUES (?,1,?)', [`${w.name} (@${w.username})`, w.id]);
    }
  }
  return workers.map(w => w.id);
}

router.get('/quality/qc-persons', auth, adminOrPermission('quality_report', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const qcWorkerIds = await syncQcWorkers(db);
    const where = [];
    if (req.query.all !== '1') where.push('is_active=1');
    // Hand-added names always show; worker-linked names only while the worker is in a QC department
    where.push(qcWorkerIds.length ? `(user_id IS NULL OR user_id IN (${qcWorkerIds.map(() => '?').join(',')}))` : 'user_id IS NULL');
    const [rows] = await db.query(
      `SELECT * FROM qc_persons WHERE ${where.join(' AND ')} ORDER BY name`, qcWorkerIds);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/quality/qc-persons', auth, adminOrPermission('quality_report', 'edit'),
  auditLog('CREATE', 'QCPerson'), async (req, res) => {
    const db = await getPool();
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ message: 'QC person name is required' });
      const [r] = await db.query('INSERT INTO qc_persons (name, is_active, created_by) VALUES (?,1,?)', [name, req.user.id]);
      res.json({ id: r.insertId, message: 'QC person added' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: 'This QC person already exists' });
      res.status(500).json({ message: err.message });
    }
  });

router.put('/quality/qc-persons/:id', auth, adminOrPermission('quality_report', 'edit'), async (req, res) => {
  const db = await getPool();
  try {
    const sets = [], vals = [];
    if (req.body.name !== undefined) { sets.push('name=?'); vals.push(String(req.body.name).trim()); }
    if (req.body.is_active !== undefined) { sets.push('is_active=?'); vals.push(req.body.is_active ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE qc_persons SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ message: 'QC person updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ REPORTS ══════════════════════════════════════════════════════════════════
router.get('/quality/reports', auth, adminOrPermission('quality_report', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const where = [], params = [];
    // Workers see reports assigned to them (plus any they created); admin sees all
    if (req.user.role !== 'admin') { where.push('(qr.assigned_to=? OR qr.created_by=?)'); params.push(req.user.id, req.user.id); }
    if (req.query.status && req.query.status !== 'all') { where.push('qr.status=?'); params.push(req.query.status); }
    const [rows] = await db.query(
      `SELECT qr.id, qr.report_no, qr.client_name, qr.sku_number, qr.inspection_level, qr.inspection_date,
              qr.status, qr.rejected_reason, p.project_id AS project_code, p.name AS project_name,
              q.name AS qc_person_name, aw.name AS assigned_to_name,
              (SELECT COUNT(*) FROM quality_report_sections s WHERE s.report_id=qr.id) AS section_count,
              (SELECT COUNT(*) FROM quality_report_images im JOIN quality_report_sections s2 ON s2.id=im.section_id WHERE s2.report_id=qr.id) AS image_count
       FROM quality_reports qr
       LEFT JOIN projects p ON p.id = qr.project_id
       LEFT JOIN qc_persons q ON q.id = qr.qc_person_id
       LEFT JOIN users aw ON aw.id = qr.assigned_to
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY qr.id DESC`, params);
    const [counts] = await db.query('SELECT status, COUNT(*) c FROM quality_reports GROUP BY status');
    res.json({ rows, counts });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/quality/reports/:id', auth, adminOrPermission('quality_report', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const r = await loadReport(db, req.params.id);
    if (!r) return res.status(404).json({ message: 'Report not found' });
    if (req.user.role !== 'admin' && r.assigned_to !== req.user.id && r.created_by !== req.user.id)
      return res.status(403).json({ message: 'This report is not assigned to you' });
    res.json(r);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/quality/reports', auth, adminOrPermission('quality_report', 'write'),
  auditLog('CREATE', 'QualityReport'), async (req, res) => {
    const db = await getPool();
    try {
      const b = req.body;
      if (!b.project_id) return res.status(400).json({ message: 'Select a project' });
      if (b.inspection_level && !INSPECTION_LEVELS.includes(b.inspection_level))
        return res.status(400).json({ message: 'Invalid inspection level' });
      const [[proj]] = await db.query('SELECT id FROM projects WHERE id=?', [b.project_id]);
      if (!proj) return res.status(400).json({ message: 'Project not found' });

      // Vendor + location snapshot from settings (fallbacks per analysis)
      const [settingsRows] = await db.query(
        "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('company_name','company_address')");
      const sMap = {}; settingsRows.forEach(s => sMap[s.setting_key] = s.setting_value);

      const reportNo = await generateReportNo(db);
      const [r] = await db.query(
        `INSERT INTO quality_reports (report_no, project_id, project_item_id, client_name, vendor_name, location,
           qc_person_id, inspection_level, inspection_date, sku_number, status, can_add_sections, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
        [reportNo, b.project_id, b.project_item_id || null, b.client_name || null,
         b.vendor_name || sMap.company_name || 'MOZI Innovators LLP', b.location || sMap.company_address || null,
         b.qc_person_id || null, b.inspection_level || 'final', b.inspection_date || null,
         b.sku_number || null, b.can_add_sections ? 1 : 0, req.user.id]);

      // Optional starter sections
      const starters = Array.isArray(b.sections) ? b.sections : [];
      for (let i = 0; i < starters.length; i++) {
        const nm = (starters[i].section_name || starters[i]).toString().trim();
        if (nm) await db.query(
          'INSERT INTO quality_report_sections (report_id, section_name, description, sort_order) VALUES (?,?,?,?)',
          [r.insertId, nm, starters[i].description || null, i]);
      }
      res.json({ id: r.insertId, report_no: reportNo, message: 'Quality report created (draft)' });
    } catch (err) {
      console.error('QR create error:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

router.put('/quality/reports/:id', auth, adminOrPermission('quality_report', 'edit'),
  auditLog('UPDATE', 'QualityReport'), async (req, res) => {
    const db = await getPool();
    try {
      const [[r]] = await db.query('SELECT * FROM quality_reports WHERE id=?', [req.params.id]);
      if (!r) return res.status(404).json({ message: 'Report not found' });
      if (!['draft', 'rejected'].includes(r.status))
        return res.status(400).json({ message: `Cannot edit a ${r.status} report` });
      const b = req.body;
      if (b.inspection_level && !INSPECTION_LEVELS.includes(b.inspection_level))
        return res.status(400).json({ message: 'Invalid inspection level' });
      await db.query(
        `UPDATE quality_reports SET client_name=?, vendor_name=?, location=?, qc_person_id=?, project_item_id=?,
           inspection_level=?, inspection_date=?, sku_number=?, can_add_sections=?, updated_by=? WHERE id=?`,
        [b.client_name ?? r.client_name, b.vendor_name ?? r.vendor_name, b.location ?? r.location,
         b.qc_person_id ?? r.qc_person_id, b.project_item_id ?? r.project_item_id,
         b.inspection_level ?? r.inspection_level, b.inspection_date ?? r.inspection_date,
         b.sku_number ?? r.sku_number, b.can_add_sections != null ? (b.can_add_sections ? 1 : 0) : r.can_add_sections,
         req.user.id, r.id]);
      res.json({ message: 'Report updated' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// Assign to a worker (→ assigned) — admin/edit
router.post('/quality/reports/:id/assign', auth, adminOrPermission('quality_report', 'edit'),
  auditLog('UPDATE', 'QualityReport'), async (req, res) => {
    const db = await getPool();
    try {
      const [[r]] = await db.query('SELECT * FROM quality_reports WHERE id=?', [req.params.id]);
      if (!r) return res.status(404).json({ message: 'Report not found' });
      if (['submitted', 'approved'].includes(r.status))
        return res.status(400).json({ message: `Cannot reassign a ${r.status} report` });
      const workerId = req.body.assigned_to ? Number(req.body.assigned_to) : null;
      if (workerId) {
        const [[w]] = await db.query("SELECT id FROM users WHERE id=? AND role IN ('worker','admin')", [workerId]);
        if (!w) return res.status(400).json({ message: 'Worker not found' });
      }
      await db.query(
        `UPDATE quality_reports SET assigned_to=?, can_add_sections=?, status='assigned', updated_by=? WHERE id=?`,
        [workerId, req.body.can_add_sections != null ? (req.body.can_add_sections ? 1 : 0) : r.can_add_sections, req.user.id, r.id]);
      res.json({ message: workerId ? 'Report assigned' : 'Assignment cleared' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

router.delete('/quality/reports/:id', auth, adminOrPermission('quality_report', 'delete'),
  auditLog('DELETE', 'QualityReport'), async (req, res) => {
    const db = await getPool();
    try {
      const [[r]] = await db.query('SELECT * FROM quality_reports WHERE id=?', [req.params.id]);
      if (!r) return res.status(404).json({ message: 'Report not found' });
      if (r.status !== 'draft') return res.status(400).json({ message: 'Only draft reports can be deleted' });
      const [imgs] = await db.query(
        `SELECT im.public_id FROM quality_report_images im
         JOIN quality_report_sections s ON s.id=im.section_id WHERE s.report_id=?`, [r.id]);
      await db.query('DELETE FROM quality_reports WHERE id=?', [r.id]); // sections+images cascade
      for (const im of imgs) { if (im.public_id) deleteFile(im.public_id).catch(() => {}); }
      res.json({ message: 'Report deleted' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// ══ SECTIONS ═════════════════════════════════════════════════════════════════
router.post('/quality/reports/:id/sections', auth, adminOrPermission('quality_report', 'write'),
  auditLog('CREATE', 'QRSection'), async (req, res) => {
    const db = await getPool();
    try {
      const [[r]] = await db.query('SELECT * FROM quality_reports WHERE id=?', [req.params.id]);
      if (!r) return res.status(404).json({ message: 'Report not found' });
      if (['submitted', 'approved'].includes(r.status))
        return res.status(400).json({ message: `Cannot modify a ${r.status} report` });
      // Add-section gate (Q10): admin always; worker only if can_add_sections
      if (req.user.role !== 'admin') {
        if (!canWorkerTouch(r, req.user)) return res.status(403).json({ message: 'This report is not assigned to you' });
        if (!r.can_add_sections) return res.status(403).json({ message: 'You do not have permission to add sections to this report' });
      }
      const name = (req.body.section_name || '').trim();
      if (!name) return res.status(400).json({ message: 'Section name is required' });
      const [[mx]] = await db.query('SELECT COALESCE(MAX(sort_order),-1) mo FROM quality_report_sections WHERE report_id=?', [r.id]);
      const [ins] = await db.query(
        'INSERT INTO quality_report_sections (report_id, section_name, description, sort_order) VALUES (?,?,?,?)',
        [r.id, name, req.body.description || null, mx.mo + 1]);
      res.json({ id: ins.insertId, message: 'Section added' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// Check points of a section: JSON list of short lines; null = never edited (print uses the standard list)
function parseCheckPoints(v) {
  if (v === null || v === undefined || v === '') return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(x => String(x)) : null; } catch (e) { return null; }
}
function cleanCheckPoints(list) {
  if (!Array.isArray(list)) return null;
  return list.map(x => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 40);
}

router.put('/quality/sections/:sectionId', auth, adminOrPermission('quality_report', 'write'), async (req, res) => {
  const db = await getPool();
  try {
    const [[sec]] = await db.query(
      `SELECT s.*, r.status, r.assigned_to, r.can_add_sections FROM quality_report_sections s
       JOIN quality_reports r ON r.id=s.report_id WHERE s.id=?`, [req.params.sectionId]);
    if (!sec) return res.status(404).json({ message: 'Section not found' });
    if (['submitted', 'approved'].includes(sec.status)) return res.status(400).json({ message: 'Report is locked' });
    const sets = [], vals = [];
    if (req.body.section_name !== undefined) { sets.push('section_name=?'); vals.push(String(req.body.section_name).trim()); }
    if (req.body.description !== undefined) { sets.push('description=?'); vals.push(req.body.description); }
    if (req.body.sort_order !== undefined) { sets.push('sort_order=?'); vals.push(Number(req.body.sort_order)); }
    if (req.body.check_points !== undefined) {
      const pts = req.body.check_points === null ? null : cleanCheckPoints(req.body.check_points);
      if (req.body.check_points !== null && pts === null) return res.status(400).json({ message: 'Check points must be a list' });
      sets.push('check_points=?'); vals.push(pts === null ? null : JSON.stringify(pts));
    }
    if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
    vals.push(sec.id);
    await db.query(`UPDATE quality_report_sections SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ message: 'Section updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/quality/sections/:sectionId', auth, adminOrPermission('quality_report', 'write'), async (req, res) => {
  const db = await getPool();
  try {
    const [[sec]] = await db.query(
      `SELECT s.*, r.status, r.assigned_to, r.can_add_sections FROM quality_report_sections s
       JOIN quality_reports r ON r.id=s.report_id WHERE s.id=?`, [req.params.sectionId]);
    if (!sec) return res.status(404).json({ message: 'Section not found' });
    if (['submitted', 'approved'].includes(sec.status)) return res.status(400).json({ message: 'Report is locked' });
    if (req.user.role !== 'admin' && (!canWorkerTouch(sec, req.user) || !sec.can_add_sections))
      return res.status(403).json({ message: 'Not permitted' });
    const [imgs] = await db.query('SELECT public_id FROM quality_report_images WHERE section_id=?', [sec.id]);
    await db.query('DELETE FROM quality_report_sections WHERE id=?', [sec.id]); // images cascade
    for (const im of imgs) { if (im.public_id) deleteFile(im.public_id).catch(() => {}); }
    res.json({ message: 'Section deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ INSPECTION FORM (printed page 2) ═════════════════════════════════════════
// Same access rule as image upload: admin, or the assigned worker, while not locked.
router.put('/quality/reports/:id/inspection', auth, adminOrPermission('quality_report', 'write'),
  auditLog('UPDATE', 'QualityReportInspection'), async (req, res) => {
    const db = await getPool();
    try {
      const [[r]] = await db.query('SELECT id, status, assigned_to FROM quality_reports WHERE id=?', [req.params.id]);
      if (!r) return res.status(404).json({ message: 'Report not found' });
      if (['submitted', 'approved'].includes(r.status))
        return res.status(400).json({ message: `Report is ${r.status} and locked` });
      if (req.user.role !== 'admin' && r.assigned_to !== req.user.id)
        return res.status(403).json({ message: 'This report is not assigned to you' });

      const b = req.body || {};
      const text = (v, max) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
      const qty = {};
      for (const k of ['order_qty', 'inspected_qty', 'accepted_qty', 'rework_qty', 'rejected_qty']) {
        if (b[k] == null || b[k] === '') { qty[k] = null; continue; }
        const n = Number(b[k]);
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: `${k.replace('_', ' ')} must be a positive number` });
        qty[k] = n;
      }
      const outcome = (qty.accepted_qty || 0) + (qty.rework_qty || 0) + (qty.rejected_qty || 0);
      if (qty.inspected_qty != null && outcome > qty.inspected_qty)
        return res.status(400).json({ message: `Accepted + Rework + Rejected (${outcome}) cannot exceed Inspected Qty (${qty.inspected_qty})` });

      if (b.inspection_result != null && b.inspection_result !== '' && !INSPECTION_RESULTS.includes(b.inspection_result))
        return res.status(400).json({ message: 'Invalid inspection result' });
      const items = Array.isArray(b.checklist) ? b.checklist : [];
      for (const it of items) {
        if (it?.result != null && it.result !== '' && !CHECK_RESULTS.includes(it.result))
          return res.status(400).json({ message: `Invalid checklist result "${it.result}"` });
      }
      // Snapshot label/criteria with each result (template rows merged in by key)
      const checklist = mergeChecklist(JSON.stringify(items.map(it => ({ key: it?.key, result: it?.result || null, remark: it?.remark }))))
        .map(({ key, label, criteria, result, remark }) => ({ key, label, criteria, result, remark }));
      if (b.signoff_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.signoff_date))
        return res.status(400).json({ message: 'Invalid sign-off date' });

      await db.query(
        `UPDATE quality_reports SET mo_number=?, drawing_revision=?, finish_code=?, order_qty=?, inspected_qty=?,
           accepted_qty=?, rework_qty=?, rejected_qty=?, checklist_json=?, inspection_result=?, qc_remarks=?,
           production_head=?, signoff_date=?, updated_by=? WHERE id=?`,
        [text(b.mo_number, 100), text(b.drawing_revision, 150), text(b.finish_code, 255),
         qty.order_qty, qty.inspected_qty, qty.accepted_qty, qty.rework_qty, qty.rejected_qty,
         JSON.stringify(checklist), b.inspection_result || null, text(b.qc_remarks, 5000),
         text(b.production_head, 150), b.signoff_date || null, req.user.id, r.id]);
      res.json({ message: 'Inspection form saved' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// ══ SECTION IMAGES ═══════════════════════════════════════════════════════════
router.post('/quality/sections/:sectionId/images', auth, adminOrPermission('quality_report', 'write'),
  moReferenceUpload.array('images', 12), async (req, res) => {
    const db = await getPool();
    try {
      const [[sec]] = await db.query(
        `SELECT s.id, r.status, r.assigned_to FROM quality_report_sections s
         JOIN quality_reports r ON r.id=s.report_id WHERE s.id=?`, [req.params.sectionId]);
      if (!sec) return res.status(404).json({ message: 'Section not found' });
      if (['submitted', 'approved'].includes(sec.status))
        return res.status(400).json({ message: `Report is ${sec.status} and locked` });
      if (req.user.role !== 'admin' && sec.assigned_to !== req.user.id)
        return res.status(403).json({ message: 'This report is not assigned to you' });
      if (!req.files || !req.files.length) return res.status(400).json({ message: 'No images received' });
      const [[mx]] = await db.query('SELECT COALESCE(MAX(sort_order),-1) mo FROM quality_report_images WHERE section_id=?', [sec.id]);
      let order = mx.mo + 1;
      const saved = [];
      for (const f of req.files) {
        const [r] = await db.query(
          'INSERT INTO quality_report_images (section_id, image_path, public_id, caption, corner_note, sort_order, uploaded_by) VALUES (?,?,?,?,?,?,?)',
          [sec.id, f.path, f.filename || f.public_id || null, req.body.caption || null, req.body.corner_note || null, order++, req.user.id]);
        saved.push({ id: r.insertId, image_path: f.path });
      }
      res.json({ message: `${saved.length} image(s) uploaded`, images: saved });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

router.put('/quality/images/:imageId', auth, adminOrPermission('quality_report', 'write'), async (req, res) => {
  const db = await getPool();
  try {
    const [[img]] = await db.query(
      `SELECT im.*, r.status, r.assigned_to FROM quality_report_images im
       JOIN quality_report_sections s ON s.id=im.section_id
       JOIN quality_reports r ON r.id=s.report_id WHERE im.id=?`, [req.params.imageId]);
    if (!img) return res.status(404).json({ message: 'Image not found' });
    if (['submitted', 'approved'].includes(img.status)) return res.status(400).json({ message: 'Report is locked' });
    if (req.user.role !== 'admin' && img.assigned_to !== req.user.id) return res.status(403).json({ message: 'Not permitted' });
    const sets = [], vals = [];
    if (req.body.caption !== undefined) { sets.push('caption=?'); vals.push(req.body.caption); }
    if (req.body.corner_note !== undefined) { sets.push('corner_note=?'); vals.push(req.body.corner_note); }
    if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
    vals.push(img.id);
    await db.query(`UPDATE quality_report_images SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ message: 'Image updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/quality/images/:imageId', auth, adminOrPermission('quality_report', 'write'), async (req, res) => {
  const db = await getPool();
  try {
    const [[img]] = await db.query(
      `SELECT im.*, r.status, r.assigned_to FROM quality_report_images im
       JOIN quality_report_sections s ON s.id=im.section_id
       JOIN quality_reports r ON r.id=s.report_id WHERE im.id=?`, [req.params.imageId]);
    if (!img) return res.status(404).json({ message: 'Image not found' });
    if (['submitted', 'approved'].includes(img.status)) return res.status(400).json({ message: 'Report is locked' });
    if (req.user.role !== 'admin' && img.assigned_to !== req.user.id) return res.status(403).json({ message: 'Not permitted' });
    await db.query('DELETE FROM quality_report_images WHERE id=?', [img.id]);
    if (img.public_id) deleteFile(img.public_id).catch(() => {});
    res.json({ message: 'Image deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ SUBMIT → existing Approvals inbox ════════════════════════════════════════
router.post('/quality/reports/:id/submit', auth, adminOrPermission('quality_report', 'write'),
  auditLog('UPDATE', 'QualityReport'), async (req, res) => {
    const db = await getPool();
    try {
      const [[r]] = await db.query('SELECT * FROM quality_reports WHERE id=?', [req.params.id]);
      if (!r) return res.status(404).json({ message: 'Report not found' });
      if (req.user.role !== 'admin' && r.assigned_to !== req.user.id)
        return res.status(403).json({ message: 'Only the assigned worker or an admin can submit' });
      if (!['assigned', 'rejected'].includes(r.status))
        return res.status(400).json({ message: `Report is ${r.status}` });
      const [[{ c: secCount }]] = await db.query('SELECT COUNT(*) c FROM quality_report_sections WHERE report_id=?', [r.id]);
      if (!secCount) return res.status(400).json({ message: 'Add at least one section before submitting' });
      const [[pending]] = await db.query(
        "SELECT id FROM approvals WHERE type='QUALITY_REPORT' AND related_id=? AND status='PENDING' LIMIT 1", [r.id]);
      if (pending) return res.status(400).json({ message: 'Report is already pending approval' });

      await createApprovalRequest({
        type: 'QUALITY_REPORT', userId: req.user.id, relatedId: r.id,
        requestData: { report_no: r.report_no, client: r.client_name, sku: r.sku_number, sections: secCount },
      });
      await db.query(
        "UPDATE quality_reports SET status='submitted', submitted_by=?, submitted_at=NOW(), rejected_by=NULL, rejected_at=NULL, rejected_reason=NULL WHERE id=?",
        [req.user.id, r.id]);
      res.json({ message: 'Quality report submitted for approval' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// ══ APPROVAL INTEGRATION (registered from server.js) ═════════════════════════
async function resolveQualityReport(approval) {
  const db = await getPool();
  const id = approval.related_id;
  const [[r]] = await db.query('SELECT * FROM quality_reports WHERE id=?', [id]);
  if (!r) throw new Error(`Quality report #${id} not found`);
  if (r.status === 'approved') return { id }; // idempotent
  if (r.status !== 'submitted') throw new Error(`Report is ${r.status}, cannot approve`);
  const [[apr]] = await db.query('SELECT approved_by FROM approvals WHERE id=?', [approval.id]);
  await db.query("UPDATE quality_reports SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?",
    [apr?.approved_by || null, id]);
  return { id };
}

function registerQualityApproval() {
  const { RESOLVERS } = require('../middleware/approvalResolvers');
  const { registerRejectHook } = require('../services/approvalHooks');
  RESOLVERS.QUALITY_REPORT = resolveQualityReport;
  registerRejectHook('QUALITY_REPORT', async (approval, adminId, reason) => {
    // Reject → back to 'assigned' for rework, with reason recorded
    await (await getPool()).query(
      "UPDATE quality_reports SET status='assigned', rejected_by=?, rejected_at=NOW(), rejected_reason=? WHERE id=? AND status='submitted'",
      [adminId, reason || '', approval.related_id]);
  });
  console.log('✅ QUALITY_REPORT approval resolver + reject hook registered');
}

module.exports = router;
module.exports.registerQualityApproval = registerQualityApproval;
