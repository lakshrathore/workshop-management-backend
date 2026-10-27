// ─────────────────────────────────────────────────────────────────────────────
//  "Ask Moji" — READ-ONLY tools the AI assistant can call (Phase 1, admin only).
//
//  Rules for every tool here:
//   • SELECT only. No INSERT / UPDATE / DELETE, ever (Phase 1 is read-only).
//   • All user-supplied values go through `?` placeholders — never string-built SQL.
//   • Result rows are capped (MAX_ROWS) so one question can't dump a whole table.
//   • Never return password hashes or other secrets.
// ─────────────────────────────────────────────────────────────────────────────

const { propose } = require('./aiActions');

const MAX_ROWS = 40;

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const like = (s) => `%${String(s).trim().replace(/[%_\\]/g, '\\$&')}%`;
const lim = (n, d = 25) => Math.min(Math.max(parseInt(n, 10) || d, 1), MAX_ROWS);
const num = (v) => (v === null || v === undefined ? v : Number(v));

// Builds "AND col >= ? AND col <= ?" for optional from/to dates.
function dateRange(col, a, where, params) {
  if (isDate(a.from)) { where.push(`${col} >= ?`); params.push(a.from); }
  if (isDate(a.to)) { where.push(`${col} <= ?`); params.push(a.to); }
}

const tools = [];
function tool(name, description, properties, handler, required = []) {
  tools.push({
    def: { name, description, input_schema: { type: 'object', properties, required } },
    handler,
  });
}

const S = (d) => ({ type: 'string', description: d });
const N = (d) => ({ type: 'integer', description: d });
const DATE_FROM = S('Start date YYYY-MM-DD (optional)');
const DATE_TO = S('End date YYYY-MM-DD (optional)');
const LIMIT = N(`Max rows (default 25, max ${MAX_ROWS})`);

// ── Overview ────────────────────────────────────────────────────────────────
tool('dashboard_summary',
  'One-shot company overview: active projects, running/waiting tasks, pending approvals, client PO outstanding balance, draft/sent quotations. Use for broad questions like "aaj ka status kya hai?".',
  {},
  async (db) => {
    const [[p]] = await db.query(`SELECT SUM(status='active') active_projects, SUM(status='on_hold') on_hold_projects, SUM(status='completed') completed_projects FROM projects WHERE status<>'deleted'`);
    const [[t]] = await db.query(`SELECT SUM(status='in_progress') tasks_in_progress, SUM(status='pending') tasks_pending, SUM(status IN ('waiting','on_hold')) tasks_waiting_or_on_hold, SUM(status<>'completed' AND due_date IS NOT NULL AND due_date < CURDATE()) tasks_overdue FROM task_assignments`);
    const [[a]] = await db.query(`SELECT COUNT(*) pending_approvals FROM approvals WHERE status='PENDING'`);
    const [[c]] = await db.query(`SELECT COUNT(*) open_client_pos, COALESCE(SUM(total_amount-paid_amount),0) client_po_outstanding FROM client_purchase_orders WHERE status NOT IN ('completed','cancelled') AND total_amount>paid_amount`);
    const [[q]] = await db.query(`SELECT SUM(status='draft') draft_quotations, SUM(status='sent') sent_quotations FROM quotations`);
    return { projects: p, tasks: t, ...a, client_pos: c, quotations: q, as_of: new Date().toISOString().slice(0, 10) };
  });

