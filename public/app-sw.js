/* +1 — service worker aplikacji testowej (/app).
   Ekran aplikacji i wydarzenia: najpierw sieć, bez zasięgu ostatnia zapisana wersja.
   Zapisujemy tylko udane odpowiedzi — strona logowania (401/403) nigdy nie trafia do pamięci. */
const CACHE = 'plusone-app-v6';
const SHELL = ['/app', '/data/events.json', '/icon-512.png', '/apple-touch-icon.png', '/favicon.svg', '/vendor/fonts/fonts.css'];

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
  const isStatic = same ? /\.(png|svg|webmanifest|woff2)$/.test(url.pathname) || url.pathname === '/vendor/fonts/fonts.css' : url.hostname.endsWith('fonts.gstatic.com') || url.hostname.endsWith('fonts.googleapis.com');
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

/* ---------- powiadomienia push ----------
   Serwer wysyła pusty sygnał (worker/push.js); tu pobieramy najnowsze nieprzeczytane powiadomienie i je pokazujemy.
   iOS wymaga pokazania powiadomienia przy każdym sygnale — gdy pobranie się nie uda, pokazujemy ogólne. */
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let n = null;
    try {
      const r = await fetch('/api/notifications', { credentials: 'include', cache: 'no-store' });
      if (r.ok) n = ((await r.json()).notifications || []).find(x => !x.read_at) || null;
    } catch {}
    const title = n ? n.title : '+1';
    return self.registration.showNotification(title, {
      body: n ? n.body : 'Masz nowe powiadomienie w +1.',
      icon: '/icon-512.png', badge: '/favicon-32.png', tag: n ? 'plusone-' + n.id : 'plusone',
      data: { url: n && n.event_id ? '/app?ev=' + encodeURIComponent(n.event_id) : '/app?notif' }
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if (new URL(w.url).pathname.startsWith('/app')) { await w.focus(); w.postMessage({ type: 'open', url }); return; }
    return self.clients.openWindow(url);
  })());
});
