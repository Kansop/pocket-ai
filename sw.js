// Self-unregistering service worker for the retired Llama Pocket AI app.
// Keeps the same filename so existing registrations update, then drop off.
// Only pocketai-* caches are cleared so other apps on this origin stay intact.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('pocketai-')).map((k) => caches.delete(k))
    );
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      try { client.navigate(client.url); } catch {}
    }
  })());
});
