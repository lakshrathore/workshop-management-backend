/**
 * APPROVAL GUARD — Centralized approval wiring
 * (See server.js for mount order. Must be mounted BEFORE app.use('/api', apiRoutes).)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITICAL FIX (2025) — req.params extraction
 * ─────────────────────────────────────────────────────────────────────────────
 * Pehle ke version me ek bug tha: yeh middleware `app.use()` se mount hota hai
 * (app-level), Express ne route-matching abhi tak ki nahi hoti, isliye
 * `req.params` HAMESHA empty `{}` rehta tha. Result:
 *
 *   POST /api/projects/42/items
 *     → req.params = {} (NOT { id: '42' })
 *     → approval payload me project_id store nahi hota
 *     → admin jab approve karta hai, resolver fail:
 *       "Project ID missing in approval payload - cannot create item without project"
 *
 * Fix: pattern me capture group (`(\d+)`) lagao aur `paramNames` se inject karo
 * `req.params` me, fir downstream middleware ko sahi data milega.
 */

const { requireApprovalForAction } = require('./approvalMiddleware');

const APPROVAL_ROUTES = [
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/items\/?$/,
    paramNames: ['id'],           // captured (\d+) → req.params.id
    type: 'ITEM',
    description: 'Worker item add karna (project_id URL me hai)'
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/?$/,
    paramNames: [],
    type: 'PROJECT',
    description: 'Worker project create karna'
  },
  {
    method: 'POST',
    pattern: /^\/api\/sale-challans\/?$/,
    paramNames: [],
    type: 'CHALLAN',
    description: 'Sale challan create (project_id body me hai)'
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/purchase-orders\/(\d+)\/status\/?$/,
    paramNames: ['id'],           // captured (\d+) → req.params.id (po id)
    type: 'PO_STATUS',
    description: 'PO status change'
  },
];

function mountApprovalGuard(app) {
  app.use((req, res, next) => {
    // Method check pehle (faster reject)
    const route = APPROVAL_ROUTES.find(
      r => r.method === req.method && r.pattern.test(req.path)
    );
    if (!route) return next();

    // ── CRITICAL: app-level middleware me Express ne req.params populate
    //    nahi kiya hota. Manually regex captures se inject karo, taaki
    //    approvalMiddleware aur resolvers ko ID mil sake.
    if (route.paramNames.length > 0) {
      const m = req.path.match(route.pattern);
      if (m) {
        // Existing req.params preserve karo (defense in depth)
        req.params = { ...(req.params || {}) };
        route.paramNames.forEach((name, idx) => {
          // m[0] = full match, m[1..] = captures
          if (m[idx + 1] !== undefined) {
            req.params[name] = m[idx + 1];
          }
        });
      }
    }

    return requireApprovalForAction(route.type)(req, res, next);
  });

  console.log(`✅ Approval Guard mounted — ${APPROVAL_ROUTES.length} protected route(s):`);
  APPROVAL_ROUTES.forEach(r => {
    const captures = r.paramNames.length ? ` [captures: ${r.paramNames.join(',')}]` : '';
    console.log(`   [${r.type}] ${r.method} ${r.pattern}${captures} — ${r.description}`);
  });
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
