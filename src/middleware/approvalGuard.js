/**
 * APPROVAL GUARD — Centralized approval wiring
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * IMPORTANT FOR ANY DEVELOPER WORKING ON THIS PROJECT:
 * ─────────────────────────────────────────────────────────────────────────────
 * Iss file ka purpose hai approval middleware ko `routes/index.js` se DECOUPLE
 * karna. Routes file regenerate/refactor ho gayi tab bhi approval system kaam
 * karta rahega kyunki yeh server.js level pe mount hai.
 *
 * Naya endpoint approval ke under daalna ho to:
 *   1. APPROVAL_ROUTES array me entry add karo (method + URL pattern + type)
 *   2. agar new type hai to backend/src/middleware/approvalResolvers.js me
 *      resolver function add karo
 *   3. agar new type hai to database.js me approval_settings me flag seed karo
 *
 * server.js me iska mount yeh hai (PEHLE apiRoutes ke mounted hone ke):
 *
 *   const { mountApprovalGuard } = require('./middleware/approvalGuard');
 *   mountApprovalGuard(app);                  // ← yeh line MAT hatao
 *   app.use('/api', apiRoutes);
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const { requireApprovalForAction } = require('./approvalMiddleware');

/**
 * Approval routes table — single source of truth.
 * Order matters: zyada specific pattern pehle rakho.
 */
const APPROVAL_ROUTES = [
  // PROJECT items — /api/projects/:id/items (POST)
  {
    method: 'POST',
    pattern: /^\/api\/projects\/\d+\/items\/?$/,
    type: 'ITEM',
    description: 'Worker item add karna'
  },
  // PROJECT — /api/projects (POST)
  {
    method: 'POST',
    pattern: /^\/api\/projects\/?$/,
    type: 'PROJECT',
    description: 'Worker project create karna'
  },
  // Sale Challan — /api/sale-challans (POST)
  // NOTE: Resolver implement karne ke baad uncomment karo
  // {
  //   method: 'POST',
  //   pattern: /^\/api\/sale-challans\/?$/,
  //   type: 'CHALLAN',
  //   description: 'Sale challan create'
  // },
  // PO Status — /api/purchase-orders/:id/status (PATCH)
  // {
  //   method: 'PATCH',
  //   pattern: /^\/api\/purchase-orders\/\d+\/status\/?$/,
  //   type: 'PO_STATUS',
  //   description: 'PO status change'
  // },
];

/**
 * Mount global approval guard on the express app.
 * MUST be called BEFORE app.use('/api', apiRoutes).
 *
 * @param {import('express').Express} app
 */
function mountApprovalGuard(app) {
  app.use((req, res, next) => {
    const match = APPROVAL_ROUTES.find(r =>
      r.method === req.method && r.pattern.test(req.path)
    );
    if (!match) return next();

    // Hand off to per-type middleware
    return requireApprovalForAction(match.type)(req, res, next);
  });

  console.log(`✅ Approval Guard mounted — ${APPROVAL_ROUTES.length} protected route(s):`);
  APPROVAL_ROUTES.forEach(r => {
    console.log(`   [${r.type}] ${r.method} ${r.pattern} — ${r.description}`);
  });
}

/**
 * Boot-time self-check — run after server starts.
 * Verifies that approval system is configured correctly.
 */
async function selfCheckApprovalSystem() {
  try {
    const { getPool } = require('../database');
    const db = await getPool();

    // Check tables exist
    const [tables] = await db.query(
      "SHOW TABLES LIKE 'approvals'"
    );
    if (!tables.length) {
      console.warn('⚠️  [APPROVAL SELF-CHECK] `approvals` table missing! Run database init.');
      return false;
    }

    // Check master setting
    const [[master]] = await db.query(
      "SELECT setting_value FROM approval_settings WHERE setting_key='approval_system_enabled'"
    );
    if (!master) {
      console.warn('⚠️  [APPROVAL SELF-CHECK] `approval_system_enabled` row missing in approval_settings.');
      return false;
    }
    if (master.setting_value !== '1') {
      console.warn('⚠️  [APPROVAL SELF-CHECK] Master switch is OFF — approval system disabled. Workers can create directly.');
      console.warn('    Enable: UPDATE approval_settings SET setting_value=\'1\' WHERE setting_key=\'approval_system_enabled\';');
      return false;
    }

    // Check resolvers loaded
    const { RESOLVERS } = require('./approvalResolvers');
    const enabledTypes = APPROVAL_ROUTES.map(r => r.type);
    const missingResolvers = enabledTypes.filter(t => !RESOLVERS[t]);
    if (missingResolvers.length) {
      console.warn(`⚠️  [APPROVAL SELF-CHECK] Resolvers missing for types: ${missingResolvers.join(', ')}`);
      return false;
    }

    console.log(`✅ [APPROVAL SELF-CHECK] System healthy — ${enabledTypes.length} type(s) protected, all resolvers loaded.`);
    return true;
  } catch (err) {
    console.error('❌ [APPROVAL SELF-CHECK] Error:', err.message);
    return false;
  }
}

module.exports = { mountApprovalGuard, selfCheckApprovalSystem, APPROVAL_ROUTES };
