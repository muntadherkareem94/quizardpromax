// sw.js

// A name for our cache
const CACHE_NAME = 'quizard-cache-v1';

// In sw.js
const urlsToCache = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/main-styles.css',
  '/images/logo.png',
  '/images/icons/icon-192x192.png', // <-- Add this line
  '/images/icons/icon-512x512.png'  // <-- And this line
];

// 1. Installation: Open a cache and add the app shell files to it.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// 2. Fetching: Intercept network requests.
self.addEventListener('fetch', event => {
  event.respondWith(
    // Try to find a match in the cache first.
    caches.match(event.request)
      .then(response => {
        // If a match is found in the cache, return it.
        if (response) {
          return response;
        }
        // If no match, go to the network to get the file.
        return fetch(event.request);
      })
  );
});