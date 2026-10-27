// ─────────────────────────────────────────────────────────────────────────────
//  Shared "Ask Moji" engine used by all three assistants:
//    • admin   (routes/aiRoutes.js        POST /api/ai/chat)
//    • client  (routes/aiRoutes.js        POST /api/ai/client-chat)
//    • public  (routes/publicAiRoutes.js  POST /api/website/ai/chat)
//
//  It talks to ONE chat-model provider and runs the tool loop. Providers (env AI_PROVIDER):
//     anthropic (default) · openai · groq      — openai/groq share the OpenAI-compatible adapter.
//  The public website bot may use a different provider via AI_PUBLIC_PROVIDER (e.g. a free/cheap
//  one for anonymous traffic). WHICH tools
//  exist and WHAT data they may touch is decided by each caller — the model never
//  gets to choose the user/client id; that always comes from the verified login token.
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');

// Env values as typed in a hosting panel may carry quotes or spaces ("groq", ' gsk_…') — strip them
const clean = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const env = (k) => clean(process.env[k]) || undefined;

// ── providers ───────────────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic: { key: () => env('ANTHROPIC_API_KEY'), model: () => env('AI_MODEL') || 'claude-sonnet-5-5' },
  openai:    { key: () => env('OPENAI_API_KEY'),    model: () => env('AI_MODEL') || 'gpt-4o-mini',
               base: () => env('OPENAI_BASE_URL') || 'https://api.openai.com/v1' },
  groq:      { key: () => env('GROQ_API_KEY') || env('GROQ_API'), model: () => env('AI_MODEL') || 'llama-3.3-70b-versatile',
               base: () => env('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1' },
};
const providerName = (override) => {
  const n = (clean(override) || env('AI_PROVIDER') || 'anthropic').toLowerCase();
  return PROVIDERS[n] ? n : 'anthropic';
};
const MODEL = (override) => PROVIDERS[providerName(override)].model();

