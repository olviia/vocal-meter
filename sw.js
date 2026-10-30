// Offline support: always try the network first (so updates show up immediately and files
// never mix versions); fall back to the cached copy when offline.
const VERSION = 'vm-6';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/main.js', 'js/ui.js', 'js/state.js', 'js/store.js', 'js/dsp.js', 'js/calibration.js',
  'js/engine.js', 'js/capture-worklet.js', 'js/qr.js', 'js/link.js', 'js/sync.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});
