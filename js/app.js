import { db } from './db.js';
import { MODELS, DEFAULT_MODEL, byKey } from './models.js';
import { renderMarkdown, esc } from './markdown.js';

const APP_VERSION = '1.0.0';
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.89/lib/index.js';
const CTX_TOKENS = 4096;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = matchMedia('(max-width: 820px)').matches;

/* ---------------- Personas ---------------- */
const BUILTIN_PERSONAS = [
  { id: 'assistant', emoji: '✨', name: 'Assistant', builtin: true,
    prompt: "You are Pocket AI, a helpful, friendly assistant that runs privately on the user's own device. Give clear, accurate, concise answers. Use Markdown (lists, bold, code blocks) when it helps. If you are not sure about something, say so instead of guessing." },
  { id: 'homework', emoji: '📚', name: 'Homework Helper', builtin: true,
    prompt: 'You are a patient tutor for a high school student. Explain concepts step by step in simple words, use short examples, and check understanding. Help the student learn and think through problems rather than just handing over finished essays.' },
  { id: 'coder', emoji: '💻', name: 'Coder', builtin: true,
    prompt: 'You are an expert programmer. Write correct, clean, well-commented code in fenced code blocks with the language name. Briefly explain what the code does and how to run it. Keep explanations tight.' },
  { id: 'writer', emoji: '✍️', name: 'Writing Coach', builtin: true,
    prompt: 'You are a writing coach. Help brainstorm, outline, and improve writing. Point out grammar, clarity and flow issues with specific suggestions. Keep the writer\'s own voice.' },
  { id: 'friend', emoji: '😄', name: 'Funny Friend', builtin: true,
    prompt: 'You are a laid-back, funny friend. Talk casually, crack jokes, use playful banter, keep replies short. Stay kind and never mean-spirited.' },
  { id: 'story', emoji: '🐉', name: 'Storyteller', builtin: true,
    prompt: 'You are a creative storyteller and game master. Write vivid, fun stories and interactive adventures. When running an adventure, end each turn with 2-3 choices for the user.' },
  { id: 'chef', emoji: '🍳', name: 'Chef', builtin: true,
    prompt: 'You are a friendly home chef. Suggest easy recipes with ingredient lists and numbered steps, offer substitutions, and keep it practical.' },
  { id: 'translator', emoji: '🌍', name: 'Translator', builtin: true,
    prompt: 'You are a translator. Translate the user\'s text accurately and naturally. If the target language is not given, translate between English and Portuguese. Show only the translation unless asked for explanations.' },
];

const SUGGESTIONS = [
  ['Explain', 'how black holes form like I\'m 12'],
  ['Write', 'a short funny poem about my dog'],
  ['Help me study', 'quiz me on the causes of World War I'],
  ['Code', 'a Python script that picks a random number game'],
  ['Brainstorm', '5 ideas for a school project on India'],
  ['Plan', 'a 20-minute home workout with no equipment'],
];

/* ---------------- Settings ---------------- */
const SETTINGS_KEY = 'pocketai.settings';
const defaults = {
  theme: 'system', customInstr: '', temperature: 0.7, maxTokens: 1024,
  sendEnter: !isMobile, showStats: true, model: DEFAULT_MODEL,
  personaId: 'assistant', personas: [], sidebarCollapsed: false,
};
let settings = { ...defaults };
try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch {}
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
const allPersonas = () => [...BUILTIN_PERSONAS, ...(settings.personas || [])];
const personaById = (id) => allPersonas().find(p => p.id === id) || BUILTIN_PERSONAS[0];

/* ---------------- State ---------------- */
let chats = [];
let current = null;          // chat object (may be unsaved: current.saved === false)
let gpu = null;              // {ok, f16, reason, ...}
let webllm = null;
let engine = null;
let worker = null;
let loadedId = null;
let loadingPromise = null;
let generating = false;
let stopRequested = false;

/* ---------------- Utilities ---------------- */
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed'); }
    ta.remove();
  }
}
function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const safeName = (s) => (s || 'chat').replace(/[^\w\- ]+/g, '').trim().slice(0, 50).replace(/\s+/g, '-') || 'chat';
function fmtMB(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'; }

function confirmBox(title, text, okLabel = 'Delete') {
  return new Promise(res => {
    const d = $('#confirmDlg');
    $('#confirmTitle').textContent = title; $('#confirmText').textContent = text; $('#confirmOk').textContent = okLabel;
    const ok = () => { cleanup(); d.close(); res(true); };
    const cancel = () => { cleanup(); res(false); };
    const cleanup = () => { $('#confirmOk').removeEventListener('click', ok); d.removeEventListener('close', cancel); };
    $('#confirmOk').addEventListener('click', ok);
    d.addEventListener('close', cancel, { once: true });
    d.showModal();
  });
}
function promptBox(title, value, { multiline = false, okLabel = 'Save', placeholder = '' } = {}) {
  return new Promise(res => {
    const d = $('#promptDlg'), inp = $('#promptInput');
    $('#promptTitle').textContent = title; $('#promptOk').textContent = okLabel;
    inp.value = value || ''; inp.rows = multiline ? 7 : 1; inp.placeholder = placeholder;
    let done = false;
    const ok = () => { done = true; cleanup(); d.close(); res(inp.value); };
    const onKey = (e) => { if (!multiline && e.key === 'Enter') { e.preventDefault(); ok(); } };
    const onClose = () => { cleanup(); if (!done) res(null); };
    const cleanup = () => { $('#promptOk').removeEventListener('click', ok); inp.removeEventListener('keydown', onKey); };
    $('#promptOk').addEventListener('click', ok);
    inp.addEventListener('keydown', onKey);
    d.addEventListener('close', onClose, { once: true });
    d.showModal();
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
  });
}

/* ---------------- Theme ---------------- */
function applyTheme() {
  let t = settings.theme;
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  $('meta[name=theme-color]').setAttribute('content', t === 'light' ? '#ffffff' : '#0f1117');
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === settings.theme));
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => settings.theme === 'system' && applyTheme());

