require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { initializeDatabase } = require('./database');
const { licenseGuard, getLicenseInfo, activateLicense, submitPayment, getPaymentInfo } = require('./middleware/license');

const app = express();
const PORT = process.env.PORT || 5000;

// CORS Configuration - Allow frontend from different server
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests from:
    // 1. Environment variable (e.g., FRONTEND_URL=https://yourdomain.com)
    // 2. Vercel deployments (*.vercel.app)
    // 3. Same origin
    // 4. Any origin if ALLOW_ALL_ORIGINS=true
    
    const allowedOrigins = [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
    ].filter(Boolean);

    if (process.env.ALLOW_ALL_ORIGINS === 'true') {
      console.log('⚠️ CORS: Allowing all origins (ALLOW_ALL_ORIGINS=true)');
      callback(null, true);
    } else if (!origin || allowedOrigins.some(allowed => origin.includes(allowed)) || origin.includes('vercel.app')) {
      console.log(`✅ CORS: Allowing origin: ${origin || 'same-origin'}`);
      callback(null, true);
    } else {
      console.warn(`❌ CORS: Blocked origin: ${origin}`);
      callback(new Error('CORS policy violation'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cloudinary upload (license screenshots)
const { licenseUpload } = require('./services/cloudinaryStorage');
const upload = licenseUpload;

// === LICENSE ROUTES (no guard) ===
app.get('/api/license/info', getLicenseInfo);
app.post('/api/license/activate', activateLicense);
app.post('/api/license/payment', upload.single('screenshot'), submitPayment);
app.get('/api/license/payment-info', getPaymentInfo);

// === PROTECTED API ROUTES (DISABLED - License blocking disabled) ===
// app.use('/api', licenseGuard);

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getPool } = require('./database');

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const db = await getPool();
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE username=? AND is_active=1', [username]);
    if (!rows.length) return res.status(401).json({ message: 'Invalid credentials' });
    if (!bcrypt.compareSync(password, rows[0].password)) {
      try {
        await db.query(
          'INSERT INTO login_logs (user_id, user_role, user_name, action, ip_address, user_agent) VALUES (?,?,?,?,?,?)',
          [rows[0].id, rows[0].role, rows[0].name, 'LOGIN_FAILED', ip, ua]
        );
      } catch(e) { console.error('Audit insert error:', e.message); }
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    try {
      await db.query(
        'INSERT INTO login_logs (user_id, user_role, user_name, action, ip_address, user_agent) VALUES (?,?,?,?,?,?)',
        [rows[0].id, rows[0].role, rows[0].name, 'LOGIN', ip, ua]
      );
      console.log('Login logged for:', rows[0].name, rows[0].role);
    } catch(e) { console.error('Audit insert error:', e.message); }
    const token = jwt.sign({ id: rows[0].id, name: rows[0].name, username: rows[0].username, role: rows[0].role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    const [depts] = await db.query(`SELECT d.* FROM departments d LEFT JOIN worker_departments wd ON wd.department_id=d.id WHERE wd.worker_id=?`, [rows[0].id]).catch(() => [[]]);
    res.json({ token, user: { id: rows[0].id, name: rows[0].name, username: rows[0].username, role: rows[0].role, departments: depts[0] || [] } });
  } catch(err) {
    console.error('Login error:', err.message);
    res.status(500).json({ message: 'Login failed' });
  }
});

const apiRoutes = require('./routes');
// const backupRoutes = require('./routes/backupRoutes');  // BACKUP SYSTEM DISABLED
app.use('/api', apiRoutes);

// ── CLIENT PORTAL ROUTES ──────────────────────────────────────────────────────
const clientRoutes = require('./routes/clientRoutes');
app.use('/api', clientRoutes);
// app.use('/api', backupRoutes);  // BACKUP SYSTEM DISABLED

// Multer error handling middleware
app.use((err, req, res, next) => {
  console.error('🔴 Middleware error caught:', err.message, err.code);

  // Multer file size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'File bahut bada hai! Max size check karo.' });
  }

  // Multer file count error
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ message: 'Zyada saare files upload karne ki koshish ki' });
  }

  // Multer file type error
  if (err instanceof multer.MulterError) {
    console.error('MulterError:', err.code, err.message);
    return res.status(400).json({ message: `Upload error: ${err.message}` });
  }

  // File type not allowed
  if (err.message && (err.message.includes('File type') || err.message.includes('only') || err.message.includes('allowed'))) {
    return res.status(400).json({ message: err.message || 'Yeh file type supported nahi hai' });
  }

  // Cloudinary errors
  if (err.message && err.message.includes('cloudinary')) {
    console.error('Cloudinary error:', err);
    return res.status(500).json({ message: 'Image service abhi kaam nahi kar raha, baad mein try karo' });
  }

  // Any other error with message
  if (err.message && req.path.includes('/mo-references')) {
    console.error('MO Reference route error:', err.message);
    return res.status(500).json({ message: `Upload error: ${err.message}` });
  }

  // Pass to next handler if not caught
  next(err);
});

app.get('/health', (req, res) => res.json({ status: 'OK' }));

// Frontend is deployed on Vercel, not here
app.get('*', (req, res) => {
  res.status(404).json({ message: 'API endpoint not found. Frontend is at https://workshop-management-frontend-885d.vercel.app' });
});

initializeDatabase().then(async () => {
  // Client portal tables initialize karo
  const clientRoutesModule = require('./routes/clientRoutes');
  const initFn = clientRoutesModule.initClientTables;
  if (typeof initFn === 'function') {
    await initFn().catch(err => console.error('Client tables init error:', err.message));
  } else {
    console.warn('⚠️ initClientTables not found — skipping client table init');
  }
  const os = require('os');
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Workshop Manager API`);
    console.log(`   Local:  http://localhost:${PORT}`);
    console.log(`   Mobile: http://${localIP}:${PORT}`);
    console.log(`📋 Admin: admin / admin123\n`);
  });
}).catch(err => {
  console.error('❌ DB Error:', err.message);
  process.exit(1);
});
