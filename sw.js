// sw.js — Emas Amir

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function eaToAbsoluteUrl(rawUrl, fallbackPath) {
  let url = rawUrl || fallbackPath || "/chat.html";

  try {
    return new URL(url, self.location.origin).href;
  } catch (e) {
    return new URL(fallbackPath || "/chat.html", self.location.origin).href;
  }
}

self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {
      title: "Emas Amir",
      body: event.data ? event.data.text() : "Anda ada mesej baru."
    };
  }

  const title = data.title || "Emas Amir";
  const body = data.body || "Anda ada mesej baru.";

  const url = eaToAbsoluteUrl(
    data.url || data.deeplink,
    "/chat.html"
  );

  const icon = data.icon || "/icons/icon-192.png";
  const badge = data.badge || "/icons/icon-192.png";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      data: { url },
      tag: data.tag || "ea-chat-notify",
      renotify: true
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = eaToAbsoluteUrl(
    event.notification?.data?.url,
    "/chat.html"
  );

  event.waitUntil(
    self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(async (clientsArr) => {
      for (const client of clientsArr) {
        if ("navigate" in client && "focus" in client) {
          await client.navigate(targetUrl);
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});