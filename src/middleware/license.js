const axios = require('axios');
const { machineIdSync } = require('node-machine-id');
const { getPool } = require('../database');

const LICENSE_SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
const CACHE_DURATION = 30 * 1000;
let cachedStatus = null;
let lastCheck = null;

function getMachineId() {
  try {
    return machineIdSync(true);
  } catch {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    for (const iface of Object.values(networkInterfaces)) {
      for (const net of iface) {
        if (!net.internal && net.mac !== '00:00:00:00:00:00') {
          return require('crypto').createHash('sha256').update(net.mac + os.hostname()).digest('hex');
        }
      }
    }
    return require('crypto').createHash('sha256').update(os.hostname() + require('os').cpus()[0]?.model).digest('hex');
  }
}

async function checkLicenseStatus() {
  const machineId = getMachineId();
  const now = Date.now();
  if (cachedStatus && lastCheck && (now - lastCheck) < CACHE_DURATION) return cachedStatus;
  try {
    const res = await axios.post(`${LICENSE_SERVER}/api/license/check`, { machine_id: machineId }, { timeout: 5000 });
    cachedStatus = res.data;
    lastCheck = now;
    const db = await getPool();
    await db.query(`INSERT INTO license_cache (machine_id, status, days_left, last_checked) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE status=VALUES(status), days_left=VALUES(days_left), last_checked=NOW()`,
      [machineId, res.data.status, res.data.days_left || 0]);
    return res.data;
  } catch (err) {
    try {
      const db = await getPool();
      const [rows] = await db.query('SELECT * FROM license_cache WHERE machine_id=?', [machineId]);
      if (rows.length > 0) {
        const cached = rows[0];
        const hoursSince = (now - new Date(cached.last_checked).getTime()) / 3600000;
        if (cached.status === 'active' && hoursSince < 24) return { status: 'active', days_left: cached.days_left, offline: true };
      }
    } catch {}
    return { status: 'server_unreachable', offline: true };
  }
}

const licenseGuard = async (req, res, next) => {
  try {
    const status = await checkLicenseStatus();
    if (status.status === 'active' || status.status === 'trial') return next();
    return res.status(402).json({ blocked: true, status: status.status, message: 'License expired', machine_id: getMachineId() });
  } catch { next(); }
};

const getLicenseInfo = async (req, res) => {
  cachedStatus = null; lastCheck = null;
  const machineId = getMachineId();
  try {
    const status = await checkLicenseStatus();
    res.json({ ...status, machine_id: machineId });
  } catch { res.json({ status: 'unknown', machine_id: machineId }); }
};

const activateLicense = async (req, res) => {
  const { license_key } = req.body;
  const machineId = getMachineId();
  cachedStatus = null; lastCheck = null;
  try {
    const response = await axios.post(`${LICENSE_SERVER}/api/license/activate`, { machine_id: machineId, license_key }, { timeout: 10000 });
    res.json(response.data);
  } catch { res.status(500).json({ success: false, message: 'Could not connect to license server.' }); }
};

const submitPayment = async (req, res) => {
  const machineId = getMachineId();
  try {
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('machine_id', machineId);
    formData.append('customer_name', req.body.customer_name || '');
    formData.append('customer_phone', req.body.customer_phone || '');
    formData.append('transaction_id', req.body.transaction_id || '');
    formData.append('amount', req.body.amount || '');
    formData.append('message', req.body.message || '');
    if (req.file) {
      const fs = require('fs');
      try {
        const fileBuffer = fs.readFileSync(req.file.path);
        formData.append('screenshot', fileBuffer, req.file.originalname);
      } catch (fileErr) {
        console.error('File read error:', fileErr);
        return res.status(400).json({ success: false, message: 'Screenshot read error: ' + fileErr.message });
      }
    }
    const response = await axios.post(`${LICENSE_SERVER}/api/license/payment`, formData, { headers: formData.getHeaders(), timeout: 30000 });
    if (req.file) { try { require('fs').unlinkSync(req.file.path); } catch {} }
    res.json(response.data);
  } catch (err) {
    console.error('submitPayment error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || 'Could not submit payment: ' + err.message });
  }
};

const getPaymentInfo = async (req, res) => {
  try {
    const response = await axios.get(`${LICENSE_SERVER}/api/license/payment-info`, { timeout: 5000 });
    res.json(response.data);
  } catch {
    res.json({ success: true, upi_id: 'lakhanrathore362@ybl', upi_name: 'Workshop Manager', amount: 10000, upi_url: 'upi://pay?pa=lakhanrathore362@ybl&pn=Workshop%20Manager&am=10000&cu=INR', currency: 'INR' });
  }
};

module.exports = { licenseGuard, getLicenseInfo, activateLicense, submitPayment, getPaymentInfo, getMachineId };