// ── Projects & production ───────────────────────────────────────────────────
tool('list_projects',
  'List projects with client, status, priority, deadline and how many items are completed. Filter by status or by name/client text.',
  {
    status: S('active | on_hold | completed | inactive | cancelled (optional)'),
    search: S('Text in project name or client name (optional)'),
    limit: LIMIT,
  },
  async (db, a) => {
    const where = [`p.status <> 'deleted'`]; const params = [];
    if (a.status) { where.push('p.status = ?'); params.push(a.status); }
    if (a.search) { where.push('(p.name LIKE ? OR p.client_name LIKE ?)'); params.push(like(a.search), like(a.search)); }
    const [rows] = await db.query(
      `SELECT p.id, p.name, p.client_name, p.status, p.priority, p.order_date, p.deadline, p.total_amount,
              (SELECT COUNT(*) FROM project_items i WHERE i.project_id = p.id) AS items_total,
              (SELECT COUNT(*) FROM project_items i WHERE i.project_id = p.id AND i.status = 'completed') AS items_completed
         FROM projects p WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows;
  });

tool('get_project',
  'Full status of ONE project: its items, and every production task (stage, worker, department, qty done, due date). Pass project_id or part of the project name.',
  { project_id: N('Project id (optional)'), name: S('Part of project name (optional)') },
  async (db, a) => {
    let p;
    if (a.project_id) [[p]] = await db.query(`SELECT * FROM projects WHERE id = ? AND status <> 'deleted'`, [a.project_id]);
    else if (a.name) [[p]] = await db.query(`SELECT * FROM projects WHERE name LIKE ? AND status <> 'deleted' ORDER BY created_at DESC LIMIT 1`, [like(a.name)]);
    if (!p) return { error: 'Project nahi mila. list_projects se naam check karo.' };
    const [items] = await db.query(`SELECT id, item_name, proto_code, quantity, unit, material, status FROM project_items WHERE project_id = ? ORDER BY id LIMIT 100`, [p.id]);
    const [tasks] = await db.query(
      `SELECT ta.id, pi.item_name, ta.task_title, ta.stage_order, ta.status, ta.priority, ta.quantity_assigned, ta.quantity_completed,
              ta.due_date, u.name AS worker, d.name AS department
         FROM task_assignments ta
         LEFT JOIN project_items pi ON pi.id = ta.project_item_id
         LEFT JOIN users u ON u.id = ta.worker_id
         LEFT JOIN departments d ON d.id = ta.department_id
        WHERE ta.project_id = ? ORDER BY pi.id, ta.stage_order LIMIT 150`, [p.id]);
    return {
      project: { id: p.id, name: p.name, client_name: p.client_name, status: p.status, priority: p.priority, order_date: p.order_date, deadline: p.deadline, total_amount: num(p.total_amount), notes: p.notes },
      items, tasks,
    };
  });

tool('list_tasks',
  'Production tasks across all projects. Use for "kaun se items waiting hain", "overdue tasks", "kis worker ke paas kya hai". Filter by status, worker name, project name, or overdue only.',
  {
    status: S('pending | in_progress | completed | on_hold | waiting (optional)'),
    worker: S('Part of worker name (optional)'),
    project: S('Part of project name (optional)'),
    overdue_only: { type: 'boolean', description: 'Only tasks past due date and not completed' },
    limit: LIMIT,
  },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.status) { where.push('ta.status = ?'); params.push(a.status); }
    if (a.worker) { where.push('u.name LIKE ?'); params.push(like(a.worker)); }
    if (a.project) { where.push('p.name LIKE ?'); params.push(like(a.project)); }
    if (a.overdue_only) where.push(`ta.status <> 'completed' AND ta.due_date IS NOT NULL AND ta.due_date < CURDATE()`);
    const [rows] = await db.query(
      `SELECT ta.id, p.name AS project, pi.item_name, ta.task_title, ta.status, ta.priority, ta.quantity_assigned, ta.quantity_completed,
              ta.start_date, ta.due_date, u.name AS worker, d.name AS department, ta.admin_notes
         FROM task_assignments ta
         LEFT JOIN projects p ON p.id = ta.project_id
         LEFT JOIN project_items pi ON pi.id = ta.project_item_id
         LEFT JOIN users u ON u.id = ta.worker_id
         LEFT JOIN departments d ON d.id = ta.department_id
        WHERE ${where.join(' AND ')} ORDER BY ta.due_date IS NULL, ta.due_date LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows;
  });

tool('daily_progress',
  'Daily production progress entries (qty done per item per worker per day). Filter by date range, project name or worker name.',
  { from: DATE_FROM, to: DATE_TO, project: S('Part of project name (optional)'), worker: S('Part of worker name (optional)'), limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    dateRange('dp.work_date', a, where, params);
    if (a.project) { where.push('p.name LIKE ?'); params.push(like(a.project)); }
    if (a.worker) { where.push('u.name LIKE ?'); params.push(like(a.worker)); }
    const [rows] = await db.query(
      `SELECT dp.work_date, p.name AS project, pi.item_name, d.name AS department, u.name AS worker, dp.qty_done, dp.notes
         FROM daily_progress dp
         LEFT JOIN project_items pi ON pi.id = dp.project_item_id
         LEFT JOIN projects p ON p.id = pi.project_id
         LEFT JOIN departments d ON d.id = dp.department_id
         LEFT JOIN users u ON u.id = dp.worker_id
        WHERE ${where.join(' AND ')} ORDER BY dp.work_date DESC, dp.id DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows;
  });

// ── Orders, quotations, billing ─────────────────────────────────────────────
tool('manufacturing_orders',
  'Manufacturing Orders (Main PO): number, project, client, status (draft/submitted/approved/rejected), number of line items.',
  { status: S('draft | submitted | approved | rejected (optional)'), search: S('Text in PO no / project / client (optional)'), limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.status) { where.push('m.status = ?'); params.push(a.status); }
    if (a.search) { where.push('(m.po_no LIKE ? OR m.project_name LIKE ? OR m.client_name LIKE ?)'); params.push(like(a.search), like(a.search), like(a.search)); }
    const [rows] = await db.query(
      `SELECT m.id, m.po_no, m.project_name, m.client_name, m.order_date, m.timelines, m.status, m.rejected_reason,
              (SELECT COUNT(*) FROM main_po_items i WHERE i.main_po_id = m.id) AS line_items
         FROM main_pos m WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows;
  });

tool('client_pos',
  'Client Purchase Orders with total, paid and balance. Use for "kis client ka payment pending hai". Set outstanding_only for unpaid balance.',
  {
    client: S('Part of client name (optional)'),
    status: S('pending | acknowledged | processing | payment_pending | advance_pending | completed | cancelled (optional)'),
    outstanding_only: { type: 'boolean', description: 'Only POs where balance > 0' },
    limit: LIMIT,
  },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.client) { where.push('u.name LIKE ?'); params.push(like(a.client)); }
    if (a.status) { where.push('c.status = ?'); params.push(a.status); }
    if (a.outstanding_only) where.push(`c.total_amount > c.paid_amount AND c.status <> 'cancelled'`);
    const [rows] = await db.query(
      `SELECT c.id, c.po_number, u.name AS client, c.order_date, c.due_date, c.status, c.total_amount, c.paid_amount,
              (c.total_amount - c.paid_amount) AS balance
         FROM client_purchase_orders c LEFT JOIN users u ON u.id = c.client_id
        WHERE ${where.join(' AND ')} ORDER BY balance DESC, c.order_date DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows.map(r => ({ ...r, total_amount: num(r.total_amount), paid_amount: num(r.paid_amount), balance: num(r.balance) }));
  });

tool('client_payments',
  'Payments received against client POs (date, amount, mode, reference). Filter by date range or client name.',
  { from: DATE_FROM, to: DATE_TO, client: S('Part of client name (optional)'), limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    dateRange('pay.payment_date', a, where, params);
    if (a.client) { where.push('u.name LIKE ?'); params.push(like(a.client)); }
    const [rows] = await db.query(
      `SELECT pay.payment_date, u.name AS client, c.po_number, pay.amount, pay.payment_mode, pay.bank_name, pay.utr_reference, pay.is_advance
         FROM client_po_payments pay
         LEFT JOIN client_purchase_orders c ON c.id = pay.po_id
         LEFT JOIN users u ON u.id = pay.client_id
        WHERE ${where.join(' AND ')} ORDER BY pay.payment_date DESC, pay.id DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    const [[tot]] = await db.query(`SELECT COALESCE(SUM(pay.amount),0) AS total FROM client_po_payments pay LEFT JOIN users u ON u.id = pay.client_id WHERE ${where.join(' AND ')}`, params);
    return { total_in_filter: num(tot.total), rows: rows.map(r => ({ ...r, amount: num(r.amount) })) };
  });

tool('quotations',
  'Quotations: number, revision, client, status (draft/sent/accepted/rejected/revised), totals.',
  { status: S('draft | sent | accepted | rejected | revised (optional)'), search: S('Text in quote no / client / subject (optional)'), from: DATE_FROM, to: DATE_TO, limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.status) { where.push('q.status = ?'); params.push(a.status); }
    if (a.search) { where.push('(q.quote_no LIKE ? OR q.client_name LIKE ? OR q.subject LIKE ?)'); params.push(like(a.search), like(a.search), like(a.search)); }
    dateRange('q.quote_date', a, where, params);
    const [rows] = await db.query(
      `SELECT q.id, q.quote_no, q.revision, q.client_name, q.subject, q.quote_date, q.valid_until, q.status, q.total_amount, q.reject_reason
         FROM quotations q WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows.map(r => ({ ...r, total_amount: num(r.total_amount) }));
  });

tool('sale_challans',
  'Sale / delivery challans: number, client, date, type, status, total, vehicle. Filter by status, client or date range.',
  { status: S('draft | sent | delivered | cancelled (optional)'), client: S('Part of client name (optional)'), from: DATE_FROM, to: DATE_TO, limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.status) { where.push('s.status = ?'); params.push(a.status); }
    if (a.client) { where.push('s.client_name LIKE ?'); params.push(like(a.client)); }
    dateRange('s.challan_date', a, where, params);
    const [rows] = await db.query(
      `SELECT s.id, s.challan_number, s.client_name, s.challan_date, s.delivery_date, s.challan_type, s.status, s.total_amount, s.transport_name, s.vehicle_number
         FROM sale_challans s WHERE ${where.join(' AND ')} ORDER BY s.challan_date DESC, s.id DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    const [[tot]] = await db.query(`SELECT COALESCE(SUM(s.total_amount),0) AS total FROM sale_challans s WHERE ${where.join(' AND ')}`, params);
    return { total_in_filter: num(tot.total), rows: rows.map(r => ({ ...r, total_amount: num(r.total_amount) })) };
  });

// ── Wood / CFT ──────────────────────────────────────────────────────────────
const WOOD_MOVES = `
  SELECT wt.name AS wood_name, 1 AS sign, r.qty AS qty, r.net_cft AS cft, wi.inward_date AS dt,
         IF(wi.entry_type='opening','opening','inward') AS kind
    FROM wood_inward_rows r JOIN wood_inwards wi ON wi.id = r.inward_id JOIN wood_types wt ON wt.id = wi.wood_type_id
   WHERE r.qty > 0
  UNION ALL
  SELECT COALESCE(wt.name, NULLIF(TRIM(cs.wood_type), ''), '(no wood type)'), IF(r.row_type='issue', -1, 1), r.qty, r.net_cft,
         DATE(COALESCE(cs.approved_at, cs.submitted_at, cs.created_at)), IF(r.row_type='issue','outward','return')
    FROM cft_rows r JOIN cft_sheets cs ON cs.id = r.sheet_id LEFT JOIN wood_types wt ON wt.id = cs.wood_type_id
   WHERE r.row_type IN ('issue','return') AND r.qty > 0 AND cs.status IN ('approved','submitted')`;

tool('wood_stock',
  'Current wood stock (closing CFT and pieces) per wood type = opening + inward + returns − issued. Optionally filter by wood type name.',
  { wood: S('Part of wood type name (optional)') },
  async (db, a) => {
    const params = []; let outer = '';
    if (a.wood) { outer = 'WHERE wood_name LIKE ?'; params.push(like(a.wood)); }
    const [rows] = await db.query(
      `SELECT wood_name, ROUND(SUM(sign*cft),2) AS stock_cft, ROUND(SUM(sign*qty),2) AS stock_pieces
         FROM (${WOOD_MOVES}) m ${outer} GROUP BY wood_name ORDER BY wood_name`, params);
    return rows.map(r => ({ ...r, stock_cft: num(r.stock_cft), stock_pieces: num(r.stock_pieces) }));
  });

tool('wood_movement',
  'Wood CFT received (inward), issued (outward) and returned in a date range, per wood type. Use for "is mahine kitni CFT sagwan aayi?".',
  { from: DATE_FROM, to: DATE_TO, wood: S('Part of wood type name (optional)') },
  async (db, a) => {
    const where = ["kind <> 'opening'"]; const params = [];
    if (isDate(a.from)) { where.push('dt >= ?'); params.push(a.from); }
    if (isDate(a.to)) { where.push('dt <= ?'); params.push(a.to); }
    if (a.wood) { where.push('wood_name LIKE ?'); params.push(like(a.wood)); }
    const [rows] = await db.query(
      `SELECT wood_name,
              ROUND(SUM(IF(kind='inward', cft, 0)),2) AS inward_cft,
              ROUND(SUM(IF(kind='outward', cft, 0)),2) AS issued_cft,
              ROUND(SUM(IF(kind='return', cft, 0)),2) AS returned_cft
         FROM (${WOOD_MOVES}) m WHERE ${where.join(' AND ')} GROUP BY wood_name ORDER BY wood_name`, params);
    return rows.map(r => ({ wood_name: r.wood_name, inward_cft: num(r.inward_cft), issued_cft: num(r.issued_cft), returned_cft: num(r.returned_cft) }));
  });

tool('cft_sheets',
  'CFT sheets (wood demand/issue per project item): sheet no, project, item, wood type, status, demand/required/issued/returned CFT.',
  { status: S('Sheet status, e.g. draft | submitted | approved | rejected (optional)'), project: S('Part of project name (optional)'), limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.status) { where.push('cs.status = ?'); params.push(a.status); }
    if (a.project) { where.push('p.name LIKE ?'); params.push(like(a.project)); }
    const [rows] = await db.query(
      `SELECT cs.id, cs.sheet_no, p.name AS project, pi.item_name, COALESCE(wt.name, cs.wood_type) AS wood_type, cs.status,
              cs.total_demand_cft, cs.total_required_cft, cs.total_issue_cft, cs.total_return_cft, cs.net_difference
         FROM cft_sheets cs
         LEFT JOIN projects p ON p.id = cs.project_id
         LEFT JOIN project_items pi ON pi.id = cs.project_item_id
         LEFT JOIN wood_types wt ON wt.id = cs.wood_type_id
        WHERE ${where.join(' AND ')} ORDER BY cs.created_at DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows.map(r => ({ ...r, total_demand_cft: num(r.total_demand_cft), total_required_cft: num(r.total_required_cft), total_issue_cft: num(r.total_issue_cft), total_return_cft: num(r.total_return_cft), net_difference: num(r.net_difference) }));
  });

// ── Packing, quality ────────────────────────────────────────────────────────
tool('packing_boxes',
  'Packing boxes: box number, project, item, number of line items inside, date. Filter by project name.',
  { project: S('Part of project name (optional)'), limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.project) { where.push('p.name LIKE ?'); params.push(like(a.project)); }
    const [rows] = await db.query(
      `SELECT b.id, b.box_number, p.name AS project, pi.item_name, b.mode, b.notes, b.created_at,
              (SELECT COUNT(*) FROM packing_box_items x WHERE x.box_id = b.id) AS lines_inside,
              (SELECT COALESCE(SUM(x.quantity),0) FROM packing_box_items x WHERE x.box_id = b.id) AS total_qty_inside
         FROM packing_boxes b
         LEFT JOIN projects p ON p.id = b.project_id
         LEFT JOIN project_items pi ON pi.id = b.project_item_id
        WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows.map(r => ({ ...r, total_qty_inside: num(r.total_qty_inside) }));
  });

tool('quality_reports',
  'QC / quality inspection reports: number, project, item, level, status (draft/assigned/submitted/approved/rejected), inspection date, rejection reason.',
  { status: S('draft | assigned | submitted | approved | rejected (optional)'), project: S('Part of project name (optional)'), from: DATE_FROM, to: DATE_TO, limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.status) { where.push('q.status = ?'); params.push(a.status); }
    if (a.project) { where.push('p.name LIKE ?'); params.push(like(a.project)); }
    dateRange('q.inspection_date', a, where, params);
    const [rows] = await db.query(
      `SELECT q.id, q.report_no, p.name AS project, pi.item_name, q.client_name, q.inspection_level, q.inspection_date, q.status, q.rejected_reason
         FROM quality_reports q
         LEFT JOIN projects p ON p.id = q.project_id
         LEFT JOIN project_items pi ON pi.id = q.project_item_id
        WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows;
  });

// ── Money (cashbook), people, approvals ─────────────────────────────────────
tool('cashbook_summary',
  'Cash book totals per worker for a date range: approved expenses, approved advances, and counts still pending approval.',
  { from: DATE_FROM, to: DATE_TO, worker: S('Part of worker name (optional)') },
  async (db, a) => {
    const w1 = ['1=1']; const p1 = []; const w2 = ['1=1']; const p2 = [];
    dateRange('e.expense_date', a, w1, p1); dateRange('v.advance_date', a, w2, p2);
    if (a.worker) { w1.push('u.name LIKE ?'); p1.push(like(a.worker)); w2.push('u.name LIKE ?'); p2.push(like(a.worker)); }
    const [exp] = await db.query(
      `SELECT u.name AS worker, SUM(e.status='approved') AS approved_count, COALESCE(SUM(IF(e.status='approved', e.amount, 0)),0) AS approved_expense,
              SUM(e.status='pending') AS pending_count, COALESCE(SUM(IF(e.status='pending', e.amount, 0)),0) AS pending_expense
         FROM cashbook_expenses e LEFT JOIN users u ON u.id = e.worker_id WHERE ${w1.join(' AND ')} GROUP BY u.name ORDER BY approved_expense DESC LIMIT ?`,
      [...p1, MAX_ROWS]);
    const [adv] = await db.query(
      `SELECT u.name AS worker, COALESCE(SUM(IF(v.status='approved', v.amount, 0)),0) AS approved_advance,
              COALESCE(SUM(IF(v.status='pending', v.amount, 0)),0) AS pending_advance
         FROM cashbook_advances v LEFT JOIN users u ON u.id = v.worker_id WHERE ${w2.join(' AND ')} GROUP BY u.name ORDER BY approved_advance DESC LIMIT ?`,
      [...p2, MAX_ROWS]);
    const fix = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
    return { expenses_by_worker: exp.map(fix), advances_by_worker: adv.map(fix) };
  });

tool('time_report',
  'Worker attendance / working hours from clock-in logs in a date range: total hours and number of logs per worker.',
  { from: DATE_FROM, to: DATE_TO, worker: S('Part of worker name (optional)') },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (isDate(a.from)) { where.push('DATE(l.clock_in) >= ?'); params.push(a.from); }
    if (isDate(a.to)) { where.push('DATE(l.clock_in) <= ?'); params.push(a.to); }
    if (a.worker) { where.push('u.name LIKE ?'); params.push(like(a.worker)); }
    const [rows] = await db.query(
      `SELECT u.name AS worker, COUNT(*) AS logs, COUNT(DISTINCT DATE(l.clock_in)) AS days_worked,
              ROUND(COALESCE(SUM(l.duration_minutes),0)/60, 1) AS total_hours
         FROM worker_time_logs l LEFT JOIN users u ON u.id = l.worker_id
        WHERE ${where.join(' AND ')} GROUP BY u.name ORDER BY total_hours DESC LIMIT ?`,
      [...params, MAX_ROWS]);
    return rows.map(r => ({ ...r, total_hours: num(r.total_hours) }));
  });

tool('pending_approvals',
  'Requests waiting for admin approval (project, item, challan, PO status, sale): type, who requested, when.',
  { type: S('PROJECT | ITEM | CHALLAN | PO_STATUS | SALE (optional)'), limit: LIMIT },
  async (db, a) => {
    const where = [`a.status = 'PENDING'`]; const params = [];
    if (a.type) { where.push('a.type = ?'); params.push(a.type); }
    const [rows] = await db.query(
      `SELECT a.id, a.type, a.related_id, u.name AS requested_by, a.created_at, LEFT(a.requested_data, 250) AS request_preview
         FROM approvals a LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ?`,
      [...params, lim(a.limit)]);
    return rows;
  });

tool('list_workers',
  'Workers with their departments and number of open tasks. Use to find a worker or to see who is free/busy.',
  { search: S('Part of worker name (optional)') },
  async (db, a) => {
    const where = [`u.role = 'worker'`, 'u.is_active = 1']; const params = [];
    if (a.search) { where.push('u.name LIKE ?'); params.push(like(a.search)); }
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.phone,
              (SELECT GROUP_CONCAT(d.name SEPARATOR ', ') FROM worker_departments wd JOIN departments d ON d.id = wd.department_id WHERE wd.worker_id = u.id) AS departments,
              (SELECT COUNT(*) FROM task_assignments t WHERE t.worker_id = u.id AND t.status IN ('pending','in_progress')) AS open_tasks
         FROM users u WHERE ${where.join(' AND ')} ORDER BY u.name LIMIT ?`,
      [...params, MAX_ROWS]);
    return rows;
  });


