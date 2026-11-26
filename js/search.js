// Free, keyless web lookups: Wikipedia (CORS) + DuckDuckGo Instant Answer (JSONP).
// Optional: Tavily API key (CORS-enabled) for real web/news search.
const TIMEOUT = 7000;

const STOP = new Set('a an the is are was were be been of to in on for and or with about can could would should you your me my i please tell what whats who whos when where which how why do does did search look up lookup google find web online internet latest current today news give show explain'.split(' '));

export function shouldAutoSearch(text) {
  const t = text.toLowerCase();
  if (t.length < 8 || /```/.test(t)) return false;
  if (/\b(search|look ?up|google|on the (web|internet)|online)\b/.test(t)) return true;
  if (/\b(latest|current(ly)?|today|tonight|yesterday|this (week|month|year)|right now|news|recent(ly)?|update[sd]?|price of|stock|score|weather|release date|came out|20(2[4-9]|3\d))\b/.test(t)) return true;
  if (/^(who|what|when|where)\s+(is|was|are|were|did)\s+[a-z]/.test(t) && !/\b(you|your|i|my|me)\b/.test(t)) return true;
  return false;
}

export function toQuery(text) {
  let q = text.replace(/[?!.,"“”]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = q.split(' ');
  const kept = words.filter(w => !STOP.has(w.toLowerCase()));
  q = (kept.length >= 1 ? kept : words).join(' ');
  return q.slice(0, 120);
}

function withTimeout(p, ms = TIMEOUT) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function wikipedia(q, lang = 'en') {
  const base = `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*`;
  const s = await withTimeout(fetch(`${base}&action=query&list=search&srlimit=3&srsearch=${encodeURIComponent(q)}`).then(r => r.json()));
  const hits = (s.query && s.query.search) || [];
  if (!hits.length) return [];
  const ids = hits.map(h => h.pageid).join('|');
  const ex = await withTimeout(fetch(`${base}&action=query&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exchars=700&pageids=${ids}`).then(r => r.json()));
  const pages = (ex.query && ex.query.pages) || {};
  return hits.map(h => pages[h.pageid]).filter(Boolean).map(p => ({
    title: p.title + ' (Wikipedia)', url: p.fullurl || `https://${lang}.wikipedia.org/?curid=${p.pageid}`,
    snippet: (p.extract || '').replace(/\s+/g, ' ').trim(),
  })).filter(r => r.snippet);
}

let jsonpN = 0;
function ddg(q) {
  return new Promise((resolve) => {
    const cb = '__pocketai_ddg' + (++jsonpN);
    const s = document.createElement('script');
    const done = (v) => { clearTimeout(t); delete window[cb]; s.remove(); resolve(v); };
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
    s.onerror = () => done([]);
    s.src = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&t=pocketai&callback=${cb}`;
    document.head.appendChild(s);
  });
}

async function tavily(q, key) {
  const r = await withTimeout(fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: 4, search_depth: 'basic', include_answer: true }),
  }), 12000);
  if (!r.ok) throw new Error('Tavily error ' + r.status);
  const d = await r.json();
  const out = [];
  if (d.answer) out.push({ title: 'Tavily summary', url: (d.results && d.results[0] && d.results[0].url) || 'https://tavily.com', snippet: d.answer });
  for (const x of d.results || []) out.push({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 700) });
  return out;
}

/** Returns {query, results:[{title,url,snippet}], provider} — never throws. */
export async function webSearch(text, { tavilyKey } = {}) {
  const query = toQuery(text);
  if (!navigator.onLine) return { query, results: [], offline: true };
  let results = [], provider = [];
  if (tavilyKey) {
    try { results = await tavily(query, tavilyKey); provider.push('Tavily'); } catch {}
  }
  if (results.length < 3) {
    const [w, d] = await Promise.all([wikipedia(query).catch(() => []), ddg(query).catch(() => [])]);
    if (d.length) provider.push('DuckDuckGo');
    if (w.length) provider.push('Wikipedia');
    results = results.concat(d, w);
  }
  const seen = new Set();
  results = results.filter(r => r.url && !seen.has(r.url) && seen.add(r.url)).slice(0, 4);
  return { query, results, provider: provider.join(' + ') };
}

export function resultsToPrompt(res) {
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return `Web search results for "${res.query}" (fetched ${date}). Use them to answer if relevant, and cite sources like [1]. If they don't answer the question, say so.\n` +
    res.results.map((r, i) => `[${i + 1}] ${r.title}: ${r.snippet.slice(0, 600)}`).join('\n');
}
