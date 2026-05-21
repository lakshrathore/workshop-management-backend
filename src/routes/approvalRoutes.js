/**
 * Approval Management Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints for admin to manage approval requests
 * Mount at: router.use('/api', approvalRoutes)
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const {
  getPendingApprovalCounts,
  getPendingApprovals,
  getUserPendingApprovals,
  approveRequest,
  rejectRequest,
  sendApprovalNotification
} = require('../services/approvalService');

// ── Auth Middleware ────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token' });
  try {
    const jwt = require('jsonwebtoken');
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'workshop_secret_2024');
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/approvals/count
 * Get count of pending approvals (all users can view)
 */
router.get('/approvals/count', auth, async (req, res) => {
  try {
    const counts = await getPendingApprovalCounts();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/approvals
 * Get all pending approvals (Admin only)
 * Query params: type, userId, limit, offset
 */
router.get('/approvals', auth, adminOnly, async (req, res) => {
  try {
    const filters = {
      type: req.query.type || null,
      userId: req.query.userId || null,
      limit: req.query.limit || 50,
      offset: req.query.offset || 0
    };

    const approvals = await getPendingApprovals(filters);

    // Get total count
    const db = await getPool();
    const [[countResult]] = await db.query(
      'SELECT COUNT(*) as total FROM approvals WHERE status="PENDING"'
    );

    res.json({
      data: approvals,
      total: countResult.total,
      limit: filters.limit,
      offset: filters.offset
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/approvals/user-pending
 * Get current user's pending approvals (Workers/Clients)
 */
router.get('/approvals/user-pending', auth, async (req, res) => {
  try {
    const approvals = await getUserPendingApprovals(req.user.id);
    res.json(approvals);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/approvals/:id/approve
 * Approve an approval request (Admin only)
 */
router.post('/approvals/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const { adminNotes } = req.body;
    const approvalId = req.params.id;

    const result = await approveRequest(approvalId, req.user.id, adminNotes || '');

    // Send notification to requester
    try {
      const db = await getPool();
      const [[approval]] = await db.query(
        'SELECT * FROM approvals WHERE id=?',
        [approvalId]
      );
      await sendApprovalNotification({
        userId: approval.user_id,
        type: approval.type,
        status: 'APPROVED',
        message: `Your ${approval.type} approval request has been APPROVED`
      });
    } catch (e) {
      console.warn('Notification error:', e.message);
    }

    res.json({
      message: result.message,
      approval_id: result.approval_id
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * POST /api/approvals/:id/reject
 * Reject an approval request (Admin only)
 */
router.post('/approvals/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    const { reason } = req.body;
    const approvalId = req.params.id;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    const result = await rejectRequest(approvalId, req.user.id, reason);

    // Send notification to requester
    try {
      const db = await getPool();
      const [[approval]] = await db.query(
        'SELECT * FROM approvals WHERE id=?',
        [approvalId]
      );
      await sendApprovalNotification({
        userId: approval.user_id,
        type: approval.type,
        status: 'REJECTED',
        message: `Your ${approval.type} approval request has been REJECTED: ${reason}`
      });
    } catch (e) {
      console.warn('Notification error:', e.message);
    }

    res.json({
      message: result.message,
      approval_id: result.approval_id
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * POST /api/approvals/:id/bulk-approve
 * Approve multiple approvals at once (Admin only)
 */
router.post('/approvals/bulk-approve', auth, adminOnly, async (req, res) => {
  try {
    const { approval_ids, adminNotes } = req.body;

    if (!Array.isArray(approval_ids) || approval_ids.length === 0) {
      return res.status(400).json({ message: 'approval_ids must be non-empty array' });
    }

    const results = [];
    const errors = [];

    for (const id of approval_ids) {
      try {
        const result = await approveRequest(id, req.user.id, adminNotes || '');
        results.push({ id, status: 'approved' });
      } catch (err) {
        errors.push({ id, error: err.message });
      }
    }

    res.json({
      approved_count: results.length,
      error_count: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * DELETE /api/approvals/:id
 * Cancel/delete an approval request (Admin only or requester)
 */
router.delete('/approvals/:id', auth, async (req, res) => {
  try {
    const db = await getPool();
    const [[approval]] = await db.query('SELECT * FROM approvals WHERE id=?', [req.params.id]);

    if (!approval) {
      return res.status(404).json({ message: 'Approval not found' });
    }

    // Only admin or the requester can cancel
    if (req.user.role !== 'admin' && req.user.id !== approval.user_id) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Only PENDING approvals can be cancelled
    if (approval.status !== 'PENDING') {
      return res.status(400).json({ message: `Cannot cancel ${approval.status} approval` });
    }

    // Update to CANCELLED
    await db.query(
      'UPDATE approvals SET status="CANCELLED" WHERE id=?',
      [req.params.id]
    );

    // Decrement queue
    await db.query(
      `UPDATE approval_queue
       SET pending_count = GREATEST(0, pending_count - 1)
       WHERE user_id = ? AND action_type = ?`,
      [approval.user_id, approval.type]
    );

    res.json({ message: 'Approval cancelled' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/approvals/:id
 * Get details of a specific approval (Admin or requester)
 */
router.get('/approvals/:id', auth, async (req, res) => {
  try {
    const db = await getPool();
    const [[approval]] = await db.query(
      `SELECT 
        a.*, 
        u.name as user_name, u.username as user_username,
        admin.name as approved_by_name
      FROM approvals a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN users admin ON admin.id = a.approved_by
      WHERE a.id = ?`,
      [req.params.id]
    );

    if (!approval) {
      return res.status(404).json({ message: 'Approval not found' });
    }

    // Only admin or requester can view
    if (req.user.role !== 'admin' && req.user.id !== approval.user_id) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Parse JSON
    approval.requested_data = approval.requested_data ? JSON.parse(approval.requested_data) : {};

    res.json(approval);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /api/approvals/:id/note
 * Add/update admin notes on approval (Admin only)
 */
router.patch('/approvals/:id/note', auth, adminOnly, async (req, res) => {
  try {
    const { note } = req.body;
    const db = await getPool();

    await db.query(
      'UPDATE approvals SET admin_notes=? WHERE id=?',
      [note || '', req.params.id]
    );

    res.json({ message: 'Note updated' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── APPROVAL SETTINGS (Admin only) ───────────────────────────────────────────

/**
 * GET /api/approvals/settings — read all approval flags
 */
router.get('/approvals/settings', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(
      'SELECT setting_key, setting_value, description FROM approval_settings ORDER BY setting_key'
    );
    const settings = {};
    rows.forEach(r => {
      settings[r.setting_key] = {
        value: r.setting_value === '1',
        description: r.description
      };
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PUT /api/approvals/settings — bulk update
 * Body: { approval_system_enabled: true, require_approval_for_PROJECT: false, ... }
 */
router.put('/approvals/settings', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const updates = req.body || {};
    const allowedKeys = [
      'approval_system_enabled',
      'require_approval_for_PROJECT',
      'require_approval_for_ITEM',
      'require_approval_for_CHALLAN',
      'require_approval_for_PO_STATUS',
      'require_approval_for_SALE'
    ];

    for (const key of Object.keys(updates)) {
      if (!allowedKeys.includes(key)) continue;
      const val = updates[key] ? '1' : '0';
      await db.query(
        'UPDATE approval_settings SET setting_value=? WHERE setting_key=?',
        [val, key]
      );
    }
    res.json({ message: 'Approval settings updated' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
