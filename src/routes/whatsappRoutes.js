// ── WhatsApp approval-alert settings (Settings → WhatsApp tab) ───────────────
//   GET    /api/settings/whatsapp          saved number + on/off
//   PUT    /api/settings/whatsapp          update number + on/off
//   GET    /api/settings/whatsapp/status   connection status (+ QR to scan)
//   POST   /api/settings/whatsapp/test     send a test alert to the saved number
//   POST   /api/settings/whatsapp/reset    unlink and show a new QR

const express = require('express');
const router = express.Router();
const { getPool } = require('../database');
const { auth, adminOrPermission } = require('../middleware/authHelpers');
const auditLog = require('../middleware/auditLog');
const { formatPhoneNumber, getWhatsAppStatus, resetWhatsAppSession, sendWhatsAppNotification } = require('../services/whatsappService');
const { getAlertSettings, buildApprovalMessage } = require('../services/approvalAlerts');

const canRead = [auth, adminOrPermission('settings', 'read')];
const canEdit = [auth, adminOrPermission('settings', 'edit')];

router.get('/settings/whatsapp', ...canRead, async (req, res) => {
  try {
    const { number, enabled } = await getAlertSettings();
    res.json({ admin_whatsapp_number: number, is_whatsapp_approval_alerts_enabled: enabled });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/settings/whatsapp', ...canEdit, auditLog('UPDATE', 'Settings'), async (req, res) => {
  try {
    const { admin_whatsapp_number, is_whatsapp_approval_alerts_enabled } = req.body || {};
    const updates = [];

    if (admin_whatsapp_number !== undefined) {
      const raw = String(admin_whatsapp_number || '').trim();
      const formatted = raw ? formatPhoneNumber(raw) : '';
      if (raw && !formatted) {
        return res.status(400).json({ message: 'Enter a valid WhatsApp number, e.g. 9876543210 or +91 98765 43210' });
      }
      updates.push(['admin_whatsapp_number', formatted]);
    }
    if (is_whatsapp_approval_alerts_enabled !== undefined) {
      const on = [true, 'true', 1, '1'].includes(is_whatsapp_approval_alerts_enabled);
      updates.push(['is_whatsapp_approval_alerts_enabled', on ? '1' : '0']);
    }

    const db = await getPool();
    for (const [key, value] of updates) {
      await db.query(
        'INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_by=VALUES(updated_by)',
        [key, value, req.user.id],
      );
    }
    const saved = await getAlertSettings();
    res.json({ message: 'WhatsApp settings saved', admin_whatsapp_number: saved.number, is_whatsapp_approval_alerts_enabled: saved.enabled });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/settings/whatsapp/status', ...canRead, (req, res) => {
  res.json(getWhatsAppStatus());
});

router.post('/settings/whatsapp/test', ...canEdit, async (req, res) => {
  try {
    const { number } = await getAlertSettings();
    if (!number) return res.status(400).json({ message: 'Save an admin WhatsApp number first' });
    const message = buildApprovalMessage({
      moduleName: 'Test Alert', referenceId: 'TEST', workerName: req.user.name || 'Admin',
      remarks: 'This is a test message. WhatsApp approval alerts are working.',
    });
    const result = await sendWhatsAppNotification(number, message);
    if (result.sent) return res.json({ message: `Test message sent to +${number}` });
    const reasons = {
      service_disabled: 'WhatsApp service is not running on this server',
      queued_until_connected: 'WhatsApp is not connected yet — scan the QR code first. The test will be sent once connected.',
      invalid_number: 'The saved number is not valid',
    };
    res.status(503).json({ message: reasons[result.reason] || `Could not send: ${result.reason}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/settings/whatsapp/reset', ...canEdit, auditLog('UPDATE', 'Settings'), async (req, res) => {
  try {
    await resetWhatsAppSession();
    res.json({ message: 'WhatsApp unlinked. Scan the new QR code to link again.' });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;
