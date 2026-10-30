// ── Send a document via WhatsApp ───────────────────────────────────────────────
// POST /api/whatsapp/send-document   (multipart/form-data)
//   phone          recipient, e.g. "9876543210" (+91 added for 10 digits)
//   documentType   SALE_CHALLAN | SALE_INVOICE | MANUFACTURING_REPORT | QUOTATION |
//                  QUALITY_REPORT | CFT_SHEET | DELIVERY_CHALLAN_BOXES
//   referenceId    the document's id/number (used in caption, file name, audit log)
//   customCaption  optional message sent with the file
//   fileName       optional file name
//   and ONE of:
//     html  (file)  the printable HTML the page already builds → rendered to PDF here
//     file  (file)  a ready PDF / DOCX / XLSX → sent as-is
//
// The app's documents are built in the browser (no server-side copies), so the
// browser uploads the same HTML it prints and we turn it into a PDF.

const { getPool } = require('../database');
const { adminOrPermission } = require('../middleware/authHelpers');
const { renderHtmlToPdf } = require('../services/pdfRenderer');
const { sendWhatsAppDocument, formatPhoneNumber, mimeTypeFor, MIME_TYPES } = require('../services/whatsappService');

const DOCUMENT_TYPES = {
  SALE_CHALLAN: { label: 'Sale Challan', menu: 'sale_challans' },
  SALE_INVOICE: { label: 'Sale Invoice', menu: 'sale_challans' },
  MANUFACTURING_REPORT: { label: 'Manufacturing Order', menu: 'main_po' },
  QUOTATION: { label: 'Quotation', menu: 'quotations' },
  QUALITY_REPORT: { label: 'Quality Report', menu: 'quality_report' },
  CFT_SHEET: { label: 'CFT Sheet', menu: 'cft' },
  DELIVERY_CHALLAN_BOXES: { label: 'Delivery Challan vs Boxes Report', menu: 'packing' },
};

const FAIL_MESSAGES = {
  invalid_number: 'Enter a valid WhatsApp number, e.g. 9876543210',
  service_disabled: 'WhatsApp is not running on this server',
  not_connected: 'WhatsApp is not connected. Ask the admin to link it in Settings → WhatsApp Alerts.',
  not_on_whatsapp: 'This number is not on WhatsApp',
  file_too_large: 'The file is too large to send on WhatsApp',
  no_file: 'No document was attached',
};

// Same read permission as the page the document comes from.
function requireDocumentPermission(req, res, next) {
  const type = DOCUMENT_TYPES[req.body?.documentType];
  if (!type) return res.status(400).json({ message: `Unknown documentType. Use one of: ${Object.keys(DOCUMENT_TYPES).join(', ')}` });
  return adminOrPermission(type.menu, 'read')(req, res, next);
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);

async function companyName() {
  try {
    const db = await getPool();
    const [[row]] = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='company_name'");
    return row?.setting_value || '';
  } catch { return ''; }
}

async function sendDocument(req, res) {
  const { phone, documentType, referenceId, customCaption, baseUrl } = req.body || {};
  const type = DOCUMENT_TYPES[documentType];
  const ref = safeName(referenceId);

  if (!formatPhoneNumber(phone)) return res.status(400).json({ message: FAIL_MESSAGES.invalid_number });

  const htmlFile = req.files?.html?.[0];
  const upload = req.files?.file?.[0];
  if (!htmlFile && !upload) return res.status(400).json({ message: FAIL_MESSAGES.no_file });

  let buffer;
  let fileName;
  let mimeType;
  try {
    if (upload) {
      const allowed = Object.values(MIME_TYPES);
      mimeType = mimeTypeFor(upload.originalname, upload.mimetype);
      if (!allowed.includes(mimeType)) return res.status(400).json({ message: 'Only PDF, Word or Excel files can be sent' });
      buffer = upload.buffer;
      fileName = safeName(req.body.fileName) || safeName(upload.originalname);
    } else {
      buffer = await renderHtmlToPdf(htmlFile.buffer.toString('utf8'), { baseUrl });
      mimeType = MIME_TYPES.pdf;
      fileName = safeName(req.body.fileName) || `${type.label}${ref ? ` ${ref}` : ''}`;
      if (!/\.pdf$/i.test(fileName)) fileName += '.pdf';
    }
  } catch (err) {
    console.error('[whatsapp-doc] PDF render failed:', err.message);
    return res.status(500).json({ message: `Could not create the PDF: ${err.message}` });
  }

  const company = await companyName();
  const caption = String(customCaption || '').trim().slice(0, 1000)
    || `${type.label}${ref ? ` #${ref}` : ''}${company ? `\n${company}` : ''}`;

  // Sending failures are reported to the user, but never crash the request.
  const result = await sendWhatsAppDocument(phone, buffer, fileName, caption, mimeType);
  if (!result.sent) {
    const status = ['invalid_number', 'not_on_whatsapp', 'file_too_large'].includes(result.reason) ? 400 : 503;
    return res.status(status).json({ message: FAIL_MESSAGES[result.reason] || `WhatsApp send failed: ${result.reason}` });
  }
  console.log(`📤 [whatsapp-doc] ${documentType} ${ref} sent to +${result.phone} by user ${req.user.id}`);
  res.json({ message: `${type.label} sent to +${result.phone}`, fileName, size: buffer.length });
}

module.exports = { sendDocument, requireDocumentPermission, DOCUMENT_TYPES };
