// ── Project ID Generator (NEW FILE — Phase 1 Main PO) ────────────────────────
// Same algorithm as the inline generator in POST /api/projects (routes/index.js):
// reads project_id_prefix / project_id_start_number from app_settings, takes the
// numeric tail of the most recent project_id and increments it.
// The existing manual Project creation route is intentionally NOT modified —
// this helper is used only by the Main PO approval resolver, so both flows share
// one continuous numbering series without touching live code.

async function generateProjectId(db) {
  try {
    const [settings] = await db.query(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('project_id_prefix', 'project_id_start_number')"
    );
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);
    const prefix = settingsMap.project_id_prefix || 'WM';
    const startNum = parseInt(settingsMap.project_id_start_number || '1001');

    const year = new Date().getFullYear().toString().slice(-2);
    const [last] = await db.query('SELECT project_id FROM projects ORDER BY id DESC LIMIT 1');
    let nextNum = startNum;
    if (last.length > 0) {
      const match = last[0].project_id?.match(/\d+$/);
      if (match) nextNum = parseInt(match[0]) + 1;
    }
    return `${prefix}-${year}-${nextNum}`;
  } catch (err) {
    console.error('projectNumbering settings fetch error:', err.message);
    const year = new Date().getFullYear().toString().slice(-2);
    return `WM-${year}-1001`;
  }
}

// Generic document series generator for new modules (Main PO now; vouchers /
// report series in later phases). Reads <prefixKey>/<startKey> from app_settings
// and increments the numeric tail of the latest value in <table>.<column>.
async function generateSeriesNumber(db, { prefixKey, startKey, defaultPrefix, table, column }) {
  let prefix = defaultPrefix;
  let startNum = 1001;
  try {
    const [settings] = await db.query(
      'SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?, ?)',
      [prefixKey, startKey]
    );
    const map = {};
    settings.forEach(s => map[s.setting_key] = s.setting_value);
    if (map[prefixKey]) prefix = map[prefixKey];
    if (map[startKey]) startNum = parseInt(map[startKey]) || startNum;
  } catch (e) { /* fall back to defaults */ }

  const year = new Date().getFullYear().toString().slice(-2);
  const [last] = await db.query(`SELECT ${column} AS v FROM ${table} ORDER BY id DESC LIMIT 1`);
  let nextNum = startNum;
  if (last.length > 0) {
    const match = last[0].v?.match(/\d+$/);
    if (match) nextNum = parseInt(match[0]) + 1;
  }
  return `${prefix}-${year}-${nextNum}`;
}

module.exports = { generateProjectId, generateSeriesNumber };
