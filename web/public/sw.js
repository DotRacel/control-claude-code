/* Claude Remote shell worker. Never intercepts /v1 or /ws. */
// Bump on every deploy that must not be served from an old cache.
// v10 covers two unreleased changes that both needed it, which is why there is no v11: the QR
// deep-link work, and manifest.webmanifest changing language (zh → en). The manifest is the one
// that could not have gone without a bump — it is precached AND served cache-first below, unlike
// index.html which is network-first and self-heals, so an installed app would otherwise have kept
// the old one forever.
const CACHE = 'ccc-web-v10';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  // Self-hosted webfonts: precached so an offline launch still gets the real type.
  // Both are variable fonts — one file per subset covers weight 400 and 600.
  './fonts/source-serif-4-latin.woff2',
  './fonts/source-serif-4-latin-ext.woff2',
  './fonts/jetbrains-mono-latin.woff2',
  './fonts/jetbrains-mono-latin-ext.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/claude-symbol.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isPassthrough(url) {
  return url.pathname.startsWith('/v1') || url.pathname.startsWith('/ws');
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) { await c.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow('./');
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isPassthrough(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
