// service-worker.js
const CACHE_NAME = "pakelmeet-cache-v1";

// Daftar file statis yang di-cache saat install
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.png",
  "/assets/css/style.css",
  "/assets/js/app.js",
];

// Install service worker dan cache file statis
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting(); // langsung aktif
});

// Activate dan hapus cache lama jika ada versi baru
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim(); // langsung kontrol page
});

// Fetch handler (Cache First, lalu fallback ke Network)
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Gunakan network untuk request API (contoh Firestore/RTC signaling)
  if (req.url.includes("firestore.googleapis.com")) {
    event.respondWith(networkFirst(req));
  } else {
    // Default: cache first untuk file statis
    event.respondWith(cacheFirst(req));
  }
});

// Strategy: Cache First
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  return cached || fetch(req);
}

// Strategy: Network First (untuk API)
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    return cached || new Response("Offline", { status: 503 });
  }
}
