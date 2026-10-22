// Sale Challan ↔ Packing helpers.
//
// A packing box may be created from a sale challan (packing_boxes.sale_challan_id).
// Each content line of such a box can point at a challan line
// (packing_box_items.sale_challan_item_id). Packed qty for a challan line is the
// SUM of the box lines pointing at it; it may never exceed the challan qty.

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const strOrNull = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
const idOrNull = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

// Ticked packing boxes for a challan line → JSON text (null when none). Accepts the
// array the page sends or the stored JSON text. A box printed with label copies
// (MJ-10-A, MJ-10-B) is one physical box per label, so a tick may carry `label`.
// A tick without a label means the whole box (all its labels).
function tickedJson(v) {
  let list = v;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const clean = [];
  for (const b of list) {
    const id = idOrNull(b && b.id);
    const label = String((b && b.label) || '').trim().slice(0, 100);
    if (!id || seen.has(`${id}|${label}`)) continue;
    seen.add(`${id}|${label}`);
    const t = { id, box_number: String((b && b.box_number) || '').slice(0, 100) };
    if (label) t.label = label;
    clean.push(t);
    if (clean.length >= 500) break;
  }
  return clean.length ? JSON.stringify(clean) : null;
}

// Label names of a box: copies > 1 → BOX-A, BOX-B, …; otherwise just the box number
const SUBS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function boxLabels(boxNumber, copies) {
  const n = Math.max(1, Math.min(26, parseInt(copies, 10) || 1));
  return n > 1 ? Array.from({ length: n }, (_, i) => `${boxNumber}-${SUBS[i]}`) : [boxNumber];
}

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
       (challan_id,item_name,description,quantity,unit,rate,total,sort_order,proto_code,project_item_id,ticked_boxes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [challanId, it.item_name, it.description || '', qty, it.unit || 'pcs', rate, qty * rate, sortOrder,
      strOrNull(it.proto_code), idOrNull(it.project_item_id), tickedJson(it.ticked_boxes)]
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
    const ticked = it.ticked_boxes !== undefined ? tickedJson(it.ticked_boxes) : old.ticked_boxes;
    await conn.query(
      `UPDATE sale_challan_items SET item_name=?, description=?, quantity=?, unit=?, rate=?, total=?,
              sort_order=?, proto_code=?, project_item_id=?, ticked_boxes=? WHERE id=?`,
      [it.item_name, it.description || '', qty, it.unit || 'pcs', rate, qty * rate, i, proto, pItem, ticked, id]);
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
// Proto codes are compared loosely: letters + digits only, upper case, without a
// leading "PROTO" — so PROTO_86005, PROTO-86005, proto 86005 and 86005 are the same.
const normCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^PROTO/, '');
const sqlNorm = col => `REGEXP_REPLACE(REGEXP_REPLACE(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', ''), '^PROTO', '')`;

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
            ${sqlNorm("COALESCE(NULLIF(pb.photo_code, ''), pi.proto_code)")} AS box_code,
            p.name AS project_name, p.project_id AS proj_code, pi.item_name,
            u.name AS created_by_name, sc.challan_number AS sale_challan_number,
            (SELECT COUNT(*) FROM packing_box_photos ph WHERE ph.box_id = pb.id) AS photo_count
       FROM packing_boxes pb
       LEFT JOIN project_items pi ON pi.id = pb.project_item_id
       LEFT JOIN projects p ON p.id = COALESCE(pb.project_id, pi.project_id)
       LEFT JOIN users u ON u.id = pb.created_by
       LEFT JOIN sale_challans sc ON sc.id = pb.sale_challan_id
       LEFT JOIN packing_box_items pbi ON pbi.box_id = pb.id
      WHERE (${sqlNorm("COALESCE(NULLIF(pb.photo_code, ''), pi.proto_code)")} IN (?)
             OR ${sqlNorm('pbi.proto_code')} IN (?))
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

// ── Packing → Sale Challan report (new workflow) ──────────────────────────
// Packing comes first. A box is "used" once a challan line has it ticked in Box
// Details (or it was made from a challan, older workflow). Cancelled challans
// don't count. Items = boxes grouped by project + loose proto code.
const ITEM_STATUS = { pending: 'pending', partial: 'partial', full: 'full' };

