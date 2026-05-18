/**
 * Approval System Utilities
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all approval workflow logic:
 * - Check if approval is needed
 * - Create approval request
 * - Approve/Reject requests
 * - Count pending approvals
 * - Send notifications
 */

const { getPool } = require('../database');

/**
 * Check if approval system is enabled
 * @param {string} actionType - 'PROJECT', 'ITEM', 'CHALLAN', 'PO_STATUS', 'SALE'
 * @returns {Promise<boolean>}
 */
async function isApprovalRequired(actionType) {
  const db = await getPool();
  try {
    // Check master switch first
    const [[master]] = await db.query(
      "SELECT setting_value FROM approval_settings WHERE setting_key='approval_system_enabled'"
    );
    if (!master || master.setting_value !== '1') return false;

    // Check specific action type setting
    const [[specific]] = await db.query(
      "SELECT setting_value FROM approval_settings WHERE setting_key=?",
      [`require_approval_for_${actionType}`]
    );
    return specific && specific.setting_value === '1';
  } catch (err) {
    console.error('isApprovalRequired error:', err.message);
    return false; // Fail open - don't require approval if check fails
  }
}

/**
 * Create approval request (don't create actual resource yet)
 * @param {Object} params
 * @returns {Promise<{approval_id, message}>}
 */
async function createApprovalRequest(params) {
  const db = await getPool();
  const { type, userId, requestData, relatedId = null } = params;

  try {
    // 1. Create approval record (PENDING)
    const [result] = await db.query(
      `INSERT INTO approvals (type, user_id, requested_data, related_id, status)
       VALUES (?, ?, ?, ?, 'PENDING')`,
      [type, userId, JSON.stringify(requestData), relatedId]
    );

    const approvalId = result.insertId;

    // 2. Update approval_queue (increment pending count)
    await db.query(
      `INSERT INTO approval_queue (user_id, action_type, pending_count, last_request_at)
       VALUES (?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE
       pending_count = pending_count + 1,
       last_request_at = NOW()`,
      [userId, type]
    );

    console.log(`✅ Approval created: ID=${approvalId}, Type=${type}, User=${userId}`);

    return {
      approval_id: approvalId,
      message: `Request pending admin approval. ID: #${approvalId}`,
      status: 'PENDING'
    };
  } catch (err) {
    console.error('createApprovalRequest error:', err.message);
    throw err;
  }
}

/**
 * Get count of pending approvals
 * @returns {Promise<{total, by_type}>}
 */
async function getPendingApprovalCounts() {
  const db = await getPool();
  try {
    // Total pending
    const [[total]] = await db.query(
      "SELECT COUNT(*) as count FROM approvals WHERE status='PENDING'"
    );

    // Breakdown by type
    const [byType] = await db.query(
      "SELECT type, COUNT(*) as count FROM approvals WHERE status='PENDING' GROUP BY type"
    );

    const breakdown = {};
    byType.forEach(row => {
      breakdown[row.type] = row.count;
    });

    return {
      total: total.count || 0,
      by_type: breakdown
    };
  } catch (err) {
    console.error('getPendingApprovalCounts error:', err.message);
    return { total: 0, by_type: {} };
  }
}

/**
 * Get all pending approvals (admin view)
 * @param {Object} filters - { type, userId, limit, offset }
 * @returns {Promise<Array>}
 */
async function getPendingApprovals(filters = {}) {
  const db = await getPool();
  try {
    let query = `
      SELECT 
        a.id, a.type, a.related_id, a.user_id, a.requested_data,
        a.status, a.created_at, a.admin_notes,
        u.name as user_name, u.username as user_username
      FROM approvals a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.status = 'PENDING'
    `;
    const params = [];

    if (filters.type) {
      query += ' AND a.type = ?';
      params.push(filters.type);
    }

    if (filters.userId) {
      query += ' AND a.user_id = ?';
      params.push(filters.userId);
    }

    query += ' ORDER BY a.created_at ASC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(parseInt(filters.limit));
      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(parseInt(filters.offset));
      }
    }

    const [rows] = await db.query(query, params);
    
    // Parse JSON data
    return rows.map(row => ({
      ...row,
      requested_data: row.requested_data ? JSON.parse(row.requested_data) : {}
    }));
  } catch (err) {
    console.error('getPendingApprovals error:', err.message);
    return [];
  }
}

/**
 * Get user's own pending approvals
 * @param {number} userId
 * @returns {Promise<Array>}
 */
async function getUserPendingApprovals(userId) {
  const db = await getPool();
  try {
    const [rows] = await db.query(
      `SELECT 
        a.id, a.type, a.related_id, a.status, a.created_at,
        a.approved_at, a.admin_notes, a.rejected_reason,
        ap.approved_by, u.name as approved_by_name
      FROM approvals a
      LEFT JOIN approvals ap ON a.id = ap.id
      LEFT JOIN users u ON ap.approved_by = u.id
      WHERE a.user_id = ? AND a.status IN ('PENDING', 'APPROVED', 'REJECTED')
      ORDER BY a.created_at DESC
      LIMIT 20`,
      [userId]
    );
    return rows;
  } catch (err) {
    console.error('getUserPendingApprovals error:', err.message);
    return [];
  }
}

