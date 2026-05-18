/**
 * Approval Middleware
 * ─────────────────────────────────────────────────────────────────────────────
 * Intercepts CREATE/UPDATE operations and applies approval workflow
 * Usage: app.use('/api/projects', requireApprovalForAction('PROJECT', 'write'))
 */

const { isApprovalRequired, createApprovalRequest, sendApprovalNotification } = require('../services/approvalService');

/**
 * Middleware: Check if approval is required, intercept if needed
 * @param {string} approvalType - 'PROJECT', 'ITEM', 'CHALLAN', 'PO_STATUS', 'SALE'
 * @param {string} permissionLevel - 'write', 'edit', 'delete'
 * @returns {Function} Express middleware
 */
function requireApprovalForAction(approvalType, permissionLevel = 'write') {
  return async (req, res, next) => {
    // Only apply to POST (create) and PATCH (status update) methods
    if (!['POST', 'PATCH', 'PUT'].includes(req.method)) {
      return next();
    }

    // Admins always bypass approval
    if (req.user?.role === 'admin') {
      return next();
    }

    // Check if approval is enabled for this action
    const needsApproval = await isApprovalRequired(approvalType);
    
    if (!needsApproval) {
      return next(); // Approval disabled, proceed normally
    }

    console.log(`⏳ Approval required for ${approvalType} by user ${req.user?.id}`);

    // Intercept the response to capture created data
    const originalJson = res.json.bind(res);
    res.json = function(body) {
      // Only intercept successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Create approval request instead of proceeding
        (async () => {
          try {
            const approvalResult = await createApprovalRequest({
              type: approvalType,
              userId: req.user.id,
              requestData: {
                method: req.method,
                path: req.path,
                body: req.body,
                query: req.query,
                params: req.params
              },
              relatedId: body?.id || null
            });

            // Send notification to admins
            await sendApprovalNotification({
              type: approvalType,
              userId: req.user.id,
              status: 'PENDING',
              message: `New ${approvalType} approval request`
            });

            // Return approval message instead of original response
            return originalJson({
              ...body,
              approval_status: 'PENDING',
              approval_id: approvalResult.approval_id,
              message: approvalResult.message,
              warning: `This action requires admin approval. Please check "My Approvals" for status.`
            });
          } catch (err) {
            console.error('Approval creation error:', err.message);
            // Fail open - if approval creation fails, allow the original operation
            return originalJson(body);
          }
        })();
      } else {
        return originalJson(body);
      }
    };

    next();
  };
}

/**
 * Simpler version: Just create approval, don't intercept response
 * For cases where we want to create approval in background
 */
function maybeCreateApprovalRequest(approvalType) {
  return async (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    
    const needsApproval = await isApprovalRequired(approvalType);
    if (!needsApproval) return next();

    // Attach flag to request so route handler can decide
    req.requiresApproval = true;
    req.approvalType = approvalType;
    
    next();
  };
}

module.exports = {
  requireApprovalForAction,
  maybeCreateApprovalRequest
};
