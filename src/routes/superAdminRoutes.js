/**
 * SUPER ADMIN ROUTES
 * Packages (plans) + Organizations (subscribers) management.
 * Super Admin login fixed credentials ke saath hota hai (DB user nahi hai).
 * Ye deployment khud "Primary Organization" hai — uska status / expiry
 * yahan se control hota hai (suspend / expire hone par login block).
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getPool } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'workshop_secret_2024';

// ── Fixed Super Admin credentials ────────────────────────────────────────────
const SUPER_ADMIN_USERNAME = 'Superadmin';
const SUPER_ADMIN_PASSWORD = 'Laksh@@8173';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Brute-force protection: 10 galat password per IP → 15 min lock
const failedAttempts = new Map();
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

/**
 * Login handler se call hota hai. Returns:
 *  null                         → ye super admin login nahi hai, normal login continue karo
 *  { status, body }             → response bhej do
 */
function trySuperAdminLogin(req) {
  const { username, password } = req.body || {};
  if (username !== SUPER_ADMIN_USERNAME) return null;

  const ip = clientIp(req);
  const rec = failedAttempts.get(ip);
  if (rec && rec.lockedUntil > Date.now()) {
    return { status: 429, body: { message: 'Too many attempts. Please try again after 15 minutes.' } };
  }

  if (!safeEqual(password, SUPER_ADMIN_PASSWORD)) {
    const r = rec && !(rec.lockedUntil && rec.lockedUntil <= Date.now()) ? rec : { count: 0, lockedUntil: 0 };
    r.count += 1;
    if (r.count >= MAX_FAILS) { r.lockedUntil = Date.now() + LOCK_MS; r.count = 0; }
    failedAttempts.set(ip, r);
    return null; // normal login try karne do (agar same naam ka DB user ho)
  }

  failedAttempts.delete(ip);
  const user = { id: 0, name: 'Super Admin', username: SUPER_ADMIN_USERNAME, role: 'superadmin' };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '12h' });
  return { status: 200, body: { token, user: { ...user, departments: [] } } };
}

function superAdminOnly(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'superadmin') return res.status(403).json({ message: 'Super Admin only' });
    req.user = decoded;
    next();
  } catch { res.status(401).json({ message: 'Invalid token' }); }
}

// ── Tables ───────────────────────────────────────────────────────────────────
async function initSuperAdminTables() {
  const db = await getPool();

  await db.query(`CREATE TABLE IF NOT EXISTS sa_packages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    price DECIMAL(12,2) DEFAULT 0,
    duration_days INT NOT NULL DEFAULT 365,
    max_users INT NULL,
    features TEXT,
    is_active TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS sa_organizations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(150),
    email VARCHAR(150),
    phone VARCHAR(50),
    address TEXT,
    gst_number VARCHAR(50),
    domain VARCHAR(255),
    package_id INT NULL,
    status ENUM('active','trial','suspended') DEFAULT 'active',
    start_date DATE NULL,
    expiry_date DATE NULL,
    max_users INT NULL,
    notes TEXT,
    is_primary TINYINT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS sa_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    organization_id INT NOT NULL,
    package_id INT NULL,
    package_name VARCHAR(150),
    amount DECIMAL(12,2) DEFAULT 0,
    start_date DATE,
    end_date DATE,
    payment_mode VARCHAR(50),
    reference VARCHAR(150),
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_org (organization_id)
  )`);

  // Live deployment = Primary Organization. Expiry NULL = kabhi block nahi hoga
  // jab tak Super Admin khud package / expiry set na kare.
  const [[primary]] = await db.query('SELECT id FROM sa_organizations WHERE is_primary=1 LIMIT 1');
  if (!primary) {
    let companyName = 'Primary Organization';
    try {
      const [[s]] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='company_name'");
      if (s?.setting_value) companyName = s.setting_value;
    } catch {}
    await db.query(
      "INSERT INTO sa_organizations (name, status, start_date, is_primary, notes) VALUES (?, 'active', CURDATE(), 1, ?)",
      [companyName, 'This is the current live deployment (running on this URL).']
    );
    console.log(`✅ Super Admin: primary organization created (${companyName})`);
  }
  // One-time firm rename MOJI → MOZI (firm ka naam badla hai). Sirf tab badlo jab
  // value abhi bhi exactly purana naam ho, aur flag set karo taaki dobara na chale —
  // baad mein Settings se jo naam rakha jaye wo kabhi overwrite nahi hoga.
  const [[renamed]] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='firm_rename_mozi_done'");
  if (!renamed) {
    const [a] = await db.query("UPDATE app_settings SET setting_value='MOZI INNOVATORS LLP' WHERE setting_key='company_name' AND setting_value='MOJI INNOVATORS LLP'");
    const [b] = await db.query("UPDATE sa_organizations SET name='MOZI INNOVATORS LLP' WHERE is_primary=1 AND name='MOJI INNOVATORS LLP'");
    await db.query("INSERT INTO app_settings (setting_key, setting_value) VALUES ('firm_rename_mozi_done', '1')");
    console.log(`✅ Firm rename MOJI → MOZI applied (company_name: ${a.affectedRows}, organization: ${b.affectedRows})`);
  }
  console.log('✅ Super Admin tables ready');
}

