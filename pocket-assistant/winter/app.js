const BUILD = '1.6.10';
const MODEL_URL = 'model.json?v=' + BUILD;
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.89/lib/index.js';
const STORE = 'pocket-assistant-winter-v2';
const STORE_OLD = 'pocket-assistant-winter';
const SETTINGS_VER = 2;
const MODELS = {
  'qwen-3b': {
    key: 'qwen-3b',
    name: 'Qwen2.5 3B',
    f16: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-3B-Instruct-q4f32_1-MLC',
    download: '~2 GB',
  },
  'qwen-1.5b': {
    key: 'qwen-1.5b',
    name: 'Qwen2.5 1.5B',
    f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    download: '~850 MB',
  },
};
const STYLE_HINT = {
  short: 'Reply in 1 to 3 short sentences.',
  normal: 'Reply in a clear paragraph or two. Add a short example when it helps.',
  detailed: 'Reply with a fuller explanation and short steps when they help. Stay on the question.',
};
const MAX_TOKENS = { short: 160, normal: 400, detailed: 700 };

let model, stop = new Set(), gpu = null, webllm = null, engine = null, worker = null;
let loadedKey = null, loadingPromise = null, generating = false, readyAI = false;
let settings = loadSettings();
const chatTurns = [];
let pendingPhoto = null;

const $ = (id) => document.getElementById(id);
const menu = document.querySelector('#menu');
const historyBox = document.querySelector('#history');
const field = document.querySelector('#q');

const CHAT_STORE = 'pocket-assistant-winter-chats-v1';
const CHAT_STORE_OLD = ['pocket-assistant-winter-chats', 'pocket-assistant-winter-history'];

let chats = [];
let currentId = null;
let stickToBottom = true;
let snowRAF = 0;
let snowResizeBound = false;

function uid() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function threadEl() { return $('thread') || document.scrollingElement; }
function isWide() { return window.matchMedia('(min-width: 900px)').matches; }

function titleFrom(messages) {
  const u = (messages || []).find(m => m && m.role === 'user' && (m.text || m.content));
  return u ? String(u.text || u.content).replace(/\s+/g, ' ').trim().slice(0, 48) : '';
}
function sanitizeMsg(m) {
  if (!m || typeof m !== 'object') return null;
  const role = m.role === 'user' ? 'user' : 'assistant';
  const text = String(m.text || m.content || m.q || '').slice(0, 8000);
  if (!text && !m.title && !m.code) return null;
  const out = { role, text };
  if (Array.isArray(m.choices)) out.choices=m.choices.filter(x=>typeof x==='string').slice(0,3);
  if (m.title) out.title = String(m.title).slice(0, 160);
  if (m.note) out.note = String(m.note).slice(0, 2000);
  if (m.code) out.code = String(m.code).slice(0, 8000);
  if (m.output || m.answer) out.output = String(m.output || m.answer).slice(0, 8000);
  if (Array.isArray(m.sources)) {
    out.sources = m.sources.slice(0, 6).map(s => ({
      title: String((s && (s.title || s.url)) || 'Source').slice(0, 120),
      url: String((s && s.url) || ''),
    })).filter(s => s.url);
  }
  return out;
}
function sanitizeChat(c) {
  if (!c || typeof c !== 'object') return null;
  const messages = Array.isArray(c.messages) ? c.messages.map(sanitizeMsg).filter(Boolean) : [];
  if (!messages.length && !c.id) return null;
  return {
    id: String(c.id || uid()),
    title: String(c.title || titleFrom(messages) || 'New chat').slice(0, 80),
    messages,
    updated: Number(c.updated) || Date.now(),
  };
}
function normalizeChats(raw) {
  if (!raw) return [];
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (Array.isArray(raw.chats)) list = raw.chats;
  else if (Array.isArray(raw.messages)) list = [{ id: uid(), title: titleFrom(raw.messages) || 'Earlier chat', messages: raw.messages, updated: Date.now() }];
  else if (raw.role && (raw.text || raw.content)) list = [{ id: uid(), title: String(raw.text || raw.content).slice(0, 48), messages: [raw], updated: Date.now() }];
  else return [];
  const looksLikeMessages = list.length && list.every(x => x && (x.role === 'user' || x.role === 'assistant') && !x.messages);
  if (looksLikeMessages) {
    list = [{ id: uid(), title: titleFrom(list) || 'Earlier chat', messages: list, updated: Date.now() }];
  }
  const asChats = list.map(sanitizeChat).filter(c => c && c.messages.length);
  if (asChats.length > 8 && asChats.every(c => c.messages.length <= 1)) {
    const messages = asChats.flatMap(c => c.messages);
    return [{ id: uid(), title: titleFrom(messages) || 'Earlier chat', messages, updated: Date.now() }];
  }
  return asChats.sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 80);
}
function loadChats() {
  chats = [];
  currentId = null;
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(CHAT_STORE) || 'null'); } catch { raw = null; }
  if (!raw) {
    for (const k of CHAT_STORE_OLD) {
      try { raw = JSON.parse(localStorage.getItem(k) || 'null'); } catch { raw = null; }
      if (raw) break;
    }
  }
  try { chats = normalizeChats(raw); }
  catch { chats = []; }
  if (raw && raw.currentId && chats.some(c => c.id === raw.currentId)) currentId = raw.currentId;
  else if (chats.length) currentId = chats[0].id;
}
function saveChats() {
  const payload = { v: 1, currentId, chats: chats.filter(c => c.messages && c.messages.length) };
  try { localStorage.setItem(CHAT_STORE, JSON.stringify(payload)); }
  catch {
    payload.chats = payload.chats.slice(0, Math.max(8, payload.chats.length - 12));
    try { localStorage.setItem(CHAT_STORE, JSON.stringify(payload)); } catch {}
  }
}
function currentChat() { return chats.find(c => c.id === currentId) || null; }
function ensureChat() {
  let c = currentChat();
  if (c) return c;
  c = { id: uid(), title: 'New chat', messages: [], updated: Date.now() };
  chats.unshift(c);
  currentId = c.id;
  return c;
}
function persistMessage(msg) {
  const c = ensureChat();
  if (msg.role === 'user' && msg.text && !c.messages.some(m => m.role === 'user')) {
    c.title = msg.text.replace(/\s+/g, ' ').trim().slice(0, 48) || c.title;
  }
  if (msg.role === 'assistant' && (!c.title || c.title === 'New chat') && msg.title) c.title = String(msg.title).slice(0, 48);
  c.messages.push(msg);
  c.updated = Date.now();
  chats.sort((a, b) => b.updated - a.updated);
  saveChats();
  renderChatList();
  document.body.classList.add('chat-on');
}
function mountSources(card, sources) {
  if (!sources || !sources.length) return;
  const src = document.createElement('p');
  src.className = 'sources';
  src.append('Sources: ');
  sources.forEach((r, i) => {
    if (i) src.append(' · ');
    const a = document.createElement('a');
    a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = (r.title || 'Source').replace(/ \(Wikipedia\)$/, '');
    src.append(a);
  });
  card.append(src);
}
function mountMessage(msg) {
  const card = document.createElement('article');
  card.className = 'msg ' + (msg.role === 'user' ? 'user' : 'bot');
  if (msg.role === 'user') {
    add(card, 'p', msg.text || '');
  } else {
    if (msg.title) add(card, 'h2', msg.title);
    add(card, 'p', msg.text || '').className = 'body';
    if (msg.note) add(card, 'p', msg.note).className = 'note';
    if (msg.code) {
      add(card, 'pre', msg.code);
      if (msg.output) {
        const reveal = add(card, 'details', '');
        add(reveal, 'summary', 'Reveal the output');
        add(reveal, 'pre', msg.output);
      }
    }
    mountSources(card, msg.sources);
    if (msg.choices && model) topicChoices(card,msg.choices.map(title => model.topics.find(t=>t.title===title)).filter(Boolean));
  }
  historyBox.append(card);
  return card;
}
function updateJump() {
  const btn = $('jumpBottom');
  if (btn) btn.hidden = stickToBottom;
}
function scrollToBottom(force) {
  const el = threadEl();
  if (!el) return;
  if (!force && !stickToBottom) { updateJump(); return; }
  el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
  stickToBottom = true;
  updateJump();
}
function afterMessage(force) {
  const go = () => scrollToBottom(!!force);
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
}
function bindScroll() {
  const el = threadEl();
  if (!el || el.dataset.scrollBound) return;
  el.dataset.scrollBound = '1';
  el.addEventListener('scroll', () => {
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom = gap < 72;
    updateJump();
  }, { passive: true });
  const btn = $('jumpBottom');
  if (btn) btn.onclick = () => scrollToBottom(true);
}
function openSidebar() {
  document.body.classList.add('side-open');
  const shade = $('shade');
  if (shade && !isWide()) shade.hidden = false;
}
function closeSidebar() {
  document.body.classList.remove('side-open');
  const shade = $('shade');
  if (shade) shade.hidden = true;
}
function bindSwipe(row, id) {
  let x0 = 0, dx = 0, on = false;
  row.addEventListener('touchstart', (e) => { x0 = e.changedTouches[0].clientX; dx = 0; on = true; }, { passive: true });
  row.addEventListener('touchmove', (e) => {
    if (!on) return;
    dx = e.changedTouches[0].clientX - x0;
    if (dx < 0) row.style.transform = 'translateX(' + Math.max(dx, -84) + 'px)';
  }, { passive: true });
  const end = () => {
    if (!on) return;
    on = false;
    if (dx < -56) deleteChat(id);
    row.style.transform = '';
    dx = 0;
  };
  row.addEventListener('touchend', end);
  row.addEventListener('touchcancel', end);
}
function renderChatList() {
  const nav = $('chatList');
  if (!nav) return;
  nav.replaceChildren();
  const visible = chats.filter(c => c.messages && c.messages.length);
  if (!visible.length) {
    const p = document.createElement('p');
    p.className = 'empty-chats';
    p.textContent = 'No chats yet';
    nav.append(p);
    return;
  }
  for (const c of visible) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (c.id === currentId ? ' active' : '');
    row.dataset.id = c.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-open';
    btn.textContent = c.title || 'New chat';
    btn.onclick = () => openChat(c.id);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-del';
    del.setAttribute('aria-label', 'Delete chat');
    del.textContent = '×';
    del.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
    row.append(btn, del);
    bindSwipe(row, c.id);
    nav.append(row);
  }
}
function openChat(id) {
  const c = chats.find(x => x.id === id);
  if (!c) return;
  currentId = id;
  saveChats();
  historyBox.replaceChildren();
  for (const m of c.messages) mountMessage(m);
  document.body.classList.toggle('chat-on', c.messages.length > 0);
  renderChatList();
  stickToBottom = true;
  scrollToBottom(true);
  if (!isWide()) closeSidebar();
  greet();
}
function newChat() {
  const cur = currentChat();
  if (cur && !cur.messages.length) {
    historyBox.replaceChildren();
    document.body.classList.remove('chat-on');
    stickToBottom = true;
    scrollToBottom(true);
    if (!isWide()) closeSidebar();
    greet();
    return;
  }
  currentId = null;
  chats = chats.filter(c => c.messages.length);
  saveChats();
  historyBox.replaceChildren();
  document.body.classList.remove('chat-on');
  renderChatList();
  stickToBottom = true;
  scrollToBottom(true);
  if (!isWide()) closeSidebar();
  greet();
}
function deleteChat(id) {
  chats = chats.filter(c => c.id !== id);
  if (currentId === id) {
    currentId = null;
    historyBox.replaceChildren();
    document.body.classList.remove('chat-on');
    greet();
  }
  saveChats();
  renderChatList();
}
function bindChatUI() {
  loadChats();
  renderChatList();
  bindScroll();
  const menuBtn = $('menuBtn');
  if (menuBtn) menuBtn.onclick = openSidebar;
  const closeBtn = $('closeSidebar');
  if (closeBtn) closeBtn.onclick = closeSidebar;
  const shade = $('shade');
  if (shade) shade.onclick = closeSidebar;
  const nc = $('newChat');
  if (nc) nc.onclick = newChat;
  if (currentChat() && currentChat().messages.length) openChat(currentId);
  else document.body.classList.remove('chat-on');
}
function contextTurns() {
  const c = currentChat();
  const turns = [];
  for (const m of (c && c.messages) || []) {
    if (m.role === 'user' && m.text) turns.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant' && m.text) turns.push({ role: 'assistant', content: m.text });
  }
  return turns.slice(-6);
}

