// /sw.js
// Service Worker для «Звонилки»
// Цели: кэш ядра, offline fallback, мягкий кэш статики из /public
// Важно: пути из Vite /public публикуются в корень, поэтому здесь БЕЗ префикса /public

const CACHE = 'zvonilka-v2';

// Базовые файлы, которые точно существуют в репозитории (из папки public → корень)
const CORE = [
  '/',                     // SPA entry
  '/index.html',
  '/manifest.webmanifest',
  '/offline.html',
  '/favicon.ico',
  '/icons/favicon.svg',    // если отсутствует — просто не закэшируется в install
  '/config.js',
  '/i18n/ru.json',
  '/i18n/en.json',
  '/i18n/he.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      // addAll упадёт, если какой-то путь недоступен — поэтому ловим и продолжаем
      await cache.addAll(CORE);
    } catch {
      // игнорируем ошибки отдельных ресурсов, офлайн все равно будет работать на /offline.html
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : Promise.resolve())));
  })());
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Перехватываем только свой origin
  if (url.origin !== self.location.origin) return;

  // 1) Навигация → Network first с офлайн‑фолбэком
  if (req.mode === 'navigate') {
    e.respondWith(networkFirstForNavigation(req));
    return;
  }

  // 2) Наши статические ресурсы из /public → Cache first
  if (req.method === 'GET' && isStaticPath(url.pathname)) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // Остальное — по сети без вмешательства (API, WS апгрейды и т.п.)
});

// ----------------- helpers -----------------

function isStaticPath(pathname) {
  // Ровно то, что реально лежит в /public после билда (в корне)
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/offline.html' ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/icons/') ||
    pathname === '/config.js' ||
    pathname.startsWith('/i18n/')
  );
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    // Только успешные ответы кладём в кэш
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return cached || Response.error();
  }
}

async function networkFirstForNavigation(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    // Кэшируем index для офлайна
    if (fresh && fresh.ok) {
      const copy = fresh.clone();
      // Кладём по двум ключам, чтобы offline работал и для '/' и для '/index.html'
      cache.put('/', copy.clone());
      cache.put('/index.html', copy);
    }
    return fresh;
  } catch {
    return (await cache.match('/offline.html')) || Response.error();
  }
}