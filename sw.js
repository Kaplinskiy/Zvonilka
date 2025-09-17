// /sw.js
// Минимальный Service Worker: кэш ядра, offline fallback, мягкий кеш для статики

const CACHE = 'zvonilka-v1';
const CORE = [
  '/',
  '/index.html',
  '/public/manifest.webmanifest',
  '/public/favicon.svg',
  '/public/config.js',
  '/public/js/helpers.js',
  '/public/js/signaling.js',
  '/public/js/webrtc.js',
  '/public/js/ui.js',
  '/public/offline.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => null)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // 1) Навигация → Network first с офлайн‑фолбэком
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Обновим кэш index.html на лету
        const copy = fresh.clone();
        const cache = await caches.open(CACHE);
        cache.put('/', copy.clone());
        cache.put('/index.html', copy);
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('/public/offline.html')) || Response.error();
      }
    })());
    return;
  }

  // 2) Статика нашего домена → Cache first
  if (sameOrigin && req.method === 'GET' && (
    url.pathname.startsWith('/public/') ||
    url.pathname === '/index.html' || url.pathname === '/'
  )) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return cached || Response.error();
      }
    })());
    return;
  }
  // 3) Остальное — по сети без перехвата
});