
// Version 6: Forces a clean slate and uses relative paths
const CACHE_NAME = 'quizard-app-shell-v8';

// The "App Shell" - Using strict relative paths
const APP_SHELL = [
  './',
  './index.html',
  './dashboard.html',
  './performance_analytics.html',
  './store.html',
  './user_profile.html',
  './main-styles.css',
  './supabaseClient.js',
  './manifest.json',
  './images/logo.png',
  './images/icons/icon-192x192.png',
  './images/icons/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching App Shell');
      return cache.addAll(APP_SHELL);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log('[Service Worker] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (!url.protocol.startsWith('http') || url.hostname.includes('supabase.co') || request.method !== 'GET') {
    return;
  }

 const isHTMLRequest = request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
  if (isHTMLRequest) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        // Fetch fresh version in the background to keep the cache updated
        const fetchPromise = fetch(request).then((networkResponse) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse.clone()));
          return networkResponse;
        }).catch(() => {});
        
        // Return the 0ms cached version immediately to trigger smooth animations
        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  const isStaticAsset = url.pathname.match(/\.(css|js|png|jpg|jpeg|svg|webp|gif|ico|json)$/);
  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const networkFetch = fetch(request)
          .then((networkResponse) => {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
            return networkResponse;
          })
          .catch(() => {
              console.log('[Service Worker] Network failed, using fallback.');
          });
        return cachedResponse || networkFetch;
      })
    );
    return;
  }

  event.respondWith(fetch(request));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});