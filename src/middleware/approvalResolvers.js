/**
 * Approval Resolvers — Approve hone par stored payload ko actual DB me execute karte hain.
 * New type add karne ke liye: resolver function likho + RESOLVERS map me register karo.
 */

const { getPool } = require('../database');

// ── PROJECT resolver ─────────────────────────────────────────────────────────
async function resolveProject(approval, db) {
  const data = approval.requested_data || {};
  const body = data.body || {};
  const userId = approval.user_id;

  let finalProjectId = body.project_id;
  if (!finalProjectId || finalProjectId.trim() === '') {
    const [settings] = await db.query(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('project_id_prefix','project_id_start_number')"
    );
    const map = {};
    settings.forEach(s => { map[s.setting_key] = s.setting_value; });
    const prefix = map.project_id_prefix || 'WM';
    const startNum = parseInt(map.project_id_start_number || '1001');
    const year = new Date().getFullYear().toString().slice(-2);
    const [last] = await db.query("SELECT project_id FROM projects ORDER BY id DESC LIMIT 1");
    let nextNum = startNum;
    if (last.length > 0) {
      const m = last[0].project_id?.match(/\d+$/);
      if (m) nextNum = parseInt(m[0]) + 1;
    }
    finalProjectId = `${prefix}-${year}-${nextNum}`;
  }

  const isReady = body.is_ready ? 1 : 0;
  const [r] = await db.query(
    `INSERT INTO projects
      (project_id,name,client_name,client_phone,description,priority,
       order_date,deadline,total_amount,notes,created_by,is_ready)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      finalProjectId, body.name, body.client_name, body.client_phone,
      body.description, body.priority || 'medium',
      body.order_date || null, body.deadline || null,
      body.total_amount || 0, body.notes, userId, isReady
    ]
  );
  return { id: r.insertId, project_id: finalProjectId };
}

// ── ITEM resolver ────────────────────────────────────────────────────────────
async function resolveItem(approval, db) {
  const data = approval.requested_data || {};
  const body = data.body || {};
  const projectId = data.params?.id || approval.related_id;

  const [r] = await db.query(
    `INSERT INTO project_items
      (project_id,item_name,proto_code,description,quantity,unit,material,
       dimensions,unit_price,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      projectId, body.item_name, body.proto_code, body.description,
      body.quantity || 1, body.unit || 'pcs', body.material,
      body.dimensions, body.unit_price || 0, body.notes
    ]
  );
  return { id: r.insertId, project_id: projectId };
}

// ── Stubs — baad me implement karna ──────────────────────────────────────────
async function resolveChallan(approval, db) {
  throw new Error('CHALLAN resolver not implemented — POST /sale-challans logic copy karo');
}
async function resolvePoStatus(approval, db) {
  throw new Error('PO_STATUS resolver not implemented yet');
}
async function resolveSale(approval, db) {
  throw new Error('SALE resolver not implemented yet');
}

const RESOLVERS = {
  PROJECT:    resolveProject,
  ITEM:       resolveItem,
  CHALLAN:    resolveChallan,
  PO_STATUS:  resolvePoStatus,
  SALE:       resolveSale,
};

async function executeApproval(approval) {
  const resolver = RESOLVERS[approval.type];
  if (!resolver) throw new Error(`No resolver registered for type: ${approval.type}`);
  const db = await getPool();
  const result = await resolver(approval, db);
  return { resourceType: approval.type, ...result };
}

module.exports = { executeApproval, RESOLVERS };