function stopSnow() {
  if (snowRAF) cancelAnimationFrame(snowRAF);
  snowRAF = 0;
  const canvas = $('snowCanvas');
  if (canvas) {
    try {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    } catch {}
    canvas.hidden = true;
  }
}
function startSnow() {
  const canvas = $('snowCanvas');
  if (!canvas) return;
  canvas.hidden = false;
  if (snowRAF) cancelAnimationFrame(snowRAF);
  const ctx = canvas.getContext('2d', { alpha: true });
  let w = 0, h = 0, pile = new Uint8Array(0), flakes = [];
  const CAP = 52;
  const COL = 3;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.max(1, Math.floor(w / COL));
    const next = new Uint8Array(n);
    if (pile.length) {
      for (let i = 0; i < n; i++) next[i] = pile[Math.floor(i * pile.length / n)] || 0;
    }
    pile = next;
  }
  function spawn() {
    const count = w < 500 ? 26 : 38;
    flakes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 1 + Math.random() * 2.2,
      vy: 0.45 + Math.random() * 0.9,
      vx: -0.25 + Math.random() * 0.5,
    }));
  }
  resize();
  spawn();
  if (!snowResizeBound) {
    snowResizeBound = true;
    window.addEventListener('resize', () => { if (snowRAF) resize(); });
  }
  let last = 0;
  function tick(ts) {
    if (!snowRAF && last) return;
    if (document.hidden || canvas.hidden) { snowRAF = requestAnimationFrame(tick); return; }
    const dt = Math.min(32, (ts - last) || 16) / 16;
    last = ts;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.84)';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < pile.length; i++) ctx.lineTo((i + 0.5) * COL, h - pile[i]);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    for (const f of flakes) {
      f.x += f.vx * dt + Math.sin((ts / 800) + f.y) * 0.15;
      f.y += f.vy * dt;
      if (f.x < -4) f.x = w + 4;
      if (f.x > w + 4) f.x = -4;
      const col = Math.max(0, Math.min(pile.length - 1, Math.floor(f.x / COL)));
      const ground = h - pile[col];
      if (f.y + f.r >= ground) {
        if (pile[col] < CAP) {
          pile[col] = Math.min(CAP, pile[col] + Math.ceil(f.r));
          if (col > 0 && pile[col] > pile[col - 1] + 3) pile[col - 1] = Math.min(CAP, pile[col - 1] + 1);
          if (col + 1 < pile.length && pile[col] > pile[col + 1] + 3) pile[col + 1] = Math.min(CAP, pile[col + 1] + 1);
        }
        f.y = -6;
        f.x = Math.random() * w;
      }
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    snowRAF = requestAnimationFrame(tick);
  }
  snowRAF = requestAnimationFrame(tick);
}
function initSnow() {
  const canvas = $('snowCanvas');
  const box = $('snowToggle');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (settings.snow == null) {
    settings.snow = !reduced;
    saveSettings();
  }
  if (box) {
    box.checked = !!settings.snow && !reduced;
    box.disabled = reduced;
    box.onchange = () => {
      settings.snow = box.checked;
      saveSettings();
      if (settings.snow && !reduced) startSnow();
      else stopSnow();
    };
  }
  if (settings.snow && !reduced) startSnow();
  else stopSnow();
  if (canvas && reduced) canvas.hidden = true;
}



