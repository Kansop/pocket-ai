const trail = new URL("./", self.registration.scope);

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  const sender = typeof data.sender === "string" && /^[a-z0-9_]{3,20}$/.test(data.sender) ? data.sender : "";
  const target = new URL(trail);
  target.hash = sender ? "chat/" + sender : "friends";
  event.waitUntil(self.registration.showNotification("Python Trail", {
    body: data.test ? "Test notification received." : "You have a new chat message.",
    icon: new URL("trail-icon-192.png", trail).href,
    tag: sender ? "python-trail-chat-" + sender : "python-trail-test",
    data: { url: target.href },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const requested = new URL(event.notification.data?.url || trail, trail);
    const target = requested.origin === trail.origin && requested.pathname === trail.pathname ? requested : trail;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => {
      const url = new URL(client.url);
      return url.origin === trail.origin && url.pathname === trail.pathname;
    });
    if (existing) {
      const opened = await existing.navigate(target.href);
      if (opened) return opened.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
