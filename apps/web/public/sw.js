// Service worker mínimo: cachea solo el "shell" estático para navegación sin conexión.
// Nunca cachea /api/* (datos privados, pagos, inventario o entregas).
const CACHE = 'aquisito-shell-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (e.request.mode === 'navigate') e.respondWith(fetch(e.request).catch(() => caches.match('/')));
});
