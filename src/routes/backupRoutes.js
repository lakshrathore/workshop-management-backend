const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const multer = require('multer');

const { createBackup, restoreBackup, getBackupStatus, BACKUP_DIR } = require('../services/backupService');
const { uploadBackupFile, listBackups, downloadBackupFile, deleteBackupFile } = require('../services/googleDriveService');

// Middleware - Admin only
const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'workshop_secret_2024';
    req.user = jwt.verify(token, JWT_SECRET);
    
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin only' });
    }
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Upload local backup file
const upload = multer({ dest: path.join(BACKUP_DIR, 'uploads') });

// ── MANUAL BACKUP ──────────────────────────────────────────────────────────
router.post('/backup/manual', adminAuth, async (req, res) => {
  try {
    console.log('🔄 Creating manual backup...');
    
    const backup = await createBackup(`backup-manual-${moment().format('YYYY-MM-DD-HHmm')}`);
    
    // Try to upload to Google Drive if available
    let gdResult = null;
    try {
      gdResult = await uploadBackupFile(backup.path, backup.name, 'manual-backups');
      console.log('☁️ Uploaded to Google Drive');
    } catch (gdErr) {
      console.warn('⚠️ Could not upload to Google Drive:', gdErr.message);
    }

    res.json({
      success: true,
      backup: {
        name: backup.name,
        size: backup.size,
        timestamp: backup.timestamp,
        local: true,
        googleDrive: gdResult ? true : false,
      },
    });
  } catch (err) {
    console.error('Backup error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET BACKUP STATUS ──────────────────────────────────────────────────────
router.get('/backup/status', adminAuth, async (req, res) => {
  try {
    const localStatus = await getBackupStatus();
    
    let driveBackups = [];
    try {
      driveBackups = await listBackups('manual-backups');
    } catch {
      // Google Drive not configured - that's ok
    }

    res.json({
      local: localStatus,
      googleDrive: driveBackups.slice(0, 10), // Last 10
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── LIST LOCAL BACKUPS ──────────────────────────────────────────────────────
router.get('/backup/list-local', adminAuth, async (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return res.json({ backups: [] });
    }

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const fullPath = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(fullPath);
        return {
          name: f,
          size: Math.round(stat.size / 1024 / 1024),
          timestamp: stat.mtime,
          id: f,
        };
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ backups: files });
  } catch (err) {
    res.status(500).json({ backups: [], error: err.message });
  }
});

// ── LIST GOOGLE DRIVE BACKUPS ──────────────────────────────────────────────────────
router.get('/backup/list-drive', adminAuth, async (req, res) => {
  try {
    const folder = req.query.folder || 'manual-backups';
    const backups = await listBackups(folder);
    res.json({ backups });
  } catch (err) {
    // Google Drive not configured - return empty list
    console.warn('⚠️ Could not list Google Drive backups:', err.message);
    res.json({ backups: [] });
  }
});

// ── RESTORE FROM LOCAL ──────────────────────────────────────────────────────
router.post('/backup/restore-local/:name', adminAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const zipPath = path.join(BACKUP_DIR, name);

    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ success: false, message: 'Backup not found' });
    }

    console.log(`🔄 Restoring from: ${name}`);
    const result = await restoreBackup(zipPath);

    res.json({
      success: true,
      message: 'Backup restored successfully',
      timestamp: result.timestamp,
    });
  } catch (err) {
    console.error('Restore error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── RESTORE FROM GOOGLE DRIVE ──────────────────────────────────────────────────────
router.post('/backup/restore-drive/:fileId', adminAuth, async (req, res) => {
  try {
    const { fileId } = req.params;
    
    // Download from Google Drive
    const tempPath = path.join(BACKUP_DIR, `temp-${moment().format('YYYYMMDDHHmmss')}.zip`);
    await downloadBackupFile(fileId, tempPath);

    // Restore
    const result = await restoreBackup(tempPath);

    // Cleanup
    fs.unlinkSync(tempPath);

    res.json({
      success: true,
      message: 'Backup restored from Google Drive',
      timestamp: result.timestamp,
    });
  } catch (err) {
    console.error('Google Drive restore error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── UPLOAD LOCAL BACKUP FILE ──────────────────────────────────────────────────────
router.post('/backup/upload-local', adminAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const zipPath = req.file.path;
    const backupName = `backup-uploaded-${moment().format('YYYY-MM-DD-HHmm')}.zip`;
    const newPath = path.join(BACKUP_DIR, backupName);

    fs.renameSync(zipPath, newPath);

    res.json({
      success: true,
      message: 'Backup file uploaded',
      backup: {
        name: backupName,
        size: Math.round(req.file.size / 1024 / 1024),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE LOCAL BACKUP ──────────────────────────────────────────────────────
router.delete('/backup/local/:name', adminAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const zipPath = path.join(BACKUP_DIR, name);

    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ success: false, message: 'Backup not found' });
    }

    fs.unlinkSync(zipPath);
    res.json({ success: true, message: 'Backup deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE GOOGLE DRIVE BACKUP ──────────────────────────────────────────────────────
router.delete('/backup/drive/:fileId', adminAuth, async (req, res) => {
  try {
    const { fileId } = req.params;
    await deleteBackupFile(fileId);
    res.json({ success: true, message: 'Backup deleted from Google Drive' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DOWNLOAD LOCAL BACKUP ──────────────────────────────────────────────────────
router.get('/backup/download/:name', adminAuth, (req, res) => {
  try {
    const { name } = req.params;
    const zipPath = path.join(BACKUP_DIR, name);

    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ success: false, message: 'Backup not found' });
    }

    res.download(zipPath, name);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
