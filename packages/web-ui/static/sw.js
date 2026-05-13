/**
 * lynox Service Worker — handles push notifications.
 * Minimal: only push event handling, no caching/offline support.
 */

/* eslint-disable no-restricted-globals */

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'lynox', body: event.data.text() };
  }

  const title = payload.title || 'lynox';
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'lynox-notification',
    data: payload.data || {},
    vibrate: [100, 50, 100],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Inbox push payloads carry { data: { itemId } } so the click can land
  // directly on the offending mail rather than the inbox root. Falls
  // back to '/' for non-inbox pushes (reminders, scheduled-send results).
  const itemId = event.notification.data && event.notification.data.itemId;
  const target = itemId ? `/app/inbox?item=${encodeURIComponent(itemId)}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          // Re-route the focused tab to the deep-link before focusing it
          // so a user already on /app/threads still lands on the mail.
          // navigate() rejects on cross-origin / detached clients — the
          // catch falls back to opening a fresh window so the toast tap
          // never silently fizzles.
          if (itemId && 'navigate' in client) {
            return client.navigate(target)
              .then(() => client.focus())
              .catch(() => self.clients.openWindow(target));
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
