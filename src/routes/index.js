const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'workshop_secret_2024';

// ── Web Push Setup ────────────────────────────────────────────────────────────
let webpush = null;
try {
  webpush = require('web-push');
  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BDT3sQDeaJhvQHe_CrbmKifgygdtlppVCbDe7OAY7oobL5D5pnWIOYLy-bVPr30xJLqkHDRZcGVXVIwXLQloeGQ';
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '5mJhC6k1qkVZnsFPUhmT5B-3-Komog0pn2xJtEPz66I';
  webpush.setVapidDetails('mailto:admin@workshop.com', VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('✅ Web Push initialized.');
} catch (e) {
  console.log('⚠️ web-push not installed — push notifications disabled');
}

// ── Auth Middleware ───────────────────────────────────────────────────────────
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

// ── Image Upload Setup (Cloudinary) ──────────────────────────────────────────
const { imgUpload, galleryUpload, moReferenceUpload, getFileUrl, deleteFile } = require('../services/cloudinaryStorage');
const auditLog = require('../middleware/auditLog');
const { sendEmail, emailAdmins, getAdminEmails, getWorkerEmail, taskAssignedEmail, taskProgressEmail, taskCompletedEmail, itemCompletedEmail } = require('../services/emailService');

// Helper: always return https Cloudinary URL from any image_path format
function toHttpsImageUrl(imagePath, resourceType = 'image') {
  if (!imagePath) return null;
  const p = String(imagePath).trim();
  if (!p) return null;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const type = resourceType === 'raw' ? 'raw' : 'image';

  // Already full https Cloudinary URL — return as-is
  if (p.startsWith('https://res.cloudinary.com')) return p;

  // http → force https
  if (p.startsWith('http://res.cloudinary.com')) return p.replace('http://', 'https://');

  // Any URL with /upload/ → extract public_id
  if (p.includes('/upload/')) {
    const publicId = p.split('/upload/').pop();
    if (!publicId) return null;
    return `https://res.cloudinary.com/${cloudName}/${type}/upload/${publicId}`;
  }

  // Plain public_id (e.g. workshop/mo-references/abc123)
  return `https://res.cloudinary.com/${cloudName}/${type}/upload/${p}`;
}

// Helper: Send push notification to a user
async function sendPushToUser(db, userId, payload) {
  if (!webpush) return;
  try {
    const [subs] = await db.query('SELECT * FROM push_subscriptions WHERE user_id=?', [userId]);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          JSON.parse(sub.subscription),
          JSON.stringify(payload)
        );
      } catch (err) {
        // Remove invalid subscriptions
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.query('DELETE FROM push_subscriptions WHERE id=?', [sub.id]);
        }
      }
    }
  } catch (err) {
    console.error('Push send error:', err.message);
  }
}

// Helper: Send push to all admins
async function sendPushToAdmins(db, payload) {
  if (!webpush) return;
  try {
    const [admins] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1");
    for (const admin of admins) {
      await sendPushToUser(db, admin.id, payload);
    }
  } catch (err) { console.error('Push admins error:', err.message); }
}

// Serve images — redirect to Cloudinary CDN
// Handles both formats:
// 1. Full Cloudinary URL already stored: https://res.cloudinary.com/...
// 2. Public ID only: workshop/task-images/abc123
router.get('/uploads/*', (req, res) => {
  let path = req.params[0]; // Captures everything after /uploads/
  if (!path) {
    return res.status(400).json({ message: 'No image path provided' });
  }
  
  console.log(`🔗 Image request: /uploads/${path}`);
  
  // If it's already a full Cloudinary URL, use it directly
  if (path.startsWith('https://')) {
    console.log(`➡️ Already full URL, redirecting: ${path}`);
    return res.redirect(path);
  }
  
  // If it's a full URL without https (encoded), decode and use it
  if (path.includes('res.cloudinary.com')) {
    const fullUrl = decodeURIComponent(path);
    console.log(`➡️ Decoded full URL, redirecting: ${fullUrl}`);
    return res.redirect(fullUrl);
  }
  
  // Otherwise treat as public_id and generate full Cloudinary URL
  console.log(`📸 Public ID format: ${path}`);
  const cloudinaryUrl = getFileUrl(path);
  console.log(`➡️ Generated Cloudinary URL: ${cloudinaryUrl}`);
  return res.redirect(cloudinaryUrl);
});