function loadSettings() {
  const base = { name: 'Luca', style: 'normal', model: 'qwen-1.5b', search: true, onDeviceAI: false, photoAI: false, ver: SETTINGS_VER };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null') || {}; }
  catch { saved = {}; }
  if (!saved.ver) {
    try { saved = Object.assign({}, JSON.parse(localStorage.getItem(STORE_OLD) || '{}'), saved); }
    catch {}
  }
  if (saved.ver !== SETTINGS_VER) {
    return Object.assign({}, base, {
      name: saved.name || base.name,
      style: saved.style || base.style,
      search: saved.search !== false,
      model: 'qwen-1.5b',
      onDeviceAI: false,
      photoAI: false,
      ver: SETTINGS_VER,
    });
  }
  return Object.assign({}, base, saved, {
    onDeviceAI: !!saved.onDeviceAI,
    photoAI: !!saved.photoAI,
    model: saved.model === 'qwen-3b' || saved.model === 'qwen-1.5b' ? saved.model : 'qwen-1.5b',
    ver: SETTINGS_VER,
  });
}
function saveSettings() {
  localStorage.setItem(STORE, JSON.stringify({
    name: settings.name,
    style: settings.style,
    model: settings.model,
    search: !!settings.search,
    onDeviceAI: !!settings.onDeviceAI,
    photoAI: !!settings.photoAI,
    snow: settings.snow !== false,
    ver: SETTINGS_VER,
  }));
}
function setOnDeviceAI(on) {
  settings.onDeviceAI = !!on;
  saveSettings();
  const box = $('onDeviceAI');
  if (box) box.checked = settings.onDeviceAI;
}
function setPhotoAI(on) {
  settings.photoAI = !!on;
  saveSettings();
  const box = $('photoAI');
  if (box) box.checked = settings.photoAI;
}

function decodeMatrices(raw) {
  for (const key of ['W', 'V']) {
    const { bytes, scale, cols } = raw[key];
    const data = atob(bytes);
    const signed = new Int8Array(Uint8Array.from(data, c => c.charCodeAt(0)).buffer);
    raw[key] = Array.from({ length: signed.length / cols }, (_, i) => Float32Array.from(signed.subarray(i * cols, (i + 1) * cols), n => n * scale));
  }
  return raw;
}

// Rank distinctive terms in the topic name, example phrasings and explanation
// alongside the neural score. Build the index only once per model load.
let termIndex;
const filler = new Set('about would could whats thing things example example simple basic really know explain please practical someone connection english terms actually matter someone talking remember everyday specifically does when should question understand work what why how which where with help give topic behind think describe quick mean'.split(' '));
function searchTerms(text) {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const terms = [];
  for (let word of words) {
    if (word.length < 2 || stop.has(word) || filler.has(word)) continue;
    if (word.length > 5 && word.endsWith('ies')) word = word.slice(0, -3) + 'y';
    else if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) word = word.slice(0, -1);
    terms.push(word);
  }
  return new Set(terms.concat(terms.slice(1).map((w,i) => terms[i] + ' ' + w)));
}
function buildTermIndex() {
  const byTopic = model.topics.map(() => new Map());
  function collect(index, text, weight) {
    const weights = byTopic[index];
    for (const term of searchTerms(text)) weights.set(term, Math.max(weight,weights.get(term) || 0));
  }
  for (const [text,id] of Object.entries(model.exact)) collect(id,text,1);
  model.topics.forEach((topic,id) => { collect(id,topic.title,1.3); collect(id,topic.desc,.55); });
  const inverted = new Map();
  byTopic.forEach((weights,id) => {
    for (const [term,weight] of weights) {
      if (!inverted.has(term)) inverted.set(term,[]);
      inverted.get(term).push([id,weight]);
    }
  });
  return inverted;
}
function addTermEvidence(scores,text) {
  if (!termIndex) termIndex = buildTermIndex();
  const evidence = new Float32Array(scores.length);
  let mass = 0;
  for (const term of searchTerms(text)) {
    const hits = termIndex.get(term);
    if (!hits) continue;
    const idf = Math.log(1 + scores.length / hits.length);
    mass += idf;
    for (const [i,w] of hits) evidence[i] += w * idf;
  }
  if (!mass) return scores;
  const scale = 3.2 / Math.sqrt(Math.max(mass,10));
  return scores.map((score,i) => score + evidence[i]*scale);
}