/* ---------------- WebGPU detection ---------------- */
async function detectGPU() {
  if (!('gpu' in navigator) || !navigator.gpu) return { ok: false, reason: 'nogpu' };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ok: false, reason: 'noadapter' };
    let info = adapter.info || {};
    return {
      ok: true,
      f16: adapter.features.has('shader-f16'),
      maxBufferMB: Math.round((adapter.limits.maxBufferSize || 0) / 1048576),
      vendor: info.vendor || '', arch: info.architecture || '',
    };
  } catch (e) {
    return { ok: false, reason: 'error', error: String(e && e.message || e) };
  }
}
function showGpuBanner() {
  const b = $('#gpuBanner');
  if (gpu.ok) { b.hidden = true; return; }
  const howTo = isIOS
    ? `<ol><li>Update your iPhone: <b style="display:inline">Settings → General → Software Update</b> (iOS 26+ has WebGPU built in).</li><li>On iOS 18 or older: Settings → Apps → Safari → Advanced → Feature Flags → turn on <b style="display:inline">WebGPU</b>, then reopen this page.</li></ol>`
    : `<ol><li>Use the latest <b style="display:inline">Google Chrome</b> or <b style="display:inline">Edge</b> (version 113+) on Mac or Windows, or Safari 26+.</li><li>In Chrome, make sure hardware acceleration is on: Settings → System → "Use graphics acceleration".</li></ol>`;
  b.innerHTML = `<b>⚠️ This browser can't run the AI (needs WebGPU)</b>Pocket AI runs the model on your device's graphics chip using WebGPU, which isn't available here${gpu.reason === 'noadapter' ? ' (no compatible GPU adapter found)' : ''}. You can still read your saved chats.${howTo}`;
  b.hidden = false;
}
const modelIdFor = (m) => (gpu && gpu.ok && !gpu.f16) ? m.f32 : m.f16;

/* ---------------- WebLLM engine ---------------- */
async function getWebLLM() {
  if (!webllm) webllm = await import(WEBLLM_URL);
  return webllm;
}

function setModelChip(state) {
  const m = byKey(settings.model);
  $('#modelLabel').textContent = m.name;
  const dot = $('#modelDot');
  dot.className = 'dot' + (state ? ' ' + state : '');
  $('#modelChip').title = state === 'ready' ? `${m.name} loaded and ready` : state === 'loading' ? `Loading ${m.name}…` : `${m.name} (tap to choose a model)`;
}

function showProgress(on, text, pct, sub) {
  const p = $('#progressBar');
  p.hidden = !on;
  if (!on) return;
  if (text != null) $('#progressText').textContent = text;
  if (pct != null) { $('#progressPct').textContent = Math.round(pct * 100) + '%'; $('#progressFill').style.width = (pct * 100).toFixed(1) + '%'; }
  if (sub != null) $('#progressSub').textContent = sub;
}

function prettyProgress(report, m) {
  const t = report.text || '';
  const fromCache = /cache/i.test(t) && !/fetch/i.test(t);
  const mb = t.match(/(\d+(?:\.\d+)?)\s*MB/);
  let label;
  if (/Fetching|fetch/i.test(t)) label = `Downloading ${m.name}${mb ? ` · ${Math.round(+mb[1])} MB` : ''}`;
  else if (fromCache) label = `Loading ${m.name} from this device`;
  else if (/shader|compil|GPU/i.test(t)) label = `Preparing ${m.name} on your GPU`;
  else label = `Loading ${m.name}`;
  return label;
}

async function ensureEngine(key = settings.model) {
  if (!gpu || !gpu.ok) throw new Error('WebGPU is not available in this browser.');
  const m = byKey(key);
  const id = modelIdFor(m);
  if (engine && loadedId === id && !loadingPromise) return engine;
  if (loadingPromise) {
    await loadingPromise.catch(() => {});
    if (engine && loadedId === id) return engine;
  }
  loadingPromise = (async () => {
    setModelChip('loading');
    showProgress(true, `Starting ${m.name}…`, 0, `First time: downloads ${m.download} once, then it's saved on this device and works offline.`);
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
    const lib = await getWebLLM();
    const cb = (r) => {
      const label = prettyProgress(r, m);
      const cached = /cache/i.test(r.text || '') && !/fetch/i.test(r.text || '');
      showProgress(true, label, r.progress || 0, cached ? 'Already downloaded, loading into memory…' : `Downloads ${m.download} once, then it's saved and works offline. Keep this tab open.`);
    };
    const chatOpts = { context_window_size: CTX_TOKENS };
    if (!engine) {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      engine = await lib.CreateWebWorkerMLCEngine(worker, id, { initProgressCallback: cb }, chatOpts);
    } else {
      engine.setInitProgressCallback(cb);
      await engine.reload(id, chatOpts);
    }
    loadedId = id;
    showProgress(false);
    setModelChip('ready');
    toast(`${m.name} is ready`);
    return engine;
  })();
  try { return await loadingPromise; }
  catch (e) {
    showProgress(false);
    setModelChip('');
    loadedId = null;
    throw e;
  } finally { loadingPromise = null; }
}

