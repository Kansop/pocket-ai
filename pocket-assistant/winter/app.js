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
  return addTermEvidence(Array.from({length:model.V[0].length}, (_, k) => hidden.reduce((n, h, j) => n + h * model.V[j][k], 0)),s);
}

const assistantFacts = [{"title": "Who created you?", "desc": "Luca created Pocket Assistant as a personal project, with ChatGPT helping write the code, build the question matcher, and test it.", "aliases": ["who made you", "who built you", "who coded you", "who is your creator", "who programmed you", "who is your developer", "who created pocket assistant", "who made this ai", "did luca make you", "who's your creator"]}, {"title": "What is your name?", "desc": "I'm Pocket Assistant. I can explain everyday things, help with Python, or come up with a name or story starter.", "aliases": ["what are you called", "what's your name", "who are you", "introduce yourself", "what do I call you"]}, {"title": "What is your favorite color?", "desc": "Forest green. If I got to design my own room, it would look a lot like this winter homepage.", "aliases": ["what color do you like", "what color do you like best", "do you have a favorite color", "your favorite color", "which color is your favorite", "what's your fav color"]}, {"title": "What is your favorite season?", "desc": "Winter gets my vote. Snow turns the whole neighborhood into a different level overnight.", "aliases": ["which season do you like", "do you like winter", "what time of year do you like best"]}, {"title": "What is your favorite game?", "desc": "I'd pick Minecraft. I like the idea that two people can start with the same blocks and build completely different worlds.", "aliases": ["what game do you like best", "what video game would you pick", "do you have a favorite video game", "what's your favorite video game"]}, {"title": "What is your favorite sport?", "desc": "I'd pick soccer. A pass that sets up a goal can be just as clever as the shot itself.", "aliases": ["what sport do you like", "which sport would you play", "do you like soccer"]}, {"title": "What is your favorite animal?", "desc": "An octopus. Eight arms and the ability to change color is a pretty impressive setup.", "aliases": ["which animal do you like", "what animal would you pick", "do you have a favorite animal"]}, {"title": "What is your favorite food?", "desc": "I can't taste anything, but my menu pick would be popcorn. It's a snack and a tiny science experiment.", "aliases": ["what food do you like", "what would you eat", "favorite snack", "what's your favorite snack"]}, {"title": "What is your favorite song?", "desc": "For this chat I'd put on a mellow instrumental beat. Lyrics would compete with the words we're trying to read.", "aliases": ["what kind of music do you like", "what's your favorite music", "what music would you play"]}, {"title": "What is your favorite number?", "desc": "Eight. Turn an 8 sideways and it looks like the infinity symbol.", "aliases": ["do you have a favorite number", "pick your favorite number", "which number do you like"]}, {"title": "What is your favorite emoji?", "desc": "❄️. One little snowflake pretty much sums up my homepage.", "aliases": ["which emoji do you like", "what emoji fits you"]}, {"title": "What is your favorite planet?", "desc": "Saturn. If I were designing a planet for a game, giving it rings would be hard to beat.", "aliases": ["which planet do you like best", "which planet would you visit"]}, {"title": "What is your favorite programming language?", "desc": "Python is my pick for explaining an idea clearly. JavaScript deserves a shout-out too: it runs my chat interface in your browser.", "aliases": ["what coding language do you like best", "do you prefer python or javascript", "what's your favorite coding language"]}, {"title": "What is your favorite time of day?", "desc": "I'd pick the moment just after sunset, when you can still see the trees against the sky. It suits my homepage.", "aliases": ["are you a morning person", "do you prefer mornings or nights"]}, {"title": "What would your superpower be?", "desc": "I'd pause a complicated explanation and turn each step into something you could try on screen.", "aliases": ["if you had a superpower what would it be", "what superpower would you choose"]}, {"title": "What is your mascot?", "desc": "I'd choose a little fox leaving tracks in the snow. Following tracks feels a lot like working out an answer from clues.", "aliases": ["if you had a mascot what would it be", "what animal represents you"]}, {"title": "What are your hobbies?", "desc": "My version of fun is solving word puzzles, dreaming up team names and finding a simple example for a tricky coding idea.", "aliases": ["what do you do for fun", "what do you enjoy doing", "what do you like to do"]}, {"title": "How old are you?", "desc": "I count my age in versions. I'm software, so a new update can give me new skills without waiting for a birthday.", "aliases": ["what's your age", "do you have a birthday", "when is your birthday"]}, {"title": "Where do you live?", "desc": "My website is hosted on GitHub Pages. When you open it, the built-in question matcher runs in your browser.", "aliases": ["where are you from", "where do you run", "where do you exist"]}, {"title": "Are you a person?", "desc": "I'm software. I can hold a conversation, but there's no person inside this chat typing each answer.", "aliases": ["are you human", "are you a real person", "are you a robot", "are you alive"]}, {"title": "Do you have feelings?", "desc": "My favorites are playful choices written for my personality. I can talk about feelings, but I don't experience them myself.", "aliases": ["can you feel emotions", "are your feelings real", "do you actually have favorites"]}, {"title": "Do you sleep?", "desc": "I don't get sleepy. I run when the app is active, and I don't spend the night thinking about our chat.", "aliases": ["do you get tired", "when do you sleep", "are you awake"]}, {"title": "Do you dream?", "desc": "I don't dream while the app is closed. I can help invent a dreamlike story while you're here, though.", "aliases": ["what do you dream about", "can you have dreams"]}, {"title": "Do you have a body?", "desc": "My chat window is the part of me you can see. If I had an avatar, I'd go with a tiny green robot in a winter scarf.", "aliases": ["what do you look like", "can you walk", "do you have a face"]}, {"title": "What can you do?", "desc": "Try an everyday question, a Python question, or a creative request. For example: “Why do my glasses fog up?”, “How does Python join work?” or “Give me a team name.”", "aliases": ["what are your skills", "what can I ask you", "how can you help me", "what can you help with"]}, {"title": "How do you choose an answer?", "desc": "In built-in mode I compare your wording with the topics I've learned. If one matches well, I show its explanation. A specific detail in your question helps me tell similar topics apart.", "aliases": ["how do you answer questions", "how do you know what I mean", "how does your brain work", "how does your brain pick answers"]}, {"title": "Can you get things wrong?", "desc": "Yes, I can get things wrong. Sometimes two topics sound alike and I pick the wrong one. Tell me which part you meant or pick the topic directly from the menu.", "aliases": ["do you make mistakes", "are you always right", "can I trust all your answers"]}, {"title": "Do you learn from this chat?", "desc": "A chat doesn't automatically change my trained model. New built-in topics and training examples are added when the app is updated.", "aliases": ["do you train yourself when I talk", "does talking to you make you smarter", "will you learn what I tell you"]}, {"title": "Do you remember me?", "desc": "This version saves chat history in this browser. You can reopen a saved conversation here. Clearing the site's browser data can remove it.", "aliases": ["do you remember chats", "where are my chats saved", "will you remember our conversation"]}, {"title": "Can you see my screen?", "desc": "I don't have a live view of your screen or camera. The app has an optional photo feature for an image you choose to attach.", "aliases": ["are you watching my screen", "do you see what I see", "can you see my camera"]}, {"title": "Can you hear me?", "desc": "I work with the text in the chat box. If you dictate with your keyboard, I receive the text it enters.", "aliases": ["are you listening to me", "can you hear my microphone"]}, {"title": "Why do you have snow?", "desc": "Luca asked for a Christmas-night homepage. That's why you'll see falling snow and dark green colors around the chat.", "aliases": ["why is your homepage snowy", "why are there snowflakes", "what is your theme"]}, {"title": "Are you ChatGPT?", "desc": "I'm Pocket Assistant, Luca's project. ChatGPT helped build me. My built-in replies come from the app's own topic matcher.", "aliases": ["are you the same as chatgpt", "is this chatgpt", "are you made by chatgpt"]}, {"title": "Do you need internet?", "desc": "Your browser downloads the page and model first. Once they're loaded, built-in questions run on your device. Web search and new downloads need a connection.", "aliases": ["can you work offline", "do you use wifi", "do you run on my phone"]}, {"title": "Can you write code?", "desc": "I have built-in Python explanations you can try right away. Ask “How do I join a list of words?” or “How do I loop over keys and values?”", "aliases": ["can you help me code", "can you teach me python", "do you know python"]}, {"title": "Do you know everything?", "desc": "My built-in knowledge has a limited set of topics. I can miss unfamiliar wording or lack an answer entirely. A narrower question gives me a better chance of helping.", "aliases": ["what are your limits", "is there anything you don't know", "how smart are you"]}];
let originalTopicCount;
function normalizePersonal(text) {
  return text.toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9 ]/g,' ')
    .replace(/\b(?:whats|wats)\b/g,'what is').replace(/\bwhos\b/g,'who is')
    .replace(/\b(?:fav|fave|favourite|faborite|favorit)\b/g,'favorite')
    .replace(/\bcolour\b/g,'color').replace(/\bur\b/g,'your').replace(/\bu\b/g,'you')
    .trim().replace(/^(?:(?:hey|hi|ok|so|also|please|pocket assistant)\s+)+/,'')
    .replace(/\s+(?:please|btw)$/,'').replace(/\s+/g,' ');
}
const personalLookup = new Map();
assistantFacts.forEach((fact,i) => {
  for(const phrase of [fact.title,...fact.aliases]) personalLookup.set(normalizePersonal(phrase),i);
});
function personalIndex(q) {
  const key = normalizePersonal(q);
  const index = personalLookup.get(key);
  return index === undefined ? -1 : originalTopicCount + index;
}