// ── Alerts (SQL only, no AI) — also exposed to the model and to GET /api/ai/alerts ──
async function getAlerts(db) {
  const out = [];
  const add = (key, level, title, count, ask, examples) => { if (count > 0) out.push({ key, level, title, count, ask, examples: examples || [] }); };

  const [od] = await db.query(
    `SELECT p.name AS project, pi.item_name, ta.task_title, ta.due_date, u.name AS worker
       FROM task_assignments ta LEFT JOIN projects p ON p.id = ta.project_id LEFT JOIN project_items pi ON pi.id = ta.project_item_id LEFT JOIN users u ON u.id = ta.worker_id
      WHERE ta.status <> 'completed' AND ta.status <> 'waiting' AND ta.due_date IS NOT NULL AND ta.due_date < CURDATE() ORDER BY ta.due_date LIMIT 200`);
  add('overdue_tasks', 'high', 'Overdue tasks', od.length, 'Overdue tasks kaun se hain?',
    od.slice(0, 3).map(r => `${r.project || '—'} · ${r.item_name || r.task_title} (${r.worker || 'unassigned'})`));

  const [[ap]] = await db.query(`SELECT COUNT(*) c FROM approvals WHERE status = 'PENDING'`);
  add('pending_approvals', 'medium', 'Approvals pending', ap.c, 'Pending approvals dikhao', []);

  const [po] = await db.query(
    `SELECT c.po_number, u.name AS client, (c.total_amount - COALESCE((SELECT SUM(amount) FROM client_po_payments WHERE po_id = c.id),0)) AS balance
       FROM client_purchase_orders c LEFT JOIN users u ON u.id = c.client_id
      WHERE c.status NOT IN ('cancelled','completed') AND c.due_date IS NOT NULL AND c.due_date < CURDATE() HAVING balance > 0 ORDER BY balance DESC LIMIT 200`);
  add('overdue_payments', 'high', 'Client payments overdue', po.length, 'Kis client ka payment pending hai?',
    po.slice(0, 3).map(r => `${r.client || '—'} · ${r.po_number} (₹${Number(r.balance).toLocaleString('en-IN')})`));

  const [tk] = await db.query(
    `SELECT ct.id, ct.subject, u.name AS client FROM client_tickets ct JOIN users u ON u.id = ct.client_id
      WHERE ct.status IN ('open','in_progress')
        AND (SELECT m.sender_role FROM client_ticket_messages m WHERE m.ticket_id = ct.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) = 'client' LIMIT 200`);
  add('tickets_waiting', 'medium', 'Client tickets awaiting reply', tk.length, 'Kaun se client tickets reply ka wait kar rahe hain?',
    tk.slice(0, 3).map(r => `${r.client} · ${r.subject}`));

  const [pr] = await db.query(`SELECT name, deadline FROM projects WHERE status = 'active' AND deadline IS NOT NULL AND deadline < CURDATE() ORDER BY deadline LIMIT 200`);
  add('projects_past_deadline', 'high', 'Projects past deadline', pr.length, 'Kaun se projects deadline cross kar chuke hain?', pr.slice(0, 3).map(r => r.name));

  const [qt] = await db.query(`SELECT quote_no, client_name FROM quotations WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at < (NOW() - INTERVAL 7 DAY) LIMIT 200`);
  add('stale_quotations', 'medium', 'Quotations sent 7+ days ago, no decision', qt.length, 'Kaun si quotations ka 7 din se jawab nahi aaya?', qt.slice(0, 3).map(r => `${r.quote_no} · ${r.client_name || '—'}`));

  return out;
}

