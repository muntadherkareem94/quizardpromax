// sw.js

// A name for our cache
const CACHE_NAME = 'quizard-cache-v2';


// In sw.js
const urlsToCache = [
  '/main-styles.css',
  '/images/logo.png',
  '/images/icons/icon-192x192.png',
  '/images/icons/icon-512x512.png'
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