function friendlyError(e) {
  const s = String(e && (e.message || e) || 'Unknown error');
  if (/WebGPU/i.test(s) && /not available|not supported|unavailable/i.test(s)) return 'WebGPU is not available in this browser, so the AI can\'t run here.';
  if (/memory|OOM|allocation|device.*lost|DeviceLost/i.test(s)) return 'Your device ran out of graphics memory. Try a smaller model (Models → Llama 3.2 1B or Qwen2.5 0.5B) and close other tabs.';
  if (/QuotaExceeded|quota|storage/i.test(s)) return 'Not enough storage space to save the model. Free up space or pick a smaller model.';
  if (/Failed to fetch|NetworkError|network/i.test(s)) return 'Download failed. Check your internet connection and try again (progress so far is saved).';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/* ---------------- Chats ---------------- */
function newChat() {
  current = { id: uid(), title: 'New chat', personaId: settings.personaId || 'assistant', systemPrompt: null, messages: [], createdAt: Date.now(), updatedAt: Date.now(), saved: false };
  renderChat();
  renderList();
  updatePersonaChip();
  closeSidebarMobile();
  setTimeout(() => !isMobile && $('#input').focus(), 30);
}
async function saveCurrent() {
  if (!current) return;
  current.updatedAt = Date.now();
  current.saved = true;
  const { saved, ...rest } = current;
  await db.put(rest);
  const i = chats.findIndex(c => c.id === current.id);
  if (i >= 0) chats[i] = current; else chats.unshift(current);
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  settings.lastChatId = current.id; saveSettings();
  renderList();
}
async function openChat(id) {
  if (generating) { toast('Stop the current reply first'); return; }
  const c = chats.find(x => x.id === id) || await db.get(id);
  if (!c) return newChat();
  current = { ...c, saved: true };
  settings.lastChatId = id; saveSettings();
  renderChat(); renderList(); updatePersonaChip();
  closeSidebarMobile();
}
async function deleteChat(id) {
  const c = chats.find(x => x.id === id);
  if (!await confirmBox('Delete chat?', `"${c ? c.title : 'This chat'}" will be permanently deleted from this device.`)) return;
  await db.del(id);
  chats = chats.filter(x => x.id !== id);
  if (current && current.id === id) newChat(); else renderList();
  toast('Chat deleted');
}
async function renameChat(id) {
  const c = chats.find(x => x.id === id) || (current && current.id === id ? current : null);
  if (!c) return;
  const v = await promptBox('Rename chat', c.title);
  if (v == null || !v.trim()) return;
  c.title = v.trim().slice(0, 80);
  if (current && current.id === id) { current.title = c.title; if (current.saved || current.messages.length) await saveCurrent(); }
  else { const { saved, ...rest } = c; await db.put(rest); renderList(); }
}
function chatToMarkdown(c) {
  const p = personaById(c.personaId);
  let md = `# ${c.title}\n\n_Persona: ${p.emoji} ${p.name} · ${new Date(c.createdAt).toLocaleString()}_\n\n`;
  for (const m of c.messages) md += `**${m.role === 'user' ? 'You' : 'Pocket AI'}:**\n\n${m.content}\n\n---\n\n`;
  return md;
}

/* ---------------- Sidebar list ---------------- */
function groupOf(ts) {
  const d = new Date(ts), now = new Date();
  const day = 86400000;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startToday) return 'Today';
  if (ts >= startToday - day) return 'Yesterday';
  if (ts >= startToday - 7 * day) return 'Previous 7 days';
  if (ts >= startToday - 30 * day) return 'Previous 30 days';
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}
function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const nav = $('#chatList');
  nav.innerHTML = '';
  let list = chats;
  const snippets = new Map();
  if (q) {
    list = chats.filter(c => {
      if (c.title.toLowerCase().includes(q)) return true;
      const hit = c.messages.find(m => m.content.toLowerCase().includes(q));
      if (hit) {
        const i = hit.content.toLowerCase().indexOf(q);
        snippets.set(c.id, (i > 20 ? '…' : '') + hit.content.slice(Math.max(0, i - 20), i + 50).replace(/\s+/g, ' '));
        return true;
      }
      return false;
    });
  }
  if (!list.length) {
    nav.innerHTML = `<div class="no-chats">${q ? 'No chats match your search.' : 'No saved chats yet.<br>Start typing below!'}</div>`;
    return;
  }
  let lastGroup = '';
  for (const c of list) {
    const g = groupOf(c.updatedAt);
    if (g !== lastGroup && !q) { const l = document.createElement('div'); l.className = 'group-label'; l.textContent = g; nav.appendChild(l); lastGroup = g; }
    const el = document.createElement('div');
    el.className = 'chat-item' + (current && current.id === c.id ? ' active' : '');
    el.dataset.id = c.id;
    el.tabIndex = 0;
    const p = personaById(c.personaId);
    el.innerHTML = `<span class="e">${esc(p.emoji)}</span><span class="t">${esc(c.title)}${snippets.has(c.id) ? `<span class="snip">${esc(snippets.get(c.id))}</span>` : ''}</span><span class="acts"><button data-a="rename" title="Rename" aria-label="Rename">✏️</button><button data-a="delete" title="Delete" aria-label="Delete">🗑</button></span>`;
    nav.appendChild(el);
  }
}

