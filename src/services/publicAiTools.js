// ─────────────────────────────────────────────────────────────────────────────
//  "Ask Moji" for the PUBLIC website — anonymous visitors.
//
//  SECURITY RULES (do not relax):
//   • Only data that is ALREADY public on the website: active products, published process
//     steps, a whitelist of site settings. Nothing from projects, clients, orders or users.
//   • SELECT only. The one "action", draft_enquiry, writes NOTHING — it only returns a
//     draft that the visitor must confirm in the widget, which then posts to the normal
//     /website/public/enquiry endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ROWS = 12;
const like = (s) => `%${String(s).trim().replace(/[%_\\]/g, '\\$&')}%`;
const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n));

// Only these settings are ever exposed.
const PUBLIC_SETTINGS = [
  'site_name', 'tagline', 'phone', 'whatsapp', 'email', 'address', 'business_hours',
  'stat_1_num', 'stat_1_label', 'stat_2_num', 'stat_2_label', 'stat_3_num', 'stat_3_label', 'stat_4_num', 'stat_4_label',
];

const tools = [];
function tool(name, description, properties, handler, required = []) {
  tools.push({ def: { name, description, input_schema: { type: 'object', properties, required } }, handler });
}
const S = (d) => ({ type: 'string', description: d });

const productRow = (r) => ({
  name: r.name, category: r.category, description: clip(r.description, 400),
  material: r.material, dimensions: r.dimensions, slug: r.slug,
});

tool('product_categories',
  'List the product categories on the website with how many products each has.',
  {},
  async (db) => {
    const [rows] = await db.query(`SELECT category, COUNT(*) AS products FROM website_products WHERE is_active = 1 GROUP BY category ORDER BY MIN(sort_order), category LIMIT 40`);
    return rows;
  });

tool('search_products',
  'Search the product catalogue by text (name / description / material / category) and/or category.',
  { query: S('Words to look for (optional)'), category: S('Exact or partial category name (optional)') },
  async (db, a) => {
    const where = ['is_active = 1']; const params = [];
    if (a.query) {
      where.push('(name LIKE ? OR description LIKE ? OR material LIKE ? OR category LIKE ?)');
      const q = like(a.query); params.push(q, q, q, q);
    }
    if (a.category) { where.push('category LIKE ?'); params.push(like(a.category)); }
    const [rows] = await db.query(
      `SELECT name, category, description, material, dimensions, slug FROM website_products WHERE ${where.join(' AND ')} ORDER BY sort_order, id LIMIT ?`,
      [...params, MAX_ROWS]);
    return { count: rows.length, products: rows.map(productRow) };
  });

tool('get_product',
  'Full details of one product by slug or name.',
  { slug: S('Product slug (optional)'), name: S('Part of product name (optional)') },
  async (db, a) => {
    let r;
    if (a.slug) [[r]] = await db.query('SELECT * FROM website_products WHERE slug = ? AND is_active = 1', [String(a.slug)]);
    else if (a.name) [[r]] = await db.query('SELECT * FROM website_products WHERE name LIKE ? AND is_active = 1 ORDER BY sort_order LIMIT 1', [like(a.name)]);
    if (!r) return { error: 'Product nahi mila.' };
    return { ...productRow(r), description: clip(r.description, 1500) };
  });

tool('company_info',
  'Company contact details, address, business hours and headline numbers (years, facility size, dealers, states).',
  {},
  async (db) => {
    const [rows] = await db.query('SELECT setting_key, setting_value FROM website_settings WHERE setting_key IN (?)', [PUBLIC_SETTINGS]);
    return Object.fromEntries(rows.filter(r => r.setting_value).map(r => [r.setting_key, r.setting_value]));
  });

tool('manufacturing_process',
  'The step-by-step manufacturing / working process as shown on the website.',
  {},
  async (db) => {
    const [rows] = await db.query('SELECT step_no, title, description FROM website_process_steps WHERE is_active = 1 ORDER BY sort_order, step_no LIMIT 15');
    return rows.map(r => ({ step: r.step_no, title: r.title, description: clip(r.description, 300) }));
  });

// Writes NOTHING. The route picks the draft out of ctx and the visitor confirms it in the widget.
tool('draft_enquiry',
  'Prepare an enquiry form for the visitor to review and send. Call this ONLY after the visitor has given their name and a phone number or email, and said they want to send an enquiry. Does not send anything by itself.',
  {
    name: S('Visitor name'),
    phone: S('Phone number (optional if email given)'),
    email: S('Email (optional if phone given)'),
    enquiry_type: S('e.g. Bulk order, Dealer, Hospitality project, Custom furniture, General'),
    message: S('Short summary of what they need: products, quantity, city, timeline'),
  },
  async (db, a, ctx) => {
    const name = clip(a.name, 120), phone = clip(a.phone, 30), email = clip(a.email, 150);
    if (!name || (!phone && !email)) return { error: 'Naam aur phone ya email chahiye.' };
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Email sahi nahi lag raha.' };
    ctx.enquiryDraft = { name, phone, email, enquiry_type: clip(a.enquiry_type, 80), message: clip(a.message, 1000) };
    return { ok: true, note: 'Draft taiyaar hai. Visitor ko bolo ki neeche "Enquiry bhejo" button se confirm kare.' };
  },
  ['name']);

const definitions = tools.map(t => t.def);
const handlers = Object.fromEntries(tools.map(t => [t.def.name, t.handler]));

async function runPublicTool(db, ctx, name, input) {
  const fn = handlers[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return await fn(db, input && typeof input === 'object' ? input : {}, ctx);
  } catch (e) {
    console.error(`[ai-public] tool ${name} failed:`, e.message);
    return { error: 'Data fetch failed for this tool.' };
  }
}

module.exports = { definitions, runPublicTool };
