// Keeps a copy of the page so it opens on slow or no internet.
// Data requests (/api) are never touched: they always go to the network.
const CACHE = 'dg-page-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add('/')).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname === '/api' || url.search) return;
  if (req.mode !== 'navigate' && url.pathname !== '/' && url.pathname !== '/index.html') return;
  // network first; after 4 seconds without an answer, show the saved copy
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then(r => { if (r.ok) cache.put('/', r.clone()); return r; });
    const slow = new Promise(res => setTimeout(res, 4000)).then(() => cache.match('/'));
    try {
      const first = await Promise.race([net, slow]);
      return first || await net;
    } catch (err) {
      return (await cache.match('/')) || Response.error();
    }
  })());
});