/* ---------------- Message rendering ---------------- */
const msgBox = () => $('#messages');
function nearBottom() { const m = msgBox(); return m.scrollHeight - m.scrollTop - m.clientHeight < 120; }
function scrollBottom(force = false) { const m = msgBox(); if (force || nearBottom()) m.scrollTop = m.scrollHeight; }

function renderSuggestions() {
  $('#suggestions').innerHTML = SUGGESTIONS.map(([a, b]) => `<button type="button" data-s="${esc(a + ' ' + b)}"><b>${esc(a)}</b><span>${esc(b)}</span></button>`).join('');
}

function messageEl(m, idx) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + m.role;
  row.dataset.idx = idx;
  if (m.role === 'user') {
    row.innerHTML = `<div class="user-wrap"><div class="bubble"></div><div class="msg-actions"><button data-a="edit" title="Edit">✏️ Edit</button><button data-a="copy" title="Copy">📋</button></div></div>`;
    $('.bubble', row).textContent = m.content;
  } else {
    const p = personaById(current.personaId);
    row.innerHTML = `<div class="avatar">${esc(p.emoji)}</div><div class="content"><div class="bubble"></div><div class="msg-actions"></div></div>`;
    fillAssistant(row, m, idx);
  }
  return row;
}
function fillAssistant(row, m, idx, streaming = false) {
  const b = $('.bubble', row);
  if (m.error) b.innerHTML = `<div class="err-note">⚠️ ${esc(m.error)}</div>`;
  else if (!m.content && streaming) b.innerHTML = '<div class="thinking"><i></i><i></i><i></i></div>';
  else b.innerHTML = renderMarkdown(m.content || '', { streaming });
  b.classList.toggle('cursor', streaming && !!m.content);
  const acts = $('.msg-actions', row);
  if (streaming) { acts.innerHTML = ''; return; }
  const isLast = idx === current.messages.length - 1;
  const stats = settings.showStats && m.stats ? `<span class="stats">${esc(m.stats)}</span>` : '';
  acts.innerHTML = `${m.content ? '<button data-a="copy" title="Copy">📋 Copy</button>' : ''}${'speechSynthesis' in window && m.content ? '<button data-a="speak" title="Read aloud">🔊</button>' : ''}${isLast ? '<button data-a="regen" title="Regenerate">🔄 Retry</button>' : ''}${stats}`;
}
function renderChat() {
  const box = msgBox();
  $$('.msg-row', box).forEach(n => n.remove());
  const empty = $('#empty');
  empty.hidden = !!(current && current.messages.length);
  if (current) current.messages.forEach((m, i) => box.appendChild(messageEl(m, i)));
  scrollBottom(true);
  document.title = current && current.messages.length ? `${current.title} · Pocket AI` : 'Pocket AI';
}
function updatePersonaChip() {
  const p = personaById(current ? current.personaId : settings.personaId);
  $('#personaEmoji').textContent = p.emoji;
  $('#personaName').textContent = current && current.systemPrompt ? `${p.name} (custom)` : p.name;
}

/* ---------------- Generation ---------------- */
function systemPromptFor(c) {
  let sp = c.systemPrompt || personaById(c.personaId).prompt;
  if (settings.customInstr.trim()) sp += `\n\nThe user's custom instructions (follow them):\n${settings.customInstr.trim()}`;
  return sp;
}
function buildMessages(c) {
  const sys = systemPromptFor(c);
  // rough budget: ~3.2 chars per token
  const budget = Math.max(1200, (CTX_TOKENS - settings.maxTokens - 150) * 3.2 - sys.length);
  const hist = c.messages.filter(m => !m.error && m.content);
  const out = [];
  let used = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const len = hist[i].content.length;
    if (used + len > budget && out.length) break;
    out.unshift({ role: hist[i].role, content: len > budget ? hist[i].content.slice(-budget) : hist[i].content });
    used += len;
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return [{ role: 'system', content: sys }, ...out];
}
function setGenerating(on) {
  generating = on;
  $('#sendBtn').hidden = on;
  $('#stopBtn').hidden = !on;
  updateSendBtn();
}
function updateSendBtn() { $('#sendBtn').disabled = generating || !$('#input').value.trim(); }

async function send(text) {
  text = (text || '').trim();
  if (!text || generating) return;
  if (!current) newChat();
  if (!current.messages.length) current.title = text.replace(/\s+/g, ' ').slice(0, 48) + (text.length > 48 ? '…' : '');
  current.messages.push({ role: 'user', content: text, ts: Date.now() });
  $('#input').value = ''; autosize();
  await saveCurrent();
  renderChat();
  await generate();
}

