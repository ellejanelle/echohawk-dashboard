// Cache only static resident resources. Call/session/receipt APIs are always network-only.
const CACHE = 'echohawk-resident-v4';
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const assets = await fetch('/app/precache.json').then(r => r.json());
  await cache.addAll(['/app/', '/app/manifest.webmanifest', '/app/icon.svg', '/app/media/bleeding-pressure-prototype.png', '/kits', '/vendor/ggwave.js', ...assets]);
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('echohawk-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;
  if (!url.pathname.startsWith('/assets/') && !url.pathname.startsWith('/app/') && url.pathname !== '/kits' && url.pathname !== '/vendor/ggwave.js') return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(c => c.put(event.request, copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? caches.match('/app/') : Response.error())));
});
