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
  if (process.env.DB_CREATE_DATABASE !== 'false') {
    const tempPool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      waitForConnections: true, connectionLimit: 2,
    });
    await tempPool.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'workshop_manager'}\``);
    await tempPool.end();
  }

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
    description TEXT, status ENUM('active','inactive','completed','on_hold','cancelled','deleted') DEFAULT 'active',
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
    ['company_name', 'MOZI INNOVATORS LLP'],
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

  await db.query(`CREATE TABLE IF NOT EXISTS worker_query_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    query_id INT NOT NULL,
    project_id INT NOT NULL,
    uploaded_by INT NULL,
    image_path VARCHAR(500) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (query_id) REFERENCES worker_queries(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
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

  // Safely execute ALTER TABLE statement without crashing startup
  const safeAlter = async (sql) => { try { await db.query(sql); } catch(e) { /* table/column might already exist or unsupported syntax */ } };

  // Ensure column exists in older MySQL / MariaDB versions that might not support ADD COLUMN IF NOT EXISTS
  const ensureColumn = async (table, column, definition) => {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );

    if (!rows || rows.length === 0) {
      // Another instance starting at the same moment may add it first — that's fine
      await db.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
        .catch(err => { if (err.code !== 'ER_DUP_FIELDNAME') throw err; });
    }
  };

  await safeAlter('ALTER TABLE daily_progress MODIFY COLUMN department_id INT NULL');
  await safeAlter("ALTER TABLE projects MODIFY COLUMN status ENUM('active','inactive','completed','on_hold','cancelled','deleted') DEFAULT 'active'");
  await safeAlter('ALTER TABLE task_assignments ADD COLUMN stage_order INT DEFAULT 0');
  await safeAlter("ALTER TABLE task_assignments MODIFY COLUMN status ENUM('pending','in_progress','completed','on_hold','waiting') DEFAULT 'pending'");
  await safeAlter('ALTER TABLE project_items ADD COLUMN proto_code VARCHAR(100)');
  await safeAlter('ALTER TABLE worker_query_images MODIFY COLUMN uploaded_by INT NULL');
  await safeAlter('ALTER TABLE project_item_images MODIFY COLUMN uploaded_by INT NULL');
  await safeAlter('ALTER TABLE project_mo_references MODIFY COLUMN uploaded_by INT NULL');
  await safeAlter('ALTER TABLE project_items ADD COLUMN current_stage_id INT DEFAULT NULL');
  await safeAlter('ALTER TABLE users ADD COLUMN hourly_rate DECIMAL(10,2) DEFAULT 0');
  // Notifications table
  await db.query(`CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    is_read TINYINT DEFAULT 0,
    task_id INT DEFAULT NULL,
    project_id INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // Project Item Reference Images
  await db.query(`CREATE TABLE IF NOT EXISTS project_item_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_item_id INT NOT NULL,
    project_id INT NOT NULL,
    image_path VARCHAR(500) NOT NULL,
    caption VARCHAR(255) DEFAULT '',
    uploaded_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  )`);

  // Admin MO Reference images for projects
  await db.query(`CREATE TABLE IF NOT EXISTS project_mo_references (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    uploaded_by INT NULL,
    image_path VARCHAR(500) NOT NULL,
    resource_type ENUM('image','raw') DEFAULT 'image',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  
  // Ensure resource_type column exists (for existing tables that might not have it)
  await safeAlter('ALTER TABLE project_mo_references ADD COLUMN IF NOT EXISTS resource_type ENUM(\'image\',\'raw\') DEFAULT \'image\'');
  await ensureColumn('project_mo_references', 'resource_type', "resource_type ENUM('image','raw') DEFAULT 'image'");
  await safeAlter('ALTER TABLE project_mo_references MODIFY COLUMN resource_type ENUM(\'image\',\'raw\') DEFAULT \'image\'');

  // Push Subscriptions table
  await db.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint TEXT NOT NULL,
    subscription TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await safeAlter('ALTER TABLE packing_boxes ADD COLUMN photo_code VARCHAR(100) DEFAULT NULL');
  await safeAlter('ALTER TABLE packing_boxes ADD COLUMN main_item VARCHAR(255) DEFAULT NULL');
  await safeAlter('ALTER TABLE departments ADD COLUMN stage_order INT DEFAULT 999');
  // is_ready flag — project start hone ke liye ready hai ya nahi
  await safeAlter('ALTER TABLE projects ADD COLUMN is_ready TINYINT(1) DEFAULT 0');
  await safeAlter("ALTER TABLE projects ADD COLUMN protocol_code VARCHAR(255) DEFAULT NULL");
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN send_type VARCHAR(10) DEFAULT 'system' COMMENT 'system or pdf'");
  // Sub-box label support: BOX-01 (A), BOX-01 (B) etc.
  await safeAlter("ALTER TABLE packing_boxes ADD COLUMN sub_label VARCHAR(10) DEFAULT NULL COMMENT 'A, B, C etc for sub-boxes'");
  // Box-level description shown on the printed packing label (independent of the linked project_item)
  await safeAlter("ALTER TABLE packing_boxes ADD COLUMN description VARCHAR(500) DEFAULT NULL");
  // Number of label copies / sub-boxes (A, B, C…) — used by both print and export
  await safeAlter("ALTER TABLE packing_boxes ADD COLUMN copies INT DEFAULT 1");
  await safeAlter("ALTER TABLE project_item_images ADD COLUMN resource_type VARCHAR(20) DEFAULT 'image'");

  // ── NEW COLUMNS: Client Purchase Orders — item/tax/project fields ──────────
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN item_name VARCHAR(255) DEFAULT ''");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN quantity DECIMAL(10,3) DEFAULT NULL");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN taxable_value DECIMAL(12,2) DEFAULT NULL");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT NULL");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN cgst DECIMAL(12,2) DEFAULT NULL");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN sgst DECIMAL(12,2) DEFAULT NULL");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN igst DECIMAL(12,2) DEFAULT NULL");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN project_name VARCHAR(255) DEFAULT ''");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN linked_project_id INT DEFAULT NULL");
  await safeAlter("ALTER TABLE client_purchase_orders ADD COLUMN items_json LONGTEXT DEFAULT NULL");
  // Expand status ENUM to include payment_pending + advance_pending for existing DBs
  await safeAlter("ALTER TABLE client_purchase_orders MODIFY COLUMN status ENUM('pending','acknowledged','processing','payment_pending','advance_pending','completed','cancelled') DEFAULT 'pending'");

  // ── NEW COLUMNS: Sale Challans — client portal send + pdf + gst split ──────
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN sent_to_client TINYINT(1) DEFAULT 0");
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN sent_client_id INT DEFAULT NULL");
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN sent_at DATETIME DEFAULT NULL");
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN pdf_url VARCHAR(500) DEFAULT NULL");
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN cgst DECIMAL(12,2) DEFAULT NULL");
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN sgst DECIMAL(12,2) DEFAULT NULL");
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN igst DECIMAL(12,2) DEFAULT NULL");
  await safeAlter("ALTER TABLE sale_challans MODIFY COLUMN challan_type ENUM('sale','delivery','proforma') DEFAULT 'delivery'");
  // Per-item tax rate for sale challan items
  await safeAlter("ALTER TABLE sale_challan_items ADD COLUMN tax_rate DECIMAL(5,2) DEFAULT 0");
  // Extend users role ENUM to include client
  await safeAlter("ALTER TABLE users MODIFY COLUMN role ENUM('admin','worker','client') DEFAULT 'worker'");
  // Link sale_challans back to a client purchase order (for fulfillment tracking)
  await safeAlter("ALTER TABLE sale_challans ADD COLUMN cpo_id INT DEFAULT NULL");

  // ── FIX: project_items mein created_by column add karo (GET /projects/:id JOIN ke liye) ──
  await safeAlter('ALTER TABLE project_items ADD COLUMN created_by INT DEFAULT NULL');

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

  // ── PURCHASE ORDERS ────────────────────────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    po_number VARCHAR(50) UNIQUE NOT NULL,
    supplier_name VARCHAR(255) NOT NULL,
    supplier_phone VARCHAR(50),
    supplier_address TEXT,
    supplier_gstin VARCHAR(20),
    project_id INT,
    order_date DATE NOT NULL,
    expected_delivery DATE,
    status ENUM('draft','ordered','partial','received','cancelled') DEFAULT 'draft',
    subtotal DECIMAL(12,2) DEFAULT 0,
    tax_percent DECIMAL(5,2) DEFAULT 0,
    tax_amount DECIMAL(12,2) DEFAULT 0,
    discount_amount DECIMAL(12,2) DEFAULT 0,
    total_amount DECIMAL(12,2) DEFAULT 0,
    notes TEXT,
    created_by INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    po_id INT NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    description TEXT,
    quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
    unit VARCHAR(50) DEFAULT 'pcs',
    rate DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(12,2) DEFAULT 0,
    received_qty DECIMAL(10,3) DEFAULT 0,
    sort_order INT DEFAULT 0,
    FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
  )`);

  // ── SALE CHALLANS ──────────────────────────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS sale_challans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    challan_number VARCHAR(50) UNIQUE NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    client_phone VARCHAR(50),
    client_address TEXT,
    client_gstin VARCHAR(20),
    project_id INT,
    challan_date DATE NOT NULL,
    delivery_date DATE,
    status ENUM('draft','sent','delivered','cancelled') DEFAULT 'draft',
    challan_type ENUM('sale','delivery','proforma') DEFAULT 'delivery',
    subtotal DECIMAL(12,2) DEFAULT 0,
    tax_percent DECIMAL(5,2) DEFAULT 0,
    tax_amount DECIMAL(12,2) DEFAULT 0,
    discount_amount DECIMAL(12,2) DEFAULT 0,
    total_amount DECIMAL(12,2) DEFAULT 0,
    transport_name VARCHAR(255),
    vehicle_number VARCHAR(50),
    notes TEXT,
    created_by INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS sale_challan_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    challan_id INT NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    description TEXT,
    quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
    unit VARCHAR(50) DEFAULT 'pcs',
    rate DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(12,2) DEFAULT 0,
    sort_order INT DEFAULT 0,
    FOREIGN KEY (challan_id) REFERENCES sale_challans(id) ON DELETE CASCADE
  )`);

  // Vehicle length (e.g. "17 ft") next to the vehicle number on a challan
  await ensureColumn('sale_challans', 'vehicle_length', 'vehicle_length VARCHAR(50) NULL');

  // ── Sale Challan ↔ Packing link ────────────────────────────────────────────
  // Proto Code + source project item on each challan line
  await ensureColumn('sale_challan_items', 'proto_code', 'proto_code VARCHAR(100) NULL');
  await ensureColumn('sale_challan_items', 'project_item_id', 'project_item_id INT NULL');
  // Packing boxes ticked for this line in the Box Details popup: JSON [{id, box_number}]
  await ensureColumn('sale_challan_items', 'ticked_boxes', 'ticked_boxes TEXT NULL');
  // A packing box can be created from a challan; each content line can point at a challan line
  await ensureColumn('packing_boxes', 'sale_challan_id', 'sale_challan_id INT NULL');
  await ensureColumn('packing_boxes', 'request_key', 'request_key VARCHAR(64) NULL');
  await ensureColumn('packing_box_items', 'sale_challan_item_id', 'sale_challan_item_id INT NULL');
  await ensureColumn('packing_box_items', 'proto_code', 'proto_code VARCHAR(100) NULL');
  const ensureIndex = async (table, name, ddl) => {
    const [rows] = await db.query(
      'SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
      [table, name]);
    if (!rows.length) await db.query(ddl);
  };
  // Same request_key twice (retry / double click) must not create a second box
  await ensureIndex('packing_boxes', 'uniq_packing_request_key',
    'ALTER TABLE packing_boxes ADD UNIQUE KEY uniq_packing_request_key (request_key)');
  await ensureIndex('packing_boxes', 'idx_packing_sale_challan',
    'ALTER TABLE packing_boxes ADD KEY idx_packing_sale_challan (sale_challan_id)');
  await ensureIndex('packing_box_items', 'idx_pbi_sale_challan_item',
    'ALTER TABLE packing_box_items ADD KEY idx_pbi_sale_challan_item (sale_challan_item_id)');

  // Auto-seed PO number prefix setting
  // Purchase Order numbering
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('po_numbering_mode', 'auto')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('po_prefix', 'PO')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('po_start_number', '1001')").catch(()=>{});
  // Sale Invoice numbering
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('sale_numbering_mode', 'auto')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('sale_prefix', 'INV')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('sale_start_number', '1001')").catch(()=>{});
  // Delivery Challan numbering
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('delivery_numbering_mode', 'auto')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('delivery_prefix', 'DC')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('delivery_start_number', '1001')").catch(()=>{});
  // Proforma numbering
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('proforma_numbering_mode', 'auto')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('proforma_prefix', 'PRO')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('proforma_start_number', '1001')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('company_phone', '')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('company_gstin', '')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('company_email', '')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('company_address', '')").catch(()=>{});

  // ── System Email (OTP / Forgot Password sender) ───────────────────────────
  // Admin sets these in Settings → Email tab. Gmail App Password required.
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('system_email', 'Mojiinnovators@gmail.com')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('resend_api_key', '')").catch(()=>{});


  // ── CLIENT PURCHASE ORDERS (client-submitted with PDF) ────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS client_purchase_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    po_number VARCHAR(100) NOT NULL,
    client_id INT NOT NULL,
    order_date DATE NOT NULL,
    due_date DATE,
    remark TEXT,
    pdf_url VARCHAR(500),
    pdf_public_id VARCHAR(300),
    status ENUM('pending','acknowledged','processing','payment_pending','advance_pending','completed','cancelled') DEFAULT 'pending',
    total_amount DECIMAL(12,2) DEFAULT 0,
    paid_amount DECIMAL(12,2) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // ── CLIENT PO PAYMENTS ────────────────────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS client_po_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    po_id INT NOT NULL,
    client_id INT NOT NULL,
    payment_date DATE NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    payment_mode ENUM('bank_transfer','cheque','upi','cash','other') DEFAULT 'bank_transfer',
    bank_name VARCHAR(255),
    cheque_number VARCHAR(100),
    utr_reference VARCHAR(255),
    remark TEXT,
    is_advance TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (po_id) REFERENCES client_purchase_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // ── CLIENT SUPPORT TICKETS (chat-style) ──────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS client_tickets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id INT NOT NULL,
    project_id INT,
    subject VARCHAR(255) NOT NULL,
    status ENUM('open','in_progress','resolved','closed') DEFAULT 'open',
    priority ENUM('low','medium','high','urgent') DEFAULT 'medium',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
  )`);

  // ── CLIENT TICKET MESSAGES ────────────────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS client_ticket_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ticket_id INT NOT NULL,
    sender_id INT NOT NULL,
    sender_role ENUM('client','admin') NOT NULL,
    message TEXT NOT NULL,
    is_read TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES client_tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // ── User Rights / Permissions ─────────────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS worker_permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_id INT NOT NULL,
    menu_key VARCHAR(100) NOT NULL,
    can_read TINYINT(1) DEFAULT 0,
    can_write TINYINT(1) DEFAULT 0,
    can_edit TINYINT(1) DEFAULT 0,
    can_delete TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_worker_menu (worker_id, menu_key),
    FOREIGN KEY (worker_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // ── APPROVAL SYSTEM ─────────────────────────────────────────────────────────
  // Main approval requests table
  await db.query(`CREATE TABLE IF NOT EXISTS approvals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type ENUM('PROJECT','ITEM','CHALLAN','PO_STATUS','SALE') NOT NULL,
    related_id INT DEFAULT NULL,
    user_id INT NOT NULL,
    requested_data LONGTEXT NOT NULL COMMENT 'JSON with complete request body',
    status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') DEFAULT 'PENDING',
    admin_notes TEXT,
    approved_by INT DEFAULT NULL,
    approved_at DATETIME DEFAULT NULL,
    rejected_reason TEXT,
    rejected_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_status (status),
    INDEX idx_type (type),
    INDEX idx_user_id (user_id),
    INDEX idx_created_at (created_at),
    INDEX idx_pending (status, type)
  )`);

  // Approval queue for counting pending approvals per user+action
  await db.query(`CREATE TABLE IF NOT EXISTS approval_queue (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    action_type VARCHAR(100) NOT NULL,
    pending_count INT DEFAULT 0,
    last_request_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_action (user_id, action_type),
    INDEX idx_pending_count (pending_count),
    INDEX idx_user_id (user_id)
  )`);

  // Approval system settings (feature flags)
  await db.query(`CREATE TABLE IF NOT EXISTS approval_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value VARCHAR(255) NOT NULL,
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_setting_key (setting_key)
  )`);

  // Seed default approval settings.
  // NOTE: Master switch defaults to '1' (ENABLED) so fresh/new deployments
  // get the approval workflow turned on automatically. Existing rows are
  // protected by INSERT IGNORE — once a DB has this row, the value is never
  // overwritten by code. Admin can still toggle via UI (PUT /api/approvals/settings).
  const approvalSettings = [
    ['approval_system_enabled', '1', 'Master switch: 0=disabled, 1=enabled'],
    ['require_approval_for_PROJECT', '1', 'Require approval for Project creation'],
    ['require_approval_for_ITEM', '1', 'Require approval for Item addition'],
    ['require_approval_for_CHALLAN', '1', 'Require approval for Sale Challan'],
    ['require_approval_for_PO_STATUS', '1', 'Require approval for PO status changes'],
    ['require_approval_for_SALE', '1', 'Require approval for Sales/Invoices']
  ];
  for (const [k, v, d] of approvalSettings) {
    await db.query('INSERT IGNORE INTO approval_settings (setting_key, setting_value, description) VALUES (?,?,?)', [k, v, d]);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN PO MODULE (Phase 1) — additive only. New tables + nullable columns.
  // No existing table is dropped, renamed, or destructively modified.
  // ══════════════════════════════════════════════════════════════════════════
  await db.query(`CREATE TABLE IF NOT EXISTS main_pos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    po_no VARCHAR(50) UNIQUE NOT NULL,
    project_name VARCHAR(255) NOT NULL,
    client_name VARCHAR(255),
    pmc_name VARCHAR(255),
    order_date DATE,
    timelines VARCHAR(255),
    remarks TEXT,
    status ENUM('draft','submitted','approved','rejected') DEFAULT 'draft',
    project_id INT NULL,
    submitted_by INT NULL, submitted_at DATETIME NULL,
    approved_by INT NULL, approved_at DATETIME NULL,
    rejected_by INT NULL, rejected_at DATETIME NULL, rejected_reason TEXT,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_mainpo_status (status),
    INDEX idx_mainpo_project (project_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS main_po_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    main_po_id INT NOT NULL,
    s_no INT DEFAULT 1,
    area VARCHAR(100),
    proto_code VARCHAR(100),
    product_name VARCHAR(255) NOT NULL,
    product_size VARCHAR(255),
    finishes_note TEXT,
    is_paint_finish TINYINT(1) DEFAULT 0,
    is_fabric_finish TINYINT(1) DEFAULT 0,
    is_metal_finish TINYINT(1) DEFAULT 0,
    size_length VARCHAR(50),
    size_width VARCHAR(50),
    size_thickness VARCHAR(50),
    qty DECIMAL(10,2) DEFAULT 1,
    remark TEXT,
    project_item_id INT NULL,
    sort_order INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_mpi_po (main_po_id),
    FOREIGN KEY (main_po_id) REFERENCES main_pos(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE SET NULL
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS main_po_item_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    main_po_item_id INT NOT NULL,
    image_path VARCHAR(500) NOT NULL,
    public_id VARCHAR(255),
    caption TEXT,
    sort_order INT DEFAULT 0,
    uploaded_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_mpimg_item (main_po_item_id),
    FOREIGN KEY (main_po_item_id) REFERENCES main_po_items(id) ON DELETE CASCADE
  )`);

  // approvals.type: APPEND 'MAIN_PO' member. Appending ENUM values is
  // backward-compatible — existing rows/queries are unaffected.
  await safeAlter(`ALTER TABLE approvals MODIFY COLUMN type ENUM('PROJECT','ITEM','CHALLAN','PO_STATUS','SALE','MAIN_PO') NOT NULL`);

  // Traceability columns (nullable — NULL for all existing/manual records)
  await ensureColumn('projects', 'source_main_po_id', 'source_main_po_id INT NULL');
  await ensureColumn('project_items', 'area', 'area VARCHAR(100) NULL');
  await ensureColumn('project_items', 'source_main_po_item_id', 'source_main_po_item_id INT NULL');

  // Proto Code mode chosen when the order is created ('manual' | 'auto'); copied to
  // its Project. NULL = older records, which keep working as manual.
  await ensureColumn('main_pos', 'proto_mode', 'proto_mode VARCHAR(10) NULL');
  await ensureColumn('projects', 'proto_mode', 'proto_mode VARCHAR(10) NULL');
  // Rows added to an order after it was approved (the customer ordered more)
  await ensureColumn('main_po_items', 'added_after_approval', 'added_after_approval TINYINT(1) NOT NULL DEFAULT 0');
  // Proto Code series (Settings) — INSERT IGNORE never overwrites configured values
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('proto_code_prefix','PROTO_'),('proto_code_start_number','1001')").catch(() => {});

  // Main PO number series (INSERT IGNORE — never overwrites configured values)
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('main_po_prefix', 'MPO')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('main_po_start_number', '1001')").catch(()=>{});

  // ══════════════════════════════════════════════════════════════════════════
  // FINISH MODULE (Phase 2: Paint / Fabric / Metal) — additive only.
  // One sheet per (main_po, finish_type); entries per flagged PO item.
  // Base product data is never copied — read live from main_po_items.
  // ══════════════════════════════════════════════════════════════════════════
  await db.query(`CREATE TABLE IF NOT EXISTS finish_sheets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    main_po_id INT NOT NULL,
    finish_type ENUM('paint','fabric','metal') NOT NULL,
    status ENUM('draft','submitted') DEFAULT 'draft',
    remarks TEXT,
    submitted_by INT NULL, submitted_at DATETIME NULL,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_finish_sheet (main_po_id, finish_type),
    FOREIGN KEY (main_po_id) REFERENCES main_pos(id) ON DELETE CASCADE
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS finish_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sheet_id INT NOT NULL,
    main_po_item_id INT NOT NULL,
    paint_finish_name VARCHAR(255) NULL,
    fabric_name VARCHAR(255) NULL,
    per_item_fabric_qty DECIMAL(10,2) NULL,
    total_qty DECIMAL(12,2) NULL,
    fabric_unit VARCHAR(20) NULL,
    material_type ENUM('sheet','pipe','pipe_material','other') NULL,
    material_other VARCHAR(255) NULL,
    metal_finish_details TEXT NULL,
    size_length VARCHAR(50) NULL,
    size_width VARCHAR(50) NULL,
    size_thickness VARCHAR(50) NULL,
    size_other VARCHAR(255) NULL,
    remark TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_finish_entry (sheet_id, main_po_item_id),
    FOREIGN KEY (sheet_id) REFERENCES finish_sheets(id) ON DELETE CASCADE,
    FOREIGN KEY (main_po_item_id) REFERENCES main_po_items(id) ON DELETE CASCADE
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS finish_entry_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entry_id INT NOT NULL,
    image_type ENUM('finish','sample') DEFAULT 'finish',
    image_path VARCHAR(500) NOT NULL,
    public_id VARCHAR(255),
    caption TEXT,
    sort_order INT DEFAULT 0,
    uploaded_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_fei_entry (entry_id),
    FOREIGN KEY (entry_id) REFERENCES finish_entries(id) ON DELETE CASCADE
  )`);

  // ══════════════════════════════════════════════════════════════════════════
  // CASH BOOK MODULE (Phase 3) — additive only.
  // ══════════════════════════════════════════════════════════════════════════
  await db.query(`CREATE TABLE IF NOT EXISTS expense_ledgers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) UNIQUE NOT NULL,
    is_default TINYINT(1) DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS cashbook_advances (
    id INT AUTO_INCREMENT PRIMARY KEY,
    voucher_no VARCHAR(50) UNIQUE NULL,
    worker_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    advance_date DATE,
    payment_mode ENUM('cash','upi','cheque','bank_transfer') DEFAULT 'cash',
    particulars TEXT,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    submitted_by INT NULL, submitted_at DATETIME NULL,
    approved_by INT NULL, approved_at DATETIME NULL,
    rejected_by INT NULL, rejected_at DATETIME NULL, rejected_reason TEXT,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_cba_worker (worker_id, status),
    FOREIGN KEY (worker_id) REFERENCES users(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS cashbook_expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_id INT NOT NULL,
    ledger_id INT NOT NULL,
    expense_date DATE,
    amount DECIMAL(12,2) NOT NULL,
    particulars TEXT,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    submitted_by INT NULL, submitted_at DATETIME NULL,
    approved_by INT NULL, approved_at DATETIME NULL,
    rejected_by INT NULL, rejected_at DATETIME NULL, rejected_reason TEXT,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_cbe_worker (worker_id, status),
    FOREIGN KEY (worker_id) REFERENCES users(id),
    FOREIGN KEY (ledger_id) REFERENCES expense_ledgers(id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS cashbook_attachments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    expense_id INT NOT NULL,
    image_path VARCHAR(500) NOT NULL,
    public_id VARCHAR(255),
    caption TEXT,
    uploaded_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cbatt_expense (expense_id),
    FOREIGN KEY (expense_id) REFERENCES cashbook_expenses(id) ON DELETE CASCADE
  )`);

  // approvals.type: APPEND cash book members (backward-compatible ENUM append)
  await safeAlter(`ALTER TABLE approvals MODIFY COLUMN type ENUM('PROJECT','ITEM','CHALLAN','PO_STATUS','SALE','MAIN_PO','CASHBOOK_ADVANCE','CASHBOOK_EXPENSE') NOT NULL`);

  // Voucher series + default ledgers (INSERT IGNORE — never overwrites)
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('cashbook_voucher_prefix', 'CPV')").catch(()=>{});
  for (const ledgerName of ['Parts', 'Freight/Parcel Expenses', 'Other Specific Details', 'Refreshment Expenses']) {
    await db.query('INSERT IGNORE INTO expense_ledgers (name, is_default, is_active) VALUES (?,1,1)', [ledgerName]).catch(()=>{});
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PAYROLL MODULE (Phase 4) — additive only, FULLY SEPARATE from users.
  // users.hourly_rate and worker_time_logs are never touched.
  // ══════════════════════════════════════════════════════════════════════════
  await db.query(`CREATE TABLE IF NOT EXISTS payroll_import_batches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    imported_by INT NULL,
    total_rows INT DEFAULT 0,
    imported_rows INT DEFAULT 0,
    skipped_rows INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS payroll_employees (
    id INT AUTO_INCREMENT PRIMARY KEY,
    emp_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    department VARCHAR(150),
    designation VARCHAR(150),
    hourly_rate DECIMAL(10,2) DEFAULT 0,
    overtime_rate DECIMAL(10,2) DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    import_batch_id INT NULL,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_pe_active (is_active)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS payroll_time_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_id INT NOT NULL,
    project_id INT NULL,
    proto_code VARCHAR(100) NULL,
    entry_date DATE NOT NULL,
    in_time TIME NOT NULL,
    out_time TIME NOT NULL,
    total_minutes INT NOT NULL DEFAULT 0,
    normal_minutes INT NOT NULL DEFAULT 0,
    ot_minutes INT NOT NULL DEFAULT 0,
    entered_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pte_emp_date (employee_id, entry_date),
    FOREIGN KEY (employee_id) REFERENCES payroll_employees(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
  )`);

  // Payroll time-window settings (INSERT IGNORE — never overwrites configured values)
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('payroll_normal_start','09:00')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('payroll_normal_end','18:00')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('payroll_ot_start','18:00')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('payroll_ot_end','23:59')").catch(()=>{});

  // ══════════════════════════════════════════════════════════════════════════
  // QUALITY REPORT MODULE (Phase 5) — additive only.
  // ══════════════════════════════════════════════════════════════════════════
  await db.query(`CREATE TABLE IF NOT EXISTS qc_persons (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS quality_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_no VARCHAR(50) UNIQUE NOT NULL,
    project_id INT NOT NULL,
    project_item_id INT NULL,
    client_name VARCHAR(255),
    vendor_name VARCHAR(255),
    location VARCHAR(500),
    qc_person_id INT NULL,
    inspection_level ENUM('final','white_body') DEFAULT 'final',
    inspection_date DATE NULL,
    sku_number VARCHAR(100),
    status ENUM('draft','assigned','submitted','approved','rejected') DEFAULT 'draft',
    can_add_sections TINYINT(1) DEFAULT 0,
    assigned_to INT NULL,
    submitted_by INT NULL, submitted_at DATETIME NULL,
    approved_by INT NULL, approved_at DATETIME NULL,
    rejected_by INT NULL, rejected_at DATETIME NULL, rejected_reason TEXT,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_qr_status (status),
    INDEX idx_qr_assigned (assigned_to),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE SET NULL,
    FOREIGN KEY (qc_person_id) REFERENCES qc_persons(id) ON DELETE SET NULL
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS quality_report_sections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_id INT NOT NULL,
    section_name VARCHAR(255) NOT NULL,
    description TEXT,
    sort_order INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_qrs_report (report_id),
    FOREIGN KEY (report_id) REFERENCES quality_reports(id) ON DELETE CASCADE
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS quality_report_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    section_id INT NOT NULL,
    image_path VARCHAR(500) NOT NULL,
    public_id VARCHAR(255),
    caption TEXT,
    corner_note VARCHAR(255),
    sort_order INT DEFAULT 0,
    uploaded_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_qri_section (section_id),
    FOREIGN KEY (section_id) REFERENCES quality_report_sections(id) ON DELETE CASCADE
  )`);

  // QC inspection form (printed page 2) — additive, all nullable. NULL = not
  // entered yet, so the print never shows invented values.
  // Links a QC person to a worker in the Quality Check department (NULL = added by hand)
  await ensureColumn('qc_persons', 'user_id', 'user_id INT NULL');
  await ensureColumn('quality_reports', 'mo_number', 'mo_number VARCHAR(100) NULL');
  await ensureColumn('quality_reports', 'drawing_revision', 'drawing_revision VARCHAR(150) NULL');
  await ensureColumn('quality_reports', 'finish_code', 'finish_code VARCHAR(255) NULL');
  await ensureColumn('quality_reports', 'order_qty', 'order_qty DECIMAL(10,2) NULL');
  await ensureColumn('quality_reports', 'inspected_qty', 'inspected_qty DECIMAL(10,2) NULL');
  await ensureColumn('quality_reports', 'accepted_qty', 'accepted_qty DECIMAL(10,2) NULL');
  await ensureColumn('quality_reports', 'rework_qty', 'rework_qty DECIMAL(10,2) NULL');
  await ensureColumn('quality_reports', 'rejected_qty', 'rejected_qty DECIMAL(10,2) NULL');
  await ensureColumn('quality_reports', 'checklist_json', 'checklist_json LONGTEXT NULL');
  await ensureColumn('quality_reports', 'inspection_result', "inspection_result ENUM('approved','rework','rejected') NULL");
  await ensureColumn('quality_reports', 'qc_remarks', 'qc_remarks TEXT NULL');
  await ensureColumn('quality_reports', 'production_head', 'production_head VARCHAR(150) NULL');
  await ensureColumn('quality_reports', 'signoff_date', 'signoff_date DATE NULL');

  // approvals.type: APPEND QUALITY_REPORT (backward-compatible ENUM append)
  await safeAlter(`ALTER TABLE approvals MODIFY COLUMN type ENUM('PROJECT','ITEM','CHALLAN','PO_STATUS','SALE','MAIN_PO','CASHBOOK_ADVANCE','CASHBOOK_EXPENSE','QUALITY_REPORT') NOT NULL`);

  // Report series (INSERT IGNORE — never overwrites)
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('qr_prefix','QR')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('qr_start_number','1')").catch(()=>{});

  // ══════════════════════════════════════════════════════════════════════════
  // CFT MODULE (Phase 6 — Solid Wood Issue Sheet) — additive only.
  // Formula + 30% offcut are fixed in code (not configurable per Q7).
  // ══════════════════════════════════════════════════════════════════════════
  await db.query(`CREATE TABLE IF NOT EXISTS cft_sheets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sheet_no VARCHAR(50) UNIQUE NOT NULL,
    project_id INT NOT NULL,
    project_item_id INT NULL,
    wood_type VARCHAR(150),
    remarks TEXT,
    offcut_percent DECIMAL(5,2) DEFAULT 30.00,
    total_demand_cft DECIMAL(14,4) DEFAULT 0,
    offcut_cft DECIMAL(14,4) DEFAULT 0,
    total_required_cft DECIMAL(14,4) DEFAULT 0,
    total_issue_cft DECIMAL(14,4) DEFAULT 0,
    total_return_cft DECIMAL(14,4) DEFAULT 0,
    difference DECIMAL(14,4) DEFAULT 0,
    net_difference DECIMAL(14,4) DEFAULT 0,
    status ENUM('draft','submitted') DEFAULT 'draft',
    submitted_by INT NULL, submitted_at DATETIME NULL,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_cft_status (status),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (project_item_id) REFERENCES project_items(id) ON DELETE SET NULL
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS cft_rows (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sheet_id INT NOT NULL,
    row_type ENUM('demand','issue','return') NOT NULL,
    label VARCHAR(255),
    length DECIMAL(12,3) DEFAULT 0,
    width DECIMAL(12,3) DEFAULT 0,
    thickness DECIMAL(12,3) DEFAULT 0,
    qty DECIMAL(12,2) DEFAULT 0,
    gross_cft DECIMAL(14,4) DEFAULT 0,
    net_cft DECIMAL(14,4) DEFAULT 0,
    sort_order INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cftrow_sheet (sheet_id, row_type),
    FOREIGN KEY (sheet_id) REFERENCES cft_sheets(id) ON DELETE CASCADE
  )`);

  // Cutting list photos on a CFT sheet: JSON array of image URLs
  await ensureColumn('cft_sheets', 'cutting_list_photos', 'cutting_list_photos TEXT NULL');

  // CFT approval flow: draft → pending (sent for approval) → approved → assigned to workers.
  // 'submitted' stays for sheets locked before this flow existed. Appending ENUM values is safe.
  await safeAlter(`ALTER TABLE cft_sheets MODIFY COLUMN status ENUM('draft','submitted','pending','approved') DEFAULT 'draft'`);
  await ensureColumn('cft_sheets', 'approved_by', 'approved_by INT NULL');
  await ensureColumn('cft_sheets', 'approved_at', 'approved_at DATETIME NULL');
  await ensureColumn('cft_sheets', 'rejected_reason', 'rejected_reason TEXT NULL');
  await ensureColumn('cft_sheets', 'rejected_at', 'rejected_at DATETIME NULL');
  await safeAlter(`ALTER TABLE approvals MODIFY COLUMN type ENUM('PROJECT','ITEM','CHALLAN','PO_STATUS','SALE','MAIN_PO','CASHBOOK_ADVANCE','CASHBOOK_EXPENSE','QUALITY_REPORT','CFT') NOT NULL`);
  // Workers an approved sheet is assigned to; each fills their own Tally details
  await db.query(`CREATE TABLE IF NOT EXISTS cft_sheet_workers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sheet_id INT NOT NULL,
    worker_id INT NOT NULL,
    assigned_by INT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    entered_in_tally ENUM('yes','no') NULL,
    stock_journal_no VARCHAR(100) NULL,
    other_details TEXT NULL,
    details_updated_at DATETIME NULL,
    completed_at DATETIME NULL,
    UNIQUE KEY uq_cft_worker (sheet_id, worker_id),
    INDEX idx_cftw_worker (worker_id),
    FOREIGN KEY (sheet_id) REFERENCES cft_sheets(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  // ── Wood stock: Wood Type master, standard sizes, Wood Inward (incl. opening balances) ──
  await db.query(`CREATE TABLE IF NOT EXISTS wood_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    remarks VARCHAR(500) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wood_name (name)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS wood_type_sizes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    wood_type_id INT NOT NULL,
    label VARCHAR(255) NULL,
    length DECIMAL(12,3) DEFAULT 0, width DECIMAL(12,3) DEFAULT 0, thickness DECIMAL(12,3) DEFAULT 0,
    sort_order INT DEFAULT 0,
    INDEX idx_wts_type (wood_type_id),
    FOREIGN KEY (wood_type_id) REFERENCES wood_types(id) ON DELETE CASCADE
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS wood_inwards (
    id INT AUTO_INCREMENT PRIMARY KEY,
    inward_no VARCHAR(50) NOT NULL,
    entry_type ENUM('inward','opening') NOT NULL DEFAULT 'inward',
    inward_date DATE NOT NULL,
    wood_type_id INT NOT NULL,
    reference VARCHAR(255) NULL,
    remarks TEXT NULL,
    total_qty DECIMAL(14,2) DEFAULT 0, total_cft DECIMAL(14,4) DEFAULT 0,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_inward_no (inward_no),
    INDEX idx_win_date (inward_date),
    FOREIGN KEY (wood_type_id) REFERENCES wood_types(id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS wood_inward_rows (
    id INT AUTO_INCREMENT PRIMARY KEY,
    inward_id INT NOT NULL,
    label VARCHAR(255) NULL,
    length DECIMAL(12,3) DEFAULT 0, width DECIMAL(12,3) DEFAULT 0, thickness DECIMAL(12,3) DEFAULT 0,
    qty DECIMAL(12,2) DEFAULT 0, gross_cft DECIMAL(14,4) DEFAULT 0, net_cft DECIMAL(14,4) DEFAULT 0,
    sort_order INT DEFAULT 0,
    INDEX idx_winr_inward (inward_id),
    FOREIGN KEY (inward_id) REFERENCES wood_inwards(id) ON DELETE CASCADE
  )`);
  // CFT sheet → wood type from the master (the old free-text wood_type stays for older sheets)
  await ensureColumn('cft_sheets', 'wood_type_id', 'wood_type_id INT NULL');
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('wood_inward_prefix','WIN')").catch(() => {});

  // ── Wood stock by thickness: each wood type has thickness categories (25, 38, 50 mm …).
  // "ALL CFT" is a separate category of every wood (rows flagged is_all_cft = 1, CFT typed directly).
  await db.query(`CREATE TABLE IF NOT EXISTS wood_type_thicknesses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    wood_type_id INT NOT NULL,
    thickness DECIMAL(12,3) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT DEFAULT 0,
    UNIQUE KEY uq_wood_thickness (wood_type_id, thickness),
    FOREIGN KEY (wood_type_id) REFERENCES wood_types(id) ON DELETE CASCADE
  )`);
  await ensureColumn('cft_rows', 'is_all_cft', 'is_all_cft TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn('wood_inward_rows', 'is_all_cft', 'is_all_cft TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn('wood_inward_rows', 'direct_cft', 'direct_cft TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn('wood_inward_rows', 'wood_type_id', 'wood_type_id INT NULL');   // one invoice can carry several woods
  await ensureColumn('wood_inwards', 'supplier_name', 'supplier_name VARCHAR(255) NULL');
  await ensureColumn('wood_inwards', 'invoice_no', 'invoice_no VARCHAR(100) NULL');
  await ensureColumn('wood_inwards', 'invoice_date', 'invoice_date DATE NULL');
  await ensureColumn('wood_inwards', 'truck_no', 'truck_no VARCHAR(50) NULL');
  await safeAlter('UPDATE wood_inward_rows r JOIN wood_inwards wi ON wi.id = r.inward_id SET r.wood_type_id = wi.wood_type_id WHERE r.wood_type_id IS NULL');
  // Moving stock from one thickness category to another of the same wood (e.g. ALL CFT → 38 mm)
  await db.query(`CREATE TABLE IF NOT EXISTS wood_transfers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    transfer_no VARCHAR(50) NOT NULL,
    transfer_date DATE NOT NULL,
    wood_type_id INT NOT NULL,
    from_all TINYINT(1) NOT NULL DEFAULT 0, from_thickness DECIMAL(12,3) NOT NULL DEFAULT 0,
    to_all TINYINT(1) NOT NULL DEFAULT 0, to_thickness DECIMAL(12,3) NOT NULL DEFAULT 0,
    cft DECIMAL(14,4) NOT NULL DEFAULT 0,
    remarks TEXT NULL,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_transfer_no (transfer_no),
    INDEX idx_wtr_date (transfer_date),
    FOREIGN KEY (wood_type_id) REFERENCES wood_types(id)
  )`);
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('wood_transfer_prefix','WTR')").catch(() => {});
  // Thicknesses already used (standard sizes, inward rows, CFT issue/return rows) join the
  // master, so existing stock lands in its T category. Idempotent: INSERT IGNORE on (wood, T).
  await safeAlter(`INSERT IGNORE INTO wood_type_thicknesses (wood_type_id, thickness)
    SELECT wood_type_id, thickness FROM wood_type_sizes WHERE thickness > 0`);
  await safeAlter(`INSERT IGNORE INTO wood_type_thicknesses (wood_type_id, thickness)
    SELECT COALESCE(r.wood_type_id, wi.wood_type_id), r.thickness FROM wood_inward_rows r JOIN wood_inwards wi ON wi.id = r.inward_id
     WHERE r.thickness > 0 AND r.is_all_cft = 0`);
  await safeAlter(`INSERT IGNORE INTO wood_type_thicknesses (wood_type_id, thickness)
    SELECT cs.wood_type_id, r.thickness FROM cft_rows r JOIN cft_sheets cs ON cs.id = r.sheet_id
     WHERE cs.wood_type_id IS NOT NULL AND r.row_type IN ('issue','return') AND r.thickness > 0 AND r.is_all_cft = 0`);

  // ── Quotations against a Manufacturing Order (revisions share quote_no) ──
  await db.query(`CREATE TABLE IF NOT EXISTS quotations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    quote_no VARCHAR(50) NOT NULL,
    revision INT NOT NULL DEFAULT 0,
    main_po_id INT NULL,
    status ENUM('draft','sent','accepted','rejected','revised') NOT NULL DEFAULT 'draft',
    client_name VARCHAR(255), client_address TEXT, client_gstin VARCHAR(30), client_phone VARCHAR(30),
    quote_date DATE, valid_until DATE NULL,
    gst_type ENUM('intra','inter') NOT NULL DEFAULT 'intra',
    subject VARCHAR(255), notes TEXT, terms TEXT,
    subtotal DECIMAL(14,2) DEFAULT 0, discount_amount DECIMAL(14,2) DEFAULT 0,
    gst_percent DECIMAL(5,2) DEFAULT 0, taxable_amount DECIMAL(14,2) DEFAULT 0,
    gst_amount DECIMAL(14,2) DEFAULT 0, total_amount DECIMAL(14,2) DEFAULT 0,
    sent_at DATETIME NULL, decided_at DATETIME NULL, reject_reason TEXT NULL,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_quote_rev (quote_no, revision),
    INDEX idx_quote_mo (main_po_id),
    FOREIGN KEY (main_po_id) REFERENCES main_pos(id) ON DELETE SET NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS quotation_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    quotation_id INT NOT NULL,
    main_po_item_id INT NULL,
    proto_code VARCHAR(100), item_name VARCHAR(255) NOT NULL, description TEXT,
    area VARCHAR(100), size VARCHAR(255), finishes VARCHAR(500), unit VARCHAR(20) DEFAULT 'pcs',
    qty DECIMAL(14,2) DEFAULT 1, rate DECIMAL(14,2) DEFAULT 0, amount DECIMAL(14,2) DEFAULT 0,
    sort_order INT DEFAULT 0,
    INDEX idx_qi_quote (quotation_id),
    FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
  )`);
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('quotation_prefix','QT')").catch(() => {});
  // QC report: check points typed per section (JSON list). NULL = never edited → the print
  // keeps the standard points for that section name.
  await ensureColumn('quality_report_sections', 'check_points', 'check_points TEXT NULL');
  // "Calculate GST" switch + additional charges (transport, loading …). Older quotations keep GST on
  // and their item GST equals the stored gst_amount.
  await ensureColumn('quotations', 'calc_gst', 'calc_gst TINYINT(1) NOT NULL DEFAULT 1');
  await ensureColumn('quotations', 'item_gst_amount', 'item_gst_amount DECIMAL(14,2) NULL');
  await ensureColumn('quotations', 'charges_amount', 'charges_amount DECIMAL(14,2) NOT NULL DEFAULT 0');
  await ensureColumn('quotations', 'charges_gst_amount', 'charges_gst_amount DECIMAL(14,2) NOT NULL DEFAULT 0');
  await safeAlter('UPDATE quotations SET item_gst_amount = gst_amount WHERE item_gst_amount IS NULL');
  // Saved Terms & Conditions for quotations (one is the default for new quotations)
  await db.query(`CREATE TABLE IF NOT EXISTS quotation_terms_templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    content TEXT NOT NULL,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT DEFAULT 0,
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  // Terms typed earlier in Settings (quotation_terms) become the first, default set — once
  await safeAlter(`INSERT INTO quotation_terms_templates (name, content, is_default)
    SELECT 'Standard Terms', setting_value, 1 FROM app_settings
     WHERE setting_key = 'quotation_terms' AND COALESCE(TRIM(setting_value), '') <> ''
       AND NOT EXISTS (SELECT 1 FROM quotation_terms_templates)`);
  await db.query(`CREATE TABLE IF NOT EXISTS quotation_charges (
    id INT AUTO_INCREMENT PRIMARY KEY,
    quotation_id INT NOT NULL,
    description VARCHAR(255) NOT NULL,
    amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    with_gst TINYINT(1) NOT NULL DEFAULT 1,
    gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
    gst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    sort_order INT DEFAULT 0,
    INDEX idx_qc_quote (quotation_id),
    FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
  )`);

  // Worker marks their CFT task done ("Mark as Complete")
  await ensureColumn('cft_sheet_workers', 'completed_at', 'completed_at DATETIME NULL');

  // CFT sheet series (INSERT IGNORE — never overwrites)
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('cft_prefix','CFT')").catch(()=>{});
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('cft_start_number','1')").catch(()=>{});
  // Negative wood stock: 'no' = refuse any change that takes a wood + thickness below zero
  await db.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('cft_allow_negative_stock','no')").catch(()=>{});

  console.log('✅ Workshop App Database initialized');
  return db;
}

module.exports = { getPool, initializeDatabase };