// ── Status helpers ───────────────────────────────────────────────────────────
function computeStatus(org) {
  if (org.status === 'suspended') return 'suspended';
  if (org.expiry_date) {
    const exp = new Date(org.expiry_date);
    exp.setHours(23, 59, 59, 999);
    if (exp < new Date()) return 'expired';
  }
  return org.status; // active | trial
}

function daysLeft(org) {
  if (!org.expiry_date) return null;
  const exp = new Date(org.expiry_date); exp.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((exp - today) / 86400000);
}

// mysql2 DATE ko local-midnight Date deta hai → local parts se YYYY-MM-DD banao
function toYMD(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function decorate(org) {
  return {
    ...org,
    start_date: toYMD(org.start_date),
    expiry_date: toYMD(org.expiry_date),
    effective_status: computeStatus(org),
    days_left: daysLeft(org),
  };
}

function formatSub(s) {
  return { ...s, start_date: toYMD(s.start_date), end_date: toYMD(s.end_date) };
}

// e.g. "Standard – ₹12,000 / 365 days" (package jo org ko assign kiya hai)
function formatINR(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function formatDMY(d) {
  const [y, m, day] = toYMD(d).split('-');
  return `${day}-${m}-${y}`;
}
function planText(org) {
  if (!org.package_name) return '';
  return `${org.package_name} – ${formatINR(org.package_price)} / ${org.package_days} days`;
}

// Primary org status — 30 sec cache. Error par fail-open (live client kabhi galti se block na ho).
let statusCache = null;
let statusCacheAt = 0;
async function getPrimaryOrgAccess() {
  if (statusCache && Date.now() - statusCacheAt < 30000) return statusCache;
  try {
    const db = await getPool();
    const [[org]] = await db.query(
      `SELECT o.*, p.name AS package_name, p.price AS package_price, p.duration_days AS package_days
       FROM sa_organizations o LEFT JOIN sa_packages p ON p.id=o.package_id WHERE o.is_primary=1 LIMIT 1`
    );
    let result = { blocked: false };
    if (org) {
      const st = computeStatus(org);
      const plan = planText(org);
      if (st === 'suspended') {
        result = { blocked: true, reason: 'suspended', message: `Your account has been suspended.${plan ? ` Plan: ${plan}.` : ''} Please contact your administrator to reactivate it.` };
      } else if (st === 'expired') {
        result = { blocked: true, reason: 'expired', message: `Your subscription expired on ${formatDMY(org.expiry_date)}.${plan ? ` Renew your ${plan} plan to continue.` : ' Please renew to continue.'} Contact your administrator for renewal.` };
      }
    }
    statusCache = result; statusCacheAt = Date.now();
    return result;
  } catch (err) {
    console.error('Org status check error:', err.message);
    return { blocked: false };
  }
}
function clearStatusCache() { statusCache = null; statusCacheAt = 0; }

// Already logged-in users (purane token) ko bhi block karo jab org suspend/expire ho
async function orgAccessGuard(req, res, next) {
  const p = req.path;
  if (p.startsWith('/superadmin') || p.startsWith('/auth') || p.startsWith('/license')) return next();
  // Public website (moji.org.in) visitors ke liye hamesha open — CMS admin routes guard ke andar hi rehte hain
  if (p.startsWith('/website/public')) return next();
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next();
  try {
    if (jwt.verify(token, JWT_SECRET).role === 'superadmin') return next();
  } catch { return next(); } // invalid token — aage ka auth middleware 401 dega
  const access = await getPrimaryOrgAccess();
  if (access.blocked) return res.status(403).json({ org_blocked: true, reason: access.reason, message: access.message });
  next();
}

// Package ka max_users limit (org override > package). null = unlimited
async function checkUserLimit() {
  try {
    const db = await getPool();
    const [[org]] = await db.query(
      `SELECT o.max_users AS org_max, p.max_users AS pkg_max, p.name AS package_name, p.price AS package_price, p.duration_days AS package_days
       FROM sa_organizations o LEFT JOIN sa_packages p ON p.id=o.package_id WHERE o.is_primary=1 LIMIT 1`
    );
    const limit = org ? (org.org_max ?? org.pkg_max ?? null) : null;
    if (limit == null) return { allowed: true, limit: null };
    const [[{ used }]] = await db.query("SELECT COUNT(*) AS used FROM users WHERE is_active=1 AND role IN ('admin','worker')");
    const plan = planText(org);
    const message = `User limit reached (${used}/${limit})${plan ? ` on your ${plan} plan` : ''}. Please contact your administrator to upgrade your package.`;
    return { allowed: used < limit, limit, used, message };
  } catch { return { allowed: true, limit: null }; }
}

// Body se sirf allowed fields lo
const ORG_FIELDS = ['name', 'contact_person', 'email', 'phone', 'address', 'gst_number', 'domain', 'package_id', 'status', 'start_date', 'expiry_date', 'max_users', 'notes'];
const PKG_FIELDS = ['name', 'description', 'price', 'duration_days', 'max_users', 'features', 'is_active'];

function pick(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body[f] === undefined) continue;
    let v = body[f];
    if (v === '') v = null;
    if (f === 'features' && Array.isArray(v)) v = JSON.stringify(v);
    out[f] = v;
  }
  return out;
}

