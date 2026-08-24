self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// What a service worker can and cannot do about a driver's ring.
//
// It CANNOT play a siren. There is no audio output in a service worker and no
// API that gives one; with the browser closed, a push can raise a notification
// and nothing else. How loud that notification is belongs to the Android
// notification channel for this site - importance, sound, whether it overrides
// Do Not Disturb - which is a per-handset setting no website can reach. See
// RUNBOOK "Making the driver ring loud" for the settings that actually matter.
//
// What it CAN do is everything below: re-alert rather than stack, buzz in a
// pattern long enough to feel like a call, refuse to auto-dismiss, and wake an
// open tab so the in-app siren starts on the push instead of on the next poll.
// The worker's ringRepeater then repeats the push every five seconds until the
// driver answers, so this runs nine or ten times rather than once.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || 'Order ready!';
  const body = data.body || 'The counter is calling you to collect an order.';
  const isRing = data.ring === true;

  event.waitUntil(
    (async () => {
      if (isRing) {
        // Start the in-app siren NOW in any tab that is still alive, rather
        // than up to three seconds later when its poll comes round - and
        // background tabs have their timers throttled hard, so the poll may not
        // arrive at all until the driver looks at the phone.
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const c of clients) c.postMessage({ type: 'driver-ring' });
      }

      await self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        // Long enough to be felt through a pocket, and repeated by the pattern
        // itself so one buzz is not the whole alert.
        vibrate: isRing
          ? [500, 200, 500, 200, 500, 200, 500]
          : [400, 150, 400, 150, 400],
        // Never auto-dismiss: the driver has to see it whenever they next look.
        requireInteraction: true,
        // Explicit. A silent notification is the one thing this must not be.
        silent: false,
        // One tag with renotify means each repeat re-alerts the SAME
        // notification. Without the tag the repeater would leave ten separate
        // notifications behind for one order.
        tag: isRing ? 'driver-ring' : 'ems-notice',
        renotify: true,
        actions: isRing ? [{ action: 'answer', title: 'On my way' }] : [],
        data: { url: data.url || '/driver' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/driver';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (c.url.includes('/driver') && 'focus' in c) {
          // Tell the page the driver answered from the notification, so it acks
          // and stops the repeater instead of waiting for them to find the
          // button. The page holds the CSRF token; a service worker does not.
          c.postMessage({ type: 'driver-ring-answered' });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});
