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

app.use(cors({ origin: '*' }));
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
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE username=? AND is_active=1', [username]);
    if (!rows.length) return res.status(401).json({ message: 'Invalid credentials' });
    if (!bcrypt.compareSync(password, rows[0].password)) return res.status(401).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ id: rows[0].id, name: rows[0].name, username: rows[0].username, role: rows[0].role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    const [depts] = await db.query(`SELECT d.* FROM departments d LEFT JOIN worker_departments wd ON wd.department_id=d.id WHERE wd.worker_id=?`, [rows[0].id]).catch(() => [[]]);
    res.json({ token, user: { id: rows[0].id, name: rows[0].name, username: rows[0].username, role: rows[0].role, departments: depts[0] || [] } });
  } catch(err) {
    console.error('Login error:', err.message);
    res.status(500).json({ message: 'Login failed' });
  }
});

const apiRoutes = require('./routes');
const backupRoutes = require('./routes/backupRoutes');
app.use('/api', apiRoutes);
app.use('/api', backupRoutes);

app.get('/health', (req, res) => res.json({ status: 'OK' }));

// === SERVE REACT FRONTEND (for Electron / production) ===
const frontendBuild = path.join(__dirname, '..', '..', 'frontend', 'build');
app.use(express.static(frontendBuild));
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendBuild, 'index.html'), (err) => {
    if (err) {
      res.status(404).json({ message: 'Frontend not found', path: frontendBuild });
    }
  });
});

initializeDatabase().then(() => {
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