tool('alerts',
  'Things that need attention right now: overdue tasks, overdue client payments, projects past deadline, tickets awaiting reply, pending approvals, stale quotations. Use for "aaj ka brief", "kya urgent hai?".',
  {},
  async (db) => ({ as_of: new Date().toISOString().slice(0, 10), alerts: await getAlerts(db) }));

tool('client_tickets',
  'Client support tickets (all clients): id, client, subject, status, priority, last sender and last message. Use before replying to a ticket or changing its status.',
  { status: S('open | in_progress | resolved | closed (optional)'), client: S('Part of client name (optional)'), limit: LIMIT },
  async (db, a) => {
    const where = ['1=1']; const params = [];
    if (a.status) { where.push('ct.status = ?'); params.push(a.status); }
    if (a.client) { where.push('u.name LIKE ?'); params.push(like(a.client)); }
    const [rows] = await db.query(
      `SELECT ct.id, u.name AS client, ct.subject, ct.status, ct.priority, ct.updated_at, p.name AS project,
              (SELECT m.sender_role FROM client_ticket_messages m WHERE m.ticket_id = ct.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender,
              (SELECT LEFT(m.message, 300) FROM client_ticket_messages m WHERE m.ticket_id = ct.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
         FROM client_tickets ct JOIN users u ON u.id = ct.client_id LEFT JOIN projects p ON p.id = ct.project_id
        WHERE ${where.join(' AND ')} ORDER BY ct.updated_at DESC LIMIT ?`, [...params, lim(a.limit)]);
    return rows;
  });

