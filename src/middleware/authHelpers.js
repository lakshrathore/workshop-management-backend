// ── Shared Auth Helpers (NEW FILE — Phase 1 Main PO) ─────────────────────────
// Byte-equivalent copies of auth / adminOnly / adminOrPermission from
// routes/index.js. They are NOT exported there, and editing that live file
// carries risk, so new route modules import from here instead.
// Behavior is identical: same JWT secret resolution, same worker_permissions
// table, same level→column mapping, same response messages.

const jwt = require('jsonwebtoken');
const { getPool } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'workshop_secret_2024';

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ message: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
  next();
}

// adminOrPermission: admin gets through always; worker needs the specified permission level
// usage: adminOrPermission('main_po', 'read')
function adminOrPermission(menuKey, level = 'read') {
  return async (req, res, next) => {
    if (req.user.role === 'admin') return next();
    if (req.user.role !== 'worker') return res.status(403).json({ message: 'Access denied' });
    try {
      const db = await getPool();
      const [[perm]] = await db.query(
        'SELECT * FROM worker_permissions WHERE worker_id=? AND menu_key=?',
        [req.user.id, menuKey]
      );
      if (!perm) return res.status(403).json({ message: 'Access denied: no permission for this menu' });
      const levelMap = { read: 'can_read', write: 'can_write', edit: 'can_edit', delete: 'can_delete' };
      const col = levelMap[level];
      if (!perm[col]) return res.status(403).json({ message: `Access denied: ${level} permission required` });
      req.userPermission = perm;
      next();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  };
}

module.exports = { auth, adminOnly, adminOrPermission };
