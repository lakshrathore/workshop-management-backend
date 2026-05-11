/**
 * CLIENT PORTAL ROUTES
 * ─────────────────────────────────────────────────────────────
 * Ye file sirf client role ke liye hai.
 * Existing routes/index.js mein kuch bhi change nahi hua.
 * Client sirf apne assigned projects dekh sakta hai — read only.
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'workshop_secret_2024';

// Helper: Cloudinary image URL banana
function toHttpsImageUrl(imagePath, resourceType) {
  if (!imagePath) return null;
  const p = String(imagePath).trim();
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const type = resourceType === 'raw' ? 'raw' : 'image';
  if (p.startsWith('https://res.cloudinary.com')) return p;
  if (p.startsWith('http://res.cloudinary.com')) return p.replace('http://', 'https://');
  if (p.includes('/upload/')) {
    const publicId = p.split('/upload/').pop();
    return `https://res.cloudinary.com/${cloudName}/${type}/upload/${publicId}`;
  }
  return `https://res.cloudinary.com/${cloudName}/${type}/upload/${p}`;
}

// ── Client Auth Middleware ────────────────────────────────────────────────────
function clientAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}

// Sirf client role allow karo
function clientOnly(req, res, next) {
  if (req.user.role !== 'client') return res.status(403).json({ message: 'Client access only' });
  next();
}

// Admin ya client dono allow
function adminOrClient(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'client') {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
  next();
}

// ── DATABASE SETUP ────────────────────────────────────────────────────────────
// Ye function database.js ke initializeDatabase ke baad call hoga
async function initClientTables() {
  const db = await getPool();
  
  // Users table mein client role add karo (safe - existing data nahi chheda)
  await db.query(`
    ALTER TABLE users MODIFY COLUMN role ENUM('admin','worker','client') DEFAULT 'worker'
  `).catch(() => {
    // Agar already hai ya syntax issue - ignore
  });

  // Client ke projects ka access table
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_project_access (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_id INT NOT NULL,
      project_id INT NOT NULL,
      granted_by INT NOT NULL,
      granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_client_project (client_id, project_id),
      FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id)
    )
  `).catch(() => {});

  console.log('✅ Client portal tables ready');
}




// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — Client management (admin ke liye)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/clients — Sabhi clients ki list
router.get('/clients', clientAuth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [clients] = await db.query(`
      SELECT 
        u.id, u.name, u.username, u.phone, u.is_active, u.created_at,
        COUNT(cpa.project_id) as project_count
      FROM users u
      LEFT JOIN client_project_access cpa ON cpa.client_id = u.id
      WHERE u.role = 'client'
      GROUP BY u.id
      ORDER BY u.name
    `);
    res.json(clients);
  } catch (err) {
    console.error('Get clients error:', err.message);
    res.status(500).json({ message: 'Failed to get clients' });
  }
});

// POST /api/clients — Naya client banao
router.post('/clients', clientAuth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const { name, username, password, phone } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ message: 'Name, username aur password zaroori hai' });
    }

    // Username unique check
    const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Ye username already exist karta hai' });
    }

    const hashed = bcrypt.hashSync(password, 10);
    const [result] = await db.query(
      'INSERT INTO users (name, username, password, role, phone, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [name, username, hashed, 'client', phone || null]
    );

    res.json({ id: result.insertId, message: 'Client bana diya gaya' });
  } catch (err) {
    console.error('Create client error:', err.message);
    res.status(500).json({ message: 'Client banane mein error' });
  }
});

// PUT /api/clients/:id — Client update karo
router.put('/clients/:id', clientAuth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const { name, phone, is_active, password } = req.body;
    const clientId = req.params.id;

    // Verify it's actually a client
    const [[client]] = await db.query('SELECT id FROM users WHERE id = ? AND role = ?', [clientId, 'client']);
    if (!client) return res.status(404).json({ message: 'Client nahi mila' });

    if (password) {
      const hashed = bcrypt.hashSync(password, 10);
      await db.query(
        'UPDATE users SET name=?, phone=?, is_active=?, password=? WHERE id=? AND role=?',
        [name, phone || null, is_active ? 1 : 0, hashed, clientId, 'client']
      );
    } else {
      await db.query(
        'UPDATE users SET name=?, phone=?, is_active=? WHERE id=? AND role=?',
        [name, phone || null, is_active ? 1 : 0, clientId, 'client']
      );
    }

    res.json({ message: 'Client update ho gaya' });
  } catch (err) {
    console.error('Update client error:', err.message);
    res.status(500).json({ message: 'Client update mein error' });
  }
});

// DELETE /api/clients/:id — Client delete karo
router.delete('/clients/:id', clientAuth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const clientId = req.params.id;
    const [[client]] = await db.query('SELECT id FROM users WHERE id = ? AND role = ?', [clientId, 'client']);
    if (!client) return res.status(404).json({ message: 'Client nahi mila' });

    // Access entries bhi delete hongi (CASCADE se)
    await db.query('DELETE FROM users WHERE id = ? AND role = ?', [clientId, 'client']);
    res.json({ message: 'Client delete ho gaya' });
  } catch (err) {
    console.error('Delete client error:', err.message);
    res.status(500).json({ message: 'Client delete mein error' });
  }
});

// GET /api/clients/:id/projects — Client ke assigned projects
router.get('/clients/:id/projects', clientAuth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [projects] = await db.query(`
      SELECT p.id, p.project_id, p.name, p.client_name, p.status, p.deadline, p.priority,
             cpa.granted_at
      FROM client_project_access cpa
      JOIN projects p ON p.id = cpa.project_id
      WHERE cpa.client_id = ?
      ORDER BY p.created_at DESC
    `, [req.params.id]);
    res.json(projects);
  } catch (err) {
    console.error('Get client projects error:', err.message);
    res.status(500).json({ message: 'Projects laane mein error' });
  }
});

// POST /api/clients/:id/projects — Client ko project access do
router.post('/clients/:id/projects', clientAuth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    const { project_id } = req.body;
    const clientId = req.params.id;

    if (!project_id) return res.status(400).json({ message: 'project_id zaroori hai' });

    // Verify client exists
    const [[client]] = await db.query('SELECT id FROM users WHERE id = ? AND role = ?', [clientId, 'client']);
    if (!client) return res.status(404).json({ message: 'Client nahi mila' });

    // Verify project exists
    const [[project]] = await db.query('SELECT id FROM projects WHERE id = ?', [project_id]);
    if (!project) return res.status(404).json({ message: 'Project nahi mila' });

    await db.query(
      'INSERT IGNORE INTO client_project_access (client_id, project_id, granted_by) VALUES (?, ?, ?)',
      [clientId, project_id, req.user.id]
    );

    res.json({ message: 'Project access de diya gaya' });
  } catch (err) {
    console.error('Assign project error:', err.message);
    res.status(500).json({ message: 'Project assign karne mein error' });
  }
});

// DELETE /api/clients/:id/projects/:projectId — Project access hatao
router.delete('/clients/:id/projects/:projectId', clientAuth, adminOnly, async (req, res) => {
  const db = await getPool();
  try {
    await db.query(
      'DELETE FROM client_project_access WHERE client_id = ? AND project_id = ?',
      [req.params.id, req.params.projectId]
    );
    res.json({ message: 'Project access hata diya gaya' });
  } catch (err) {
    console.error('Remove project access error:', err.message);
    res.status(500).json({ message: 'Access hatane mein error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT PORTAL ROUTES — Client ke liye (sirf apne projects)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/client/projects — Client ke assigned projects ki list
router.get('/client/projects', clientAuth, clientOnly, async (req, res) => {
  const db = await getPool();
  try {
    const [projects] = await db.query(`
      SELECT 
        p.id, p.project_id, p.name, p.client_name, p.status, p.priority,
        p.order_date, p.deadline, p.description,
        (SELECT COUNT(id) FROM project_items WHERE project_id = p.id) as item_count,
        (SELECT COUNT(id) FROM task_assignments WHERE project_id = p.id) as task_count,
        (SELECT COUNT(id) FROM task_assignments WHERE project_id = p.id AND status = 'completed') as completed_tasks,
        (SELECT image_path FROM project_mo_references WHERE project_id = p.id ORDER BY created_at ASC LIMIT 1) as thumbnail_path,
        (SELECT resource_type FROM project_mo_references WHERE project_id = p.id ORDER BY created_at ASC LIMIT 1) as thumbnail_type
      FROM client_project_access cpa
      JOIN projects p ON p.id = cpa.project_id
      WHERE cpa.client_id = ?
        AND p.status != 'deleted'
        AND p.is_ready = 1
      ORDER BY p.created_at DESC
    `, [req.user.id]);

    res.json(projects.map(p => ({
      ...p,
      thumbnail_url: p.thumbnail_path ? toHttpsImageUrl(p.thumbnail_path, p.thumbnail_type || 'image') : null
    })));
  } catch (err) {
    console.error('Client get projects error:', err.message);
    res.status(500).json({ message: 'Projects laane mein error' });
  }
});

// GET /api/client/projects/:id — Client ke project ki detail (stage tracker)
router.get('/client/projects/:id', clientAuth, clientOnly, async (req, res) => {
  const db = await getPool();
  try {
    const projectId = req.params.id;

    // SECURITY: Check karo ki ye project is client ke liye assigned hai
    const [[access]] = await db.query(
      'SELECT id FROM client_project_access WHERE client_id = ? AND project_id = ?',
      [req.user.id, projectId]
    );
    if (!access) {
      return res.status(403).json({ message: 'Is project ka access nahi hai' });
    }

    // Project basic info
    const [[project]] = await db.query(
      'SELECT id, project_id, name, client_name, status, priority, order_date, deadline, description, notes FROM projects WHERE id = ?',
      [projectId]
    );
    if (!project) return res.status(404).json({ message: 'Project nahi mila' });

    // Project items
    const [items] = await db.query(
      'SELECT id, item_name, proto_code, description, quantity, unit, material, dimensions, status FROM project_items WHERE project_id = ? ORDER BY id',
      [projectId]
    );

    // Tasks — worker name nahi dikhana client ko, sirf department + progress
    const [tasks] = await db.query(`
      SELECT 
        ta.id, ta.project_item_id, ta.department_id, ta.stage_order,
        ta.task_title, ta.quantity_assigned, ta.quantity_completed,
        ta.status, ta.start_date, ta.due_date, ta.completed_date,
        d.name as department_name, d.color as dept_color,
        pi.item_name
      FROM task_assignments ta
      LEFT JOIN departments d ON d.id = ta.department_id
      LEFT JOIN project_items pi ON pi.id = ta.project_item_id
      WHERE ta.project_id = ?
      ORDER BY ta.stage_order, ta.created_at
    `, [projectId]);

    // Production chains (stage order)
    const [chains] = await db.query(`
      SELECT pc.id, pc.project_item_id, pc.department_id, pc.stage_order,
             d.name as dept_name, d.color as dept_color
      FROM production_chains pc
      JOIN departments d ON d.id = pc.department_id
      WHERE pc.project_id = ?
      ORDER BY pc.project_item_id, pc.stage_order
    `, [projectId]);

    // Images — task images grouped by item + stage
    const [allImages] = await db.query(`
      SELECT ti.id, ti.image_path, ti.image_type, ti.caption, ti.created_at,
             ta.project_item_id, ta.department_id, ta.stage_order
      FROM task_images ti
      JOIN task_assignments ta ON ta.id = ti.task_id
      WHERE ta.project_id = ?
      ORDER BY ta.project_item_id, ta.stage_order, ti.created_at DESC
    `, [projectId]);

    // Group images: { "itemId_stageOrder_deptId": [images...] }
    const imageMap = {};
    allImages.forEach(img => {
      const key = `${img.project_item_id}_${img.stage_order}_${img.department_id}`;
      if (!imageMap[key]) imageMap[key] = [];
      imageMap[key].push({
        id: img.id,
        image_url: toHttpsImageUrl(img.image_path),
        caption: img.caption,
        created_at: img.created_at
      });
    });

    res.json({ project, items, tasks, chains, imageMap });
  } catch (err) {
    console.error('Client project detail error:', err.message);
    res.status(500).json({ message: 'Project detail laane mein error' });
  }
});

// Attach initClientTables to router so both are accessible from same require()
router.initClientTables = initClientTables;

module.exports = router;
