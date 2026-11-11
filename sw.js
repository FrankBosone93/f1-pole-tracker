// sw.js - service worker: installazione come web app (icona sulla
// schermata Home), notifiche push e apertura senza connessione.
//
// File del sito: "network-first", mai "cache-first". La freschezza di
// data.json/calendar.json/telemetry.json/ecc. è fondamentale (la pagina li
// chiede con cache:'no-cache'), quindi la copia salvata si usa solo quando la
// rete non risponde (offline), mai come prima scelta mentre si è online.
//
// Librerie dal CDN (Chart.js): "cache-first", hanno la versione
// nell'indirizzo e non cambiano mai. Fino al 2026-11-05 non venivano salvate
// qui (si contava sulla cache del browser): sull'iPhone, offline, la web app
// si apriva senza Chart.js e senza nessun dato, perché il grafico andava in
// errore prima dei box dei tempi. Tailwind non arriva più dal CDN: la grafica
// è styles.css, un file del sito (scripts/build-css.js).

const CACHE_NAME = 'f1-pole-tracker-v1';
const CORE_ASSETS = ['./', './index.html', './styles.css', './manifest.json'];
// Stessi indirizzi dei tag <script> di index.html (versione e hash si
// cambiano lì). Una versione diversa viene comunque salvata alla prima
// apertura con la rete.
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js',
];
// Dati che servono all'apertura: salvati già all'installazione, così il sito
// si apre offline anche se dopo non è stato riaperto con la rete.
const DATA_ASSETS = ['./data.json', './calendar.json', './standings.json', './telemetry.json', './news.json', './forecast.json', './history/index.json', './changelog.json'];

const isCdn = url => url.startsWith('https://cdn.jsdelivr.net/');

// File del sito sempre dalla rete, mai dalla cache del browser (GitHub Pages
// la tiene valida 10 minuti): appena pubblicato, un service worker nuovo
// potrebbe altrimenti salvare la pagina vecchia insieme ai file nuovi.
const fresh = url => new Request(url, { cache: 'reload' });

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.all([
        // Pagina e grafica insieme o niente: se uno manca l'installazione
        // fallisce e resta il service worker precedente con i suoi file.
        cache.addAll(CORE_ASSETS.map(fresh)),
        // Uno per uno, senza bloccare l'installazione se un file non arriva:
        // si salva alla prima apertura con la rete.
        ...CDN_ASSETS.map(url => cache.add(url).catch(() => {})),
        ...DATA_ASSETS.map(url => cache.add(fresh(url)).catch(() => {})),
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

// Tocco sulla notifica: apre la web app sull'indirizzo indicato. Se è già
// aperta la porta in primo piano su quell'indirizzo, con in più n=<istante
// del tocco> (dal 2026-11-10). Così la pagina capisce che arriva da una
// notifica e, se è aperta da tempo, si ricarica invece di mostrare i dati che
// ha in memoria (statistiche, pole e novità caricate ore prima: toccando la
// notifica del GP si rivedeva il racconto vecchio); e l'indirizzo è sempre
// diverso da quello di prima, altrimenti con la stessa vista già aperta non
// succedeva nulla. Vedi l'ascolto di hashchange in index.html. I link delle
// Novità (#novita) restano senza n: una pagina non ancora aggiornata non li
// riconoscerebbe più.
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = new URL(event.notification.data && event.notification.data.url || './', self.registration.scope).href;
    const hash = new URL(url).hash;
    const marked = hash.includes('=') && !hash.startsWith('#novita') ? `${url}&n=${Date.now()}` : url;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const open = list.find(c => c.url.startsWith(self.registration.scope));
        if (!open) return self.clients.openWindow(url);
        // Browser senza navigate (o pagina non controllata da questo service
        // worker): l'indirizzo arriva alla pagina con un messaggio.
        const viaMessage = () => { open.postMessage({ type: 'notification-open', url: marked }); return open; };
        const shown = typeof open.navigate === 'function'
            ? open.navigate(marked).then(c => c || open, viaMessage)
            : Promise.resolve(viaMessage());
        return shown.then(c => c.focus());
    }));
});
