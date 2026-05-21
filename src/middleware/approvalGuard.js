/**
 * APPROVAL GUARD — Centralized approval wiring
 * (See server.js for mount order. Must be mounted BEFORE app.use('/api', apiRoutes).)
 */

const { requireApprovalForAction } = require('./approvalMiddleware');

const APPROVAL_ROUTES = [
  { method: 'POST',  pattern: /^\/api\/projects\/\d+\/items\/?$/,            type: 'ITEM',      description: 'Worker item add karna' },
  { method: 'POST',  pattern: /^\/api\/projects\/?$/,                         type: 'PROJECT',   description: 'Worker project create karna' },
  { method: 'POST',  pattern: /^\/api\/sale-challans\/?$/,                    type: 'CHALLAN',   description: 'Sale challan create' },
  { method: 'PATCH', pattern: /^\/api\/purchase-orders\/\d+\/status\/?$/,     type: 'PO_STATUS', description: 'PO status change' },
];

function mountApprovalGuard(app) {
  app.use((req, res, next) => {
    const match = APPROVAL_ROUTES.find(r => r.method === req.method && r.pattern.test(req.path));
    if (!match) return next();
    return requireApprovalForAction(match.type)(req, res, next);
  });

  console.log(`✅ Approval Guard mounted — ${APPROVAL_ROUTES.length} protected route(s):`);
  APPROVAL_ROUTES.forEach(r => console.log(`   [${r.type}] ${r.method} ${r.pattern} — ${r.description}`));
}

async function selfCheckApprovalSystem() {
  try {
    const { getPool } = require('../database');
    const db = await getPool();

    const [tables] = await db.query("SHOW TABLES LIKE 'approvals'");
    if (!tables.length) {
      console.warn('⚠️  [APPROVAL SELF-CHECK] `approvals` table missing! Run database init.');
      return false;
    }

    const [[master]] = await db.query(
      "SELECT setting_value FROM approval_settings WHERE setting_key='approval_system_enabled'"
    );
    if (!master) {
      console.warn('⚠️  [APPROVAL SELF-CHECK] `approval_system_enabled` row missing.');
      return false;
    }
    if (master.setting_value !== '1') {
      console.warn('⚠️  [APPROVAL SELF-CHECK] Master switch is OFF — workers can create directly.');
      return false;
    }

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
