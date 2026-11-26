// Pocket AI service worker.
// - Same-origin files (HTML/JS/CSS/icons): NETWORK-FIRST, bypassing the HTTP cache (GitHub Pages sends
//   max-age=600, which could mix an old index.html with new JS). Falls back to the cache when offline.
// - The pinned WebLLM library: cache-first (its URL is versioned, so it never goes stale).
// - Model weights: not touched here (WebLLM caches them itself).
const VERSION = 'pocketai-v1.5.0';
const BUILD = '1.5.0';
const q = '?v=' + BUILD;
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css' + q,
  ...['app', 'db', 'models', 'markdown', 'worker', 'search', 'memory', 'device', 'seasons'].map(n => `./js/${n}.js${q}`),
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.png',
];
const LIB = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.89/lib/index.js';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // cache what we can; one failed file must not break the install
    await Promise.all(SHELL.map(u => fetch(u, { cache: 'no-cache' }).then(r => r.ok && c.put(u, r)).catch(() => {})));
    try { await c.add(new Request(LIB, { mode: 'cors' })); } catch {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('pocketai-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok && res.type === 'basic') { const c = await caches.open(VERSION); c.put(req, res.clone()).catch(() => {}); }
        return res;
      } catch {
        const c = await caches.open(VERSION);
        const hit = await c.match(req) || await c.match(req, { ignoreSearch: true }) ||
          (req.mode === 'navigate' ? (await c.match('./index.html') || await c.match('./')) : null);
        return hit || Response.error();
      }
    })());
    return;
  }
  if (url.href.startsWith('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(VERSION); c.put(req, res.clone()).catch(() => {}); }
      return res;
    })());
  }
  // everything else (model downloads, search APIs) goes straight to the network
});