async function packingDispatchReport(db, q = {}) {
  // 1. Boxes (filtered by packing date / project / search)
  const where = ['1=1'];
  const params = [];
  if (q.date_from) { where.push('DATE(pb.created_at) >= ?'); params.push(q.date_from); }
  if (q.date_to) { where.push('DATE(pb.created_at) <= ?'); params.push(q.date_to); }
  if (q.project_id) { where.push('COALESCE(pb.project_id, pi.project_id) = ?'); params.push(q.project_id); }
  const [boxes] = await db.query(
    `SELECT pb.id, pb.box_number, pb.sub_label, pb.copies, pb.main_item, pb.created_at, pb.sale_challan_id,
            COALESCE(NULLIF(pb.photo_code, ''), pi.proto_code) AS proto_code,
            ${sqlNorm("COALESCE(NULLIF(pb.photo_code, ''), pi.proto_code)")} AS code_key,
            COALESCE(pb.project_id, pi.project_id) AS project_id,
            p.name AS project_name, p.project_id AS proj_code, pi.item_name
       FROM packing_boxes pb
       LEFT JOIN project_items pi ON pi.id = pb.project_item_id
       LEFT JOIN projects p ON p.id = COALESCE(pb.project_id, pi.project_id)
      WHERE ${where.join(' AND ')}
      ORDER BY pb.created_at DESC, pb.id DESC`, params);

  const boxIds = boxes.map(b => b.id);
  const lines = new Map();
  if (boxIds.length) {
    const [rows] = await db.query(
      'SELECT box_id, item_name, quantity, unit FROM packing_box_items WHERE box_id IN (?) ORDER BY box_id, id', [boxIds]);
    rows.forEach(r => { if (!lines.has(r.box_id)) lines.set(r.box_id, []); lines.get(r.box_id).push(r); });
  }

  // 2. Where each box is used: ticks on challan lines + boxes made from a challan
  const [tickRows] = await db.query(
    `SELECT sci.ticked_boxes, sc.id AS challan_id, sc.challan_number, sc.challan_date, sc.client_name, sc.vehicle_number, sc.vehicle_length, sc.transport_name
       FROM sale_challan_items sci JOIN sale_challans sc ON sc.id = sci.challan_id
      WHERE sci.ticked_boxes IS NOT NULL AND sc.status <> 'cancelled'`);
  const ticks = [];
  for (const r of tickRows) {
    let list = [];
    try { list = JSON.parse(r.ticked_boxes); } catch (e) { list = []; }   // a bad value only skips that line
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const id = idOrNull(t && t.id);
      if (id) ticks.push({ ...r, ticked_boxes: undefined, box_id: id, label: String((t && t.label) || '').trim() });
    }
  }
  const [made] = await db.query(
    `SELECT pb.id AS box_id, sc.id AS challan_id, sc.challan_number, sc.challan_date, sc.client_name, sc.vehicle_number, sc.vehicle_length, sc.transport_name
       FROM packing_boxes pb JOIN sale_challans sc ON sc.id = pb.sale_challan_id
      WHERE sc.status <> 'cancelled'`);
  // box_id → [{challan…, label}] ; label '' = the whole box (all its labels)
  const usage = new Map();
  for (const u of [...ticks, ...made.map(m => ({ ...m, label: '' }))]) {
    if (!usage.has(u.box_id)) usage.set(u.box_id, []);
    const list = usage.get(u.box_id);
    if (!list.some(x => x.challan_id === u.challan_id && x.label === (u.label || ''))) list.push({ ...u, label: u.label || '' });
  }

  // 3. Challan quantity per project + code (non-cancelled challans)
  const [clines] = await db.query(
    `SELECT sc.project_id, ${sqlNorm('sci.proto_code')} AS code_key, SUM(sci.quantity) AS qty,
            GROUP_CONCAT(DISTINCT sc.challan_number ORDER BY sc.challan_number SEPARATOR ', ') AS challans
       FROM sale_challan_items sci JOIN sale_challans sc ON sc.id = sci.challan_id
      WHERE sc.status <> 'cancelled' AND sci.proto_code IS NOT NULL AND sci.proto_code <> ''
      GROUP BY sc.project_id, code_key`);
  const challanQty = new Map(clines.map(r => [`${r.project_id || ''}|${r.code_key}`, r]));

  // 4. Per box rows
  const challanFilter = String(q.challan || '').trim().toLowerCase();
  const search = String(q.item || '').trim().toLowerCase();
  const searchKey = normCode(q.item);
  // Each label of a box (MJ-10-A, MJ-10-B) is one physical box → one row each
  let boxRows = boxes.flatMap(b => boxLabels(b.box_number, b.copies).map((label, li, all) => ({ b, label, multi: all.length > 1 }))).map(({ b, label, multi }) => {
    const used = (usage.get(b.id) || []).filter(u => !u.label || u.label === label || (!multi && u.label === b.box_number));
    const contents = lines.get(b.id) || [];
    return {
      id: b.id, unit_key: `${b.id}|${label}`, box_number: label, parent_box_number: multi ? b.box_number : '', sub_label: b.sub_label, labels: 1,
      project_id: b.project_id, project_name: b.project_name || '', proj_code: b.proj_code || '',
      // No main item / project item: name the box after its first content line
      proto_code: b.proto_code || '', code_key: b.code_key || '', main_item: b.main_item || b.item_name || (contents[0] && contents[0].item_name) || '',
      item_real: b.main_item || b.item_name || '',   // a real item name (not taken from contents)
      contents: contents.map(l => ({ item_name: l.item_name, quantity: Number(l.quantity) || 0, unit: l.unit })),
      packed_at: b.created_at,
      status: used.length ? 'used' : 'pending',
      challans: used.map(u => ({ id: u.challan_id, challan_number: u.challan_number, challan_date: u.challan_date, client_name: u.client_name || '',
        vehicle_number: u.vehicle_number || '', vehicle_length: u.vehicle_length || '', transport_name: u.transport_name || '' })),
    };
  });
  if (search) {
    boxRows = boxRows.filter(b => (searchKey && b.code_key.includes(searchKey))
      || `${b.box_number} ${b.main_item} ${b.proto_code} ${b.contents.map(c => c.item_name).join(' ')}`.toLowerCase().includes(search));
  }
  if (challanFilter) boxRows = boxRows.filter(b => b.challans.some(c => String(c.challan_number).toLowerCase().includes(challanFilter)));
  // Vehicle filter: spaces / hyphens / case ignored (RJ14GA1234 = RJ-14-GA-1234)
  const vKey = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const vehicleFilter = vKey(q.vehicle);
  if (vehicleFilter) boxRows = boxRows.filter(b => b.challans.some(c => vKey(c.vehicle_number).includes(vehicleFilter)));

  // 5. Items: group boxes by project + code
  const groups = new Map();
  for (const b of boxRows) {
    const key = `${b.project_id || ''}|${b.code_key || `#box${b.id}`}`;
    if (!groups.has(key)) {
      groups.set(key, { key, project_id: b.project_id, project_name: b.project_name, proj_code: b.proj_code,
        proto_code: b.proto_code, code_key: b.code_key, item_name: b.item_real || b.main_item, has_real: !!b.item_real, boxes: 0, labels: 0,
        used_boxes: 0, used_labels: 0, box_numbers: [], challans: new Set() });
    }
    const g = groups.get(key);
    g.boxes += 1; g.labels += b.labels; g.box_numbers.push(b.box_number);
    // Prefer a real item name from any box in the group over one taken from contents
    if (b.item_real && !g.has_real) { g.item_name = b.item_real; g.has_real = true; }
    else if (!g.item_name && b.main_item) g.item_name = b.main_item;
    if (b.status === 'used') { g.used_boxes += 1; g.used_labels += b.labels; b.challans.forEach(c => g.challans.add(c.challan_number)); }
  }
  const itemRows = [...groups.values()].map(g => {
    const cq = g.code_key ? challanQty.get(`${g.project_id || ''}|${g.code_key}`) : null;
    const status = g.used_boxes === 0 ? ITEM_STATUS.pending : g.used_boxes >= g.boxes ? ITEM_STATUS.full : ITEM_STATUS.partial;
    return { ...g, challans: [...g.challans].sort(), pending_boxes: g.boxes - g.used_boxes, pending_labels: g.labels - g.used_labels,
      challan_qty: cq ? Number(cq.qty) || 0 : 0, status };
  }).sort((a, b) => (a.code_key ? 0 : 1) - (b.code_key ? 0 : 1)   // items with a Proto Code first
    || `${a.proj_code}|${a.proto_code}`.localeCompare(`${b.proj_code}|${b.proto_code}`));

  // 6. Status filter applies to the matching view (box: used/pending, item: pending/partial/full)
  const st = q.status || '';
  const boxesOut = ['used', 'pending'].includes(st) ? boxRows.filter(b => b.status === st)
    : ['partial', 'full'].includes(st) ? boxRows.filter(b => itemRows.find(i => i.status === st && i.key === `${b.project_id || ''}|${b.code_key || `#box${b.id}`}`))
    : boxRows;
  const itemsOut = ['pending', 'partial', 'full'].includes(st) ? itemRows.filter(i => i.status === st)
    : st === 'used' ? itemRows.filter(i => i.used_boxes > 0)
    : itemRows;

  // Vehicles: challans (with boxes from this report) grouped by vehicle number
  const vehicles = new Map();
  for (const b of boxesOut) {
    for (const c of b.challans) {
      if (vehicleFilter && !vKey(c.vehicle_number).includes(vehicleFilter)) continue;
      const key = vKey(c.vehicle_number) || '__none';
      if (!vehicles.has(key)) {
        vehicles.set(key, { key, vehicle_number: '', lengths: new Set(), transports: new Set(),
          challans: new Map(), boxes: new Set(), labels: 0, items: new Map(), projects: new Set() });
      }
      const v = vehicles.get(key);
      // Show the fullest spelling seen (RJ-14-GA-1234 rather than rj14ga1234), in capitals
      if (String(c.vehicle_number || '').trim().length > v.vehicle_number.length) v.vehicle_number = String(c.vehicle_number).trim();
      if (c.vehicle_length) v.lengths.add(c.vehicle_length);
      if (c.transport_name) v.transports.add(c.transport_name);
      if (!v.challans.has(c.id)) v.challans.set(c.id, { id: c.id, challan_number: c.challan_number, challan_date: c.challan_date, client_name: c.client_name, boxes: 0 });
      v.challans.get(c.id).boxes += 1;
      if (!v.boxes.has(b.unit_key)) { v.boxes.add(b.unit_key); v.labels += b.labels; }
      const itemKey = b.code_key || b.main_item;
      if (itemKey && !v.items.has(itemKey)) v.items.set(itemKey, [b.proto_code, b.main_item].filter(Boolean).join(' · '));
      const pj = [b.proj_code, b.project_name].filter(Boolean).join(' — ');
      if (pj) v.projects.add(pj);
    }
  }
  const vehicleRows = [...vehicles.values()].map(v => ({
    key: v.key, vehicle_number: v.vehicle_number.toUpperCase(), vehicle_lengths: [...v.lengths], transports: [...v.transports],
    challans: [...v.challans.values()].sort((a, b) => String(b.challan_date).localeCompare(String(a.challan_date))),
    trips: v.challans.size, boxes: v.boxes.size, labels: v.labels, items: [...v.items.values()], projects: [...v.projects],
  })).sort((a, b) => (a.key === '__none') - (b.key === '__none') || b.boxes - a.boxes);

  const summary = {
    vehicles: vehicleRows.filter(v => v.key !== '__none').length,
    boxes: boxRows.length,
    used_boxes: boxRows.filter(b => b.status === 'used').length,
    labels: boxRows.reduce((s, b) => s + b.labels, 0),
    used_labels: boxRows.filter(b => b.status === 'used').reduce((s, b) => s + b.labels, 0),
    items: itemRows.length,
    items_full: itemRows.filter(i => i.status === 'full').length,
    items_partial: itemRows.filter(i => i.status === 'partial').length,
    items_pending: itemRows.filter(i => i.status === 'pending').length,
    challans: new Set(boxRows.flatMap(b => b.challans.map(c => c.id))).size,
  };
  summary.pending_boxes = summary.boxes - summary.used_boxes;
  summary.pending_labels = summary.labels - summary.used_labels;
  return { summary, items: itemsOut, boxes: boxesOut, vehicles: vehicleRows };
}

module.exports = {
  packingDispatchReport, boxLabels,
  boxesByProto, normCode, sqlNorm,
  insertChallanItems, syncChallanItems, challanPackingStatus,
  validateBoxAgainstChallan, challanPackingReport, packingStatus,
};
