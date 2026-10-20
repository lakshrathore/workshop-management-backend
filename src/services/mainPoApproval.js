// ── MAIN PO Approval Integration (NEW FILE — Phase 1) ────────────────────────
// Registers the MAIN_PO resolver into the EXISTING approval framework from the
// outside: approvalResolvers.js exports its RESOLVERS map, so we add one key at
// startup without editing that file. Existing resolvers are untouched.
//
// Business rules implemented (client-confirmed Q1–Q4):
//  * Approval is HARD-MANDATORY — approval_settings toggles are NOT consulted.
//  * Admin may approve a Main PO created by the same admin (no maker-checker).
//  * Project + project_items are created ONLY here, at approval time, in a
//    transaction, guarded for idempotency (main_pos.project_id IS NULL) so
//    duplicate Projects can never be created.
//  * On reject, the Main PO returns to an editable 'rejected' state with the
//    reason recorded; resubmission creates a fresh approvals row.
//  * Approved Main PO = locked (enforced in mainPoRoutes, and creation here is
//    the terminal transition).

const { getPool } = require('../database');
const { generateProjectId } = require('./projectNumbering');
const { registerRejectHook } = require('./approvalHooks');

async function resolveMainPo(approval /*, dbIgnored */) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  const mainPoId = approval.related_id;
  if (!mainPoId) throw new Error('Main PO id missing on approval record');

  try {
    await conn.beginTransaction();

    const [[po]] = await conn.query('SELECT * FROM main_pos WHERE id=? FOR UPDATE', [mainPoId]);
    if (!po) throw new Error(`Main PO #${mainPoId} not found`);

    // Idempotency guard — double-approve / retry can never duplicate a Project
    if (po.project_id) {
      await conn.commit();
      return { id: mainPoId, project_db_id: po.project_id, note: 'Project already created (idempotent)' };
    }
    if (po.status !== 'submitted') {
      throw new Error(`Main PO ${po.po_no} is not in submitted state (current: ${po.status})`);
    }

    const [items] = await conn.query(
      'SELECT * FROM main_po_items WHERE main_po_id=? ORDER BY sort_order, id', [mainPoId]
    );
    if (items.length === 0) throw new Error(`Main PO ${po.po_no} has no item rows`);

    // Who approved — approvals row is set to APPROVED before resolver runs
    let approvedBy = null;
    try {
      const [[apr]] = await conn.query('SELECT approved_by FROM approvals WHERE id=?', [approval.id]);
      approvedBy = apr?.approved_by || null;
    } catch (e) { /* non-fatal */ }

    // 1. Project — same numbering series as manual creation
    const projectIdStr = await generateProjectId(conn);
    const [pr] = await conn.query(
      `INSERT INTO projects (project_id, name, client_name, description, priority, order_date, notes, created_by, source_main_po_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [projectIdStr, po.project_name, po.client_name || null,
       `Auto-created from Main PO ${po.po_no}`, 'medium',
       po.order_date || null, po.remarks || null,
       po.created_by || approval.user_id, mainPoId]
    );
    const projectDbId = pr.insertId;

    // 2. One project_item per Main PO row
    for (const it of items) {
      const dims = [it.size_length, it.size_width, it.size_thickness].filter(Boolean).join(' x ')
        || it.product_size || null;
      const [pi] = await conn.query(
        `INSERT INTO project_items (project_id, item_name, proto_code, description, quantity, dimensions, notes, area, source_main_po_item_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [projectDbId, it.product_name, it.proto_code || null,
         it.finishes_note || null, Math.max(1, Math.round(Number(it.qty) || 1)),
         dims, it.remark || null, it.area || null, it.id]
      );
      await conn.query('UPDATE main_po_items SET project_item_id=? WHERE id=?', [pi.insertId, it.id]);
    }

    // 3. Lock the Main PO
    await conn.query(
      `UPDATE main_pos SET status='approved', project_id=?, approved_by=?, approved_at=NOW() WHERE id=?`,
      [projectDbId, approvedBy, mainPoId]
    );

    await conn.commit();
    console.log(`✅ MAIN_PO resolver: PO ${po.po_no} → Project ${projectIdStr} (${items.length} items)`);
    // Return the Main PO id so approveRequest keeps approvals.related_id = main_po_id
    return { id: mainPoId, project_db_id: projectDbId, project_id: projectIdStr };
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* noop */ }
    throw err;
  } finally {
    conn.release();
  }
}

async function mainPoRejectHook(approval, adminId, reason) {
  const db = await getPool();
  await db.query(
    `UPDATE main_pos SET status='rejected', rejected_by=?, rejected_at=NOW(), rejected_reason=?
     WHERE id=? AND status='submitted'`,
    [adminId, reason || '', approval.related_id]
  );
}

function registerMainPoApproval() {
  const { RESOLVERS } = require('../middleware/approvalResolvers');
  RESOLVERS.MAIN_PO = resolveMainPo;
  registerRejectHook('MAIN_PO', mainPoRejectHook);
  console.log('✅ MAIN_PO approval resolver + reject hook registered');
}

module.exports = { registerMainPoApproval, resolveMainPo };
