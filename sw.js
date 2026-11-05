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

    // Il parametro di query (?t=..., ?v=...) è ignorato nella chiave, così lo
    // stesso file non si accumula in decine di copie.
    const key = request.url.split('?')[0];
    event.respondWith((async () => {
        try {
            const response = await fetch(request);
            // Si conserva solo una copia delle risposte complete (200): i
            // 404/errori verrebbero serviti offline al posto della pagina
            // vera, e le risposte parziali (206) la cache le rifiuta.
            if (response.status === 200) {
                const copy = response.clone();
                // waitUntil: il service worker resta attivo finché la copia
                // non è salvata (il browser può fermarlo appena risposto).
                event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(key, copy)).catch(() => {}));
            }
            return response;
        } catch (err) {
            // Offline: la copia salvata, oppure un normale errore di rete se
            // il file non è mai stato scaricato (prima respondWith riceveva
            // undefined e falliva con un'eccezione).
            return (await caches.match(key)) || Response.error();
        }
    })());
});

// --- Notifiche push (web app sulla schermata Home) ---------------------
// Inviate dall'automazione del lunedì (scripts/notify-gp.js, lib/webpush.js)
// come JSON { title, body, url }. iOS richiede che ogni push mostri una
// notifica, quindi anche un messaggio illeggibile ne mostra una generica.
self.addEventListener('push', event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
    event.waitUntil(self.registration.showNotification(data.title || 'F1 Pole Tracker', {
        body: data.body || '',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        data: { url: data.url || './' },
    }));
});

// Tocco sulla notifica: apre la web app sul GP indicato (o la porta in
// primo piano se è già aperta).
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = new URL(event.notification.data && event.notification.data.url || './', self.registration.scope).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const open = list.find(c => c.url.startsWith(self.registration.scope));
        if (open && typeof open.navigate === 'function') return open.navigate(url).then(c => (c || open).focus()).catch(() => open.focus());
        if (open) return open.focus();
        return self.clients.openWindow(url);
    }));
});
