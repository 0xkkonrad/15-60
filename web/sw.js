/* Bump the final stamp whenever a deployed shell file changes. A new cache is
 * populated completely before activate removes the previous complete shell. */
const CACHE = 'clear60-shell-v1-20260805t';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'archive.js',
  'core.js',
  'topics.js',
  'storage.js',
  'notifications.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-maskable.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable.png',
  'apple-touch-icon.png',
  'fonts/dm-mono-400.woff2',
  'fonts/dm-mono-500.woff2',
  'fonts/LICENSES.md',
];

async function validAppPage(response) {
  if (!response?.ok) return false;
  const type = response.headers.get('content-type') || '';
  if (type && !type.includes('text/html')) return false;
  try {
    const html = await response.clone().text();
    return html.includes('id="today-view"') && html.includes('data-clear60-app');
  } catch { return false; }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('clear60-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (await validAppPage(fresh)) {
          const cache = await caches.open(CACHE);
          await cache.put('index.html', fresh.clone());
          return fresh;
        }
      } catch { /* offline */ }
      const cache = await caches.open(CACHE);
      return (await cache.match('index.html')) || (await cache.match('./'))
        || new Response('15:60 is unavailable offline until one complete visit has been cached.', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        });
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (request.destination === 'script' || request.destination === 'style') {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) {
          await cache.put(request, fresh.clone());
          return fresh;
        }
        return hit || fresh;
      } catch {
        if (hit) return hit;
        throw new Error(`No cached ${request.destination} is available offline.`);
      }
    }
    if (hit) return hit;
    return fetch(request);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = new URL(self.registration.scope);
    let target = scope.href;
    try {
      const proposed = new URL(event.notification.data?.url || '', scope);
      if (proposed.origin === scope.origin && proposed.pathname.startsWith(scope.pathname)) target = proposed.href;
    } catch { /* stay at scope root */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => {
      const url = new URL(client.url);
      return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
    });
    if (existing) {
      if ('navigate' in existing) await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