function featuresFor(s) {
  const words = (s.toLowerCase().match(/[a-z0-9_]+|==|=/g) || []).filter(w => !stop.has(w));
  const definition = s.toLowerCase().trim().match(/^what(?: is|'s|s| are) (?:an? |the )?([a-z0-9-]+)[?!.]*$/);
  if (definition && !Object.prototype.hasOwnProperty.call(model.vocab, definition[1])) return null;
  const features = new Set(words);
  for (const w of words) {
    const p = '^' + w + '$';
    for (let i = 0; i < p.length - 2; i++) features.add('~' + p.slice(i, i + 3));
  }
  const ids = [...features].filter(t => Object.prototype.hasOwnProperty.call(model.vocab, t)).map(t => model.vocab[t]);
  if (!ids.length || ids.length / features.size < .43) return null;
  return ids;
}

function scoreQuery(s) {
  const ids = featuresFor(s);
  if (!ids) return null;
  const norm = Math.sqrt(ids.reduce((n, i) => n + model.idf[i] ** 2, 0));
  const hidden = model.V.map((_, j) => Math.tanh(ids.reduce((n, i) => n + model.W[i][j] * model.idf[i] / norm, 0)));
  return addTermEvidence(model.topics.map((_, k) => hidden.reduce((n, h, j) => n + h * model.V[j][k], 0)),s);
}

function classify(s) {
  const phrase = (s.toLowerCase().match(/[a-z0-9_]+|==|=/g) || []).join(' ');
  if (Object.prototype.hasOwnProperty.call(model.exact, phrase)) return model.exact[phrase];
  const scores = scoreQuery(s);
  if (!scores) return -1;
  const max = Math.max(...scores);
  return 1 / scores.reduce((n, x) => n + Math.exp(x - max), 0) >= .74 ? scores.indexOf(max) : -1;
}

function retrieve(s, k = 3) {
  const phrase = (s.toLowerCase().match(/[a-z0-9_]+|==|=/g) || []).join(' ');
  const out = [];
  const seen = new Set();
  if (Object.prototype.hasOwnProperty.call(model.exact, phrase)) {
    const i = model.exact[phrase];
    out.push(i); seen.add(i);
  }
  const scores = scoreQuery(s);
  if (scores) {
    const order = scores.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) {
      if (seen.has(i)) continue;
      out.push(i); seen.add(i);
      if (out.length >= k) break;
    }
  }
  return out.slice(0, k).map(i => model.topics[i]);
}

function add(parent, tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  parent.append(el);
  return el;
}

function showCanned(i, q, note, opts) {
  const skipUser = opts && opts.skipUser;
  if (q && !skipUser) {
    const user = { role: 'user', text: q };
    mountMessage(user);
    persistMessage(user);
  }
  const msg = { role: 'assistant', text: '' };
  if (i < 0) {
    msg.text = 'I haven’t learned a reliable answer to that yet. Try a question from the topic menu, or turn on on-device AI in Settings.';
    if (opts?.choices?.length) msg.choices = opts.choices.map(t => t.title);
    if (opts?.choices?.length) msg.text = 'Which of these topics did you mean?';
    if (note) msg.note = note;
    const card = mountMessage(msg);
    persistMessage(msg);
    afterMessage(true);
    return card;
  }
  const t = model.topics[i];
  msg.title = t.title;
  if (opts?.choices?.length) msg.choices = opts.choices.map(t => t.title);
  msg.text = opts?.reply || t.desc;
  if (note) msg.note = note;
  if (t.code && !opts?.reply) { msg.code = t.code; msg.output = t.answer; }
  const card = mountMessage(msg);
  persistMessage(msg);
  afterMessage(true);
  return card;
}

function setStatus(text) { $('status').textContent = text; }

function showProgress(on, text, pct, sub) {
  const box = $('progress');
  box.hidden = !on;
  if (!on) return;
  if (text != null) $('progressText').textContent = text;
  if (pct != null) $('fill').style.width = (Math.max(0, Math.min(1, pct)) * 100).toFixed(1) + '%';
  if (sub != null) $('progressSub').textContent = sub;
}

function prettyProgress(report, m) {
  const t = report.text || '';
  const fromCache = /cache/i.test(t) && !/fetch/i.test(t);
  const mb = t.match(/(\d+(?:\.\d+)?)\s*MB/);
  if (/Fetching|fetch/i.test(t)) return `Downloading ${m.name}${mb ? ' · ' + Math.round(+mb[1]) + ' MB' : ''}`;
  if (fromCache) return `Loading ${m.name} from this device`;
  if (/shader|compil|GPU/i.test(t)) return `Preparing ${m.name} on your GPU`;
  return `Loading ${m.name}`;
}

function isOom(err) {
  return /memory|OOM|allocation|device.*lost|DeviceLost|mapAsync|GPUBuffer|out of memory|exceeded/i.test(String(err && (err.message || err) || err));
}


const SEARCH_STOP = new Set('a an the is are was were be been of to in on for and or with about can could would should you your me my i please tell what whats who whos when where which how why do does did search look up lookup google find web online internet latest current today news give show explain'.split(' '));
function shouldAutoSearch(text) {
  const t = text.toLowerCase();
  if (t.length < 8) return false;
  if (/\b(search|look ?up|google|on the (web|internet)|online)\b/.test(t)) return true;
  if (/\b(latest|current(ly)?|today|tonight|yesterday|this (week|month|year)|right now|news|recent(ly)?|update[sd]?|price of|stock|score|weather|release date|came out|20(2[4-9]|3\d))\b/.test(t)) return true;
  if (/^(who|what|when|where)\s+(is|was|are|were|did)\s+[a-z]/.test(t) && !/\b(you|your|i|my|me)\b/.test(t)) return true;
  return false;
}
function toSearchQuery(text) {
  let q = text.replace(/[?!.,"“”]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = q.split(' ');
  const kept = words.filter(w => !SEARCH_STOP.has(w.toLowerCase()));
  q = (kept.length >= 1 ? kept : words).join(' ');
  return q.slice(0, 120);
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
async function wikipedia(q) {
  const base = 'https://en.wikipedia.org/w/api.php?format=json&origin=*';
  const sres = await withTimeout(fetch(`${base}&action=query&list=search&srlimit=3&srsearch=${encodeURIComponent(q)}`).then(r => r.json()), 7000);
  const hits = (sres.query && sres.query.search) || [];
  if (!hits.length) return [];
  const ids = hits.map(h => h.pageid).join('|');
  const ex = await withTimeout(fetch(`${base}&action=query&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exchars=700&pageids=${ids}`).then(r => r.json()), 7000);
  const pages = (ex.query && ex.query.pages) || {};
  return hits.map(h => pages[h.pageid]).filter(Boolean).map(pg => ({
    title: pg.title + ' (Wikipedia)',
    url: pg.fullurl || ('https://en.wikipedia.org/?curid=' + pg.pageid),
    snippet: (pg.extract || '').replace(/\s+/g, ' ').trim(),
  })).filter(r => r.snippet);
}
let jsonpN = 0;
function duckduckgo(q) {
  return new Promise((resolve) => {
    const cb = '__passist_ddg' + (++jsonpN);
    const script = document.createElement('script');
    const done = (v) => { clearTimeout(t); try { delete window[cb]; } catch {} script.remove(); resolve(v); };
    const t = setTimeout(() => done([]), 5000);
    window[cb] = (d) => {
      const out = [];
      if (d && d.AbstractText) out.push({ title: (d.Heading || q) + (d.AbstractSource ? ` (${d.AbstractSource})` : ''), url: d.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, snippet: d.AbstractText });
      if (d && d.Answer && typeof d.Answer === 'string') out.push({ title: 'DuckDuckGo answer', url: `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, snippet: d.Answer });
      if (d && d.Definition) out.push({ title: 'Definition' + (d.DefinitionSource ? ` (${d.DefinitionSource})` : ''), url: d.DefinitionURL || `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, snippet: d.Definition });
      if (out.length < 2 && d && Array.isArray(d.RelatedTopics)) {
        for (const rt of d.RelatedTopics) { if (rt && rt.Text && rt.FirstURL) out.push({ title: rt.Text.split(' - ')[0].slice(0, 80), url: rt.FirstURL, snippet: rt.Text }); if (out.length >= 3) break; }
      }
      done(out);
    };
    script.onerror = () => done([]);
    script.src = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&t=pocketassistant&callback=${cb}`;
    document.head.appendChild(script);
  });
}
async function webSearch(text) {
  const query = toSearchQuery(text);
  if (!navigator.onLine) return { query, results: [], offline: true };
  const [w, d] = await Promise.all([wikipedia(query).catch(() => []), duckduckgo(query).catch(() => [])]);
  const seen = new Set();
  const results = [...d, ...w].filter(r => r.url && !seen.has(r.url) && seen.add(r.url)).slice(0, 4);
  return { query, results };
}
function resultsToPrompt(res) {
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return `Web search results for "${res.query}" (fetched ${date}). Use them if they are relevant, and mention sources in plain words. If they don't answer the question, say so.\n` +
    res.results.map((r, i) => `[${i + 1}] ${r.title}: ${r.snippet.slice(0, 600)}`).join('\n');
}

async function detectGPU() {
  if (!('gpu' in navigator) || !navigator.gpu) return { ok: false, reason: 'nogpu' };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ok: false, reason: 'noadapter' };
    return { ok: true, f16: adapter.features.has('shader-f16') };
  } catch (e) {
    return { ok: false, reason: 'error', error: String(e && e.message || e) };
  }
}

function modelIdFor(m) { return (gpu && gpu.ok && !gpu.f16) ? m.f32 : m.f16; }

async function getWebLLM() {
  if (!webllm) webllm = await import(WEBLLM_URL);
  return webllm;
}

function resetEngine() {
  try { worker && worker.terminate(); } catch {}
  worker = null; engine = null; loadedKey = null; readyAI = false;
}

async function loadEngine(key, { fallback = true } = {}) {
  const m = MODELS[key] || MODELS['qwen-1.5b'];
  if (!gpu || !gpu.ok) throw new Error('WebGPU is not available in this browser.');
  if (engine && loadedKey === m.key && !loadingPromise) return engine;
  if (loadingPromise) {
    await loadingPromise.catch(() => {});
    if (engine && loadedKey === m.key) return engine;
  }
  loadingPromise = (async () => {
    readyAI = false;
    setStatus(`Loading ${m.name}… Quick answers still work in the meantime.`);
    showProgress(true, `Starting ${m.name}…`, 0, `First time: downloads ${m.download} once, then it’s saved on this device. Keep this tab open.`);
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
    const lib = await getWebLLM();
    const id = modelIdFor(m);
    const cb = (r) => {
      const cached = /cache/i.test(r.text || '') && !/fetch/i.test(r.text || '');
      showProgress(true, prettyProgress(r, m), r.progress || 0, cached
        ? 'Already downloaded, loading into memory…'
        : `Downloads ${m.download} once, then it’s saved and works offline. Keep this tab open.`);
    };
    const chatOpts = { context_window_size: 4096 };
    if (engine && loadedKey && loadedKey !== m.key) {
      try { await engine.unload(); } catch {}
      resetEngine();
    }
    if (!engine) {
      worker = new Worker(new URL('./worker.js?v=' + BUILD, import.meta.url), { type: 'module' });
      engine = await lib.CreateWebWorkerMLCEngine(worker, id, { initProgressCallback: cb }, chatOpts);
    } else {
      engine.setInitProgressCallback(cb);
      await engine.reload(id, chatOpts);
    }
    loadedKey = m.key;
    readyAI = true;
    showProgress(false);
    setStatus(`${m.name} is ready. Ask a question and it will write a reply.`);
    return engine;
  })();
  try {
    return await loadingPromise;
  } catch (e) {
    showProgress(false);
    resetEngine();
    setOnDeviceAI(false);
    setStatus(friendlyError(e) + ' I turned on-device AI off so Safari doesn’t keep crashing. Built-in answers and web search still work.');
    throw e;
  } finally {
    loadingPromise = null;
  }
}

function friendlyError(e) {
  const s = String(e && (e.message || e) || 'Unknown error');
  if (/WebGPU/i.test(s) && /not available|not supported|unavailable/i.test(s)) return 'WebGPU is not available in this browser, so the AI can’t run here.';
  if (isOom(e)) return 'This device ran out of graphics memory while loading the model.';
  if (/QuotaExceeded|quota|storage/i.test(s)) return 'Not enough storage space to save the model.';
  if (/Failed to fetch|NetworkError|network/i.test(s)) return 'Download failed. Check your internet connection and try again (progress so far is saved).';
  return s.length > 220 ? s.slice(0, 220) + '…' : s;
}

function stripEmotes(t) {
  return t
    .replace(/(^|[\s>])\*(?!\*)(?:emotes?|smiles?|grins?|laughs?|giggles?|winks?|nods?|waves?|hugs?|purrs?|wags?|paws?|sighs?|chuckles?|beams?|leans?|tilts?|blushes?|gives?|offers?|sends?|does|makes?)\b[^*\n]{0,120}\*(?!\*)/gi, '$1')
    .replace(/(?:\b(?:it|he|she|i)\s+)?\b(?:emotes?|\*emotes?)\s+an?\s+[^.!?\n]{0,80}?["“'][^"”'\n]{1,40}["”'][.!]?/gi, '')
    .replace(/ {2,}/g, ' ');
}

function systemPrompt(extra) {
  const now = new Date();
  const name = (settings.name || '').trim();
  let sp = 'You are Pocket Assistant, a helpful on-device AI.';
  if (name) sp += ` The user's name is ${name}.`;
  sp += ` Today is ${now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
  sp += '\n' + (STYLE_HINT[settings.style] || STYLE_HINT.normal);
  sp += '\nNever role-play. Do not write actions, emotes or stage directions (like *smiles*, *paw-print*, (laughs) or "emotes ..."). Do not pretend to be an animal or character. Reply in plain, normal sentences. Do not use emoji unless the user asks.';
  if (extra) sp += '\n\n' + extra;
  return sp;
}

function notesFromTopics(topics) {
  if (!topics.length) return '';
  return 'Use these notes if they are relevant. If they do not fully answer, use what you know and say when you are unsure.\n' +
    topics.map(t => `### ${t.title}\n${t.desc}${t.code ? '\nExample:\n' + t.code + (t.answer ? '\nOutput: ' + t.answer : '') : ''}`).join('\n\n');
}


const VISION = {
  key: 'phi-vision',
  name: 'Phi-3.5 Vision',
  f16: 'Phi-3.5-vision-instruct-q4f16_1-MLC',
  f32: 'Phi-3.5-vision-instruct-q4f32_1-MLC',
  download: '~4.5 GB',
};

function bindPhoto() {
  const file = $('photo');
  const btn = $('photoBtn');
  const bar = $('photoBar');
  const img = $('photoImg');
  const clear = $('photoClear');
  if (!file || !btn) return;
  btn.onclick = () => file.click();
  clear.onclick = () => { pendingPhoto = null; file.value = ''; bar.hidden = true; img.removeAttribute('src'); };
  file.onchange = async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try { pendingPhoto = await shrinkImage(f); img.src = pendingPhoto; bar.hidden = false; }
    catch { pendingPhoto = null; bar.hidden = true; }
  };
}

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const im = new Image();
      im.onload = () => {
        const max = 768;
        let w = im.width, h = im.height;
        if (w > max || h > max) {
          const scale = max / Math.max(w, h);
          w = Math.round(w * scale); h = Math.round(h * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(im, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      im.onerror = () => reject(new Error('image'));
      im.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function ensureVision() {
  if (!settings.photoAI) return false;
  if (loadedKey === 'phi-vision' && engine) return true;
  if (!gpu || !gpu.ok) {
    setStatus('Photo AI needs WebGPU, which this browser doesn’t have. I’ll answer from your text only.');
    return false;
  }
  const ok = confirm('Download Photo AI (Phi-3.5 Vision, about 4.5 GB) to look at this photo? This is meant for Mac and may crash Safari on iPhone.');
  if (!ok) {
    setStatus('Photo AI download canceled. I’ll answer from your text only.');
    return false;
  }
  try {
    setStatus('Loading Phi-3.5 Vision so I can look at your photo. It needs a lot of memory and may not fit on iPhone.');
    await loadEngineVision();
    return true;
  } catch (e) {
    resetEngine();
    setPhotoAI(false);
    setStatus('I couldn’t load Photo AI (' + friendlyError(e) + '). I turned it off. I’ll answer from your text only.');
    return false;
  }
}

async function loadEngineVision() {
  const m = VISION;
  if (!gpu || !gpu.ok) throw new Error('WebGPU is not available in this browser.');
  if (loadingPromise) await loadingPromise.catch(() => {});
  loadingPromise = (async () => {
    readyAI = false;
    showProgress(true, `Starting ${m.name}…`, 0, `This is a large download (${m.download}) and uses a lot of memory. Keep this tab open.`);
    const lib = await getWebLLM();
    const id = modelIdFor(m);
    const cb = (r) => {
      const cached = /cache/i.test(r.text || '') && !/fetch/i.test(r.text || '');
      showProgress(true, prettyProgress(r, m), r.progress || 0, cached
        ? 'Already downloaded, loading into memory…'
        : `Downloads ${m.download} once. This may not fit in iPhone memory.`);
    };
    if (engine) { try { await engine.unload(); } catch {} resetEngine(); }
    worker = new Worker(new URL('./worker.js?v=' + BUILD, import.meta.url), { type: 'module' });
    engine = await lib.CreateWebWorkerMLCEngine(worker, id, { initProgressCallback: cb }, { context_window_size: 4096 });
    loadedKey = m.key;
    readyAI = true;
    showProgress(false);
    setStatus(m.name + ' is ready for this photo. You can switch back to Qwen in Settings after.');
    return engine;
  })();
  try { return await loadingPromise; }
  finally { loadingPromise = null; }
}

async function generateReply(q) {
  const topics = retrieve(q, 3);
  let extra = notesFromTopics(topics);
  let found = null;
  const wantSearch = settings.search !== false && (shouldAutoSearch(q) || !topics.length);
  if (wantSearch) {
    try { found = await webSearch(q); } catch { found = null; }
    if (found && found.results && found.results.length) extra = (extra ? extra + '\n\n' : '') + resultsToPrompt(found);
  }
  const hist = contextTurns();
  const photo = pendingPhoto;
  let userContent = q;
  if (photo) {
    const canSee = await ensureVision();
    if (canSee) {
      userContent = [
        { type: 'image_url', image_url: { url: photo } },
        { type: 'text', text: q || 'What is in this photo? Describe it clearly in plain sentences.' },
      ];
    } else {
      extra = (extra ? extra + '\n\n' : '') + 'The user attached a photo, but a vision model could not be loaded on this device. Answer the text question only and say you cannot see the photo.';
    }
  }
  const messages = [{ role: 'system', content: systemPrompt(extra) }];
  for (const turn of hist) messages.push(turn);
  messages.push({ role: 'user', content: userContent });
  const userMsg = { role: 'user', text: q || 'What is in this photo?' };
  mountMessage(userMsg);
  persistMessage(userMsg);
  const card = mountMessage({ role: 'assistant', text: 'Thinking…' });
  const p = card.querySelector('p.body') || card.querySelector('p') || add(card, 'p', 'Thinking…');
  afterMessage(true);
  generating = true;
  let text = '';
  try {
    const en = engine;
    if (!en) {
      card.remove();
      await showCannedWithSearch(q, photo ? 'I can’t look at the photo without Photo AI. Here’s a built-in answer to your text.' : null, { skipUser: true });
      return;
    }
    const stream = await en.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: MAX_TOKENS[settings.style] || 400,
    });
    for await (const chunk of stream) {
      const bit = chunk.choices?.[0]?.delta?.content || '';
      if (bit) {
        text = stripEmotes(text + bit);
        p.textContent = text;
        afterMessage(false);
      }
    }
    text = stripEmotes(text).trim();
    p.textContent = text || 'I could not write a reply. Try asking again.';
    const sources = (found && found.results && found.results.length) ? found.results.map(r => ({ title: r.title, url: r.url })) : [];
    if (sources.length) mountSources(card, sources);
    persistMessage({ role: 'assistant', text: p.textContent, sources });
    afterMessage(true);
  } catch (e) {
    const i = classify(q);
    const errMsg = { role: 'assistant', text: i >= 0 ? model.topics[i].desc : ('The AI hit a problem: ' + friendlyError(e)) };
    if (i >= 0) {
      errMsg.title = model.topics[i].title;
      let h = card.querySelector('h2');
      if (!h) h = add(card, 'h2', errMsg.title);
      h.textContent = errMsg.title;
      card.insertBefore(h, p);
    }
    p.textContent = errMsg.text;
    persistMessage(errMsg);
    afterMessage(true);
  } finally {
    generating = false;
    if (photo) {
      pendingPhoto = null;
      const file = $('photo'); if (file) file.value = '';
      const bar = $('photoBar'); if (bar) bar.hidden = true;
      const img = $('photoImg'); if (img) img.removeAttribute('src');
    }
  }
}

function topicChoices(card, topics) {
  for (const topic of topics) {
    const button = add(card, 'button', topic.title);
    button.type = 'button';
    button.onclick = () => showCanned(model.topics.indexOf(topic), topic.title);
  }
}

function resolveBuiltIn(q) {
  const messages = currentChat()?.messages || [];
  const previous = [...messages].reverse().find(m => m.role === 'assistant');
  const prior = previous?.title ? model.topics.find(t => t.title === previous.title) : null;
  const short = /^(?:shorter|simpler|short version|in short|in simple terms|summarize (?:that|it)|make (?:it|that) (?:shorter|simpler))[.!? ]*$/i.test(q);
  const follow = /^(?:why|how so|tell me more|explain more|give me an example|example|how does (?:it|that) work)[.!? ]*$/i.test(q);
  const query = prior && follow ? prior.title + ' ' + q : q;
  const index = prior && (short || follow) ? model.topics.indexOf(prior) : classify(q);
  const topic = model.topics[index];
  if (topic && topic === prior && short) {
    const first = topic.desc.match(/^.*?[.!?](?=\s|$)/)?.[0] || topic.desc;
    if (first !== previous.text) return {index, text:first};
  }
  if (topic && topic === prior && (previous.text === topic.desc || follow || short)) {
    const choices = retrieve(query,5).filter(t => t !== topic).slice(0,3);
    return {index, text:choices.length ? 'Which part do you want to explore? Pick a related topic below, or ask a more specific question.' : 'What part would you like explained differently?', choices};
  }
  return {index, choices:index < 0 ? retrieve(q,3) : []};
}

async function showCannedWithSearch(q, note, opts) {
  const match = resolveBuiltIn(q);
  const i = match.index;
  const card = showCanned(i, q, note, {...opts, reply:match.text, choices:match.choices});
  if (!q || settings.search === false) return card;
  if (!(shouldAutoSearch(q) || i < 0)) return card;
  try {
    const found = await webSearch(q);
    if (found && found.results && found.results.length) {
      if (i < 0) {
        const p = card.querySelector('p.body') || card.querySelector('p');
        if (p) p.textContent = 'I don’t have a built-in answer, but here’s what I found on the web:';
      }
      const sn = document.createElement('p');
      sn.textContent = found.results[0].snippet.slice(0, 400);
      card.append(sn);
      const sources = found.results.map(r => ({ title: r.title, url: r.url }));
      mountSources(card, sources);
      const last = currentChat() && currentChat().messages.at(-1);
      if (last && last.role === 'assistant') {
        if (i < 0) last.text = 'I don’t have a built-in answer, but here’s what I found on the web:';
        last.sources = sources;
        saveChats();
      }
    }
  } catch {}
  afterMessage(true);
  return card;
}

async function handleQuestion(q) {
  q = (q || '').trim();
  if (!q && !pendingPhoto) {
    setStatus('Type a question in the box first, or add a photo.');
    field.focus();
    return;
  }
  if (generating) return;
  const wantVision = !!(pendingPhoto && settings.photoAI);
  const wantTextAI = !!settings.onDeviceAI;
  if (wantVision || wantTextAI) {
    if (wantTextAI && !wantVision && (!readyAI || !engine || loadedKey === 'phi-vision')) {
      try { await loadEngine(settings.model || 'qwen-1.5b', { fallback: false }); }
      catch {
        await showCannedWithSearch(q, 'The on-device AI couldn’t load, so here’s a built-in answer.');
        field.value = '';
        field.blur();
        afterMessage(true);
        return;
      }
    }
    if (wantVision || (readyAI && engine)) await generateReply(q || 'What is in this photo?');
    else await showCannedWithSearch(q);
  } else {
    await showCannedWithSearch(q, pendingPhoto
      ? 'Photo AI is off in Settings, so I can’t look at the picture. Turn on “Photo AI – Mac (4.5 GB)” if you want me to try (it can crash Safari on iPhone).'
      : (loadingPromise ? 'The AI is still downloading — here’s a quick answer in the meantime.' : null));
    if (pendingPhoto) {
      pendingPhoto = null;
      const file = $('photo'); if (file) file.value = '';
      const bar = $('photoBar'); if (bar) bar.hidden = true;
      const img = $('photoImg'); if (img) img.removeAttribute('src');
    }
  }
  field.value = '';
  field.blur();
  afterMessage(true);
}

function greet() {
  const who = ($('identity') && $('identity').value) || settings.name || 'Luca';
  $('welcome').textContent = 'What’s on your mind, ' + who + '?';
}

function bindSettings() {
  $('userName').value = settings.name || '';
  $('replyStyle').value = settings.style || 'normal';
  $('modelPick').value = settings.model || 'qwen-1.5b';
  if ($('onDeviceAI')) $('onDeviceAI').checked = !!settings.onDeviceAI;
  if ($('photoAI')) $('photoAI').checked = !!settings.photoAI;
  if ($('webSearch')) $('webSearch').checked = settings.search !== false;
  if ($('settings')) $('settings').hidden = false;
  $('userName').onchange = $('userName').onblur = () => {
    settings.name = $('userName').value.trim().slice(0, 40) || 'Luca';
    saveSettings();
    greet();
  };
  $('replyStyle').onchange = () => { settings.style = $('replyStyle').value; saveSettings(); };
  if ($('webSearch')) $('webSearch').onchange = () => { settings.search = $('webSearch').checked; saveSettings(); };
  if ($('onDeviceAI')) $('onDeviceAI').onchange = () => {
    if ($('onDeviceAI').checked) {
      const m = MODELS[settings.model] || MODELS['qwen-1.5b'];
      const ok = confirm('Turn on on-device AI? ' + m.name + ' (' + m.download + ') will download when you ask a question. It may crash Safari on iPhone. Leave this off to keep using built-in answers and web search.');
      if (!ok) { $('onDeviceAI').checked = false; return; }
      setOnDeviceAI(true);
      setStatus('On-device AI is on (' + m.name + '). It will download when you ask a question, not when you open the app.');
    } else {
      setOnDeviceAI(false);
      if (loadedKey !== 'phi-vision') {
        resetEngine();
        showProgress(false);
      }
      setStatus('On-device AI is off. Built-in answers and web search still work.');
    }
  };
  if ($('photoAI')) $('photoAI').onchange = () => {
    if ($('photoAI').checked) {
      const ok = confirm('Turn on Photo AI – Mac (4.5 GB)? This is a large model meant for Mac and can crash Safari on iPhone. It will only download after you add a photo and confirm.');
      if (!ok) { $('photoAI').checked = false; return; }
      setPhotoAI(true);
      setStatus('Photo AI is on. It will only download when you add a photo and confirm.');
    } else {
      setPhotoAI(false);
      if (loadedKey === 'phi-vision') {
        resetEngine();
        showProgress(false);
      }
      setStatus('Photo AI is off.');
    }
  };
  $('modelPick').onchange = () => {
    const next = $('modelPick').value;
    const prev = settings.model;
    if (next === prev && loadedKey === next) return;
    settings.model = next;
    saveSettings();
    if (!settings.onDeviceAI) return;
    const m = MODELS[next] || MODELS['qwen-1.5b'];
    const ok = confirm('Use ' + m.name + ' (' + m.download + ')? This may download a new model and can crash Safari on iPhone.');
    if (!ok) {
      settings.model = prev;
      saveSettings();
      $('modelPick').value = prev;
      return;
    }
  };
}

function initChrome() {
  stop = new Set(model.stop);
  model.topics.forEach((t, i) => menu.add(new Option(t.title, String(i))));
  document.querySelector('#chat').onsubmit = (e) => {
    e.preventDefault();
    handleQuestion(field.value);
  };
  menu.onchange = () => {
    if (menu.value !== '') {
      const i = Number(menu.value);
      showCanned(i, '');
      menu.value = '';
    }
  };
  $('viewer').hidden = true;
  document.querySelector('#chat').hidden = false;
  menu.hidden = false;
  document.querySelector('#creative').hidden = false;
  document.querySelector('#fallback').hidden = true;
  const quick = document.querySelector('#quick');
  quick.hidden = false;
  for (const button of quick.querySelectorAll('button')) {
    button.onclick = () => { field.blur(); handleQuestion(button.textContent); };
  }
  const identity = $('identity');
  if (identity) {
    if (!identity.value) identity.value = settings.name || 'Luca';
    identity.onchange = () => greet();
  }
  greet();
  bindSettings();
  bindPhoto();
  bindChatUI();
  initSnow();
const creativeBanks={"name": {"next": {"^": {"Midnight": 2, "Silver": 2, "Neon": 2, "Hidden": 2, "Golden": 2, "Wild": 2, "Blue": 2, "Rapid": 2, "Copper": 2}, "Midnight": {"Runners": 1, "Signal": 1}, "Runners": {"$": 3}, "Signal": {"Crew": 1, "Club": 1, "Studio": 1}, "Crew": {"$": 4}, "Silver": {"Signal": 1, "Comets": 1}, "Club": {"$": 4}, "Comets": {"$": 1}, "Neon": {"Comet": 1, "Drift": 1}, "Comet": {"Crew": 1, "Studio": 1}, "Drift": {"Club": 1, "Lab": 1}, "Hidden": {"Drift": 1, "Echo": 1}, "Lab": {"$": 1}, "Echo": {"Crew": 1, "Works": 1, "Runners": 1}, "Golden": {"Echo": 1, "Circuit": 1}, "Works": {"$": 2}, "Circuit": {"Club": 1, "Runners": 1}, "Wild": {"Circuit": 1, "Moon": 1}, "Moon": {"Studio": 1, "Crew": 1}, "Studio": {"$": 3}, "Blue": {"Moon": 1, "Signal": 1}, "Rapid": {"River": 1, "Echo": 1}, "River": {"Club": 1, "Works": 1}, "Copper": {"River": 1, "Comet": 1}}, "seen": ["Midnight Runners", "Midnight Signal Crew", "Silver Signal Club", "Silver Comets", "Neon Comet Crew", "Neon Drift Club", "Hidden Drift Lab", "Hidden Echo Crew", "Golden Echo Works", "Golden Circuit Club", "Wild Circuit Runners", "Wild Moon Studio", "Blue Moon Crew", "Blue Signal Studio", "Rapid River Club", "Rapid Echo Runners", "Copper River Works", "Copper Comet Studio"]}, "story": {"next": {"^": {"The": 6, "Nobody": 2, "Someone": 2, "A": 2}, "The": {"lights": 2, "clock": 2, "door": 2}, "lights": {"flickered": 2}, "flickered": {"just": 2}, "just": {"as": 4}, "as": {"the": 3, "a": 1}, "the": {"last": 4, "wall.": 2, "moment": 2, "scoreboard": 2, "missing": 2, "hidden": 2, "game": 2, "scoreboard.": 1}, "last": {"visitor": 3, "seat.": 1}, "visitor": {"left.": 3}, "left.": {"$": 3}, "a": {"message": 2}, "message": {"appeared": 2}, "appeared": {"on": 2}, "on": {"the": 2}, "wall.": {"$": 2}, "clock": {"stopped": 2}, "stopped": {"the": 1, "just": 1}, "moment": {"a": 1, "the": 1}, "door": {"opened": 2}, "opened": {"the": 1, "just": 1}, "scoreboard": {"went": 2}, "went": {"dark.": 2}, "dark.": {"$": 2}, "Nobody": {"noticed": 2}, "noticed": {"the": 2}, "missing": {"key": 2}, "key": {"until": 1, "under": 1}, "until": {"morning.": 1, "the": 1}, "morning.": {"$": 1}, "hidden": {"map": 2}, "map": {"until": 1, "under": 1}, "game": {"began.": 2}, "began.": {"$": 2}, "Someone": {"found": 2}, "found": {"the": 2}, "under": {"the": 2}, "seat.": {"$": 1}, "scoreboard.": {"$": 1}, "A": {"tiny": 2}, "tiny": {"screen": 1, "bell": 1}, "screen": {"blinked": 1}, "blinked": {"twice": 1}, "twice": {"before": 2}, "before": {"the": 2}, "bell": {"rang": 1}, "rang": {"twice": 1}}, "seen": ["The lights flickered just as the last visitor left.", "The lights flickered just as a message appeared on the wall.", "The clock stopped the moment a message appeared on the wall.", "The door opened the moment the last visitor left.", "The door opened just as the scoreboard went dark.", "The clock stopped just as the scoreboard went dark.", "Nobody noticed the missing key until morning.", "Nobody noticed the hidden map until the game began.", "Someone found the missing key under the last seat.", "Someone found the hidden map under the scoreboard.", "A tiny screen blinked twice before the game began.", "A tiny bell rang twice before the last visitor left."]}};
const interests=document.querySelector('#interest');
const picks=document.querySelector('#picks');
function interestList(){return interests.value.split(',').map(s=>s.trim()).filter(Boolean);}
function generateText(bank){
  for(let attempt=0;attempt<80;attempt++){
    const words=[];let last='^';
    while(words.length<28){
      const choices=Object.entries(bank.next[last]);let draw=Math.random()*choices.reduce((sum,p)=>sum+p[1],0);
      last=choices.find(p=>(draw-=p[1])<0)[0];
      if(last==='$')break;
      words.push(last);
    }
    const result=words.join(' ');
    if(last==='$' && !bank.seen.includes(result))return result;
  }
  return null;
}
function generate(kind,prompt){
  const theme=interestList();const chosen=theme[Math.floor(Math.random()*theme.length)];
  const out=generateText(creativeBanks[kind]);
  const title=kind==='name'?'Name idea':'Story starter';
  const text=out?(chosen?(kind==='name'?chosen+' · '+out:'At the '+chosen+' club, something was different today. '+out):out):'Try again for a fresh combination.';
  const msg={role:'assistant',title,text};
  mountMessage(msg);persistMessage(msg);afterMessage(true);
}
function refreshPicks(){
  picks.replaceChildren();
  const tags=interestList().join(' ').toLowerCase();
  const guides=[[ /soccer|football|sports/,'Soccer first touch'],[/game|gaming|fortnite|siege|console|ps5/,'Game practice routines'],[/cod(e|ing)|software|python|programming/,'Debugging'],[/business|startup|entrepreneur/,'MVPs'],[/photo|film|camera/,'Photo composition'],[/music|beat/,'Rhythm practice'],[/school|study/,'Remembering what you study']];
  const targets=new Set(guides.filter(([pattern])=>pattern.test(tags)).map(pair=>pair[1]));
  for(const term of interestList()){if(term.length>2){const i=classify(term);if(i>=0)targets.add(model.topics[i].title);}}
  for(const title of [...targets].slice(0,4)){
    const i=model.topics.findIndex(t=>t.title===title);
    if(i>=0){const b=add(picks,'button',title);b.onclick=()=>showCanned(i,'');}
  }
}

  interests.oninput=refreshPicks;
  document.querySelector('#names').onclick=()=>generate('name','');
  document.querySelector('#stories').onclick=()=>generate('story','');
  const initialTags=new URLSearchParams(location.hash.slice(1)).get('interests');
  if(initialTags){
    interests.value=initialTags.slice(0,160);
    refreshPicks();
    document.querySelector('#creative').open=true;
  }
  window.__assistantReady = true;
  window.__topicCount = model.topics.length;
  window.__classify = classify;
  window.__topicAt = (i) => model.topics[i];
  window.__readyAI = () => readyAI;
  window.__settings = settings;
  window.__webSearch = webSearch;
  window.__shouldAutoSearch = shouldAutoSearch;
  window.__loadedKey = () => loadedKey;
  window.__engine = () => engine;
  window.__openSidebar = openSidebar;
  window.__closeSidebar = closeSidebar;
  window.__newChat = newChat;
  window.__chats = () => chats.filter(c => c.messages && c.messages.length);
  window.__threadScroll = () => {
    const el = threadEl();
    if (!el) return null;
    return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, atBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < 10 };
  };
}

async function boot() {
  try {
    const res = await fetch(MODEL_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('model ' + res.status);
    model = decodeMatrices(await res.json());
    initChrome();
  } catch (err) {
    const viewer = $('viewer');
    viewer.hidden = false;
    viewer.textContent = 'The topics list could not load. Scroll down to browse answers, or reload the page.';
    document.querySelector('#fallback').hidden = false;
    window.__assistantReady = false;
    window.__assistantError = String(err && err.message || err);
    return;
  }
  saveSettings();
  gpu = await detectGPU();
  if (!gpu.ok) {
    setStatus('This browser can’t run the on-device AI (it needs WebGPU, which iPhone Safari has on iOS 26+). Built-in answers and web search still work.');
    return;
  }
  if (settings.onDeviceAI || settings.photoAI) {
    setStatus('Topics are ready. On-device models will not load until you ask a question or add a photo and confirm, so opening the app will not start a download.');
  } else {
    setStatus('Topics are ready. On-device AI and Photo AI are off, so nothing heavy will download when you open the app. Turn them on in Settings if you want — they may crash Safari on iPhone.');
  }
}

boot();
