// ─────────────────────────────────────────────────────────────────────────────
//  "Ask Moji" for the CLIENT portal — READ-ONLY tools, strictly scoped to ONE client.
//
//  SECURITY RULES (do not relax):
//   • `clientId` comes ONLY from the verified login token (req.user.id). No tool takes a
//     client id / user id from the model, so the model cannot be talked into reading
//     another client's data.
//   • Every query is bound to that clientId (client_id = ?, or via client_project_access).
//   • Mirrors what the client portal already shows: only projects marked is_ready, no
//     worker names, no internal notes, no cost/margin data.
//   • SELECT only. Placeholders only. Row caps on everything.
// ─────────────────────────────────────────────────────────────────────────────

const { propose } = require('./aiActions');

const MAX_ROWS = 30;
const lim = (n, d = 20) => Math.min(Math.max(parseInt(n, 10) || d, 1), MAX_ROWS);
const num = (v) => (v === null || v === undefined ? v : Number(v));
const like = (s) => `%${String(s).trim().replace(/[%_\\]/g, '\\$&')}%`;

const tools = [];
function tool(name, description, properties, handler) {
  tools.push({ def: { name, description, input_schema: { type: 'object', properties } }, handler });
}
const S = (d) => ({ type: 'string', description: d });
const N = (d) => ({ type: 'integer', description: d });

// Projects visible to this client (same rule as the portal: assigned + ready + not deleted).
const MY_PROJECTS_SQL = `
  FROM client_project_access cpa
  JOIN projects p ON p.id = cpa.project_id
 WHERE cpa.client_id = ? AND p.status <> 'deleted' AND p.is_ready = 1`;

tool('my_projects',
  'List YOUR projects with status, deadline and production progress (completed tasks / total tasks).',
  { status: S('active | on_hold | completed (optional)') },
  async (db, clientId, a) => {
    const params = [clientId]; let extra = '';
    if (a.status) { extra = ' AND p.status = ?'; params.push(a.status); }
    const [rows] = await db.query(
      `SELECT p.id, p.project_id AS code, p.name, p.status, p.priority, p.order_date, p.deadline,
              (SELECT COUNT(*) FROM project_items i WHERE i.project_id = p.id) AS items,
              (SELECT COUNT(*) FROM task_assignments t WHERE t.project_id = p.id) AS tasks_total,
              (SELECT COUNT(*) FROM task_assignments t WHERE t.project_id = p.id AND t.status = 'completed') AS tasks_completed
         ${MY_PROJECTS_SQL}${extra} ORDER BY p.created_at DESC LIMIT ?`,
      [...params, MAX_ROWS]);
    return rows;
  });

tool('my_project_detail',
  'Detailed progress of ONE of your projects: items, and each production stage (department, status, quantity done, due date). Pass project_id or part of the project name.',
  { project_id: N('Project id from my_projects (optional)'), name: S('Part of project name (optional)') },
  async (db, clientId, a) => {
    const params = [clientId]; let extra = '';
    if (a.project_id) { extra = ' AND p.id = ?'; params.push(a.project_id); }
    else if (a.name) { extra = ' AND p.name LIKE ?'; params.push(like(a.name)); }
    else return { error: 'Project id ya naam batao.' };
    const [[p]] = await db.query(
      `SELECT p.id, p.project_id AS code, p.name, p.status, p.priority, p.order_date, p.deadline, p.description ${MY_PROJECTS_SQL}${extra} ORDER BY p.created_at DESC LIMIT 1`,
      params);
    if (!p) return { error: 'Ye project aapke account me nahi mila.' };
    const [items] = await db.query(
      `SELECT item_name, proto_code, quantity, unit, material, dimensions, status FROM project_items WHERE project_id = ? ORDER BY id LIMIT 100`, [p.id]);
    // No worker names / admin notes — department + progress only, like the portal.
    const [stages] = await db.query(
      `SELECT pi.item_name, d.name AS department, ta.stage_order, ta.task_title, ta.status,
              ta.quantity_assigned, ta.quantity_completed, ta.start_date, ta.due_date, ta.completed_date
         FROM task_assignments ta
         LEFT JOIN project_items pi ON pi.id = ta.project_item_id
         LEFT JOIN departments d ON d.id = ta.department_id
        WHERE ta.project_id = ? ORDER BY pi.id, ta.stage_order LIMIT 150`, [p.id]);
    const open = stages.filter(s => s.status !== 'completed' && s.due_date);
    const latestDue = open.length ? open.map(s => s.due_date).sort().pop() : null;
    return { project: p, items, stages, latest_stage_due_date: latestDue };
  });

tool('my_purchase_orders',
  'YOUR purchase orders with total, paid and balance. Use outstanding_only for unpaid balance.',
  { status: S('pending | acknowledged | processing | payment_pending | advance_pending | completed | cancelled (optional)'),
    outstanding_only: { type: 'boolean', description: 'Only POs where balance > 0' } },
  async (db, clientId, a) => {
    const where = ['c.client_id = ?']; const params = [clientId];
    if (a.status) { where.push('c.status = ?'); params.push(a.status); }
    if (a.outstanding_only) where.push(`paid.amt < c.total_amount AND c.status <> 'cancelled'`);
    const [rows] = await db.query(
      `SELECT c.po_number, c.order_date, c.due_date, c.status, c.total_amount,
              paid.amt AS paid_amount, (c.total_amount - paid.amt) AS balance
         FROM client_purchase_orders c
         JOIN (SELECT c2.id, COALESCE((SELECT SUM(amount) FROM client_po_payments WHERE po_id = c2.id), 0) AS amt FROM client_purchase_orders c2 WHERE c2.client_id = ?) paid ON paid.id = c.id
        WHERE ${where.join(' AND ')} ORDER BY c.order_date DESC LIMIT ?`,
      [clientId, ...params, MAX_ROWS]);
    return rows.map(r => ({ ...r, total_amount: num(r.total_amount), paid_amount: num(r.paid_amount), balance: num(r.balance) }));
  });

