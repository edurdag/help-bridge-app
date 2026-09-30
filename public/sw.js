/**
 * HELP Telecare — Service Worker (PWA Fallback for iOS)
 * 
 * This service worker enables offline caching for the iOS PWA
 * "Add to Home Screen" installation method. It caches app shell
 * assets for instant loading and provides offline support.
 * 
 * NOTE: This is the FALLBACK path for iOS. The primary path is
 * a native Capacitor app distributed via TestFlight or OTA IPA.
 * 
 * PWA Limitations on iOS:
 * - No background BLE (Web Bluetooth not supported in WebKit)
 * - No push notifications (limited PWA push on iOS 16.4+)
 * - App killed when backgrounded for >30s
 * - No access to CallKit, PushKit, or BGTaskScheduler
 * 
 * What PWA CAN do on iOS:
 * - Display telemetry when user has app open
 * - Connect via WebSocket to server for real-time data
 * - Receive doctor video calls (when app is in foreground)
 * - Show cached content when offline
 */

const CACHE_NAME = 'help-telecare-v1.0.0';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          })
      );
    })
  );
  // Take control of all clients
  self.clients.claim();
});

// Fetch: network-first with cache fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip WebSocket connections
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  // Skip API calls (always network)
  if (url.pathname.startsWith('/api/')) return;

  // Network-first strategy for HTML/JS/CSS
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed — try cache
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Return offline page for navigation requests
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});

// Push notification handler (iOS 16.4+ PWA push support)
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const title = data.title || 'HELP Sağlık';
    const options = {
      body: data.body || 'Yeni bildirim',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      tag: data.tag || 'help-notification',
      data: data,
      requireInteraction: data.emergency === true,
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    console.error('[SW] Push parse error:', e);
  }
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      // Open new window
      return self.clients.openWindow('/');
    })
  );
});
