/* Service Worker for PakelMeet PWA
   - network-first for navigation (HTML)
   - cache-first for assets
   - works with GitHub Pages subfolder
*/

const CACHE_VERSION = 'v1';
const CACHE_NAME = `pakelmeet-cache-${CACHE_VERSION}`;

const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.png",
  "./assets/css/style.css",
  "./assets/js/app.js",
];

// -------- INSTALL --------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = ASSETS_TO_CACHE.map(
      u => new Request(u, { cache: 'reload' })
    );
    await cache.addAll(requests);
  })());
  self.skipWaiting();
});

// -------- ACTIVATE --------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    );
  })());
  self.clients.claim();
});

// -------- FETCH --------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isNavigation =
    req.mode === 'navigate' ||
    (req.headers.get('accept')?.includes('text/html'));

  if (isNavigation) {
    // network-first untuk navigasi
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(req);
        if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, networkResponse.clone()).catch(() => {});
        }
        return networkResponse;
      } catch {
        const cached = await caches.match('./index.html');
        return cached || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // cache-first untuk assets
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const networkResponse = await fetch(req);
      if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, networkResponse.clone()).catch(() => {});
      }
      return networkResponse;
    } catch {
      const fallback = await caches.match('./index.html');
      return fallback || new Response('Offline', { status: 503 });
    }
  })());
});
