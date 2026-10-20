const CACHE_VERSION = 'colete-shell-v2';
const STATIC_DESTINATIONS = new Set(['font', 'image', 'script', 'style']);
const SENSITIVE_PATH_PARTS = [
  '/auth/',
  '/rest/',
  '/storage/',
  '/functions/',
  '/proof',
  '/pix',
  '/payment',
];

const isCacheablePublicAsset = (request) => {
  if (request.method !== 'GET' || !STATIC_DESTINATIONS.has(request.destination)) return false;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (request.headers.has('authorization') || request.headers.has('cookie')) return false;

  return !SENSITIVE_PATH_PARTS.some((part) => url.pathname.toLowerCase().includes(part));
};

self.addEventListener('install', () => {
  // Deliberately no precache: a first install cannot pin stale HTML or authenticated state.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheablePublicAsset(request)) return;

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    }),
  );
});
