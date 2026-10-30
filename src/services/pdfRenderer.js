// ── HTML → PDF renderer (headless Chrome via puppeteer-core) ─────────────────
// The app's printable documents (challans, invoices, quotations, QC reports,
// CFT sheets, ...) are HTML pages built in the browser. To send them as real
// PDFs, the browser uploads that same HTML and we print it here with Chrome,
// so the PDF matches what the user gets from "Print → Save as PDF".
//
// Chrome is found via CHROME_PATH, else common install locations
// (Railway/Nixpacks: `chromium` from nixpacks.toml; Windows: Chrome/Edge).
//
// Safety: uploaded HTML runs in Chrome, so requests are restricted to
// https/data/blob URLs on public hosts — no file://, localhost, private IPs or
// Railway-internal hosts. One render at a time; the browser is reused and
// closed after a few idle minutes.

const fs = require('fs');
const { execSync } = require('child_process');

const RENDER_TIMEOUT_MS = 45000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;

let browserPromise = null;
let idleTimer = null;
let chain = Promise.resolve(); // serialises renders

// Ubuntu ships /usr/bin/chromium-browser as a tiny script that only says
// "install the chromium snap" — it is not a browser. Skip such stubs.
function isRealBrowser(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (st.size > 64 * 1024) return true; // real binaries are large
    const head = fs.readFileSync(file, 'utf8').slice(0, 4096);
    return !/snap/i.test(head) || /exec\s+["']?\/nix\/store/.test(head); // keep Nix wrapper scripts
  } catch { return false; }
}

// Candidate browsers, best first: CHROME_PATH, then whatever is on PATH
// (Railway/Nixpacks puts chromium there), then common install locations.
function chromeCandidates() {
  const list = [];
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH);
  if (process.platform !== 'win32') {
    for (const bin of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
      try {
        const out = execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'], shell: '/bin/sh' }).toString().trim();
        if (out) list.push(out);
      } catch { /* not on PATH */ }
    }
  }
  list.push(
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  return [...new Set(list)].filter((p) => p === process.env.CHROME_PATH || isRealBrowser(p));
}

function findChrome() {
  return chromeCandidates()[0] || null;
}

const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'];

// Try each candidate until one actually starts.
async function launchAny() {
  const puppeteer = require('puppeteer-core');
  const candidates = chromeCandidates();
  if (!candidates.length) {
    throw new Error('PDF engine not available: no Chrome/Chromium found on the server (install chromium or set CHROME_PATH)');
  }
  const failures = [];
  for (const executablePath of candidates) {
    try {
      const browser = await puppeteer.launch({ executablePath, headless: true, args: LAUNCH_ARGS });
      if (failures.length) console.warn('[pdf] skipped browsers:', failures.join(' | '));
      console.log(`🖨️  [pdf] using ${executablePath}`);
      return browser;
    } catch (err) {
      failures.push(`${executablePath}: ${String(err.message).split('\n')[0]}`);
    }
  }
  throw new Error(`PDF engine could not start Chrome. Tried: ${failures.join(' | ')}`);
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchAny().catch((err) => { browserPromise = null; throw err; });
    browserPromise.then((b) => b.on('disconnected', () => { browserPromise = null; })).catch(() => {});
  }
  return browserPromise;
}

function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = browserPromise;
    browserPromise = null;
    if (p) (await p.catch(() => null))?.close().catch(() => {});
  }, IDLE_CLOSE_MS);
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.railway\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

function isAllowedUrl(raw) {
  if (raw.startsWith('data:') || raw.startsWith('blob:') || raw === 'about:blank') return true;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !PRIVATE_HOST.test(u.hostname);
  } catch { return false; }
}

// Pages built for printing call window.print() when ready (paged.js ones only
// after pagination). This hook, injected first in <head>, records that instead
// of opening a dialog. (evaluateOnNewDocument doesn't apply to setContent.)
const PRINT_HOOK = '<script>window.__printRequested=false;window.print=function(){window.__printRequested=true;};</script>';

// Add the print hook, and make relative URLs (e.g. /logo.png) resolve against
// the app's public origin.
function prepareHtml(html, baseUrl) {
  let head = PRINT_HOOK;
  if (baseUrl && !/<base\s/i.test(html) && isAllowedUrl(baseUrl)) head += `<base href="${baseUrl.replace(/"/g, '')}/">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : `${head}${html}`;
}

async function renderOnce(html, { baseUrl, landscape } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => (isAllowedUrl(req.url()) ? req.continue() : req.abort()));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    await page.setContent(prepareHtml(html, baseUrl), { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS });

    // paged.js documents: wait until pagination has finished (they call print() then).
    const usesPagedJs = await page.evaluate(() => Boolean(window.PagedPolyfill || window.Paged || document.querySelector('script[src*="paged"]')));
    if (usesPagedJs) await page.waitForFunction(() => window.__printRequested, { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => document.fonts && document.fonts.ready);

    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true, // honour each document's @page size/orientation
      format: 'A4',
      landscape: Boolean(landscape),
      timeout: RENDER_TIMEOUT_MS,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

// Render HTML to a PDF Buffer. Throws a readable Error on failure.
function renderHtmlToPdf(html, options = {}) {
  const job = chain.then(() => renderOnce(html, options));
  chain = job.catch(() => {}); // keep the queue going after failures
  return job.finally(touchIdle);
}

module.exports = { renderHtmlToPdf, findChrome, chromeCandidates };