// Serve department gallery files — redirect to Cloudinary CDN
router.get('/gallery/*', (req, res) => {
  const publicId = req.params[0]; // Captures everything after /gallery/
  if (!publicId) {
    return res.status(400).json({ message: 'No image path provided' });
  }
  console.log(`🔗 Redirecting gallery request: /gallery/${publicId}`);
  const cloudinaryUrl = getFileUrl(publicId);
  console.log(`➡️ Cloudinary URL: ${cloudinaryUrl}`);
  return res.redirect(cloudinaryUrl);
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
// Emergency admin password reset — only works with secret key from .env
router.post('/auth/emergency-reset', async (req, res) => {
  const { secret, new_password } = req.body;
  const RESET_SECRET = process.env.RESET_SECRET || 'moji-reset-2024';
  if (secret !== RESET_SECRET) return res.status(403).json({ message: 'Wrong secret key' });
  if (!new_password || new_password.length < 4) return res.status(400).json({ message: 'Password kam se kam 4 characters ka hona chahiye' });
  try {
    const db = await getPool();
    const hashed = await bcrypt.hash(new_password, 10);
    await db.query("UPDATE users SET password=? WHERE role='admin' LIMIT 1", [hashed]);
    const [[admin]] = await db.query("SELECT username FROM users WHERE role='admin' LIMIT 1");
    res.json({ message: `Admin password reset ho gaya! Username: ${admin.username}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/auth/login', async (req, res) => {
  const db = await getPool();
  const { username, password } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';

  const [[user]] = await db.query('SELECT * FROM users WHERE username=? AND is_active=1', [username]);

  // Log failed attempt
  if (!user || !bcrypt.compareSync(password, user.password)) {
    try {
      if (user) {
        await db.query(
          'INSERT INTO login_logs (user_id, user_role, user_name, action, ip_address, user_agent) VALUES (?,?,?,?,?,?)',
          [user.id, user.role, user.name, 'LOGIN_FAILED', ip, ua]
        );
      }
    } catch (e) { console.error('Audit insert error:', e.message); }
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  // Log successful login
  try {
    await db.query(
      'INSERT INTO login_logs (user_id, user_role, user_name, action, ip_address, user_agent) VALUES (?,?,?,?,?,?)',
      [user.id, user.role, user.name, 'LOGIN', ip, ua]
    );
    console.log('Login logged for:', user.name, user.role);
  } catch (e) { console.error('Audit insert error:', e.message); }

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '30m' });
  res.json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
});

// Logout log
router.post('/auth/logout', auth, async (req, res) => {
  try {
    const db = await getPool();
    await db.query(
      'INSERT INTO login_logs (user_id, user_role, user_name, action, ip_address, user_agent) VALUES (?,?,?,?,?,?)',
      [req.user.id, req.user.role, req.user.name, 'LOGOUT',
       req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
       req.headers['user-agent'] || 'unknown']
    );
  } catch(e) { console.error('Logout log error:', e.message); }
  res.json({ message: 'Logged out' });
});

// ── LICENSE ───────────────────────────────────────────────────────────────────
const axios = require('axios');
const os = require('os');
let licenseCache = null; let lastLicenseCheck = 0;
router.get('/license/info', async (req, res) => {
  const now = Date.now();
  if (licenseCache && now - lastLicenseCheck < 30000) return res.json(licenseCache);
  try {
    const machineIdSync = require('node-machine-id').machineIdSync(true);
    const machineInfo = { hostname: os.hostname(), platform: os.platform(), arch: os.arch() };
    const r = await axios.post(`${process.env.LICENSE_SERVER_URL || 'http://localhost:4000'}/api/license/check`, { machine_id: machineIdSync, machine_info: machineInfo }, { timeout: 5000 });
    const response = { ...r.data, machine_id: machineIdSync };
    licenseCache = response; 
    lastLicenseCheck = now; 
    res.json(response);
  } catch (err) {
    console.error('License check error:', err.message);
    res.json(licenseCache || { status: 'active', machine_id: 'unknown' });
  }
});
router.post('/license/activate', async (req, res) => {
  try {
    const machineId = require('node-machine-id').machineIdSync(true);
    const r = await axios.post(`${process.env.LICENSE_SERVER_URL || 'http://localhost:4000'}/api/license/activate`, { ...req.body, machine_id: machineId }, { timeout: 10000 });
    licenseCache = null; res.json(r.data);
  } catch (err) { res.status(400).json({ message: err.response?.data?.message || 'Error' }); }
});
router.post('/license/verify-payment', async (req, res) => {
  try {
    const r = await axios.post(`${process.env.LICENSE_SERVER_URL || 'http://localhost:4000'}/api/license/verify-payment`, req.body, { timeout: 10000 });
    licenseCache = null; res.json(r.data);
  } catch (err) { res.status(400).json({ message: err.response?.data?.message || 'Error' }); }
});

// ── DEPARTMENTS ───────────────────────────────────────────────────────────────
router.get('/departments', auth, async (req, res) => {
  const db = await getPool();
  const { all } = req.query;
  // By default return ALL (active + inactive) so admin can see and restore
  // Workers/chain setup use active_only=1
  const whereClause = req.query.active_only === '1' ? 'WHERE d.is_active=1' : 'WHERE 1=1';
  const [rows] = await db.query(`
    SELECT d.*, COUNT(DISTINCT wd.worker_id) as worker_count,
      COUNT(DISTINCT ta.id) as total_tasks,
      SUM(ta.status='completed') as completed_tasks,
      SUM(ta.status='in_progress') as active_tasks,
      CASE WHEN COUNT(DISTINCT wd.worker_id) > 0 THEN 1 ELSE 0 END as has_workers
    FROM departments d
    LEFT JOIN worker_departments wd ON wd.department_id=d.id
    LEFT JOIN task_assignments ta ON ta.department_id=d.id
    ${whereClause} GROUP BY d.id ORDER BY COALESCE(d.stage_order,999), d.name`);
  res.json(rows);
});
router.post('/departments', auth, adminOnly, auditLog('CREATE','Department'), async (req, res) => {
  const db = await getPool();
  const { name, description, color } = req.body;
  const [r] = await db.query('INSERT INTO departments (name,description,color) VALUES (?,?,?)', [name, description, color || '#3B82F6']);
  res.json({ id: r.insertId, name, description, color });
});
router.put('/departments/:id', auth, adminOnly, auditLog('UPDATE','Department'), async (req, res) => {
  const db = await getPool();
  const { name, description, color, is_active } = req.body;
  await db.query('UPDATE departments SET name=?,description=?,color=?,is_active=? WHERE id=?', [name, description, color, is_active, req.params.id]);
  res.json({ message: 'Updated' });
});

// ── WORKERS ───────────────────────────────────────────────────────────────────
router.get('/workers', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [workers] = await db.query(
      "SELECT id,name,username,phone,hourly_rate,is_active,created_at FROM users WHERE role='worker' ORDER BY name"
    );
    // Get departments for each worker
    const [deptRows] = await db.query(`
      SELECT wd.worker_id, d.id, d.name, d.color
      FROM worker_departments wd
      JOIN departments d ON d.id=wd.department_id
      ORDER BY d.stage_order, d.name`
    );
    // Map departments to workers
    const deptMap = {};
    for (const d of deptRows) {
      if (!deptMap[d.worker_id]) deptMap[d.worker_id] = [];
      deptMap[d.worker_id].push({ id: d.id, name: d.name, color: d.color });
    }
    const result = workers.map(w => ({ ...w, departments: deptMap[w.id] || [] }));
    res.json(result);
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});
router.post('/workers', auth, adminOnly, auditLog('CREATE','Worker'), async (req, res) => {
  const db = await getPool();
  const { name, username, password, phone, department_ids, hourly_rate } = req.body;
  const hashed = bcrypt.hashSync(password, 10);
  const [r] = await db.query('INSERT INTO users (name,username,password,role,phone,hourly_rate) VALUES (?,?,?,?,?,?)', [name, username, hashed, 'worker', phone, hourly_rate || 0]);
  if (department_ids?.length) {
    for (const did of department_ids)
      await db.query('INSERT IGNORE INTO worker_departments (worker_id,department_id) VALUES (?,?)', [r.insertId, did]);
  }
  res.json({ id: r.insertId, name });
});
router.put('/workers/:id', auth, adminOnly, auditLog('UPDATE','Worker'), async (req, res) => {
  const db = await getPool();
  const { name, phone, is_active, department_ids, hourly_rate, password } = req.body;
  try {
    if (password && password.trim()) {
      const hashed = bcrypt.hashSync(password, 10);
      await db.query('UPDATE users SET name=?,phone=?,is_active=?,hourly_rate=?,password=? WHERE id=?',
        [name, phone, is_active ?? 1, hourly_rate || 0, hashed, req.params.id]);
    } else {
      await db.query('UPDATE users SET name=?,phone=?,is_active=?,hourly_rate=? WHERE id=?',
        [name, phone, is_active ?? 1, hourly_rate || 0, req.params.id]);
    }
    if (department_ids !== undefined) {
      await db.query('DELETE FROM worker_departments WHERE worker_id=?', [req.params.id]);
      for (const did of (department_ids || []))
        await db.query('INSERT IGNORE INTO worker_departments (worker_id,department_id) VALUES (?,?)', [req.params.id, did]);
    }
    res.json({ message: 'Updated' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});
router.delete('/workers/:id', auth, adminOnly, auditLog('DELETE','Worker'), async (req, res) => {
  const db = await getPool();
  try {
    // First check if worker exists
    const [workerCheck] = await db.query('SELECT id FROM users WHERE id=? AND role="worker"', [req.params.id]);
    if (!workerCheck[0]) return res.status(404).json({ message: 'Worker not found' });

    // Get all tasks assigned to this worker
    const [tasks] = await db.query('SELECT id FROM task_assignments WHERE worker_id=?', [req.params.id]);
    
    // Delete all related data for each task
    for (const task of tasks) {
      await db.query('DELETE FROM task_images WHERE task_id=?', [task.id]);
      await db.query('DELETE FROM worker_time_logs WHERE task_id=?', [task.id]);
      await db.query('DELETE FROM task_progress WHERE task_id=?', [task.id]);
      await db.query('DELETE FROM task_transfers WHERE task_id=?', [task.id]);
    }
    
    // Delete all queries raised by this worker
    await db.query('DELETE FROM worker_queries WHERE raised_by=?', [req.params.id]);
    
    // Delete all tasks assigned to this worker
    await db.query('DELETE FROM task_assignments WHERE worker_id=?', [req.params.id]);
    
    // Delete all time logs for this worker
    await db.query('DELETE FROM worker_time_logs WHERE worker_id=?', [req.params.id]);
    
    // Delete worker from departments
    await db.query('DELETE FROM worker_departments WHERE worker_id=?', [req.params.id]);
    
    // Finally delete the worker
    await db.query('DELETE FROM users WHERE id=? AND role="worker"', [req.params.id]);
    
    res.json({ message: 'Worker and all related data deleted successfully' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/workers/:id/rate', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  await db.query('UPDATE users SET hourly_rate=? WHERE id=?', [req.body.hourly_rate, req.params.id]);
  res.json({ message: 'Rate updated' });
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
router.get('/projects', auth, async (req, res) => {
  const db = await getPool();
  const { status, search, ready } = req.query;
  let where = "WHERE p.status != 'deleted'";
  const params = [];
  if (status && status !== 'all') {
    where = "WHERE p.status=? AND p.status != 'deleted'";
    params.push(status);
  }
  // is_ready filter: 'yes' = ready only, 'no' = not-ready only
  if (ready === 'yes') {
    where += ' AND p.is_ready = 1';
  } else if (ready === 'no') {
    where += ' AND (p.is_ready = 0 OR p.is_ready IS NULL)';
  }
  if (search) {
    where += ' AND (p.name LIKE ? OR p.client_name LIKE ? OR p.project_id LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  try {
    const [rows] = await db.query(`
      SELECT p.*,
        (SELECT COUNT(id) FROM project_items WHERE project_id=p.id) as item_count,
        (SELECT COALESCE(SUM(quantity), 0) FROM project_items WHERE project_id=p.id) as total_item_qty,
        (SELECT COALESCE(SUM(quantity), 0) FROM project_items pi 
         WHERE pi.project_id=p.id 
         AND NOT EXISTS (
           SELECT 1 FROM task_assignments ta 
           WHERE ta.project_item_id=pi.id 
           AND ta.status != 'completed'
         )) as completed_item_qty,
        (SELECT COUNT(id) FROM task_assignments WHERE project_id=p.id AND stage_order=1) as task_count,
        (SELECT SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) FROM task_assignments WHERE project_id=p.id AND stage_order=1) as completed_tasks,
        (SELECT SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) FROM task_assignments WHERE project_id=p.id AND stage_order=1) as active_tasks,
        (SELECT COUNT(id) FROM task_assignments WHERE project_id=p.id AND status='delayed') as delayed_tasks,
        (SELECT image_path FROM project_mo_references WHERE project_id=p.id ORDER BY created_at ASC LIMIT 1) as thumbnail_path,
        (SELECT resource_type FROM project_mo_references WHERE project_id=p.id ORDER BY created_at ASC LIMIT 1) as thumbnail_type
      FROM projects p
      ${where} ORDER BY p.created_at DESC`, params);
    
    // For each project, fetch worker completion data
    for (let project of rows) {
      const [workers] = await db.query(`
        SELECT 
          u.id,
          u.name,
          d.name as department,
          COALESCE(SUM(ta.quantity_assigned), 0) as assigned_qty,
          COALESCE(SUM(ta.quantity_completed), 0) as completed_qty
        FROM task_assignments ta
        JOIN users u ON ta.worker_id = u.id
        JOIN departments d ON ta.department_id = d.id
        WHERE ta.project_id = ?
        GROUP BY u.id, u.name, d.name
        ORDER BY u.name`, [project.id]);
      project.workers = workers;
    }
    
    // Apply toHttpsImageUrl on thumbnail_path for projects list
    const projects = rows.map(p => ({
      ...p,
      thumbnail_path: p.thumbnail_path ? toHttpsImageUrl(p.thumbnail_path, p.thumbnail_type || 'image') : null
    }));
    res.json(projects);
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});
router.post('/projects', auth, adminOnly, auditLog('CREATE','Project'), async (req, res) => {
  const db = await getPool();
  const { project_id, name, client_name, client_phone, description, priority, order_date, deadline, total_amount, notes } = req.body;
  // Auto-generate project_id if not provided
  let finalProjectId = project_id;
  if (!finalProjectId || finalProjectId.trim() === '') {
    try {
      // Get custom prefix and starting number from settings
      const [settings] = await db.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('project_id_prefix', 'project_id_start_number')");
      const settingsMap = {};
      settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);
      const prefix = settingsMap.project_id_prefix || 'WM';
      const startNum = parseInt(settingsMap.project_id_start_number || '1001');
      
      const year = new Date().getFullYear().toString().slice(-2);
      const [last] = await db.query("SELECT project_id FROM projects ORDER BY id DESC LIMIT 1");
      let nextNum = startNum;
      if (last.length > 0) {
        const match = last[0].project_id?.match(/\d+$/);
        if (match) nextNum = parseInt(match[0]) + 1;
      }
      finalProjectId = `${prefix}-${year}-${nextNum}`;
    } catch (err) {
      console.error('Settings fetch error:', err.message);
      // Fallback to default
      const year = new Date().getFullYear().toString().slice(-2);
      finalProjectId = `WM-${year}-1001`;
    }
  }
  try {
    const isReady = req.body.is_ready ? 1 : 0;
    const [r] = await db.query('INSERT INTO projects (project_id,name,client_name,client_phone,description,priority,order_date,deadline,total_amount,notes,created_by,is_ready) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [finalProjectId, name, client_name, client_phone, description, priority || 'medium', order_date || null, deadline || null, total_amount || 0, notes, req.user.id, isReady]);
    res.json({ id: r.insertId, project_id: finalProjectId });
  } catch(err) {
    console.error('Create project error:', err.message);
    res.status(500).json({ message: err.message });
  }
});
router.put('/projects/:id', auth, adminOnly, auditLog('UPDATE','Project'), async (req, res) => {
  const db = await getPool();
  const { name, client_name, client_phone, description, status, priority, order_date, deadline, total_amount, notes, is_ready } = req.body;
  const isReadyVal = is_ready !== undefined ? (is_ready ? 1 : 0) : undefined;
  const updateQuery = isReadyVal !== undefined
    ? 'UPDATE projects SET name=?,client_name=?,client_phone=?,description=?,status=?,priority=?,order_date=?,deadline=?,total_amount=?,notes=?,is_ready=? WHERE id=?'
    : 'UPDATE projects SET name=?,client_name=?,client_phone=?,description=?,status=?,priority=?,order_date=?,deadline=?,total_amount=?,notes=? WHERE id=?';
  const updateParams = isReadyVal !== undefined
    ? [name, client_name, client_phone, description, status, priority, order_date || null, deadline || null, total_amount, notes, isReadyVal, req.params.id]
    : [name, client_name, client_phone, description, status, priority, order_date || null, deadline || null, total_amount, notes, req.params.id];
  await db.query(updateQuery, updateParams);
  res.json({ message: 'Updated' });
});

router.post('/projects/:id/mo-references', auth, adminOnly, moReferenceUpload.array('images', 10), async (req, res) => {
  const db = await getPool();
  const projectId = parseInt(req.params.id, 10);
  try {
    console.log(`\n📤 MO REFERENCE UPLOAD REQUEST`);
    console.log(`   Project ID: ${projectId}`);
    console.log(`   Files received: ${req.files?.length || 0}`);
    
    if (req.files && req.files.length > 0) {
      console.log(`   File details:`);
      req.files.forEach((f, idx) => {
        console.log(`     [${idx}] filename: ${f.filename}`);
        console.log(`         public_id: ${f.public_id}`);
        console.log(`         resource_type: ${f.resource_type}`);
        console.log(`         originalname: ${f.originalname}`);
        console.log(`         path: ${f.path?.substring(0, 100)}`);
        console.log(`         location: ${f.location?.substring(0, 100)}`);
        console.log(`         All keys: ${Object.keys(f).join(', ')}`);
      });
    }

    if (!req.files || req.files.length === 0) {
      console.error(`❌ NO FILES IN REQUEST`);
      return res.status(400).json({ 
        message: 'No files uploaded. Multer did not receive files.',
        debug: { filesReceived: 0, middleware: 'moReferenceUpload.array(images, 10)' }
      });
    }

    const [[project]] = await db.query('SELECT id FROM projects WHERE id=?', [projectId]);
    if (!project) {
      console.error(`❌ PROJECT NOT FOUND: ${projectId}`);
      return res.status(404).json({ message: 'Project not found' });
    }

    const files = req.files;
    let saved = 0;
    const errors = [];

    for (const f of files) {
      try {
        let publicId = '';

        // PRIORITY: Try filename first (most reliable from Cloudinary)
        if (f.filename) {
          publicId = f.filename;
          console.log(`✅ Got publicId from f.filename: ${publicId}`);
        }
        // Otherwise try public_id
        else if (f.public_id) {
          publicId = f.public_id;
          console.log(`✅ Got publicId from f.public_id: ${publicId}`);
        }
        // Try key
        else if (f.key) {
          publicId = f.key;
          console.log(`✅ Got publicId from f.key: ${publicId}`);
        }
        // Try extracting from path/location
        else if (f.path) {
          const match = f.path.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
          if (match && match[1]) {
            publicId = match[1];
            console.log(`✅ Got publicId from f.path: ${publicId}`);
          }
        }
        else if (f.location) {
          const match = f.location.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
          if (match && match[1]) {
            publicId = match[1];
            console.log(`✅ Got publicId from f.location: ${publicId}`);
          }
        }

        if (!publicId) {
          const err = `No public_id found. File props: ${JSON.stringify({filename: f.filename, public_id: f.public_id, key: f.key, originalname: f.originalname})}`;
          console.error(`❌ ${err}`);
          errors.push({ file: f.originalname, error: err });
          continue;
        }

        // Store full secure URL directly — extension intact, no parsing issues
        // f.path ya f.location Cloudinary ki full URL hoti hai
        let storeUrl = '';
        if (f.path && f.path.startsWith('http')) {
          storeUrl = f.path.replace('http://', 'https://');
        } else if (f.location && f.location.startsWith('http')) {
          storeUrl = f.location.replace('http://', 'https://');
        } else {
          // Fallback: plain publicId se URL banao
          storeUrl = publicId;
        }

        if (!storeUrl) {
          errors.push({ file: f.originalname, error: 'Could not determine file URL' });
          continue;
        }

        // Determine resource type
        const resourceType = f.resource_type || (/(jpg|jpeg|png|gif|webp)$/i.test(f.originalname) ? 'image' : 'raw');

        console.log(`   INSERT: url='${storeUrl}', resourceType='${resourceType}', file='${f.originalname}'`);

        await db.query(
          'INSERT INTO project_mo_references (project_id, uploaded_by, image_path, resource_type) VALUES (?,?,?,?)',
          [projectId, req.user.id, storeUrl, resourceType]
        );

        console.log(`   ✅ SAVED to DB`);
        saved++;
      } catch (fileErr) {
        const err = `Error processing ${f.originalname}: ${fileErr.message}`;
        console.error(`❌ ${err}`);
        errors.push({ file: f.originalname, error: fileErr.message });
      }
    }

    if (saved === 0) {
      console.error(`❌ NO FILES SAVED. Errors:`, errors);
      return res.status(400).json({ 
        message: `Failed to save any files. ${errors.length} error(s) occurred.`,
        details: errors
      });
    }

    const [images] = await db.query(
      'SELECT id, project_id, image_path, resource_type, created_at FROM project_mo_references WHERE project_id=? ORDER BY created_at DESC',
      [projectId]
    );

    console.log(`✅ SUCCESS: ${saved} file(s) uploaded and saved\n`);
    res.json({
      message: `${saved} file(s) uploaded successfully`,
      saved_count: saved,
      error_count: errors.length,
      images: images.map(img => ({
        ...img,
        image_url: toHttpsImageUrl(img.image_path, img.resource_type || 'image'),
      })),
    });
  } catch(err) {
    console.error(`\n❌ FATAL ERROR:`, err.message);
    console.error(err.stack);
    res.status(500).json({ message: `Upload error: ${err.message}` });
  }
});

router.get('/projects/:id/mo-references', auth, async (req, res) => {
  const db = await getPool();
  const projectId = req.params.id;
  try {
    const cloudinary = require('cloudinary').v2;
    const [images] = await db.query('SELECT * FROM project_mo_references WHERE project_id=? ORDER BY created_at DESC', [projectId]);
    res.json(images.map(img => {
      const resourceType = img.resource_type || 'image';
      // Use cloudinary.url() — yeh proper URL banata hai version number ke saath
      // jo bina extension ke bhi kaam karta hai
      let image_url;
      try {
        image_url = cloudinary.url(img.image_path, {
          secure: true,
          resource_type: resourceType,
        });
      } catch(e) {
        image_url = toHttpsImageUrl(img.image_path, resourceType);
      }
      return { ...img, image_url, download_url: image_url };
    }));
  } catch(err) {
    console.error('MO Reference fetch error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.delete('/projects/:projectId/mo-references/:fileId', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { projectId, fileId } = req.params;
  try {
    const [file] = await db.query('SELECT * FROM project_mo_references WHERE id=? AND project_id=?', [fileId, projectId]);
    if (!file.length) return res.status(404).json({ message: 'File not found' });

    // Delete from Cloudinary
    if (file[0].image_path) {
      try {
        await deleteFile(file[0].image_path);
        console.log(`🗑️ Deleted from Cloudinary: ${file[0].image_path}`);
      } catch (e) {
        console.warn(`⚠️ Cloudinary delete failed: ${e.message}`);
      }
    }

    // Delete from database
    await db.query('DELETE FROM project_mo_references WHERE id=?', [fileId]);
    res.json({ message: 'File deleted successfully' });
  } catch(err) {
    console.error('MO Reference delete error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.get('/reports/mo-references', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(`
      SELECT
        p.id AS project_id,
        p.project_id AS proj_code,
        p.name AS project_name,
        COUNT(mr.id) AS image_count,
        MAX(mr.created_at) AS latest_image_created_at,
        (SELECT mr2.image_path FROM project_mo_references mr2 WHERE mr2.project_id=p.id ORDER BY mr2.created_at DESC LIMIT 1) AS latest_image_path,
        (SELECT mr2.resource_type FROM project_mo_references mr2 WHERE mr2.project_id=p.id ORDER BY mr2.created_at DESC LIMIT 1) AS latest_resource_type
      FROM projects p
      LEFT JOIN project_mo_references mr ON mr.project_id=p.id
      GROUP BY p.id
      ORDER BY image_count DESC, p.created_at DESC
      LIMIT 500`
    );
    const result = rows.map(r => ({
      ...r,
      latest_image_url: r.latest_image_path ? toHttpsImageUrl(r.latest_image_path, r.latest_resource_type) : null,
    }));
    res.json(result);
  } catch(err) {
    console.error('MO references report error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.delete('/projects/:id', auth, adminOnly, auditLog('DELETE','Project'), async (req, res) => {
  const db = await getPool();
  try {
    const { force } = req.query; // force=true for hard delete

    // Check for active tasks
    const [activeTasks] = await db.query(
      "SELECT COUNT(*) as cnt FROM task_assignments WHERE project_id=? AND status IN ('in_progress','on_hold')",
      [req.params.id]
    );

    if (activeTasks[0].cnt > 0 && !force) {
      return res.status(400).json({ 
        message: `${activeTasks[0].cnt} tasks abhi kaam mein hain (in_progress/on_hold) — pehle complete karo phir delete hoga`,
        active_tasks: activeTasks[0].cnt
      });
    }

    if (force === 'true') {
      // HARD DELETE - completely remove all related data
      console.log(`🗑️ HARD DELETE initiated for project ${req.params.id}`);

      // Delete all task images
      const [tasks] = await db.query('SELECT id FROM task_assignments WHERE project_id=?', [req.params.id]);
      for (const task of tasks) {
        await db.query('DELETE FROM task_images WHERE task_id=?', [task.id]);
        await db.query('DELETE FROM worker_time_logs WHERE task_id=?', [task.id]);
        await db.query('DELETE FROM task_progress WHERE task_id=?', [task.id]);
        await db.query('DELETE FROM task_transfers WHERE task_id=?', [task.id]);
      }

      // Delete all tasks
      await db.query('DELETE FROM task_assignments WHERE project_id=?', [req.params.id]);

      // Delete all production chains
      await db.query('DELETE FROM production_chains WHERE project_id=?', [req.params.id]);

      // Delete all project items
      await db.query('DELETE FROM project_items WHERE project_id=?', [req.params.id]);

      // Finally delete the project
      await db.query('DELETE FROM projects WHERE id=?', [req.params.id]);

      res.json({ message: '✅ Project completely delete ho gaya (hard delete)', type: 'success' });
    } else {
      // SOFT DELETE - just mark as deleted (recoverable)
      await db.query("UPDATE projects SET status='deleted' WHERE id=?", [req.params.id]);
      res.json({ message: 'Project delete ho gaya (recoverable)', type: 'soft_delete' });
    }
  } catch(err) {
    console.error('Delete project error:', err.message);
    res.status(500).json({ message: 'Delete fail: ' + err.message });
  }
});

router.get('/projects/:id', auth, async (req, res) => {
  const db = await getPool();
  const [[project]] = await db.query('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!project) return res.status(404).json({ message: 'Not found' });
  const [itemsRaw] = await db.query(`
    SELECT pi.*,
      (SELECT pii.image_path FROM project_item_images pii WHERE pii.project_item_id=pi.id ORDER BY pii.created_at ASC LIMIT 1) as thumbnail_path,
      (SELECT pii.resource_type FROM project_item_images pii WHERE pii.project_item_id=pi.id ORDER BY pii.created_at ASC LIMIT 1) as thumbnail_type
    FROM project_items pi WHERE pi.project_id=? ORDER BY pi.id
  `, [req.params.id]);
  // Apply toHttpsImageUrl on thumbnail_path so full URLs pass through correctly
  const items = itemsRaw.map(item => ({
    ...item,
    thumbnail_path: item.thumbnail_path ? toHttpsImageUrl(item.thumbnail_path, item.thumbnail_type || 'image') : null
  }));
  const [tasks] = await db.query(`
    SELECT ta.*, 
      COALESCE(u.name, dept_workers.worker_names) as worker_name,
      d.name as department_name, d.color as dept_color,
      pi.item_name, COALESCE(pi.proto_code,'') as proto_code
    FROM task_assignments ta
    LEFT JOIN users u ON u.id=ta.worker_id
    LEFT JOIN departments d ON d.id=ta.department_id
    LEFT JOIN project_items pi ON pi.id=ta.project_item_id
    LEFT JOIN (
      SELECT wd.department_id, GROUP_CONCAT(u2.name ORDER BY u2.name SEPARATOR ', ') as worker_names
      FROM worker_departments wd
      JOIN users u2 ON u2.id=wd.worker_id AND u2.is_active=1
      GROUP BY wd.department_id
    ) dept_workers ON dept_workers.department_id=ta.department_id AND ta.worker_id IS NULL
    WHERE ta.project_id=? ORDER BY ta.created_at DESC`, [req.params.id]);
  // Production chain per item
  const [chains] = await db.query(`
    SELECT pc.*, d.name as dept_name, d.color as dept_color
    FROM production_chains pc
    JOIN departments d ON d.id=pc.department_id
    WHERE pc.project_id=? ORDER BY pc.project_item_id, pc.stage_order`, [req.params.id]);
  res.json({ project, items, tasks, chains });
});

// Get images grouped by production chain steps for a project
router.get('/projects/:id/images-by-stage', auth, async (req, res) => {
  const db = await getPool();
  try {
    // Single query — get chains + all images together (no N+1 loop)
    const [chains] = await db.query(`
      SELECT DISTINCT pc.stage_order, pc.department_id, d.name as dept_name, d.color as dept_color
      FROM production_chains pc
      JOIN departments d ON d.id=pc.department_id
      WHERE pc.project_id=? ORDER BY pc.stage_order`, [req.params.id]);

    if (chains.length === 0) return res.json([]);

    const [allImages] = await db.query(`
      SELECT ti.*, u.name as uploaded_by_name, ta.task_title,
             ta.department_id, ta.stage_order
      FROM task_images ti
      JOIN task_assignments ta ON ta.id=ti.task_id
      JOIN users u ON u.id=ti.uploaded_by
      WHERE ta.project_id=?
      ORDER BY ta.stage_order, ti.created_at DESC`, [req.params.id]);

    // Group images by stage_order + department_id
    const imageMap = {};
    allImages.forEach(img => {
      const key = img.stage_order + '_' + img.department_id;
      if (!imageMap[key]) imageMap[key] = [];
      imageMap[key].push({ ...img, image_url: toHttpsImageUrl(img.image_path) });
    });

    const result = chains.map(chain => ({
      stage_order: chain.stage_order,
      dept_name: chain.dept_name,
      dept_color: chain.dept_color,
      images: imageMap[chain.stage_order + '_' + chain.department_id] || []
    }));

    res.json(result);
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// ── CHANGE PASSWORD ─────────────────────────────────────────────────────────────
router.put('/auth/change-password', auth, async (req, res) => {
  const db = await getPool();
  const { current_password, new_password } = req.body;
  try {
    if (!current_password || !new_password) {
      return res.status(400).json({ message: 'Current aur naya password dono zaroori hain' });
    }
    if (new_password.length < 4) {
      return res.status(400).json({ message: 'Naya password kam se kam 4 characters ka hona chahiye' });
    }
    const [[user]] = await db.query('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isMatch = bcrypt.compareSync(current_password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password galat hai' });
    }

    const hashed = bcrypt.hashSync(new_password, 10);
    await db.query('UPDATE users SET password=? WHERE id=?', [hashed, req.user.id]);
    res.json({ message: 'Password change ho gaya' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PROJECT ITEMS ─────────────────────────────────────────────────────────────
router.post('/projects/:id/items', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { item_name, proto_code, description, quantity, unit, material, dimensions, unit_price, notes } = req.body;
  const [r] = await db.query('INSERT INTO project_items (project_id,item_name,proto_code,description,quantity,unit,material,dimensions,unit_price,notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [req.params.id, item_name, proto_code, description, quantity || 1, unit || 'pcs', material, dimensions, unit_price || 0, notes]);
  res.json({ id: r.insertId });
});
router.put('/projects/:projectId/items/:id', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { item_name, proto_code, description, quantity, unit, material, dimensions, unit_price, notes } = req.body;
  await db.query('UPDATE project_items SET item_name=?,proto_code=?,description=?,quantity=?,unit=?,material=?,dimensions=?,unit_price=?,notes=? WHERE id=? AND project_id=?',
    [item_name, proto_code, description, quantity, unit, material, dimensions, unit_price, notes, req.params.id, req.params.projectId]);
  res.json({ message: 'Updated' });
});
router.delete('/projects/:projectId/items/:id', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [activeTasks] = await db.query(
      "SELECT COUNT(*) as cnt FROM task_assignments WHERE project_item_id=? AND status IN ('in_progress','on_hold')",
      [req.params.id]
    );
    if (activeTasks[0].cnt > 0) {
      return res.status(400).json({ message: `Is item pe ${activeTasks[0].cnt} tasks kaam mein hain — pehle complete karo` });
    }
    await db.query('DELETE FROM project_items WHERE id=? AND project_id=?', [req.params.id, req.params.projectId]);
    res.json({ message: 'Item deleted' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PROJECT ITEM REFERENCE IMAGES ─────────────────────────────────────────────

// Upload reference images for a project item
router.post('/projects/:projectId/items/:itemId/images', auth, adminOnly, imgUpload.array('images', 10), async (req, res) => {
  const db = await getPool();
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: 'Koi image nahi' });

    let savedCount = 0;
    for (const f of files) {
      // multer-storage-cloudinary stores public_id in f.filename or f.public_id
      // and full URL in f.path
      let publicId = '';

      if (f.filename) {
        // multer-storage-cloudinary v4 uses f.filename as public_id
        publicId = f.filename;
      } else if (f.public_id) {
        publicId = f.public_id;
      } else if (f.key) {
        publicId = f.key;
      } else if (f.path && (f.path.startsWith('http') || f.path.includes('cloudinary'))) {
        // Extract public_id from URL
        const match = f.path.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
        if (match && match[1]) publicId = match[1];
      } else if (f.location) {
        const match = f.location.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
        if (match && match[1]) publicId = match[1];
      }

      // Store full URL — extension intact, resource_type saved
      let storeUrl = '';
      if (f.path && f.path.startsWith('http')) {
        storeUrl = f.path.replace('http://', 'https://');
      } else if (f.location && f.location.startsWith('http')) {
        storeUrl = f.location.replace('http://', 'https://');
      } else if (publicId) {
        storeUrl = publicId;
      }
      const itemResourceType = f.resource_type || 'image';

      if (storeUrl) {
        await db.query(
          'INSERT INTO project_item_images (project_item_id, project_id, image_path, resource_type, uploaded_by) VALUES (?,?,?,?,?)',
          [req.params.itemId, req.params.projectId, storeUrl, itemResourceType, req.user.id]
        );
        savedCount++;
      }
    }

    if (savedCount === 0) {
      return res.status(400).json({ message: 'Images save nahi hui — retry karo' });
    }

    const [images] = await db.query(
      'SELECT * FROM project_item_images WHERE project_item_id=? ORDER BY created_at DESC',
      [req.params.itemId]
    );
    res.json({ message: `${savedCount} images upload ho gayi`, images: images.map(img => ({ ...img, image_url: toHttpsImageUrl(img.image_path) })) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get reference images for a project item
router.get('/projects/:projectId/items/:itemId/images', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [images] = await db.query(
      'SELECT * FROM project_item_images WHERE project_item_id=? ORDER BY created_at ASC',
      [req.params.itemId]
    );
    res.json(images.map(img => ({ ...img, image_url: toHttpsImageUrl(img.image_path) })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Delete a reference image
router.delete('/projects/:projectId/items/:itemId/images/:imageId', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [[img]] = await db.query('SELECT * FROM project_item_images WHERE id=? AND project_item_id=?', [req.params.imageId, req.params.itemId]);
    if (!img) return res.status(404).json({ message: 'Image nahi mili' });
    await deleteFile(img.image_path);
    await db.query('DELETE FROM project_item_images WHERE id=?', [req.params.imageId]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PRODUCTION CHAIN ──────────────────────────────────────────────────────────
// Set/replace chain for a project (or project item)
router.post('/projects/:id/chain', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const { project_item_id, stages } = req.body;
    // stages = [{department_id, stage_order}]
    if (project_item_id) {
      await db.query('DELETE FROM production_chains WHERE project_id=? AND project_item_id=?', [req.params.id, project_item_id]);
    } else {
      await db.query('DELETE FROM production_chains WHERE project_id=? AND project_item_id IS NULL', [req.params.id]);
    }
    for (const s of stages) {
      await db.query('INSERT INTO production_chains (project_id,project_item_id,department_id,stage_order) VALUES (?,?,?,?)',
        [req.params.id, project_item_id || null, s.department_id, s.stage_order]);
    }
    // Auto-create tasks for each stage, linked to each item
    if (!project_item_id) {
      // Project-level chain: apply to all items
      const [items] = await db.query('SELECT * FROM project_items WHERE project_id=?', [req.params.id]);
      for (const item of items) {
        await _createChainTasks(db, req.params.id, item, stages, req.user.id);
      }
    } else {
      const [[item]] = await db.query('SELECT * FROM project_items WHERE id=?', [project_item_id]);
      if (item) await _createChainTasks(db, req.params.id, item, stages, req.user.id);
    }
    res.json({ message: 'Chain set kiya' });
  } catch (err) {
    console.error('Chain save error:', err);
    res.status(500).json({ message: err.message });
  }
});

async function _createChainTasks(db, project_id, item, stages, created_by) {
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const [[dept]] = await db.query('SELECT * FROM departments WHERE id=?', [s.department_id]);
    // Check if task already exists for this item+department
    const [[existing]] = await db.query('SELECT id FROM task_assignments WHERE project_id=? AND project_item_id=? AND department_id=?',
      [project_id, item.id, s.department_id]);
    if (existing) {
      await db.query('UPDATE task_assignments SET stage_order=? WHERE id=?', [s.stage_order, existing.id]);
      continue;
    }
    const status = i === 0 ? 'pending' : 'waiting';
    const [r] = await db.query(`INSERT INTO task_assignments 
      (project_id, project_item_id, assign_type, department_id, stage_order, task_title, quantity_assigned, status)
      VALUES (?,?,?,?,?,?,?,?)`,
      [project_id, item.id, 'department', s.department_id, s.stage_order,
        `${item.item_name} — ${dept.name}`, item.quantity, status]);

    // Notify workers of Stage 1 (pending) — they can start work now
    if (i === 0) {
      const taskId = r.insertId;
      const [deptWorkers] = await db.query(
        'SELECT worker_id FROM worker_departments WHERE department_id=?', [s.department_id]
      );
      for (const w of deptWorkers) {
        const workerEmail = await getWorkerEmail(db, w.worker_id);
        await createNotification(db, {
          user_id: w.worker_id,
          type: 'stage_activated',
          title: 'New Task Assigned!',
          message: `"${item.item_name} — ${dept.name}" — Stage 1 is ready to start! Qty: ${item.quantity}`,
          task_id: taskId,
          project_id,
          workerEmail,
          emailPayload: taskAssignedEmail({
            workerName: 'Team Member',
            taskTitle: `${item.item_name} — ${dept.name}`,
            projectName: '',
            itemName: item.item_name,
            quantity: item.quantity,
            dueDate: null,
            deptName: dept.name
          })
        });
      }
    }
  }
}

// When a chain task has progress → auto-advance to next stage
async function autoAdvanceChain(db, task_id) {
  const [[task]] = await db.query('SELECT * FROM task_assignments WHERE id=?', [task_id]);
  if (!task || !task.project_item_id) return;

  // Activate next stage on ANY progress (partial or full)
  if (task.quantity_completed > 0 || task.status === 'completed') {
    await checkAndActivateNextStage(db, task);
  }
}

// Transfer function removed - caused quantity inflation
// Chain tasks are already created with correct qty in _createChainTasks
// Only status activation is needed via checkAndActivateNextStage

// ── TASKS ─────────────────────────────────────────────────────────────────────
router.get('/tasks/all', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { status, department_id, worker_id } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (status) { where += ' AND ta.status=?'; params.push(status); }
  if (department_id) { where += ' AND ta.department_id=?'; params.push(department_id); }
  if (worker_id) { where += ' AND (ta.worker_id=? OR (ta.worker_id IS NULL AND ta.department_id IN (SELECT department_id FROM worker_departments WHERE worker_id=?)))'; params.push(worker_id, worker_id); }
  try {
    const [rows] = await db.query(`
      SELECT ta.*, 
        COALESCE(u.name, dept_workers.worker_names) as worker_name,
        d.name as department_name, d.color as dept_color,
        p.name as project_name, p.project_id as proj_code, p.client_name as customer_name,
        pi.item_name, COALESCE(pi.proto_code,'') as proto_code
      FROM task_assignments ta
      LEFT JOIN users u ON u.id=ta.worker_id
      LEFT JOIN departments d ON d.id=ta.department_id
      LEFT JOIN projects p ON p.id=ta.project_id
      LEFT JOIN project_items pi ON pi.id=ta.project_item_id
      LEFT JOIN (
        SELECT wd.department_id, GROUP_CONCAT(u2.name ORDER BY u2.name SEPARATOR ', ') as worker_names
        FROM worker_departments wd
        JOIN users u2 ON u2.id=wd.worker_id AND u2.is_active=1
        GROUP BY wd.department_id
      ) dept_workers ON dept_workers.department_id=ta.department_id AND ta.worker_id IS NULL
      ${where} ORDER BY ta.created_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch(err) {
    console.error('tasks/all error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.get('/tasks/my', auth, async (req, res) => {
  const db = await getPool();
  const { status } = req.query;
  let statusWhere = '';
  const params = [req.user.id, req.user.id];
  if (!status || status === '') {
    statusWhere = "AND ta.status IN ('pending','in_progress','on_hold','waiting')";
  } else if (status === 'all') {
    statusWhere = '';
  } else {
    statusWhere = 'AND ta.status=?';
    params.push(status);
  }
  try {
    const [rows] = await db.query(
      `SELECT ta.*, p.name as project_name, p.project_id as proj_code,
        pi.item_name, COALESCE(pi.proto_code,'') as proto_code,
        d.name as department_name, d.color as dept_color,
        COALESCE(ta.stage_order, 0) as stage_order
      FROM task_assignments ta
      JOIN projects p ON p.id=ta.project_id
      LEFT JOIN project_items pi ON pi.id=ta.project_item_id
      LEFT JOIN departments d ON d.id=ta.department_id
      LEFT JOIN worker_departments wd ON wd.worker_id=? AND wd.department_id=ta.department_id
      WHERE (ta.worker_id=? OR wd.worker_id IS NOT NULL) ${statusWhere}
      ORDER BY ta.created_at DESC`, params);
    res.json(rows);
  } catch(err) {
    console.error('tasks/my error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.get('/tasks/:id', auth, async (req, res) => {
  const db = await getPool();
  const [[task]] = await db.query(`
    SELECT ta.*,u.name as worker_name,d.name as department_name,d.color as dept_color,
      p.name as project_name,p.project_id as proj_code,pi.item_name,pi.proto_code
    FROM task_assignments ta
    LEFT JOIN users u ON u.id=ta.worker_id
    LEFT JOIN departments d ON d.id=ta.department_id
    LEFT JOIN projects p ON p.id=ta.project_id
    LEFT JOIN project_items pi ON pi.id=ta.project_item_id
    WHERE ta.id=?`, [req.params.id]);
  if (!task) return res.status(404).json({ message: 'Not found' });
  const [transfers] = await db.query(`
    SELECT tt.*,fw.name as from_worker_name,tw.name as to_worker_name,tb.name as transferred_by_name
    FROM task_transfers tt
    LEFT JOIN users fw ON fw.id=tt.from_worker_id
    LEFT JOIN users tw ON tw.id=tt.to_worker_id
    JOIN users tb ON tb.id=tt.transferred_by
    WHERE tt.task_id=? ORDER BY tt.created_at DESC`, [req.params.id]);
  res.json({ ...task, transfers });
});

router.post('/tasks', auth, adminOnly, auditLog('CREATE','Task'), async (req, res) => {
  const db = await getPool();
  const { project_id, project_item_id, assign_type, worker_id, department_id, stage_order,
    task_title, task_description, quantity_assigned, priority, start_date, due_date, admin_notes } = req.body;
  const [r] = await db.query(`INSERT INTO task_assignments 
    (project_id,project_item_id,assign_type,worker_id,department_id,stage_order,
    task_title,task_description,quantity_assigned,priority,start_date,due_date,admin_notes,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [project_id, project_item_id || null, assign_type || 'worker', worker_id || null,
      department_id || null, stage_order || 0,
      task_title, task_description, quantity_assigned || 1, priority || 'medium',
      start_date, due_date, admin_notes, 'pending']);
  res.json({ id: r.insertId });
});

router.put('/tasks/:id', auth, adminOnly, auditLog('UPDATE','Task'), async (req, res) => {
  const db = await getPool();
  const [[old]] = await db.query('SELECT * FROM task_assignments WHERE id=?', [req.params.id]);
  const { assign_type, worker_id, department_id, stage_order, task_title, task_description,
    quantity_assigned, status, priority, start_date, due_date, admin_notes } = req.body;
  // Log worker change as transfer
  if (old && worker_id && old.worker_id && parseInt(worker_id) !== old.worker_id) {
    await db.query('INSERT INTO task_transfers (task_id,from_worker_id,to_worker_id,transferred_by,reason) VALUES (?,?,?,?,?)',
      [req.params.id, old.worker_id, worker_id, req.user.id, 'Admin ne worker change kiya']);
  }
  await db.query(`UPDATE task_assignments SET assign_type=?,worker_id=?,department_id=?,stage_order=?,
    task_title=?,task_description=?,quantity_assigned=?,status=?,priority=?,start_date=?,due_date=?,admin_notes=?
    WHERE id=?`,
    [assign_type, worker_id || null, department_id || null, stage_order || 0,
      task_title, task_description, quantity_assigned, status, priority, start_date, due_date, admin_notes, req.params.id]);
  res.json({ message: 'Updated' });
});

router.delete('/tasks/:id', auth, adminOnly, auditLog('DELETE','Task'), async (req, res) => {
  const db = await getPool();
  try {
    const [task] = await db.query('SELECT status FROM task_assignments WHERE id=?', [req.params.id]);
    if (!task[0]) return res.status(404).json({ message: 'Task not found' });
    if (task[0].status === 'in_progress') {
      return res.status(400).json({ message: 'In-progress task delete nahi ho sakti — pehle complete karo' });
    }
    // Delete task and all related data
    await db.query('DELETE FROM task_images WHERE task_id=?', [req.params.id]);
    await db.query('DELETE FROM worker_time_logs WHERE task_id=?', [req.params.id]);
    await db.query('DELETE FROM task_progress WHERE task_id=?', [req.params.id]);
    await db.query('DELETE FROM task_transfers WHERE task_id=?', [req.params.id]);
    await db.query('DELETE FROM task_assignments WHERE id=?', [req.params.id]);
    res.json({ message: 'Task deleted' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// Helper: Check and activate next waiting stage — triggers on ANY progress (partial or full)
// Helper: Create notification + send push
async function createNotification(db, { user_id, type, title, message, task_id, project_id, workerEmail, emailPayload }) {
  try {
    await db.query(
      'INSERT INTO notifications (user_id, type, title, message, task_id, project_id) VALUES (?,?,?,?,?,?)',
      [user_id, type, title, message, task_id || null, project_id || null]
    );
    await sendPushToUser(db, user_id, { title, body: message, tag: type, task_id, project_id });
    // Send email to worker if provided
    if (workerEmail && emailPayload) {
      await sendEmail(db, { to: workerEmail, ...emailPayload });
    }
  } catch (err) { console.error('Notification error:', err.message); }
}

// Helper: Notify all admins
async function notifyAdmins(db, { type, title, message, task_id, project_id, emailPayload }) {
  try {
    const [admins] = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=1");
    for (const admin of admins) {
      await createNotification(db, { user_id: admin.id, type, title, message, task_id, project_id });
    }
    // Send email to all admin emails
    if (emailPayload) {
      await emailAdmins(db, emailPayload);
    }
  } catch (err) { console.error('Notify admins error:', err.message); }
}

async function checkAndActivateNextStage(db, task) {
  const [[nextTask]] = await db.query(`
    SELECT * FROM task_assignments 
    WHERE project_id=? AND project_item_id=? AND stage_order>? AND status='waiting'
    ORDER BY stage_order LIMIT 1`,
    [task.project_id, task.project_item_id, task.stage_order]);

  if (nextTask) {
    await db.query("UPDATE task_assignments SET status='pending' WHERE id=?", [nextTask.id]);

    // Notify workers in next stage department
    const [deptWorkers] = await db.query(
      'SELECT worker_id FROM worker_departments WHERE department_id=?',
      [nextTask.department_id]
    );
    for (const w of deptWorkers) {
      await createNotification(db, {
        user_id: w.worker_id,
        type: 'stage_activated',
        title: '🔔 Naya Kaam Ready!',
        message: `"${nextTask.task_title}" — Stage ${nextTask.stage_order} ab pending hai. Kaam shuru karo!`,
        task_id: nextTask.id,
        project_id: nextTask.project_id
      });
    }
    if (nextTask.worker_id) {
      await createNotification(db, {
        user_id: nextTask.worker_id,
        type: 'stage_activated',
        title: '🔔 Naya Kaam Ready!',
        message: `"${nextTask.task_title}" — Stage ${nextTask.stage_order} ab pending hai. Kaam shuru karo!`,
        task_id: nextTask.id,
        project_id: nextTask.project_id
      });
    }
  }

  // Check if all stages done for this item
  const [[waiting]] = await db.query(`
    SELECT COUNT(*) as cnt FROM task_assignments 
    WHERE project_id=? AND project_item_id=? AND status != 'completed'`, [task.project_id, task.project_item_id]);
  if (waiting.cnt === 0) {
    await db.query("UPDATE project_items SET status='completed' WHERE id=?", [task.project_item_id]);
    await notifyAdmins(db, {
      type: 'item_completed',
      title: '✅ Item Completed!',
      message: `All stages of the project item have been completed!`,
      project_id: task.project_id,
      emailPayload: itemCompletedEmail({ projectName: task.project_name || 'Project' })
    });
  }
}

// Helper: Get previous stage's completed quantity for stage dependency validation
async function getPreviousStageQuantity(db, projectItemId, currentStageOrder) {
  if (currentStageOrder <= 1) return null; // First stage has no dependency

  const [[prev]] = await db.query(`
    SELECT ta.quantity_assigned, ta.quantity_completed, ta.status
    FROM task_assignments ta
    WHERE ta.project_item_id=? AND ta.stage_order=?
    LIMIT 1`, [projectItemId, currentStageOrder - 1]);

  if (!prev) return null;
  // If previous stage is fully completed — no restriction on current stage
  if (prev.status === 'completed') return null;
  // Otherwise restrict to what previous stage has completed so far
  return prev.quantity_completed;
}

// Worker progress update
router.patch('/tasks/:id/progress', auth, auditLog('UPDATE','Task'), async (req, res) => {
  const db = await getPool();
  const { quantity_completed, status, worker_notes } = req.body;
  const [[task]] = await db.query('SELECT * FROM task_assignments WHERE id=?', [req.params.id]);
  if (!task) return res.status(404).json({ message: 'Not found' });
  const newQty = quantity_completed !== undefined ? parseInt(quantity_completed, 10) : task.quantity_completed;
  const assignedQty = parseInt(task.quantity_assigned, 10);

  // Stage dependency validation
  if (task.stage_order > 1 && newQty > task.quantity_completed) {
    const prevStageQty = await getPreviousStageQuantity(db, task.project_item_id, task.stage_order);
    if (prevStageQty !== null && newQty > prevStageQty) {
      return res.status(400).json({
        message: `Pehle stage mein sirf ${prevStageQty} quantity complete hue hain. Max ${prevStageQty} hi set kar sakte ho.`,
        max_allowed: prevStageQty,
        previous_stage_completed: prevStageQty
      });
    }
  }

  // Status logic:
  // 1. If qty == assigned → always completed (auto)
  // 2. If qty == 0 → pending (reset)
  // 3. Otherwise → respect worker's chosen status exactly
  let newStatus;
  if (newQty >= assignedQty) {
    newStatus = 'completed'; // auto complete when all qty done
  } else if (newQty === 0) {
    newStatus = 'pending'; // reset
  } else {
    // Respect whatever worker selected — don't override
    newStatus = status || task.status;
    // Only prevent 'completed' if qty not fully done
    if (newStatus === 'completed' && newQty < assignedQty) {
      newStatus = 'in_progress';
    }
  }

  const completedDate = newStatus === 'completed' ? new Date().toISOString().split('T')[0] : null;

  await db.query(
    'UPDATE task_assignments SET quantity_completed=?,status=?,worker_notes=?,completed_date=? WHERE id=?',
    [newQty, newStatus, worker_notes !== undefined ? worker_notes : task.worker_notes, completedDate, req.params.id]
  );

  // Also save as daily progress entry automatically
  const workDate = new Date().toISOString().slice(0, 10);
  const dailyQty = newQty - (task.quantity_completed || 0);
  if (dailyQty > 0) {
    const [existing] = await db.query(
      'SELECT id FROM daily_progress WHERE task_id=? AND work_date=? AND (worker_id=? OR created_by=?)',
      [req.params.id, workDate, req.user.id, req.user.id]
    );
    if (existing.length > 0) {
      await db.query('UPDATE daily_progress SET qty_done=qty_done+?, notes=? WHERE id=?',
        [dailyQty, worker_notes || '', existing[0].id]);
    } else {
      await db.query(
        'INSERT INTO daily_progress (task_id,project_item_id,department_id,worker_id,work_date,qty_done,notes,created_by) VALUES (?,?,?,?,?,?,?,?)',
        [req.params.id, task.project_item_id, task.department_id || null, req.user.id, workDate, dailyQty, worker_notes || '', req.user.id]
      );
    }
  }

  await db.query(
    'INSERT INTO task_progress (task_id,updated_by,quantity_done,status,notes) VALUES (?,?,?,?,?)',
    [req.params.id, req.user.id, newQty, newStatus, worker_notes || '']
  );

  // Notify admins about progress update
  await notifyAdmins(db, {
    type: 'progress_update',
    title: `Task Progress Update`,
    message: `${req.user.name} updated "${task.task_title}": ${newQty}/${task.quantity_assigned} (${newStatus})`,
    task_id: req.params.id,
    project_id: task.project_id,
    emailPayload: taskProgressEmail({
      workerName: req.user.name,
      taskTitle: task.task_title,
      projectName: task.project_name || '',
      oldQty: task.quantity_completed,
      newQty,
      totalQty: task.quantity_assigned,
      newStatus
    })
  });

  // Auto-advance chain — call on any progress (qty > 0)
  if (newQty > 0) await autoAdvanceChain(db, req.params.id);

  const [[updated]] = await db.query('SELECT * FROM task_assignments WHERE id=?', [req.params.id]);
  res.json({ message: 'Updated', task: updated });
});

// Task transfer (ADMIN ONLY)
router.post('/tasks/:id/transfer', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { to_worker_id, reason } = req.body;
  const [[task]] = await db.query('SELECT * FROM task_assignments WHERE id=?', [req.params.id]);
  if (!task) return res.status(404).json({ message: 'Not found' });
  if (task.status === 'completed')
    return res.status(400).json({ message: 'Completed task transfer nahi ho sakta' });
  await db.query('INSERT INTO task_transfers (task_id,from_worker_id,to_worker_id,transferred_by,reason) VALUES (?,?,?,?,?)',
    [req.params.id, task.worker_id, to_worker_id, req.user.id, reason || '']);
  await db.query("UPDATE task_assignments SET worker_id=?,status=IF(status='completed','completed','pending') WHERE id=?",
    [to_worker_id, req.params.id]);
  res.json({ message: 'Task transfer ho gaya' });
});

// ── TASK IMAGES ───────────────────────────────────────────────────────────────
router.post('/tasks/:id/images', auth, imgUpload.array('images', 5), async (req, res) => {
  try {
    const db = await getPool();
    const { image_type, caption } = req.body;
    const files = req.files || [];

    console.log(`📸 Image upload request for task ${req.params.id}, received ${files.length} files`);

    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'Koi image select nahi kiya', success: false });
    }

    // Verify task exists
    const [[task]] = await db.query('SELECT id FROM task_assignments WHERE id=?', [req.params.id]);
    if (!task) {
      return res.status(404).json({ message: 'Task nahi mila', success: false });
    }

    // Insert all uploaded images
    let savedCount = 0;
    let failedCount = 0;
    
    for (const f of files) {
      // Log ALL properties on the file object to understand what Cloudinary is returning
      console.log(`📸 === File ${files.indexOf(f) + 1} ===`);
      console.log(`📸 All file properties:`, JSON.stringify(f, null, 2).substring(0, 500));
      console.log(`📸 Key properties: key=${f.key}, public_id=${f.public_id}, location=${f.location}, path=${f.path}`);
      
      let publicId = '';
      
      // Method 1: filename (multer-storage-cloudinary v4 primary field)
      if (f.filename && typeof f.filename === 'string') {
        publicId = f.filename;
      }
      // Method 2: Direct key property (from Cloudinary storage)
      else if (f.key && typeof f.key === 'string') {
        publicId = f.key;
      } 
      // Method 3: Direct public_id property
      else if (f.public_id && typeof f.public_id === 'string') {
        publicId = f.public_id;
      } 
      // Method 4: Extract from path URL
      else if (f.path && (f.path.startsWith('http') || f.path.includes('cloudinary'))) {
        const match = f.path.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
        if (match && match[1]) publicId = match[1];
      }
      // Method 5: Extract from location (might be secure_url)
      else if (f.location || f.secure_url) {
        const url = f.location || f.secure_url;
        const match = url.match(/\/upload\/v[\d]+\/(.+?)(?:\?|$)/);
        if (match && match[1]) publicId = match[1];
      }
      
      // Clean up the public_id: remove common image extensions
      if (publicId) {
        publicId = publicId.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '');
        
        // CRITICAL: Remove "https://" or "http://" if accidentally included
        // This prevents storing full URLs instead of just public_id
        if (publicId.startsWith('https://') || publicId.startsWith('http://')) {
          console.warn('⚠️ WARNING: public_id looks like a full URL, extracting actual public_id');
          const match = publicId.match(/workshop\/[a-z0-9\-_]+\/[a-z0-9\-_]+/i);
          if (match) {
            publicId = match[0];
            console.log(`✅ Extracted real public_id from URL: ${publicId}`);
          }
        }
      }
      
      if (publicId) {
        // Store ONLY the public_id - NEVER store full URL
        try {
          console.log(`💾 Saving to DB with public_id: ${publicId}`);
          await db.query('INSERT INTO task_images (task_id,uploaded_by,image_path,image_type,caption) VALUES (?,?,?,?,?)',
            [req.params.id, req.user.id, publicId, image_type || 'progress', caption || '']);
          savedCount++;
          console.log(`✅ Saved to DB: ${publicId}`);
        } catch (dbErr) {
          failedCount++;
          console.error(`❌ DB insert failed for ${publicId}:`, dbErr.message);
        }
      } else {
        failedCount++;
        console.warn(`⚠️ FAILED to extract public_id. File object:`, f);
      }
    }

    if (savedCount === 0 && failedCount > 0) {
      return res.status(400).json({ 
        message: `${failedCount} image upload fail - public_id extract nahi hua`, 
        saved: 0,
        failed: failedCount,
        success: false 
      });
    }

    res.json({ 
      message: `${savedCount} image save hua${failedCount > 0 ? `, ${failedCount} fail` : ''}`, 
      saved: savedCount,
      failed: failedCount,
      success: savedCount > 0 
    });
  } catch (err) {
    console.error('Image upload error:', err.message);
    res.status(500).json({ 
      message: 'Image upload fail ho gaya: ' + (err.message || 'Unknown error'),
      success: false,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});
router.get('/tasks/:id/images', auth, async (req, res) => {
  const db = await getPool();
  const [rows] = await db.query(`
    SELECT ti.*,u.name as uploaded_by_name FROM task_images ti
    JOIN users u ON u.id=ti.uploaded_by WHERE ti.task_id=? ORDER BY ti.created_at DESC`, [req.params.id]);
  console.log(`📸 Getting images for task ${req.params.id}: found ${rows.length} images`);
  if (rows.length > 0) {
    console.log(`Image paths: ${rows.map(r => r.image_path).join(', ')}`);
  }
  // Add full Cloudinary URL to each image object
  const rowsWithUrl = rows.map(r => ({
    ...r,
    image_url: toHttpsImageUrl(r.image_path)
  }));
  res.json(rowsWithUrl);
});
router.delete('/tasks/:id/images/:imgId', auth, async (req, res) => {
  const db = await getPool();
  const [[img]] = await db.query('SELECT * FROM task_images WHERE id=? AND task_id=?', [req.params.imgId, req.params.id]);
  if (!img) return res.status(404).json({ message: 'Not found' });
  // img.image_path is the B2 key e.g. "task-images/1234-photo.jpg"
  await deleteFile(img.image_path);
  await db.query('DELETE FROM task_images WHERE id=?', [req.params.imgId]);
  res.json({ message: 'Deleted' });
});

// Get all images for a project grouped by worker (for worker view)
router.get('/projects/:projectId/images-for-worker', auth, async (req, res) => {
  const db = await getPool();
  const workerId = req.user.id;
  try {
    // Get all tasks for this project that worker can see (assigned to them or in their department)
    const [myDepts] = await db.query(
      'SELECT department_id FROM worker_departments WHERE worker_id=?', [workerId]
    );
    const deptIds = myDepts.map(d => d.department_id);
    
    // Build query to get tasks: either assigned to this worker OR in their departments
    let taskQuery = `
      SELECT ta.id FROM task_assignments ta
      WHERE ta.project_id=? AND (ta.worker_id=?`;
    const queryParams = [req.params.projectId, workerId];
    
    if (deptIds.length > 0) {
      taskQuery += ` OR ta.department_id IN (${deptIds.map(() => '?').join(',')})`;
      queryParams.push(...deptIds);
    }
    taskQuery += ')';
    
    const [tasks] = await db.query(taskQuery, queryParams);
    const taskIds = tasks.map(t => t.id);
    
    if (taskIds.length === 0) {
      return res.json([]);
    }
    
    // Get all images for these tasks grouped by worker
    const [images] = await db.query(`
      SELECT ti.*, u.name as uploaded_by_name, ta.task_title
      FROM task_images ti
      JOIN task_assignments ta ON ta.id=ti.task_id
      JOIN users u ON u.id=ti.uploaded_by
      WHERE ti.task_id IN (${taskIds.map(() => '?').join(',')})
      ORDER BY u.name, ti.created_at DESC
    `, taskIds);
    
    // Group by worker
    const grouped = {};
    images.forEach(img => {
      if (!grouped[img.uploaded_by_name]) {
        grouped[img.uploaded_by_name] = [];
      }
      // Add full Cloudinary URL to each image object
      grouped[img.uploaded_by_name].push({
        ...img,
        image_url: toHttpsImageUrl(img.image_path)
      });
    });
    
    // Convert to array format
    const result = Object.entries(grouped).map(([workerName, imgs]) => ({
      worker_name: workerName,
      images: imgs
    }));
    
    res.json(result);
  } catch (err) {
    console.error('Error fetching project images for worker:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── DEPARTMENT GALLERY ─────────────────────────────────────────────────────────
// Upload files to department gallery (PNG, Excel, PDF, Docs)
router.post('/departments/:id/gallery', auth, galleryUpload.array('files', 10), async (req, res) => {
  const db = await getPool();
  const files = req.files || [];
  const { description } = req.body;
  
  // Check if user belongs to this department
  const [[userDept]] = await db.query(`
    SELECT * FROM worker_departments WHERE worker_id=? AND department_id=?`, 
    [req.user.id, req.params.id]);
  
  if (!userDept && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Aap is department mein nahi ho' });
  }
  
  for (const f of files) {
    const ext = path.extname(f.originalname);
    // f.key = "department-gallery/1234-file.pdf"
    await db.query(`INSERT INTO department_gallery 
      (department_id, uploaded_by, file_path, file_name, file_type, description)
      VALUES (?,?,?,?,?,?)`,
      [req.params.id, req.user.id, f.key, f.originalname, ext, description || '']);
  }
  res.json({ message: `${files.length} file(s) uploaded`, count: files.length });
});

// Get department gallery files
router.get('/departments/:id/gallery', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [files] = await db.query(`
      SELECT dg.*,u.name as uploaded_by_name, d.name as department_name
      FROM department_gallery dg
      JOIN users u ON u.id=dg.uploaded_by
      JOIN departments d ON d.id=dg.department_id
      WHERE dg.department_id=? 
      ORDER BY dg.created_at DESC`, [req.params.id]);
    res.json(files);
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete file from department gallery
router.delete('/departments/:id/gallery/:fileId', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const [[file]] = await db.query(`SELECT * FROM department_gallery WHERE id=? AND department_id=?`, 
    [req.params.fileId, req.params.id]);
  if (!file) return res.status(404).json({ message: 'File not found' });
  // file.file_path is the B2 key e.g. "department-gallery/1234-file.pdf"
  await deleteFile(file.file_path);
  await db.query('DELETE FROM department_gallery WHERE id=?', [req.params.fileId]);
  res.json({ message: 'File deleted' });
});

// Get previous stage constraint for a task (for UI display)
router.get('/tasks/:id/stage-constraint', auth, async (req, res) => {
  const db = await getPool();
  const [[task]] = await db.query('SELECT * FROM task_assignments WHERE id=?', [req.params.id]);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  
  if (task.stage_order <= 1) {
    return res.json({ has_constraint: false, constraint_qty: null });
  }
  
  const [[prev]] = await db.query(`
    SELECT ta.quantity_completed, d.name as dept_name
    FROM task_assignments ta
    LEFT JOIN departments d ON d.id=ta.department_id
    WHERE ta.project_item_id=? AND ta.stage_order=?
    LIMIT 1`, [task.project_item_id, task.stage_order - 1]);
  
  if (!prev) {
    return res.json({ has_constraint: false, constraint_qty: null });
  }
  
  res.json({ 
    has_constraint: true, 
    constraint_qty: prev.quantity_completed,
    previous_dept: prev.dept_name,
    message: `Previous department "${prev.dept_name}" has completed ${prev.quantity_completed} units. You can work on max ${prev.quantity_completed} units.`
  });
});

// ── TIME TRACKING ─────────────────────────────────────────────────────────────
router.post('/tasks/:id/clock-in', auth, async (req, res) => {
  const db = await getPool();
  const [[active]] = await db.query('SELECT * FROM worker_time_logs WHERE task_id=? AND worker_id=? AND clock_out IS NULL', [req.params.id, req.user.id]);
  if (active) return res.status(400).json({ message: 'Pehle se clock-in hai', log: active });
  // Allow custom clock_in datetime (for manual entry), default to NOW()
  const clockInTime = req.body.clock_in ? new Date(req.body.clock_in).toISOString().slice(0,19).replace('T',' ') : null;
  const [r] = await db.query(
    'INSERT INTO worker_time_logs (task_id,worker_id,clock_in) VALUES (?,?,?)',
    [req.params.id, req.user.id, clockInTime || new Date()]
  );
  res.json({ message: 'Clock-in ho gaya', log_id: r.insertId });
});
router.post('/tasks/:id/clock-out', auth, async (req, res) => {
  const db = await getPool();
  const { notes } = req.body;
  const [[active]] = await db.query('SELECT * FROM worker_time_logs WHERE task_id=? AND worker_id=? AND clock_out IS NULL', [req.params.id, req.user.id]);
  if (!active) return res.status(400).json({ message: 'Clock-in nahi tha' });
  await db.query('UPDATE worker_time_logs SET clock_out=NOW(),duration_minutes=TIMESTAMPDIFF(MINUTE,clock_in,NOW()),notes=? WHERE id=?', [notes || '', active.id]);
  const [[log]] = await db.query('SELECT * FROM worker_time_logs WHERE id=?', [active.id]);
  res.json({ message: 'Clock-out ho gaya', duration_minutes: log.duration_minutes, log });
});
router.get('/tasks/:id/time-logs', auth, async (req, res) => {
  const db = await getPool();
  const [rows] = await db.query(`
    SELECT tl.*,u.name as worker_name FROM worker_time_logs tl
    JOIN users u ON u.id=tl.worker_id WHERE tl.task_id=? ORDER BY tl.clock_in DESC`, [req.params.id]);
  res.json(rows);
});
router.get('/tasks/:id/active-session', auth, async (req, res) => {
  const db = await getPool();
  const [[active]] = await db.query('SELECT * FROM worker_time_logs WHERE task_id=? AND worker_id=? AND clock_out IS NULL', [req.params.id, req.user.id]);
  res.json({ active: active || null });
});

// Manual time entry — for when worker didn't use clock-in/clock-out
router.post('/tasks/:id/manual-time', auth, async (req, res) => {
  const db = await getPool();
  const { clock_in, clock_out, notes } = req.body;
  if (!clock_in || !clock_out) return res.status(400).json({ message: 'Clock-in aur clock-out time dono zaroori hain' });
  
  const clockInDt = new Date(clock_in);
  const clockOutDt = new Date(clock_out);
  if (clockOutDt <= clockInDt) return res.status(400).json({ message: 'Clock-out, clock-in se pehle nahi ho sakta' });
  
  const durationMins = Math.round((clockOutDt - clockInDt) / 60000);
  if (durationMins < 1) return res.status(400).json({ message: 'Duration kam se kam 1 minute hona chahiye' });
  
  // Admin can enter time for any worker, otherwise use req.user.id
  const finalWorkerId = (req.user.role === 'admin' && req.body.worker_id) ? req.body.worker_id : req.user.id;
  
  try {
    const [r] = await db.query(
      'INSERT INTO worker_time_logs (task_id,worker_id,clock_in,clock_out,duration_minutes,notes) VALUES (?,?,?,?,?,?)',
      [req.params.id, finalWorkerId, clock_in, clock_out, durationMins, notes || 'Manual entry']
    );
    const [[log]] = await db.query('SELECT * FROM worker_time_logs WHERE id=?', [r.insertId]);
    res.json({ message: 'Manual time entry save ho gayi', log });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// ── REPORTS ───────────────────────────────────────────────────────────────────
router.get('/reports/dashboard', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [[taskStats]] = await db.query(`SELECT COUNT(*) as total,
      SUM(status='completed') as completed, SUM(status='in_progress') as in_progress,
      SUM(status='pending') as pending, SUM(status='waiting') as waiting,
      SUM(status!='completed' AND due_date IS NOT NULL AND due_date<CURDATE()) as delayed_count
      FROM task_assignments`);

    const [[projStats]] = await db.query(`SELECT COUNT(*) as total,
      SUM(status='active') as active,
      SUM(status='completed') as completed,
      SUM(status='pending') as pending,
      SUM(status='in_progress') as in_progress,
      SUM(status='deleted') as deleted_count,
      SUM(status NOT IN ('deleted','cancelled','completed') AND deadline IS NOT NULL AND deadline < CURDATE()) as overdue
      FROM projects`);

    const [[workerStats]] = await db.query(`SELECT COUNT(*) as total FROM users WHERE role='worker' AND is_active=1`);

    // Top 10 projects by recency — subqueries avoid cartesian product from joining both items+tasks
    const [recentProjects] = await db.query(`
      SELECT p.id, p.project_id, p.name, p.client_name, p.status, p.deadline, p.priority, p.created_at,
        (SELECT COUNT(*) FROM project_items WHERE project_id=p.id) as item_count,
        (SELECT COUNT(*) FROM task_assignments WHERE project_id=p.id) as task_count,
        (SELECT COUNT(*) FROM task_assignments WHERE project_id=p.id AND status='completed') as done_tasks,
        (SELECT COUNT(*) FROM task_assignments WHERE project_id=p.id AND status='in_progress') as active_tasks,
        (SELECT COUNT(*) FROM task_assignments WHERE project_id=p.id AND status='pending') as pending_tasks
      FROM projects p
      WHERE p.status NOT IN ('deleted','cancelled')
      ORDER BY p.created_at DESC LIMIT 10`);

    // Delayed tasks with days overdue
    const [delayedTasks] = await db.query(`
      SELECT ta.id, ta.task_title, ta.due_date, ta.status, ta.priority,
        p.name as project_name, p.project_id as proj_code, p.id as project_db_id,
        u.name as worker_name, d.name as dept_name,
        DATEDIFF(CURDATE(), ta.due_date) as days_overdue
      FROM task_assignments ta
      JOIN projects p ON p.id=ta.project_id
      LEFT JOIN users u ON u.id=ta.worker_id
      LEFT JOIN departments d ON d.id=ta.department_id
      WHERE ta.status NOT IN ('completed','cancelled','waiting')
        AND ta.due_date IS NOT NULL AND ta.due_date < CURDATE()
      ORDER BY ta.due_date ASC LIMIT 10`);

    // Worker performance summary — include both directly assigned & dept-assigned tasks
    const [workerPerformance] = await db.query(`
      SELECT u.id, u.name,
        COUNT(DISTINCT ta.id) as total_tasks,
        COALESCE(SUM(ta.status='completed'),0) as completed,
        COALESCE(SUM(ta.status='in_progress'),0) as in_progress,
        COALESCE(SUM(ta.status!='completed' AND ta.due_date IS NOT NULL AND ta.due_date<CURDATE()),0) as delayed_count,
        COALESCE(SUM(ta.quantity_assigned),0) as qty_assigned,
        COALESCE(SUM(ta.quantity_completed),0) as qty_done
      FROM users u
      LEFT JOIN worker_departments wd ON wd.worker_id=u.id
      LEFT JOIN task_assignments ta ON (ta.worker_id=u.id OR ta.department_id=wd.department_id)
      WHERE u.role='worker' AND u.is_active=1
      GROUP BY u.id
      ORDER BY completed DESC
      LIMIT 8`);

    // Department workload summary
    const [deptLoad] = await db.query(`
      SELECT d.id, d.name, d.color,
        COUNT(DISTINCT wd.worker_id) as worker_count,
        COUNT(ta.id) as total_tasks,
        COALESCE(SUM(ta.status='completed'),0) as completed,
        COALESCE(SUM(ta.status='in_progress'),0) as in_progress,
        COALESCE(SUM(ta.status='pending'),0) as pending,
        COALESCE(SUM(ta.quantity_assigned),0) as qty_assigned,
        COALESCE(SUM(ta.quantity_completed),0) as qty_done
      FROM departments d
      LEFT JOIN worker_departments wd ON wd.department_id=d.id
      LEFT JOIN task_assignments ta ON ta.department_id=d.id
      WHERE d.is_active=1
      GROUP BY d.id ORDER BY total_tasks DESC LIMIT 8`);

    // Pipeline: active products + dept stage status (top 20 items)
    const [pipelineItems] = await db.query(`
      SELECT pi.id, pi.item_name, pi.proto_code, pi.quantity,
        p.name as project_name, p.project_id as proj_code, p.client_name, p.id as project_db_id,
        COUNT(ta.id) as total_stages,
        COALESCE(SUM(ta.status='completed'),0) as completed_stages,
        COALESCE(SUM(ta.status='in_progress'),0) as active_stages
      FROM project_items pi
      JOIN projects p ON p.id=pi.project_id
      LEFT JOIN task_assignments ta ON ta.project_item_id=pi.id
      WHERE p.status='active'
      GROUP BY pi.id ORDER BY p.created_at DESC, pi.id LIMIT 20`);

    const itemIds = pipelineItems.map(i => i.id);
    let deptTasks = [];
    if (itemIds.length > 0) {
      [deptTasks] = await db.query(`
        SELECT ta.project_item_id, ta.status, ta.quantity_assigned, ta.quantity_completed,
          d.name as dept_name, d.color as dept_color, d.stage_order,
          COALESCE(ta.stage_order, d.stage_order) as sort_order
        FROM task_assignments ta
        LEFT JOIN departments d ON d.id=ta.department_id
        WHERE ta.project_item_id IN (${itemIds.join(',')})
        ORDER BY ta.project_item_id, sort_order`);
    }

    const deptMap = {};
    for (const t of deptTasks) {
      if (!t.dept_name) continue;
      if (!deptMap[t.project_item_id]) deptMap[t.project_item_id] = [];
      deptMap[t.project_item_id].push(t);
    }

    const pipeline = pipelineItems.map(item => ({
      ...item,
      departments: deptMap[item.id] || []
    }));

    res.json({
      tasks: taskStats,
      projects: projStats,
      workers: workerStats,
      recentProjects,
      delayedTasks,
      pipeline,
      workerPerformance,
      deptLoad
    });
  } catch(err) {
    console.error('dashboard error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Product tracking — stage-wise per product
router.get('/reports/product-tracking', auth, async (req, res) => {
  const db = await getPool();
  const { project_id } = req.query;
  const where = project_id ? 'WHERE pi.project_id=?' : 'WHERE 1=1';
  const params = project_id ? [project_id] : [];
  const [items] = await db.query(`
    SELECT pi.*,p.name as project_name,p.project_id as proj_code,p.client_name,p.status as project_status
    FROM project_items pi JOIN projects p ON p.id=pi.project_id ${where}
    ORDER BY p.created_at DESC,pi.id`, params);
  if (!items.length) return res.json({ items: [], stages: [] });
  const itemIds = items.map(i=>i.id);
  const projectIds = [...new Set(items.map(i => i.project_id))];
  let chains = [];
  let tasks = [];
  if (itemIds.length > 0) {
    // Get both item-specific AND project-level chains
    const [chainsData] = await db.query(`
      SELECT pc.*,d.name as dept_name,d.color as dept_color
      FROM production_chains pc JOIN departments d ON d.id=pc.department_id
      WHERE (pc.project_item_id IN (${itemIds.map(() => '?').join(',')}) 
             OR (pc.project_item_id IS NULL AND pc.project_id IN (${projectIds.map(() => '?').join(',')})))
      ORDER BY pc.stage_order`, [...itemIds, ...projectIds]);
    chains = chainsData;
    const [tasksData] = await db.query(`
      SELECT ta.*,d.name as dept_name,d.color as dept_color,u.name as worker_name
      FROM task_assignments ta
      LEFT JOIN departments d ON d.id=ta.department_id
      LEFT JOIN users u ON u.id=ta.worker_id
      WHERE ta.project_item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY ta.stage_order`, itemIds);
    tasks = tasksData;
  }
  const chainsByItem = {}, projectChains = {}, tasksByItem = {};
  for (const c of chains) {
    if (c.project_item_id) {
      if (!chainsByItem[c.project_item_id]) chainsByItem[c.project_item_id] = [];
      chainsByItem[c.project_item_id].push(c);
    } else {
      if (!projectChains[c.project_id]) projectChains[c.project_id] = [];
      projectChains[c.project_id].push(c);
    }
  }
  for (const t of tasks) { if (!tasksByItem[t.project_item_id]) tasksByItem[t.project_item_id] = []; tasksByItem[t.project_item_id].push(t); }
  const result = items.map(item => {
    // Use item-specific chain if exists, otherwise use project-level chain (not both)
    const chain = (chainsByItem[item.id] && chainsByItem[item.id].length > 0)
      ? chainsByItem[item.id]
      : (projectChains[item.project_id] || []);
    const itemTasks = tasksByItem[item.id] || [];
    const stages = chain.map(c => {
      const t = itemTasks.find(t => t.department_id === c.department_id && t.stage_order === c.stage_order);
      const pct = t && t.quantity_assigned > 0 ? Math.round((t.quantity_completed / t.quantity_assigned) * 100) : 0;
      return { ...c, task: t || null, pct, status: t ? t.status : 'not_assigned' };
    });
    const totalStages = stages.length;
    const doneStages = stages.filter(s => s.status === 'completed').length;
    // Overall % = average of all stage percentages (shows actual work done, not just completed stages)
    const overallPct = totalStages > 0
      ? Math.round(stages.reduce((sum, s) => sum + s.pct, 0) / totalStages)
      : 0;
    return { ...item, stages, overallPct, doneStages, totalStages };
  });
  res.json({ items: result });
});

router.get('/reports/workers', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(`
      SELECT u.id, u.name, u.phone, COALESCE(u.hourly_rate,0) as hourly_rate,
        COUNT(DISTINCT ta.id) as total_tasks,
        SUM(ta.status='completed') as completed,
        SUM(ta.status='in_progress') as in_progress,
        SUM(ta.status!='completed' AND ta.due_date<CURDATE()) as delayed_count,
        SUM(ta.quantity_assigned) as total_qty,
        SUM(ta.quantity_completed) as done_qty,
        0 as total_minutes
      FROM users u
      LEFT JOIN worker_departments wd ON wd.worker_id=u.id
      LEFT JOIN task_assignments ta ON (ta.worker_id=u.id OR ta.department_id=wd.department_id)
      WHERE u.role='worker' AND u.is_active=1
      GROUP BY u.id ORDER BY u.name`);
    res.json(rows);
  } catch(err) {
    console.error('reports/workers error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.get('/reports/departments', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(`
      SELECT d.id, d.name, d.color,
        COUNT(DISTINCT wd.worker_id) as workers,
        COUNT(ta.id) as total_tasks,
        SUM(ta.status='completed') as completed,
        SUM(ta.status='in_progress') as in_progress,
        SUM(ta.status!='completed' AND ta.due_date<CURDATE()) as delayed_count,
        SUM(ta.quantity_assigned) as total_qty,
        SUM(ta.quantity_completed) as done_qty
      FROM departments d
      LEFT JOIN worker_departments wd ON wd.department_id=d.id
      LEFT JOIN task_assignments ta ON ta.department_id=d.id
      WHERE d.is_active=1 GROUP BY d.id ORDER BY d.name`);
    res.json(rows);
  } catch(err) {
    console.error('reports/departments error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.get('/reports/transfers', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const [rows] = await db.query(`
    SELECT tt.*,ta.task_title,ta.status as task_status,
      p.name as project_name,p.project_id as proj_code,
      fw.name as from_worker_name,tw.name as to_worker_name,
      tb.name as transferred_by_name,tb.role as transferred_by_role
    FROM task_transfers tt
    JOIN task_assignments ta ON ta.id=tt.task_id
    JOIN projects p ON p.id=ta.project_id
    LEFT JOIN users fw ON fw.id=tt.from_worker_id
    LEFT JOIN users tw ON tw.id=tt.to_worker_id
    JOIN users tb ON tb.id=tt.transferred_by
    ORDER BY tt.created_at DESC LIMIT 200`);
  res.json(rows);
});

router.get('/reports/material-requests', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [summary] = await db.query(`
      SELECT p.id AS project_id, p.project_id AS proj_code, p.name AS project_name,
        COUNT(DISTINCT wq.id) AS mr_requests,
        COUNT(wqi.id) AS mr_images,
        MAX(wq.created_at) AS latest_request,
        MAX(wqi.created_at) AS latest_image
      FROM worker_queries wq
      JOIN projects p ON p.id=wq.project_id
      LEFT JOIN worker_query_images wqi ON wqi.query_id=wq.id
      WHERE wq.query_type='material_request'
      GROUP BY p.id
      ORDER BY mr_images DESC, mr_requests DESC
      LIMIT 200`);
    res.json(summary);
  } catch(err) {
    console.error('reports/material-requests error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Time report
router.get('/reports/time', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { worker_id, from_date, to_date } = req.query;
  const conds = ['1=1']; const params = [];
  if (worker_id) { conds.push('tl.worker_id=?'); params.push(worker_id); }
  if (from_date) { conds.push('DATE(tl.clock_in)>=?'); params.push(from_date); }
  if (to_date) { conds.push('DATE(tl.clock_in)<=?'); params.push(to_date); }
  const where = 'WHERE ' + conds.join(' AND ');
  const [logs] = await db.query(`
    SELECT tl.*,u.name as worker_name,u.hourly_rate,
      ta.task_title, ta.stage_order, ta.department_id,
      d.name as department_name,
      p.name as project_name,p.client_name,p.project_id as proj_code,
      pi.item_name, COALESCE(pi.proto_code,'') as proto_code,
      ROUND(tl.duration_minutes/60*u.hourly_rate,2) as earnings
    FROM worker_time_logs tl
    JOIN users u ON u.id=tl.worker_id
    JOIN task_assignments ta ON ta.id=tl.task_id
    LEFT JOIN departments d ON d.id=ta.department_id
    LEFT JOIN project_items pi ON pi.id=ta.project_item_id
    JOIN projects p ON p.id=ta.project_id
    ${where} ORDER BY tl.clock_in DESC LIMIT 500`, params);
  const [summary] = await db.query(`
    SELECT u.id,u.name,u.hourly_rate,COUNT(*) as sessions,
      SUM(tl.duration_minutes) as total_minutes,
      ROUND(SUM(tl.duration_minutes)/60*u.hourly_rate,2) as total_earnings
    FROM worker_time_logs tl JOIN users u ON u.id=tl.worker_id
    ${where} GROUP BY u.id ORDER BY total_minutes DESC`, params);
  res.json({ logs, summary });
});


// ══════════════════════════════════════════════════════════════════
// FEATURE 1: DAILY DATE-WISE PROGRESS
// ══════════════════════════════════════════════════════════════════

// Worker adds daily progress (how many pieces done today)
router.post('/tasks/:id/daily-progress', auth, async (req, res) => {
  const db = await getPool();
  const { qty_done, work_date, notes } = req.body;
  try {
    const [task] = await db.query('SELECT * FROM task_assignments WHERE id=?', [req.params.id]);
    if (!task[0]) return res.status(404).json({ message: 'Task not found' });
    const t = task[0];
    const dateToUse = work_date || new Date().toISOString().slice(0,10);

    // Insert or update existing entry for same date
    const [existing] = await db.query(
      'SELECT id FROM daily_progress WHERE task_id=? AND work_date=? AND (worker_id=? OR created_by=?)',
      [req.params.id, dateToUse, req.user.id, req.user.id]
    );

    if (existing.length > 0) {
      await db.query('UPDATE daily_progress SET qty_done=?, notes=? WHERE id=?',
        [qty_done, notes, existing[0].id]);
    } else {
      await db.query(
        'INSERT INTO daily_progress (task_id,project_item_id,department_id,worker_id,work_date,qty_done,notes,created_by) VALUES (?,?,?,?,?,?,?,?)',
        [req.params.id, t.project_item_id, t.department_id || null, req.user.id, dateToUse, qty_done, notes, req.user.id]
      );
    }

    // Auto-update total quantity_completed in task
    const [totals] = await db.query(
      'SELECT SUM(qty_done) as total FROM daily_progress WHERE task_id=?', [req.params.id]);
    const totalDone = Math.min(totals[0].total || 0, t.quantity_assigned);
    let newStatus = t.status;
    if (totalDone >= t.quantity_assigned) newStatus = 'completed';
    else if (totalDone > 0) newStatus = 'in_progress';

    await db.query('UPDATE task_assignments SET quantity_completed=?, status=?, updated_at=NOW() WHERE id=?',
      [totalDone, newStatus, req.params.id]);

    // Auto-advance chain — pass task ID (not project_item_id!)
    if (newStatus === 'completed' && t.status !== 'completed') {
      await autoAdvanceChain(db, req.params.id);
    } else if (newStatus === 'in_progress' && totalDone > 0) {
      // Also trigger partial transfer if in progress
      await autoAdvanceChain(db, req.params.id);
    }

    res.json({ message: 'Daily progress saved', total_done: totalDone, status: newStatus });
  } catch(err) {
    console.error('daily-progress error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Get daily progress for a task
router.get('/tasks/:id/daily-progress', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(
      `SELECT dp.*, u.name as worker_name
       FROM daily_progress dp
       LEFT JOIN users u ON u.id=dp.worker_id
       WHERE dp.task_id=? ORDER BY dp.work_date ASC`, [req.params.id]);
    res.json(rows);
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: get daily progress report for a project (all items + all departments + all dates)
router.get('/reports/daily-progress', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { project_id, date_from, date_to } = req.query;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (project_id) { where += ' AND ta.project_id=?'; params.push(project_id); }
    if (date_from) { where += ' AND dp.work_date>=?'; params.push(date_from); }
    if (date_to) { where += ' AND dp.work_date<=?'; params.push(date_to); }

    const [rows] = await db.query(`
      SELECT dp.work_date, dp.qty_done, dp.notes,
        pi.item_name, COALESCE(pi.proto_code,'') as proto_code, pi.quantity as total_qty,
        d.name as dept_name, d.color as dept_color,
        u.name as worker_name,
        ta.task_title, ta.quantity_assigned, ta.quantity_completed, ta.status as task_status,
        p.name as project_name, p.project_id as proj_code
      FROM daily_progress dp
      JOIN task_assignments ta ON ta.id=dp.task_id
      JOIN projects p ON p.id=ta.project_id
      JOIN project_items pi ON pi.id=dp.project_item_id
      JOIN departments d ON d.id=dp.department_id
      LEFT JOIN users u ON u.id=dp.worker_id
      ${where}
      ORDER BY dp.work_date DESC, pi.proto_code, d.name`, params);
    res.json(rows);
  } catch(err) {
    console.error('daily-progress report error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// FEATURE 2: MATERIAL CONSUMPTION & WASTAGE
// ══════════════════════════════════════════════════════════════════

router.get('/materials', auth, async (req, res) => {
  const db = await getPool();
  const { project_id, task_id } = req.query;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (project_id) { where += ' AND mc.project_id=?'; params.push(project_id); }
    if (task_id) { where += ' AND mc.task_id=?'; params.push(task_id); }
    const [rows] = await db.query(`
      SELECT mc.*, u.name as entered_by_name,
        pi.item_name, COALESCE(pi.proto_code,'') as proto_code,
        d.name as dept_name, p.name as project_name
      FROM material_consumption mc
      JOIN users u ON u.id=mc.entered_by
      LEFT JOIN project_items pi ON pi.id=mc.project_item_id
      LEFT JOIN departments d ON d.id=mc.department_id
      LEFT JOIN projects p ON p.id=mc.project_id
      ${where} ORDER BY mc.created_at DESC`, params);
    res.json(rows);
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/materials', auth, auditLog('CREATE','Material'), async (req, res) => {
  const db = await getPool();
  const { project_id, project_item_id, department_id, task_id,
          material_name, consumed_qty, unit, rate_per_unit, material_type, notes, entry_date } = req.body;
  try {
    const total = (parseFloat(consumed_qty)||0) * (parseFloat(rate_per_unit)||0);
    const [r] = await db.query(
      `INSERT INTO material_consumption
        (project_id,project_item_id,department_id,task_id,material_name,consumed_qty,unit,rate_per_unit,total_amount,material_type,notes,entered_by,entry_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [project_id, project_item_id||null, department_id, task_id||null,
       material_name, consumed_qty, unit||'pcs', rate_per_unit||0, total,
       material_type||'consumption', notes, req.user.id, entry_date||new Date().toISOString().slice(0,10)]
    );
    res.json({ id: r.insertId, message: 'Material entry saved' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/materials/:id', auth, auditLog('UPDATE','Material'), async (req, res) => {
  const db = await getPool();
  const { material_name, consumed_qty, unit, rate_per_unit, material_type, notes } = req.body;
  try {
    const total = (parseFloat(consumed_qty)||0) * (parseFloat(rate_per_unit)||0);
    await db.query(
      'UPDATE material_consumption SET material_name=?,consumed_qty=?,unit=?,rate_per_unit=?,total_amount=?,material_type=?,notes=? WHERE id=?',
      [material_name, consumed_qty, unit, rate_per_unit, total, material_type, notes, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/materials/:id', auth, adminOnly, auditLog('DELETE','Material'), async (req, res) => {
  const db = await getPool();
  try {
    await db.query('DELETE FROM material_consumption WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// ── MATERIAL PRODUCTION OUTPUT ───────────────────────────────────────────────
router.get('/production-output', auth, async (req, res) => {
  const db = await getPool();
  const { project_id, department_id } = req.query;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (project_id) { where += ' AND mp.project_id=?'; params.push(project_id); }
    if (department_id) { where += ' AND mp.department_id=?'; params.push(department_id); }
    const [rows] = await db.query(`
      SELECT mp.*, u.name as entered_by_name,
        pi.item_name as project_item_name, COALESCE(pi.proto_code,'') as proto_code,
        d.name as dept_name, p.name as project_name
      FROM material_production mp
      JOIN users u ON u.id=mp.entered_by
      LEFT JOIN project_items pi ON pi.id=mp.project_item_id
      LEFT JOIN departments d ON d.id=mp.department_id
      LEFT JOIN projects p ON p.id=mp.project_id
      ${where} ORDER BY mp.entry_date DESC, mp.created_at DESC`, params);
    res.json(rows);
  } catch(err) { res.status(500).json({ message: err.message }); }
});

router.post('/production-output', auth, async (req, res) => {
  const db = await getPool();
  const { project_id, project_item_id, department_id, item_name, produced_qty, unit, rate_per_unit, notes, entry_date } = req.body;
  try {
    if (!project_id || !item_name || !produced_qty) {
      return res.status(400).json({ message: 'Project, Item name aur Qty zaroori hai' });
    }
    const total = (parseFloat(produced_qty)||0) * (parseFloat(rate_per_unit)||0);
    const [r] = await db.query(
      'INSERT INTO material_production (project_id,project_item_id,department_id,item_name,produced_qty,unit,rate_per_unit,total_amount,notes,entered_by,entry_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [project_id, project_item_id||null, department_id||null, item_name, produced_qty, unit||'pcs', rate_per_unit||0, total, notes, req.user.id, entry_date||new Date().toISOString().slice(0,10)]
    );
    res.json({ id: r.insertId, message: 'Production entry saved' });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

router.delete('/production-output/:id', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    await db.query('DELETE FROM material_production WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/materials', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { project_id } = req.query;
  try {
    let where = project_id ? 'WHERE mc.project_id=?' : 'WHERE 1=1';
    let whereP = project_id ? 'WHERE mp.project_id=?' : 'WHERE 1=1';
    const params = project_id ? [project_id] : [];

    const [summary] = await db.query(`
      SELECT mc.material_name, mc.unit,
        SUM(CASE WHEN mc.material_type='consumption' THEN mc.consumed_qty ELSE 0 END) as total_consumed,
        SUM(CASE WHEN mc.material_type='wastage' THEN mc.consumed_qty ELSE 0 END) as total_wastage,
        SUM(CASE WHEN mc.material_type='consumption' THEN mc.total_amount ELSE 0 END) as consumption_cost,
        SUM(CASE WHEN mc.material_type='wastage' THEN mc.total_amount ELSE 0 END) as wastage_cost,
        SUM(mc.total_amount) as grand_total,
        d.name as dept_name, p.name as project_name
      FROM material_consumption mc
      LEFT JOIN departments d ON d.id=mc.department_id
      LEFT JOIN projects p ON p.id=mc.project_id
      ${where}
      GROUP BY mc.material_name, mc.unit, mc.department_id, mc.project_id
      ORDER BY grand_total DESC`, params);

    const [detail] = await db.query(`
      SELECT mc.*, u.name as entered_by_name,
        pi.item_name, COALESCE(pi.proto_code,'') as proto_code,
        d.name as dept_name, p.name as project_name
      FROM material_consumption mc
      JOIN users u ON u.id=mc.entered_by
      LEFT JOIN project_items pi ON pi.id=mc.project_item_id
      LEFT JOIN departments d ON d.id=mc.department_id
      LEFT JOIN projects p ON p.id=mc.project_id
      ${where} ORDER BY mc.entry_date DESC`, params);

    const [production] = await db.query(`
      SELECT mp.*, u.name as entered_by_name,
        pi.item_name as project_item_name, COALESCE(pi.proto_code,'') as proto_code,
        d.name as dept_name, p.name as project_name
      FROM material_production mp
      JOIN users u ON u.id=mp.entered_by
      LEFT JOIN project_items pi ON pi.id=mp.project_item_id
      LEFT JOIN departments d ON d.id=mp.department_id
      LEFT JOIN projects p ON p.id=mp.project_id
      ${whereP} ORDER BY mp.entry_date DESC`, params);

    // Wastage calculation: consumption cost - production cost
    const totalConsumptionCost = summary.reduce((s,r) => s + parseFloat(r.consumption_cost||0), 0);
    const totalProductionCost = production.reduce((s,r) => s + parseFloat(r.total_amount||0), 0);
    const wastageValue = totalConsumptionCost - totalProductionCost;

    res.json({ summary, detail, production, totalConsumptionCost, totalProductionCost, wastageValue });
  } catch(err) {
    console.error('materials report error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// FEATURE 3: WORKER QUERIES / ISSUES
// ══════════════════════════════════════════════════════════════════

router.get('/queries', auth, async (req, res) => {
  const db = await getPool();
  const { status, project_id, my } = req.query;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (my === 'true' || req.user.role === 'worker') {
      where += ' AND wq.raised_by=?'; params.push(req.user.id);
    }
    if (status) { where += ' AND wq.status=?'; params.push(status); }
    if (project_id) { where += ' AND wq.project_id=?'; params.push(project_id); }

    const [rows] = await db.query(`
      SELECT wq.*,
        u.name as raised_by_name,
        ru.name as responded_by_name,
        p.name as project_name, p.project_id as proj_code,
        pi.item_name, COALESCE(pi.proto_code,'') as proto_code,
        d.name as dept_name,
        ta.task_title
      FROM worker_queries wq
      JOIN users u ON u.id=wq.raised_by
      LEFT JOIN users ru ON ru.id=wq.responded_by
      LEFT JOIN projects p ON p.id=wq.project_id
      LEFT JOIN project_items pi ON pi.id=wq.project_item_id
      LEFT JOIN departments d ON d.id=wq.department_id
      LEFT JOIN task_assignments ta ON ta.id=wq.task_id
      ${where} ORDER BY
        FIELD(wq.priority,'urgent','high','medium','low'),
        FIELD(wq.status,'open','in_review','resolved','closed'),
        wq.created_at DESC`, params);

    const queryIds = rows.map(r => r.id);
    let queryImagesByQueryId = {};
    if (queryIds.length > 0) {
      const [images] = await db.query(
        'SELECT * FROM worker_query_images WHERE query_id IN (?) ORDER BY created_at DESC',
        [queryIds]
      );
      queryImagesByQueryId = images.reduce((acc, image) => {
        const qid = image.query_id;
        if (!acc[qid]) acc[qid] = [];
        acc[qid].push({ ...image, image_url: toHttpsImageUrl(image.image_path) });
        return acc;
      }, {});
    }

    const rowsWithImages = rows.map(row => ({ ...row, images: queryImagesByQueryId[row.id] || [] }));
    res.json(rowsWithImages);
  } catch(err) {
    console.error('queries error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.post('/queries/:id/images', auth, imgUpload.array('images', 10), async (req, res) => {
  const db = await getPool();
  const queryId = req.params.id;
  try {
    const [[query]] = await db.query('SELECT * FROM worker_queries WHERE id=?', [queryId]);
    if (!query) return res.status(404).json({ message: 'Query not found' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: 'No files uploaded' });

    let saved = 0;
    for (const f of files) {
      let publicId = '';
      if (f.filename) publicId = f.filename;
      else if (f.public_id) publicId = f.public_id;
      else if (f.key) publicId = f.key;
      else if (f.path && (f.path.startsWith('http') || f.path.includes('cloudinary'))) {
        const match = f.path.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
        if (match && match[1]) publicId = match[1];
      } else if (f.location) {
        const match = f.location.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
        if (match && match[1]) publicId = match[1];
      }
      publicId = publicId.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '');
      if (!publicId) continue;
      await db.query('INSERT INTO worker_query_images (query_id, project_id, uploaded_by, image_path) VALUES (?,?,?,?)', [queryId, query.project_id, req.user.id, publicId]);
      saved++;
    }
    if (saved === 0) return res.status(400).json({ message: 'No valid images were saved' });

    const [images] = await db.query('SELECT * FROM worker_query_images WHERE query_id=? ORDER BY created_at DESC', [queryId]);
    res.json({ message: `${saved} images uploaded`, images: images.map(img => ({ ...img, image_url: toHttpsImageUrl(img.image_path) })) });
  } catch(err) {
    console.error('query images upload error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.get('/queries/:id/images', auth, async (req, res) => {
  const db = await getPool();
  const queryId = req.params.id;
  try {
    const [images] = await db.query('SELECT * FROM worker_query_images WHERE query_id=? ORDER BY created_at DESC', [queryId]);
    res.json(images.map(img => ({ ...img, image_url: toHttpsImageUrl(img.image_path) })));
  } catch(err) {
    console.error('query images load error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.post('/queries', auth, auditLog('CREATE','Query'), async (req, res) => {
  const db = await getPool();
  const { task_id, project_id, project_item_id, department_id,
          query_type, title, description, priority } = req.body;
  try {
    const [r] = await db.query(
      `INSERT INTO worker_queries
        (task_id,project_id,project_item_id,department_id,raised_by,query_type,title,description,priority)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      [task_id||null, project_id, project_item_id||null, department_id||null,
       req.user.id, query_type||'issue', title, description, priority||'medium']
    );
    res.json({ id: r.insertId, message: 'Query raised successfully' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin responds to query
router.patch('/queries/:id/respond', auth, adminOnly, auditLog('UPDATE','Query'), async (req, res) => {
  const db = await getPool();
  const { admin_response, status } = req.body;
  try {
    await db.query(
      `UPDATE worker_queries SET admin_response=?, status=?, responded_by=?, responded_at=NOW(), updated_at=NOW() WHERE id=?`,
      [admin_response, status||'resolved', req.user.id, req.params.id]
    );
    res.json({ message: 'Response saved' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/queries/:id/status', auth, adminOnly, auditLog('UPDATE','Query'), async (req, res) => {
  const db = await getPool();
  await db.query('UPDATE worker_queries SET status=?, updated_at=NOW() WHERE id=?',
    [req.body.status, req.params.id]);
  res.json({ message: 'Status updated' });
});



// ══════════════════════════════════════════════════════════════════
// APP SETTINGS
// ══════════════════════════════════════════════════════════════════
router.get('/settings', async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query('SELECT setting_key, setting_value FROM app_settings');
    const settings = {};
    rows.forEach(r => settings[r.setting_key] = r.setting_value);
    res.json(settings);
  } catch(err) { res.status(500).json({ message: err.message }); }
});

router.put('/settings', auth, adminOnly, auditLog('UPDATE','Settings'), async (req, res) => {
  const db = await getPool();
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await db.query(
        'INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value=?, updated_by=?',
        [key, value, req.user.id, value, req.user.id]
      );
    }
    res.json({ message: 'Settings saved' });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// ── DEPARTMENT DELETE ────────────────────────────────────────────
router.delete('/departments/:id', auth, adminOnly, auditLog('DELETE','Department'), async (req, res) => {
  const db = await getPool();
  try {
    // Check if dept has active tasks
    const [tasks] = await db.query(
      "SELECT COUNT(*) as cnt FROM task_assignments WHERE department_id=? AND status NOT IN ('completed','cancelled')",
      [req.params.id]
    );
    if (tasks[0].cnt > 0) {
      return res.status(400).json({ message: `${tasks[0].cnt} active tasks hain is department mein — pehle complete karo` });
    }
    // Soft delete — just deactivate
    await db.query('UPDATE departments SET is_active=0 WHERE id=?', [req.params.id]);
    res.json({ message: 'Department deactivated' });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// ── DEPARTMENT HARD DELETE (force) ──────────────────────────────
router.delete('/departments/:id/force', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    await db.query('DELETE FROM worker_departments WHERE department_id=?', [req.params.id]);
    await db.query('DELETE FROM departments WHERE id=?', [req.params.id]);
    res.json({ message: 'Department deleted permanently' });
  } catch(err) { res.status(500).json({ message: err.message }); }
});

// ── DEPARTMENT REORDER ───────────────────────────────────────────
router.post('/departments/reorder', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const { order } = req.body; // [{id, stage_order}]
    for (const item of order) {
      await db.query('UPDATE departments SET stage_order=? WHERE id=?', [item.stage_order, item.id]);
    }
    res.json({ message: 'Reordered' });
  } catch(err) { res.status(500).json({ message: err.message }); }
});


// ── BULK DEPARTMENT ASSIGNMENT ───────────────────────────────────────────────
router.post('/workers/bulk-departments', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { worker_ids, department_ids, action } = req.body;
  // action: 'add' | 'replace'
  try {
    for (const wid of (worker_ids || [])) {
      if (action === 'replace') {
        await db.query('DELETE FROM worker_departments WHERE worker_id=?', [wid]);
      }
      for (const did of (department_ids || [])) {
        await db.query('INSERT IGNORE INTO worker_departments (worker_id,department_id) VALUES (?,?)', [wid, did]);
      }
    }
    res.json({ message: `${worker_ids.length} workers updated` });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// ── FIX IMAGE PATHS IN DB ────────────────────────────────────────────────────
// One-time fix: convert localhost/server URLs stored in image_path to clean public_ids
router.post('/admin/fix-image-paths', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [images] = await db.query('SELECT id, image_path FROM task_images');
    let fixed = 0;
    for (const img of images) {
      const p = String(img.image_path || '').trim();
      if (!p) continue;
      let newPath = p;
      // Extract public_id from localhost or any URL with /uploads/
      if (p.includes('/uploads/')) {
        newPath = p.split('/uploads/').pop(); // e.g. workshop/task-images/abc123
      } else if (p.startsWith('http://res.cloudinary.com') || p.startsWith('https://res.cloudinary.com')) {
        // Extract public_id from full Cloudinary URL
        const match = p.match(/\/upload\/(?:v\d+\/)?(.+)$/);
        if (match) newPath = match[1];
      }
      if (newPath !== p) {
        await db.query('UPDATE task_images SET image_path=? WHERE id=?', [newPath, img.id]);
        fixed++;
      }
    }
    res.json({ message: `Fix complete! ${fixed} image paths updated.`, fixed });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// One-time fix: activate next waiting stage for all completed tasks
router.post('/admin/fix-waiting-tasks', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    // Find all completed tasks that have a next waiting stage
    const [completedTasks] = await db.query(`
      SELECT ta.* FROM task_assignments ta
      WHERE ta.status = 'completed' AND ta.project_item_id IS NOT NULL
      ORDER BY ta.project_item_id, ta.stage_order
    `);

    let fixed = 0;
    for (const task of completedTasks) {
      // Check if there's a waiting task for the next stage of same item+project
      const [[nextTask]] = await db.query(`
        SELECT * FROM task_assignments
        WHERE project_id=? AND project_item_id=? AND stage_order>? AND status='waiting'
        ORDER BY stage_order LIMIT 1`,
        [task.project_id, task.project_item_id, task.stage_order]);

      if (nextTask) {
        // Only activate if NO other task at same stage_order is still incomplete
        // i.e. this completed task is truly the blocker
        await db.query("UPDATE task_assignments SET status='pending' WHERE id=?", [nextTask.id]);
        fixed++;
        console.log(`✅ Fixed: task ${nextTask.id} (${nextTask.task_title}) → pending`);
      }
    }

    res.json({ message: `Fix complete! ${fixed} waiting tasks activated.`, fixed });
  } catch (err) {
    console.error('Fix waiting tasks error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── NOTIFICATIONS ──────────────────────────────────────────────────────────────

// ── PUSH SUBSCRIPTIONS ────────────────────────────────────────────────────────

// Get VAPID public key
router.get('/push/vapid-key', auth, (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || 'BDT3sQDeaJhvQHe_CrbmKifgygdtlppVCbDe7OAY7oobL5D5pnWIOYLy-bVPr30xJLqkHDRZcGVXVIwXLQloeGQ';
  res.json({ publicKey: key });
});

// Save push subscription
router.post('/push/subscribe', auth, async (req, res) => {
  const db = await getPool();
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ message: 'Subscription required' });
    const subStr = JSON.stringify(subscription);
    const endpoint = subscription.endpoint;
    // Upsert — same endpoint update karo
    const [existing] = await db.query(
      'SELECT id FROM push_subscriptions WHERE user_id=? AND endpoint=?',
      [req.user.id, endpoint]
    );
    if (existing.length > 0) {
      await db.query('UPDATE push_subscriptions SET subscription=? WHERE id=?', [subStr, existing[0].id]);
    } else {
      await db.query(
        'INSERT INTO push_subscriptions (user_id, endpoint, subscription) VALUES (?,?,?)',
        [req.user.id, endpoint, subStr]
      );
    }
    res.json({ message: 'Subscribed!' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Remove push subscription
router.post('/push/unsubscribe', auth, async (req, res) => {
  const db = await getPool();
  try {
    const { endpoint } = req.body;
    await db.query('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?', [req.user.id, endpoint]);
    res.json({ message: 'Unsubscribed' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get notifications for current user
router.get('/notifications', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(
      `SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unreadCount = rows.filter(r => !r.is_read).length;
    res.json({ notifications: rows, unread_count: unreadCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Mark notification(s) as read
router.patch('/notifications/read', auth, async (req, res) => {
  const db = await getPool();
  const { ids } = req.body; // array of ids, or empty = mark all
  try {
    if (ids && ids.length > 0) {
      await db.query(
        `UPDATE notifications SET is_read=1 WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`,
        [req.user.id, ...ids]
      );
    } else {
      await db.query('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]);
    }
    res.json({ message: 'Read mark ho gaya' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Delete a notification
router.delete('/notifications/:id', auth, async (req, res) => {
  const db = await getPool();
  await db.query('DELETE FROM notifications WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ message: 'Deleted' });
});

// ── PACKING BOXES ─────────────────────────────────────────────────────────────

// Generate next box number
async function generateBoxNumber(db) {
  const [setting] = await db.query(
    "SELECT setting_value FROM app_settings WHERE setting_key='packing_box_prefix'"
  );
  const prefix = setting[0]?.setting_value || 'BOX';
  const [last] = await db.query(
    "SELECT box_number FROM packing_boxes WHERE box_number LIKE ? ORDER BY id DESC LIMIT 1",
    [`${prefix}-%`]
  );
  if (!last[0]) return `${prefix}-01`;
  const lastNum = parseInt(last[0].box_number.split('-').pop()) || 0;
  return `${prefix}-${String(lastNum + 1).padStart(2, '0')}`;
}

// Get all boxes (with items) — filter by project or all
router.get('/packing/boxes', auth, async (req, res) => {
  const db = await getPool();
  try {
    const { project_id } = req.query;
    const where = project_id ? 'WHERE pb.project_id=?' : 'WHERE 1=1';
    const params = project_id ? [project_id] : [];
    const [boxes] = await db.query(`
      SELECT pb.*, pb.sub_label, u.name as created_by_name,
        p.name as project_name, p.project_id as proj_code, p.client_name,
        pi.item_name,
        (SELECT COUNT(*) FROM packing_box_photos pbp WHERE pbp.box_id = pb.id) as photo_count
      FROM packing_boxes pb
      LEFT JOIN users u ON u.id = pb.created_by
      LEFT JOIN projects p ON p.id = pb.project_id
      LEFT JOIN project_items pi ON pi.id = pb.project_item_id
      ${where} ORDER BY pb.created_at DESC`, params);

    // Get items for each box
    for (const box of boxes) {
      const [items] = await db.query(
        'SELECT * FROM packing_box_items WHERE box_id=? ORDER BY id',
        [box.id]
      );
      box.items = items;
    }
    res.json(boxes);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Create new box (manual or auto)
router.post('/packing/boxes', auth, auditLog('CREATE','PackingBox'), async (req, res) => {
  const db = await getPool();
  try {
    const { project_id, project_item_id, mode, items, notes, box_number, photo_code, main_item, sub_label } = req.body;
    const finalBoxNum = box_number || await generateBoxNumber(db);
    const finalSubLabel = sub_label ? sub_label.trim().toUpperCase() : null;

    const [r] = await db.query(
      'INSERT INTO packing_boxes (box_number, sub_label, project_id, project_item_id, photo_code, main_item, mode, created_by, notes) VALUES (?,?,?,?,?,?,?,?,?)',
      [finalBoxNum, finalSubLabel, project_id || null, project_item_id || null, photo_code || null, main_item || null, mode || 'manual', req.user.id, notes || '']
    );
    const boxId = r.insertId;

    // Add items to box
    if (items && items.length > 0) {
      for (const item of items) {
        await db.query(
          'INSERT INTO packing_box_items (box_id, item_name, quantity, unit, notes) VALUES (?,?,?,?,?)',
          [boxId, item.item_name, item.quantity || 1, item.unit || 'pcs', item.notes || '']
        );
      }
    }

    const [[box]] = await db.query(
      'SELECT pb.*, u.name as created_by_name FROM packing_boxes pb JOIN users u ON u.id=pb.created_by WHERE pb.id=?',
      [boxId]
    );
    const [boxItems] = await db.query('SELECT * FROM packing_box_items WHERE box_id=?', [boxId]);
    res.json({ ...box, items: boxItems });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Update box
router.put('/packing/boxes/:id', auth, auditLog('UPDATE','PackingBox'), async (req, res) => {
  const db = await getPool();
  try {
    const { notes, items, photo_code, main_item } = req.body;
    await db.query(
      'UPDATE packing_boxes SET notes=?, photo_code=?, main_item=? WHERE id=?',
      [notes || '', photo_code || null, main_item || null, req.params.id]
    );
    if (items) {
      await db.query('DELETE FROM packing_box_items WHERE box_id=?', [req.params.id]);
      for (const item of items) {
        await db.query(
          'INSERT INTO packing_box_items (box_id, item_name, quantity, unit, notes) VALUES (?,?,?,?,?)',
          [req.params.id, item.item_name, item.quantity || 1, item.unit || 'pcs', item.notes || '']
        );
      }
    }
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Delete box
router.delete('/packing/boxes/:id', auth, auditLog('DELETE','PackingBox'), async (req, res) => {
  const db = await getPool();
  await db.query('DELETE FROM packing_boxes WHERE id=?', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Get next box number (for UI preview)
router.get('/packing/next-box-number', auth, async (req, res) => {
  const db = await getPool();
  try {
    const nextNum = await generateBoxNumber(db);
    res.json({ box_number: nextNum });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Upload photos for a box
router.post('/packing/boxes/:id/photos', auth, imgUpload.array('photos', 10), async (req, res) => {
  const db = await getPool();
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: 'Koi photo nahi' });

    let savedCount = 0;
    for (const f of files) {
      let publicId = '';

      // Method 1: filename (multer-storage-cloudinary v4 primary field)
      if (f.filename && typeof f.filename === 'string') {
        publicId = f.filename;
      }
      // Method 2: key (from multer-storage-cloudinary)
      else if (f.key && typeof f.key === 'string') {
        publicId = f.key;
      }
      // Method 3: public_id
      else if (f.public_id && typeof f.public_id === 'string') {
        publicId = f.public_id;
      }
      // Method 4: extract from path URL
      else if (f.path && (f.path.startsWith('http') || f.path.includes('cloudinary'))) {
        const match = f.path.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
        if (match && match[1]) publicId = match[1];
      }
      // Method 5: extract from location/secure_url
      else if (f.location || f.secure_url) {
        const url = f.location || f.secure_url;
        const match = url.match(/\/upload\/(?:v[\d]+\/)?(.+?)(?:\?|$)/);
        if (match && match[1]) publicId = match[1];
      }

      // Clean extension
      publicId = publicId.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '');

      // Remove full URL prefix if accidentally included
      if (publicId.startsWith('https://') || publicId.startsWith('http://')) {
        const match = publicId.match(/workshop\/[a-z0-9\-_]+\/[a-z0-9\-_]+/i);
        if (match) publicId = match[0];
      }

      if (publicId) {
        await db.query(
          'INSERT INTO packing_box_photos (box_id, image_path, uploaded_by) VALUES (?,?,?)',
          [req.params.id, publicId, req.user.id]
        );
        savedCount++;
      }
    }

    if (savedCount === 0) {
      return res.status(400).json({ message: 'Photos save nahi ho sake — retry karo' });
    }

    // Return updated photos list
    const [photos] = await db.query(
      'SELECT * FROM packing_box_photos WHERE box_id=? ORDER BY created_at DESC',
      [req.params.id]
    );
    const photosWithUrl = photos.map(p => ({ ...p, image_url: toHttpsImageUrl(p.image_path) }));
    res.json({ message: `${savedCount} photos upload ho gaye`, photos: photosWithUrl });
  } catch (err) {
    console.error('Packing photo upload error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Get photos for a box
router.get('/packing/boxes/:id/photos', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [photos] = await db.query(
      'SELECT * FROM packing_box_photos WHERE box_id=? ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(photos.map(p => ({ ...p, image_url: toHttpsImageUrl(p.image_path) })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Delete a box photo
router.delete('/packing/boxes/:boxId/photos/:photoId', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [[photo]] = await db.query('SELECT * FROM packing_box_photos WHERE id=? AND box_id=?', [req.params.photoId, req.params.boxId]);
    if (!photo) return res.status(404).json({ message: 'Photo nahi mili' });
    await deleteFile(photo.image_path);
    await db.query('DELETE FROM packing_box_photos WHERE id=?', [req.params.photoId]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PACKING PARTS ─────────────────────────────────────────────────────────────

// Get packing parts for a project item
router.get('/packing-parts/:project_item_id', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [parts] = await db.query(`
      SELECT pp.*,
        COALESCE((SELECT SUM(pl.packed_qty) FROM packing_logs pl WHERE pl.packing_part_id = pp.id), 0) as packed_qty,
        (SELECT u.name FROM packing_logs pl JOIN users u ON u.id = pl.packed_by 
         WHERE pl.packing_part_id = pp.id ORDER BY pl.packed_at DESC LIMIT 1) as last_packed_by_name
      FROM packing_parts pp
      WHERE pp.project_item_id = ?
      ORDER BY pp.sort_order, pp.id`, [req.params.project_item_id]);
    res.json(parts);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Create packing parts for a project item (admin)
router.post('/packing-parts', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const { project_item_id, project_id, parts } = req.body;
    // parts = [{part_name, quantity, unit, sort_order}]
    if (!parts || !parts.length) return res.status(400).json({ message: 'Parts list empty hai' });
    // Delete existing parts first
    await db.query('DELETE FROM packing_parts WHERE project_item_id=?', [project_item_id]);
    for (const p of parts) {
      await db.query(
        'INSERT INTO packing_parts (project_item_id, project_id, part_name, quantity, unit, sort_order) VALUES (?,?,?,?,?,?)',
        [project_item_id, project_id, p.part_name, p.quantity || 1, p.unit || 'pcs', p.sort_order || 0]
      );
    }
    res.json({ message: 'Packing parts save ho gaye' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Delete a single packing part (admin)
router.delete('/packing-parts/:id', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  await db.query('DELETE FROM packing_parts WHERE id=?', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Log packing progress for a part (worker)
router.post('/packing-parts/:id/log', auth, async (req, res) => {
  const db = await getPool();
  try {
    const { packed_qty, notes } = req.body;
    const [[part]] = await db.query('SELECT * FROM packing_parts WHERE id=?', [req.params.id]);
    if (!part) return res.status(404).json({ message: 'Part nahi mila' });

    // Get already packed qty
    const [[existing]] = await db.query(
      'SELECT COALESCE(SUM(packed_qty),0) as total FROM packing_logs WHERE packing_part_id=?',
      [req.params.id]
    );
    const alreadyPacked = parseInt(existing.total || 0);
    const newTotal = alreadyPacked + parseInt(packed_qty || 0);

    if (newTotal > part.quantity) {
      return res.status(400).json({
        message: `Sirf ${part.quantity - alreadyPacked} units baki hain pack karne ke liye`,
        remaining: part.quantity - alreadyPacked
      });
    }

    await db.query(
      'INSERT INTO packing_logs (packing_part_id, project_item_id, packed_qty, packed_by, notes) VALUES (?,?,?,?,?)',
      [req.params.id, part.project_item_id, parseInt(packed_qty), req.user.id, notes || '']
    );

    res.json({ message: 'Packing log save ho gaya', total_packed: newTotal, remaining: part.quantity - newTotal });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get packing logs for a part
router.get('/packing-parts/:id/logs', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [logs] = await db.query(`
      SELECT pl.*, u.name as packed_by_name
      FROM packing_logs pl
      JOIN users u ON u.id = pl.packed_by
      WHERE pl.packing_part_id = ?
      ORDER BY pl.packed_at DESC`, [req.params.id]);
    res.json(logs);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get full packing summary for label printing
router.get('/packing-label/:project_item_id', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [[item]] = await db.query(`
      SELECT pi.*, p.name as project_name, p.project_id as proj_code,
        p.client_name, p.deadline
      FROM project_items pi
      JOIN projects p ON p.id = pi.project_id
      WHERE pi.id = ?`, [req.params.project_item_id]);
    if (!item) return res.status(404).json({ message: 'Item nahi mila' });

    const [parts] = await db.query(`
      SELECT pp.*,
        COALESCE((SELECT SUM(pl.packed_qty) FROM packing_logs pl WHERE pl.packing_part_id = pp.id), 0) as packed_qty
      FROM packing_parts pp
      WHERE pp.project_item_id = ?
      ORDER BY pp.sort_order, pp.id`, [req.params.project_item_id]);

    res.json({ item, parts });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE ALL DATA ───────────────────────────────────────────────────────────
router.post('/admin/delete-all-data', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    // Delete all project-related data
    await db.query('DELETE FROM task_transfers');
    await db.query('DELETE FROM task_images');
    await db.query('DELETE FROM worker_time_logs');
    await db.query('DELETE FROM daily_progress');
    await db.query('DELETE FROM task_progress');
    await db.query('DELETE FROM task_assignments');
    await db.query('DELETE FROM production_chains');
    await db.query('DELETE FROM project_items');
    await db.query('DELETE FROM projects');
    await db.query('DELETE FROM worker_departments');
    
    // Keep workers/departments but clear their associations
    // Keep users (admin + workers) but mark workers as inactive
    await db.query("UPDATE users SET is_active=0 WHERE role='worker'");
    
    res.json({ message: 'All data deleted successfully' });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});


// ── Barcode Generator API ─────────────────────────────────────────────────────
// GET /api/barcodes/items — all project items that have proto_code set
router.get('/barcodes/items', auth, async (req, res) => {
  const db = await getPool();
  try {
    const { project_id } = req.query;
    let query = `
      SELECT 
        pi.id, pi.item_name, pi.proto_code, pi.quantity, pi.unit,
        p.id as project_id, p.name as project_name, p.project_id as proj_code, p.client_name
      FROM project_items pi
      JOIN projects p ON p.id = pi.project_id
      WHERE pi.proto_code IS NOT NULL AND pi.proto_code != ''
        AND p.status != 'deleted'
    `;
    const params = [];
    if (project_id) { query += ' AND p.id = ?'; params.push(project_id); }
    query += ' ORDER BY p.name, pi.item_name';
    const [items] = await db.query(query, params);
    res.json(items);
  } catch (err) {
    console.error('Barcode items error:', err.message);
    res.status(500).json({ message: err.message });
  }
});


// GET /api/barcodes/lookup?code=XYZ — scan se item dhundo
router.get('/barcodes/lookup', auth, async (req, res) => {
  const db = await getPool();
  try {
    const { code } = req.query;
    if (!code?.trim()) return res.status(400).json({ message: 'Barcode code required' });
    const [items] = await db.query(`
      SELECT
        pi.id, pi.item_name, pi.proto_code, pi.quantity, pi.unit,
        pi.unit_price, pi.description, pi.dimensions,
        p.id as project_id, p.name as project_name, p.project_id as proj_code, p.client_name
      FROM project_items pi
      JOIN projects p ON p.id = pi.project_id
      WHERE pi.proto_code = ? AND p.status != 'deleted'
      LIMIT 5
    `, [code.trim()]);
    if (!items.length) return res.status(404).json({ message: `No item found for barcode: ${code}` });
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ── PURCHASE ORDERS ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// Helper: generate next PO number
// ── Numbering helpers (per-type: po | sale | delivery | proforma) ──────────

async function getNextAutoNumber(db, docType) {
  const prefixKey = `${docType}_prefix`;
  const startKey  = `${docType}_start_number`;
  const defaults  = { po: 'PO', sale: 'INV', delivery: 'DC', proforma: 'PRO' };

  const [[prefixRow]] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [prefixKey]);
  const [[startRow]]  = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [startKey]);

  const prefix   = (prefixRow?.setting_value || defaults[docType] || docType.toUpperCase()).trim();
  const startNum = parseInt(startRow?.setting_value || '1001');

  const table      = docType === 'po' ? 'purchase_orders' : 'sale_challans';
  const col        = docType === 'po' ? 'po_number'       : 'challan_number';
  const typeFilter = docType !== 'po' ? ` AND challan_type='${docType}'` : '';

  const [[maxRow]] = await db.query(
    `SELECT MAX(CAST(SUBSTRING(${col}, ?) AS UNSIGNED)) as maxn FROM ${table} WHERE ${col} LIKE ?${typeFilter}`,
    [prefix.length + 2, prefix + '-%']
  );
  const maxn = maxRow?.maxn || (startNum - 1);
  const next = Math.max(maxn + 1, startNum);
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

async function getLastUsedNumber(db, docType) {
  const prefixKey = `${docType}_prefix`;
  const defaults  = { po: 'PO', sale: 'INV', delivery: 'DC', proforma: 'PRO' };
  const [[prefixRow]] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [prefixKey]);
  const prefix = (prefixRow?.setting_value || defaults[docType] || docType.toUpperCase()).trim();

  const table      = docType === 'po' ? 'purchase_orders' : 'sale_challans';
  const col        = docType === 'po' ? 'po_number'       : 'challan_number';
  const typeFilter = docType !== 'po' ? ` AND challan_type='${docType}'` : '';

  const [[row]] = await db.query(
    `SELECT ${col} as num FROM ${table} WHERE ${col} LIKE ?${typeFilter} ORDER BY id DESC LIMIT 1`,
    [prefix + '-%']
  );
  return row?.num || null;
}

async function getNumberingMode(db, docType) {
  const [[row]] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [`${docType}_numbering_mode`]);
  return row?.setting_value || 'auto';
}

async function getNextPONumber(db) { return getNextAutoNumber(db, 'po'); }

// GET all purchase orders
router.get('/purchase-orders', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const { project_id, status, search } = req.query;
    let sql = `
      SELECT po.*, p.name as project_name, p.project_id as proj_code,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM purchase_order_items WHERE po_id=po.id) as item_count
      FROM purchase_orders po
      LEFT JOIN projects p ON p.id = po.project_id
      JOIN users u ON u.id = po.created_by
      WHERE 1=1`;
    const params = [];
    if (project_id) { sql += ' AND po.project_id=?'; params.push(project_id); }
    if (status) { sql += ' AND po.status=?'; params.push(status); }
    if (search) { sql += ' AND (po.po_number LIKE ? OR po.supplier_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY po.created_at DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET single PO with items
router.get('/purchase-orders/:id', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [[po]] = await db.query(`
      SELECT po.*, p.name as project_name, p.project_id as proj_code,
        u.name as created_by_name
      FROM purchase_orders po
      LEFT JOIN projects p ON p.id = po.project_id
      JOIN users u ON u.id = po.created_by
      WHERE po.id=?`, [req.params.id]);
    if (!po) return res.status(404).json({ message: 'Purchase Order not found' });
    const [items] = await db.query('SELECT * FROM purchase_order_items WHERE po_id=? ORDER BY sort_order, id', [req.params.id]);
    res.json({ ...po, items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST create PO
router.post('/purchase-orders', auth, adminOnly, auditLog('CREATE','PurchaseOrder'), async (req, res) => {
  const db = await getPool();
  try {
    const { supplier_name, supplier_phone, supplier_address, supplier_gstin,
      project_id, order_date, expected_delivery, status, notes,
      tax_percent, discount_amount, items, manual_number } = req.body;
    if (!supplier_name?.trim()) return res.status(400).json({ message: 'Supplier name required' });
    if (!items?.length) return res.status(400).json({ message: 'Please add at least one item' });

    const poMode = await getNumberingMode(db, 'po');
    let po_number;
    if (poMode === 'manual') {
      if (!manual_number?.trim()) return res.status(400).json({ message: 'PO number is required in manual mode' });
      po_number = manual_number.trim();
    } else {
      po_number = await getNextAutoNumber(db, 'po');
    }
    let subtotal = 0;
    for (const item of items) { subtotal += (parseFloat(item.quantity) || 0) * (parseFloat(item.rate) || 0); }
    const taxPct = parseFloat(tax_percent) || 0;
    const disc = parseFloat(discount_amount) || 0;
    const tax_amount = parseFloat(((subtotal - disc) * taxPct / 100).toFixed(2));
    const total_amount = parseFloat((subtotal - disc + tax_amount).toFixed(2));

    const [r] = await db.query(
      `INSERT INTO purchase_orders (po_number,supplier_name,supplier_phone,supplier_address,supplier_gstin,
        project_id,order_date,expected_delivery,status,subtotal,tax_percent,tax_amount,discount_amount,total_amount,notes,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [po_number, supplier_name.trim(), supplier_phone||'', supplier_address||'', supplier_gstin||'',
        project_id||null, order_date, expected_delivery||null, status||'draft',
        subtotal, taxPct, tax_amount, disc, total_amount, notes||'', req.user.id]
    );
    const poId = r.insertId;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity) || 0;
      const rate = parseFloat(it.rate) || 0;
      await db.query(
        'INSERT INTO purchase_order_items (po_id,item_name,description,quantity,unit,rate,total,sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [poId, it.item_name, it.description||'', qty, it.unit||'pcs', rate, qty*rate, i]
      );
    }
    res.json({ id: poId, po_number, message: 'Purchase Order created successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT update PO
router.put('/purchase-orders/:id', auth, adminOnly, auditLog('UPDATE','PurchaseOrder'), async (req, res) => {
  const db = await getPool();
  try {
    const { supplier_name, supplier_phone, supplier_address, supplier_gstin,
      project_id, order_date, expected_delivery, status, notes,
      tax_percent, discount_amount, items } = req.body;
    if (!supplier_name?.trim()) return res.status(400).json({ message: 'Supplier name required' });
    if (!items?.length) return res.status(400).json({ message: 'Please add at least one item' });

    let subtotal = 0;
    for (const item of items) { subtotal += (parseFloat(item.quantity) || 0) * (parseFloat(item.rate) || 0); }
    const taxPct = parseFloat(tax_percent) || 0;
    const disc = parseFloat(discount_amount) || 0;
    const tax_amount = parseFloat(((subtotal - disc) * taxPct / 100).toFixed(2));
    const total_amount = parseFloat((subtotal - disc + tax_amount).toFixed(2));

    await db.query(
      `UPDATE purchase_orders SET supplier_name=?,supplier_phone=?,supplier_address=?,supplier_gstin=?,
        project_id=?,order_date=?,expected_delivery=?,status=?,subtotal=?,tax_percent=?,
        tax_amount=?,discount_amount=?,total_amount=?,notes=? WHERE id=?`,
      [supplier_name.trim(), supplier_phone||'', supplier_address||'', supplier_gstin||'',
        project_id||null, order_date, expected_delivery||null, status||'draft',
        subtotal, taxPct, tax_amount, disc, total_amount, notes||'', req.params.id]
    );
    await db.query('DELETE FROM purchase_order_items WHERE po_id=?', [req.params.id]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity) || 0;
      const rate = parseFloat(it.rate) || 0;
      await db.query(
        'INSERT INTO purchase_order_items (po_id,item_name,description,quantity,unit,rate,total,sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [req.params.id, it.item_name, it.description||'', qty, it.unit||'pcs', rate, qty*rate, i]
      );
    }
    res.json({ message: 'Purchase Order updated successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH status only
router.patch('/purchase-orders/:id/status', auth, adminOnly, auditLog('UPDATE','PurchaseOrder'), async (req, res) => {
  const db = await getPool();
  try {
    const { status } = req.body;
    await db.query('UPDATE purchase_orders SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ message: 'Status updated successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE PO
router.delete('/purchase-orders/:id', auth, adminOnly, auditLog('DELETE','PurchaseOrder'), async (req, res) => {
  const db = await getPool();
  try {
    await db.query('DELETE FROM purchase_orders WHERE id=?', [req.params.id]);
    res.json({ message: 'Purchase Order deleted successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// ── SALE CHALLANS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// Helper: generate next Challan number
// getNextChallanNumber is now type-aware (uses getNextAutoNumber)

// GET all challans
router.get('/sale-challans', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const { project_id, status, search } = req.query;
    let sql = `
      SELECT sc.*, p.name as project_name, p.project_id as proj_code,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM sale_challan_items WHERE challan_id=sc.id) as item_count
      FROM sale_challans sc
      LEFT JOIN projects p ON p.id = sc.project_id
      JOIN users u ON u.id = sc.created_by
      WHERE 1=1`;
    const params = [];
    if (project_id) { sql += ' AND sc.project_id=?'; params.push(project_id); }
    if (status) { sql += ' AND sc.status=?'; params.push(status); }
    if (search) { sql += ' AND (sc.challan_number LIKE ? OR sc.client_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY sc.created_at DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET single challan with items
router.get('/sale-challans/:id', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [[challan]] = await db.query(`
      SELECT sc.*, p.name as project_name, p.project_id as proj_code,
        u.name as created_by_name
      FROM sale_challans sc
      LEFT JOIN projects p ON p.id = sc.project_id
      JOIN users u ON u.id = sc.created_by
      WHERE sc.id=?`, [req.params.id]);
    if (!challan) return res.status(404).json({ message: 'Challan not found' });
    const [items] = await db.query('SELECT * FROM sale_challan_items WHERE challan_id=? ORDER BY sort_order, id', [req.params.id]);
    res.json({ ...challan, items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST create challan
router.post('/sale-challans', auth, adminOnly, auditLog('CREATE','SaleChallan'), async (req, res) => {
  const db = await getPool();
  try {
    const { client_name, client_phone, client_address, client_gstin, challan_type,
      project_id, challan_date, delivery_date, status, notes,
      tax_percent, discount_amount, transport_name, vehicle_number, items, manual_number } = req.body;
    if (!client_name?.trim()) return res.status(400).json({ message: 'Client name required' });
    if (!items?.length) return res.status(400).json({ message: 'Please add at least one item' });

    const cType = challan_type || 'delivery';
    const challanMode = await getNumberingMode(db, cType);
    let challan_number;
    if (challanMode === 'manual') {
      if (!manual_number?.trim()) return res.status(400).json({ message: 'Challan number is required in manual mode' });
      challan_number = manual_number.trim();
    } else {
      challan_number = await getNextAutoNumber(db, cType);
    }
    let subtotal = 0;
    for (const item of items) { subtotal += (parseFloat(item.quantity) || 0) * (parseFloat(item.rate) || 0); }
    const taxPct = parseFloat(tax_percent) || 0;
    const disc = parseFloat(discount_amount) || 0;
    const tax_amount = parseFloat(((subtotal - disc) * taxPct / 100).toFixed(2));
    const total_amount = parseFloat((subtotal - disc + tax_amount).toFixed(2));

    const [r] = await db.query(
      `INSERT INTO sale_challans (challan_number,client_name,client_phone,client_address,client_gstin,challan_type,
        project_id,challan_date,delivery_date,status,subtotal,tax_percent,tax_amount,discount_amount,
        total_amount,transport_name,vehicle_number,notes,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [challan_number, client_name.trim(), client_phone||'', client_address||'', client_gstin||'',
        challan_type||'delivery', project_id||null, challan_date, delivery_date||null, status||'draft',
        subtotal, taxPct, tax_amount, disc, total_amount,
        transport_name||'', vehicle_number||'', notes||'', req.user.id]
    );
    const challanId = r.insertId;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity) || 0;
      const rate = parseFloat(it.rate) || 0;
      await db.query(
        'INSERT INTO sale_challan_items (challan_id,item_name,description,quantity,unit,rate,total,sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [challanId, it.item_name, it.description||'', qty, it.unit||'pcs', rate, qty*rate, i]
      );
    }
    res.json({ id: challanId, challan_number, message: 'Sale Challan created successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT update challan
router.put('/sale-challans/:id', auth, adminOnly, auditLog('UPDATE','SaleChallan'), async (req, res) => {
  const db = await getPool();
  try {
    const { client_name, client_phone, client_address, client_gstin, challan_type,
      project_id, challan_date, delivery_date, status, notes,
      tax_percent, discount_amount, transport_name, vehicle_number, items } = req.body;
    if (!client_name?.trim()) return res.status(400).json({ message: 'Client name required' });
    if (!items?.length) return res.status(400).json({ message: 'Please add at least one item' });

    let subtotal = 0;
    for (const item of items) { subtotal += (parseFloat(item.quantity) || 0) * (parseFloat(item.rate) || 0); }
    const taxPct = parseFloat(tax_percent) || 0;
    const disc = parseFloat(discount_amount) || 0;
    const tax_amount = parseFloat(((subtotal - disc) * taxPct / 100).toFixed(2));
    const total_amount = parseFloat((subtotal - disc + tax_amount).toFixed(2));

    await db.query(
      `UPDATE sale_challans SET client_name=?,client_phone=?,client_address=?,client_gstin=?,challan_type=?,
        project_id=?,challan_date=?,delivery_date=?,status=?,subtotal=?,tax_percent=?,
        tax_amount=?,discount_amount=?,total_amount=?,transport_name=?,vehicle_number=?,notes=? WHERE id=?`,
      [client_name.trim(), client_phone||'', client_address||'', client_gstin||'', challan_type||'delivery',
        project_id||null, challan_date, delivery_date||null, status||'draft',
        subtotal, taxPct, tax_amount, disc, total_amount,
        transport_name||'', vehicle_number||'', notes||'', req.params.id]
    );
    await db.query('DELETE FROM sale_challan_items WHERE challan_id=?', [req.params.id]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity) || 0;
      const rate = parseFloat(it.rate) || 0;
      await db.query(
        'INSERT INTO sale_challan_items (challan_id,item_name,description,quantity,unit,rate,total,sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [req.params.id, it.item_name, it.description||'', qty, it.unit||'pcs', rate, qty*rate, i]
      );
    }
    res.json({ message: 'Sale Challan updated successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH status only
router.patch('/sale-challans/:id/status', auth, adminOnly, auditLog('UPDATE','SaleChallan'), async (req, res) => {
  const db = await getPool();
  try {
    const { status } = req.body;
    await db.query('UPDATE sale_challans SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ message: 'Status updated successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE challan
router.delete('/sale-challans/:id', auth, adminOnly, auditLog('DELETE','SaleChallan'), async (req, res) => {
  const db = await getPool();
  try {
    await db.query('DELETE FROM sale_challans WHERE id=?', [req.params.id]);
    res.json({ message: 'Challan deleted successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ── DISPATCH WORKER — Sale Challan routes (auth only, no adminOnly) ───────
// ═══════════════════════════════════════════════════════════════════════════

// GET all challans — dispatch worker sees only delivery type + own challans
router.get('/dispatch/challans', auth, async (req, res) => {
  const db = await getPool();
  try {
    const isAdmin = req.user.role === 'admin';
    let sql = `
      SELECT sc.*, p.name as project_name, p.project_id as proj_code,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM sale_challan_items WHERE challan_id=sc.id) as item_count
      FROM sale_challans sc
      LEFT JOIN projects p ON p.id = sc.project_id
      JOIN users u ON u.id = sc.created_by
      WHERE 1=1`;
    const params = [];
    if (!isAdmin) {
      sql += ' AND sc.created_by = ?';
      params.push(req.user.id);
    }
    sql += ' ORDER BY sc.created_at DESC LIMIT 50';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET single challan with items — dispatch worker can view
router.get('/dispatch/challans/:id', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [[challan]] = await db.query(`
      SELECT sc.*, p.name as project_name, p.project_id as proj_code,
        u.name as created_by_name
      FROM sale_challans sc
      LEFT JOIN projects p ON p.id = sc.project_id
      JOIN users u ON u.id = sc.created_by
      WHERE sc.id=?`, [req.params.id]);
    if (!challan) return res.status(404).json({ message: 'Challan not found' });
    // Non-admin can only view own challans
    if (req.user.role !== 'admin' && challan.created_by !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const [items] = await db.query('SELECT * FROM sale_challan_items WHERE challan_id=? ORDER BY sort_order, id', [req.params.id]);
    res.json({ ...challan, items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST create challan — dispatch worker can create delivery challan
router.post('/dispatch/challans', auth, auditLog('CREATE','Dispatch'), async (req, res) => {
  const db = await getPool();
  try {
    const { client_name, client_phone, client_address, client_gstin,
      project_id, challan_date, delivery_date, notes,
      tax_percent, discount_amount, transport_name, vehicle_number,
      items, manual_number } = req.body;
    if (!client_name?.trim()) return res.status(400).json({ message: 'Client name required' });
    if (!items?.length) return res.status(400).json({ message: 'Please add at least one item' });

    const challan_type = 'delivery'; // dispatch worker only creates delivery challans
    const cType = challan_type;
    const challanMode = await getNumberingMode(db, cType);
    let challan_number;
    if (challanMode === 'manual') {
      if (!manual_number?.trim()) return res.status(400).json({ message: 'Challan number is required in manual mode' });
      challan_number = manual_number.trim();
    } else {
      challan_number = await getNextAutoNumber(db, cType);
    }

    let subtotal = 0;
    for (const item of items) { subtotal += (parseFloat(item.quantity) || 0) * (parseFloat(item.rate) || 0); }
    const taxPct = parseFloat(tax_percent) || 0;
    const disc = parseFloat(discount_amount) || 0;
    const tax_amount = parseFloat(((subtotal - disc) * taxPct / 100).toFixed(2));
    const total_amount = parseFloat((subtotal - disc + tax_amount).toFixed(2));

    const [r] = await db.query(
      `INSERT INTO sale_challans (challan_number,client_name,client_phone,client_address,client_gstin,challan_type,
        project_id,challan_date,delivery_date,status,subtotal,tax_percent,tax_amount,discount_amount,
        total_amount,transport_name,vehicle_number,notes,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [challan_number, client_name.trim(), client_phone||'', client_address||'', client_gstin||'',
        challan_type, project_id||null, challan_date, delivery_date||null, 'draft',
        subtotal, taxPct, tax_amount, disc, total_amount,
        transport_name||'', vehicle_number||'', notes||'', req.user.id]
    );
    const challanId = r.insertId;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity) || 0;
      const rate = parseFloat(it.rate) || 0;
      await db.query(
        'INSERT INTO sale_challan_items (challan_id,item_name,description,quantity,unit,rate,total,sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [challanId, it.item_name, it.description||'', qty, it.unit||'pcs', rate, qty*rate, i]
      );
    }
    res.json({ id: challanId, challan_number, message: 'Delivery Challan created successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH mark as delivered — dispatch worker can update status
router.patch('/dispatch/challans/:id/status', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [[challan]] = await db.query('SELECT created_by FROM sale_challans WHERE id=?', [req.params.id]);
    if (!challan) return res.status(404).json({ message: 'Challan not found' });
    if (req.user.role !== 'admin' && challan.created_by !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const { status } = req.body;
    await db.query('UPDATE sale_challans SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ message: 'Status updated successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET projects list for dispatch worker
router.get('/dispatch/projects', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [rows] = await db.query(`
      SELECT id, name, project_id, client_name, client_phone, status
      FROM projects WHERE status != 'deleted' ORDER BY name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET project items for dispatch worker (to auto-fill challan)
router.get('/dispatch/projects/:id/items', auth, async (req, res) => {
  const db = await getPool();
  try {
    const [items] = await db.query(`
      SELECT id, item_name, description, quantity, unit, unit_price, dimensions
      FROM project_items WHERE project_id=? ORDER BY item_name
    `, [req.params.id]);
    res.json(items);
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// ── Numbering Info API (for Settings page & manual mode) ──────────────────
// GET last used numbers + modes for all doc types
router.get('/numbering-info', auth, async (req, res) => {
  const db = await getPool();
  try {
    const types = ['po', 'sale', 'delivery', 'proforma'];
    const result = {};
    for (const t of types) {
      const mode = await getNumberingMode(db, t);
      const last = await getLastUsedNumber(db, t);
      const [[pfxRow]]   = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [`${t}_prefix`]);
      const [[startRow]] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [`${t}_start_number`]);
      const defaults = { po: 'PO', sale: 'INV', delivery: 'DC', proforma: 'PRO' };
      result[t] = {
        mode,
        prefix: pfxRow?.setting_value || defaults[t],
        start_number: startRow?.setting_value || '1001',
        last_used: last,
      };
      if (mode === 'auto') {
        try { result[t].next_number = await getNextAutoNumber(db, t); } catch { result[t].next_number = null; }
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});



// POST /settings/test-email — Send test email
router.post('/settings/test-email', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const emails = await getAdminEmails(db);
    if (!emails.length) return res.status(400).json({ message: 'No admin emails configured. Add admin emails in Email Setup first.' });

    const { sendEmail } = require('../services/emailService');
    const { baseTemplate } = require('../services/emailService');

    for (const email of emails) {
      await sendEmail(db, {
        to: email,
        subject: '✅ Test Email — Workshop Manager',
        html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:20px;background:#f3f4f6">
          <div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
            <h2 style="color:#1e293b;margin:0 0 16px">✅ Email Setup Successful!</h2>
            <p style="color:#374151">Your Workshop Manager email system is working correctly.</p>
            <p style="color:#6b7280;font-size:13px;margin-top:16px">This is a test email sent from your settings page.</p>
          </div>
        </body></html>`
      });
    }
    res.json({ message: `Test email sent to ${emails.join(', ')}` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── AUDIT TRAIL ROUTES (Admin only) ──────────────────────────────────────────

// GET /audit/login-logs — Login history with filters
router.get('/audit/login-logs', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const { user_id, role, action, date_from, date_to, limit = 200 } = req.query;
    let where = ['1=1']; let params = [];
    if (user_id)   { where.push('l.user_id=?');           params.push(user_id); }
    if (role)      { where.push('l.user_role=?');          params.push(role); }
    if (action)    { where.push('l.action=?');             params.push(action); }
    if (date_from) { where.push('DATE(l.created_at)>=?');  params.push(date_from); }
    if (date_to)   { where.push('DATE(l.created_at)<=?');  params.push(date_to); }
    const [rows] = await db.query(
      `SELECT l.* FROM login_logs l WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT ?`,
      [...params, parseInt(limit)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /audit/activity-logs — All activity (create/update/delete)
router.get('/audit/activity-logs', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const { user_id, role, action_type, module_name, date_from, date_to, limit = 200 } = req.query;
    let where = ['1=1']; let params = [];
    if (user_id)     { where.push('a.user_id=?');          params.push(user_id); }
    if (role)        { where.push('a.user_role=?');         params.push(role); }
    if (action_type) { where.push('a.action_type=?');       params.push(action_type); }
    if (module_name) { where.push('a.module_name=?');       params.push(module_name); }
    if (date_from)   { where.push('DATE(a.created_at)>=?'); params.push(date_from); }
    if (date_to)     { where.push('DATE(a.created_at)<=?'); params.push(date_to); }
    const [rows] = await db.query(
      `SELECT a.* FROM audit_logs a WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ?`,
      [...params, parseInt(limit)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /audit/summary — Quick stats
router.get('/audit/summary', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [[loginToday]]    = await db.query("SELECT COUNT(*) as c FROM login_logs WHERE DATE(created_at)=CURDATE() AND action='LOGIN'");
    const [[failedToday]]   = await db.query("SELECT COUNT(*) as c FROM login_logs WHERE DATE(created_at)=CURDATE() AND action='LOGIN_FAILED'");
    const [[activityToday]] = await db.query("SELECT COUNT(*) as c FROM audit_logs WHERE DATE(created_at)=CURDATE()");
    const [activeUsers]     = await db.query(
      `SELECT user_id, user_name, user_role, MAX(created_at) as last_login
       FROM login_logs WHERE action='LOGIN' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY user_id, user_name, user_role ORDER BY last_login DESC LIMIT 10`
    );
    res.json({ logins_today: loginToday.c, failed_today: failedToday.c, activity_today: activityToday.c, recent_active_users: activeUsers });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
