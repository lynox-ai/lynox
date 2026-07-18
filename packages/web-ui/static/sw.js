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
  // directly on the offending mail. Task / escalation pushes carry
  // { data: { threadId } } → deep-link to that conversation via
  // `/app?thread=<id>` (the /app page's onMount resumes it), so a completed
  // background task opens its OWN thread instead of a blank new chat.
  // Falls back to '/' for plain pushes (reminders, scheduled-send results).
  const data = event.notification.data || {};
  const itemId = data.itemId;
  const threadId = data.threadId;
  const target = itemId
    ? `/app/inbox?item=${encodeURIComponent(itemId)}`
    : (threadId ? `/app?thread=${encodeURIComponent(threadId)}` : '/');
  const deepLink = Boolean(itemId || threadId);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const inScope = clientList.filter(
        (c) => c.url.includes(self.registration.scope) && 'focus' in c,
      );
      if (inScope.length === 0) {
        return self.clients.openWindow(target);
      }
      // Re-route every open lynox tab to the deep-link so a user with
      // multiple windows doesn't accidentally land on a stale route. The
      // first match also gets focused. `.catch` is scoped to navigate
      // only — a focus rejection must NOT spawn a second window.
      const first = inScope[0];
      const rest = inScope.slice(1);
      const navigateAll = () => Promise.all(
        rest.map((c) =>
          deepLink && 'navigate' in c
            ? c.navigate(target).catch(() => undefined)
            : Promise.resolve(),
        ),
      );
      if (deepLink && 'navigate' in first) {
        return first.navigate(target)
          .then(() => first.focus())
          .then(navigateAll)
          .catch(() => self.clients.openWindow(target));
      }
      return Promise.resolve(first.focus()).then(navigateAll);
    }),
  );
});