/**
 * Approve an approval request
 * @param {number} approvalId - ID of approval record
 * @param {number} adminId - ID of admin approving
 * @param {string} adminNotes - Optional notes
 * @returns {Promise<Object>} - { approval, approval_id, message }
 */
async function approveRequest(approvalId, adminId, adminNotes = '') {
  const db = await getPool();
  try {
    // 1. Get approval record
    const [[approval]] = await db.query(
      'SELECT * FROM approvals WHERE id=?',
      [approvalId]
    );

    if (!approval) {
      throw new Error('Approval not found');
    }

    if (approval.status !== 'PENDING') {
      throw new Error(`Cannot approve non-PENDING approval (current status: ${approval.status})`);
    }

    // 2. Update approval status to APPROVED
    await db.query(
      `UPDATE approvals 
       SET status='APPROVED', approved_by=?, approved_at=NOW(), admin_notes=?
       WHERE id=?`,
      [adminId, adminNotes, approvalId]
    );

    // 3. Decrement pending count in approval_queue
    await db.query(
      `UPDATE approval_queue
       SET pending_count = GREATEST(0, pending_count - 1)
       WHERE user_id = ? AND action_type = ?`,
      [approval.user_id, approval.type]
    );

    // 4. Log in audit_logs
    try {
      await db.query(
        `INSERT INTO audit_logs 
         (user_id, user_role, action_type, module_name, record_id, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [adminId, 'admin', 'APPROVE', 'Approval', approvalId, 
         `Admin approved ${approval.type} approval from user ${approval.user_id}`]
      );
    } catch (e) {
      console.warn('Audit log error:', e.message);
    }

    console.log(`✅ Approval #${approvalId} (${approval.type}) APPROVED by admin ${adminId}`);

    return {
      approval_id: approvalId,
      message: `Approval #${approvalId} approved`,
      approval
    };
  } catch (err) {
    console.error('approveRequest error:', err.message);
    throw err;
  }
}

/**
 * Reject an approval request
 * @param {number} approvalId - ID of approval record
 * @param {number} adminId - ID of admin rejecting
 * @param {string} reason - Reason for rejection
 * @returns {Promise<Object>} - { approval_id, message }
 */
async function rejectRequest(approvalId, adminId, reason = '') {
  const db = await getPool();
  try {
    // 1. Get approval record
    const [[approval]] = await db.query(
      'SELECT * FROM approvals WHERE id=?',
      [approvalId]
    );

    if (!approval) {
      throw new Error('Approval not found');
    }

    if (approval.status !== 'PENDING') {
      throw new Error(`Cannot reject non-PENDING approval (current status: ${approval.status})`);
    }

    // 2. Update approval status to REJECTED
    await db.query(
      `UPDATE approvals 
       SET status='REJECTED', approved_by=?, rejected_at=NOW(), rejected_reason=?
       WHERE id=?`,
      [adminId, reason, approvalId]
    );

    // 3. Decrement pending count in approval_queue
    await db.query(
      `UPDATE approval_queue
       SET pending_count = GREATEST(0, pending_count - 1)
       WHERE user_id = ? AND action_type = ?`,
      [approval.user_id, approval.type]
    );

    // 4. Log in audit_logs
    try {
      await db.query(
        `INSERT INTO audit_logs 
         (user_id, user_role, action_type, module_name, record_id, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [adminId, 'admin', 'REJECT', 'Approval', approvalId, 
         `Admin rejected ${approval.type} approval from user ${approval.user_id}: ${reason}`]
      );
    } catch (e) {
      console.warn('Audit log error:', e.message);
    }

    console.log(`❌ Approval #${approvalId} (${approval.type}) REJECTED by admin ${adminId}`);

    return {
      approval_id: approvalId,
      message: `Approval #${approvalId} rejected: ${reason}`,
      approval
    };
  } catch (err) {
    console.error('rejectRequest error:', err.message);
    throw err;
  }
}

/**
 * Send notification to user (placeholder for email/push system)
 * @param {Object} params
 */
async function sendApprovalNotification(params) {
  const { userId, type, status, message } = params;
  
  // TODO: Integrate with email service
  console.log(`📧 NOTIFICATION: User ${userId} - ${type} approval ${status}: ${message}`);
  
  // In future: send email, push notification, etc.
}

module.exports = {
  isApprovalRequired,
  createApprovalRequest,
  getPendingApprovalCounts,
  getPendingApprovals,
  getUserPendingApprovals,
  approveRequest,
  rejectRequest,
  sendApprovalNotification
};
