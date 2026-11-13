/* Socle service worker, the same file on every app host (/_socle/sw.js, scope "/").
   Notifications only: there is no offline cache, so an app never shows stale data.
   It must never importScripts() or run anything an app provides. */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  if (!event.data) return {};
  try {
    const data = event.data.json();
    return data && typeof data === 'object' ? data : {};
  } catch {
    return { body: event.data.text() };
  }
}

/** Notifications only ever open a page of this app: the value is resolved, then the origin is checked. */
function localPath(value) {
  if (typeof value !== 'string') return '/';
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  const title = typeof data.title === 'string' && data.title ? data.title : 'Notification';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      icon: '/_socle/icons/icon-192.png',
      badge: '/_socle/icons/badge-96.png',
      tag: typeof data.tag === 'string' && data.tag ? data.tag : 'socle',
      renotify: true,
      data: { url: localPath(data.url) },
    }),
  );
});

async function openApp(path) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    await client.focus();
    // The page may route itself without a reload by listening to this message.
    client.postMessage({ type: 'socle:navigate', url: path });
    return;
  }
  await self.clients.openWindow(new URL(path, self.location.origin).href);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openApp(localPath(event.notification.data?.url)));
});
