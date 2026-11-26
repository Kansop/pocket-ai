// Pocket AI service worker: caches the app shell + WebLLM library for offline use.
// Model weights are cached by WebLLM itself (Cache API), so we never touch those requests.
const VERSION = 'pocketai-v1.0.0';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/db.js', './js/models.js', './js/markdown.js', './js/worker.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.png',
];
const LIB = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.89/lib/index.js';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    try { await c.add(new Request(LIB, { mode: 'cors' })); } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('pocketai-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isLib = url.href.startsWith('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@');
  if (!sameOrigin && !isLib) return; // model downloads (huggingface, github raw) go straight to network
  if (sameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html') || url.pathname.endsWith('/'))) {
    // network-first for app code so updates arrive quickly; fall back to cache offline
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) { const c = await caches.open(VERSION); c.put(req, res.clone()); }
        return res;
      } catch {
        const hit = await caches.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await caches.match('./index.html') : null);
        return hit || Response.error();
      }
    })());
    return;
  }
  // cache-first for icons, manifest and the pinned WebLLM library
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) { const c = await caches.open(VERSION); c.put(req, res.clone()); }
    return res;
  })());
});
