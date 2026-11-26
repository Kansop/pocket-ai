import { db } from './db.js';
import { MODELS, DEFAULT_MODEL, byKey } from './models.js';
import { renderMarkdown, esc } from './markdown.js';
import { webSearch, shouldAutoSearch, resultsToPrompt } from './search.js';
import { parseRemember, parseForget, extractMemories } from './memory.js';
import { getStorage, modelSizes, chatsSizeMB, ramInfo, fitCheck, fmt } from './device.js';

const APP_VERSION = '1.3.0';
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
  { id: 'chef', emoji: '🍳', name: 'Chef', builtin: true,
    prompt: 'You are a friendly home chef. Suggest easy recipes with ingredient lists and numbered steps, offer substitutions, and keep it practical.' },
  { id: 'translator', emoji: '🌍', name: 'Translator', builtin: true,
    prompt: 'You are a translator. Translate the user\'s text accurately and naturally. If the target language is not given, translate between English and Portuguese. Show only the translation unless asked for explanations.' },
];

const DEFAULT_PROMPTS = [
  { label: '🪐 Explain', text: 'Explain how black holes form like I\'m 12' },
  { label: '😂 Poem', text: 'Write a short funny poem about my dog' },
  { label: '📚 Quiz me', text: 'Quiz me on the causes of World War I, one question at a time' },
  { label: '💻 Code', text: 'Write a Python number guessing game' },
  { label: '💡 Ideas', text: 'Give me 5 ideas for a school project on India' },
  { label: '🏋️ Workout', text: 'Plan a 20-minute home workout with no equipment' },
  { label: '📰 News', text: 'Search the web: what are the latest tech news today?' },
];
const WIDGETS = {
  clock: 'Clock & date', storage: 'Memory & storage meter', search: 'Search bar', prompts: 'Quick prompts', recent: 'Recent chats',
  model: 'AI model status', memories: 'Memories', tip: 'Tip of the day',
};
const DEFAULT_WIDGETS = [
  { id: 'clock', on: true }, { id: 'search', on: true }, { id: 'prompts', on: true }, { id: 'recent', on: true },
  { id: 'model', on: true }, { id: 'storage', on: true }, { id: 'memories', on: false }, { id: 'tip', on: true },
];
const ACCENTS = ['#7c5cff', '#3b82f6', '#06b6d4', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7'];
const WALLS = {
  none: { name: 'None', css: '' },
  aurora: { name: 'Aurora', css: 'radial-gradient(at 20% 15%, #7c5cff 0, transparent 50%), radial-gradient(at 80% 10%, #22d3ee 0, transparent 45%), radial-gradient(at 50% 90%, #10b981 0, transparent 55%), #0b1020' },
  sunset: { name: 'Sunset', css: 'linear-gradient(160deg, #ff7e5f 0%, #feb47b 35%, #6a3093 100%)' },
  ocean: { name: 'Ocean', css: 'linear-gradient(170deg, #0f2027 0%, #203a43 45%, #2c5364 100%)' },
  forest: { name: 'Forest', css: 'linear-gradient(165deg, #134e5e 0%, #71b280 100%)' },
  candy: { name: 'Candy', css: 'linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)' },
  midnight: { name: 'Midnight', css: 'radial-gradient(at 70% 20%, #312e81 0, transparent 55%), radial-gradient(at 10% 80%, #831843 0, transparent 50%), #05060a' },
  peach: { name: 'Peach', css: 'linear-gradient(140deg, #ffecd2 0%, #fcb69f 100%)' },
  galaxy: { name: 'Galaxy', css: 'radial-gradient(1px 1px at 20% 30%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 70% 60%, #fff 50%, transparent 51%), radial-gradient(1.5px 1.5px at 40% 80%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 85% 15%, #fff 50%, transparent 51%), radial-gradient(at 50% 50%, #3b0764 0, #020617 70%)' },
};
const EMOJIS = ['✨', '🤖', '🧠', '🦊', '🐱', '🐼', '👾', '🚀', '⚡', '🔥', '🌙', '💎', '🎧', '🦄', '🐉', '😎'];
const TIPS = [
  'Say "remember that …" and I\'ll keep it in mind in every chat.',
  'Tap 🌐 next to the message box to search the web for one message.',
  'Add Pocket AI to your Home Screen: Share → Add to Home Screen. It works offline too.',
  'Llama 3.2 1B is the best model for iPhone. On a Mac, try Llama 3.2 3B.',
  'Make your own persona in 🎭 Personas, like a gym coach or a debate partner.',
  'Press Esc to stop a reply, Ctrl/⌘+K to search chats.',
  'Change the wallpaper and accent color in Settings → Look.',
  'Export all your chats any time from Settings → General.',
];

/* ---------------- Settings ---------------- */
const SETTINGS_KEY = 'pocketai.settings';
const defaults = {
  theme: 'system', customInstr: '', temperature: 0.7, maxTokens: 1024,
  sendEnter: !isMobile, showStats: true, model: DEFAULT_MODEL,
  personaId: 'assistant', personas: [], sidebarCollapsed: false,
  userName: '', aboutMe: '', assistantName: 'Pocket AI', assistantEmoji: '✨',
  autoMemory: true, memories: [], searchMode: 'auto', tavilyKey: '',
  accent: '#7c5cff', wallpaper: 'none', wallDim: 0.45, chatWidth: 'normal',
  homeOnLaunch: true, homeLayout: 'centered', widgets: DEFAULT_WIDGETS, quickPrompts: DEFAULT_PROMPTS,
};
let settings = { ...defaults };
try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch {}
// make sure newly added widgets appear for older saved settings
settings.widgets = [...settings.widgets.filter(w => WIDGETS[w.id]), ...DEFAULT_WIDGETS.filter(d => !settings.widgets.find(w => w.id === d.id))];
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { toast('Couldn\'t save settings (storage full?)'); } };
const asstName = () => (settings.assistantName || '').trim() || 'Pocket AI';
const allPersonas = () => [{ ...BUILTIN_PERSONAS[0], name: asstName(), emoji: settings.assistantEmoji || '✨', prompt: BUILTIN_PERSONAS[0].prompt.replace('You are Pocket AI', `You are ${asstName()}`) }, ...BUILTIN_PERSONAS.slice(1), ...(settings.personas || [])];
const personaById = (id) => allPersonas().find(p => p.id === id) || allPersonas()[0];

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
let activeGen = null;
const fitChecked = new Set();
let webForce = false;        // 🌐 button: force search for the next message
let clockTimer = null;

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
  applyLook();
}
function applyLook() {
  const root = document.documentElement.style;
  root.setProperty('--accent', settings.accent || '#7c5cff');
  let wall = '';
  if (settings.wallpaper === 'custom') { const d = localStorage.getItem('pocketai.wallpaper'); if (d) wall = `url("${d}")`; }
  else if (WALLS[settings.wallpaper]) wall = WALLS[settings.wallpaper].css;
  document.body.classList.toggle('has-wall', !!wall);
  const main = $('#main');
  if (wall) {
    main.style.background = settings.wallpaper === 'custom' ? `${wall} center / cover no-repeat` : wall;
    main.style.backgroundAttachment = 'local';
  } else main.style.background = '';
  root.setProperty('--wall-dim', String(settings.wallDim ?? 0.45));
  document.body.classList.toggle('chat-wide', settings.chatWidth === 'wide');
  const name = asstName();
  $('#brandName').textContent = name;
  $('#brandAv').textContent = settings.assistantEmoji || '✨';
  $('#input').placeholder = `Message ${name}`;
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
  const compact = sessionStorage.getItem('pocketai.gpuBannerCompact') === '1';
  b.classList.toggle('compact', compact);
  b.innerHTML = compact
    ? `<b>⚠️ AI can't run in this browser (needs WebGPU). Tap for help.</b>`
    : `<button class="banner-x" aria-label="Collapse">✕</button><b>⚠️ This browser can't run the AI (needs WebGPU)</b>Pocket AI runs the model on your device's graphics chip using WebGPU, which isn't available here${gpu.reason === 'noadapter' ? ' (no compatible GPU adapter found)' : ''}. You can still read your saved chats.${howTo}`;
  b.onclick = (e) => {
    if (compact) { sessionStorage.removeItem('pocketai.gpuBannerCompact'); showGpuBanner(); }
    else if (e.target.closest('.banner-x')) { sessionStorage.setItem('pocketai.gpuBannerCompact', '1'); showGpuBanner(); }
  };
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
  setTimeout(refreshHomeIfVisible, 0);
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
  if (!fitChecked.has(id)) {
    const st = await collectStats().catch(() => null);
    const warns = st ? fitCheck(m, st.storage, st.ram, !!st.sizes[m.key]) : [];
    if (warns.length && !await confirmBox(`${m.name} might not fit`, warns.join(' ') + ' You can pick a smaller model in Models.', 'Try anyway')) {
      throw Object.assign(new Error('stopped'), { stopped: true });
    }
    fitChecked.add(id);
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
    removeOtherModels(id, lib);  // only after the new model loaded fine
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

// Keep only one model on the device: delete every other cached model (both f16/f32 builds).
async function removeOtherModels(keepId, lib) {
  try {
    const removed = [];
    for (const mm of MODELS) {
      for (const vid of [mm.f16, mm.f32]) {
        if (vid === keepId) continue;
        let has = false;
        try { has = await lib.hasModelInCache(vid); } catch {}
        await lib.deleteModelAllInfoInCache(vid).catch(() => {});
        if (has && mm.f16 !== keepId && mm.f32 !== keepId && !removed.includes(mm.name)) removed.push(mm.name);
      }
    }
    if (removed.length) setTimeout(() => toast(`Replaced ${removed.join(', ')} to free up space`, 3500), 2400);
    lastStats = null;
    refreshHomeIfVisible();
  } catch {}
}
function resetEngine() {
  try { worker && worker.terminate(); } catch {}
  worker = null; engine = null; loadedId = null; loadingPromise = null;
  setModelChip('');
}
function friendlyError(e) {
  const s = String(e && (e.message || e) || 'Unknown error');
  if (/WebGPU/i.test(s) && /not available|not supported|unavailable/i.test(s)) return 'WebGPU is not available in this browser, so the AI can\'t run here.';
  if (/memory|OOM|allocation|device.*lost|DeviceLost|mapAsync|Instance reference|GPUBuffer/i.test(s)) return 'Your device ran out of graphics memory. Try a smaller model (Models → Llama 3.2 1B or Qwen2.5 0.5B) and close other tabs.';
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
  updateSaveBtn();
  closeSidebarMobile();
  setTimeout(() => !isMobile && $('#input').focus(), 30);
}
// Persists the current chat only if the user chose "Save this chat".
async function saveCurrent() {
  if (!current) return;
  current.updatedAt = Date.now();
  if (!current.saved) { updateSaveBtn(); return; }
  await persistCurrent();
}
async function saveThisChat() {
  if (!current || !current.messages.length) return;
  current.saved = true;
  await persistCurrent();
  toast('Chat saved ✓');
}
async function unsaveThisChat() {
  if (!current || !current.saved) return;
  if (!await confirmBox('Remove from saved chats?', 'It will be deleted from your chat list. You can keep reading it until you start a new chat.', 'Remove')) return;
  await db.del(current.id);
  chats = chats.filter(x => x.id !== current.id);
  current.saved = false;
  if (settings.lastChatId === current.id) { settings.lastChatId = null; saveSettings(); }
  renderList(); updateSaveBtn(); refreshHomeIfVisible();
  toast('Removed from saved chats');
}
function updateSaveBtn() {
  const b = $('#saveChatBtn'); if (!b) return;
  const has = !!(current && current.messages.length);
  b.hidden = !has;
  const saved = !!(current && current.saved);
  b.classList.toggle('saved', saved);
  b.innerHTML = saved ? 'Saved ✓<span class="caret">▾</span>' : '💾 <span class="long">Save this chat</span><span class="short">Save</span>';
  b.title = saved ? 'Saved. Tap to remove it from your saved chats' : 'This chat isn\'t saved. It disappears when you start a new chat or close the app.';
}
async function persistCurrent() {
  current.updatedAt = Date.now();
  const { saved, ...rest } = current;
  await db.put(rest);
  const i = chats.findIndex(c => c.id === current.id);
  if (i >= 0) chats[i] = current; else chats.unshift(current);
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  settings.lastChatId = current.id; saveSettings();
  renderList(); updateSaveBtn();
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
  if (current && current.id === id) { current.title = c.title; await saveCurrent(); document.title = `${c.title} · Pocket AI`; }
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
    nav.innerHTML = `<div class="no-chats">${q ? 'No chats match your search.' : 'No saved chats yet.<br>Tap “💾 Save this chat” at the top of a chat to keep it.'}</div>`;
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


function messageEl(m, idx) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + m.role;
  row.dataset.idx = idx;
  if (m.role === 'user') {
    row.innerHTML = `<div class="user-wrap"><div class="bubble"></div><div class="msg-actions"><button data-a="edit" title="Edit">✏️ Edit</button><button data-a="copy" title="Copy">📋</button></div></div>`;
    $('.bubble', row).textContent = m.content;
    if (m.learned && m.learned.length) { const n = document.createElement('div'); n.className = 'memory-note'; n.textContent = '🧠 Remembered: ' + m.learned.join(' · '); $('.user-wrap', row).appendChild(n); }
  } else {
    const p = personaById(current.personaId);
    row.innerHTML = `<div class="avatar">${esc(p.emoji)}</div><div class="content"><div class="bubble"></div><div class="msg-actions"></div></div>`;
    fillAssistant(row, m, idx);
  }
  return row;
}
function fillAssistant(row, m, idx, streaming = false) {
  const b = $('.bubble', row);
  const status = m.searching ? `<div class="search-status"><span class="thinking"><i></i><i></i><i></i></span> Searching the web…</div>`
    : m.searchNote ? `<div class="search-status">🌐 ${esc(m.searchNote)}</div>`
    : (m.sources && m.sources.length && streaming && !m.content) ? `<div class="search-status">🌐 Found ${m.sources.length} sources, thinking…</div>` : '';
  const sources = m.sources && m.sources.length ? `<div class="sources"><span class="src-label">Sources</span>${m.sources.map((x, i) => { let host = ''; try { host = new URL(x.url).hostname.replace(/^www\./, ''); } catch {} return `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" title="${esc(x.title)}"><b>${i + 1}</b>${esc(x.title.length > 42 ? x.title.slice(0, 40) + '…' : x.title)}<span class="muted">· ${esc(host)}</span></a>`; }).join('')}</div>` : '';
  if (m.error) b.innerHTML = status + `<div class="err-note">⚠️ ${esc(m.error)}</div>`;
  else if (!m.content && streaming) b.innerHTML = status + (m.searching ? '' : '<div class="thinking"><i></i><i></i><i></i></div>');
  else b.innerHTML = status + renderMarkdown(m.content || '', { streaming }) + (streaming ? '' : sources);
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
  if (!empty.hidden) renderHome(); else stopClock();
  if (current) current.messages.forEach((m, i) => box.appendChild(messageEl(m, i)));
  if (empty.hidden) scrollBottom(true); else box.scrollTop = 0;
  updateSaveBtn();
  document.title = current && current.messages.length ? `${current.title} · Pocket AI` : 'Pocket AI';
}
function updatePersonaChip() {
  const p = personaById(current ? current.personaId : settings.personaId);
  $('#personaEmoji').textContent = p.emoji;
  $('#personaName').textContent = current && current.systemPrompt ? `${p.name} (custom)` : p.name;
}


/* ---------------- Home page ---------------- */
function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Up late';
  const n = (settings.userName || '').trim();
  return n ? `${part}, ${n}` : `${part}!`;
}
function relTime(ts) {
  const d = Date.now() - ts, m = 60000, h = 60 * m, day = 24 * h;
  if (d < m) return 'just now';
  if (d < h) return Math.floor(d / m) + 'm ago';
  if (d < day) return Math.floor(d / h) + 'h ago';
  if (d < 7 * day) return Math.floor(d / day) + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function stopClock() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }
function tickClock() {
  const now = new Date();
  const t = $('#homeTime'), d = $('#homeDate');
  if (t) t.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d) d.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
function modelStateText() {
  const m = byKey(settings.model);
  const st = $('#modelDot') ? $('#modelDot').className.replace('dot', '').trim() : '';
  const label = !gpu ? 'Checking device…' : !gpu.ok ? 'WebGPU not available in this browser' : st === 'ready' ? 'Loaded and ready' : st === 'loading' ? 'Loading…' : st === 'cached' ? 'Downloaded, loads when you chat' : `Downloads ${m.download} on first message`;
  return { m, st, label };
}
function renderHome() {
  const el = $('#empty');
  const layout = settings.homeLayout || 'centered';
  el.className = 'home layout-' + layout;
  const name = asstName();
  const parts = [];
  parts.push(`<div class="w-greet"><div class="home-av">${esc(settings.assistantEmoji || '✨')}</div><div><h1>${esc(greeting())}</h1><p class="sub">${layout === 'minimal' ? 'What can I help with?' : `I'm ${esc(name)}. I run 100% on your device: private, free, unlimited, and I work offline.`}</p></div></div>`);
  const widgets = layout === 'minimal' ? settings.widgets.filter(w => w.on && (w.id === 'prompts' || w.id === 'search')) : settings.widgets.filter(w => w.on);
  for (const w of widgets) {
    if (w.id === 'clock') parts.push(`<div class="widget w-clock"><span class="time" id="homeTime"></span><span class="date" id="homeDate"></span></div>`);
    else if (w.id === 'search') parts.push(`<form class="widget w-search" id="homeSearch"><span>🔎</span><input id="homeSearchInput" type="search" placeholder="Search the web or ask ${esc(name)}…" autocomplete="off" aria-label="Search the web"><button type="submit">Ask</button></form>`);
    else if (w.id === 'prompts') parts.push(`<div class="widget w-prompts"><h3>Quick prompts <button type="button" data-home="editPrompts">Edit</button></h3><div class="chips">${(settings.quickPrompts || []).map((q, i) => !q.text.trim() ? '' : `<button type="button" data-qp="${i}" title="${esc(q.text)}">${esc(q.label || q.text.slice(0, 30))}</button>`).join('') || '<span class="muted-empty">No quick prompts yet.</span>'}</div></div>`);
    else if (w.id === 'recent') {
      const rec = chats.slice(0, 5);
      parts.push(`<div class="widget w-recent"><h3>Recent chats ${chats.length > 5 ? '<button type="button" data-home="allChats">See all</button>' : ''}</h3><div class="recent">${rec.map(c => `<button type="button" data-open="${esc(c.id)}"><span>${esc(personaById(c.personaId).emoji)}</span><span class="rt">${esc(c.title)}</span><span class="rd">${relTime(c.updatedAt)}</span></button>`).join('') || '<span class="muted-empty">Your chats will show up here.</span>'}</div></div>`);
    }
    else if (w.id === 'model') {
      const { m, st, label } = modelStateText();
      parts.push(`<div class="widget w-model"><h3>AI model <button type="button" data-home="models">Change</button></h3><div class="mrow"><span class="dot ${st}"></span><b>${esc(m.name)}</b><span class="muted small">${esc(label)}</span></div></div>`);
    }
    else if (w.id === 'storage') {
      parts.push(`<div class="widget w-storage"><h3>Memory & storage <button type="button" data-home="storage">Details</button></h3><div id="homeStorage">${lastStats ? storageBarHTML(lastStats, true) + ramHTML(lastStats.ram, true) : '<span class="muted-empty">Checking…</span>'}</div></div>`);
      collectStats().then(st => { const el = $('#homeStorage'); if (el) el.innerHTML = storageBarHTML(st, true) + ramHTML(st.ram, true); }).catch(() => {});
    }
    else if (w.id === 'memories') {
      const mem = settings.memories || [];
      parts.push(`<div class="widget w-mem"><h3>What I remember <button type="button" data-home="memories">Manage</button></h3>${mem.length ? `<ul>${mem.slice(-5).reverse().map(x => `<li>${esc(x.text)}</li>`).join('')}</ul>` : '<span class="muted-empty">Nothing yet. Say "remember that …" in a chat.</span>'}</div>`);
    }
    else if (w.id === 'tip') {
      const tip = TIPS[Math.floor(Date.now() / 86400000) % TIPS.length];
      parts.push(`<div class="widget w-tip"><h3>Tip</h3><p>${esc(tip)}</p></div>`);
    }
  }
  el.innerHTML = parts.join('');
  stopClock();
  if ($('#homeTime')) { tickClock(); clockTimer = setInterval(tickClock, 15000); }
}
function refreshHomeIfVisible() { if (!$('#empty').hidden) renderHome(); }

/* ---------------- Generation ---------------- */
// Remove role-play emotes such as *smiles warmly* or *emotes a warm "paw-print"*.
function stripEmotes(t) {
  return t
    .replace(/(^|[\s>])\*(?!\*)(?:emotes?|smiles?|grins?|laughs?|giggles?|winks?|nods?|waves?|hugs?|purrs?|wags?|paws?|sighs?|chuckles?|beams?|leans?|tilts?|blushes?|gives?|offers?|sends?|does|makes?)\b[^*\n]{0,120}\*(?!\*)/gi, '$1')
    .replace(/(?:\b(?:it|he|she|i)\s+)?\b(?:emotes?|\*emotes?)\s+an?\s+[^.!?\n]{0,80}?["“'][^"”'\n]{1,40}["”'][.!]?/gi, '')
    .replace(/ {2,}/g, ' ');
}
function systemPromptFor(c, extra = '') {
  let sp = c.systemPrompt || personaById(c.personaId).prompt;
  if (c.personaId !== 'assistant' || c.systemPrompt) sp += `\nYour name is ${asstName()}.`;
  const now = new Date();
  sp += `\nToday is ${now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
  if (settings.userName.trim()) sp += `\nThe user's name is ${settings.userName.trim()}.`;
  if (settings.aboutMe.trim()) sp += `\nAbout the user: ${settings.aboutMe.trim()}`;
  const mem = (settings.memories || []).slice(-30);
  if (mem.length) sp += `\nFacts you remember about the user ("I"/"my" in a fact means the user). Use them naturally when relevant; don't list them unprompted:\n${mem.map(m => '- ' + m.text).join('\n')}`;
  if (settings.customInstr.trim()) sp += `\n\nThe user's custom instructions (follow them):\n${settings.customInstr.trim()}`;
  if (extra) sp += `\n\n${extra}`;
  sp += `\n\nNever role-play. Do not write actions, emotes or stage directions (like *smiles*, *paw-print*, (laughs) or "emotes ..."). Do not pretend to be an animal or character. Reply in plain, normal sentences.`;
  return sp;
}
function buildMessages(c, extra = '') {
  const sys = systemPromptFor(c, extra);
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
  // local commands: remember / forget (no model needed)
  const rem = parseRemember(text), forget = !rem && parseForget(text);
  if (rem) {
    const fact = normalizeFact(rem);
    addMemory(fact, false);
    current.messages.push({ role: 'assistant', content: `Got it 👍 I'll remember: **${fact}**\n\nYou can see and edit everything I remember in Settings → You & Memory.`, ts: Date.now(), local: true });
    webForce = false; updateWebBtn();
    await saveCurrent(); renderChat(); return;
  }
  if (forget) {
    const q = forget.toLowerCase().replace(/^(that|about)\s+/, '');
    const before = settings.memories.length;
    const words = q.split(/\s+/).filter(w => w.length > 2);
    settings.memories = settings.memories.filter(m => { const t = m.text.toLowerCase(); return !(t.includes(q) || (words.length && words.every(w => t.includes(w)))); });
    const n = before - settings.memories.length; saveSettings();
    current.messages.push({ role: 'assistant', content: n ? `Done, I forgot ${n} thing${n > 1 ? 's' : ''} about that. 🧹` : `I couldn't find a memory matching "${forget}". You can manage memories in Settings → You & Memory.`, ts: Date.now(), local: true });
    await saveCurrent(); renderChat(); return;
  }
  const learned = settings.autoMemory ? extractMemories(text).filter(f => addMemory(f, true)) : [];
  if (learned.length) current.messages[current.messages.length - 1].learned = learned;
  await saveCurrent();
  renderChat();
  await generate();
}
function normalizeFact(t) {
  t = t.trim().replace(/[.!]+$/, '');
  const ex = extractMemories(t + '.');
  if (ex.length === 1) return ex[0];
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function addMemory(text, auto) {
  text = text.trim();
  if (!text) return false;
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (settings.memories.some(m => norm(m.text) === norm(text))) return false;
  // replace an older fact with the same subject, e.g. "User's favorite food is …"
  const subj = text.match(/^(User's (?:name|favorite [\w ]+?|birthday)) is /);
  if (subj) settings.memories = settings.memories.filter(m => !m.text.startsWith(subj[1] + ' is '));
  settings.memories.push({ id: uid(), text, auto: !!auto, ts: Date.now() });
  saveSettings();
  return true;
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
  let finished = false;
  const finish = async () => {
    if (finished) return; finished = true;
    if (activeGen && activeGen.finish === finish) activeGen = null;
    setGenerating(false);
    if (c === current) { fillAssistant(row, reply, idx, false); scrollBottom(); }
    // refresh previous assistant actions (remove retry from older)
    if (c === current) { const prev = $$('.msg-row.assistant', msgBox()); prev.slice(0, -1).forEach(r => { const i = +r.dataset.idx; const mm = c.messages[i]; if (mm) fillAssistant(r, mm, i); }); }
    current = c;
    await saveCurrent();
  };
  activeGen = { finish, reply, model: m };
  try {
    if (!gpu.ok) throw new Error('WebGPU is not available in this browser, so the AI can\'t run here. See the note at the top for how to fix it.');
    const lastUser = [...c.messages].reverse().find(x => x.role === 'user');
    const forced = webForce; webForce = false; updateWebBtn();
    const wantSearch = settings.searchMode !== 'off' || forced
      ? (forced || settings.searchMode === 'always' || shouldAutoSearch(lastUser ? lastUser.content : ''))
      : false;
    let extra = '';
    if (wantSearch && lastUser) {
      if (!navigator.onLine) reply.searchNote = 'Offline: answered without web search.';
      else {
        reply.searching = true; fillAssistant(row, reply, idx, true);
        const res = await webSearch(lastUser.content, { tavilyKey: settings.tavilyKey.trim() });
        reply.searching = false;
        if (res.results.length) { reply.sources = res.results.map(r => ({ title: r.title, url: r.url })); extra = resultsToPrompt(res); }
        else reply.searchNote = 'Web search found nothing useful, answering from what I know.';
        fillAssistant(row, reply, idx, true);
      }
      if (stopRequested) throw Object.assign(new Error('stopped'), { stopped: true });
    }
    const eng = await ensureEngine();
    if (finished) return;
    if (stopRequested) throw Object.assign(new Error('stopped'), { stopped: true });
    const stream = await eng.chat.completions.create({
      messages: buildMessages({ ...c, messages: c.messages.slice(0, -1) }, extra),
      stream: true,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      stream_options: { include_usage: true },
    });
    let pending = false, usage = null;
    for await (const chunk of stream) {
      if (finished) break;
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (d) reply.content = stripEmotes(reply.content + d);
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
    else {
      reply.error = friendlyError(e);
      if (/lost|mapAsync|Instance reference|GPUBuffer|memory/i.test(String(e && e.message || e))) resetEngine();
    }
  } finally {
    await finish();
  }
}
async function stop() {
  stopRequested = true;
  const g = activeGen;
  try { if (engine && generating) engine.interruptGenerate(); } catch {}
  // If the GPU is busy (e.g. a long prompt on a slow device) the interrupt can lag.
  // After a short grace period, finish the reply in the UI and restart the engine.
  setTimeout(() => {
    if (g && activeGen === g) {
      g.reply.content = g.reply.content || '_(stopped)_';
      g.reply.stats = `${g.model.name} · stopped`;
      if (engine && !loadingPromise) resetEngine();  // keep a model download going
      g.finish();
    }
  }, 2500);
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
        <button class="btn ${m.key === settings.model ? '' : 'primary'}" data-use="${m.key}">${m.key === settings.model ? (loadedId === modelIdFor(m) ? '✓ In use' : 'Selected · Load now') : 'Switch to this model'}</button>
        <button class="btn danger-outline" data-del="${m.key}" hidden>Delete download</button>
      </div>
    </div>`).join('');
  const di = $('#deviceInfo');
  if (!gpu.ok) di.innerHTML = '⚠️ <b>WebGPU not available</b> in this browser, so models can\'t run here. See the note on the main screen.';
  else di.innerHTML = `✅ WebGPU ready${gpu.vendor ? ` · ${esc(gpu.vendor)} ${esc(gpu.arch)}` : ''} · ${gpu.f16 ? 'fast 16-bit mode' : '32-bit mode (a bit more memory)'}${isIOS ? '<br>📱 iPhone tip: <b>Llama 3.2 1B</b> is the best pick. The 3B model may crash Safari.' : ''}`;
  updateStorageInfo();
  const st = await collectStats().catch(() => null);
  if (st) {
    for (const m of MODELS) {
      const card = $(`.model-card[data-key="${m.key}"]`, wrap); if (!card) continue;
      const z = st.sizes[m.key];
      if (z) { const c = $('[data-cached]', card); c.hidden = false; c.textContent = `✓ Downloaded · ${fmt(z.mb)}`; $('[data-del]', card).hidden = false; }
      const warns = fitCheck(m, st.storage, st.ram, !!z);
      const fit = document.createElement('div');
      fit.className = warns.length ? 'fit-bad' : 'fit-ok';
      fit.textContent = warns.length ? '⚠️ ' + warns.join(' ') : (st.ram.tabBudgetMB || st.storage.freeMB != null ? '✓ Should fit on this device' : '');
      if (fit.textContent) $('.mc-warn', card).after(fit);
    }
  }
  if (gpu.ok) {
    try {
      const lib = await getWebLLM();
      for (const m of MODELS) {
        const card = $(`.model-card[data-key="${m.key}"]`, wrap);
        if (!card || !$('[data-cached]', card).hidden) continue;
        const has = await lib.hasModelInCache(modelIdFor(m)).catch(() => false);
        if (has) { $('[data-cached]', card).hidden = false; $('[data-del]', card).hidden = false; }
      }
    } catch {}
  }
}
async function updateStorageInfo() {
  try {
    const s = await getStorage();
    if (s.supported) $('#storageInfo').textContent = `Using ${fmt(s.usageMB)}${s.freeMB != null ? ` · ~${fmt(s.freeMB)} free for this site` : ''}`;
  } catch {}
}
async function useModel(key) {
  const m = byKey(key);
  const st = await collectStats().catch(() => null);
  const downloaded = !!(st && st.sizes[m.key]);
  const warns = st ? fitCheck(m, st.storage, st.ram, downloaded) : [];
  if (warns.length) {
    if (!await confirmBox(`${m.name} might not fit`, warns.join(' ') + (isIOS ? ' Llama 3.2 1B is the safer choice on iPhone.' : ' Try a smaller model if it fails.'), 'Load anyway')) return;
  } else if (isIOS && m.memMB > 1500) {
    if (!await confirmBox(`Load ${m.name} on iPhone?`, `This model needs about ${fmtMB(m.memMB)} of memory. Safari may close the tab if it runs out. Llama 3.2 1B is the safer choice on iPhone.`, 'Load anyway')) return;
  } else if (!downloaded && m.memMB > 2000) {
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


/* ---------------- Storage / memory meter ---------------- */
let lastStats = null;
async function collectStats() {
  const [storage, sizes] = await Promise.all([getStorage(), modelSizes(MODELS, modelIdFor)]);
  const modelsMB = Object.values(sizes).reduce((a, b) => a + b.mb, 0);
  const chatMB = chatsSizeMB(chats) + chatsSizeMB(settings) + ((localStorage.getItem('pocketai.wallpaper') || '').length / 1048576);
  lastStats = { storage, sizes, modelsMB, chatMB, ram: ramInfo(gpu) };
  return lastStats;
}
function storageBarHTML(st, compact = false) {
  const { storage, modelsMB, chatMB } = st;
  if (!storage.supported || !storage.quotaMB) return `<div class="muted small">This browser doesn't report storage space.${modelsMB ? ` Models use ~${fmt(modelsMB)}.` : ''}</div>`;
  const q = storage.quotaMB, used = storage.usageMB;
  const other = Math.max(0, used - modelsMB - chatMB);
  const pct = (x) => Math.max(0, Math.min(100, x / q * 100)).toFixed(2) + '%';
  return `<div class="meter-block">
    <div class="meter-head"><b>Storage</b><span>${fmt(used)} used · <b>${fmt(storage.freeMB)} free</b>${compact ? '' : ` of ${fmt(q)}`}</span></div>
    <div class="meter-bar" role="img" aria-label="Storage used ${fmt(used)} of ${fmt(q)}"><i class="seg-models" style="width:${pct(modelsMB)}"></i><i class="seg-chats" style="width:${pct(chatMB)}"></i><i class="seg-other" style="width:${pct(other)}"></i></div>
    <div class="meter-legend"><span style="--c:var(--accent)">Models ${fmt(modelsMB)}</span><span style="--c:var(--accent-2)">Chats & settings ${fmt(chatMB)}</span><span style="--c:var(--muted)">App & other ${fmt(other)}</span></div>
    ${compact ? '' : `<div class="muted small" style="margin-top:6px">"Free" is how much this site may use, as reported by your browser${/iPad|iPhone|iPod/.test(navigator.userAgent) ? ' (Safari reports a rough estimate)' : ''}. ${storage.persisted ? '🔒 Storage is protected from automatic cleanup.' : 'The browser may clear it if your device gets very low on space.'}</div>`}
  </div>`;
}
function ramHTML(ram, compact = false) {
  const rows = [];
  if (ram.deviceGB) rows.push(['Device memory (RAM)', `${ram.deviceGB} GB${ram.exact ? '' : ' <span class="est">estimate</span>'}`]);
  else rows.push(['Device memory (RAM)', 'Not shared by this browser']);
  if (ram.tabBudgetMB) rows.push(['Likely free for the AI', `~${fmt(ram.tabBudgetMB)} <span class="est">estimate</span>`]);
  if (!compact && ram.heapLimitMB) rows.push(['Page memory (JS heap)', `${fmt(ram.heapUsedMB)} of ${fmt(ram.heapLimitMB)}`]);
  if (!compact && ram.gpuMaxBufferMB) rows.push(['GPU max buffer', fmt(ram.gpuMaxBufferMB)]);
  const loaded = loadedId ? MODELS.find(m => m.f16 === loadedId || m.f32 === loadedId) : null;
  rows.push(['AI model in memory', loaded ? `${esc(loaded.name)} · ~${fmt(loaded.memMB)}` : 'None loaded']);
  let bar = '';
  if (ram.tabBudgetMB) {
    const usedMB = loaded ? loaded.memMB : 0;
    bar = `<div class="meter-head" style="margin-top:10px"><b>Memory</b><span>${loaded ? `~${fmt(usedMB)} used by AI · ` : ''}~${fmt(Math.max(0, ram.tabBudgetMB - usedMB))} left <span class="est">estimate</span></span></div><div class="meter-bar ram"><i style="width:${Math.min(100, usedMB / ram.tabBudgetMB * 100).toFixed(1)}%"></i></div>`;
  }
  return `${bar}<div class="ram-grid" style="margin-top:10px">${rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('')}</div>${!compact && ram.notes.length ? `<p class="muted small">${ram.notes.map(esc).join(' ')}</p>` : ''}`;
}
async function renderStoragePane() {
  const pane = $('#storagePane');
  const st = await collectStats();
  const rows = MODELS.map(m => {
    const z = st.sizes[m.key];
    const warns = fitCheck(m, st.storage, st.ram, !!z);
    return `<div><span>${esc(m.name)} ${z ? '' : '<span class="muted small">· not downloaded</span>'}${warns.length ? ` <span class="est" title="${esc(warns.join(' '))}">⚠️ may not fit</span>` : ''}</span><span>${z ? fmt(z.mb) + (z.estimated ? ' <span class="est">estimate</span>' : '') : `<span class="muted">${m.download}</span>`}</span></div>`;
  }).join('');
  pane.innerHTML = `${storageBarHTML(st)}
    <label style="font-weight:600;font-size:14px">Downloaded models</label>
    <div class="size-list">${rows}<div><span>Chats, memories & settings</span><span>${fmt(st.chatMB)}</span></div></div>
    <div style="margin-top:18px"><label style="font-weight:600;font-size:14px">Memory (RAM)</label>${ramHTML(st.ram)}</div>`;
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
const segOn = (sel, v) => $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
function fillSettings() {
  applyTheme();
  $('#customInstr').value = settings.customInstr;
  $('#temp').value = settings.temperature; $('#tempVal').textContent = (+settings.temperature).toFixed(2);
  $('#maxTok').value = settings.maxTokens; $('#maxTokVal').textContent = settings.maxTokens;
  $('#sendEnter').checked = settings.sendEnter;
  $('#showStats').checked = settings.showStats;
  $('#appVersion').textContent = 'v' + APP_VERSION;
  // me
  $('#userName').value = settings.userName; $('#asstName').value = settings.assistantName === 'Pocket AI' ? '' : settings.assistantName;
  $('#aboutMe').value = settings.aboutMe; $('#autoMemory').checked = settings.autoMemory;
  renderEmojiPick(); renderMemories();
  // search
  segOn('#searchSeg', settings.searchMode); $('#tavilyKey').value = settings.tavilyKey;
  // look
  renderAccents(); renderWalls(); segOn('#widthSeg', settings.chatWidth);
  $('#wallDimVal').textContent = settings.wallDim <= 0.2 ? 'Low' : settings.wallDim >= 0.65 ? 'High' : 'Medium';
  // home
  $('#homeOnLaunch').checked = settings.homeOnLaunch; segOn('#layoutSeg', settings.homeLayout);
  renderWidgetList(); renderQuickPrompts();
}
function showTab(t) {
  $$('#setTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $$('#settingsDlg [data-pane]').forEach(p => p.hidden = p.dataset.pane !== t);
  if (t === 'storage') renderStoragePane();
}
function openSettings(tab = 'general') { closeSidebarMobile(); fillSettings(); showTab(tab); if (!$('#settingsDlg').open) $('#settingsDlg').showModal(); }
function renderEmojiPick() {
  const cur = settings.assistantEmoji || '✨';
  $('#emojiPick').innerHTML = EMOJIS.map(e => `<button type="button" data-emoji="${e}" class="${e === cur ? 'on' : ''}">${e}</button>`).join('') +
    `<input type="text" id="emojiCustom" maxlength="4" placeholder="Any" value="${EMOJIS.includes(cur) ? '' : esc(cur)}" aria-label="Custom emoji">`;
}
function renderMemories() {
  const mem = settings.memories || [];
  $('#memCount').textContent = mem.length ? `(${mem.length})` : '';
  $('#memList').innerHTML = mem.length ? mem.slice().reverse().map(m => `<div class="mem" data-mid="${m.id}"><span class="mt" contenteditable="true" spellcheck="false">${esc(m.text)}</span>${m.auto ? '<span class="auto">auto</span>' : ''}<button type="button" data-mdel="${m.id}" title="Delete" aria-label="Delete memory">🗑</button></div>`).join('')
    : '<div class="mem-empty">No memories yet.</div>';
}
function renderAccents() {
  $('#accentSw').innerHTML = ACCENTS.map(c => `<button type="button" data-accent="${c}" style="background:${c}" class="${c === settings.accent ? 'on' : ''}" aria-label="Accent ${c}"></button>`).join('') +
    `<input type="color" id="accentCustom" value="${esc(settings.accent)}" title="Custom color" aria-label="Custom accent color">`;
}
function renderWalls() {
  const custom = localStorage.getItem('pocketai.wallpaper');
  $('#wallPick').innerHTML = Object.entries(WALLS).map(([k, w]) => `<button type="button" data-wall="${k}" class="${k === 'none' ? 'none ' : ''}${settings.wallpaper === k ? 'on' : ''}" style="${w.css ? `background:${w.css}` : ''}">${esc(w.name)}</button>`).join('') +
    (custom ? `<button type="button" data-wall="custom" class="${settings.wallpaper === 'custom' ? 'on' : ''}" style="background-image:url('${custom}')">Yours</button>` : '');
}
function renderWidgetList() {
  const ws = settings.widgets;
  $('#widgetList').innerHTML = ws.map((w, i) => `<div class="wrow" data-wi="${i}"><input type="checkbox" class="toggle" data-wtoggle="${i}" ${w.on ? 'checked' : ''} aria-label="Show ${esc(WIDGETS[w.id])}"><span class="wn">${esc(WIDGETS[w.id])}</span><button type="button" data-wup="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button type="button" data-wdown="${i}" ${i === ws.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></div>`).join('');
}
function renderQuickPrompts() {
  $('#qpList').innerHTML = (settings.quickPrompts || []).map((q, i) => `<div class="qrow" data-qi="${i}"><input class="ql" data-qf="label" value="${esc(q.label)}" placeholder="Label" maxlength="30"><input class="qt" data-qf="text" value="${esc(q.text)}" placeholder="Prompt text"><button type="button" data-qdel="${i}" aria-label="Delete prompt">✕</button></div>`).join('') || '<div class="mem-empty">No quick prompts. Add one below.</div>';
}
async function loadWallpaperFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 1600, scale = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    let q = 0.82, data = cv.toDataURL('image/jpeg', q);
    while (data.length > 1.6e6 && q > 0.4) { q -= 0.12; data = cv.toDataURL('image/jpeg', q); }
    localStorage.setItem('pocketai.wallpaper', data);
    settings.wallpaper = 'custom'; saveSettings(); applyLook(); renderWalls(); toast('Wallpaper set');
  } catch { toast('Couldn\'t use that image (too big or unsupported)'); }
  finally { URL.revokeObjectURL(url); }
}
function updateWebBtn() {
  const b = $('#webBtn'); if (!b) return;
  const mode = settings.searchMode;
  const on = webForce || mode === 'always';
  b.classList.toggle('on', on);
  b.classList.toggle('off', !on && mode === 'off');
  $('#webBtnLabel').textContent = webForce ? 'On' : mode === 'always' ? 'Always' : mode === 'auto' ? 'Auto' : 'Off';
  b.title = webForce ? 'Web search ON for your next message (tap to cancel)' : mode === 'auto' ? 'Web search: auto-detect. Tap to force for the next message' : mode === 'always' ? 'Web search on every message' : 'Web search off. Tap to search for the next message';
}

/* ---------------- Events ---------------- */
function bind() {
  $('#saveChatBtn').onclick = () => { if (current && current.saved) unsaveThisChat(); else saveThisChat(); };
  $('#goHome').onclick = () => { if (generating) return toast('Stop the current reply first'); newChat(); };
  $('#webBtn').onclick = () => {
    if (settings.searchMode === 'always') { openSettings('search'); return; }
    webForce = !webForce; updateWebBtn();
    toast(webForce ? '🌐 Web search on for your next message' : 'Web search back to ' + (settings.searchMode === 'auto' ? 'auto-detect' : 'off'));
  };
  // home page interactions
  $('#empty').addEventListener('click', (e) => {
    const qp = e.target.closest('[data-qp]'); if (qp) { const q = settings.quickPrompts[+qp.dataset.qp]; if (q) send(q.text); return; }
    const op = e.target.closest('[data-open]'); if (op) { openChat(op.dataset.open); return; }
    const h = e.target.closest('[data-home]'); if (!h) return;
    const a = h.dataset.home;
    if (a === 'editPrompts') openSettings('home');
    else if (a === 'memories') openSettings('me');
    else if (a === 'storage') openSettings('storage');
    else if (a === 'models') { $('#modelsDlg').showModal(); renderModels(); }
    else if (a === 'allChats') { if (matchMedia('(max-width: 820px)').matches) openSidebar(); else { document.body.classList.remove('side-collapsed'); settings.sidebarCollapsed = false; saveSettings(); } }
  });
  $('#empty').addEventListener('submit', (e) => {
    if (e.target.id !== 'homeSearch') return;
    e.preventDefault();
    const v = $('#homeSearchInput').value.trim(); if (!v) return;
    if (settings.searchMode !== 'always') webForce = true;
    send(v);
  });
  // settings tabs
  $('#setTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
  // you & memory
  $('#userName').addEventListener('input', (e) => { settings.userName = e.target.value; saveSettings(); refreshHomeIfVisible(); });
  $('#asstName').addEventListener('input', (e) => { settings.assistantName = e.target.value.trim() || 'Pocket AI'; saveSettings(); applyLook(); updatePersonaChip(); refreshHomeIfVisible(); });
  $('#aboutMe').addEventListener('input', (e) => { settings.aboutMe = e.target.value; saveSettings(); });
  $('#autoMemory').addEventListener('change', (e) => { settings.autoMemory = e.target.checked; saveSettings(); });
  $('#emojiPick').addEventListener('click', (e) => { const b = e.target.closest('[data-emoji]'); if (!b) return; settings.assistantEmoji = b.dataset.emoji; saveSettings(); renderEmojiPick(); applyLook(); updatePersonaChip(); renderChat(); renderList(); });
  $('#emojiPick').addEventListener('input', (e) => { if (e.target.id !== 'emojiCustom') return; const v = e.target.value.trim(); if (!v) return; settings.assistantEmoji = v; saveSettings(); $$('#emojiPick button').forEach(b => b.classList.remove('on')); applyLook(); updatePersonaChip(); });
  $('#memList').addEventListener('click', (e) => { const d = e.target.closest('[data-mdel]'); if (!d) return; settings.memories = settings.memories.filter(m => m.id !== d.dataset.mdel); saveSettings(); renderMemories(); });
  $('#memList').addEventListener('focusout', (e) => {
    const t = e.target.closest('.mt'); if (!t) return;
    const id = t.closest('.mem').dataset.mid; const m = settings.memories.find(x => x.id === id); if (!m) return;
    const v = t.textContent.trim();
    if (!v) settings.memories = settings.memories.filter(x => x.id !== id); else { m.text = v; m.auto = false; }
    saveSettings(); renderMemories();
  });
  $('#memList').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('.mt')) { e.preventDefault(); e.target.blur(); } });
  const addMem = () => { const v = $('#memNew').value.trim(); if (!v) return; if (addMemory(normalizeFact(v), false)) { $('#memNew').value = ''; renderMemories(); toast('Memory added'); } else toast('Already remembered'); };
  $('#memAddBtn').onclick = addMem;
  $('#memNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addMem(); } });
  $('#memClear').onclick = async () => { if (!settings.memories.length) return; if (!await confirmBox('Clear all memories?', 'Everything the AI remembers about you will be deleted.', 'Clear')) return; settings.memories = []; saveSettings(); renderMemories(); };
  // search
  $('#searchSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.searchMode = b.dataset.v; webForce = false; saveSettings(); segOn('#searchSeg', settings.searchMode); updateWebBtn(); });
  $('#tavilyKey').addEventListener('input', (e) => { settings.tavilyKey = e.target.value.trim(); saveSettings(); });
  $('#testSearch').onclick = async () => {
    const out = $('#testSearchOut'); out.textContent = 'Searching…';
    const r = await webSearch('Eiffel Tower height', { tavilyKey: settings.tavilyKey.trim() });
    out.textContent = r.offline ? 'You are offline.' : r.results.length ? `✅ ${r.results.length} results via ${r.provider}` : '⚠️ No results (network blocked?)';
  };
  // look
  $('#accentSw').addEventListener('click', (e) => { const b = e.target.closest('[data-accent]'); if (!b) return; settings.accent = b.dataset.accent; saveSettings(); applyLook(); renderAccents(); });
  $('#accentSw').addEventListener('input', (e) => { if (e.target.id !== 'accentCustom') return; settings.accent = e.target.value; saveSettings(); applyLook(); $$('#accentSw button').forEach(b => b.classList.remove('on')); });
  $('#wallPick').addEventListener('click', (e) => { const b = e.target.closest('[data-wall]'); if (!b) return; settings.wallpaper = b.dataset.wall; saveSettings(); applyLook(); renderWalls(); });
  $('#wallUpload').onclick = () => $('#wallFile').click();
  $('#wallFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadWallpaperFile(f); e.target.value = ''; });
  $('#wallDim').onclick = () => { const steps = [0.2, 0.45, 0.7]; const i = steps.findIndex(x => Math.abs(x - settings.wallDim) < 0.05); settings.wallDim = steps[(i + 1) % steps.length]; saveSettings(); applyLook(); fillSettings(); };
  $('#widthSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.chatWidth = b.dataset.v; saveSettings(); applyLook(); segOn('#widthSeg', settings.chatWidth); });
  // home settings
  $('#homeOnLaunch').addEventListener('change', (e) => { settings.homeOnLaunch = e.target.checked; saveSettings(); });
  $('#layoutSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.homeLayout = b.dataset.v; saveSettings(); segOn('#layoutSeg', settings.homeLayout); refreshHomeIfVisible(); });
  $('#widgetList').addEventListener('change', (e) => { const t = e.target.closest('[data-wtoggle]'); if (!t) return; settings.widgets[+t.dataset.wtoggle].on = t.checked; saveSettings(); refreshHomeIfVisible(); });
  $('#widgetList').addEventListener('click', (e) => {
    const up = e.target.closest('[data-wup]'), dn = e.target.closest('[data-wdown]'); if (!up && !dn) return;
    const i = +(up ? up.dataset.wup : dn.dataset.wdown), j = up ? i - 1 : i + 1;
    const w = settings.widgets; if (j < 0 || j >= w.length) return;
    [w[i], w[j]] = [w[j], w[i]]; saveSettings(); renderWidgetList(); refreshHomeIfVisible();
  });
  $('#qpList').addEventListener('input', (e) => { const f = e.target.closest('[data-qf]'); if (!f) return; const i = +f.closest('.qrow').dataset.qi; settings.quickPrompts[i][f.dataset.qf] = f.value; saveSettings(); refreshHomeIfVisible(); });
  $('#qpList').addEventListener('click', (e) => { const d = e.target.closest('[data-qdel]'); if (!d) return; settings.quickPrompts.splice(+d.dataset.qdel, 1); saveSettings(); renderQuickPrompts(); refreshHomeIfVisible(); });
  $('#qpAdd').onclick = () => { settings.quickPrompts.push({ label: '⭐ New', text: '' }); saveSettings(); renderQuickPrompts(); const rows = $$('#qpList .qt'); rows[rows.length - 1]?.focus(); };
  $('#qpReset').onclick = () => { settings.quickPrompts = DEFAULT_PROMPTS.map(x => ({ ...x })); saveSettings(); renderQuickPrompts(); refreshHomeIfVisible(); };
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
  $('#clearModels2').onclick = async () => { await clearAllModels(); renderStoragePane(); };
  $('#storageRefresh').onclick = renderStoragePane;

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

  $('#openSettings').onclick = () => openSettings('general');
  $('#themeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; settings.theme = b.dataset.v; saveSettings(); applyTheme(); });
  $('#customInstr').addEventListener('input', (e) => { settings.customInstr = e.target.value; saveSettings(); });
  $('#temp').addEventListener('input', (e) => { settings.temperature = +e.target.value; $('#tempVal').textContent = settings.temperature.toFixed(2); saveSettings(); });
  $('#maxTok').addEventListener('input', (e) => { settings.maxTokens = +e.target.value; $('#maxTokVal').textContent = settings.maxTokens; saveSettings(); });
  $('#sendEnter').addEventListener('change', (e) => { settings.sendEnter = e.target.checked; saveSettings(); });
  $('#showStats').addEventListener('change', (e) => { settings.showStats = e.target.checked; saveSettings(); renderChat(); });
  $('#exportAll').onclick = async () => {
    const all = await db.all();
    download(`pocket-ai-chats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'pocket-ai', version: 1, exportedAt: new Date().toISOString(), chats: all, personas: settings.personas, memories: settings.memories }, null, 2), 'application/json');
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
      if (Array.isArray(data.memories)) for (const m of data.memories) if (m && m.text) addMemory(String(m.text), !!m.auto);
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
  bind();
  setModelChip('');
  try { chats = await db.all(); } catch { chats = []; toast('Couldn\'t open saved chats (private browsing?)'); }
  const last = settings.lastChatId && chats.find(c => c.id === settings.lastChatId);
  if (last && !settings.homeOnLaunch) { current = { ...last, saved: true }; renderChat(); renderList(); updatePersonaChip(); }
  else newChat();
  updateWebBtn();
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