// ── Anthropic Messages API ──────────────────────────────────────────────────
async function callAnthropic({ system, tools, messages, maxTokens, model }) {
  const { data } = await axios.post(
    (env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com') + '/v1/messages',
    { model, max_tokens: maxTokens || 1500, system, tools, messages },
    { headers: { 'x-api-key': PROVIDERS.anthropic.key(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 60000 }
  );
  return data;
}

async function runAnthropic({ system, tools, runTool, history, maxTokens, model, maxRounds, maxToolChars }) {
  const messages = [...history];
  const toolsUsed = [];
  for (let round = 0; round < maxRounds; round++) {
    const resp = await callAnthropic({ system, tools, messages, maxTokens, model });
    if (resp.stop_reason !== 'tool_use') {
      const reply = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { reply: reply || 'Jawab nahi mil paya, dobara try karo.', toolsUsed };
    }
    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const block of resp.content.filter(b => b.type === 'tool_use')) {
      toolsUsed.push(block.name);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: clipJson(await runTool(block.name, block.input), maxToolChars) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: TOO_BIG, toolsUsed };
}

// ── OpenAI-compatible Chat Completions (OpenAI, Groq) ───────────────────────
async function callCompat(name, { system, tools, messages, maxTokens, model }) {
  const p = PROVIDERS[name];
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    tool_choice: 'auto',
    temperature: 0.2,
  };
  body[name === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens || 1500;
  const url = `${p.base()}/chat/completions`;
  const headers = { Authorization: `Bearer ${p.key()}`, 'content-type': 'application/json' };
  if (swapped[`${name}|${model}`]) body.model = swapped[`${name}|${model}`];
  try {
    return (await axios.post(url, body, { headers, timeout: 60000 })).data;
  } catch (err) {
    // Open models occasionally emit a malformed tool call (Groq: code "tool_use_failed"). One retry usually fixes it.
    if (err.response?.status === 400 && /tool_use_failed|failed_generation/i.test(JSON.stringify(err.response?.data || ''))) {
      return (await axios.post(url, body, { headers, timeout: 60000 })).data;
    }
    // The model was retired / renamed by the provider → pick a current one from its model list, retry once
    if (isModelGone(err)) {
      const next = await pickLiveModel(name, headers, body.model);
      if (next) {
        swapped[`${name}|${model}`] = next;
        console.warn(`[ai] model "${body.model}" is not available on ${name} — using "${next}". Set AI_MODEL to choose one.`);
        return (await axios.post(url, { ...body, model: next }, { headers, timeout: 60000 })).data;
      }
    }
    throw err;
  }
}

// Retired-model handling (Groq retires models often)
const swapped = {};                       // "<provider>|<configured model>" → model actually used
const isModelGone = (err) => {
  const s = err.response?.status;
  const t = JSON.stringify(err.response?.data || '');
  return (s === 404 || s === 400) && /model_not_found|model_decommissioned|does not exist|decommissioned|not found/i.test(t) && /model/i.test(t);
};
// Chat models known to handle tool calls well, best first; else any chat model on the list
const PREFERRED = {
  groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-maverick-17b-128e-instruct',
    'moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-20b'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
};
async function pickLiveModel(name, headers, current) {
  try {
    const { data } = await axios.get(`${PROVIDERS[name].base()}/models`, { headers, timeout: 15000 });
    const ids = (data?.data || []).filter(m => m && m.id && m.active !== false).map(m => m.id);
    const chat = ids.filter(id => id !== current && !/whisper|tts|guard|embed|playai|distil|orpheus|compound|vision|audio|moderation|image|dall-e|realtime|transcribe/i.test(id));
    return (PREFERRED[name] || []).find(id => chat.includes(id))
      || chat.find(id => /70b|120b|maverick|large|instruct|versatile/i.test(id))
      || chat[0] || null;
  } catch (e) {
    console.error(`[ai] could not list ${name} models:`, e.response?.status || e.message);
    return null;
  }
}

const safeJson = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

async function runCompat(name, { system, tools, runTool, history, maxTokens, model, maxRounds, maxToolChars }) {
  const messages = [...history];
  const toolsUsed = [];
  for (let round = 0; round < maxRounds; round++) {
    const resp = await callCompat(name, { system, tools, messages, maxTokens, model });
    const msg = resp.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) return { reply: (msg.content || '').trim() || 'Jawab nahi mil paya, dobara try karo.', toolsUsed };
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
    for (const c of calls) {
      toolsUsed.push(c.function?.name);
      const out = await runTool(c.function?.name, safeJson(c.function?.arguments));
      messages.push({ role: 'tool', tool_call_id: c.id, content: clipJson(out, maxToolChars) });
    }
  }
  return { reply: TOO_BIG, toolsUsed };
}

const TOO_BIG = 'Sawal thoda bada hai — thoda chhota ya specific karke puchho.';
const clipJson = (v, max) => { const o = JSON.stringify(v); return o.length > max ? o.slice(0, max) + '…[truncated]' : o; };

// Keeps only plain-text user/assistant turns, trims length, makes sure it starts and ends on a user turn.
function sanitizeHistory(incoming, { maxHistory = 16, maxChars = 2000 } = {}) {
  const list = (Array.isArray(incoming) ? incoming : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-maxHistory)
    .map(m => ({ role: m.role, content: m.content.slice(0, maxChars) }));
  while (list.length && list[0].role !== 'user') list.shift();
  if (!list.length || list[list.length - 1].role !== 'user') return null;
  return list;
}

/**
 * Runs the chat + tool loop with the configured provider.
 * @param {object} o
 * @param {string} o.system         system prompt
 * @param {Array}  o.tools          tool definitions ({ name, description, input_schema })
 * @param {Function} o.runTool      async (name, input) => result (JSON-serialisable)
 * @param {Array}  o.history        sanitised chat history
 * @param {string} [o.provider]     override AI_PROVIDER for this call (e.g. the public bot)
 * @returns {{ reply: string, toolsUsed: string[] }}
 */
async function runChat({ system, tools, runTool, history, maxTokens, model, provider, maxRounds = 6, maxToolChars = 14000 }) {
  const name = providerName(provider);
  const args = { system, tools, runTool, history, maxTokens, model: clean(model) || MODEL(provider), maxRounds, maxToolChars };
  return name === 'anthropic' ? runAnthropic(args) : runCompat(name, args);
}

// In-memory sliding-window limiter. keyFn(req) → string. Returns express middleware.
function makeRateLimiter({ max, windowMs, keyFn, message }) {
  const hits = new Map();
  setInterval(() => {            // drop stale keys so the map can't grow forever
    const now = Date.now();
    for (const [k, list] of hits) { if (!list.some(t => now - t < windowMs)) hits.delete(k); }
  }, 10 * 60 * 1000).unref();
  return (req, res, next) => {
    const key = keyFn(req); const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ message });
    list.push(now); hits.set(key, list);
    next();
  };
}

// Maps an Anthropic/axios error to a safe client response (never leaks upstream details).
// showDetail (admin only): adds the provider's own error text so a setup problem
// (wrong model name, wrong key, provider mismatch) can be fixed without the server logs.
function sendAiError(res, err, tag = 'ai', { showDetail = false } = {}) {
  const status = err.response?.status;
  const upstream = err.response?.data?.error?.message || err.response?.data?.message || err.message || '';
  console.error(`[${tag}] chat error:`, providerName(), status, upstream);
  const detail = showDetail
    ? ` [${providerName()}${status ? ' ' + status : ''}: ${String(upstream).replace(/(sk|gsk|key)[-_A-Za-z0-9]{8,}/g, '***').slice(0, 250)}]`
    : '';
  if (status === 429 || status === 529) return res.status(503).json({ message: 'AI abhi busy hai, thodi der baad try karo.' + detail });
  if (status === 401 || status === 403) return res.status(503).json({ message: 'AI abhi available nahi hai. Thodi der baad try karo.' + (showDetail ? ' (API key check karo)' + detail : '') });
  return res.status(500).json({ message: 'AI se jawab nahi aa paya. Thodi der baad try karo.' + detail });
}

const isConfigured = (provider) => !!PROVIDERS[providerName(provider)].key();

module.exports = { runChat, sanitizeHistory, makeRateLimiter, sendAiError, isConfigured, providerName, MODEL };
