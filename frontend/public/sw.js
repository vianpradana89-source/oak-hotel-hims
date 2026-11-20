self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SET_BADGE') {
    const count = Number(data.count || 0);
    if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
      if (count > 0) {
        self.navigator.setAppBadge(count).catch(() => {});
      } else if (typeof self.navigator.clearAppBadge === 'function') {
        self.navigator.clearAppBadge().catch(() => {});
      }
    }
  } else if (data.type === 'SHOW_NOTIFICATION') {
    const title = data.title || 'OAK Lawang — Tugas Baru';
    const options = {
      body: data.body || 'Ada permintaan pemeriksaan kamar baru dari Front Office.',
      icon: '/favicon.png',
      badge: '/favicon.png',
      tag: data.tag || 'oak-hk-urgent',
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 150, 400, 150, 600],
      data: { url: data.url || '/' }
    };
    event.waitUntil(self.registration.showNotification(title, options).catch(() => {}));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
