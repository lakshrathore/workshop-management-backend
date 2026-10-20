// ── CASH BOOK Routes (NEW FILE — Phase 3) ────────────────────────────────────
// Mounted in server.js at /api. routes/index.js is NOT modified.
//
// Workflow (client-confirmed Q5):
//  * Worker creates advance request / expense → status 'pending' + approval row
//    (type CASHBOOK_ADVANCE / CASHBOOK_EXPENSE) in the EXISTING Approvals inbox.
//  * Admin approve → status 'approved'; advances get a voucher number
//    (CPV-2026-0001 series) at issue time. Reject → 'rejected' + reason.
//  * Admin-created entries are issued/approved directly ("Admin is responsible
//    for issuing the advance") — no approval row, voucher issued immediately.
//  * Workers can NEVER approve (approve endpoints are adminOnly) and only see
//    their own entries. Balance = Approved Advances − Approved Expenses.
//
// Permission key 'cash_book':
//   read = View own (workers) / all (admin) + Print
//   write = Add advance request / Add expense / upload bills / edit own pending
//   delete = Delete own pending
//   Approve/Reject = admin only via the existing /api/approvals endpoints.

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOnly, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');
const { moReferenceUpload, deleteFile } = require('../services/cloudinaryStorage');
const { createApprovalRequest } = require('../services/approvalService');

const PAYMENT_MODES = ['cash', 'upi', 'cheque', 'bank_transfer'];

