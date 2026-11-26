const BUILD = '1.6.5';
const MODEL_URL = 'model.json?v=' + BUILD;
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.89/lib/index.js';
const STORE = 'pocket-assistant-winter';
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

function loadSettings() {
  const base = { name: 'Luca', style: 'normal', model: 'qwen-3b', search: true };
  try { return Object.assign(base, JSON.parse(localStorage.getItem(STORE) || '{}')); }
  catch { return base; }
}
function saveSettings() {
  localStorage.setItem(STORE, JSON.stringify({ name: settings.name, style: settings.style, model: settings.model, search: !!settings.search }));
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
  return model.topics.map((_, k) => hidden.reduce((n, h, j) => n + h * model.V[j][k], 0));
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

function showCanned(i, q, note) {
  const card = document.createElement('article');
  historyBox.append(card);
  if (q) add(card, 'small', q);
  if (i < 0) {
    add(card, 'p', 'I haven’t learned a reliable answer to that yet. Try a question from the topic menu, or wait until the AI finishes loading.');
    return card;
  }
  const t = model.topics[i];
  add(card, 'h2', t.title);
  add(card, 'p', t.desc);
  if (note) add(card, 'p', note).id = 'note';
  if (!t.code) return card;
  add(card, 'pre', t.code);
  const reveal = add(card, 'details', '');
  add(reveal, 'summary', 'Reveal the output');
  add(reveal, 'pre', t.answer);
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
  const m = MODELS[key] || MODELS['qwen-3b'];
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
    if (fallback && m.key === 'qwen-3b' && isOom(e)) {
      settings.model = 'qwen-1.5b';
      saveSettings();
      $('modelPick').value = 'qwen-1.5b';
      sessionStorage.setItem(STORE + '.oom3b', '1');
      setStatus('Qwen2.5 3B needed more memory than Safari allowed, so I switched to Qwen2.5 1.5B. You can try 3B again in Settings.');
      loadingPromise = null;
      return loadEngine('qwen-1.5b', { fallback: false });
    }
    setStatus(friendlyError(e) + ' Quick answers still work.');
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
  download: '~2.5 GB',
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
  if (loadedKey === 'phi-vision' && engine) return true;
  if (!gpu || !gpu.ok) return false;
  const previous = loadedKey;
  try {
    setStatus('Loading Phi-3.5 Vision so I can look at your photo. It needs a lot of memory and may not fit on iPhone.');
    await loadEngineVision();
    return true;
  } catch (e) {
    setStatus('I couldn’t load the vision model on this device (' + friendlyError(e) + '). I’ll answer from your text only.');
    if (previous && MODELS[previous]) {
      try { await loadEngine(previous, { fallback: previous === 'qwen-3b' }); } catch {}
    }
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
  const hist = chatTurns.slice(-6);
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
  const card = document.createElement('article');
  historyBox.append(card);
  add(card, 'small', q);
  const p = add(card, 'p', 'Thinking…');
  card.scrollIntoView({ block: 'nearest' });
  generating = true;
  let text = '';
  try {
    const en = engine;
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
      }
    }
    text = stripEmotes(text).trim();
    p.textContent = text || 'I could not write a reply. Try asking again.';
    if (found && found.results && found.results.length) {
      const src = document.createElement('p');
      src.append('Sources: ');
      found.results.forEach((r, i) => {
        if (i) src.append(' · ');
        const a = document.createElement('a');
        a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = r.title.replace(/ \(Wikipedia\)$/, '');
        src.append(a);
      });
      card.append(src);
    }
    if (text) {
      chatTurns.push({ role: 'user', content: q });
      chatTurns.push({ role: 'assistant', content: text });
    }
  } catch (e) {
    const i = classify(q);
    p.textContent = i >= 0 ? model.topics[i].desc : ('The AI hit a problem: ' + friendlyError(e));
    if (i >= 0) {
      add(card, 'h2', model.topics[i].title);
      card.insertBefore(card.querySelector('h2'), p);
    }
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

async function handleQuestion(q) {
  q = (q || '').trim();
  if (!q && !pendingPhoto) {
    add(historyBox, 'p', 'Type a question in the box first, or add a photo.');
    field.focus();
    return;
  }
  if (generating) return;
  if ((readyAI && engine) || pendingPhoto) await generateReply(q || 'What is in this photo?');
  else {
    const note = loadingPromise
      ? 'The AI is still downloading — here’s a quick answer in the meantime.'
      : null;
    showCanned(classify(q), q, note);
  }
  field.value = '';
  field.blur();
  historyBox.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function greet() {
  const who = ($('identity') && $('identity').value) || settings.name || 'Luca';
  $('welcome').textContent = 'What’s on your mind, ' + who + '?';
}

function bindSettings() {
  $('userName').value = settings.name || '';
  $('replyStyle').value = settings.style || 'normal';
  $('modelPick').value = settings.model || 'qwen-3b';
  if ($('webSearch')) $('webSearch').checked = settings.search !== false;
  $('settings').hidden = false;
  $('userName').onchange = $('userName').onblur = () => {
    settings.name = $('userName').value.trim().slice(0, 40) || 'Luca';
    saveSettings();
    greet();
  };
  $('replyStyle').onchange = () => { settings.style = $('replyStyle').value; saveSettings(); };
  if ($('webSearch')) $('webSearch').onchange = () => { settings.search = $('webSearch').checked; saveSettings(); };
  $('modelPick').onchange = async () => {
    const next = $('modelPick').value;
    if (next === settings.model && loadedKey === next) return;
    settings.model = next;
    saveSettings();
    if (!gpu || !gpu.ok) return;
    try { await loadEngine(next, { fallback: next === 'qwen-3b' }); }
    catch {}
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
  const profiles = new Map();
  let active = identity.value || 'Luca';
  identity.value = active;
  greet();
  identity.onchange = () => {
    profiles.set(active, { cards: [...historyBox.childNodes], draft: field.value });
    active = identity.value;
    const profile = profiles.get(active);
    historyBox.replaceChildren(...(profile?.cards || []));
    field.value = profile?.draft || '';
    menu.value = '';
    greet();
    window.scrollTo(0, 0);
  };
  bindSettings();
  bindPhoto();
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
  const card=document.createElement('article');historyBox.append(card);
  const theme=interestList();const chosen=theme[Math.floor(Math.random()*theme.length)];
  add(card,'h2',kind==='name'?'Name idea':'Story starter');
  const out=generateText(creativeBanks[kind]);
  add(card,'p',out?(chosen?(kind==='name'?chosen+' · '+out:'At the '+chosen+' club, something was different today. '+out):out):'Try again for a fresh combination.');
}
function refreshPicks(){
  picks.replaceChildren();
  const tags=interestList().join(' ').toLowerCase();
  const guides=[[ /soccer|football|sports/,'Soccer first touch'],[/game|gaming|fortnite|siege|console|ps5/,'Game practice routines'],[/cod(e|ing)|software|python|programming/,'Debugging'],[/business|startup|entrepreneur/,'MVPs'],[/photo|film|camera/,'Photo composition'],[/music|beat/,'Rhythm practice'],[/school|study/,'Remembering what you study']];
  const targets=new Set(guides.filter(([pattern])=>pattern.test(tags)).map(pair=>pair[1]));
  for(const term of interestList()){if(term.length>2){const i=classify(term);if(i>=0)targets.add(model.topics[i].title);}}
  for(const title of [...targets].slice(0,4)){
    const i=model.topics.findIndex(t=>t.title===title);
    if(i>=0){const b=add(picks,'button',title);b.onclick=()=>show(i,'');}
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
  gpu = await detectGPU();
  if (!gpu.ok) {
    setStatus('This browser can’t run the on-device AI (it needs WebGPU, which iPhone Safari has on iOS 26+). Quick answers still work.');
    return;
  }
  let startKey = settings.model || 'qwen-3b';
  if (startKey === 'qwen-3b' && sessionStorage.getItem(STORE + '.oom3b') === '1') {
    startKey = 'qwen-1.5b';
    settings.model = 'qwen-1.5b';
    $('modelPick').value = 'qwen-1.5b';
    setStatus('Last time, Qwen2.5 3B ran out of memory. Loading Qwen2.5 1.5B. You can try 3B again in Settings.');
  }
  try { await loadEngine(startKey, { fallback: startKey === 'qwen-3b' }); }
  catch {}
}

boot();
