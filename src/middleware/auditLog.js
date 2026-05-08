// ── Audit Log Middleware ──────────────────────────────────────────────────────
// Automatically logs CREATE / UPDATE / DELETE actions to audit_logs table
// Usage: router.post('/tasks', auth, auditLog('CREATE','Task'), handler)

const { getPool } = require('../database');

/**
 * @param {string} actionType  - 'CREATE' | 'UPDATE' | 'DELETE' | 'VIEW'
 * @param {string} moduleName  - 'Task' | 'Project' | 'Worker' | 'Material' etc.
 * @param {Function} [getRecordId] - optional fn(req, res_body) => id
 */
function auditLog(actionType, moduleName, getRecordId = null) {
  return async (req, res, next) => {
    // Wrap res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = async function (body) {
      // Only log successful responses (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
        try {
          const db = await getPool();
          const userId   = req.user.id;
          const userRole = req.user.role;

          // Try to determine record id
          let recordId = null;
          if (getRecordId) {
            recordId = getRecordId(req, body);
          } else if (req.params?.id) {
            recordId = req.params.id;
          } else if (body?.id) {
            recordId = body.id;
          }

          // Human-readable description
          const description = `${userRole} "${req.user.name}" performed ${actionType} on ${moduleName}${recordId ? ` #${recordId}` : ''}`;

          // old_value for UPDATE: store req.body before (what was sent)
          const oldValue = (actionType === 'UPDATE' || actionType === 'DELETE')
            ? JSON.stringify(req.body || {})
            : null;

          // new_value: what the API returned
          const newValue = (actionType === 'CREATE' || actionType === 'UPDATE')
            ? JSON.stringify(body || {})
            : null;

          await db.query(
            `INSERT INTO audit_logs
              (user_id, user_role, action_type, module_name, record_id, old_value, new_value, description)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, userRole, actionType, moduleName, recordId, oldValue, newValue, description]
          );
        } catch (err) {
          // Never break the main request because of audit failure
          console.error('Audit log error:', err.message);
        }
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = auditLog;
