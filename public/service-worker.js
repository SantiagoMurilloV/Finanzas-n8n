// Service Worker mínimo para Finanzas Demo PWA
// Estrategia:
//   - HTML/CSS/JS/SVG: cache-first (rápido offline-first)
//   - /api/*: network-only (datos siempre frescos)

const CACHE = 'finanzas-v1';
const ASSETS = [
  '/',
  '/styles.css',
  '/app.js',
  '/logo.svg',
  '/icon-512.svg',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Nunca cachear la API ni el socket.io ni websockets
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) {
    return;
  }

  // Cache-first para los assets estáticos
  if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          // Solo cachear respuestas válidas same-origin
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return res;
        }).catch(() => caches.match('/'));
      })
    );
  }
});
