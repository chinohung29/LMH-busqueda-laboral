// Service worker: guarda el "cascarón" de la app. La API siempre va a la red.
const VERSION = 'v16';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/cv.js', '/theme.js', '/install.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/logo-wide.png',
  '/terminos.html', '/privacidad.html', '/arrepentimiento.html', '/legal.css', '/arrepentimiento.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Red primero (siempre la última versión); sin conexión, lo guardado.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/index.html'))),
  );
});
