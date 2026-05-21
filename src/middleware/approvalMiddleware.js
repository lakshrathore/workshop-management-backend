/**
 * Approval Middleware (v2 — BLOCKING design)
 * Worker create operations ko block karta hai jab approval required hai.
 */

const {
  isApprovalRequired,
  createApprovalRequest,
  sendApprovalNotification
} = require('../services/approvalService');

function requireApprovalForAction(approvalType) {
  return async (req, res, next) => {
    if (!['POST', 'PATCH', 'PUT'].includes(req.method)) return next();
    if (req.user?.role === 'admin') return next();
    if (req.isApprovedReplay) return next();

    let needsApproval = false;
    try {
      needsApproval = await isApprovalRequired(approvalType);
    } catch (err) {
      console.error(`[approval] isApprovalRequired error for ${approvalType}:`, err.message);
      return next(); // fail-open on DB error
    }

    if (!needsApproval) return next();

    console.log(`⏳ [approval] BLOCKED ${approvalType} by user ${req.user?.id}`);

    try {
      const approvalResult = await createApprovalRequest({
        type: approvalType,
        userId: req.user.id,
        requestData: {
          method: req.method,
          path: req.originalUrl || req.path,
          body: req.body,
          query: req.query,
          params: req.params
        },
        relatedId: req.params?.id ? Number(req.params.id) : null
      });

      sendApprovalNotification({
        type: approvalType,
        userId: req.user.id,
        status: 'PENDING',
        message: `New ${approvalType} approval request #${approvalResult.approval_id}`
      }).catch(e => console.warn('[approval] notif error:', e.message));

      return res.status(202).json({
        approval_status: 'PENDING',
        approval_id: approvalResult.approval_id,
        message: approvalResult.message,
        warning: 'Yeh action admin approval ke baad apply hoga. "My Approvals" me status check karo.'
      });
    } catch (err) {
      console.error('[approval] createApprovalRequest fatal:', err.message);
      return res.status(500).json({
        message: 'Approval system error. Please contact admin.',
        error: err.message
      });
    }
  };
}

module.exports = { requireApprovalForAction };
