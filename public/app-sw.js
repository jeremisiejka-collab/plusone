/* +1 — service worker aplikacji testowej (/app).
   Ekran aplikacji i wydarzenia: najpierw sieć, bez zasięgu ostatnia zapisana wersja.
   Zapisujemy tylko udane odpowiedzi — strona logowania (401/403) nigdy nie trafia do pamięci. */
const CACHE = 'plusone-app-v2';
const SHELL = ['/app', '/data/events.json', '/icon-512.png', '/apple-touch-icon.png', '/favicon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u =>
    fetch(u, { credentials: 'same-origin' }).then(r => r.ok && c.put(u, r)).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  const same = url.origin === location.origin;
  // konto i logowanie zawsze na żywo
  if (same && url.pathname.startsWith('/api/')) return;
  const isApp = same && (req.mode === 'navigate' || url.pathname === '/data/events.json');
  const isStatic = same ? /\.(png|svg|webmanifest)$/.test(url.pathname) : url.hostname.endsWith('fonts.gstatic.com') || url.hostname.endsWith('fonts.googleapis.com');
  if (!isApp && !isStatic) return;
  const key = req.mode === 'navigate' ? '/app' : req;
  if (isApp) {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key).then(r => r || Response.error())));
  } else {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    })));
  }
});
