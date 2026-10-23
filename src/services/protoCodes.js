// ── Proto Code series + per-order/per-project mode ─────────────────────────────
// A Manufacturing Order picks a Proto Code mode when it is created:
//   'manual' — the user types every code (nothing is generated)
//   'auto'   — the next code of the Settings series is given to each new item
// The mode is copied to the Project made from the order and never changes after.
// Older orders/projects have no mode (NULL) and keep working as manual.
//
// Series (Settings → Proto Code Series): proto_code_prefix + number, e.g. PROTO_1001.
// It starts at the Starting Number and skips any code already used anywhere, so
// codes never repeat across projects.

const MODES = ['manual', 'auto'];
const DEFAULT_PREFIX = 'PROTO_';
const DEFAULT_START = 1001;

const modeOf = v => (v === 'auto' ? 'auto' : 'manual');           // NULL / legacy = manual
const readMode = v => (MODES.includes(v) ? v : null);

// Same loose rule as the rest of the app: PROTO_86005 = PROTO-86005 = 86005
const normCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^PROTO/, '');

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

// Every Proto Code already used anywhere (loose form), so the series can skip them
async function usedCodes(db) {
  const set = new Set();
  for (const table of ['project_items', 'main_po_items']) {
    const [rows] = await db.query(`SELECT proto_code FROM ${table} WHERE proto_code IS NOT NULL AND proto_code <> ''`);
    for (const r of rows) { const n = normCode(r.proto_code); if (n) set.add(n); }
  }
  return set;
}

// The counter remembers "prefix|start|last number given". When the prefix or the
// Starting Number in Settings changes, counting starts again at the new Starting Number.
const COUNTER_KEY = 'proto_code_last_number';
function lastGiven(value, prefix, start) {
  const [p, st, last] = String(value || '').split('|');
  if (last !== undefined && p === prefix && Number(st) === start) return Math.max(start - 1, parseInt(last, 10) || 0);
  return start - 1;
}

// Next free numbers from the Starting Number, skipping codes that are already used
function pickCodes(prefix, from, count, used) {
  const out = [];
  let n = from;
  for (let guard = 0; out.length < count && guard < count + 100000; guard++, n++) {
    const code = `${prefix}${n}`;
    if (!used.has(normCode(code))) out.push(code);
  }
  if (out.length < count) throw new Error('Could not find free Proto Codes in the series');
  return { codes: out, last: n - 1 };
}

// What the next codes would be (preview only — nothing is reserved)
async function previewCodes(db, count = 1) {
  const { prefix, start } = await readSeries(db);
  const [[row]] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [COUNTER_KEY]);
  const { codes } = pickCodes(prefix, lastGiven(row?.setting_value, prefix, start) + 1, count, await usedCodes(db));
  return { prefix, start, next: codes[0], codes };
}

// Take the next `count` codes of the series. MUST run inside a transaction on `conn`:
// the counter row is locked until commit, so two saves can never get the same code.
async function takeCodes(conn, count) {
  if (!count) return [];
  const { prefix, start } = await readSeries(conn);
  await conn.query('INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [COUNTER_KEY, '']);
  const [[row]] = await conn.query('SELECT setting_value FROM app_settings WHERE setting_key=? FOR UPDATE', [COUNTER_KEY]);
  const { codes, last } = pickCodes(prefix, lastGiven(row?.setting_value, prefix, start) + 1, count, await usedCodes(conn));
  await conn.query('UPDATE app_settings SET setting_value=? WHERE setting_key=?', [`${prefix}|${start}|${last}`, COUNTER_KEY]);
  return codes;
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
