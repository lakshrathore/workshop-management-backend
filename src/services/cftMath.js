// ── CFT maths shared by CFT sheets, Wood Inward and the wood stock reports ──
// CFT per piece = L × W × T (mm) × 0.00000003528 ; total = per piece × qty (4 decimals)

const CFT_CONSTANT = 0.00000003528; // fixed conversion constant (mm³ → CFT)
const r4 = n => Math.round((Number(n) || 0) * 10000) / 10000;

function rowCft(row) {
  const L = Number(row.length) || 0, W = Number(row.width) || 0, T = Number(row.thickness) || 0;
  const qty = Number(row.qty) || 0;
  const gross = L * W * T * CFT_CONSTANT;      // per piece
  return { gross_cft: r4(gross), net_cft: r4(gross * qty) };
}

module.exports = { CFT_CONSTANT, r4, rowCft };