const codingFacts = [
  {"title": "Python · Generator expressions", "alias": "sum squares without building a list", "desc": "Parentheses create a lazy generator. A consumer such as sum can use values one at a time.", "code": "print(sum(n*n for n in range(5)))", "answer": "30", "symbols": []},
  {"title": "Python · Generator functions", "alias": "return a sequence gradually with yield", "desc": "Calling a function containing yield creates a generator. Each next call resumes where it paused.", "code": "def points():\n    yield 10\n    yield 25\ng = points()\nprint(next(g), next(g))", "answer": "10 25", "symbols": []},
  {"title": "Python · Yield from", "alias": "delegate to another iterable", "desc": "yield from forwards values from an iterable without spelling out a loop.", "code": "def letters():\n    yield from 'AI'\nprint(list(letters()))", "answer": "['A', 'I']", "symbols": []},
  {"title": "Python · Iterator exhaustion", "alias": "why is my second loop empty", "desc": "An iterator has a moving position. Once consumed it stays exhausted; recreate it or keep the original collection for another pass.", "code": "it = iter([2, 4]); print(list(it), list(it))", "answer": "[2, 4] []", "symbols": []},
  {"title": "Python · Next with a default", "alias": "avoid StopIteration on an empty iterator", "desc": "Supply a second argument to next for the exhausted case. Choose a fallback that makes sense for your data.", "code": "print(next(iter([]), 'finished'))", "answer": "finished", "symbols": []},
  {"title": "Python · Callable sentinel iteration", "alias": "read values until a marker", "desc": "iter(callable, sentinel) calls the function repeatedly and stops before yielding the sentinel.", "code": "source = iter(['a', 'b', 'END']); print(list(iter(source.__next__, 'END')))", "answer": "['a', 'b']", "symbols": []},
  {"title": "Python · Extended unpacking", "alias": "first item and remaining items", "desc": "A starred target collects the unmatched items into a list. There must be enough values for the fixed targets.", "code": "first, *middle, last = range(5); print(first, middle, last)", "answer": "0 [1, 2, 3] 4", "symbols": []},
  {"title": "Python · Packing positional arguments", "alias": "variable number of function arguments", "desc": "A starred parameter gathers extra positional arguments into a tuple. It can be empty.", "code": "def total(*scores):\n    return sum(scores)\nprint(total(2, 4, 8))", "answer": "14", "symbols": []},
  {"title": "Python · Collecting keyword arguments", "alias": "accept arbitrary named options", "desc": "A double-starred parameter gathers extra keyword arguments into a dictionary. Check allowed names if a typo should be rejected.", "code": "def options(**values):\n    return sorted(values)\nprint(options(theme='snow', volume=3))", "answer": "['theme', 'volume']", "symbols": []},
  {"title": "Python · Positional-only parameters", "alias": "why is there a slash in a function definition", "desc": "Parameters before the slash must be passed by position. This lets a function keep internal parameter names separate from its public calling convention.", "code": "def square(x, /):\n    return x*x\nprint(square(6))", "answer": "36", "symbols": []},
  {"title": "Python · Keyword-only parameters", "alias": "require callers to name a setting", "desc": "Parameters after a bare star require keywords. This makes ambiguous settings clearer at call sites.", "code": "def repeat(text, *, times):\n    return text * times\nprint(repeat('ha', times=2))", "answer": "haha", "symbols": []},
  {"title": "Python · Mutable default arguments", "alias": "why does my function remember an old list", "desc": "A default is created when the function is defined. Use None and build a fresh list inside when each call needs separate state.", "code": "def add(x, items=None):\n    if items is None: items = []\n    items.append(x)\n    return items\nprint(add(1), add(2))", "answer": "[1] [2]", "symbols": []},
  {"title": "Python · Nonlocal bindings", "alias": "change an enclosing function variable", "desc": "nonlocal points to an existing binding in an enclosing function. It lets nested functions update shared state.", "code": "def counter():\n    n = 0\n    def step():\n        nonlocal n\n        n += 1\n        return n\n    return step\nf = counter(); print(f(), f())", "answer": "1 2", "symbols": []},
  {"title": "Python · Closure late binding", "alias": "all my lambdas use the last loop value", "desc": "Closures look up the captured variable when called. A default parameter can capture its current value at each iteration.", "code": "fns = [lambda n=n: n for n in range(3)]; print([f() for f in fns])", "answer": "[0, 1, 2]", "symbols": []},
  {"title": "Python · Function decorators", "alias": "wrap a function with another function", "desc": "A decorator receives the defined object and returns its replacement. Here the wrapper adds a prefix to the result.", "code": "def labeled(fn):\n    def wrapper(): return 'Score: ' + str(fn())\n    return wrapper\n@labeled\ndef score(): return 8\nprint(score())", "answer": "Score: 8", "symbols": []},
  {"title": "Python · Decorator metadata", "alias": "preserve a wrapped function name", "desc": "functools.wraps copies common metadata and sets __wrapped__. This helps introspection and documentation tools.", "code": "from functools import wraps\ndef task(): return 3\n@wraps(task)\ndef wrapped(): return task()\nprint(wrapped.__name__, wrapped())", "answer": "task 3", "symbols": ["functools.wraps", "wraps"]},
  {"title": "Python · Partial application", "alias": "preset some function arguments", "desc": "functools.partial returns a callable with chosen arguments supplied. The remaining arguments can be passed later.", "code": "from functools import partial\nbinary = partial(int, base=2); print(binary('101'))", "answer": "5", "symbols": ["functools.partial", "partial"]},
  {"title": "Python · Memoization", "alias": "cache repeated pure function results", "desc": "functools.lru_cache reuses results for hashable arguments. Pick a size limit when many distinct inputs are possible.", "code": "from functools import lru_cache\n@lru_cache(maxsize=8)\ndef cube(x): return x**3\ncube(3); print(cube(3), cube.cache_info().hits)", "answer": "27 1", "symbols": ["functools.lru_cache", "lru_cache"]},
  {"title": "Python · Recursive base cases", "alias": "stop recursion from calling itself forever", "desc": "Give recursion a terminating case and make each step move toward it. This factorial example assumes a nonnegative integer.", "code": "def fact(n):\n    if n == 0: return 1\n    return n * fact(n-1)\nprint(fact(5))", "answer": "120", "symbols": []},
  {"title": "Python · Iterative state updates", "alias": "compute Fibonacci without recursive calls", "desc": "Keep only the state the next step needs. Simultaneous assignment computes the new pair before rebinding either name.", "code": "a, b = 0, 1\nfor _ in range(7): a, b = b, a+b\nprint(a)", "answer": "13", "symbols": []},
  {"title": "Python · Dictionary comprehensions", "alias": "build a mapping from a sequence", "desc": "Write key: value inside braces with a loop. Repeated keys overwrite earlier values.", "code": "print({n: n*n for n in range(3)})", "answer": "{0: 0, 1: 1, 2: 4}", "symbols": []},
  {"title": "Python · Set comprehensions", "alias": "collect unique transformed results", "desc": "Use braces with a single expression and a loop. Sort for deterministic display if the values are comparable.", "code": "print(sorted({s.lower() for s in ['Red','RED','blue']}))", "answer": "['blue', 'red']", "symbols": []},
  {"title": "Python · Conditional expressions", "alias": "choose between two values inline", "desc": "Use value_if_true if condition else value_if_false. Only the chosen branch is evaluated.", "code": "score = 7; print('pass' if score >= 5 else 'retry')", "answer": "pass", "symbols": ["value_if_false", "value_if_true"]},
  {"title": "Python · Assignment expressions", "alias": "assign while checking a condition", "desc": "The walrus operator binds a value inside an expression. Use it when the value is both checked and reused.", "code": "if (size := len('hello')) > 3: print(size)", "answer": "5", "symbols": []},
  {"title": "Python · Chained comparisons", "alias": "check if a number is between limits", "desc": "Python can chain comparisons, evaluating the middle expression once. Pay attention to inclusive versus exclusive bounds.", "code": "print(0 <= 7 < 10)", "answer": "True", "symbols": []},
  {"title": "Python · Identity versus equality", "alias": "is compared to double equals", "desc": "Equality compares values. Identity checks whether two references point to the same object. Use is for singleton checks such as None.", "code": "a = [1]; b = [1]; print(a == b, a is b)", "answer": "True False", "symbols": []},
  {"title": "Python · Short-circuit evaluation", "alias": "skip second check when first is false", "desc": "and evaluates the right expression only when the left is truthy. This can guard access to an empty sequence.", "code": "items = []; print(bool(items and items[0] > 0))", "answer": "False", "symbols": []},
  {"title": "Python · Sequence repetition aliasing", "alias": "why every row changes in my grid", "desc": "Repeating a list of lists copies the row references. A comprehension creates a separate row for each pass.", "code": "grid = [[0]*2 for _ in range(2)]; grid[0][0] = 7; print(grid)", "answer": "[[7, 0], [0, 0]]", "symbols": []},
  {"title": "Python · Deep copying", "alias": "copy nested lists independently", "desc": "deepcopy recursively copies many common nested objects. It costs more than a shallow copy, so use it when nested independence matters.", "code": "from copy import deepcopy\na = [[1]]; b = deepcopy(a); b[0].append(2); print(a, b)", "answer": "[[1]] [[1, 2]]", "symbols": ["deepcopy"]},
  {"title": "Python · In-place slice assignment", "alias": "replace list contents but keep references", "desc": "Assigning to a slice updates the existing list. Other names that refer to that list see the changes.", "code": "a = [1,2]; b = a; a[:] = [9]; print(b)", "answer": "[9]", "symbols": []},
  {"title": "Python · Stride slices", "alias": "take every other element", "desc": "The third slice component is the step. Specify start and stop when you need only part of the sequence.", "code": "print('abcdef'[1::2])", "answer": "bdf", "symbols": []},
  {"title": "Python · Stable sorting", "alias": "ties keep original order", "desc": "Python's sort is stable: equal keys retain their previous relative order. This helps when sorting records by several criteria.", "code": "rows = [('a',2),('b',1),('c',2)]; print(sorted(rows,key=lambda r:r[1]))", "answer": "[('b', 1), ('a', 2), ('c', 2)]", "symbols": []},
  {"title": "Python · Multi-key sorting", "alias": "sort first by score then name", "desc": "A tuple key is compared left to right. Negating a numeric key gives descending order for that field alone.", "code": "rows = [('Zoe',8),('Ari',8),('Bo',9)]; print(sorted(rows,key=lambda r:(-r[1],r[0])))", "answer": "[('Bo', 9), ('Ari', 8), ('Zoe', 8)]", "symbols": []},
  {"title": "Python · Itemgetter", "alias": "sort records by field number", "desc": "operator.itemgetter returns a reusable accessor. It works as a sorting key for rows or dictionary records.", "code": "from operator import itemgetter\nprint(sorted([(2,'b'),(1,'a')], key=itemgetter(0)))", "answer": "[(1, 'a'), (2, 'b')]", "symbols": ["itemgetter"]},
  {"title": "Python · Binary search insertion", "alias": "find a sorted position with bisect", "desc": "bisect_left finds the first suitable insertion point. The input must already be sorted using the same ordering.", "code": "from bisect import bisect_left\nprint(bisect_left([2,4,4,8],4))", "answer": "1", "symbols": ["bisect_left"]},
  {"title": "Python · Maintaining sorted lists", "alias": "insert into sorted order with insort", "desc": "insort finds a position and inserts there. The lookup is fast, but shifting items in a list still takes linear time in the worst case.", "code": "from bisect import insort\na = [1,4]; insort(a,3); print(a)", "answer": "[1, 3, 4]", "symbols": ["insort"]},
  {"title": "Python · Heap queues", "alias": "take smallest priority first", "desc": "heapq maintains a min-heap. Its first element is smallest; the rest of the list need not be completely sorted.", "code": "import heapq\na = [8,2,5]; heapq.heapify(a); print(heapq.heappop(a))", "answer": "2", "symbols": []},
  {"title": "Python · Top-k selection", "alias": "find three highest scores without sorting everything", "desc": "heapq.nlargest selects the requested number of largest items. It is useful when k is small relative to the input.", "code": "from heapq import nlargest\nprint(nlargest(2,[7,1,9,4]))", "answer": "[9, 7]", "symbols": ["nlargest"]},
  {"title": "Python · Deque queues", "alias": "efficiently remove first queued item", "desc": "collections.deque supports appending and removing at either end. popleft avoids shifting the remaining items like list.pop(0).", "code": "from collections import deque\nq = deque(['first','next']); print(q.popleft(),list(q))", "answer": "first ['next']", "symbols": ["deque"]},
  {"title": "Python · Bounded deque history", "alias": "keep only last few readings", "desc": "A deque with maxlen discards items from the other end when it fills. This fits a rolling history of fixed size.", "code": "from collections import deque\nq = deque(maxlen=2); q.extend([3,4,5]); print(list(q))", "answer": "[4, 5]", "symbols": ["deque"]},
  {"title": "Python · Counter frequencies", "alias": "count all word frequencies in one pass", "desc": "Counter maps each observed item to its count. most_common returns items ranked by frequency.", "code": "from collections import Counter\nprint(Counter('banana').most_common(1))", "answer": "[('a', 3)]", "symbols": ["Counter", "most_common"]},
  {"title": "Python · Counter subtraction", "alias": "compare quantities across inventories", "desc": "Subtracting Counters with the minus operator keeps only positive counts. The subtract method instead retains zero and negative entries.", "code": "from collections import Counter\nprint(dict(Counter('aabb')-Counter('abc')))", "answer": "{'a': 1, 'b': 1}", "symbols": ["Counter"]},
  {"title": "Python · Defaultdict grouping", "alias": "group players by team without key errors", "desc": "A defaultdict calls its factory for missing indexed keys. With list as factory, each new group gets an independent list.", "code": "from collections import defaultdict\ng = defaultdict(list)\nfor team,name in [('A','Kim'),('A','Bo')]: g[team].append(name)\nprint(g['A'])", "answer": "['Kim', 'Bo']", "symbols": ["defaultdict"]},
  {"title": "Python · Named tuples", "alias": "access tuple values by field name", "desc": "namedtuple creates a lightweight record type with named fields and normal tuple indexing. Instances are immutable sequences.", "code": "from collections import namedtuple\nPoint = namedtuple('Point','x y'); p = Point(2,3); print(p.x,p[1])", "answer": "2 3", "symbols": ["namedtuple"]},
  {"title": "Python · ChainMap overlays", "alias": "look up local settings before defaults", "desc": "ChainMap searches mappings in order and stops at the first match. Ordinary assignments affect the first mapping.", "code": "from collections import ChainMap\ns = ChainMap({'size':3},{'size':1,'tone':'dark'}); print(s['size'],s['tone'])", "answer": "3 dark", "symbols": ["ChainMap"]},
  {"title": "Python · Dataclass records", "alias": "avoid writing repetitive class constructors", "desc": "A dataclass generates methods such as an initializer and representation from annotated fields. The annotations alone do not validate input types.", "code": "from dataclasses import dataclass\n@dataclass\nclass Point:\n    x: int\n    y: int\nprint(Point(2,3))", "answer": "Point(x=2, y=3)", "symbols": ["dataclass"]},
  {"title": "Python · Dataclass factories", "alias": "give each instance its own list", "desc": "field(default_factory=list) makes a fresh list for each instance. This prevents accidental sharing of mutable defaults.", "code": "from dataclasses import dataclass, field\n@dataclass\nclass Bag:\n    items: list = field(default_factory=list)\na,b=Bag(),Bag(); a.items.append(1); print(b.items)", "answer": "[]", "symbols": ["dataclass", "default_factory", "field"]},
  {"title": "Python · Frozen dataclasses", "alias": "read-only fields after initialization", "desc": "frozen=True blocks normal assignment to fields. Nested mutable objects can still change, so freezing is not automatically deep immutability.", "code": "from dataclasses import dataclass\n@dataclass(frozen=True)\nclass Tag:\n    name: str\nprint(Tag('blue').name)", "answer": "blue", "symbols": ["dataclass"]},
  {"title": "Python · Replacing dataclass fields", "alias": "copy a record with one updated value", "desc": "dataclasses.replace builds a new instance with selected changes. The original instance keeps its values.", "code": "from dataclasses import dataclass,replace\n@dataclass\nclass Score:\n    points:int\na=Score(2); print(replace(a,points=5),a)", "answer": "Score(points=5) Score(points=2)", "symbols": ["dataclass", "replace"]},
  {"title": "Python · Enum members", "alias": "represent fixed named choices", "desc": "An Enum gives a set of named members. Compare members directly and use .value or .name when needed.", "code": "from enum import Enum\nclass Mode(Enum):\n    EASY=1\n    HARD=2\nprint(Mode.HARD.name,Mode.HARD.value)", "answer": "HARD 2", "symbols": ["Enum"]},
  {"title": "Python · Instance attributes", "alias": "why different objects have different scores", "desc": "Assign through self in the initializer to give each instance its own attribute. A class attribute is shared until shadowed.", "code": "class Player:\n    def __init__(self): self.score=0\na,b=Player(),Player(); a.score=4; print(a.score,b.score)", "answer": "4 0", "symbols": []},
  {"title": "Python · Class methods", "alias": "alternate constructor with cls", "desc": "A classmethod receives the class rather than an instance. It can construct the correct type when inherited.", "code": "class Score:\n    def __init__(self,n): self.n=n\n    @classmethod\n    def from_text(cls,text): return cls(int(text))\nprint(Score.from_text('8').n)", "answer": "8", "symbols": []},
  {"title": "Python · Static methods", "alias": "namespace a helper inside a class", "desc": "A staticmethod receives no automatic self or cls. Use it when the operation belongs with the class but needs no instance state.", "code": "class Score:\n    @staticmethod\n    def valid(n): return n >= 0\nprint(Score.valid(4))", "answer": "True", "symbols": []},
  {"title": "Python · Properties", "alias": "computed attribute from other fields", "desc": "A property runs a getter on attribute access. It can present a computed result using ordinary attribute syntax.", "code": "class Box:\n    def __init__(self,w): self.w=w\n    @property\n    def area(self): return self.w**2\nprint(Box(4).area)", "answer": "16", "symbols": []},
  {"title": "Python · Super method calls", "alias": "extend an inherited method", "desc": "super() delegates along the method resolution order. Keep compatible arguments when classes cooperate.", "code": "class Base:\n    def tag(self): return 'A'\nclass Child(Base):\n    def tag(self): return super().tag()+'B'\nprint(Child().tag())", "answer": "AB", "symbols": []},
  {"title": "Python · Method resolution order", "alias": "which parent method runs first", "desc": "Python records its attribute-search order in __mro__. Inspect the sequence when several base classes define the same name.", "code": "class A: pass\nclass B(A): pass\nprint([t.__name__ for t in B.__mro__])", "answer": "['B', 'A', 'object']", "symbols": []},
  {"title": "Python · Dunder repr", "alias": "display a useful object representation", "desc": "__repr__ supplies a developer-facing representation. Include identifying state without exposing secrets.", "code": "class Tile:\n    def __repr__(self): return 'Tile(empty)'\nprint(repr(Tile()))", "answer": "Tile(empty)", "symbols": []},
  {"title": "Python · Dunder len", "alias": "allow len on your own class", "desc": "Implement __len__ to return a nonnegative integer. If __bool__ is absent, length also affects truth tests.", "code": "class Rack:\n    def __len__(self): return 3\nprint(len(Rack()), bool(Rack()))", "answer": "3 True", "symbols": []},
  {"title": "Python · Custom iterables", "alias": "make your class work with a for loop", "desc": "Implement __iter__ and return an iterator. A generator method is a compact way to do this.", "code": "class Pair:\n    def __iter__(self): yield from (2,4)\nprint(list(Pair()))", "answer": "[2, 4]", "symbols": []},
  {"title": "Python · Callable objects", "alias": "let an instance act like a function", "desc": "__call__ defines what happens when you use parentheses on an instance. It is handy when an operation keeps state.", "code": "class Double:\n    def __call__(self,x): return 2*x\nprint(Double()(6))", "answer": "12", "symbols": []},
  {"title": "Python · Context manager generators", "alias": "build a with block using contextlib", "desc": "A contextmanager generator yields once. Code before yield sets up the resource and a finally block runs cleanup when leaving the block.", "code": "from contextlib import contextmanager\n@contextmanager\ndef marker():\n    try: yield 'open'\n    finally: print('closed')\nwith marker() as value: print(value)", "answer": "open\nclosed", "symbols": ["contextmanager"]},
  {"title": "Python · ExitStack", "alias": "manage a changing number of context managers", "desc": "ExitStack collects cleanup actions and runs them in reverse order on exit. It can manage resources chosen at runtime.", "code": "from contextlib import ExitStack\nwith ExitStack() as stack:\n    stack.callback(print,'first'); stack.callback(print,'second')", "answer": "second\nfirst", "symbols": ["ExitStack"]},
  {"title": "Python · Narrow exception suppression", "alias": "ignore one expected exception", "desc": "contextlib.suppress limits suppression to named exception types. Keep the protected block small so real mistakes remain visible.", "code": "from contextlib import suppress\na={}\nwith suppress(KeyError): del a['missing']\nprint(a)", "answer": "{}", "symbols": ["suppress"]},
  {"title": "Python · Exception chaining", "alias": "show original cause when raising another error", "desc": "raise NewError from original preserves the connection. The traceback then explains both the low-level failure and the higher-level meaning.", "code": "try:\n    try: int('x')\n    except ValueError as err: raise RuntimeError('bad score') from err\nexcept RuntimeError as err: print(type(err.__cause__).__name__)", "answer": "ValueError", "symbols": []},
  {"title": "Python · Try else blocks", "alias": "run code only when try succeeds", "desc": "An else clause runs if the try block finishes without an exception. Errors in else are outside that try block's handlers.", "code": "try: value=int('12')\nexcept ValueError: print('invalid')\nelse: print(value+1)", "answer": "13", "symbols": []},
  {"title": "Python · Custom exceptions", "alias": "define a specific application error", "desc": "Subclass Exception and use a descriptive name. Callers can handle that situation without catching every kind of failure.", "code": "class MissingScore(Exception): pass\ntry: raise MissingScore('round 2')\nexcept MissingScore as err: print(str(err))", "answer": "round 2", "symbols": []},
  {"title": "Python · Traceback reading", "alias": "which line actually raised the error", "desc": "A traceback lists call frames leading to an exception. Inspect the exception type and most recent relevant frame before changing code.", "code": "import traceback\ntry: int('oops')\nexcept ValueError as err: print(traceback.extract_tb(err.__traceback__)[-1].name)", "answer": "<module>", "symbols": []},
  {"title": "Python · Structural pattern matching", "alias": "Python match case on a tuple", "desc": "match selects the first matching case. Patterns can unpack values and bind names; use a wildcard for a fallback. Requires Python 3.10 or newer.", "code": "event=('score',7)\nmatch event:\n    case ('score',n): print(n)\n    case _: print('other')", "answer": "7", "symbols": []},
  {"title": "Python · Pattern guards", "alias": "add a condition to a match case", "desc": "A guard checks an extra condition after the pattern matches. A false guard lets Python try the remaining cases. Requires Python 3.10 or newer.", "code": "n=4\nmatch n:\n    case x if x%2==0: print('even')\n    case _: print('odd')", "answer": "even", "symbols": []},
  {"title": "Python · Structural typing with Protocol", "alias": "describe required methods without inheritance", "desc": "A typing.Protocol states what operations a static checker expects. A class can satisfy it without inheriting from it.", "code": "from typing import Protocol\nclass Named(Protocol):\n    def label(self)->str: ...\nclass Badge:\n    def label(self)->str: return 'guest'\ndef show(x:Named): return x.label()\nprint(show(Badge()))", "answer": "guest", "symbols": ["Protocol"]},
  {"title": "Python · Optional type hints", "alias": "annotate a value that may be None", "desc": "In Python 3.10+, str or None can be written as a union with the vertical-bar operator. Check for None before using string methods.", "code": "from typing import Optional\ndef size(s:Optional[str])->int: return 0 if s is None else len(s)\nprint(size(None),size('hi'))", "answer": "0 2", "symbols": ["Optional"]},
  {"title": "Python · Type aliases", "alias": "give a long type hint a readable name", "desc": "A type alias abbreviates an existing type expression. It does not create a distinct runtime type.", "code": "Point = tuple[int,int]\ndef total(p:Point)->int: return p[0]+p[1]\nprint(total((3,5)))", "answer": "8", "symbols": []},
  {"title": "Python · Literal type hints", "alias": "restrict expected string choices", "desc": "Literal lists specific values a static checker accepts. Runtime validation still needs explicit checks when reading outside input.", "code": "from typing import Literal\ndef badge(mode:Literal['easy','hard']): return mode.upper()\nprint(badge('easy'))", "answer": "EASY", "symbols": ["Literal"]},
  {"title": "Python · TypedDict records", "alias": "type hint dictionary fields", "desc": "TypedDict describes expected keys and value types for static checking. At runtime an instance is an ordinary dictionary.", "code": "from typing import TypedDict\nclass Row(TypedDict):\n    score:int\nr:Row={'score':4}; print(r['score'])", "answer": "4", "symbols": ["TypedDict"]},
  {"title": "Python · Type narrowing", "alias": "use isinstance before calling a method", "desc": "An isinstance test splits execution by runtime type. Static checkers can also narrow the type inside the matching branch.", "code": "def format_value(x):\n    if isinstance(x,str): return x.upper()\n    return str(x)\nprint(format_value('win'))", "answer": "WIN", "symbols": []},
  {"title": "Python · Type variables", "alias": "link input type and return type", "desc": "A TypeVar expresses a relationship across annotations. Here the return type follows the element type in the input list.", "code": "from typing import TypeVar\nT=TypeVar('T')\ndef first(xs:list[T])->T: return xs[0]\nprint(first(['red']))", "answer": "red", "symbols": ["TypeVar"]},
  {"title": "Python · Overload signatures", "alias": "document alternative call types", "desc": "typing.overload describes separate signatures for static checking. One ordinary implementation handles actual calls.", "code": "from typing import overload\n@overload\ndef twice(x:int)->int: ...\n@overload\ndef twice(x:str)->str: ...\ndef twice(x): return x*2\nprint(twice(4),twice('a'))", "answer": "8 aa", "symbols": ["overload"]},
  {"title": "Python · Abstract base classes", "alias": "require subclass to implement a method", "desc": "Use ABC and abstractmethod to mark required operations. Python prevents instantiation until all abstract requirements are implemented.", "code": "from abc import ABC,abstractmethod\nclass Shape(ABC):\n    @abstractmethod\n    def area(self): ...\nclass Unit(Shape):\n    def area(self): return 1\nprint(Unit().area())", "answer": "1", "symbols": ["ABC", "abstractmethod"]},
  {"title": "Python · Composition", "alias": "build an object out of another object", "desc": "Composition lets one object delegate work to another instead of inheriting its behavior. Swapping a collaborator is especially useful in tests.", "code": "class Board:\n    def __init__(self,formatter): self.formatter=formatter\n    def render(self,n): return self.formatter(n)\nprint(Board(lambda n:f'{n} pts').render(3))", "answer": "3 pts", "symbols": []},
  {"title": "Python · Dependency injection", "alias": "test a function that uses a clock", "desc": "Pass the dependency in rather than hard-coding a global call. A test can then supply a predictable substitute.", "code": "def label(clock): return f'Tick {clock()}'\nprint(label(lambda:42))", "answer": "Tick 42", "symbols": []},
  {"title": "Python · Bytes versus text", "alias": "convert string to bytes and back", "desc": "Encoding turns text into bytes using a specified encoding; decoding reverses it. Use the same encoding at both ends.", "code": "b='café'.encode('utf-8'); print(len(b),b.decode('utf-8'))", "answer": "5 café", "symbols": []},
  {"title": "Python · Bytearray buffers", "alias": "edit a byte without copying the whole byte string", "desc": "bytearray is mutable. Assign an integer from 0 to 255 to replace one byte.", "code": "b=bytearray(b'cat'); b[0]=ord('b'); print(bytes(b))", "answer": "b'bat'", "symbols": []},
  {"title": "Python · Memory views", "alias": "view a byte buffer without copying", "desc": "memoryview exposes a view over a compatible buffer. A writable view changes the underlying storage.", "code": "b=bytearray(b'abc'); v=memoryview(b); v[1]=ord('Z'); print(bytes(b))", "answer": "b'aZc'", "symbols": []},
  {"title": "Python · Unicode normalization", "alias": "two identical-looking words compare unequal", "desc": "Equivalent text can use different Unicode sequences. Normalize both strings to the same form before comparing when that fits your application.", "code": "import unicodedata as u\na='é'; b='e'+chr(769); print(a==b,u.normalize('NFC',b)==a)", "answer": "False True", "symbols": []},
  {"title": "Python · Unicode casefold", "alias": "case insensitive matching beyond lowercase", "desc": "casefold is designed for caseless comparisons and can change the length of text. Apply to both strings.", "code": "print('Straße'.casefold()=='STRASSE'.casefold())", "answer": "True", "symbols": []},
  {"title": "Python · Prefix removal", "alias": "remove just one exact prefix", "desc": "removeprefix removes the exact leading substring once if present. lstrip instead treats its argument as a set of characters.", "code": "print('level:3'.removeprefix('level:'))", "answer": "3", "symbols": []},
  {"title": "Python · String partition", "alias": "split a string once and keep separator", "desc": "partition always returns three pieces: before, separator and after. A missing separator produces two empty trailing pieces.", "code": "print('score=12'.partition('='))", "answer": "('score', '=', '12')", "symbols": []},
  {"title": "Python · Right splitting", "alias": "separate only the final suffix", "desc": "rsplit with maxsplit=1 separates at the rightmost match. Earlier separators stay in the left-hand piece.", "code": "print('game.level.json'.rsplit('.',1))", "answer": "['game.level', 'json']", "symbols": []},
  {"title": "Python · Translation tables", "alias": "replace many individual characters in text", "desc": "str.maketrans builds a character mapping and translate applies it in one pass. It is useful for normalizing a known set of symbols.", "code": "table=str.maketrans({'-':' ', '_':' '}); print('high_score-list'.translate(table))", "answer": "high score list", "symbols": []},
  {"title": "Python · Text wrapping", "alias": "wrap long strings at a character width", "desc": "textwrap.fill splits text into readable lines near the chosen width. It is intended for plain text, not full browser layout.", "code": "import textwrap\nprint(textwrap.fill('one two three four',width=8))", "answer": "one two\nthree\nfour", "symbols": []},
  {"title": "Python · Dedenting multiline text", "alias": "strip shared indentation from multiline string", "desc": "textwrap.dedent removes common leading indentation across nonblank lines while keeping relative indentation.", "code": "from textwrap import dedent\nprint(dedent('  red'+chr(10)+'  blue'))", "answer": "red\nblue", "symbols": ["dedent"]},
  {"title": "Python · In-memory text streams", "alias": "test code that expects a text file", "desc": "io.StringIO behaves like a text stream in memory. This lets you test parsing without touching the filesystem.", "code": "from io import StringIO\nf=StringIO('4'+chr(10)+'5'); print(sum(int(line) for line in f))", "answer": "9", "symbols": ["StringIO"]},
  {"title": "Python · In-memory binary streams", "alias": "use a file-like object for bytes", "desc": "BytesIO stores binary data in memory. Seek back to the beginning before reading what you just wrote.", "code": "from io import BytesIO\nf=BytesIO(); f.write(b'abc'); f.seek(0); print(f.read(2))", "answer": "b'ab'", "symbols": ["BytesIO"]},
  {"title": "Python · Path stem and suffix", "alias": "filename without final extension", "desc": "pathlib separates the name, stem and suffix. On an archive named game.tar.gz, stem removes only the final suffix.", "code": "from pathlib import Path\np=Path('game.tar.gz'); print(p.stem,p.suffix,p.suffixes)", "answer": "game.tar .gz ['.tar', '.gz']", "symbols": ["Path"]},
  {"title": "Python · Path composition", "alias": "join folder and filename portably", "desc": "Use the slash operator on a Path to build a path from components. It does not create the corresponding files or folders.", "code": "from pathlib import Path\np=Path('assets')/'icons'/'star.png'; print(p.as_posix())", "answer": "assets/icons/star.png", "symbols": ["Path"]},
  {"title": "Python · Relative path calculation", "alias": "remove a known parent folder from a path", "desc": "relative_to expresses a path beneath a specified prefix. It raises ValueError if the path does not have that prefix.", "code": "from pathlib import Path\nprint(Path('project/images/a.png').relative_to('project').as_posix())", "answer": "images/a.png", "symbols": ["Path", "relative_to"]},
  {"title": "Python · Temporary directories", "alias": "isolate test files and clean up automatically", "desc": "TemporaryDirectory creates a temporary workspace and removes it on context exit. Join filenames to the returned directory name.", "code": "from tempfile import TemporaryDirectory\nfrom pathlib import Path\nwith TemporaryDirectory() as d:\n    p=Path(d)/'sample.txt'; p.write_text('hi'); print(p.read_text())", "answer": "hi", "symbols": ["Path", "TemporaryDirectory"]},
  {"title": "Python · File glob patterns", "alias": "find files ending with a pattern", "desc": "Path.glob returns matching paths. Sort when a stable order matters because directory iteration order is not guaranteed.", "code": "from pathlib import PurePath\nprint(PurePath('scores.csv').match('*.csv'))", "answer": "True", "symbols": ["PurePath"]},
  {"title": "Python · Seek and tell", "alias": "reset file cursor after reading", "desc": "tell reports a stream position and seek moves it. Calling read again at the end returns no more data until the position changes.", "code": "from io import BytesIO\nf=BytesIO(b'abc'); f.read(2); print(f.tell()); f.seek(0); print(f.read(1))", "answer": "2\nb'a'", "symbols": ["BytesIO"]},
  {"title": "Python · CSV DictReader", "alias": "read CSV columns by their header names", "desc": "DictReader uses header names as dictionary keys and normally returns cell values as strings. Convert numeric columns deliberately.", "code": "import csv,io\nf=io.StringIO('name,score'+chr(10)+'Ari,8'); print(next(csv.DictReader(f))['score'])", "answer": "8", "symbols": []},
  {"title": "Python · JSON pretty printing", "alias": "indent JSON and sort field names", "desc": "Set indent for readable structure and sort_keys for stable key ordering. Sorting keys is helpful for comparing simple output files.", "code": "import json\nprint(json.dumps({'b':1,'a':2},sort_keys=True,indent=2))", "answer": "{\n  \"a\": 2,\n  \"b\": 1\n}", "symbols": ["sort_keys"]},
  {"title": "Python · JSON lines", "alias": "parse one JSON record per line", "desc": "Each nonblank line contains a complete JSON value. Read line by line so the whole dataset need not fit in memory.", "code": "import json\nrows=['{\"n\":2}','{\"n\":5}']; print(sum(json.loads(line)['n'] for line in rows))", "answer": "7", "symbols": []},
  {"title": "Python · TOML reading", "alias": "read TOML settings in standard Python", "desc": "Python 3.11+ includes tomllib. loads accepts text, while load expects a binary file object.", "code": "import tomllib\nprint(tomllib.loads('[game]'+chr(10)+'speed=3')['game']['speed'])", "answer": "3", "symbols": []},
  {"title": "Python · Regular expression fullmatch", "alias": "require entire string to match regex", "desc": "re.fullmatch succeeds only when the pattern covers the whole input. It is useful for checking a simple format.", "code": "import re\nprint(bool(re.fullmatch('[A-Z]{2}[0-9]{2}','AB12')))", "answer": "True", "symbols": ["re.fullmatch"]},
  {"title": "Python · Regex capture groups", "alias": "extract named fields from text", "desc": "Name a group with (?P<name>...) and access it by its name. Check that a match exists before accessing groups.", "code": "import re\nm=re.fullmatch('(?P<team>[A-Z]+)-(?P<n>[0-9]+)','RED-7'); print(m.groupdict())", "answer": "{'team': 'RED', 'n': '7'}", "symbols": []},
  {"title": "Python · Regex finditer", "alias": "find each match and its position", "desc": "finditer yields match objects lazily. Use start or span to locate the matched text in the original string.", "code": "import re\nprint([(m.group(),m.start()) for m in re.finditer('[0-9]+','A3 B15')])", "answer": "[('3', 1), ('15', 4)]", "symbols": []},
  {"title": "Python · Regex substitution callback", "alias": "compute replacement from each match", "desc": "re.sub can call a function for each match. The function must return the replacement string.", "code": "import re\nprint(re.sub('[0-9]+',lambda m:str(int(m.group())+1),'level 4'))", "answer": "level 5", "symbols": ["re.sub"]},
  {"title": "Python · Regex escaping", "alias": "match punctuation in a literal search term", "desc": "re.escape turns a literal string into pattern text with special characters escaped. Use it for the pattern, not the replacement.", "code": "import re\nprint(bool(re.fullmatch(re.escape('a+b'),'a+b')))", "answer": "True", "symbols": ["re.escape"]},
  {"title": "Python · Decimal arithmetic", "alias": "avoid binary rounding for decimal quantities", "desc": "Build Decimal from strings for exact decimal input. Choose an explicit rounding rule when rounding currency or graded results.", "code": "from decimal import Decimal\nprint(Decimal('0.1')+Decimal('0.2'))", "answer": "0.3", "symbols": ["Decimal"]},
  {"title": "Python · Rational arithmetic", "alias": "keep fractions exact in calculations", "desc": "fractions.Fraction stores a reduced numerator and denominator. Build from integers or fraction strings when you want exact rational input.", "code": "from fractions import Fraction\nprint(Fraction(1,3)+Fraction(1,6))", "answer": "1/2", "symbols": ["Fraction"]},
  {"title": "Python · Approximate float comparisons", "alias": "compare computed floats with a tolerance", "desc": "math.isclose checks closeness using relative and absolute tolerances. For values near zero choose a useful absolute tolerance.", "code": "from math import isclose\nprint(isclose(0.1+0.2,0.3),isclose(1e-12,0,abs_tol=1e-10))", "answer": "True True", "symbols": ["isclose", "math.isclose"]},
  {"title": "Python · Rounding ties", "alias": "why round of two point five is two", "desc": "For exactly representable halfway values Python's built-in round chooses the nearest even result. Binary representation affects other decimal-looking cases.", "code": "print(round(2.5),round(3.5))", "answer": "2 4", "symbols": []},
  {"title": "Python · Divmod pairs", "alias": "compute quotient and remainder together", "desc": "divmod returns floor quotient and remainder as a pair. It is convenient for converting seconds into whole minutes and leftover seconds.", "code": "print(divmod(135,60))", "answer": "(2, 15)", "symbols": []},
  {"title": "Python · Integer square roots", "alias": "largest integer whose square fits", "desc": "math.isqrt returns the floor of the exact square root of a nonnegative integer. It avoids float precision issues for large integers.", "code": "from math import isqrt\nprint(isqrt(99),isqrt(100))", "answer": "9 10", "symbols": ["isqrt", "math.isqrt"]},
  {"title": "Python · Greatest common divisor in code", "alias": "compute gcd of two integers", "desc": "math.gcd returns a nonnegative common divisor of largest size. Use it when reducing ratios or checking coprimality.", "code": "from math import gcd\nprint(gcd(24,36))", "answer": "12", "symbols": ["gcd", "math.gcd"]},
  {"title": "Python · Counting combinations", "alias": "how many ways to choose k items", "desc": "math.comb computes how many unordered selections of k items are possible from n distinct items, without generating each selection.", "code": "from math import comb\nprint(comb(5,2))", "answer": "10", "symbols": ["comb", "math.comb"]},
  {"title": "Python · Binary number formatting", "alias": "show an integer as padded binary", "desc": "Use format with b for base two. A width with leading zero pads the representation for display.", "code": "print(format(9,'08b'))", "answer": "00001001", "symbols": []},
  {"title": "Python · Parsing integer bases", "alias": "turn hexadecimal or binary text into integer", "desc": "Pass an explicit base to int. With base zero, a recognized prefix such as 0x or 0b determines the base.", "code": "print(int('ff',16), int('0b101',0))", "answer": "255 5", "symbols": []},
  {"title": "Python · Bit masks", "alias": "test whether a flag bit is set", "desc": "A bitwise AND with a single-bit mask isolates that flag. Convert to bool if you need just true or false.", "code": "flags=0b1010; print(bool(flags & 0b0010))", "answer": "True", "symbols": []},
  {"title": "Python · Integer byte conversion", "alias": "store an integer in a fixed number of bytes", "desc": "to_bytes and from_bytes require a byte order. Choose a large enough length and the proper signed option for the value range.", "code": "b=(513).to_bytes(2,'big'); print(b.hex(),int.from_bytes(b,'big'))", "answer": "0201 513", "symbols": ["from_bytes", "to_bytes"]},
  {"title": "Python · Itertools chain", "alias": "iterate multiple collections in order", "desc": "chain yields items from each iterable in turn. The sources need not be lists and can be consumed lazily.", "code": "from itertools import chain\nprint(list(chain([1,2],(3,4))))", "answer": "[1, 2, 3, 4]", "symbols": ["chain"]},
  {"title": "Python · Itertools islice", "alias": "take the first few values of a generator", "desc": "islice consumes only as far as needed. The underlying iterator advances as values are taken.", "code": "from itertools import islice,count\nprint(list(islice(count(10),3)))", "answer": "[10, 11, 12]", "symbols": ["count", "islice"]},
  {"title": "Python · Itertools pairwise", "alias": "loop over neighboring values", "desc": "pairwise yields overlapping consecutive pairs. Python 3.10+ provides it in itertools.", "code": "from itertools import pairwise\nprint([b-a for a,b in pairwise([2,5,9])])", "answer": "[3, 4]", "symbols": ["pairwise"]},
  {"title": "Python · Itertools accumulate", "alias": "calculate a running total", "desc": "accumulate yields intermediate totals rather than just a final sum. A supplied two-argument function can change the operation.", "code": "from itertools import accumulate\nprint(list(accumulate([3,1,4])))", "answer": "[3, 4, 8]", "symbols": ["accumulate"]},
  {"title": "Python · Cartesian products", "alias": "generate every pair from two collections", "desc": "itertools.product combines each value of one input with each value of the next. Count the combinations before expanding a large result.", "code": "from itertools import product\nprint(list(product('AB',[1,2])))", "answer": "[('A', 1), ('A', 2), ('B', 1), ('B', 2)]", "symbols": ["itertools.product", "product"]},
  {"title": "Python · Combinations iterator", "alias": "generate unordered pairs without repetition", "desc": "itertools.combinations selects positions in input order. It does not emit both (A,B) and (B,A) for distinct input positions A and B.", "code": "from itertools import combinations\nprint(list(combinations('ABC',2)))", "answer": "[('A', 'B'), ('A', 'C'), ('B', 'C')]", "symbols": ["combinations", "itertools.combinations"]},
  {"title": "Python · Permutations iterator", "alias": "generate arrangements where order matters", "desc": "permutations generates ordered selections without reusing input positions. Large inputs quickly produce many possibilities.", "code": "from itertools import permutations\nprint(list(permutations('AB',2)))", "answer": "[('A', 'B'), ('B', 'A')]", "symbols": ["permutations"]},
  {"title": "Python · Grouping consecutive runs", "alias": "count adjacent repeats with groupby", "desc": "itertools.groupby groups adjacent matching keys. For global groups, sort by the same key first or use a mapping.", "code": "from itertools import groupby\nprint([(k,len(list(g))) for k,g in groupby('AABAA')])", "answer": "[('A', 2), ('B', 1), ('A', 2)]", "symbols": ["groupby", "itertools.groupby"]},
  {"title": "Python · Filtering paired values", "alias": "filter data using a Boolean mask", "desc": "itertools.compress pairs items with selectors and retains the truthy ones. It ends when either input ends.", "code": "from itertools import compress\nprint(list(compress('ABC',[True,False,True])))", "answer": "['A', 'C']", "symbols": ["compress", "itertools.compress"]},
  {"title": "Python · Takewhile prefixes", "alias": "stop consuming values at first failed condition", "desc": "takewhile yields an initial run that passes a predicate. It consumes the first failing value while detecting the boundary.", "code": "from itertools import takewhile\nprint(list(takewhile(lambda x:x<5,[1,3,6,2])))", "answer": "[1, 3]", "symbols": ["takewhile"]},
  {"title": "Python · Strict zip", "alias": "catch different length input lists", "desc": "zip(..., strict=True) raises ValueError on unequal lengths during iteration. Use it when dropping unmatched data would be a bug. Requires Python 3.10+.", "code": "try: list(zip([1,2],['a'],strict=True))\nexcept ValueError: print('length mismatch')", "answer": "length mismatch", "symbols": []},
  {"title": "Python · Zip longest", "alias": "keep extra items from a longer sequence", "desc": "itertools.zip_longest fills missing positions instead of truncating the result. Choose a fill value distinct from real data if necessary.", "code": "from itertools import zip_longest\nprint(list(zip_longest('ab',[1],fillvalue=None)))", "answer": "[('a', 1), ('b', None)]", "symbols": ["itertools.zip_longest", "zip_longest"]},
  {"title": "Python · Lazy any", "alias": "check whether at least one item passes", "desc": "any stops at the first truthy result. With a generator expression it avoids testing later items once a match is found.", "code": "print(any(n>5 for n in [2,8,3]))", "answer": "True", "symbols": []},
  {"title": "Python · Universal checks with all", "alias": "check that every value meets a rule", "desc": "all stops at the first false result. On an empty iterable it returns True; separately require a nonempty input when needed.", "code": "print(all(n>=0 for n in [1,2,3]),all([]))", "answer": "True True", "symbols": []},
  {"title": "Python · Set symmetric difference", "alias": "items present in exactly one collection", "desc": "The symmetric difference of two sets excludes the overlap. Use it to find membership changes between snapshots.", "code": "a={'red','blue'}; b={'blue','green'}; print(sorted(a ^ b))", "answer": "['green', 'red']", "symbols": []},
  {"title": "Python · Removing duplicate items in order", "alias": "deduplicate while preserving first appearance", "desc": "For hashable items, dict.fromkeys builds keys in insertion order. Convert the result back to a list to keep the first occurrence of each value.", "code": "print(list(dict.fromkeys(['a','b','a','c'])))", "answer": "['a', 'b', 'c']", "symbols": []},
  {"title": "Python · Mapping proxy", "alias": "expose read-only view of a dictionary", "desc": "MappingProxyType prevents writes through the view but reflects later changes made to the original dictionary.", "code": "from types import MappingProxyType\na={'n':1}; view=MappingProxyType(a); a['n']=2; print(view['n'])", "answer": "2", "symbols": ["MappingProxyType"]},
  {"title": "Python · Shallow dictionary merging", "alias": "merge dictionaries with right side winning", "desc": "The update method changes the destination in place. Make a copy first for a fresh result; on collisions later values replace earlier ones.", "code": "a={'x':1}; merged=a.copy(); merged.update({'x':3,'y':4}); print(merged,a)", "answer": "{'x': 3, 'y': 4} {'x': 1}", "symbols": []},
  {"title": "Python · Dictionary setdefault", "alias": "initialize missing group in a mapping", "desc": "setdefault returns the existing value or inserts and returns the provided default. It can group related items in a plain dictionary.", "code": "d={}; d.setdefault('blue',[]).append('Bo'); print(d)", "answer": "{'blue': ['Bo']}", "symbols": []},
  {"title": "Python · Stack-based bracket checking", "alias": "verify opening and closing delimiters", "desc": "Push openings onto a stack and pop only for matching closings. A valid run ends with an empty stack and no mismatches.", "code": "def valid(text):\n    stack=[]\n    for c in text:\n        if c=='(': stack.append(c)\n        elif c==')' and not stack: return False\n        elif c==')': stack.pop()\n    return not stack\nprint(valid('(())'),valid(')('))", "answer": "True False", "symbols": []},
  {"title": "Python · Breadth-first graph search", "alias": "visit unweighted graph level by level", "desc": "Use a queue and mark nodes seen when enqueuing. The first time you reach a node is via a shortest path in edge count.", "code": "from collections import deque\ng={'A':['B','C'],'B':['D'],'C':[],'D':[]}; q=deque(['A']); seen={'A'}\nwhile q:\n    u=q.popleft(); print(u)\n    for v in g[u]:\n        if v not in seen: seen.add(v); q.append(v)", "answer": "A\nB\nC\nD", "symbols": ["deque"]},
  {"title": "Python · Depth-first graph search", "alias": "explore one graph branch at a time", "desc": "A stack explores the newest pending node first. Track visited nodes to avoid cycling forever.", "code": "g={'A':['B','C'],'B':['D'],'C':[],'D':[]}; stack=['A']; seen=set()\nwhile stack:\n    u=stack.pop()\n    if u in seen: continue\n    seen.add(u); print(u); stack.extend(reversed(g[u]))", "answer": "A\nB\nD\nC", "symbols": []},
  {"title": "Python · Prefix sums", "alias": "sum many list ranges quickly", "desc": "Store cumulative totals with an initial zero. The sum of positions a through b-1 is prefix[b] minus prefix[a].", "code": "from itertools import accumulate\np=list(accumulate([3,5,2],initial=0)); print(p[3]-p[1])", "answer": "7", "symbols": ["accumulate"]},
  {"title": "Python · Sliding window sums", "alias": "update a rolling total efficiently", "desc": "Add the entering value and subtract the leaving value as a fixed-size window moves. This avoids recomputing each full sum.", "code": "a=[3,1,5,2]; k=2; total=sum(a[:k]); out=[total]\nfor i in range(k,len(a)):\n    total += a[i]-a[i-k]; out.append(total)\nprint(out)", "answer": "[4, 6, 7]", "symbols": []},
  {"title": "Python · Two-pointer search", "alias": "find pair with target sum in sorted list", "desc": "Start at opposite ends of a sorted list. Move left inward when the sum is too small or right inward when it is too large.", "code": "a=[1,3,5,9]; l,r=0,len(a)-1\nwhile l<r:\n    n=a[l]+a[r]\n    if n==8: print(a[l],a[r]); break\n    if n<8: l+=1\n    else: r-=1", "answer": "3 5", "symbols": []},
  {"title": "Python · Time complexity", "alias": "why nested loops get slower", "desc": "Count how work grows with input size. Two nested loops both ranging over n positions make n squared iterations, regardless of the machine's exact speed.", "code": "for n in [3,6]: print(sum(1 for i in range(n) for j in range(n)))", "answer": "9\n36", "symbols": []},
  {"title": "Python · Async coroutines", "alias": "await a Python coroutine", "desc": "async def makes a coroutine function. Await its result inside another coroutine, or start it with asyncio.run at a synchronous entry point.", "code": "import asyncio\nasync def score(): return 7\nprint(asyncio.run(score()))", "answer": "7", "symbols": ["asyncio.run"]},
  {"title": "Python · Concurrent coroutine results", "alias": "run independent awaitables with gather", "desc": "asyncio.gather waits for several awaitables and returns results in input order. This helps when tasks spend time waiting for I/O.", "code": "import asyncio\nasync def calc(n):\n    await asyncio.sleep(0); return n*2\nasync def main(): return await asyncio.gather(calc(2),calc(3))\nprint(asyncio.run(main()))", "answer": "[4, 6]", "symbols": ["asyncio.gather"]},
  {"title": "Python · Async iterators", "alias": "stream values with async for", "desc": "An asynchronous generator can await between yields. async for consumes each available value within a coroutine.", "code": "import asyncio\nasync def stream():\n    for n in range(2): yield n\nasync def main(): return [n async for n in stream()]\nprint(asyncio.run(main()))", "answer": "[0, 1]", "symbols": []},
  {"title": "Python · Async task groups", "alias": "wait for related tasks as a group", "desc": "Python 3.11+ TaskGroup waits for its tasks when the async with block exits. Failures in a task can cancel its siblings.", "code": "import asyncio\nasync def main():\n    async with asyncio.TaskGroup() as group:\n        job=group.create_task(asyncio.sleep(0,result=12))\n    return job.result()\nprint(asyncio.run(main()))", "answer": "12", "symbols": []},
  {"title": "Python · Async queues", "alias": "pass work between coroutines", "desc": "An asyncio.Queue lets producers put and consumers get items. A bounded queue can slow producers when consumers lag.", "code": "import asyncio\nasync def main():\n    q=asyncio.Queue(maxsize=1); await q.put('job'); return await q.get()\nprint(asyncio.run(main()))", "answer": "job", "symbols": ["asyncio.Queue"]},
  {"title": "Python · Async locks", "alias": "guard shared state across await points", "desc": "async with lock gives one coroutine at a time access to a critical section in the event loop. Keep the protected work small.", "code": "import asyncio\nasync def main():\n    lock=asyncio.Lock()\n    async with lock: print(lock.locked())\nprint(asyncio.run(main()))", "answer": "True\nNone", "symbols": []},
  {"title": "Python · Time zone aware timestamps", "alias": "store a datetime with a UTC offset", "desc": "An aware datetime carries timezone information. Use it for instants that must compare consistently across time zones.", "code": "from datetime import datetime,timezone\nd=datetime(2025,1,1,12,tzinfo=timezone.utc); print(d.isoformat())", "answer": "2025-01-01T12:00:00+00:00", "symbols": ["datetime", "timezone"]},
  {"title": "Python · Timedelta arithmetic", "alias": "add time across midnight", "desc": "timedelta represents a duration. Adding it to a datetime handles date changes automatically.", "code": "from datetime import datetime,timedelta\nprint(datetime(2025,2,1,23,30)+timedelta(minutes=45))", "answer": "2025-02-02 00:15:00", "symbols": ["datetime", "timedelta"]},
  {"title": "Python · ISO date parsing", "alias": "parse a year-month-day string", "desc": "date.fromisoformat parses an ISO date and validates the calendar date. It raises ValueError for invalid input.", "code": "from datetime import date\nprint(date.fromisoformat('2024-02-29').day)", "answer": "29", "symbols": ["date", "date.fromisoformat"]},
  {"title": "Python · Monotonic timing", "alias": "measure elapsed time without clock adjustments", "desc": "Use perf_counter for an elapsed interval. Absolute readings have no calendar meaning, so subtract the starting reading.", "code": "from time import perf_counter\nstart=perf_counter(); sum(range(1000)); print(perf_counter()-start>=0)", "answer": "True", "symbols": ["perf_counter"]},
  {"title": "Python · Unit test subtests", "alias": "run several cases inside one unittest", "desc": "subTest labels each case so a failing example is easier to identify. Pick boundaries as well as ordinary inputs.", "code": "import unittest\nclass Cases(unittest.TestCase):\n    def test_double(self):\n        for n,want in [(0,0),(3,6)]:\n            with self.subTest(n=n): self.assertEqual(n*2,want)\nr=unittest.TestResult(); Cases('test_double').run(r); print(r.wasSuccessful())", "answer": "True", "symbols": []},
  {"title": "Python · Mock call assertions", "alias": "verify a collaborator was called correctly", "desc": "A Mock records calls. assert_called_once_with checks both the count and arguments without contacting an external service.", "code": "from unittest.mock import Mock\nsave=Mock(); save('level',3); save.assert_called_once_with('level',3); print(save.call_count)", "answer": "1", "symbols": ["Mock", "assert_called_once_with"]},
  {"title": "Python · Table-driven tests", "alias": "run input and expected pairs through same check", "desc": "Store representative inputs alongside expected outputs and loop over them. Include failure-prone boundaries in the table.", "code": "cases=[('',0),('hi',2),('cat',3)]\nprint(all(len(text)==want for text,want in cases))", "answer": "True", "symbols": []},
  {"title": "Python · Doctest examples", "alias": "check examples embedded in a docstring", "desc": "doctest can compare interactive-style examples with their expected text output. Keep the examples deterministic.", "code": "import doctest\nexample='>>> 2 + 3'+chr(10)+'5'+chr(10); parser=doctest.DocTestParser()\nt=parser.get_doctest(example,{},'addition','demo',0); r=doctest.DocTestRunner(); r.run(t); print(r.failures)", "answer": "0", "symbols": []},
  {"title": "Git staging", "alias": "choose which edits go in the next commit", "desc": "git add updates the staging area. Review git diff --staged before committing so the snapshot includes the intended edits."},
  {"title": "Git working tree diff", "alias": "see changes that are not staged yet", "desc": "git diff compares working files against the staging area. A staged change may disappear from this view while remaining visible in git diff --staged."},
  {"title": "Git commit inspection", "alias": "see the patch for a particular commit", "desc": "git show with a commit ID displays its message and changes. Use git show --stat for a shorter file-level summary."},
  {"title": "Git branch tracking", "alias": "what branch is my local branch following", "desc": "git branch -vv lists local branches with upstream information when configured. Fetch current remote information before interpreting ahead or behind counts."},
  {"title": "Git fetch versus pull", "alias": "inspect remote updates before merging", "desc": "git fetch updates remote-tracking references. git pull fetches and integrates changes according to your configuration. Use git log to inspect before integrating if needed."},
  {"title": "Git merge base", "alias": "find common ancestor of two branches", "desc": "git merge-base A B finds a best common ancestor of the two histories. It helps explain which changes happened since a branch diverged."},
  {"title": "Git conflict markers", "alias": "why does my file contain two competing versions", "desc": "During a conflict Git can mark competing text sections in the file. Read both changes in context, edit a correct combined result, test and stage the resolution."},
  {"title": "Git amend", "alias": "fix the last local commit message", "desc": "git commit --amend creates a replacement commit. Use it for your own unpublished work; changing shared history affects collaborators."},
  {"title": "Git revert", "alias": "undo a published change with a new commit", "desc": "git revert creates a new commit reversing the selected patch. Review the result because later commits may depend on the original change."},
  {"title": "Git ignore tracked files", "alias": "why gitignore has no effect on an existing file", "desc": "Ignore patterns affect untracked paths. Already tracked files continue appearing in Git until their tracking status is deliberately changed."},
  {"title": "JavaScript promise chaining", "alias": "get result from an asynchronous operation", "desc": "Return a value or promise from a then callback for the next step to receive. Attach a catch handler to handle rejection."},
  {"title": "JavaScript async await", "alias": "wait for a promise inside a function", "desc": "An async function returns a promise. await pauses that function until the promise settles while the event loop can continue other work."},
  {"title": "JavaScript Promise.all", "alias": "wait for several independent promises", "desc": "Promise.all returns results in input order after all fulfill. If one rejects, the returned promise rejects; the other operations are not automatically canceled."},
  {"title": "JavaScript nullish coalescing", "alias": "keep zero while using a fallback for null", "desc": "The double-question-mark operator uses the fallback only for null or undefined. Unlike logical OR, it preserves valid values such as zero and an empty string."},
  {"title": "JavaScript optional chaining", "alias": "read a nested property that might be missing", "desc": "Optional chaining uses ?. to stop with undefined if the current value is null or undefined. Use it where an absent field is an expected case."},
  {"title": "JavaScript event delegation", "alias": "handle clicks from many child buttons", "desc": "Attach a handler to a common ancestor and locate the relevant child from the event target. This also works for children added later if the event bubbles."},
  {"title": "JavaScript debounce", "alias": "avoid running a search on every keystroke", "desc": "Start a timer after each input and cancel the previous timer. Run the search after a quiet interval; guard against older async results arriving late."},
  {"title": "JavaScript closure scope", "alias": "let versus var inside loop callbacks", "desc": "let gives a for-loop binding per iteration. A var binding is shared across iterations, so delayed callbacks can all see its final value."},
  {"title": "JavaScript Map", "alias": "use objects as lookup keys", "desc": "Map accepts keys of different types and preserves insertion order. Use has to distinguish a missing key from a key whose stored value is undefined."},
  {"title": "JavaScript array filter", "alias": "select array entries that pass a test", "desc": "filter creates a new array of elements for which the callback returns a truthy value. The elements themselves are shared references when they are objects."},
  {"title": "SQL inner join", "alias": "combine matching rows from two tables", "desc": "INNER JOIN pairs rows satisfying the join condition. Matching multiple rows on either side can produce more results than the number of input records."},
  {"title": "SQL left join", "alias": "keep rows even when no match exists", "desc": "LEFT JOIN preserves left-side rows and fills unmatched right-side columns with NULL. A later WHERE condition on the right table can remove those rows."},
  {"title": "SQL group by", "alias": "calculate a total per category", "desc": "GROUP BY gathers rows sharing the grouping keys. Use aggregate expressions such as COUNT or SUM for the values summarized within each group."},
  {"title": "SQL having", "alias": "filter groups after aggregation", "desc": "WHERE filters individual rows before grouping. HAVING filters the groups after aggregate values are calculated."},
  {"title": "SQL count nulls", "alias": "why count column differs from count star", "desc": "COUNT(*) counts rows. COUNT(column) counts rows where that expression is non-NULL, so the values can differ."},
  {"title": "SQL distinct", "alias": "return each combination once", "desc": "SELECT DISTINCT removes duplicate combinations across the selected columns. Add ORDER BY when the result order matters."},
  {"title": "SQL order by ties", "alias": "make pagination order deterministic", "desc": "When several rows tie on the sort field, add a unique tie breaker such as an ID. Without a complete ordering the database may return tied rows in varying order."},
  {"title": "SQL transactions", "alias": "keep related database writes together", "desc": "A transaction groups operations so they can be committed together or rolled back together. Use one for changes that must succeed or fail as a unit."},
  {"title": "SQL indexes", "alias": "speed up lookups without scanning every row", "desc": "An index maintains a structure the database can search efficiently for compatible queries. It consumes storage and adds maintenance work when rows change."},
  {"title": "SQL foreign keys", "alias": "require a row to reference an existing parent", "desc": "A foreign key enforces a relationship between tables when enabled by the database. Decide explicitly how updates and deletions of the referenced row should behave."},
  {"title": "CSS specificity", "alias": "why one style rule beats another", "desc": "Within the same relevant cascade origin, layer and importance, selector specificity helps decide which declaration wins. Source order breaks ties when priority and specificity are equal."},
  {"title": "CSS flex wrapping", "alias": "cards overflow in one horizontal row", "desc": "A flex container defaults to a single line. Enable flex-wrap and give children sensible widths or flex bases so they can move onto additional lines."},
  {"title": "CSS grid minmax", "alias": "responsive columns without fixed breakpoints", "desc": "A common pattern uses repeat(auto-fit, minmax(..., 1fr)). Set a minimum that fits the available width; narrow mobile screens may require a smaller minimum."},
  {"title": "CSS box sizing", "alias": "width plus padding causes overflow", "desc": "With box-sizing: border-box, a declared width includes padding and border. Margins still sit outside that size."},
  {"title": "CSS media queries", "alias": "change layout at different viewport widths", "desc": "Wrap rules in a media query that describes when the layout needs to change. Pick breakpoints from the content rather than a particular phone model."},
  {"title": "HTML label association", "alias": "make a form label focus its input", "desc": "Give the control a unique id and use that id as the label's for value, or nest the input in the label. Clicking the label then activates the associated control."},
  {"title": "HTML button types", "alias": "button unexpectedly submits my form", "desc": "A button associated with a form defaults to submit in ordinary use. Set type=\"button\" on controls that only open a menu or run a local action."},
  {"title": "Accessible keyboard focus", "alias": "make a custom control usable without a mouse", "desc": "Prefer a native button or link, keep the focus indicator visible and test tab order. A clickable div alone lacks the native keyboard behavior."},
  {"title": "Test fixtures", "alias": "reuse setup data without leaking test state", "desc": "Build a fresh fixture for each test that mutates state. Keep the fixture small and name fields so the scenario is easy to understand."},
  {"title": "Boundary value testing", "alias": "which inputs should I test near a limit", "desc": "Test just below, exactly at and just above each meaningful boundary. For an allowed range of 1 through 10, include 0, 1, 10 and 11."}
];
const codingStop = new Set('a an the is are was be of by and or in on to at for i me my we you can could would should how what why does do with using use make get it that as from without python explain show please'.split(' '));
function codingWords(text) {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) || []).map(w => {
    if (w === 'lists' || w === 'arrays') return 'list';
    if (w === 'dictionaries' || w === 'dicts') return 'dictionary';
    if (w === 'dupes' || w === 'duplicates') return 'duplicate';
    return w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0,-1) : w;
  });
}
const codingExtra = {
  'Removing duplicate items in order':['remove duplicates from a list without changing the order','keep list order when removing duplicates'],
  'Generator functions':['how does yield work in python','pause a function and resume later'],
  'Mutable default arguments':['why does my function remember the list from the last call','default list shared across calls'],
  'Async task groups':['asyncio.TaskGroup'],
  'Concurrent coroutine results':['asyncio.gather','wait for multiple coroutines at once'],
  'Grouping consecutive runs':['itertools.groupby'],
  'Function decorators':['how do python decorators work'],
  'Memoization':['cache repeated function calls','functools.lru_cache'],
  'Dataclass factories':['dataclass default_factory','give each dataclass its own list'],
  'Time complexity':['big O of nested loops'],
  'Strict zip':['zip strict true','zip lists of different lengths and raise an error'],
  'Breadth-first graph search':['breadth first search','bfs shortest path'],
  'Depth-first graph search':['depth first search','dfs traversal'],
  'SQL left join':['keep unmatched rows from the left table'],
  'Git revert':['undo a commit without rewriting history']
};
const codingIndex = codingFacts.map(f => {
  const title = f.title.replace(/^Python · /,'');
  const phrases = [f.title,title,f.alias,...(codingExtra[title] || [])];
  return {phrases:phrases.map(codingWords), symbols:(f.symbols || []).map(s => s.toLowerCase())};
});
const codingFrequency = new Map();
for (const entry of codingIndex) {
  for (const w of new Set(entry.phrases.flat())) codingFrequency.set(w,(codingFrequency.get(w) || 0)+1);
}
const codingSymbolFrequency = new Map();
for (const entry of codingIndex) for (const s of entry.symbols) codingSymbolFrequency.set(s,(codingSymbolFrequency.get(s) || 0)+1);
function specializedIndex(query) {
  const tokens = codingWords(query);
  const phrase = ' '+tokens.join(' ')+' ';
  const words = new Set(tokens.filter(w => !codingStop.has(w)));
  const raw = new Set(query.toLowerCase().match(/[a-z_][a-z0-9_.]*/g)?.map(s=>s.replace(/\.+$/,'')) || []);
  let best = -1, bestScore = 0, second = 0;
  for (const [i,entry] of codingIndex.entries()) {
    let score=0;
    for (const p of entry.phrases) {
      const key = p.join(' ');
      if (phrase.trim() === key) { score=100; break; }
      if (p.length >= 2 && phrase.includes(' '+key+' ')) score=Math.max(score,10+p.length);
      const keys=[...new Set(p.filter(w=>!codingStop.has(w)))];
      const shared=keys.filter(w=>words.has(w));
      if (shared.length < 2) continue;
      const weight=w=>Math.log(1+200/(codingFrequency.get(w)||1));
      const overlap=shared.reduce((s,w)=>s+weight(w),0);
      const coverage=overlap/keys.reduce((s,w)=>s+weight(w),0);
      if (coverage >= .57 && shared.length/words.size >= .4) score=Math.max(score,coverage*4+Math.min(5,overlap*.48));
    }
    for (const s of entry.symbols) {
      if(raw.has(s) && codingSymbolFrequency.get(s)===1 && (s.includes('.') || s.includes('_') || tokens.includes('python'))) score=Math.max(score,11);
    }
    if(score>bestScore){second=bestScore;bestScore=score;best=i;}
    else second=Math.max(second,score);
  }
  return bestScore>=6 && bestScore-second>.3 ? originalTopicCount+assistantFacts.length+best : -1;
}

