// scripts/lib/openf1.js
//
// Accesso a OpenF1 condiviso tra build-telemetry.js (giro di pole in
// qualifica) e build-race-pace.js (giri di gara): distanziamento delle
// richieste per il rate limit del piano gratuito e mappa dei nomi dei circuiti.

const { fetchJson, sleep } = require('./http');

// Il piano gratuito di OpenF1 consente 3 richieste/secondo e 30 al minuto: con
// un backoff reattivo sui 429 (tentativi ravvicinati per pochi secondi) una
// rigenerazione di più circuiti falliva a raffica. Le richieste vengono
// invece distanziate in anticipo (una ogni 2,1 s, condiviso tra i worker),
// così il limite non scatta quasi mai.
const OPENF1_MIN_INTERVAL_MS = 2100;
let openf1NextSlot = 0;
async function openf1Json(url) {
    const now = Date.now();
    const wait = Math.max(0, openf1NextSlot - now);
    openf1NextSlot = Math.max(now, openf1NextSlot) + OPENF1_MIN_INTERVAL_MS;
    if (wait > 0) await sleep(wait);
    return fetchJson(url);
}

// circuit_short_name (OpenF1) -> nome circuito usato dal sito.
const CIRCUIT_MAP = {
    'Imola': 'Imola',
    'Melbourne': 'Melbourne (Australia)',
    'Shanghai': 'Shanghai (Cina)',
    'Suzuka': 'Suzuka',
    'Sakhir': 'Bahrain (Sakhir)',
    'Jeddah': 'Jeddah (Arabia Saudita)',
    'Miami': 'Miami',
    'Montreal': 'Montreal (Canada)',
    'Monte Carlo': 'Monaco',
    'Catalunya': 'Barcellona',
    'Spielberg': 'Red Bull Ring',
    'Silverstone': 'Silverstone',
    'Spa-Francorchamps': 'Spa-Francorchamps',
    'Hungaroring': 'Hungaroring',
    'Zandvoort': 'Zandvoort',
    'Monza': 'Monza',
    'Madring': 'Madrid',
    'Kuala Lumpur': 'Sepang (Malesia)', // OpenF1 chiama così il circuito di Sepang (round 16 del 2026)
    'Baku': 'Baku (Azerbaijan)',
    'Singapore': 'Singapore',
    'Austin': 'Austin (COTA)',
    'Mexico City': 'Città del Messico',
    'Interlagos': 'Interlagos (San Paolo)',
    'Las Vegas': 'Las Vegas',
    'Lusail': 'Qatar (Lusail)',
    'Yas Marina Circuit': 'Abu Dhabi (Yas Marina)',
};

// Nome del circuito usato dal sito -> nome file (es. "Baku (Azerbaijan)" ->
// "baku-azerbaijan"), per i file per-gara in pace/{anno}/.
function circuitSlug(circuitName) {
    return circuitName.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

module.exports = { openf1Json, CIRCUIT_MAP, circuitSlug };
