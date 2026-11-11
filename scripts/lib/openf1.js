// scripts/lib/openf1.js
//
// Accesso a OpenF1 condiviso tra build-telemetry.js (giro di pole in
// qualifica) e build-race-pace.js (giri di gara): distanziamento delle
// richieste per il rate limit del piano gratuito e mappa dei nomi dei circuiti.

const fs = require('fs');
const path = require('path');
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

// Elenchi della stagione (meetings e sessions), chiesti da quasi tutti gli
// script: una sola richiesta per run, e le liste filtrate (solo gare, solo
// qualifiche) si ricavano da quella completa invece di chiederle a parte.
// Fino al 2026-11-11 un giro di update-calendar.yml (sei script di seguito)
// scaricava meetings?year 6 volte e le sessioni 6 volte. Con
// OPENF1_CACHE_DIR (impostata nei workflow che lanciano più script nello
// stesso job) la lista si salva anche su file e si riusa per 15 minuti dagli
// script successivi. Un errore non si salva: il prossimo tentativo richiede
// di nuovo. Ogni chiamata riceve una copia, così chi la modifica non tocca
// quella degli altri.
const SEASON_LIST_MAX_AGE_MS = 15 * 60 * 1000;
const seasonLists = new Map();
async function loadSeasonList(kind, year) {
    const dir = process.env.OPENF1_CACHE_DIR;
    const file = dir ? path.join(dir, `openf1-${kind}-${year}.json`) : null;
    if (file) {
        try {
            if (Date.now() - fs.statSync(file).mtimeMs < SEASON_LIST_MAX_AGE_MS) return JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (err) { /* file assente o illeggibile: si scarica */ }
    }
    const data = await openf1Json(`https://api.openf1.org/v1/${kind}?year=${year}`);
    if (file && Array.isArray(data)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
        } catch (err) { /* la cache su file è solo un risparmio */ }
    }
    return data;
}
async function openf1SeasonList(kind, year) {
    const key = `${kind}-${year}`;
    if (!seasonLists.has(key)) {
        const pending = loadSeasonList(kind, year);
        seasonLists.set(key, pending);
        pending.catch(() => seasonLists.delete(key));
    }
    return structuredClone(await seasonLists.get(key));
}
const openf1Meetings = year => openf1SeasonList('meetings', year);
const openf1Sessions = year => openf1SeasonList('sessions', year);

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
    // Circuiti del calendario 2027 che il sito ha già con le pole del 2021
    // (OpenF1 non ha dati prima del 2023, quindi mancavano da questa tabella):
    // senza queste righe, finché Jolpica non pubblica il calendario 2027, a
    // gennaio venivano "imparati" come circuiti nuovi con un altro nome
    // ("Portimão", "Istanbul") e la loro storia si divideva in due.
    'Algarve International Circuit': 'Portimão (Portogallo)',
    'Istanbul': 'Istanbul (Turchia)',
};

// Circuiti nuovi riconosciuti in automatico (lib/auto-circuits.js), solo se
// non già presenti sopra.
for (const [shortName, name] of Object.entries(require('./auto-circuits').loadAutoCircuits().openf1)) {
    if (!(shortName in CIRCUIT_MAP)) CIRCUIT_MAP[shortName] = name;
}

// Nome del circuito usato dal sito -> nome file (es. "Baku (Azerbaijan)" ->
// "baku-azerbaijan"), per i file per-gara in pace/{anno}/.
function circuitSlug(circuitName) {
    return circuitName.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

module.exports = { openf1Json, openf1Meetings, openf1Sessions, CIRCUIT_MAP, circuitSlug };
