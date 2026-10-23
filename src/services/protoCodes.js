// ── Proto Code series + per-order/per-project mode ─────────────────────────────
// A Manufacturing Order picks a Proto Code mode when it is created:
//   'manual' — the user types every code (nothing is generated)
//   'auto'   — the next code of the Settings series is given to each new item
// The mode is copied to the Project made from the order and never changes after.
// Older orders/projects have no mode (NULL) and keep working as manual.
//
// Series (Settings → Proto Code Series): proto_code_prefix + number, e.g. PROTO_1001.
// One series for the whole software, so codes never repeat across projects.

const MODES = ['manual', 'auto'];
const DEFAULT_PREFIX = 'PROTO_';
const DEFAULT_START = 1001;

const modeOf = v => (v === 'auto' ? 'auto' : 'manual');           // NULL / legacy = manual
const readMode = v => (MODES.includes(v) ? v : null);

// Same loose rule as the rest of the app: PROTO_86005 = PROTO-86005 = 86005
const normCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^PROTO/, '');
const sqlNorm = col => `REGEXP_REPLACE(REGEXP_REPLACE(UPPER(COALESCE(${col},'')),'[^A-Z0-9]',''),'^PROTO','')`;

const cleanCode = v => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

async function readSeries(db) {
  const [rows] = await db.query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('proto_code_prefix','proto_code_start_number')");
  const m = {};
  rows.forEach(r => { m[r.setting_key] = r.setting_value; });
  const prefix = (m.proto_code_prefix ?? DEFAULT_PREFIX).toString().trim() || DEFAULT_PREFIX;
  const start = Math.max(1, parseInt(m.proto_code_start_number, 10) || DEFAULT_START);
  return { prefix, start };
}

const likeEscape = s => s.replace(/[\\%_]/g, c => `\\${c}`);
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Highest number already used in the series, in projects or Manufacturing Orders
async function highestUsed(db, prefix) {
  const re = new RegExp(`^${reEscape(prefix)}(\\d+)$`, 'i');
  const like = `${likeEscape(prefix)}%`;
  let max = 0;
  for (const table of ['project_items', 'main_po_items']) {
    const [rows] = await db.query(`SELECT proto_code FROM ${table} WHERE proto_code LIKE ?`, [like]);
    for (const r of rows) {
      const m = re.exec(String(r.proto_code || '').trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max;
}

async function codeExists(db, code) {
  const n = normCode(code);
  if (!n) return false;
  for (const table of ['project_items', 'main_po_items']) {
    const [[row]] = await db.query(`SELECT 1 AS x FROM ${table} WHERE ${sqlNorm('proto_code')} = ? LIMIT 1`, [n]);
    if (row) return true;
  }
  return false;
}

// What the next codes would be (preview only — nothing is reserved)
async function previewCodes(db, count = 1) {
  const { prefix, start } = await readSeries(db);
  let next = Math.max(start, (await highestUsed(db, prefix)) + 1);
  return { prefix, start, next: `${prefix}${next}`, codes: Array.from({ length: count }, () => `${prefix}${next++}`) };
}

// Take the next `count` codes of the series. MUST run inside a transaction on `conn`:
// the counter row is locked until commit, so two saves can never get the same code.
async function takeCodes(conn, count) {
  if (!count) return [];
  const { prefix, start } = await readSeries(conn);
  await conn.query(
    "INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('proto_code_last_number', '0')");
  const [[row]] = await conn.query(
    "SELECT setting_value FROM app_settings WHERE setting_key='proto_code_last_number' FOR UPDATE");
  // The counter remembers the prefix it counted for; a new prefix starts its own count
  let [lastPrefix, lastNum] = String(row?.setting_value || '').split('|');
  if (lastNum === undefined) { lastNum = lastPrefix; lastPrefix = prefix; }   // old plain value
  const counted = lastPrefix === prefix ? (parseInt(lastNum, 10) || 0) : 0;
  let next = Math.max(start, counted + 1, (await highestUsed(conn, prefix)) + 1);
  const out = [];
  for (let guard = 0; out.length < count && guard < count + 5000; guard++, next++) {
    const code = `${prefix}${next}`;
    if (await codeExists(conn, code)) continue;      // e.g. someone typed "1005" by hand
    out.push(code);
  }
  if (out.length < count) throw new Error('Could not find free Proto Codes in the series');
  await conn.query("UPDATE app_settings SET setting_value=? WHERE setting_key='proto_code_last_number'",
    [`${prefix}|${next - 1}`]);
  return out;
}

// Manual codes: no code twice in one order/project (loose match).
// `taken` = codes already on the order/project that the new ones must not repeat.
function checkManualCodes(codes, taken = []) {
  const seen = new Map();
  for (const c of taken) { const n = normCode(c); if (n) seen.set(n, c); }
  for (const c of codes) {
    const n = normCode(c);
    if (!n) continue;
    if (seen.has(n)) {
      const e = new Error(`Proto Code "${c}" is used twice${seen.get(n) !== c ? ` (same as "${seen.get(n)}")` : ''}. Each item needs its own code.`);
      e.status = 400;
      throw e;
    }
    seen.set(n, c);
  }
}

// Codes for items being ADDED to a project (project page, approvals, client POs).
// Auto project → series codes (typed codes ignored); manual → typed codes, checked.
async function codesForNewProjectItems(conn, projectId, typedCodes) {
  const [[p]] = await conn.query('SELECT proto_mode FROM projects WHERE id=?', [projectId]);
  if (p?.proto_mode === 'auto') return takeCodes(conn, typedCodes.length);
  // Older projects (no mode chosen) keep working exactly as before
  if (p?.proto_mode !== 'manual') return typedCodes.map(c => (c === undefined ? null : c));
  const [existing] = await conn.query('SELECT proto_code FROM project_items WHERE project_id=?', [projectId]);
  const codes = typedCodes.map(cleanCode);
  checkManualCodes(codes, existing.map(r => r.proto_code));
  return codes.map(c => c || null);
}

module.exports = {
  MODES, modeOf, readMode, normCode, cleanCode, readSeries, previewCodes, takeCodes,
  checkManualCodes, codesForNewProjectItems,
};
