const nodemailer = require('nodemailer');

// ── Fixed System Email (OTP / Forgot Password) ────────────────────────────────
// Credentials are stored in app_settings (system_email, system_email_password).
// Admin sets these from Settings → Email tab. No .env needed.
const SYSTEM_FROM_NAME = 'MOJI INNOVATORS LLP';
let _systemTransporter    = null;
let _systemConfigStr      = null;

async function getSystemConfig(db) {
  const [rows] = await db.query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('system_email','system_email_password')"
  );
  const cfg = {};
  rows.forEach(r => { cfg[r.setting_key] = r.setting_value; });
  return cfg;
}

async function getSystemTransporter(db) {
  try {
    const cfg = await getSystemConfig(db);
    if (!cfg.system_email || !cfg.system_email_password) {
      console.error('❌ system_email / system_email_password not configured in Settings → Email tab.');
      return null;
    }
    const cfgStr = JSON.stringify(cfg);
    if (cfgStr !== _systemConfigStr) {
      _systemConfigStr = cfgStr;
      _systemTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: cfg.system_email, pass: cfg.system_email_password },
      });
    }
    return { transporter: _systemTransporter, fromEmail: cfg.system_email };
  } catch (err) {
    console.error('System transporter error:', err.message);
    return null;
  }
}

/**
 * Send an email from the fixed system address configured in Settings.
 * Used for OTP / forgot-password / username-recovery emails only.
 * Reads system_email + system_email_password from app_settings — no .env needed.
 */
async function sendSystemEmail(db, { to, subject, html }) {
  try {
    if (!to || !subject) return;
    const t = await getSystemTransporter(db);
    if (!t) return;
    await t.transporter.sendMail({
      from: `"${SYSTEM_FROM_NAME}" <${t.fromEmail}>`,
      to,
      subject,
      html,
    });
    console.log(`✅ System email sent → ${to} | ${subject}`);
  } catch (err) {
    console.error('❌ System email error:', err.message);
  }
}

// ── Configurable SMTP (notifications, task updates, etc.) ────────────────────
let _transporter = null;
let _configStr = null;

async function getConfig(db) {
  const [rows] = await db.query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('smtp_email','smtp_password','smtp_name','smtp_enabled')"
  );
  const cfg = {};
  rows.forEach(r => { cfg[r.setting_key] = r.setting_value; });
  return cfg;
}

async function getTransporter(db) {
  try {
    const cfg = await getConfig(db);
    if (cfg.smtp_enabled !== 'true' || !cfg.smtp_email || !cfg.smtp_password) return null;

    const cfgStr = JSON.stringify(cfg);
    if (cfgStr !== _configStr) {
      _configStr = cfgStr;
      _transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: cfg.smtp_email, pass: cfg.smtp_password },
      });
    }
    return {
      transporter: _transporter,
      from: `"${cfg.smtp_name || 'MOJI INNOVATORS LLP'}" <${cfg.smtp_email}>`,
      replyTo: cfg.smtp_email,
    };
  } catch (err) {
    console.error('Email transporter error:', err.message);
    return null;
  }
}

