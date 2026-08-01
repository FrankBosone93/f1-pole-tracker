// sw.js - service worker minimo, solo per abilitare l'installazione come
// PWA (icona a schermo intero su home screen) e una resilienza di base
// offline. Strategia "network-first" per TUTTO, mai "cache-first": la
// freschezza di data.json/calendar.json/telemetry.json/ecc. è fondamentale
// per questo sito (già scaricati altrove con cache:'no-store'), quindi la
// cache scatta solo come ripiego quando la rete non risponde (offline), mai
// come prima scelta mentre si è online - niente rischio di mostrare dati
// vecchi mentre si è connessi.

const CACHE_NAME = 'f1-pole-tracker-v1';
const CORE_ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        fetch(event.request)
            .then(response => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