tool('mo_items',
  'Line items of one Manufacturing Order (product, size, qty, finish). Use to prepare a quotation draft — the user must give the rates.',
  { mo_number: S('Manufacturing Order number, e.g. MO-1001') },
  async (db, a) => {
    const [[mo]] = await db.query('SELECT id, po_no, project_name, client_name, status FROM main_pos WHERE po_no = ?', [String(a.mo_number || '')]);
    if (!mo) return { error: 'Manufacturing Order nahi mila.' };
    const [items] = await db.query('SELECT s_no, area, proto_code, product_name, product_size, qty, finishes_note FROM main_po_items WHERE main_po_id = ? ORDER BY sort_order, s_no LIMIT 80', [mo.id]);
    return { mo, items };
  });

// ── Proposals (never write — the human must press Confirm) ──
tool('propose_ticket_reply',
  'PREPARE a reply to a client support ticket. Nothing is sent until the admin presses Confirm on the card.',
  { ticket_id: N('Ticket id from client_tickets'), message: S('The reply text to the client') },
  async (db, a, ctx) => propose(db, ctx, 'admin_ticket_reply', a));

tool('propose_ticket_status',
  'PREPARE a status change for a client ticket. Nothing changes until the admin presses Confirm.',
  { ticket_id: N('Ticket id'), status: S('open | in_progress | resolved | closed') },
  async (db, a, ctx) => propose(db, ctx, 'admin_ticket_status', a));