// Voucher series: CPV-2026-0001 (full year, 4-digit padded, configurable prefix)
async function generateVoucherNo(db) {
  let prefix = 'CPV';
  try {
    const [[s]] = await db.query(
      "SELECT setting_value FROM app_settings WHERE setting_key='cashbook_voucher_prefix'");
    if (s?.setting_value) prefix = s.setting_value;
  } catch (e) { /* default */ }
  const year = new Date().getFullYear();
  const [last] = await db.query(
    'SELECT voucher_no FROM cashbook_advances WHERE voucher_no IS NOT NULL ORDER BY id DESC LIMIT 1');
  let next = 1;
  if (last.length > 0) {
    const m = last[0].voucher_no?.match(/(\d+)$/);
    if (m) next = parseInt(m[1]) + 1;
  }
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

function isOwnerOrAdmin(req, row) {
  return req.user.role === 'admin' || row.worker_id === req.user.id || row.created_by === req.user.id;
}

// ══ LEDGER MASTER ═════════════════════════════════════════════════════════════
router.get('/cashbook/ledgers', auth, adminOrPermission('cash_book', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const showAll = req.query.all === '1' && req.user.role === 'admin';
    const [rows] = await db.query(
      `SELECT * FROM expense_ledgers ${showAll ? '' : 'WHERE is_active=1'} ORDER BY name`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/cashbook/ledgers', auth, adminOnly, auditLog('CREATE', 'CashBookLedger'), async (req, res) => {
  const db = await getPool();
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Ledger name is required' });
    const [r] = await db.query(
      'INSERT INTO expense_ledgers (name, is_active, created_by) VALUES (?,1,?)', [name, req.user.id]);
    res.json({ id: r.insertId, message: 'Ledger created' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: 'A ledger with this name already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.put('/cashbook/ledgers/:id', auth, adminOnly, auditLog('UPDATE', 'CashBookLedger'), async (req, res) => {
  const db = await getPool();
  try {
    const sets = [], vals = [];
    if (req.body.name !== undefined) { sets.push('name=?'); vals.push(String(req.body.name).trim()); }
    if (req.body.is_active !== undefined) { sets.push('is_active=?'); vals.push(req.body.is_active ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE expense_ledgers SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ message: 'Ledger updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ message: 'A ledger with this name already exists' });
    res.status(500).json({ message: err.message });
  }
});

// ══ ADVANCES ═════════════════════════════════════════════════════════════════
router.get('/cashbook/advances', auth, adminOrPermission('cash_book', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const where = [], params = [];
    if (req.user.role !== 'admin') { where.push('a.worker_id=?'); params.push(req.user.id); }
    else if (req.query.worker_id) { where.push('a.worker_id=?'); params.push(req.query.worker_id); }
    if (req.query.status && req.query.status !== 'all') { where.push('a.status=?'); params.push(req.query.status); }
    const [rows] = await db.query(
      `SELECT a.*, w.name AS worker_name, cu.name AS created_by_name, au.name AS approved_by_name
       FROM cashbook_advances a
       LEFT JOIN users w ON w.id = a.worker_id
       LEFT JOIN users cu ON cu.id = a.created_by
       LEFT JOIN users au ON au.id = a.approved_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.id DESC`, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/cashbook/advances', auth, adminOrPermission('cash_book', 'write'),
  auditLog('CREATE', 'CashBookAdvance'), async (req, res) => {
    const db = await getPool();
    try {
      const b = req.body;
      const amount = Number(b.amount);
      if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than 0' });
      const workerId = req.user.role === 'admin' ? Number(b.worker_id) : req.user.id;
      if (!workerId) return res.status(400).json({ message: 'Select the worker to issue the advance to' });
      if (b.payment_mode && !PAYMENT_MODES.includes(b.payment_mode))
        return res.status(400).json({ message: 'Invalid payment mode' });
      const [[worker]] = await db.query("SELECT id, name FROM users WHERE id=? AND role IN ('worker','admin')", [workerId]);
      if (!worker) return res.status(400).json({ message: 'Worker not found' });

      const isAdmin = req.user.role === 'admin';
      let voucherNo = null;
      if (isAdmin) voucherNo = await generateVoucherNo(db); // admin issues directly

      const [r] = await db.query(
        `INSERT INTO cashbook_advances (voucher_no, worker_id, amount, advance_date, payment_mode, particulars, status,
           created_by, submitted_by, submitted_at, approved_by, approved_at)
         VALUES (?,?,?,?,?,?,?,?,?,NOW(),?,${isAdmin ? 'NOW()' : 'NULL'})`,
        [voucherNo, workerId, amount, b.advance_date || new Date(), b.payment_mode || 'cash',
         b.particulars || null, isAdmin ? 'approved' : 'pending',
         req.user.id, req.user.id, isAdmin ? req.user.id : null]);

      if (!isAdmin) {
        await createApprovalRequest({
          type: 'CASHBOOK_ADVANCE', userId: req.user.id, relatedId: r.insertId,
          requestData: { worker: worker.name, amount, particulars: b.particulars || '', date: b.advance_date || '' },
        });
      }
      res.json({
        id: r.insertId, voucher_no: voucherNo,
        message: isAdmin ? `Advance issued (${voucherNo})` : 'Advance request submitted for approval',
      });
    } catch (err) {
      console.error('Advance create error:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

router.put('/cashbook/advances/:id', auth, adminOrPermission('cash_book', 'write'),
  auditLog('UPDATE', 'CashBookAdvance'), async (req, res) => {
    const db = await getPool();
    try {
      const [[row]] = await db.query('SELECT * FROM cashbook_advances WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ message: 'Advance not found' });
      if (row.status !== 'pending') return res.status(400).json({ message: `Cannot edit a ${row.status} advance` });
      if (!isOwnerOrAdmin(req, row)) return res.status(403).json({ message: 'Not your entry' });
      const b = req.body;
      const amount = Number(b.amount);
      if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than 0' });
      await db.query(
        'UPDATE cashbook_advances SET amount=?, advance_date=?, payment_mode=?, particulars=?, updated_by=? WHERE id=?',
        [amount, b.advance_date || row.advance_date, b.payment_mode || row.payment_mode,
         b.particulars ?? row.particulars, req.user.id, row.id]);
      res.json({ message: 'Advance updated' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

router.delete('/cashbook/advances/:id', auth, adminOrPermission('cash_book', 'delete'),
  auditLog('DELETE', 'CashBookAdvance'), async (req, res) => {
    const db = await getPool();
    try {
      const [[row]] = await db.query('SELECT * FROM cashbook_advances WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ message: 'Advance not found' });
      if (row.status !== 'pending') return res.status(400).json({ message: `Cannot delete a ${row.status} advance` });
      if (!isOwnerOrAdmin(req, row)) return res.status(403).json({ message: 'Not your entry' });
      await db.query('DELETE FROM cashbook_advances WHERE id=?', [row.id]);
      await db.query("UPDATE approvals SET status='CANCELLED' WHERE type='CASHBOOK_ADVANCE' AND related_id=? AND status='PENDING'", [row.id]);
      res.json({ message: 'Advance deleted' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// ══ EXPENSES ═════════════════════════════════════════════════════════════════
router.get('/cashbook/expenses', auth, adminOrPermission('cash_book', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const where = [], params = [];
    if (req.user.role !== 'admin') { where.push('e.worker_id=?'); params.push(req.user.id); }
    else if (req.query.worker_id) { where.push('e.worker_id=?'); params.push(req.query.worker_id); }
    if (req.query.status && req.query.status !== 'all') { where.push('e.status=?'); params.push(req.query.status); }
    const [rows] = await db.query(
      `SELECT e.*, w.name AS worker_name, l.name AS ledger_name, au.name AS approved_by_name
       FROM cashbook_expenses e
       LEFT JOIN users w ON w.id = e.worker_id
       LEFT JOIN expense_ledgers l ON l.id = e.ledger_id
       LEFT JOIN users au ON au.id = e.approved_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY e.id DESC`, params);
    const ids = rows.map(r => r.id);
    let atts = [];
    if (ids.length) {
      [atts] = await db.query('SELECT * FROM cashbook_attachments WHERE expense_id IN (?) ORDER BY id', [ids]);
    }
    res.json(rows.map(r => ({ ...r, attachments: atts.filter(a => a.expense_id === r.id) })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/cashbook/expenses', auth, adminOrPermission('cash_book', 'write'),
  auditLog('CREATE', 'CashBookExpense'), async (req, res) => {
    const db = await getPool();
    try {
      const b = req.body;
      const amount = Number(b.amount);
      if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than 0' });
      if (!b.ledger_id) return res.status(400).json({ message: 'Select an expense ledger' });
      const [[ledger]] = await db.query('SELECT id, name FROM expense_ledgers WHERE id=? AND is_active=1', [b.ledger_id]);
      if (!ledger) return res.status(400).json({ message: 'Ledger not found or inactive' });
      const workerId = req.user.role === 'admin' && b.worker_id ? Number(b.worker_id) : req.user.id;
      const isAdmin = req.user.role === 'admin';

      const [r] = await db.query(
        `INSERT INTO cashbook_expenses (worker_id, ledger_id, expense_date, amount, particulars, status,
           created_by, submitted_by, submitted_at, approved_by, approved_at)
         VALUES (?,?,?,?,?,?,?,?,NOW(),?,${isAdmin ? 'NOW()' : 'NULL'})`,
        [workerId, ledger.id, b.expense_date || new Date(), amount, b.particulars || null,
         isAdmin ? 'approved' : 'pending', req.user.id, req.user.id, isAdmin ? req.user.id : null]);

      if (!isAdmin) {
        const [[worker]] = await db.query('SELECT name FROM users WHERE id=?', [workerId]);
        await createApprovalRequest({
          type: 'CASHBOOK_EXPENSE', userId: req.user.id, relatedId: r.insertId,
          requestData: { worker: worker?.name, ledger: ledger.name, amount, particulars: b.particulars || '', date: b.expense_date || '' },
        });
      }
      res.json({ id: r.insertId, message: isAdmin ? 'Expense recorded (approved)' : 'Expense submitted for approval' });
    } catch (err) {
      console.error('Expense create error:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

router.put('/cashbook/expenses/:id', auth, adminOrPermission('cash_book', 'write'),
  auditLog('UPDATE', 'CashBookExpense'), async (req, res) => {
    const db = await getPool();
    try {
      const [[row]] = await db.query('SELECT * FROM cashbook_expenses WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ message: 'Expense not found' });
      if (row.status !== 'pending') return res.status(400).json({ message: `Cannot edit a ${row.status} expense` });
      if (!isOwnerOrAdmin(req, row)) return res.status(403).json({ message: 'Not your entry' });
      const b = req.body;
      const amount = Number(b.amount);
      if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than 0' });
      if (b.ledger_id) {
        const [[ledger]] = await db.query('SELECT id FROM expense_ledgers WHERE id=? AND is_active=1', [b.ledger_id]);
        if (!ledger) return res.status(400).json({ message: 'Ledger not found or inactive' });
      }
      await db.query(
        'UPDATE cashbook_expenses SET ledger_id=?, expense_date=?, amount=?, particulars=?, updated_by=? WHERE id=?',
        [b.ledger_id || row.ledger_id, b.expense_date || row.expense_date, amount,
         b.particulars ?? row.particulars, req.user.id, row.id]);
      res.json({ message: 'Expense updated' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

router.delete('/cashbook/expenses/:id', auth, adminOrPermission('cash_book', 'delete'),
  auditLog('DELETE', 'CashBookExpense'), async (req, res) => {
    const db = await getPool();
    try {
      const [[row]] = await db.query('SELECT * FROM cashbook_expenses WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ message: 'Expense not found' });
      if (row.status !== 'pending') return res.status(400).json({ message: `Cannot delete a ${row.status} expense` });
      if (!isOwnerOrAdmin(req, row)) return res.status(403).json({ message: 'Not your entry' });
      const [atts] = await db.query('SELECT public_id FROM cashbook_attachments WHERE expense_id=?', [row.id]);
      await db.query('DELETE FROM cashbook_expenses WHERE id=?', [row.id]); // attachments cascade
      for (const a of atts) { if (a.public_id) deleteFile(a.public_id).catch(() => {}); }
      await db.query("UPDATE approvals SET status='CANCELLED' WHERE type='CASHBOOK_EXPENSE' AND related_id=? AND status='PENDING'", [row.id]);
      res.json({ message: 'Expense deleted' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

// ── Expense bill attachments ────────────────────────────────────────────────
router.post('/cashbook/expenses/:id/attachments', auth, adminOrPermission('cash_book', 'write'),
  moReferenceUpload.array('images', 5), async (req, res) => {
    const db = await getPool();
    try {
      const [[row]] = await db.query('SELECT * FROM cashbook_expenses WHERE id=?', [req.params.id]);
      if (!row) return res.status(404).json({ message: 'Expense not found' });
      if (!isOwnerOrAdmin(req, row)) return res.status(403).json({ message: 'Not your entry' });
      if (row.status === 'rejected') return res.status(400).json({ message: 'Cannot attach bills to a rejected expense' });
      if (row.status === 'approved' && req.user.role !== 'admin')
        return res.status(400).json({ message: 'Expense already approved — ask admin to attach' });
      if (!req.files || !req.files.length) return res.status(400).json({ message: 'No images received' });
      const saved = [];
      for (const f of req.files) {
        const [r] = await db.query(
          'INSERT INTO cashbook_attachments (expense_id, image_path, public_id, caption, uploaded_by) VALUES (?,?,?,?,?)',
          [row.id, f.path, f.filename || f.public_id || null, req.body.caption || null, req.user.id]);
        saved.push({ id: r.insertId, image_path: f.path });
      }
      res.json({ message: `${saved.length} bill image(s) attached`, attachments: saved });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

router.delete('/cashbook/attachments/:id', auth, adminOrPermission('cash_book', 'write'), async (req, res) => {
  const db = await getPool();
  try {
    const [[att]] = await db.query(
      `SELECT a.*, e.status, e.worker_id, e.created_by AS exp_created_by
       FROM cashbook_attachments a JOIN cashbook_expenses e ON e.id = a.expense_id WHERE a.id=?`, [req.params.id]);
    if (!att) return res.status(404).json({ message: 'Attachment not found' });
    const own = req.user.role === 'admin' || att.worker_id === req.user.id || att.exp_created_by === req.user.id;
    if (!own) return res.status(403).json({ message: 'Not your entry' });
    if (att.status !== 'pending' && req.user.role !== 'admin')
      return res.status(400).json({ message: 'Entry is decided — ask admin' });
    await db.query('DELETE FROM cashbook_attachments WHERE id=?', [att.id]);
    if (att.public_id) deleteFile(att.public_id).catch(() => {});
    res.json({ message: 'Attachment deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ BALANCES: Advance − Approved Expenses = Remaining ════════════════════════
router.get('/cashbook/balances', auth, adminOrPermission('cash_book', 'read'), async (req, res) => {
  const db = await getPool();
  try {
    const workerFilter = req.user.role !== 'admin' ? 'WHERE u.id=?' : '';
    const params = req.user.role !== 'admin' ? [req.user.id] : [];
    const [rows] = await db.query(
      `SELECT u.id AS worker_id, u.name AS worker_name,
              COALESCE((SELECT SUM(a.amount) FROM cashbook_advances a WHERE a.worker_id=u.id AND a.status='approved'),0) AS total_advance,
              COALESCE((SELECT SUM(e.amount) FROM cashbook_expenses e WHERE e.worker_id=u.id AND e.status='approved'),0) AS total_expenses,
              COALESCE((SELECT SUM(e2.amount) FROM cashbook_expenses e2 WHERE e2.worker_id=u.id AND e2.status='pending'),0) AS pending_expenses
       FROM users u
       ${workerFilter}
       ${workerFilter ? '' : `WHERE u.role IN ('worker','admin') AND (
         EXISTS(SELECT 1 FROM cashbook_advances a2 WHERE a2.worker_id=u.id) OR
         EXISTS(SELECT 1 FROM cashbook_expenses e3 WHERE e3.worker_id=u.id))`}
       ORDER BY u.name`, params);
    res.json(rows.map(r => ({
      ...r,
      total_advance: Number(r.total_advance),
      total_expenses: Number(r.total_expenses),
      pending_expenses: Number(r.pending_expenses),
      balance: Number((Number(r.total_advance) - Number(r.total_expenses)).toFixed(2)),
    })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══ APPROVAL INTEGRATION (registered from server.js, same pattern as MAIN_PO) ═
async function resolveCashbookAdvance(approval) {
  const db = await getPool();
  const id = approval.related_id;
  const [[row]] = await db.query('SELECT * FROM cashbook_advances WHERE id=?', [id]);
  if (!row) throw new Error(`Advance #${id} not found (may have been deleted)`);
  if (row.status === 'approved') return { id }; // idempotent
  if (row.status !== 'pending') throw new Error(`Advance is ${row.status}, cannot approve`);
  const [[apr]] = await db.query('SELECT approved_by FROM approvals WHERE id=?', [approval.id]);
  const voucherNo = row.voucher_no || await generateVoucherNo(db);
  await db.query(
    "UPDATE cashbook_advances SET status='approved', voucher_no=?, approved_by=?, approved_at=NOW() WHERE id=?",
    [voucherNo, apr?.approved_by || null, id]);
  return { id, voucher_no: voucherNo };
}

async function resolveCashbookExpense(approval) {
  const db = await getPool();
  const id = approval.related_id;
  const [[row]] = await db.query('SELECT * FROM cashbook_expenses WHERE id=?', [id]);
  if (!row) throw new Error(`Expense #${id} not found (may have been deleted)`);
  if (row.status === 'approved') return { id }; // idempotent
  if (row.status !== 'pending') throw new Error(`Expense is ${row.status}, cannot approve`);
  const [[apr]] = await db.query('SELECT approved_by FROM approvals WHERE id=?', [approval.id]);
  await db.query(
    "UPDATE cashbook_expenses SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?",
    [apr?.approved_by || null, id]);
  return { id };
}

function registerCashbookApproval() {
  const { RESOLVERS } = require('../middleware/approvalResolvers');
  const { registerRejectHook } = require('../services/approvalHooks');
  RESOLVERS.CASHBOOK_ADVANCE = resolveCashbookAdvance;
  RESOLVERS.CASHBOOK_EXPENSE = resolveCashbookExpense;
  registerRejectHook('CASHBOOK_ADVANCE', async (approval, adminId, reason) => {
    await (await getPool()).query(
      "UPDATE cashbook_advances SET status='rejected', rejected_by=?, rejected_at=NOW(), rejected_reason=? WHERE id=? AND status='pending'",
      [adminId, reason || '', approval.related_id]);
  });
  registerRejectHook('CASHBOOK_EXPENSE', async (approval, adminId, reason) => {
    await (await getPool()).query(
      "UPDATE cashbook_expenses SET status='rejected', rejected_by=?, rejected_at=NOW(), rejected_reason=? WHERE id=? AND status='pending'",
      [adminId, reason || '', approval.related_id]);
  });
  console.log('✅ CASHBOOK approval resolvers + reject hooks registered');
}

module.exports = router;
module.exports.registerCashbookApproval = registerCashbookApproval;