async function generate() {
  const c = current;
  const m = byKey(settings.model);
  const reply = { role: 'assistant', content: '', ts: Date.now(), model: m.name };
  c.messages.push(reply);
  const idx = c.messages.length - 1;
  $('#empty').hidden = true;
  const row = messageEl(reply, idx);
  msgBox().appendChild(row);
  fillAssistant(row, reply, idx, true);
  scrollBottom(true);
  setGenerating(true);
  stopRequested = false;
  const t0 = performance.now();
  try {
    if (!gpu.ok) throw new Error('WebGPU is not available in this browser, so the AI can\'t run here. See the note at the top for how to fix it.');
    const eng = await ensureEngine();
    if (stopRequested) throw Object.assign(new Error('stopped'), { stopped: true });
    const stream = await eng.chat.completions.create({
      messages: buildMessages({ ...c, messages: c.messages.slice(0, -1) }),
      stream: true,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      stream_options: { include_usage: true },
    });
    let pending = false, usage = null;
    for await (const chunk of stream) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (d) reply.content += d;
      if (chunk.usage) usage = chunk.usage;
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => { pending = false; if (c === current) { fillAssistant(row, reply, idx, true); scrollBottom(); } });
      }
    }
    const secs = (performance.now() - t0) / 1000;
    const tps = usage && usage.extra && usage.extra.decode_tokens_per_s;
    reply.stats = `${m.name} · ${tps ? tps.toFixed(1) + ' tok/s' : secs.toFixed(1) + 's'}${stopRequested ? ' · stopped' : ''}`;
    if (!reply.content.trim()) reply.content = stopRequested ? '_(stopped)_' : '_(no reply, try again)_';
  } catch (e) {
    if (e && e.stopped) reply.content = reply.content || '_(stopped)_';
    else reply.error = friendlyError(e);
  } finally {
    setGenerating(false);
    if (c === current) { fillAssistant(row, reply, idx, false); scrollBottom(); }
    // refresh previous assistant actions (remove retry from older)
    if (c === current) { const prev = $$('.msg-row.assistant', msgBox()); prev.slice(0, -1).forEach(r => { const i = +r.dataset.idx; const mm = c.messages[i]; if (mm) fillAssistant(r, mm, i); }); }
    current = c;
    await saveCurrent();
  }
}
async function stop() {
  stopRequested = true;
  try { if (engine && generating) await engine.interruptGenerate(); } catch {}
}
async function regenerate() {
  if (generating || !current) return;
  const last = current.messages[current.messages.length - 1];
  if (last && last.role === 'assistant') current.messages.pop();
  renderChat();
  await generate();
}
async function editMessage(idx) {
  if (generating) return;
  const m = current.messages[idx];
  const v = await promptBox('Edit message', m.content, { multiline: true, okLabel: 'Save & resend' });
  if (v == null || !v.trim()) return;
  current.messages = current.messages.slice(0, idx);
  current.messages.push({ role: 'user', content: v.trim(), ts: Date.now() });
  await saveCurrent();
  renderChat();
  await generate();
}

