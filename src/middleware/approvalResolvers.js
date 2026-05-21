/**
 * Approval Resolvers — Approve hone par stored payload ko actual DB me execute karte hain.
 *
 * approval = { id, user_id, type, related_id, requested_data: {method,path,body,query,params}, ... }
 */

const { getPool } = require('../database');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (self-contained — routes/index.js ke helpers se decoupled)
// ─────────────────────────────────────────────────────────────────────────────

async function getNumberingMode(db, docType) {
  const [[row]] = await db.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=?',
    [`${docType}_numbering_mode`]
  );
  return row?.setting_value || 'auto';
}

async function getNextAutoChallanNumber(db, challanType) {
  const defaults = { sale: 'INV', delivery: 'DC', proforma: 'PRO' };
  const [[prefixRow]] = await db.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=?',
    [`${challanType}_prefix`]
  );
  const [[startRow]] = await db.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=?',
    [`${challanType}_start_number`]
  );
  const prefix   = (prefixRow?.setting_value || defaults[challanType] || challanType.toUpperCase()).trim();
  const startNum = parseInt(startRow?.setting_value || '1001');

  const [[maxRow]] = await db.query(
    `SELECT MAX(CAST(SUBSTRING(challan_number, ?) AS UNSIGNED)) as maxn
     FROM sale_challans
     WHERE challan_number LIKE ? AND challan_type=?`,
    [prefix.length + 2, prefix + '-%', challanType]
  );
  const maxn = maxRow?.maxn || (startNum - 1);
  const next = Math.max(maxn + 1, startNum);
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

// ── PROJECT resolver ─────────────────────────────────────────────────────────
async function resolveProject(approval, db) {
  const data   = approval.requested_data || {};
  const body   = data.body || {};
  const userId = approval.user_id;

  let finalProjectId = body.project_id;
  if (!finalProjectId || finalProjectId.trim() === '') {
    const [settings] = await db.query(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('project_id_prefix','project_id_start_number')"
    );
    const map = {};
    settings.forEach(s => { map[s.setting_key] = s.setting_value; });
    const prefix   = map.project_id_prefix || 'WM';
    const startNum = parseInt(map.project_id_start_number || '1001');
    const year     = new Date().getFullYear().toString().slice(-2);
    const [last]   = await db.query("SELECT project_id FROM projects ORDER BY id DESC LIMIT 1");
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
  const data      = approval.requested_data || {};
  const body      = data.body || {};
  
  // Try multiple sources for project_id
  let projectId = data.params?.id || body.project_id || approval.related_id;
  
  console.log(`[resolveItem] Attempting to resolve - approval_id=${approval.id}, related_id=${approval.related_id}`);
  console.log(`[resolveItem] data.params=`, data.params);
  console.log(`[resolveItem] body keys=`, Object.keys(body));
  console.log(`[resolveItem] projectId resolved to:`, projectId);
  
  if (!projectId || String(projectId).trim() === '') {
    console.error(`[resolveItem] Missing project ID - data=`, JSON.stringify(data, null, 2));
    throw new Error('Project ID missing in approval payload - cannot create item without project');
  }

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

// ── CHALLAN resolver ─────────────────────────────────────────────────────────
async function resolveChallan(approval, db) {
  const data   = approval.requested_data || {};
  const body   = data.body || {};
  const userId = approval.user_id;

  const {
    client_name, client_phone, client_address, client_gstin, challan_type,
    project_id, challan_date, delivery_date, status, notes,
    tax_percent, discount_amount, transport_name, vehicle_number, items,
    manual_number, cpo_id, cgst, sgst, igst
  } = body;

  if (!client_name || !client_name.trim()) {
    throw new Error('Client name missing in approval payload');
  }
  if (!project_id || String(project_id).trim() === '') {
    throw new Error('Project ID missing in approval payload - cannot create challan without project');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No items in approval payload');
  }

  // Numbering — re-resolve at approval time so sequence stays gap-free
  const cType       = challan_type || 'delivery';
  const challanMode = await getNumberingMode(db, cType);
  let challan_number;
  if (challanMode === 'manual') {
    if (!manual_number || !manual_number.trim()) {
      throw new Error('Manual challan number required');
    }
    challan_number = manual_number.trim();
  } else {
    challan_number = await getNextAutoChallanNumber(db, cType);
  }

  // Totals
  let subtotal = 0;
  for (const it of items) {
    subtotal += (parseFloat(it.quantity) || 0) * (parseFloat(it.rate) || 0);
  }
  const taxPct       = parseFloat(tax_percent) || 0;
  const disc         = parseFloat(discount_amount) || 0;
  const tax_amount   = parseFloat(((subtotal - disc) * taxPct / 100).toFixed(2));
  const total_amount = parseFloat((subtotal - disc + tax_amount).toFixed(2));

  const [r] = await db.query(
    `INSERT INTO sale_challans
      (challan_number,client_name,client_phone,client_address,client_gstin,challan_type,
       project_id,challan_date,delivery_date,status,subtotal,tax_percent,tax_amount,discount_amount,
       total_amount,transport_name,vehicle_number,notes,cgst,sgst,igst,cpo_id,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      challan_number, client_name.trim(), client_phone || '', client_address || '', client_gstin || '',
      cType, project_id, challan_date, delivery_date || null, status || 'draft',
      subtotal, taxPct, tax_amount, disc, total_amount,
      transport_name || '', vehicle_number || '', notes || '',
      cgst || null, sgst || null, igst || null, cpo_id || null, userId
    ]
  );
  const challanId = r.insertId;

  for (let i = 0; i < items.length; i++) {
    const it   = items[i];
    const qty  = parseFloat(it.quantity) || 0;
    const rate = parseFloat(it.rate) || 0;
    await db.query(
      `INSERT INTO sale_challan_items
        (challan_id,item_name,description,quantity,unit,rate,total,sort_order)
       VALUES (?,?,?,?,?,?,?,?)`,
      [challanId, it.item_name, it.description || '', qty, it.unit || 'pcs', rate, qty * rate, i]
    );
  }

  return { id: challanId, challan_number };
}

// ── PO_STATUS resolver ───────────────────────────────────────────────────────
async function resolvePoStatus(approval, db) {
  const data   = approval.requested_data || {};
  const body   = data.body || {};
  const poId   = approval.related_id || data.params?.id;
  const status = body.status;

  if (!poId) throw new Error('PO id missing in approval payload');
  if (!status || !String(status).trim()) {
    throw new Error('Status value missing in approval payload');
  }

  const [r] = await db.query(
    'UPDATE purchase_orders SET status=? WHERE id=?',
    [status, poId]
  );

  if (r.affectedRows === 0) {
    throw new Error(`Purchase order #${poId} not found — cannot apply status change`);
  }

  return { id: Number(poId), status };
}

// ── SALE resolver — stub ─────────────────────────────────────────────────────
async function resolveSale(approval, db) {
  throw new Error('SALE resolver not implemented yet');
}

const RESOLVERS = {
  PROJECT:   resolveProject,
  ITEM:      resolveItem,
  CHALLAN:   resolveChallan,
  PO_STATUS: resolvePoStatus,
  SALE:      resolveSale,
};

async function executeApproval(approval) {
  const resolver = RESOLVERS[approval.type];
  if (!resolver) throw new Error(`No resolver registered for type: ${approval.type}`);
  const db     = await getPool();
  const result = await resolver(approval, db);
  return { resourceType: approval.type, ...result };
}

module.exports = { executeApproval, RESOLVERS };