tool('propose_quotation_draft',
  'PREPARE a quotation DRAFT against a Manufacturing Order. Every item needs name, qty and a rate GIVEN BY THE USER — never invent rates. Saved only after the admin presses Confirm; it is saved as draft (not sent).',
  {
    mo_number: S('Manufacturing Order number, e.g. MO-1001'),
    client_name: S('Client name (optional, defaults to the MO client)'),
    subject: S('Quotation subject (optional)'),
    notes: S('Notes (optional)'),
    gst_percent: { type: 'number', description: 'GST % (optional, default 0)' },
    discount_amount: { type: 'number', description: 'Discount in rupees (optional)' },
    items: { type: 'array', description: 'Rows of the quotation', items: { type: 'object', properties: {
      item_name: { type: 'string' }, qty: { type: 'number' }, rate: { type: 'number', description: 'Rate per unit in rupees, from the user' },
      unit: { type: 'string' }, size: { type: 'string' }, description: { type: 'string' } }, required: ['item_name', 'qty', 'rate'] } },
  },
  async (db, a, ctx) => propose(db, ctx, 'admin_quotation_draft', a));

const definitions = tools.map(t => t.def);
const handlers = Object.fromEntries(tools.map(t => [t.def.name, t.handler]));

// mysql2 returns DATE/DATETIME as JS Dates built in the server's local time zone.
// Turn them into plain "YYYY-MM-DD" (or "YYYY-MM-DD HH:MM") so the model never sees UTC-shifted ISO strings.
function plainDates(v) {
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    const p = (n) => String(n).padStart(2, '0');
    const d = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    return v.getHours() || v.getMinutes() ? `${d} ${p(v.getHours())}:${p(v.getMinutes())}` : d;
  }
  if (Array.isArray(v)) return v.map(plainDates);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainDates(x)]));
  return v;
}

// Runs one tool call safely. Never throws — errors go back to the model as data.
async function runTool(db, name, input, ctx = {}) {
  const fn = handlers[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return plainDates(await fn(db, input && typeof input === 'object' ? input : {}, ctx));
  } catch (e) {
    console.error(`[ai] tool ${name} failed:`, e.message);
    return { error: 'Data fetch failed for this tool.' };
  }
}

module.exports = { definitions, runTool, getAlerts, MAX_ROWS };