tool('my_payments',
  'Payments YOU have made against your purchase orders (date, amount, mode, reference).',
  { po_number: S('Filter by PO number (optional)') },
  async (db, clientId, a) => {
    const where = ['pay.client_id = ?', 'c.client_id = ?']; const params = [clientId, clientId];
    if (a.po_number) { where.push('c.po_number LIKE ?'); params.push(like(a.po_number)); }
    const [rows] = await db.query(
      `SELECT pay.payment_date, c.po_number, pay.amount, pay.payment_mode, pay.utr_reference, pay.is_advance
         FROM client_po_payments pay JOIN client_purchase_orders c ON c.id = pay.po_id
        WHERE ${where.join(' AND ')} ORDER BY pay.payment_date DESC, pay.id DESC LIMIT ?`,
      [...params, MAX_ROWS]);
    const [[tot]] = await db.query(
      `SELECT COALESCE(SUM(pay.amount),0) AS total FROM client_po_payments pay JOIN client_purchase_orders c ON c.id = pay.po_id WHERE ${where.join(' AND ')}`, params);
    return { total_paid: num(tot.total), payments: rows.map(r => ({ ...r, amount: num(r.amount) })) };
  });

tool('my_invoices',
  'Invoices / sale challans that were SENT to you: number, date, project, status, total amount.',
  {},
  async (db, clientId) => {
    const [[u]] = await db.query('SELECT name FROM users WHERE id = ?', [clientId]);
    const [rows] = await db.query(
      `SELECT sc.challan_number, sc.challan_date, sc.delivery_date, sc.status, sc.total_amount,
              p.name AS project_name, (SELECT COUNT(*) FROM sale_challan_items WHERE challan_id = sc.id) AS items
         FROM sale_challans sc LEFT JOIN projects p ON p.id = sc.project_id
        WHERE sc.sent_to_client = 1 AND sc.challan_type = 'sale'
          AND (sc.sent_client_id = ? OR (sc.sent_client_id IS NULL AND LOWER(TRIM(sc.client_name)) = LOWER(TRIM(?))))
        ORDER BY sc.created_at DESC LIMIT ?`,
      [clientId, u?.name || '', MAX_ROWS]);
    return rows.map(r => ({ ...r, total_amount: num(r.total_amount) }));
  });

tool('my_tickets',
  'YOUR support tickets: subject, status, priority, last update, and the latest message.',
  { status: S('open | in_progress | resolved | closed (optional)') },
  async (db, clientId, a) => {
    const where = ['ct.client_id = ?']; const params = [clientId];
    if (a.status) { where.push('ct.status = ?'); params.push(a.status); }
    const [rows] = await db.query(
      `SELECT ct.id, ct.subject, ct.status, ct.priority, ct.created_at, ct.updated_at, p.name AS project_name,
              (SELECT m.sender_role FROM client_ticket_messages m WHERE m.ticket_id = ct.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender,
              (SELECT LEFT(m.message, 200) FROM client_ticket_messages m WHERE m.ticket_id = ct.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
         FROM client_tickets ct LEFT JOIN projects p ON p.id = ct.project_id
        WHERE ${where.join(' AND ')} ORDER BY ct.updated_at DESC LIMIT ?`,
      [...params, MAX_ROWS]);
    return rows;
  });

// ── Proposals (never write — the client must press Confirm on the card) ──
tool('propose_ticket',
  'PREPARE a new support ticket for the client. Nothing is created until the client presses Confirm on the card. Ask for a clear subject and message first.',
  { subject: S('Short subject'), message: S('What the client needs, in their words'),
    priority: S('low | medium | high | urgent (optional, default medium)'), project_id: N('Project id from my_projects (optional)') },
  async (db, clientId, a, ctx) => propose(db, ctx, 'client_create_ticket', a));

tool('propose_ticket_reply',
  'PREPARE a new message on one of the client\'s own tickets. Nothing is sent until the client presses Confirm.',
  { ticket_id: N('Ticket id from my_tickets'), message: S('The message to send') },
  async (db, clientId, a, ctx) => propose(db, ctx, 'client_ticket_reply', a));

const definitions = tools.map(t => t.def);
const handlers = Object.fromEntries(tools.map(t => [t.def.name, t.handler]));

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

// clientId is bound by the route from the verified token — never from model input.
async function runClientTool(db, clientId, name, input, ctx = {}) {
  const fn = handlers[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  if (!Number.isInteger(clientId) || clientId <= 0) return { error: 'Not allowed.' };
  try {
    return plainDates(await fn(db, clientId, input && typeof input === 'object' ? input : {}, ctx));
  } catch (e) {
    console.error(`[ai-client] tool ${name} failed:`, e.message);
    return { error: 'Data fetch failed for this tool.' };
  }
}

module.exports = { definitions, runClientTool };
