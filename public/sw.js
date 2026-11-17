// Service worker: guarda el "cascarón" de la app. La API siempre va a la red.
const VERSION = 'v19';
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

// Notificaciones push: el aviso llega vacío; el texto se pide a la API con la sesión de la persona.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let title = 'LMH Búsqueda Laboral', body = 'Hay ofertas nuevas para revisar.', url = '/#/ofertas';
    try {
      const r = await fetch('/api/push/summary', { credentials: 'same-origin' });
      if (r.ok) { const d = await r.json(); title = d.title || title; body = d.body || body; url = d.url || url; }
    } catch { /* sin conexión o sesión vencida: texto genérico */ }
    await self.registration.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: 'ofertas-nuevas', renotify: true, data: { url } });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/#/ofertas';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate && c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
