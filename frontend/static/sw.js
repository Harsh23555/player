const CACHE_NAME = 'nova-player-v1';
const ASSETS = [
    '/',
    '/static/icons/icon.png',
    'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (event) => {
    // Basic network-first strategy for dynamic content.
    // Offline content for static.
    if (event.request.url.includes('/api/')) {
        return fetch(event.request);
    }
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
