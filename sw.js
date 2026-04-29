const CACHE_NAME = 'jd-bot-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Network-first strategy for API calls
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }
  // For panel.html, always go to network
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
