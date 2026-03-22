const mysql = require('mysql2/promise');
require('dotenv').config();
let pool;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'workshop_manager',
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return pool;
}

async function initializeDatabase() {
  const tempPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true, connectionLimit: 2,
  });
  await tempPool.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'workshop_manager'}\``);
  await tempPool.end();

  const db = await getPool();

  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL,
    role ENUM('admin','worker') DEFAULT 'worker', phone VARCHAR(50),
    hourly_rate DECIMAL(10,2) DEFAULT 0, is_active TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10,2) DEFAULT 0`).catch(()=>{});

  await db.query(`CREATE TABLE IF NOT EXISTS departments (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT, color VARCHAR(20) DEFAULT '#3B82F6',
    is_active TINYINT DEFAULT 1, stage_order INT DEFAULT 999,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS worker_departments (
    id INT AUTO_INCREMENT PRIMARY KEY, worker_id INT NOT NULL, department_id INT NOT NULL,
    UNIQUE KEY unique_wd (worker_id, department_id),
    FOREIGN KEY (worker_id) REFERENCES users(id),
    FOREIGN KEY (department_id) REFERENCES departments(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS projects (
    id INT AUTO_INCREMENT PRIMARY KEY, project_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL, client_name VARCHAR(255), client_phone VARCHAR(50),
    description TEXT, status ENUM('active','completed','on_hold','cancelled','deleted') DEFAULT 'active',
    priority ENUM('low','medium','high','urgent') DEFAULT 'medium',
    order_date DATE, deadline DATE, total_amount DECIMAL(12,2) DEFAULT 0,
    notes TEXT, created_by INT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS project_items (
    id INT AUTO_INCREMENT PRIMARY KEY, project_id INT NOT NULL,
    item_name VARCHAR(255) NOT NULL, proto_code VARCHAR(100),
    description TEXT, quantity INT DEFAULT 1, unit VARCHAR(50) DEFAULT 'pcs',
    material VARCHAR(255), dimensions VARCHAR(255), unit_price DECIMAL(10,2) DEFAULT 0,
    status ENUM('pending','in_progress','completed') DEFAULT 'pending',
    notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  )`);
  await db.query(`ALTER TABLE project_items ADD COLUMN IF NOT EXISTS proto_code VARCHAR(100)`).catch(()=>{});

  // Production chain: admin defines stage order per project-item
  await db.query(`CREATE TABLE IF NOT EXISTS production_chains (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    project_item_id INT,
    department_id INT NOT NULL,
    stage_order INT NOT NULL DEFAULT 1,
    is_active TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS task_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY, project_id INT NOT NULL,
    project_item_id INT, assign_type ENUM('worker','department') DEFAULT 'worker',
    worker_id INT, department_id INT, stage_order INT DEFAULT 0,
    task_title VARCHAR(255) NOT NULL, task_description TEXT,
    quantity_assigned INT DEFAULT 1, quantity_completed INT DEFAULT 0,
    status ENUM('pending','in_progress','completed','on_hold','waiting') DEFAULT 'pending',
    priority ENUM('low','medium','high','urgent') DEFAULT 'medium',
    start_date DATE, due_date DATE, completed_date DATE,
    worker_notes TEXT, admin_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE SET NULL,
    FOREIGN KEY (worker_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
  )`);
  await db.query(`ALTER TABLE task_assignments ADD COLUMN IF NOT EXISTS stage_order INT DEFAULT 0`).catch(()=>{});
  await db.query(`ALTER TABLE task_assignments MODIFY COLUMN status ENUM('pending','in_progress','completed','on_hold','waiting') DEFAULT 'pending'`).catch(()=>{});

  // Task images
  await db.query(`CREATE TABLE IF NOT EXISTS task_images (
    id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, uploaded_by INT NOT NULL,
    image_path VARCHAR(500) NOT NULL, image_type ENUM('before','after','progress','issue') DEFAULT 'progress',
    caption TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES task_assignments(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  )`);

  // Add customer_name to projects if not exists
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`).catch(()=>{});
  
  // Add photo_id to task_assignments if not exists
  await db.query(`ALTER TABLE task_assignments ADD COLUMN IF NOT EXISTS photo_id INT`).catch(()=>{});
  await db.query(`ALTER TABLE task_assignments ADD CONSTRAINT IF NOT EXISTS fk_task_photo FOREIGN KEY (photo_id) REFERENCES task_images(id) ON DELETE SET NULL`).catch(()=>{});

  // Worker time tracking
  await db.query(`CREATE TABLE IF NOT EXISTS worker_time_logs (
    id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, worker_id INT NOT NULL,
    clock_in DATETIME NOT NULL, clock_out DATETIME,
    duration_minutes INT DEFAULT 0, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES task_assignments(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_id) REFERENCES users(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS task_progress (
    id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, updated_by INT NOT NULL,
    quantity_done INT DEFAULT 0, status VARCHAR(50), notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES task_assignments(id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by) REFERENCES users(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS task_transfers (
    id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL,
    from_worker_id INT, to_worker_id INT, transferred_by INT NOT NULL,
    reason TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES task_assignments(id) ON DELETE CASCADE,
    FOREIGN KEY (from_worker_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (to_worker_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (transferred_by) REFERENCES users(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS license_cache (
    id INT AUTO_INCREMENT PRIMARY KEY, machine_id VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(50), license_end DATETIME, days_left INT,
    last_checked DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);



  // ── APP SETTINGS ────────────────────────────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS app_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT NOT NULL,
    updated_by INT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  // Seed default settings
  const defaultSettings = [
    ['currency_symbol', '₹'],
    ['currency_name', 'INR'],
    ['date_format', 'DD/MM/YYYY'],
    ['company_name', 'Workshop Manager'],
    ['timezone', 'Asia/Kolkata'],
  ];
  for (const [k, v] of defaultSettings) {
    await db.query('INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES (?,?)', [k, v]);
  }

  // ── FEATURE 1: Daily Date-wise Progress ────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS daily_progress (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    project_item_id INT NOT NULL,
    department_id INT,
    worker_id INT,
    work_date DATE NOT NULL,
    qty_done INT DEFAULT 0,
    notes TEXT,
    created_by INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES task_assignments(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id),
    FOREIGN KEY (worker_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  // ── FEATURE 2: Material Consumption (Cutting Dept) ─────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS material_consumption (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    project_item_id INT,
    department_id INT NOT NULL,
    task_id INT,
    material_name VARCHAR(255) NOT NULL,
    consumed_qty DECIMAL(10,3) DEFAULT 0,
    unit VARCHAR(50) DEFAULT 'pcs',
    rate_per_unit DECIMAL(10,2) DEFAULT 0,
    total_amount DECIMAL(12,2) DEFAULT 0,
    material_type ENUM('consumption','wastage') DEFAULT 'consumption',
    notes TEXT,
    entered_by INT NOT NULL,
    entry_date DATE DEFAULT (CURDATE()),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE SET NULL,
    FOREIGN KEY (department_id) REFERENCES departments(id),
    FOREIGN KEY (task_id) REFERENCES task_assignments(id) ON DELETE SET NULL,
    FOREIGN KEY (entered_by) REFERENCES users(id)
  )`);

  // ── FEATURE 3: Worker Queries / Issues ─────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS worker_queries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT,
    project_id INT NOT NULL,
    project_item_id INT,
    department_id INT,
    raised_by INT NOT NULL,
    query_type ENUM('issue','material_request','clarification','other') DEFAULT 'issue',
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    priority ENUM('low','medium','high','urgent') DEFAULT 'medium',
    status ENUM('open','in_review','resolved','closed') DEFAULT 'open',
    admin_response TEXT,
    responded_by INT,
    responded_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES task_assignments(id) ON DELETE SET NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE SET NULL,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY (raised_by) REFERENCES users(id),
    FOREIGN KEY (responded_by) REFERENCES users(id) ON DELETE SET NULL
  )`);


  // ── MATERIAL PRODUCTION OUTPUT (Excel: Cutting sheet - production side) ──────
  await db.query(`CREATE TABLE IF NOT EXISTS material_production (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    project_item_id INT,
    department_id INT,
    item_name VARCHAR(255) NOT NULL,
    produced_qty DECIMAL(10,3) DEFAULT 0,
    unit VARCHAR(50) DEFAULT 'pcs',
    rate_per_unit DECIMAL(10,2) DEFAULT 0,
    total_amount DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    entered_by INT NOT NULL,
    entry_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE SET NULL,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY (entered_by) REFERENCES users(id)
  )`);

  // Seed admin
  const bcrypt = require('bcryptjs');
  const [admins] = await db.query("SELECT id FROM users WHERE username='admin'");
  if (admins.length === 0) {
    const hashed = bcrypt.hashSync('admin123', 10);
    await db.query("INSERT INTO users (name,username,password,role) VALUES ('Administrator','admin',?,'admin')", [hashed]);
  }

  // Seed departments — exact match to client Excel (VISHAL_SHAH_RESIDENCE.xlsx)
  // Sheets order: DRAWING, CNC_PYTHA, PASTING, CUTTING, EDGE_BENDING, DRILLING,
  //               CNC_WORK, LATHE, ASSEMBLING, PAINTING, METAL_GLASS_STONE, FABRICATION,
  //               QUALITY_CHECK, PACKING, DISPATCH
  const [depts] = await db.query("SELECT COUNT(*) as cnt FROM departments WHERE is_active=1");
  if (depts[0].cnt === 0) {
    const deps = [
      // [name, description, color, stage_order]
      ['Drawing',          'Design drawing & approval',      '#6366F1', 1],
      ['CNC/Pytha',        'CNC cutting & Pytha work',       '#8B5CF6', 2],
      ['Pasting',          'Sheet pasting work',             '#EC4899', 3],
      ['Cutting',          'Wood cutting & sizing',          '#EF4444', 4],
      ['Edge Bending',     'Edge banding / tapeing',         '#F97316', 5],
      ['Drilling',         'Drilling & boring work',         '#F59E0B', 6],
      ['CNC Work',         'CNC routing & carving',          '#EAB308', 7],
      ['Lathe',            'Lathe turning work',             '#84CC16', 8],
      ['Assembling',       'Assembly of all parts',          '#10B981', 9],
      ['Painting',         'Painting & polishing finish',    '#14B8A6', 10],
      ['Metal/Glass/Stone','Metal, glass & stone fitting',   '#06B6D4', 11],
      ['Fabrication',      'Fabrication work',               '#3B82F6', 12],
      ['Quality Check',    'Quality inspection & approval',  '#8B5CF6', 13],
      ['Packing',          'Packing & wrapping',             '#A855F7', 14],
      ['Dispatch',         'Final dispatch to client',       '#64748B', 15],
    ];
    for (const d of deps) {
      await db.query("INSERT IGNORE INTO departments (name,description,color,stage_order) VALUES (?,?,?,?)", d);
    }
  }

  // Safely add columns that might be missing in existing installations
  const safeAlter = async (sql) => { try { await db.query(sql); } catch(e) { /* column exists */ } };
  await safeAlter('ALTER TABLE daily_progress MODIFY COLUMN department_id INT NULL');
    await safeAlter("ALTER TABLE projects MODIFY COLUMN status ENUM('active','completed','on_hold','cancelled','deleted') DEFAULT 'active'");
  await safeAlter('ALTER TABLE task_assignments ADD COLUMN stage_order INT DEFAULT 0');
  await safeAlter("ALTER TABLE task_assignments MODIFY COLUMN status ENUM('pending','in_progress','completed','on_hold','waiting') DEFAULT 'pending'");
  await safeAlter('ALTER TABLE project_items ADD COLUMN proto_code VARCHAR(100)');
  await safeAlter('ALTER TABLE project_items ADD COLUMN current_stage_id INT DEFAULT NULL');
  await safeAlter('ALTER TABLE users ADD COLUMN hourly_rate DECIMAL(10,2) DEFAULT 0');
  await safeAlter('ALTER TABLE departments ADD COLUMN stage_order INT DEFAULT 999');

  // Packing Boxes table — manual + auto box management
  await db.query(`CREATE TABLE IF NOT EXISTS packing_boxes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    box_number VARCHAR(100) NOT NULL,
    project_id INT,
    project_item_id INT,
    photo_code VARCHAR(100) DEFAULT NULL,
    mode ENUM('auto','manual') DEFAULT 'manual',
    created_by INT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  // Packing Box Items table — items inside each box
  await db.query(`CREATE TABLE IF NOT EXISTS packing_box_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    box_id INT NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    quantity INT DEFAULT 1,
    unit VARCHAR(50) DEFAULT 'pcs',
    notes TEXT,
    FOREIGN KEY (box_id) REFERENCES packing_boxes(id) ON DELETE CASCADE
  )`);

  // Packing Box Photos
  await db.query(`CREATE TABLE IF NOT EXISTS packing_box_photos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    box_id INT NOT NULL,
    image_path VARCHAR(500) NOT NULL,
    uploaded_by INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (box_id) REFERENCES packing_boxes(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS packing_parts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_item_id INT NOT NULL,
    project_id INT NOT NULL,
    part_name VARCHAR(255) NOT NULL,
    quantity INT DEFAULT 1,
    unit VARCHAR(50) DEFAULT 'pcs',
    sort_order INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE CASCADE
  )`);

  // Packing Logs table
  await db.query(`CREATE TABLE IF NOT EXISTS packing_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    packing_part_id INT NOT NULL,
    project_item_id INT NOT NULL,
    packed_qty INT DEFAULT 0,
    packed_by INT NOT NULL,
    notes TEXT,
    packed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (packing_part_id) REFERENCES packing_parts(id) ON DELETE CASCADE,
    FOREIGN KEY (packed_by) REFERENCES users(id)
  )`);

  console.log('✅ Workshop App Database initialized');
  return db;
}

module.exports = { getPool, initializeDatabase };