function parsePackage(p) {
  let features = [];
  try { features = p.features ? JSON.parse(p.features) : []; } catch { features = String(p.features).split('\n').filter(Boolean); }
  return { ...p, features };
}

function addDays(ymd, days) {
  const d = new Date(`${toYMD(ymd)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

router.use('/superadmin', superAdminOnly);

// ── Dashboard ────────────────────────────────────────────────────────────────
router.get('/superadmin/dashboard', async (req, res) => {
  try {
    const db = await getPool();
    const [orgs] = await db.query('SELECT o.*, p.name AS package_name FROM sa_organizations o LEFT JOIN sa_packages p ON p.id=o.package_id');
    const list = orgs.map(decorate);
    const [[pk]] = await db.query('SELECT COUNT(*) AS total, SUM(is_active=1) AS active FROM sa_packages');
    const [[rev]] = await db.query(`SELECT COALESCE(SUM(amount),0) AS total,
      COALESCE(SUM(CASE WHEN YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE()) THEN amount ELSE 0 END),0) AS this_month
      FROM sa_subscriptions`);
    const [[users]] = await db.query(`SELECT COUNT(*) AS total,
      SUM(role='admin' AND is_active=1) AS admins, SUM(role='worker' AND is_active=1) AS workers,
      SUM(role='client' AND is_active=1) AS clients FROM users`);
    let projects = 0;
    try { const [[pr]] = await db.query('SELECT COUNT(*) AS c FROM projects'); projects = pr.c; } catch {}
    const [recent] = await db.query(`SELECT s.*, o.name AS organization_name FROM sa_subscriptions s
      LEFT JOIN sa_organizations o ON o.id=s.organization_id ORDER BY s.created_at DESC LIMIT 8`);

    res.json({
      organizations: {
        total: list.length,
        active: list.filter(o => o.effective_status === 'active').length,
        trial: list.filter(o => o.effective_status === 'trial').length,
        suspended: list.filter(o => o.effective_status === 'suspended').length,
        expired: list.filter(o => o.effective_status === 'expired').length,
        expiring_soon: list.filter(o => o.days_left != null && o.days_left >= 0 && o.days_left <= 15 && o.effective_status !== 'suspended'),
      },
      packages: { total: Number(pk.total || 0), active: Number(pk.active || 0) },
      revenue: { total: Number(rev.total), this_month: Number(rev.this_month) },
      primary: {
        organization: list.find(o => o.is_primary) || null,
        users: { total: Number(users.total || 0), admins: Number(users.admins || 0), workers: Number(users.workers || 0), clients: Number(users.clients || 0) },
        projects: Number(projects || 0),
      },
      recent_subscriptions: recent.map(formatSub),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Packages ─────────────────────────────────────────────────────────────────
router.get('/superadmin/packages', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`SELECT p.*, (SELECT COUNT(*) FROM sa_organizations o WHERE o.package_id=p.id) AS org_count
      FROM sa_packages p ORDER BY p.price ASC, p.id ASC`);
    res.json(rows.map(parsePackage));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/superadmin/packages', async (req, res) => {
  const data = pick(req.body, PKG_FIELDS);
  if (!data.name) return res.status(400).json({ message: 'Package name is required' });
  if (!data.duration_days || Number(data.duration_days) < 1) return res.status(400).json({ message: 'Duration must be at least 1 day' });
  try {
    const db = await getPool();
    const [r] = await db.query('INSERT INTO sa_packages SET ?', [data]);
    res.json({ id: r.insertId, message: 'Package created' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/superadmin/packages/:id', async (req, res) => {
  const data = pick(req.body, PKG_FIELDS);
  if (data.name === null) return res.status(400).json({ message: 'Package name is required' });
  if (!Object.keys(data).length) return res.status(400).json({ message: 'Nothing to update' });
  try {
    const db = await getPool();
    await db.query('UPDATE sa_packages SET ? WHERE id=?', [data, req.params.id]);
    clearStatusCache();
    res.json({ message: 'Package updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/superadmin/packages/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [[{ c }]] = await db.query('SELECT COUNT(*) AS c FROM sa_organizations WHERE package_id=?', [req.params.id]);
    if (c > 0) return res.status(400).json({ message: `This package is assigned to ${c} organization(s). Change their package first, or mark this package inactive.` });
    await db.query('DELETE FROM sa_packages WHERE id=?', [req.params.id]);
    res.json({ message: 'Package deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Organizations ────────────────────────────────────────────────────────────
router.get('/superadmin/organizations', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(`SELECT o.*, p.name AS package_name, p.max_users AS package_max_users
      FROM sa_organizations o LEFT JOIN sa_packages p ON p.id=o.package_id
      ORDER BY o.is_primary DESC, o.created_at DESC`);
    let primaryUsers = null;
    try {
      const [[u]] = await db.query("SELECT COUNT(*) AS c FROM users WHERE is_active=1 AND role IN ('admin','worker')");
      primaryUsers = u.c;
    } catch {}
    res.json(rows.map(o => ({ ...decorate(o), users_used: o.is_primary ? primaryUsers : null })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/superadmin/organizations/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [[org]] = await db.query(`SELECT o.*, p.name AS package_name, p.max_users AS package_max_users
      FROM sa_organizations o LEFT JOIN sa_packages p ON p.id=o.package_id WHERE o.id=?`, [req.params.id]);
    if (!org) return res.status(404).json({ message: 'Organization not found' });
    const [subs] = await db.query('SELECT * FROM sa_subscriptions WHERE organization_id=? ORDER BY created_at DESC', [req.params.id]);
    res.json({ ...decorate(org), subscriptions: subs.map(formatSub) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/superadmin/organizations', async (req, res) => {
  const data = pick(req.body, ORG_FIELDS);
  if (!data.name) return res.status(400).json({ message: 'Organization name is required' });
  try {
    const db = await getPool();
    if (!data.start_date) data.start_date = toYMD(new Date());
    // Package diya hai aur expiry nahi → package duration se expiry nikalo
    if (data.package_id && !data.expiry_date) {
      const [[pkg]] = await db.query('SELECT duration_days FROM sa_packages WHERE id=?', [data.package_id]);
      if (pkg) data.expiry_date = addDays(data.start_date, pkg.duration_days - 1);
    }
    const [r] = await db.query('INSERT INTO sa_organizations SET ?', [{ ...data, is_primary: 0 }]);
    res.json({ id: r.insertId, message: 'Organization created' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/superadmin/organizations/:id', async (req, res) => {
  const data = pick(req.body, ORG_FIELDS);
  if (data.name === null) return res.status(400).json({ message: 'Organization name is required' });
  if (!Object.keys(data).length) return res.status(400).json({ message: 'Nothing to update' });
  try {
    const db = await getPool();
    await db.query('UPDATE sa_organizations SET ? WHERE id=?', [data, req.params.id]);
    clearStatusCache();
    res.json({ message: 'Organization updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/superadmin/organizations/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active', 'trial', 'suspended'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
  try {
    const db = await getPool();
    await db.query('UPDATE sa_organizations SET status=? WHERE id=?', [status, req.params.id]);
    clearStatusCache();
    res.json({ message: `Organization ${status}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Package assign / renew — expiry aage badhao + history save karo
router.post('/superadmin/organizations/:id/renew', async (req, res) => {
  const { package_id, amount, payment_mode, reference, notes, start_date, duration_days } = req.body;
  try {
    const db = await getPool();
    const [[org]] = await db.query('SELECT * FROM sa_organizations WHERE id=?', [req.params.id]);
    if (!org) return res.status(404).json({ message: 'Organization not found' });
    const [[pkg]] = await db.query('SELECT * FROM sa_packages WHERE id=?', [package_id || org.package_id]);
    if (!pkg) return res.status(400).json({ message: 'Please select a package' });

    const days = Number(duration_days) > 0 ? Number(duration_days) : pkg.duration_days;
    const today = toYMD(new Date());
    let from = start_date || today;
    // Agar abhi valid hai to current expiry ke baad se extend karo
    if (!start_date && org.expiry_date) {
      const curExp = toYMD(org.expiry_date);
      if (curExp >= today) from = addDays(curExp, 1);
    }
    const end = addDays(from, days - 1);

    await db.query(
      "UPDATE sa_organizations SET package_id=?, expiry_date=?, status='active', start_date=COALESCE(start_date, ?) WHERE id=?",
      [pkg.id, end, from, org.id]
    );
    await db.query(
      'INSERT INTO sa_subscriptions (organization_id, package_id, package_name, amount, start_date, end_date, payment_mode, reference, notes) VALUES (?,?,?,?,?,?,?,?,?)',
      [org.id, pkg.id, pkg.name, amount === '' || amount == null ? pkg.price : amount, from, end, payment_mode || null, reference || null, notes || null]
    );
    clearStatusCache();
    res.json({ message: `Subscription active until ${formatDMY(end)} (${pkg.name} – ${formatINR(amount === '' || amount == null ? pkg.price : amount)})`, expiry_date: end });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/superadmin/organizations/:id', async (req, res) => {
  try {
    const db = await getPool();
    const [[org]] = await db.query('SELECT is_primary FROM sa_organizations WHERE id=?', [req.params.id]);
    if (!org) return res.status(404).json({ message: 'Organization not found' });
    if (org.is_primary) return res.status(400).json({ message: 'The primary (live) organization cannot be deleted. You can suspend it instead.' });
    await db.query('DELETE FROM sa_subscriptions WHERE organization_id=?', [req.params.id]);
    await db.query('DELETE FROM sa_organizations WHERE id=?', [req.params.id]);
    res.json({ message: 'Organization deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Primary org users (live login se connected) ──────────────────────────────
async function requirePrimary(req, res) {
  const db = await getPool();
  const [[org]] = await db.query('SELECT is_primary FROM sa_organizations WHERE id=?', [req.params.id]);
  if (!org) { res.status(404).json({ message: 'Organization not found' }); return false; }
  if (!org.is_primary) { res.status(400).json({ message: 'Users are available only for the primary (live) organization' }); return false; }
  return true;
}

router.get('/superadmin/organizations/:id/users', async (req, res) => {
  try {
    if (!(await requirePrimary(req, res))) return;
    const db = await getPool();
    const [rows] = await db.query("SELECT id, name, username, role, phone, is_active, created_at FROM users ORDER BY FIELD(role,'admin','worker','client'), name");
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/superadmin/organizations/:id/users/:userId/password', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ message: 'Password must be at least 4 characters' });
  try {
    if (!(await requirePrimary(req, res))) return;
    const db = await getPool();
    const [r] = await db.query('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(password, 10), req.params.userId]);
    if (!r.affectedRows) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'Password has been reset' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/superadmin/organizations/:id/users/:userId/username', async (req, res) => {
  const username = String(req.body.username || '').trim();
  if (username.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters' });
  if (!/^[A-Za-z0-9._@-]+$/.test(username)) return res.status(400).json({ message: 'Username can only contain letters, numbers and . _ @ -' });
  if (username === SUPER_ADMIN_USERNAME) return res.status(400).json({ message: 'This username is reserved' });
  try {
    if (!(await requirePrimary(req, res))) return;
    const db = await getPool();
    const [[taken]] = await db.query('SELECT id FROM users WHERE username=? AND id<>?', [username, req.params.userId]);
    if (taken) return res.status(409).json({ message: `Username "${username}" is already taken` });
    const [r] = await db.query('UPDATE users SET username=? WHERE id=?', [username, req.params.userId]);
    if (!r.affectedRows) return res.status(404).json({ message: 'User not found' });
    res.json({ message: `Username changed to ${username}`, username });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/superadmin/organizations/:id/users/:userId/status', async (req, res) => {
  const is_active = req.body.is_active ? 1 : 0;
  try {
    if (!(await requirePrimary(req, res))) return;
    const db = await getPool();
    const [r] = await db.query('UPDATE users SET is_active=? WHERE id=?', [is_active, req.params.userId]);
    if (!r.affectedRows) return res.status(404).json({ message: 'User not found' });
    res.json({ message: is_active ? 'User activated' : 'User deactivated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
module.exports.initSuperAdminTables = initSuperAdminTables;
module.exports.trySuperAdminLogin = trySuperAdminLogin;
module.exports.getPrimaryOrgAccess = getPrimaryOrgAccess;
module.exports.orgAccessGuard = orgAccessGuard;
module.exports.checkUserLimit = checkUserLimit;