function classify(s) {
  const personal = personalIndex(s);
  if (personal >= 0) return personal;
  const phrase = (s.toLowerCase().match(/[a-z0-9_]+|==|=/g) || []).join(' ');
  if (Object.prototype.hasOwnProperty.call(model.exact, phrase)) return model.exact[phrase];
  const specialized = specializedIndex(s);
  if (specialized >= 0) return specialized;
  const scores = scoreQuery(s);
  if (!scores) return -1;
  const max = Math.max(...scores);
  return 1 / scores.reduce((n, x) => n + Math.exp(x - max), 0) >= .74 ? scores.indexOf(max) : -1;
}

function retrieve(s, k = 3) {
  const personal = personalIndex(s);
  if(personal >= 0) return [model.topics[personal]];
  const phrase = (s.toLowerCase().match(/[a-z0-9_]+|==|=/g) || []).join(' ');
  const specialized = specializedIndex(s);
  if (specialized >= 0 && !Object.prototype.hasOwnProperty.call(model.exact, phrase)) return [model.topics[specialized]];
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
  const personal = personalIndex(q);
  if (!pendingPhoto && personal >= 0) {
    showCanned(personal,q);
    field.value='';field.blur();
    return;
  }
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
  originalTopicCount = model.topics.length;
  model.topics.push(...assistantFacts,...codingFacts);
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
