const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'workshop_secret_2024';

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
const { imgUpload, galleryUpload, getFileUrl, deleteFile } = require('../services/cloudinaryStorage');

// Serve images — redirect to Cloudinary CDN
// Path format stored in DB: "workshop/task-images/filename.jpg" (full Cloudinary public_id)
router.get('/uploads/*', (req, res) => {
  const publicId = req.params[0]; // Captures everything after /uploads/
  if (!publicId) {
    return res.status(400).json({ message: 'No image path provided' });
  }
  console.log(`🔗 Redirecting image request: /uploads/${publicId}`);
  const cloudinaryUrl = getFileUrl(publicId);
  console.log(`➡️ Cloudinary URL: ${cloudinaryUrl}`);
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
router.post('/auth/login', async (req, res) => {
  const db = await getPool();
  const { username, password } = req.body;
  const [[user]] = await db.query('SELECT * FROM users WHERE username=? AND is_active=1', [username]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ message: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
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
      SUM(ta.status='in_progress') as active_tasks
    FROM departments d
    LEFT JOIN worker_departments wd ON wd.department_id=d.id
    LEFT JOIN task_assignments ta ON ta.department_id=d.id
    ${whereClause} GROUP BY d.id ORDER BY COALESCE(d.stage_order,999), d.name`);
  res.json(rows);
});
router.post('/departments', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { name, description, color } = req.body;
  const [r] = await db.query('INSERT INTO departments (name,description,color) VALUES (?,?,?)', [name, description, color || '#3B82F6']);
  res.json({ id: r.insertId, name, description, color });
});
router.put('/departments/:id', auth, adminOnly, async (req, res) => {
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
router.post('/workers', auth, adminOnly, async (req, res) => {
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
router.put('/workers/:id', auth, adminOnly, async (req, res) => {
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
router.delete('/workers/:id', auth, adminOnly, async (req, res) => {
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
  const { status, search } = req.query;
  let where = "WHERE p.status != 'deleted'";
  const params = [];
  if (status && status !== 'all') {
    where = 'WHERE p.status=?';
    params.push(status);
  }
  if (search) {
    where += (where.includes('WHERE') ? ' AND' : ' WHERE') + ' (p.name LIKE ? OR p.client_name LIKE ? OR p.project_id LIKE ?)';
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
        (SELECT COUNT(id) FROM task_assignments WHERE project_id=p.id AND status='delayed') as delayed_tasks
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
    
    res.json(rows);
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});
router.post('/projects', auth, adminOnly, async (req, res) => {
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
    const [r] = await db.query('INSERT INTO projects (project_id,name,client_name,client_phone,description,priority,order_date,deadline,total_amount,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [finalProjectId, name, client_name, client_phone, description, priority || 'medium', order_date || null, deadline || null, total_amount || 0, notes, req.user.id]);
    res.json({ id: r.insertId, project_id: finalProjectId });
  } catch(err) {
    console.error('Create project error:', err.message);
    res.status(500).json({ message: err.message });
  }
});
router.put('/projects/:id', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { name, client_name, client_phone, description, status, priority, order_date, deadline, total_amount, notes } = req.body;
  await db.query('UPDATE projects SET name=?,client_name=?,client_phone=?,description=?,status=?,priority=?,order_date=?,deadline=?,total_amount=?,notes=? WHERE id=?',
    [name, client_name, client_phone, description, status, priority, order_date, deadline, total_amount, notes, req.params.id]);
  res.json({ message: 'Updated' });
});
router.delete('/projects/:id', auth, adminOnly, async (req, res) => {
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
  const [items] = await db.query('SELECT * FROM project_items WHERE project_id=? ORDER BY id', [req.params.id]);
  const [tasks] = await db.query(`
    SELECT ta.*, u.name as worker_name, d.name as department_name, d.color as dept_color,
      pi.item_name, COALESCE(pi.proto_code,'') as proto_code
    FROM task_assignments ta
    LEFT JOIN users u ON u.id=ta.worker_id
    LEFT JOIN departments d ON d.id=ta.department_id
    LEFT JOIN project_items pi ON pi.id=ta.project_item_id
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
    const [chains] = await db.query(`
      SELECT pc.*, d.name as dept_name, d.color as dept_color
      FROM production_chains pc
      JOIN departments d ON d.id=pc.department_id
      WHERE pc.project_id=? ORDER BY pc.stage_order`, [req.params.id]);
    
    const result = [];
    for (const chain of chains) {
      // Get all tasks for this stage and their images
      const [images] = await db.query(`
        SELECT ti.*, u.name as uploaded_by_name, ta.task_title
        FROM task_images ti
        JOIN task_assignments ta ON ta.id=ti.task_id
        JOIN users u ON u.id=ti.uploaded_by
        WHERE ta.project_id=? AND ta.department_id=? AND ta.stage_order=?
        ORDER BY ti.created_at DESC`, [req.params.id, chain.department_id, chain.stage_order]);
      
      result.push({
        stage_order: chain.stage_order,
        dept_name: chain.dept_name,
        dept_color: chain.dept_color,
        images: images
      });
    }
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
    const status = i === 0 ? 'pending' : 'waiting'; // First stage active, rest waiting
    await db.query(`INSERT INTO task_assignments 
      (project_id, project_item_id, assign_type, department_id, stage_order, task_title, quantity_assigned, status)
      VALUES (?,?,?,?,?,?,?,?)`,
      [project_id, item.id, 'department', s.department_id, s.stage_order,
        `${item.item_name} — ${dept.name}`, item.quantity, status]);
  }
}

// When a chain task completes → auto-advance to next stage
async function autoAdvanceChain(db, task_id) {
  const [[task]] = await db.query('SELECT * FROM task_assignments WHERE id=?', [task_id]);
  if (!task || !task.project_item_id) return;

  // If partially completed → transfer done qty to next stage
  if (task.quantity_completed > 0 && task.quantity_completed < task.quantity_assigned) {
    await transferPartialQuantityToNextStage(db, task);
  }

  // If task is marked as completed → check and activate next waiting stage
  if (task.status === 'completed') {
    await checkAndActivateNextStage(db, task);
  }
}

// Transfer completed quantity to next stage in production chain
async function transferPartialQuantityToNextStage(db, currentTask) {
  if (!currentTask.project_item_id || !currentTask.stage_order) return;

  // Find next stage in production chain
  const [[nextStage]] = await db.query(`
    SELECT * FROM production_chains 
    WHERE project_item_id=? AND stage_order>?
    ORDER BY stage_order LIMIT 1`,
    [currentTask.project_item_id, currentTask.stage_order]);

  if (!nextStage) return; // No next stage

  const completedQty = currentTask.quantity_completed;

  // Check if next stage task already exists for this item
  const [[existingNextTask]] = await db.query(`
    SELECT * FROM task_assignments 
    WHERE project_item_id=? AND department_id=? AND stage_order=?`,
    [currentTask.project_item_id, nextStage.department_id, nextStage.stage_order]);

  if (existingNextTask) {
    // Add to existing next stage task
    const newQty = parseInt(existingNextTask.quantity_assigned, 10) + completedQty;
    await db.query(
      'UPDATE task_assignments SET quantity_assigned=? WHERE id=?',
      [newQty, existingNextTask.id]
    );
  } else {
    // Create new task for next stage with completed quantity
    const [[dept]] = await db.query('SELECT * FROM departments WHERE id=?', [nextStage.department_id]);
    const taskTitle = `${currentTask.task_title.split('—')[0].trim()} — ${dept.name}`;
    
    await db.query(`
      INSERT INTO task_assignments 
      (project_id, project_item_id, assign_type, department_id, stage_order,
       task_title, task_description, quantity_assigned, status, priority)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [currentTask.project_id, currentTask.project_item_id, 'department', nextStage.department_id,
       nextStage.stage_order, taskTitle, currentTask.task_description,
       completedQty, 'waiting', currentTask.priority]);
  }

  // Record the transfer
  await db.query(`
    INSERT INTO task_progress (task_id, updated_by, quantity_done, status, notes)
    VALUES (?,?,?,?,?)`,
    [currentTask.id, 1, completedQty, 'partial_transferred', 
     `${completedQty} units transferred to next stage (${nextStage.stage_order})`]);
}

// ── TASKS ─────────────────────────────────────────────────────────────────────
router.get('/tasks/all', auth, adminOnly, async (req, res) => {
  const db = await getPool();
  const { status, department_id, worker_id } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (status) { where += ' AND ta.status=?'; params.push(status); }
  if (department_id) { where += ' AND ta.department_id=?'; params.push(department_id); }
  if (worker_id) { where += ' AND ta.worker_id=?'; params.push(worker_id); }
  try {
    const [rows] = await db.query(`
      SELECT ta.*, u.name as worker_name, d.name as department_name, d.color as dept_color,
        p.name as project_name, p.project_id as proj_code, p.client_name as customer_name,
        pi.item_name, COALESCE(pi.proto_code,'') as proto_code
      FROM task_assignments ta
      LEFT JOIN users u ON u.id=ta.worker_id
      LEFT JOIN departments d ON d.id=ta.department_id
      LEFT JOIN projects p ON p.id=ta.project_id
      LEFT JOIN project_items pi ON pi.id=ta.project_item_id
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

router.post('/tasks', auth, adminOnly, async (req, res) => {
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

router.put('/tasks/:id', auth, adminOnly, async (req, res) => {
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

router.delete('/tasks/:id', auth, adminOnly, async (req, res) => {
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

// Helper: Check and activate next waiting stage when current stage is fully completed
async function checkAndActivateNextStage(db, task) {
  // Find next waiting stage task for same item
  const [[nextTask]] = await db.query(`
    SELECT * FROM task_assignments 
    WHERE project_item_id=? AND stage_order>? AND status='waiting'
    ORDER BY stage_order LIMIT 1`,
    [task.project_item_id, task.stage_order]);

  if (nextTask) {
    console.log(`Activating next stage task ${nextTask.id} - was waiting, now pending`);
    await db.query("UPDATE task_assignments SET status='pending' WHERE id=?", [nextTask.id]);
  }

  // Check if all stages done for this item → mark item complete
  const [[waiting]] = await db.query(`
    SELECT COUNT(*) as cnt FROM task_assignments 
    WHERE project_item_id=? AND status != 'completed'`, [task.project_item_id]);
  if (waiting.cnt === 0) {
    console.log(`All stages completed for item ${task.project_item_id}`);
    await db.query("UPDATE project_items SET status='completed' WHERE id=?", [task.project_item_id]);
  }
}

// Helper: Get previous stage's completed quantity for stage dependency validation
async function getPreviousStageQuantity(db, projectItemId, currentStageOrder) {
  if (currentStageOrder <= 1) return null; // First stage has no dependency
  
  const [[prev]] = await db.query(`
    SELECT ta.quantity_completed
    FROM task_assignments ta
    WHERE ta.project_item_id=? AND ta.stage_order=?
    LIMIT 1`, [projectItemId, currentStageOrder - 1]);
  
  return prev ? prev.quantity_completed : null;
}

// Worker progress update
router.patch('/tasks/:id/progress', auth, async (req, res) => {
  const db = await getPool();
  const { quantity_completed, status, worker_notes } = req.body;
  const [[task]] = await db.query('SELECT * FROM task_assignments WHERE id=?', [req.params.id]);
  if (!task) return res.status(404).json({ message: 'Not found' });
  const newQty = quantity_completed !== undefined ? parseInt(quantity_completed, 10) : task.quantity_completed;
  const assignedQty = parseInt(task.quantity_assigned, 10);
  let newStatus = status || task.status;
  
  // Stage dependency validation: check previous stage's completed quantity
  if (task.stage_order > 1 && newQty > task.quantity_completed) {
    const prevStageQty = await getPreviousStageQuantity(db, task.project_item_id, task.stage_order);
    if (prevStageQty !== null && newQty > prevStageQty) {
      return res.status(400).json({ 
        message: `Pehle stage mein sirf ${prevStageQty} quantity complete hue hain, isliye aap ${newQty} nahi kar sakte. Max ${prevStageQty} hi set kar sakte ho.`,
        max_allowed: prevStageQty,
        previous_stage_completed: prevStageQty
      });
    }
  }

  // Revert case: admin sets qty=0 and status=pending
  if (newQty === 0 && status === 'pending') {
    newStatus = 'pending';
  } else if (newQty >= assignedQty) {
    newStatus = 'completed';
  } else if (newQty > 0 && newStatus === 'pending') {
    newStatus = 'in_progress';
  } else if (newQty < assignedQty && newStatus === 'completed') {
    newStatus = 'in_progress';
  }

  const completedDate = newStatus === 'completed' ? new Date().toISOString().split('T')[0] : null;
  await db.query('UPDATE task_assignments SET quantity_completed=?,status=?,worker_notes=?,completed_date=? WHERE id=?',
    [newQty, newStatus, worker_notes !== undefined ? worker_notes : task.worker_notes, completedDate, req.params.id]);
  await db.query('INSERT INTO task_progress (task_id,updated_by,quantity_done,status,notes) VALUES (?,?,?,?,?)',
    [req.params.id, req.user.id, newQty, newStatus, worker_notes || '']);
  
  // Auto-advance chain (handles both partial and full completion)
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
    for (const f of files) {
      console.log(`✅ Saving image: path=${f.path}, publicId=${f.public_id}, filename=${f.filename}`);
      // Extract just the public_id from Cloudinary response
      // f.path might be full URL, f.public_id is the clean public_id
      const publicId = f.public_id || (f.path ? f.path.replace(/^https?:\/\/[^\/]+\/v\d+\//, '') : '');
      
      if (publicId) {
        // Store only the public_id (e.g., "workshop/task-images/abc123")
        // Redirect route will use this to generate full Cloudinary URL
        console.log(`💾 Storing public_id: ${publicId}`);
        await db.query('INSERT INTO task_images (task_id,uploaded_by,image_path,image_type,caption) VALUES (?,?,?,?,?)',
          [req.params.id, req.user.id, publicId, image_type || 'progress', caption || '']);
      } else {
        console.warn(`⚠️ Could not extract public_id from:`, { path: f.path, public_id: f.public_id, filename: f.filename });
      }
    }

    res.json({ 
      message: `${files.length} image(s) upload ho gaye`, 
      count: files.length,
      success: true 
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
  res.json(rows);
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
      grouped[img.uploaded_by_name].push(img);
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
  const [r] = await db.query('INSERT INTO worker_time_logs (task_id,worker_id,clock_in) VALUES (?,?,NOW())', [req.params.id, req.user.id]);
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
      SUM(status='active') as active, SUM(status='completed') as completed,
      SUM(status='deleted') as deleted_count
      FROM projects`);
    const [[workerStats]] = await db.query(`SELECT COUNT(*) as total FROM users WHERE role='worker' AND is_active=1`);

    // Recent active projects with pipeline summary
    const [recentProjects] = await db.query(`
      SELECT p.id, p.project_id, p.name, p.client_name, p.status, p.deadline, p.priority,
        COUNT(DISTINCT pi.id) as item_count,
        COUNT(DISTINCT ta.id) as task_count,
        SUM(ta.status='completed') as done_tasks,
        SUM(ta.status='in_progress') as active_tasks
      FROM projects p
      LEFT JOIN project_items pi ON pi.project_id=p.id
      LEFT JOIN task_assignments ta ON ta.project_id=p.id
      WHERE p.status NOT IN ('deleted','cancelled')
      GROUP BY p.id ORDER BY p.created_at DESC LIMIT 8`);

    // Delayed tasks
    const [delayedTasks] = await db.query(`
      SELECT ta.id, ta.task_title, ta.due_date, ta.status,
        p.name as project_name, p.project_id as proj_code,
        u.name as worker_name, d.name as dept_name
      FROM task_assignments ta
      JOIN projects p ON p.id=ta.project_id
      LEFT JOIN users u ON u.id=ta.worker_id
      LEFT JOIN departments d ON d.id=ta.department_id
      WHERE ta.status NOT IN ('completed','cancelled','waiting')
        AND ta.due_date IS NOT NULL AND ta.due_date < CURDATE()
      ORDER BY ta.due_date ASC LIMIT 10`);

    // Excel-style pipeline: active products + their department stage status
    const [pipelineItems] = await db.query(`
      SELECT pi.id, pi.item_name, pi.proto_code, pi.quantity,
        p.name as project_name, p.project_id as proj_code, p.client_name,
        COUNT(ta.id) as total_stages,
        SUM(ta.status='completed') as completed_stages,
        SUM(ta.status='in_progress') as active_stages
      FROM project_items pi
      JOIN projects p ON p.id=pi.project_id
      LEFT JOIN task_assignments ta ON ta.project_item_id=pi.id
      WHERE p.status='active'
      GROUP BY pi.id ORDER BY p.created_at DESC, pi.id LIMIT 20`);

    // For pipeline: get dept-wise status per item
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
      if (!t.dept_name) continue; // skip tasks without department
      if (!deptMap[t.project_item_id]) deptMap[t.project_item_id] = [];
      deptMap[t.project_item_id].push(t);
    }

    const pipeline = pipelineItems.map(item => ({
      ...item,
      departments: deptMap[item.id] || []
    }));

    res.json({ tasks: taskStats, projects: projStats, workers: workerStats, recentProjects, delayedTasks, pipeline });
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
    // Use item-specific chain if exists, otherwise use project-level chain
    const chain = chainsByItem[item.id] || projectChains[item.project_id] || [];
    const itemTasks = tasksByItem[item.id] || [];
    const stages = chain.map(c => {
      const t = itemTasks.find(t => t.department_id === c.department_id);
      const pct = t ? Math.round((t.quantity_completed / t.quantity_assigned) * 100) : 0;
      return { ...c, task: t || null, pct, status: t ? t.status : 'not_assigned' };
    });
    const totalStages = stages.length;
    const doneStages = stages.filter(s => s.status === 'completed').length;
    const overallPct = totalStages > 0 ? Math.round((doneStages / totalStages) * 100) : 0;
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
      ta.task_title,p.name as project_name,p.client_name,p.project_id as proj_code,
      ROUND(tl.duration_minutes/60*u.hourly_rate,2) as earnings
    FROM worker_time_logs tl
    JOIN users u ON u.id=tl.worker_id
    JOIN task_assignments ta ON ta.id=tl.task_id
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

    if (newStatus === 'completed' && t.status !== 'completed') {
      await autoAdvanceChain(db, t.project_item_id, t.stage_order || 0);
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

router.post('/materials', auth, async (req, res) => {
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

router.put('/materials/:id', auth, async (req, res) => {
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

router.delete('/materials/:id', auth, adminOnly, async (req, res) => {
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
    res.json(rows);
  } catch(err) {
    console.error('queries error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

router.post('/queries', auth, async (req, res) => {
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
router.patch('/queries/:id/respond', auth, adminOnly, async (req, res) => {
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

router.patch('/queries/:id/status', auth, adminOnly, async (req, res) => {
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

router.put('/settings', auth, adminOnly, async (req, res) => {
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
router.delete('/departments/:id', auth, adminOnly, async (req, res) => {
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

module.exports = router;