async function sendEmail(db, { to, subject, html }) {
  try {
    if (!to || !subject) return;
    const t = await getTransporter(db);
    if (!t) return;
    await t.transporter.sendMail({ from: t.from, replyTo: t.replyTo, to, subject, html });
    console.log(`✅ Email sent → ${to} | ${subject}`);
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

// Get admin emails from app_settings
async function getAdminEmails(db) {
  try {
    const [[row]] = await db.query(
      "SELECT setting_value FROM app_settings WHERE setting_key='admin_emails'"
    );
    if (!row?.setting_value) return [];
    return row.setting_value.split(',').map(e => e.trim()).filter(Boolean);
  } catch { return []; }
}

// Get worker email from app_settings
async function getWorkerEmail(db, workerId) {
  try {
    const [[row]] = await db.query(
      "SELECT setting_value FROM app_settings WHERE setting_key=?",
      [`worker_email_${workerId}`]
    );
    return row?.setting_value || null;
  } catch { return null; }
}

// Send email to all admins
async function emailAdmins(db, { subject, html }) {
  const emails = await getAdminEmails(db);
  for (const email of emails) {
    await sendEmail(db, { to: email, subject, html });
  }
}

// ── HTML Templates ────────────────────────────────────────────────────────────

function baseTemplate(title, color, bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#f3f4f6;font-family:Arial,sans-serif">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <div style="background:#1e293b;padding:20px 24px;display:flex;align-items:center;gap:12px">
      <div style="width:10px;height:10px;border-radius:50%;background:${color}"></div>
      <h2 style="color:#fff;margin:0;font-size:18px;font-weight:700">${title}</h2>
    </div>
    <div style="padding:24px">${bodyHtml}</div>
    <div style="background:#f9fafb;padding:12px 24px;border-top:1px solid #e5e7eb;text-align:center">
      <p style="color:#9ca3af;font-size:11px;margin:0">Workshop Management System — Automated Email</p>
    </div>
  </div>
</body></html>`;
}

function taskAssignedEmail({ workerName, taskTitle, projectName, itemName, quantity, dueDate, deptName }) {
  const body = `
    <p style="color:#374151;margin:0 0 16px">Hi <strong>${workerName}</strong>,</p>
    <p style="color:#374151;margin:0 0 16px">A new task has been assigned to you:</p>
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:6px;padding:16px;margin:0 0 16px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:4px 0;color:#78350f;font-size:13px;width:120px"><strong>Task</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${taskTitle}</td></tr>
        <tr><td style="padding:4px 0;color:#78350f;font-size:13px"><strong>Project</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${projectName}</td></tr>
        ${itemName ? `<tr><td style="padding:4px 0;color:#78350f;font-size:13px"><strong>Item</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${itemName}</td></tr>` : ''}
        ${deptName ? `<tr><td style="padding:4px 0;color:#78350f;font-size:13px"><strong>Department</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${deptName}</td></tr>` : ''}
        ${quantity ? `<tr><td style="padding:4px 0;color:#78350f;font-size:13px"><strong>Quantity</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${quantity}</td></tr>` : ''}
        ${dueDate ? `<tr><td style="padding:4px 0;color:#78350f;font-size:13px"><strong>Due Date</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${dueDate}</td></tr>` : ''}
      </table>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0">Please login to your account to view task details and update progress.</p>`;
  return { subject: `New Task Assigned: ${taskTitle}`, html: baseTemplate('New Task Assigned', '#f59e0b', body) };
}

function taskProgressEmail({ workerName, taskTitle, projectName, oldQty, newQty, totalQty, newStatus }) {
  const body = `
    <p style="color:#374151;margin:0 0 16px">Hi <strong>Admin</strong>,</p>
    <p style="color:#374151;margin:0 0 16px"><strong>${workerName}</strong> has updated a task:</p>
    <div style="background:#f0fdf4;border-left:4px solid #22c55e;border-radius:6px;padding:16px;margin:0 0 16px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:4px 0;color:#166534;font-size:13px;width:120px"><strong>Task</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${taskTitle}</td></tr>
        <tr><td style="padding:4px 0;color:#166534;font-size:13px"><strong>Project</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${projectName}</td></tr>
        <tr><td style="padding:4px 0;color:#166534;font-size:13px"><strong>Progress</strong></td><td style="padding:4px 0;font-size:13px">
          <span style="color:#dc2626;text-decoration:line-through">${oldQty}/${totalQty}</span>
          <span style="color:#6b7280;margin:0 6px">→</span>
          <span style="color:#16a34a;font-weight:bold">${newQty}/${totalQty}</span>
        </td></tr>
        <tr><td style="padding:4px 0;color:#166534;font-size:13px"><strong>Status</strong></td><td style="padding:4px 0;color:#374151;font-size:13px;text-transform:capitalize">${newStatus}</td></tr>
      </table>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0">Login to your admin panel to review the update.</p>`;
  return { subject: `Task Progress Update: ${taskTitle} — ${newQty}/${totalQty}`, html: baseTemplate('Task Progress Update', '#22c55e', body) };
}

function taskCompletedEmail({ taskTitle, projectName, workerName }) {
  const body = `
    <p style="color:#374151;margin:0 0 16px">Hi <strong>Admin</strong>,</p>
    <p style="color:#374151;margin:0 0 16px">A task has been <strong>completed</strong>:</p>
    <div style="background:#f0fdf4;border-left:4px solid #22c55e;border-radius:6px;padding:16px;margin:0 0 16px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:4px 0;color:#166534;font-size:13px;width:120px"><strong>Task</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${taskTitle}</td></tr>
        <tr><td style="padding:4px 0;color:#166534;font-size:13px"><strong>Project</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${projectName}</td></tr>
        ${workerName ? `<tr><td style="padding:4px 0;color:#166534;font-size:13px"><strong>Completed by</strong></td><td style="padding:4px 0;color:#374151;font-size:13px">${workerName}</td></tr>` : ''}
      </table>
    </div>`;
  return { subject: `✅ Task Completed: ${taskTitle}`, html: baseTemplate('Task Completed', '#22c55e', body) };
}

function itemCompletedEmail({ projectName }) {
  const body = `
    <p style="color:#374151;margin:0 0 16px">Hi <strong>Admin</strong>,</p>
    <p style="color:#374151;margin:0 0 16px">All stages of a project item have been <strong>completed</strong>:</p>
    <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:6px;padding:16px;margin:0 0 16px">
      <p style="margin:0;color:#1e40af;font-size:13px"><strong>Project:</strong> ${projectName}</p>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0">Login to your admin panel to review the completed item.</p>`;
  return { subject: `✅ Project Item Completed — ${projectName}`, html: baseTemplate('Item Completed', '#3b82f6', body) };
}

module.exports = {
  sendEmail, sendSystemEmail, emailAdmins, getAdminEmails, getWorkerEmail,
  taskAssignedEmail, taskProgressEmail, taskCompletedEmail, itemCompletedEmail
};