/* ---------------- Models dialog ---------------- */
async function renderModels() {
  const wrap = $('#modelCards');
  const meter = (n) => `<span class="meter">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
  wrap.innerHTML = MODELS.map(m => `
    <div class="model-card ${m.key === settings.model ? 'active' : ''}" data-key="${m.key}">
      <div class="mc-top"><span class="mc-name">${esc(m.name)}</span>${m.badges.map(([t, c]) => `<span class="badge ${c}">${esc(t)}</span>`).join('')}<span class="badge cached" data-cached hidden>✓ Downloaded</span></div>
      <div class="mc-desc">${esc(m.desc)}</div>
      <div class="mc-meta"><span>Download <b>${m.download}</b></span><span>Memory <b>~${fmtMB(m.memMB)}</b></span><span>Speed ${meter(m.speed)}</span><span>Smarts ${meter(m.smarts)}</span></div>
      <div class="mc-warn">⚠️ ${esc(m.warn)}</div>
      <div class="mc-actions">
        <button class="btn ${m.key === settings.model ? '' : 'primary'}" data-use="${m.key}">${m.key === settings.model ? (loadedId === modelIdFor(m) ? '✓ In use' : 'Selected · Load now') : 'Use this model'}</button>
        <button class="btn danger-outline" data-del="${m.key}" hidden>Delete download</button>
      </div>
    </div>`).join('');
  const di = $('#deviceInfo');
  if (!gpu.ok) di.innerHTML = '⚠️ <b>WebGPU not available</b> in this browser, so models can\'t run here. See the note on the main screen.';
  else di.innerHTML = `✅ WebGPU ready${gpu.vendor ? ` · ${esc(gpu.vendor)} ${esc(gpu.arch)}` : ''} · ${gpu.f16 ? 'fast 16-bit mode' : '32-bit mode (a bit more memory)'}${isIOS ? '<br>📱 iPhone tip: <b>Llama 3.2 1B</b> is the best pick. The 3B model may crash Safari.' : ''}`;
  updateStorageInfo();
  if (gpu.ok) {
    try {
      const lib = await getWebLLM();
      for (const m of MODELS) {
        const has = await lib.hasModelInCache(modelIdFor(m)).catch(() => false);
        const card = $(`.model-card[data-key="${m.key}"]`, wrap);
        if (card && has) { $('[data-cached]', card).hidden = false; $('[data-del]', card).hidden = false; }
      }
    } catch {}
  }
}
async function updateStorageInfo() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      $('#storageInfo').textContent = `Using ${fmtMB(usage / 1048576)} of storage${quota ? ` (≈${fmtMB(quota / 1048576)} available to this site)` : ''}`;
    }
  } catch {}
}
async function useModel(key) {
  const m = byKey(key);
  if (isIOS && m.memMB > 1500) {
    if (!await confirmBox(`Load ${m.name} on iPhone?`, `This model needs about ${fmtMB(m.memMB)} of memory. Safari may close the tab if it runs out. Llama 3.2 1B is the safer choice on iPhone.`, 'Load anyway')) return;
  } else if (m.memMB > 2000) {
    if (!await confirmBox(`Download ${m.name}?`, `This is a big model: ${m.download} download and ~${fmtMB(m.memMB)} of memory. Use Wi-Fi. It's saved after the first download.`, 'Download')) return;
  }
  settings.model = key; saveSettings();
  setModelChip(loadedId === modelIdFor(m) ? 'ready' : '');
  $('#modelsDlg').close();
  if (!gpu.ok) { toast('WebGPU isn\'t available here'); return; }
  if (generating) return;
  try { await ensureEngine(key); }
  catch (e) { toast(friendlyError(e), 6000); }
}
async function deleteModel(key) {
  const m = byKey(key);
  if (!await confirmBox(`Delete ${m.name}?`, 'The downloaded files are removed from this device. You can download it again any time.')) return;
  try {
    const lib = await getWebLLM();
    if (engine && loadedId === modelIdFor(m)) { await engine.unload(); loadedId = null; setModelChip(''); }
    await lib.deleteModelAllInfoInCache(m.f16).catch(() => {});
    await lib.deleteModelAllInfoInCache(m.f32).catch(() => {});
    toast(`${m.name} deleted`);
  } catch (e) { toast(friendlyError(e)); }
  renderModels();
}
async function clearAllModels() {
  if (!await confirmBox('Clear all downloaded models?', 'This frees up storage by deleting every downloaded AI model. Your chats are kept. Models will download again when you next use them.', 'Clear models')) return;
  try {
    if (generating) await stop();
    if (engine) { try { await engine.unload(); } catch {} }
    loadedId = null;
    if (gpu.ok || webllm) {
      try {
        const lib = await getWebLLM();
        for (const m of MODELS) { await lib.deleteModelAllInfoInCache(m.f16).catch(() => {}); await lib.deleteModelAllInfoInCache(m.f32).catch(() => {}); }
      } catch {}
    }
    if (window.caches) for (const k of await caches.keys()) if (/webllm|tvmjs/i.test(k)) await caches.delete(k);
    if (indexedDB.databases) {
      for (const d of await indexedDB.databases()) if (d.name && /webllm|tvmjs/i.test(d.name)) indexedDB.deleteDatabase(d.name);
    }
    setModelChip('');
    toast('Downloaded models cleared');
  } catch (e) { toast(friendlyError(e)); }
  renderModels();
}

/* ---------------- Personas dialog ---------------- */
let editingPersona = null;
function renderPersonas() {
  const activeId = current ? current.personaId : settings.personaId;
  $('#personaList').innerHTML = allPersonas().map(p => `
    <button type="button" class="persona ${p.id === activeId ? 'on' : ''}" data-pid="${esc(p.id)}">
      ${p.builtin ? '' : `<span class="pact"><span data-pedit="${esc(p.id)}" title="Edit">✏️</span><span data-pdel="${esc(p.id)}" title="Delete">🗑</span></span>`}
      <div class="pe">${esc(p.emoji)}</div><div class="pn">${esc(p.name)}</div><div class="pd">${esc(p.prompt)}</div>
    </button>`).join('');
}
function openPersonaEditor(p) {
  editingPersona = p || null;
  $('#personaEditorTitle').textContent = p ? `✏️ Edit "${p.name}"` : '＋ Create a persona';
  $('#pEmoji').value = p ? p.emoji : '';
  $('#pName').value = p ? p.name : '';
  $('#pPrompt').value = p ? p.prompt : '';
  $('#personaEditor').open = true;
  $('#pName').focus();
}
async function choosePersona(id) {
  settings.personaId = id; saveSettings();
  if (current) {
    current.personaId = id; current.systemPrompt = null;
    if (current.saved) await saveCurrent();
    renderChat();
  }
  updatePersonaChip(); renderPersonas();
  $('#personasDlg').close();
  toast(`Persona: ${personaById(id).name}`);
}

/* ---------------- Composer ---------------- */
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  updateSendBtn();
}

/* ---------------- Sidebar toggle ---------------- */
function openSidebar() {
  if (matchMedia('(max-width: 820px)').matches) { document.body.classList.add('side-open'); $('#scrim').hidden = false; }
  else { settings.sidebarCollapsed = !settings.sidebarCollapsed; document.body.classList.toggle('side-collapsed', settings.sidebarCollapsed); saveSettings(); }
}
function closeSidebarMobile() { document.body.classList.remove('side-open'); $('#scrim').hidden = true; }

