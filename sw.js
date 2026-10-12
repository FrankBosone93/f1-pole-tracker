// sw.js - service worker minimo, solo per abilitare l'installazione come
// PWA (icona a schermo intero su home screen) e una resilienza di base
// offline. Strategia "network-first" per TUTTO, mai "cache-first": la
// freschezza di data.json/calendar.json/telemetry.json/ecc. è fondamentale
// per questo sito (già scaricati altrove con cache:'no-cache', cioè sempre rivalidati), quindi la
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
    const { request } = event;
    if (request.method !== 'GET') return;
    // Solo risorse dello stesso sito: le librerie da CDN (Tailwind, Chart.js)
    // hanno già la cache HTTP del browser, e metterle qui raddoppierebbe
    // soltanto lo spazio occupato.
    if (new URL(request.url).origin !== self.location.origin) return;

    event.respondWith(
        fetch(request)
            .then(response => {
                // Si conserva solo una copia di risposte valide (200): prima
                // finivano in cache anche i 404/errori, e poi venivano
                // serviti offline al posto della pagina vera. Il parametro
                // di query (?t=..., ?v=...) è ignorato nella chiave, così lo
                // stesso file non si accumula in decine di copie.
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request.url.split('?')[0], copy));
                }
                return response;
            })
            .catch(() => caches.match(request.url.split('?')[0]))
    );
});
