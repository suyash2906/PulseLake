// PulseLake service worker: shows push notifications from the action dispatcher (Web Push / VAPID)
// and opens the Responder app on tap. No caching / fetch handling - pages always come from CloudFront.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "PulseLake", body: e.data ? e.data.text() : "" };
  }
  const show = self.registration.showNotification(d.title || "PulseLake", {
    body: d.body || "",
    tag: d.tag || "pulselake",
    renotify: true,
    requireInteraction: !!d.critical,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    vibrate: d.critical ? [500, 150, 500, 150, 900] : [200],
    data: { url: d.url || "/responder.html" },
  });
  // let an open Responder app refresh immediately
  const tell = self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((list) => list.forEach((c) => c.postMessage({ type: "push", data: d })));
  e.waitUntil(Promise.all([show, tell]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/responder.html";
  const page = new URL(url, self.location.origin).pathname; // /responder.html or /device.html
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).pathname === page) {
          c.postMessage({ type: "open", url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
