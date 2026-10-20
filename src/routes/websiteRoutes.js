/**
 * PUBLIC WEBSITE + CMS ROUTES
 * ─────────────────────────────────────────────────────────────
 * Fully self-contained, additive file — mirrors clientRoutes.js pattern.
 * Nothing in routes/index.js is touched or affected.
 *
 * Mounted in server.js at: app.use('/api/website', websiteRoutes.router)
 *
 *  PUBLIC (no auth)  → /api/website/public/*   — read-only, used by moji.org.in homepage
 *  ADMIN  (auth)     → /api/website/admin/*    — CRUD, admin role only, used by the
 *                                                 "Website" section inside the admin panel
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

const JWT_SECRET = process.env.JWT_SECRET || 'workshop_secret_2024';

// ── Auth middleware (self-contained, same pattern as clientRoutes.js) ────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access only' });
  next();
}

// ── Cloudinary upload for website media ───────────────────────────────────────
// Config is shared process-wide (cloudinary.config() already called in
// services/cloudinaryStorage.js, loaded by server.js before requests arrive).
const websiteUpload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'website/media',
      allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function slugify(str) {
  return (str || '').toString().toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function uniqueSlug(db, base, excludeId) {
  let slug = base || 'product';
  let i = 1;
  while (true) {
    const [[row]] = excludeId
      ? await db.query('SELECT id FROM website_products WHERE slug=? AND id<>?', [slug, excludeId])
      : await db.query('SELECT id FROM website_products WHERE slug=?', [slug]);
    if (!row) return slug;
    i += 1;
    slug = `${base}-${i}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TABLE INIT (called once from server.js after core DB init — additive only)
// ═══════════════════════════════════════════════════════════════════════════
async function initWebsiteTables() {
  const db = await getPool();

  await db.query(`CREATE TABLE IF NOT EXISTS website_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS website_pages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(150) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    content LONGTEXT,
    meta_title VARCHAR(255),
    meta_description VARCHAR(500),
    meta_keywords VARCHAR(500),
    og_image TEXT,
    is_published TINYINT DEFAULT 1,
    is_system TINYINT DEFAULT 0,
    show_in_menu TINYINT DEFAULT 1,
    sort_order INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS website_sections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    section_key VARCHAR(100) UNIQUE NOT NULL,
    title VARCHAR(255),
    subtitle VARCHAR(500),
    body LONGTEXT,
    image_url TEXT,
    image_url_2 TEXT,
    is_active TINYINT DEFAULT 1,
    sort_order INT DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS website_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category VARCHAR(150) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    image_url TEXT,
    sort_order INT DEFAULT 0,
    is_active TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Product detail-page fields (additive migration — safe on an existing live table).
  // MySQL 8 "ADD COLUMN IF NOT EXISTS" support nahi karta (sirf MariaDB) — isliye
  // information_schema se check karke add karo (database.js ke ensureColumn jaisa).
  const ensureColumn = async (column, definition) => {
    const [[{ c }]] = await db.query(
      'SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
      ['website_products', column]
    );
    if (!c) await db.query(`ALTER TABLE website_products ADD COLUMN ${definition}`);
  };
  await ensureColumn('slug', 'slug VARCHAR(200)');
  await ensureColumn('gallery_images', 'gallery_images LONGTEXT');
  await ensureColumn('material', 'material VARCHAR(255)');
  await ensureColumn('dimensions', 'dimensions VARCHAR(255)');
  const [[{ idx }]] = await db.query(
    "SELECT COUNT(*) AS idx FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='website_products' AND INDEX_NAME='slug_unique'"
  );
  if (!idx) await db.query('ALTER TABLE website_products ADD UNIQUE INDEX slug_unique (slug)').catch(() => {});

  // Backfill slugs for any products created before this field existed
  const [slugless] = await db.query('SELECT id, name FROM website_products WHERE slug IS NULL OR slug = ""');
  for (const p of slugless) {
    const base = slugify(p.name) || 'product';
    await db.query('UPDATE website_products SET slug=? WHERE id=?', [`${base}-${p.id}`, p.id]).catch(() => {});
  }

  await db.query(`CREATE TABLE IF NOT EXISTS website_process_steps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    step_no INT DEFAULT 1,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    image_url TEXT,
    sort_order INT DEFAULT 0,
    is_active TINYINT DEFAULT 1
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS website_testimonials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_name VARCHAR(255) NOT NULL,
    client_role VARCHAR(255),
    quote TEXT NOT NULL,
    rating INT DEFAULT 5,
    sort_order INT DEFAULT 0,
    is_active TINYINT DEFAULT 1
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS website_team (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    designation VARCHAR(255),
    image_url TEXT,
    sort_order INT DEFAULT 0,
    is_active TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS website_media (
    id INT AUTO_INCREMENT PRIMARY KEY,
    url TEXT NOT NULL,
    public_id VARCHAR(255),
    alt_text VARCHAR(255),
    category VARCHAR(100) DEFAULT 'general',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS website_enquiries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    enquiry_type VARCHAR(100),
    message TEXT,
    status ENUM('new','contacted','closed') DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ── Seed sensible starter content ONLY if empty, so the site is never blank ──
  const [[{ c: pageCount }]] = await db.query('SELECT COUNT(*) c FROM website_pages');
  if (pageCount === 0) {
    await db.query(
      `INSERT INTO website_pages (slug, title, is_system, meta_title, meta_description) VALUES
       ('home','Home',1,'Moji Innovators LLP | Furniture Manufacturing','Furniture manufacturing and export from Moji Innovators LLP.'),
       ('about','About Us',0,'About Us | Moji Innovators LLP','Learn about Moji Innovators LLP furniture manufacturing.'),
       ('contact','Contact',0,'Contact Us | Moji Innovators LLP','Get in touch with Moji Innovators LLP for bulk orders and enquiries.')`
    );
  }

  const [[{ c: settingsCount }]] = await db.query('SELECT COUNT(*) c FROM website_settings');
  if (settingsCount === 0) {
    const defaults = {
      site_name: 'Moji Innovators LLP',
      tagline: 'Furniture built on craft, engineered for scale.',
      logo_url: '',
      favicon_url: '',
      phone: '',
      whatsapp: '',
      email: 'info@mojiinnovators.com',
      address: 'Industrial Area, Jaipur, Rajasthan, India',
      business_hours: 'Mon – Sat, 9:30 AM – 6:30 PM',
      facebook_url: '',
      instagram_url: '',
      linkedin_url: '',
      hero_image: 'https://images.unsplash.com/photo-1683115099860-5379ac101bce?auto=format&fit=crop&w=1900&q=80',
      hero_heading: "Furniture built on craft, engineered for scale.",
      hero_subheading: 'Moji Innovators LLP designs and manufactures furniture for dealers, hospitality projects, and retail brands across India.',
      stat_1_num: '12+', stat_1_label: 'Years Manufacturing',
      stat_2_num: '40,000', stat_2_label: 'Sq. Ft. Facility',
      stat_3_num: '180+', stat_3_label: 'Dealer Partners',
      stat_4_num: '6', stat_4_label: 'States Served',
      seo_default_title: 'Moji Innovators LLP | Furniture Manufacturing',
      seo_default_description: 'Furniture manufacturing and export from Moji Innovators LLP — dealers, retailers, and hospitality projects.',
      seo_default_keywords: 'furniture manufacturer, furniture export, Jaipur furniture, Moji Innovators',
      og_image: 'https://images.unsplash.com/photo-1683115099860-5379ac101bce?auto=format&fit=crop&w=1200&q=80',
      google_analytics_id: '',
    };
    for (const [k, v] of Object.entries(defaults)) {
      await db.query('INSERT INTO website_settings (setting_key, setting_value) VALUES (?,?)', [k, v]);
    }
  }

  const [[{ c: sectionCount }]] = await db.query('SELECT COUNT(*) c FROM website_sections');
  if (sectionCount === 0) {
    await db.query(
      `INSERT INTO website_sections (section_key, title, subtitle, body, image_url, image_url_2, sort_order) VALUES
      ('about','Two generations of woodwork, one modern factory floor.','About the Company','What began as a small workshop has grown into a full-scale manufacturing unit producing furniture for homes, offices, and hospitality spaces. We combine traditional joinery with modern machinery to hold tight tolerances at volume — without losing the finish that makes solid wood worth choosing.','https://images.unsplash.com/photo-1687180498602-5a1046defaa4?auto=format&fit=crop&w=900&q=80','https://images.unsplash.com/photo-1683115096447-5d01c11d3ead?auto=format&fit=crop&w=700&q=80',1)`
    );
  }

  const [[{ c: prodCount }]] = await db.query('SELECT COUNT(*) c FROM website_products');
  if (prodCount === 0) {
    await db.query(
      `INSERT INTO website_products (category, name, description, image_url, sort_order) VALUES
      ('dining','Dining','Dining tables, chairs and sets for retail and hospitality.','https://images.unsplash.com/photo-1613906800797-d5d4fb2f7bbb?auto=format&fit=crop&w=700&q=80',1),
      ('living-room','Living Room','Sofas, coffee tables and living room furniture.','https://images.unsplash.com/photo-1634712282287-14ed57b9cc89?auto=format&fit=crop&w=700&q=80',2),
      ('office','Office & Institutional','Desks, storage and institutional furniture.','https://images.unsplash.com/photo-1740759546813-6b58d44f5dce?auto=format&fit=crop&w=700&q=80',3),
      ('custom','Custom & Bespoke','Custom sizing and design for bulk B2B orders.','https://images.unsplash.com/photo-1680503397090-0483be73406f?auto=format&fit=crop&w=700&q=80',4)`
    );
  }

  const [[{ c: stepCount }]] = await db.query('SELECT COUNT(*) c FROM website_process_steps');
  if (stepCount === 0) {
    await db.query(
      `INSERT INTO website_process_steps (step_no, title, description, image_url, sort_order) VALUES
      (1,'Design & Sketch','Client brief or catalog design is finalized into cut-ready technical drawings.','https://images.unsplash.com/photo-1678184096514-d28596346091?auto=format&fit=crop&w=600&q=80',1),
      (2,'Material Selection','Kiln-dried hardwood or engineered board is selected and graded for the run.','https://images.unsplash.com/photo-1683115098516-9b8d5c643b5b?auto=format&fit=crop&w=600&q=80',2),
      (3,'Cutting & Shaping','Precision cutting and shaping on calibrated machinery for consistent parts.','https://images.unsplash.com/photo-1683115099860-5379ac101bce?auto=format&fit=crop&w=600&q=80',3),
      (4,'Assembly & Joinery','Frames are joined, glued and reinforced by hand for long-term durability.','https://images.unsplash.com/photo-1683115096447-5d01c11d3ead?auto=format&fit=crop&w=600&q=80',4),
      (5,'Finishing & QC','Sanding, polish and a final quality check before the piece is packed.','https://images.unsplash.com/photo-1587006158786-7b79525a2147?auto=format&fit=crop&w=600&q=80',5)`
    );
  }

  console.log('✅ Website CMS tables ready');
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES — no auth, used by the live moji.org.in homepage
// ═══════════════════════════════════════════════════════════════════════════

router.get('/public/settings', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT setting_key, setting_value FROM website_settings');
    const settings = {};
    rows.forEach(r => settings[r.setting_key] = r.setting_value);
    res.json(settings);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/pages', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query(
      'SELECT id, slug, title, sort_order FROM website_pages WHERE is_published=1 AND show_in_menu=1 ORDER BY sort_order, id'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/pages/:slug', async (req, res) => {
  try {
    const db = await getPool();
    const [[page]] = await db.query('SELECT * FROM website_pages WHERE slug=? AND is_published=1', [req.params.slug]);
    if (!page) return res.status(404).json({ message: 'Page not found' });
    res.json(page);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/sections', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_sections WHERE is_active=1 ORDER BY sort_order, id');
    const map = {};
    rows.forEach(r => map[r.section_key] = r);
    res.json(map);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/products', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_products WHERE is_active=1 ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/products/:slug', async (req, res) => {
  try {
    const db = await getPool();
    const [[product]] = await db.query('SELECT * FROM website_products WHERE slug=? AND is_active=1', [req.params.slug]);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/process', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_process_steps WHERE is_active=1 ORDER BY sort_order, step_no');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/testimonials', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_testimonials WHERE is_active=1 ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/team', async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_team WHERE is_active=1 ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/public/media', async (req, res) => {
  try {
    const db = await getPool();
    const { category } = req.query;
    const [rows] = category
      ? await db.query('SELECT * FROM website_media WHERE category=? ORDER BY id DESC', [category])
      : await db.query('SELECT * FROM website_media ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/public/enquiry', async (req, res) => {
  try {
    const { name, phone, email, enquiry_type, message } = req.body;
    if (!name || (!phone && !email)) return res.status(400).json({ message: 'Name and a phone or email are required' });
    const db = await getPool();
    await db.query(
      'INSERT INTO website_enquiries (name, phone, email, enquiry_type, message) VALUES (?,?,?,?,?)',
      [name, phone || null, email || null, enquiry_type || null, message || null]
    );
    res.json({ message: 'Enquiry received' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — auth + adminOnly, used by the "Website" section of admin panel
// ═══════════════════════════════════════════════════════════════════════════

// ── Settings ──
router.put('/admin/settings', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    for (const [key, value] of Object.entries(req.body)) {
      await db.query(
        'INSERT INTO website_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
        [key, value, value]
      );
    }
    res.json({ message: 'Website settings saved' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Pages (dynamic) ──
router.post('/admin/pages', auth, adminOnly, async (req, res) => {
  try {
    const { slug, title, content, meta_title, meta_description, meta_keywords, og_image, is_published, show_in_menu, sort_order } = req.body;
    if (!slug || !title) return res.status(400).json({ message: 'Slug and title are required' });
    const db = await getPool();
    const [result] = await db.query(
      `INSERT INTO website_pages (slug, title, content, meta_title, meta_description, meta_keywords, og_image, is_published, show_in_menu, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [slug, title, content || '', meta_title || title, meta_description || '', meta_keywords || '', og_image || '', is_published ?? 1, show_in_menu ?? 1, sort_order || 0]
    );
    res.json({ id: result.insertId, message: 'Page created' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'A page with this slug already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.put('/admin/pages/:id', auth, adminOnly, async (req, res) => {
  try {
    const { slug, title, content, meta_title, meta_description, meta_keywords, og_image, is_published, show_in_menu, sort_order } = req.body;
    const db = await getPool();
    await db.query(
      `UPDATE website_pages SET slug=?, title=?, content=?, meta_title=?, meta_description=?, meta_keywords=?, og_image=?, is_published=?, show_in_menu=?, sort_order=? WHERE id=?`,
      [slug, title, content || '', meta_title || title, meta_description || '', meta_keywords || '', og_image || '', is_published ?? 1, show_in_menu ?? 1, sort_order || 0, req.params.id]
    );
    res.json({ message: 'Page updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/admin/pages/:id', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [[page]] = await db.query('SELECT is_system FROM website_pages WHERE id=?', [req.params.id]);
    if (page?.is_system) return res.status(400).json({ message: 'This is a system page and cannot be deleted' });
    await db.query('DELETE FROM website_pages WHERE id=?', [req.params.id]);
    res.json({ message: 'Page deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/admin/pages', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_pages ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Homepage sections ──
router.get('/admin/sections', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_sections ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/admin/sections/:key', auth, adminOnly, async (req, res) => {
  try {
    const { title, subtitle, body, image_url, image_url_2, is_active, sort_order } = req.body;
    const db = await getPool();
    await db.query(
      `INSERT INTO website_sections (section_key, title, subtitle, body, image_url, image_url_2, is_active, sort_order)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE title=?, subtitle=?, body=?, image_url=?, image_url_2=?, is_active=?, sort_order=?`,
      [req.params.key, title, subtitle, body, image_url, image_url_2, is_active ?? 1, sort_order || 0,
       title, subtitle, body, image_url, image_url_2, is_active ?? 1, sort_order || 0]
    );
    res.json({ message: 'Section saved' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Products ──
router.get('/admin/products', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_products ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post('/admin/products', auth, adminOnly, async (req, res) => {
  try {
    const { category, name, description, image_url, sort_order, is_active, gallery_images, material, dimensions } = req.body;
    if (!name) return res.status(400).json({ message: 'Product name is required' });
    const db = await getPool();
    const slug = await uniqueSlug(db, slugify(name));
    const [r] = await db.query(
      'INSERT INTO website_products (category, name, description, image_url, sort_order, is_active, slug, gallery_images, material, dimensions) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [category, name, description || '', image_url || '', sort_order || 0, is_active ?? 1, slug,
       JSON.stringify(gallery_images || []), material || '', dimensions || '']
    );
    res.json({ id: r.insertId, slug, message: 'Product added' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.put('/admin/products/:id', auth, adminOnly, async (req, res) => {
  try {
    const { category, name, description, image_url, sort_order, is_active, gallery_images, material, dimensions } = req.body;
    const db = await getPool();
    const [[existing]] = await db.query('SELECT slug, name FROM website_products WHERE id=?', [req.params.id]);
    // Regenerate slug only if the name changed (keeps existing product URLs stable otherwise)
    const slug = (existing && existing.name === name && existing.slug)
      ? existing.slug
      : await uniqueSlug(db, slugify(name), req.params.id);
    await db.query(
      'UPDATE website_products SET category=?, name=?, description=?, image_url=?, sort_order=?, is_active=?, slug=?, gallery_images=?, material=?, dimensions=? WHERE id=?',
      [category, name, description || '', image_url || '', sort_order || 0, is_active ?? 1, slug,
       JSON.stringify(gallery_images || []), material || '', dimensions || '', req.params.id]
    );
    res.json({ message: 'Product updated', slug });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.delete('/admin/products/:id', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    await db.query('DELETE FROM website_products WHERE id=?', [req.params.id]);
    res.json({ message: 'Product deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Process steps ──
router.get('/admin/process', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_process_steps ORDER BY sort_order, step_no');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post('/admin/process', auth, adminOnly, async (req, res) => {
  try {
    const { step_no, title, description, image_url, sort_order, is_active } = req.body;
    const db = await getPool();
    const [r] = await db.query(
      'INSERT INTO website_process_steps (step_no, title, description, image_url, sort_order, is_active) VALUES (?,?,?,?,?,?)',
      [step_no || 1, title, description || '', image_url || '', sort_order || 0, is_active ?? 1]
    );
    res.json({ id: r.insertId, message: 'Step added' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.put('/admin/process/:id', auth, adminOnly, async (req, res) => {
  try {
    const { step_no, title, description, image_url, sort_order, is_active } = req.body;
    const db = await getPool();
    await db.query(
      'UPDATE website_process_steps SET step_no=?, title=?, description=?, image_url=?, sort_order=?, is_active=? WHERE id=?',
      [step_no || 1, title, description || '', image_url || '', sort_order || 0, is_active ?? 1, req.params.id]
    );
    res.json({ message: 'Step updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.delete('/admin/process/:id', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    await db.query('DELETE FROM website_process_steps WHERE id=?', [req.params.id]);
    res.json({ message: 'Step deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Testimonials ──
router.get('/admin/testimonials', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_testimonials ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post('/admin/testimonials', auth, adminOnly, async (req, res) => {
  try {
    const { client_name, client_role, quote, rating, sort_order, is_active } = req.body;
    const db = await getPool();
    const [r] = await db.query(
      'INSERT INTO website_testimonials (client_name, client_role, quote, rating, sort_order, is_active) VALUES (?,?,?,?,?,?)',
      [client_name, client_role || '', quote, rating || 5, sort_order || 0, is_active ?? 1]
    );
    res.json({ id: r.insertId, message: 'Testimonial added' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.put('/admin/testimonials/:id', auth, adminOnly, async (req, res) => {
  try {
    const { client_name, client_role, quote, rating, sort_order, is_active } = req.body;
    const db = await getPool();
    await db.query(
      'UPDATE website_testimonials SET client_name=?, client_role=?, quote=?, rating=?, sort_order=?, is_active=? WHERE id=?',
      [client_name, client_role || '', quote, rating || 5, sort_order || 0, is_active ?? 1, req.params.id]
    );
    res.json({ message: 'Testimonial updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.delete('/admin/testimonials/:id', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    await db.query('DELETE FROM website_testimonials WHERE id=?', [req.params.id]);
    res.json({ message: 'Testimonial deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Team ──
router.get('/admin/team', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_team ORDER BY sort_order, id');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.post('/admin/team', auth, adminOnly, async (req, res) => {
  try {
    const { name, designation, image_url, sort_order, is_active } = req.body;
    const db = await getPool();
    const [r] = await db.query(
      'INSERT INTO website_team (name, designation, image_url, sort_order, is_active) VALUES (?,?,?,?,?)',
      [name, designation || '', image_url || '', sort_order || 0, is_active ?? 1]
    );
    res.json({ id: r.insertId, message: 'Team member added' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.put('/admin/team/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, designation, image_url, sort_order, is_active } = req.body;
    const db = await getPool();
    await db.query(
      'UPDATE website_team SET name=?, designation=?, image_url=?, sort_order=?, is_active=? WHERE id=?',
      [name, designation || '', image_url || '', sort_order || 0, is_active ?? 1, req.params.id]
    );
    res.json({ message: 'Team member updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.delete('/admin/team/:id', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    await db.query('DELETE FROM website_team WHERE id=?', [req.params.id]);
    res.json({ message: 'Team member deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Media library ──
router.get('/admin/media', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const { category } = req.query;
    const [rows] = category
      ? await db.query('SELECT * FROM website_media WHERE category=? ORDER BY id DESC', [category])
      : await db.query('SELECT * FROM website_media ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/admin/media/upload', auth, adminOnly, websiteUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image uploaded' });
    const db = await getPool();
    const { alt_text, category } = req.body;
    const [r] = await db.query(
      'INSERT INTO website_media (url, public_id, alt_text, category) VALUES (?,?,?,?)',
      [req.file.path, req.file.filename, alt_text || '', category || 'general']
    );
    res.json({ id: r.insertId, url: req.file.path, message: 'Image uploaded' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/admin/media/:id', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [[media]] = await db.query('SELECT public_id FROM website_media WHERE id=?', [req.params.id]);
    if (media?.public_id) {
      cloudinary.uploader.destroy(media.public_id).catch(() => {});
    }
    await db.query('DELETE FROM website_media WHERE id=?', [req.params.id]);
    res.json({ message: 'Image deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Enquiries (leads from the contact form) ──
router.get('/admin/enquiries', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.query('SELECT * FROM website_enquiries ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.patch('/admin/enquiries/:id', auth, adminOnly, async (req, res) => {
  try {
    const db = await getPool();
    await db.query('UPDATE website_enquiries SET status=? WHERE id=?', [req.body.status, req.params.id]);
    res.json({ message: 'Status updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = { router, initWebsiteTables };