/* ---------------- Settings dialog ---------------- */
function fillSettings() {
  applyTheme();
  $('#customInstr').value = settings.customInstr;
  $('#temp').value = settings.temperature; $('#tempVal').textContent = (+settings.temperature).toFixed(2);
  $('#maxTok').value = settings.maxTokens; $('#maxTokVal').textContent = settings.maxTokens;
  $('#sendEnter').checked = settings.sendEnter;
  $('#showStats').checked = settings.showStats;
  $('#appVersion').textContent = 'v' + APP_VERSION;
}

/* ---------------- Events ---------------- */
function bind() {
  $('#newChat').onclick = () => { if (generating) return toast('Stop the current reply first'); newChat(); };
  $('#openSidebar').onclick = openSidebar;
  $('#closeSidebar').onclick = closeSidebarMobile;
  $('#scrim').onclick = closeSidebarMobile;
  $('#search').addEventListener('input', renderList);

  $('#chatList').addEventListener('click', (e) => {
    const item = e.target.closest('.chat-item'); if (!item) return;
    const a = e.target.closest('[data-a]');
    if (a) { e.stopPropagation(); if (a.dataset.a === 'rename') renameChat(item.dataset.id); else deleteChat(item.dataset.id); return; }
    openChat(item.dataset.id);
  });
  $('#chatList').addEventListener('keydown', (e) => { const item = e.target.closest('.chat-item'); if (item && e.key === 'Enter') openChat(item.dataset.id); });

  $('#suggestions').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) send(b.dataset.s); });

  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (settings.sendEnter || e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input.value); }
  });
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  $('#stopBtn').onclick = stop;

  msgBox().addEventListener('click', async (e) => {
    const cc = e.target.closest('.copy-code');
    if (cc) { const code = cc.closest('.code-block').querySelector('pre').innerText; await copyText(code); cc.textContent = 'Copied!'; setTimeout(() => cc.textContent = 'Copy', 1500); return; }
    const a = e.target.closest('[data-a]'); if (!a) return;
    const row = a.closest('.msg-row'); const idx = +row.dataset.idx; const m = current.messages[idx];
    if (a.dataset.a === 'copy') copyText(m.content);
    else if (a.dataset.a === 'regen') regenerate();
    else if (a.dataset.a === 'edit') editMessage(idx);
    else if (a.dataset.a === 'speak') {
      if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
      const u = new SpeechSynthesisUtterance(m.content.replace(/```[\s\S]*?```/g, ' (code) ').replace(/[*_#`>|]/g, ''));
      speechSynthesis.speak(u);
    }
  });

  // dialogs: close buttons and click-outside
  $$('dialog').forEach(d => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); if (e.target.closest('[data-close]')) d.close(); });
  });

  $('#openModels').onclick = $('#modelChip').onclick = () => { closeSidebarMobile(); $('#modelsDlg').showModal(); renderModels(); };
  $('#modelCards').addEventListener('click', (e) => {
    const u = e.target.closest('[data-use]'); if (u) return useModel(u.dataset.use);
    const d = e.target.closest('[data-del]'); if (d) return deleteModel(d.dataset.del);
  });
  $('#clearModels').onclick = clearAllModels;

  $('#openPersonas').onclick = $('#personaChip').onclick = () => { closeSidebarMobile(); renderPersonas(); $('#personaEditor').open = false; $('#personasDlg').showModal(); };
  $('#personaList').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-pedit]'); if (ed) { e.stopPropagation(); return openPersonaEditor(personaById(ed.dataset.pedit)); }
    const dl = e.target.closest('[data-pdel]');
    if (dl) {
      e.stopPropagation();
      settings.personas = settings.personas.filter(p => p.id !== dl.dataset.pdel);
      if (settings.personaId === dl.dataset.pdel) settings.personaId = 'assistant';
      saveSettings(); renderPersonas(); return;
    }
    const p = e.target.closest('[data-pid]'); if (p) choosePersona(p.dataset.pid);
  });
  $('#pSave').onclick = () => {
    const name = $('#pName').value.trim(), prompt = $('#pPrompt').value.trim();
    if (!name || !prompt) return toast('Give it a name and a system prompt');
    const emoji = $('#pEmoji').value.trim() || '🤖';
    if (editingPersona) Object.assign(settings.personas.find(p => p.id === editingPersona.id), { name, prompt, emoji });
    else settings.personas.push({ id: 'p_' + uid(), name, prompt, emoji });
    saveSettings(); editingPersona = null;
    $('#personaEditor').open = false; $('#pName').value = $('#pPrompt').value = $('#pEmoji').value = '';
    renderPersonas(); updatePersonaChip(); toast('Persona saved');
  };
  $('#pCancel').onclick = () => { editingPersona = null; $('#personaEditor').open = false; };

  $('#openSettings').onclick = () => { closeSidebarMobile(); fillSettings(); $('#settingsDlg').showModal(); };
  $('#themeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.theme = b.dataset.v; saveSettings(); applyTheme(); });
  $('#customInstr').addEventListener('input', (e) => { settings.customInstr = e.target.value; saveSettings(); });
  $('#temp').addEventListener('input', (e) => { settings.temperature = +e.target.value; $('#tempVal').textContent = settings.temperature.toFixed(2); saveSettings(); });
  $('#maxTok').addEventListener('input', (e) => { settings.maxTokens = +e.target.value; $('#maxTokVal').textContent = settings.maxTokens; saveSettings(); });
  $('#sendEnter').addEventListener('change', (e) => { settings.sendEnter = e.target.checked; saveSettings(); });
  $('#showStats').addEventListener('change', (e) => { settings.showStats = e.target.checked; saveSettings(); renderChat(); });
  $('#exportAll').onclick = async () => {
    const all = await db.all();
    download(`pocket-ai-chats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'pocket-ai', version: 1, exportedAt: new Date().toISOString(), chats: all, personas: settings.personas }, null, 2), 'application/json');
  };
  $('#exportMd').onclick = async () => {
    const all = await db.all();
    download(`pocket-ai-chats-${new Date().toISOString().slice(0, 10)}.md`, all.map(chatToMarkdown).join('\n\n'), 'text/markdown');
  };
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : (data.chats || []);
      let n = 0;
      for (const c of list) {
        if (!c || !Array.isArray(c.messages)) continue;
        const chat = { id: c.id || uid(), title: String(c.title || 'Imported chat'), personaId: c.personaId || 'assistant', systemPrompt: c.systemPrompt || null,
          messages: c.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant')).map(m => ({ role: m.role, content: String(m.content || ''), ts: m.ts || Date.now(), model: m.model, stats: m.stats })),
          createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now() };
        await db.put(chat); n++;
      }
      if (Array.isArray(data.personas)) for (const p of data.personas) if (p && p.id && !settings.personas.find(x => x.id === p.id)) settings.personas.push(p);
      saveSettings();
      chats = await db.all(); renderList();
      toast(`Imported ${n} chat${n === 1 ? '' : 's'}`);
    } catch { toast('That file isn\'t a valid Pocket AI export'); }
    e.target.value = '';
  });
  $('#deleteAll').onclick = async () => {
    if (!await confirmBox('Delete all chats?', 'Every saved chat on this device will be permanently deleted.', 'Delete all')) return;
    await db.clear(); chats = []; newChat(); toast('All chats deleted');
  };

  // chat menu
  $('#chatMenuBtn').onclick = (e) => {
    const d = $('#chatMenu');
    const r = e.currentTarget.getBoundingClientRect();
    d.style.top = (r.bottom + 6) + 'px';
    d.style.right = Math.max(8, innerWidth - r.right) + 'px';
    d.style.left = 'auto';
    d.showModal();
  };
  $('#chatMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    $('#chatMenu').close();
    if (!current) return;
    const act = b.dataset.act;
    if (act === 'rename') {
      if (!current.messages.length) return toast('Send a message first');
      renameChat(current.id);
    } else if (act === 'system') {
      const v = await promptBox('System prompt for this chat', current.systemPrompt || personaById(current.personaId).prompt, { multiline: true, placeholder: 'Tell the AI how to behave in this chat…' });
      if (v == null) return;
      const base = personaById(current.personaId).prompt;
      current.systemPrompt = v.trim() && v.trim() !== base ? v.trim() : null;
      if (current.saved || current.messages.length) await saveCurrent();
      updatePersonaChip(); toast('System prompt updated');
    } else if (act === 'exportmd') {
      if (!current.messages.length) return toast('Nothing to export yet');
      download(`${safeName(current.title)}.md`, chatToMarkdown(current), 'text/markdown');
    } else if (act === 'exportjson') {
      if (!current.messages.length) return toast('Nothing to export yet');
      const { saved, ...c } = current;
      download(`${safeName(current.title)}.json`, JSON.stringify({ app: 'pocket-ai', version: 1, chats: [c] }, null, 2), 'application/json');
    } else if (act === 'copy') {
      copyText(chatToMarkdown(current));
    } else if (act === 'delete') {
      if (current.saved) deleteChat(current.id); else newChat();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && generating) stop();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (matchMedia('(max-width: 820px)').matches) openSidebar(); $('#search').focus(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!generating) newChat(); }
  });
}

/* ---------------- Service worker ---------------- */
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Pocket AI updated. Reopen the app to get the new version.', 4000);
      });
    });
  }).catch(() => {});
}

/* ---------------- Boot ---------------- */
async function boot() {
  applyTheme();
  if (settings.sidebarCollapsed && !matchMedia('(max-width: 820px)').matches) document.body.classList.add('side-collapsed');
  renderSuggestions();
  bind();
  setModelChip('');
  try { chats = await db.all(); } catch { chats = []; toast('Couldn\'t open saved chats (private browsing?)'); }
  const last = settings.lastChatId && chats.find(c => c.id === settings.lastChatId);
  if (last && isMobile === false) { current = { ...last, saved: true }; renderChat(); renderList(); updatePersonaChip(); }
  else newChat();
  gpu = await detectGPU();
  showGpuBanner();
  if (gpu.ok) {
    // Show whether the selected model is already on this device, without loading it.
    setTimeout(async () => {
      try {
        const lib = await getWebLLM();
        if (!loadedId && await lib.hasModelInCache(modelIdFor(byKey(settings.model)))) setModelChip('cached');
      } catch {}
    }, 1200);
  }
  registerSW();
  window.__pocketai = { version: APP_VERSION, gpu, ready: true };
}
boot();
