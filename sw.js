// sw.js - service worker: installazione come web app (icona sulla
// schermata Home), notifiche push e apertura senza connessione.
//
// File del sito: "network-first", mai "cache-first". La freschezza di
// data.json/calendar.json/telemetry.json/ecc. è fondamentale (la pagina li
// chiede con cache:'no-cache'), quindi la copia salvata si usa solo quando la
// rete non risponde (offline), mai come prima scelta mentre si è online.
//
// Librerie dal CDN (Tailwind, Chart.js): "cache-first", hanno la versione
// nell'indirizzo e non cambiano mai. Fino al 2026-11-05 non venivano salvate
// qui (si contava sulla cache del browser): sull'iPhone, offline, la web app
// si apriva senza Chart.js e senza nessun dato, perché il grafico andava in
// errore prima dei box dei tempi.

const CACHE_NAME = 'f1-pole-tracker-v1';
const CORE_ASSETS = ['./', './index.html', './manifest.json'];
// Stessi indirizzi dei tag <script> di index.html (versione e hash si
// cambiano lì). Una versione diversa viene comunque salvata alla prima
// apertura con la rete.
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3',
    'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js',
];
// Dati che servono all'apertura: salvati già all'installazione, così il sito
// si apre offline anche se dopo non è stato riaperto con la rete.
const DATA_ASSETS = ['./data.json', './calendar.json', './standings.json', './telemetry.json', './news.json', './history/index.json', './changelog.json'];

const isCdn = url => url.startsWith('https://cdn.jsdelivr.net/');

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.all([
        cache.addAll(CORE_ASSETS),
        // Uno per uno, senza bloccare l'installazione se un file non arriva:
        // si salva alla prima apertura con la rete.
        ...[...CDN_ASSETS, ...DATA_ASSETS].map(url => cache.add(url).catch(() => {})),
    ])));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
        // Versioni vecchie delle librerie (cambiate in index.html): non servono più.
        const cache = await caches.open(CACHE_NAME);
        for (const req of await cache.keys()) if (isCdn(req.url) && !CDN_ASSETS.includes(req.url)) await cache.delete(req);
    })());
    self.clients.claim();
});

// Salva la copia senza ritardare la risposta. waitUntil tiene attivo il
// service worker finché la copia non è salvata; un suo eventuale errore (dopo
// un await alcuni browser lo rifiutano) non deve trasformare una risposta
// arrivata dalla rete in una risposta "offline".
function saveCopy(event, key, response) {
    // Solo le risposte complete (200): i 404/errori verrebbero serviti offline
    // al posto del file vero, e le risposte parziali (206) la cache le rifiuta.
    if (response.status !== 200) return;
    const copy = response.clone();
    const saving = caches.open(CACHE_NAME).then(cache => cache.put(key, copy)).catch(() => {});
    try { event.waitUntil(saving); } catch (err) { /* il salvataggio prosegue comunque */ }
}

async function networkFirst(event, key) {
    let response;
    try {
        response = await fetch(event.request);
    } catch (err) {
        // Offline: la copia salvata, oppure un normale errore di rete se il
        // file non è mai stato scaricato.
        return (await caches.match(key)) || Response.error();
    }
    saveCopy(event, key, response);
    return response;
}

async function cacheFirst(event) {
    const cached = await caches.match(event.request.url);
    if (cached) return cached;
    // Mai salvata: dalla rete (offline è un normale errore di rete).
    const response = await fetch(event.request);
    saveCopy(event, event.request.url, response);
    return response;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    if (isCdn(request.url)) { event.respondWith(cacheFirst(event)); return; }
    // Altre risorse esterne (es. immagini delle notizie): gestite dal browser.
    if (new URL(request.url).origin !== self.location.origin) return;
    // Il parametro di query (?t=..., ?v=...) è ignorato nella chiave, così lo
    // stesso file non si accumula in decine di copie.
    event.respondWith(networkFirst(event, request.url.split('?')[0]));
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
