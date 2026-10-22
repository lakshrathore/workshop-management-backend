// Sale Challan ↔ Packing helpers.
//
// A packing box may be created from a sale challan (packing_boxes.sale_challan_id).
// Each content line of such a box can point at a challan line
// (packing_box_items.sale_challan_item_id). Packed qty for a challan line is the
// SUM of the box lines pointing at it; it may never exceed the challan qty.

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const strOrNull = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
const idOrNull = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

function packingStatus(qty, packed) {
  if (packed <= 0) return 'pending';
  if (packed + 1e-9 >= qty) return 'fully_packed';
  return 'partially_packed';
}

// ── Challan items ─────────────────────────────────────────────────────────

async function insertChallanItem(db, challanId, it, sortOrder) {
  const qty = num(it.quantity);
  const rate = num(it.rate);
  await db.query(
    `INSERT INTO sale_challan_items
       (challan_id,item_name,description,quantity,unit,rate,total,sort_order,proto_code,project_item_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [challanId, it.item_name, it.description || '', qty, it.unit || 'pcs', rate, qty * rate, sortOrder,
      strOrNull(it.proto_code), idOrNull(it.project_item_id)]
  );
}

async function insertChallanItems(db, challanId, items) {
  for (let i = 0; i < items.length; i++) await insertChallanItem(db, challanId, items[i], i);
}

// Packed qty per challan line (optionally ignoring one box, used while editing that box)
async function packedByLine(db, challanId, { excludeBoxId = null } = {}) {
  const [rows] = await db.query(
    `SELECT pbi.sale_challan_item_id AS line_id, SUM(pbi.quantity) AS packed
       FROM packing_box_items pbi
       JOIN packing_boxes pb ON pb.id = pbi.box_id
      WHERE pb.sale_challan_id = ? ${excludeBoxId ? 'AND pb.id <> ?' : ''}
        AND pbi.sale_challan_item_id IS NOT NULL
      GROUP BY pbi.sale_challan_item_id`,
    excludeBoxId ? [challanId, excludeBoxId] : [challanId]
  );
  const map = new Map();
  rows.forEach(r => map.set(Number(r.line_id), num(r.packed)));
  return map;
}

// Update challan lines in place so packing links survive an edit.
// Lines are matched by id; lines sent without an id (older screens, invoice page)
// are matched to an unclaimed existing line with the same name + proto code.
// Removing a packed line, or cutting its qty below what is packed, is refused.
async function syncChallanItems(conn, challanId, items) {
  const [existing] = await conn.query(
    'SELECT * FROM sale_challan_items WHERE challan_id=? ORDER BY sort_order, id FOR UPDATE', [challanId]);
  const packed = await packedByLine(conn, challanId);
  const byId = new Map(existing.map(r => [r.id, r]));
  const claimed = new Set();
  const plan = items.map(it => {
    const id = idOrNull(it.id);
    if (id && byId.has(id) && !claimed.has(id)) { claimed.add(id); return { it, id }; }
    return { it, id: null };
  });
  for (const p of plan) {
    if (p.id) continue;
    const name = String(p.it.item_name || '').trim().toLowerCase();
    // Screens that don't know about proto codes don't send the field: match on name alone
    const codeSent = p.it.proto_code !== undefined;
    const code = strOrNull(p.it.proto_code);
    const match = existing.find(r => !claimed.has(r.id)
      && String(r.item_name || '').trim().toLowerCase() === name
      && (!codeSent || (r.proto_code || null) === code));
    if (match) { claimed.add(match.id); p.id = match.id; }
  }

  for (const r of existing) {
    const done = packed.get(r.id) || 0;
    if (!claimed.has(r.id) && done > 0) {
      const e = new Error(`"${r.item_name}" already has ${done} packed. Remove it from packing before removing it from the challan.`);
      e.status = 400; throw e;
    }
  }
  for (const p of plan) {
    if (!p.id) continue;
    const done = packed.get(p.id) || 0;
    if (num(p.it.quantity) + 1e-9 < done) {
      const e = new Error(`"${p.it.item_name}" quantity cannot be less than the ${done} already packed.`);
      e.status = 400; throw e;
    }
  }

  const keep = new Set(plan.filter(p => p.id).map(p => p.id));
  const drop = existing.filter(r => !keep.has(r.id)).map(r => r.id);
  if (drop.length) await conn.query('DELETE FROM sale_challan_items WHERE id IN (?)', [drop]);

  for (let i = 0; i < plan.length; i++) {
    const { it, id } = plan[i];
    if (!id) { await insertChallanItem(conn, challanId, it, i); continue; }
    const qty = num(it.quantity), rate = num(it.rate);
    // Keep the stored proto/project link when an older screen doesn't send them
    const old = byId.get(id);
    const proto = it.proto_code !== undefined ? strOrNull(it.proto_code) : old.proto_code;
    const pItem = it.project_item_id !== undefined ? idOrNull(it.project_item_id) : old.project_item_id;
    await conn.query(
      `UPDATE sale_challan_items SET item_name=?, description=?, quantity=?, unit=?, rate=?, total=?,
              sort_order=?, proto_code=?, project_item_id=? WHERE id=?`,
      [it.item_name, it.description || '', qty, it.unit || 'pcs', rate, qty * rate, i, proto, pItem, id]);
  }
}

// ── Packing status for one challan ────────────────────────────────────────

async function challanPackingStatus(db, challanId) {
  const [[challan]] = await db.query(
    `SELECT sc.id, sc.challan_number, sc.challan_date, sc.challan_type, sc.status, sc.client_name,
            sc.project_id, p.name AS project_name, p.project_id AS proj_code
       FROM sale_challans sc LEFT JOIN projects p ON p.id = sc.project_id WHERE sc.id=?`, [challanId]);
  if (!challan) return null;
  const [lines] = await db.query(
    'SELECT id, item_name, description, proto_code, project_item_id, quantity, unit FROM sale_challan_items WHERE challan_id=? ORDER BY sort_order, id',
    [challanId]);
  const packed = await packedByLine(db, challanId);
  const [[{ boxes }]] = await db.query('SELECT COUNT(*) AS boxes FROM packing_boxes WHERE sale_challan_id=?', [challanId]);
  const items = lines.map(l => {
    const qty = num(l.quantity), done = packed.get(l.id) || 0;
    return { ...l, quantity: qty, packed_qty: done, remaining_qty: Math.max(0, qty - done), packing_status: packingStatus(qty, done) };
  });
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  const totalPacked = items.reduce((s, i) => s + Math.min(i.packed_qty, i.quantity), 0);
  return {
    ...challan, items, box_count: Number(boxes),
    total_qty: totalQty, packed_qty: totalPacked, remaining_qty: Math.max(0, totalQty - totalPacked),
    packing_status: items.length && items.every(i => i.packing_status === 'fully_packed') ? 'fully_packed'
      : items.some(i => i.packed_qty > 0) ? 'partially_packed' : 'pending',
  };
}

// ── Validate box contents against a challan (call inside a transaction) ───

async function validateBoxAgainstChallan(conn, challanId, items, excludeBoxId = null) {
  const [[challan]] = await conn.query('SELECT id, project_id, status FROM sale_challans WHERE id=? FOR UPDATE', [challanId]);
  if (!challan) { const e = new Error('Sale Challan not found'); e.status = 404; throw e; }
  const [lines] = await conn.query('SELECT id, item_name, quantity FROM sale_challan_items WHERE challan_id=? FOR UPDATE', [challanId]);
  const lineById = new Map(lines.map(l => [l.id, l]));
  const packed = await packedByLine(conn, challanId, { excludeBoxId });
  const adding = new Map();
  for (const it of items) {
    const lineId = idOrNull(it.sale_challan_item_id);
    if (!lineId) continue;
    if (!lineById.has(lineId)) { const e = new Error(`"${it.item_name}" is not on this Sale Challan`); e.status = 400; throw e; }
    const q = parseInt(it.quantity, 10);
    if (!Number.isInteger(q) || q < 1) { const e = new Error(`"${it.item_name}" quantity must be at least 1`); e.status = 400; throw e; }
    adding.set(lineId, (adding.get(lineId) || 0) + q);
  }
  for (const [lineId, q] of adding) {
    const line = lineById.get(lineId);
    const remaining = num(line.quantity) - (packed.get(lineId) || 0);
    if (q > remaining + 1e-9) {
      const e = new Error(`"${line.item_name}": only ${Math.max(0, remaining)} left to pack (challan qty ${num(line.quantity)}), but ${q} entered.`);
      e.status = 400; throw e;
    }
  }
  return challan;
}

// ── Sale Challan vs Packing report ────────────────────────────────────────

async function challanPackingReport(db, q = {}) {
  const where = ["sc.challan_type <> 'sale'", "sc.status <> 'cancelled'"];
  const params = [];
  if (q.date_from) { where.push('sc.challan_date >= ?'); params.push(q.date_from); }
  if (q.date_to) { where.push('sc.challan_date <= ?'); params.push(q.date_to); }
  if (q.challan) { where.push('sc.challan_number LIKE ?'); params.push(`%${q.challan}%`); }
  if (q.project_id) { where.push('sc.project_id = ?'); params.push(q.project_id); }
  if (q.item) { where.push('(sci.item_name LIKE ? OR sci.proto_code LIKE ?)'); params.push(`%${q.item}%`, `%${q.item}%`); }
  const [rows] = await db.query(
    `SELECT sc.id AS challan_id, sc.challan_number, sc.challan_date, sc.client_name, sc.status AS challan_status,
            sc.project_id, p.name AS project_name, p.project_id AS proj_code,
            sci.id AS line_id, sci.item_name, sci.proto_code, sci.unit, sci.quantity AS challan_qty,
            COALESCE(pk.packed, 0) AS packed_qty, pk.box_numbers
       FROM sale_challan_items sci
       JOIN sale_challans sc ON sc.id = sci.challan_id
       LEFT JOIN projects p ON p.id = sc.project_id
       LEFT JOIN (
         SELECT pbi.sale_challan_item_id, SUM(pbi.quantity) AS packed,
                GROUP_CONCAT(DISTINCT pb.box_number ORDER BY pb.box_number SEPARATOR ', ') AS box_numbers
           FROM packing_box_items pbi JOIN packing_boxes pb ON pb.id = pbi.box_id
          WHERE pbi.sale_challan_item_id IS NOT NULL
          GROUP BY pbi.sale_challan_item_id
       ) pk ON pk.sale_challan_item_id = sci.id
      WHERE ${where.join(' AND ')}
      ORDER BY sc.challan_date DESC, sc.id DESC, sci.sort_order, sci.id`, params);
  let out = rows.map(r => {
    const qty = num(r.challan_qty), packed = num(r.packed_qty);
    return { ...r, challan_qty: qty, packed_qty: packed, remaining_qty: Math.max(0, qty - packed), packing_status: packingStatus(qty, packed) };
  });
  if (q.status) out = out.filter(r => r.packing_status === q.status);
  const summary = {
    challans: new Set(out.map(r => r.challan_id)).size,
    lines: out.length,
    challan_qty: out.reduce((s, r) => s + r.challan_qty, 0),
    packed_qty: out.reduce((s, r) => s + Math.min(r.packed_qty, r.challan_qty), 0),
  };
  summary.remaining_qty = Math.max(0, summary.challan_qty - summary.packed_qty);
  ['pending', 'partially_packed', 'fully_packed'].forEach(k => { summary[k] = out.filter(r => r.packing_status === k).length; });
  return { rows: out, summary };
}

// ── Packing boxes by Proto Code (Sale Challan row "Box Details") ──────────
// Packing is made before the challan; this only reads it. A box's proto code is
// its own Proto Code field, else its linked project item's code; content lines
// may also carry a code. Matching is case-insensitive. With a project given,
// only that project's boxes are returned, so the same code used on another
// project never shows up on this challan.
const normCode = v => String(v || '').trim().toUpperCase();

async function boxesByProto(db, codes, projectId = null) {
  const wanted = [...new Set((codes || []).map(normCode).filter(Boolean))].slice(0, 200);
  const out = {};
  wanted.forEach(c => { out[c] = []; });
  if (!wanted.length) return out;

  const params = [wanted, wanted];
  let projectSql = '';
  if (projectId) {
    projectSql = 'AND (pb.project_id = ? OR (pb.project_id IS NULL AND pi.project_id = ?))';
    params.push(projectId, projectId);
  }
  const [boxes] = await db.query(
    `SELECT DISTINCT pb.id, pb.box_number, pb.sub_label, pb.copies, pb.main_item, pb.description, pb.notes,
            pb.created_at, pb.project_id, pb.sale_challan_id,
            UPPER(TRIM(COALESCE(NULLIF(pb.photo_code, ''), pi.proto_code))) AS box_code,
            p.name AS project_name, p.project_id AS proj_code, pi.item_name,
            u.name AS created_by_name, sc.challan_number AS sale_challan_number,
            (SELECT COUNT(*) FROM packing_box_photos ph WHERE ph.box_id = pb.id) AS photo_count
       FROM packing_boxes pb
       LEFT JOIN project_items pi ON pi.id = pb.project_item_id
       LEFT JOIN projects p ON p.id = COALESCE(pb.project_id, pi.project_id)
       LEFT JOIN users u ON u.id = pb.created_by
       LEFT JOIN sale_challans sc ON sc.id = pb.sale_challan_id
       LEFT JOIN packing_box_items pbi ON pbi.box_id = pb.id
      WHERE (UPPER(TRIM(COALESCE(NULLIF(pb.photo_code, ''), pi.proto_code))) IN (?)
             OR UPPER(TRIM(pbi.proto_code)) IN (?))
        ${projectSql}
      ORDER BY pb.box_number, pb.id`, params);
  if (!boxes.length) return out;

  const [lines] = await db.query(
    'SELECT box_id, item_name, quantity, unit, proto_code FROM packing_box_items WHERE box_id IN (?) ORDER BY box_id, id',
    [boxes.map(b => b.id)]);
  const linesByBox = new Map();
  lines.forEach(l => { if (!linesByBox.has(l.box_id)) linesByBox.set(l.box_id, []); linesByBox.get(l.box_id).push(l); });

  for (const b of boxes) {
    const items = linesByBox.get(b.id) || [];
    const copies = Math.max(1, Math.min(26, parseInt(b.copies, 10) || 1));
    const labels = copies > 1 ? Array.from({ length: copies }, (_, i) => `${b.box_number}-${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i]}`) : [];
    // A box goes under every requested code it matches: its own code or a content line's code
    const codesHere = new Set([b.box_code, ...items.map(l => normCode(l.proto_code))].filter(c => wanted.includes(c)));
    for (const c of codesHere) {
      // Box matched by its own code: show all contents. Matched only through a
      // content line: show just the lines for this code.
      const shown = b.box_code === c ? items : items.filter(l => normCode(l.proto_code) === c);
      out[c].push({
        id: b.id, box_number: b.box_number, sub_label: b.sub_label, labels, main_item: b.main_item || b.item_name || '',
        description: b.description || '', notes: b.notes || '', project_name: b.project_name || '', proj_code: b.proj_code || '',
        created_by_name: b.created_by_name || '', created_at: b.created_at, photo_count: Number(b.photo_count) || 0,
        sale_challan_number: b.sale_challan_number || '', items: shown,
        total_qty: shown.reduce((s, l) => s + (Number(l.quantity) || 0), 0),
      });
    }
  }
  return out;
}

module.exports = {
  boxesByProto,
  insertChallanItems, syncChallanItems, challanPackingStatus,
  validateBoxAgainstChallan, challanPackingReport, packingStatus,
};
