// scripts/update-forecast.js
//
// Meteo previsto per il Prossimo GP: probabilità di pioggia, cielo e
// temperatura di qualifiche e gara (e delle sessioni sprint, nei weekend
// sprint), dalle previsioni orarie di Open-Meteo (gratuito, nessuna
// chiave). Scrive forecast.json, che il sito mostra prima del giorno di
// ogni sessione, nel widget "Prossimo GP" e nel pannello Calendario (es.
// "🌧️ 80% · 26°").
//
// Gira ogni 3 ore (vedi .github/workflows/update-forecast.yml), ma funziona
// anche a mano:
//   node scripts/update-forecast.js
//   node scripts/update-forecast.js --now 2026-11-07T20:00:00Z   (prova: "adesso" a scelta)
//
// Previsioni dal martedì prima dell'inizio del weekend (scelta
// dell'utente), dalla mezzanotte italiana, fino alla fine della gara; fuori
// da questa finestra il file resta senza sessioni e il sito non mostra
// niente.

const fs = require('fs');
const path = require('path');
const { CIRCUIT_INFO } = require('./lib/weather');
const { fetchJson } = require('./lib/http');

const ROOT = path.join(__dirname, '..');
const CALENDAR_PATH = path.join(ROOT, 'calendar.json');
const FORECAST_PATH = path.join(ROOT, 'forecast.json');

// Sessioni con il meteo previsto e loro durata stimata in minuti (gli stessi
// valori di SESSION_DURATION_MIN in index.html, che decide quando una
// sessione è finita).
const SESSIONS = { sprintQualy: 60, sprintRace: 45, qualy: 60, race: 130 };
// Senza cambiamenti il file si riscrive comunque dopo 12 ore, così updatedAt
// dice quando le previsioni sono state ricontrollate: il sito le nasconde se
// sono più vecchie di 24 ore (automazione ferma).
const REFRESH_HOURS = 12;

const HOUR = 3600000;

// Codici meteo WMO di Open-Meteo: icona di giorno, icona di notte, descrizione.
function describeSky(code, isDay) {
    const pick = (day, night, label) => ({ icon: isDay === 0 ? night : day, sky: label });
    if (code == null) return { icon: null, sky: null };
    if (code === 0) return pick('☀️', '🌙', 'Sereno');
    if (code === 1) return pick('🌤️', '🌙', 'Poco nuvoloso');
    if (code === 2) return pick('⛅', '☁️', 'Parzialmente nuvoloso');
    if (code === 3) return pick('☁️', '☁️', 'Coperto');
    if (code === 45 || code === 48) return pick('🌫️', '🌫️', 'Nebbia');
    if (code >= 51 && code <= 57) return pick('🌧️', '🌧️', 'Pioviggine');
    if (code === 65 || code === 67) return pick('🌧️', '🌧️', 'Pioggia forte');
    if (code >= 61 && code <= 67) return pick('🌧️', '🌧️', 'Pioggia');
    if (code === 82) return pick('🌧️', '🌧️', 'Rovesci forti');
    if (code >= 80 && code <= 82) return pick('🌦️', '🌧️', 'Rovesci');
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return pick('🌨️', '🌨️', 'Neve');
    if (code >= 95) return pick('⛈️', '⛈️', 'Temporale');
    return { icon: null, sky: null };
}

// Sessioni con orario di una gara: { key, start, end } (Date UTC).
function sessionTimes(race) {
    return Object.entries(SESSIONS).map(([key, minutes]) => {
        const s = race.schedule && race.schedule[key];
        if (!s || !s.date || !s.time) return null;
        const start = new Date(`${s.date}T${s.time}`);
        if (isNaN(start)) return null;
        return { key, start, end: new Date(start.getTime() + minutes * 60000) };
    }).filter(Boolean);
}

// Mezzanotte italiana di un giorno "AAAA-MM-GG" (alle 00:00 UTC in Italia
// è l'1 d'inverno, le 2 d'estate).
function romeMidnight(day) {
    const utcMidnight = new Date(`${day}T00:00:00Z`);
    const romeHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(utcMidnight));
    return new Date(utcMidnight.getTime() - romeHour * HOUR);
}

// Da quando mostrare le previsioni di un GP: martedì alle 00:00 (ora
// italiana) della settimana in cui inizia il weekend, cioè il martedì prima
// della prima sessione (prove libere 1), nel giorno italiano in cui il sito
// la mostra. Weekend dal venerdì: 3 giorni prima; dal giovedì (es. Jeddah
// 2024): 2. null se il calendario non ha orari.
function forecastFrom(race) {
    const starts = Object.values(race.schedule || {})
        .filter(s => s && s.date && s.time)
        .map(s => new Date(`${s.date}T${s.time}`).getTime())
        .filter(ms => !isNaN(ms));
    if (!starts.length) return null;
    const firstDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date(Math.min(...starts)));
    const d = new Date(`${firstDay}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() - 2 + 7) % 7);
    return romeMidnight(d.toISOString().slice(0, 10));
}

// Ora intera UTC come nelle previsioni orarie di Open-Meteo con
// timezone=UTC, es. "2026-11-07T18:00".
const hourKey = ms => new Date(ms).toISOString().slice(0, 13) + ':00';
const floorHour = ms => Math.floor(ms / HOUR) * HOUR;

// Ore da guardare per una sessione. Pioggia e codice meteo di Open-Meteo
// si riferiscono all'ora PRECEDENTE (il valore delle 19:00 è la pioggia
// tra le 18 e le 19): servono le ore dalla prima dopo l'inizio a quella
// della fine. Temperatura all'inizio, giorno/notte a metà sessione (le
// gare al tramonto, come Abu Dhabi, si corrono per lo più col buio).
function sessionHours({ start, end }) {
    const rain = [];
    for (let h = floorHour(start.getTime()) + HOUR; h < end.getTime() + HOUR; h += HOUR) rain.push(h);
    const nearest = ms => Math.round(ms / HOUR) * HOUR;
    return { rain, temp: nearest(start.getTime()), day: nearest((start.getTime() + end.getTime()) / 2) };
}

async function fetchForecast(info, hours) {
    const day = ms => new Date(ms).toISOString().slice(0, 10);
    const all = hours.flatMap(h => [...h.rain, h.temp, h.day]);
    const url = 'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${info.lat}&longitude=${info.lon}` +
        '&hourly=precipitation_probability,temperature_2m,weather_code,is_day&timezone=UTC' +
        `&start_date=${day(Math.min(...all))}&end_date=${day(Math.max(...all))}`;
    const j = await fetchJson(url, { retries: 3 });
    const index = new Map((j.hourly?.time || []).map((t, i) => [t, i]));
    return (field, ms) => {
        const v = j.hourly?.[field]?.[index.get(hourKey(ms))];
        return typeof v === 'number' ? v : null;
    };
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function parseNow() {
    const i = process.argv.indexOf('--now');
    if (i === -1) return new Date();
    const d = new Date(process.argv[i + 1]);
    if (isNaN(d)) throw new Error(`--now non valido: ${process.argv[i + 1]}`);
    return d;
}

async function main() {
    const now = parseNow();
    const calendar = readJson(CALENDAR_PATH);
    if (!calendar || !Array.isArray(calendar.races)) throw new Error('calendar.json mancante o non valido.');

    // Il primo GP con una sessione non ancora finita, dal martedì della sua
    // settimana: è quello del widget "Prossimo GP" (il sito controlla
    // comunque che il round coincida).
    let content = { season: calendar.season, round: null, circuit: null, sessions: {} };
    for (const race of calendar.races) {
        const times = sessionTimes(race);
        if (!times.length || times.every(t => t.end <= now)) continue;
        const from = forecastFrom(race);
        if (now < from) {
            const when = from.toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
            console.log(`${race.round}. ${race.circuit}: previsioni da ${when}, ancora niente.`);
            break;
        }
        const info = CIRCUIT_INFO[race.circuit];
        if (!info) throw new Error(`Coordinate mancanti per "${race.circuit}" (scripts/lib/weather.js / auto-circuits.json).`);

        const upcoming = times.filter(t => t.end > now);
        const hours = upcoming.map(sessionHours);
        const value = await fetchForecast(info, hours);
        const sessions = {};
        upcoming.forEach((t, i) => {
            const h = hours[i];
            const probs = h.rain.map(ms => value('precipitation_probability', ms)).filter(v => v !== null);
            const codes = h.rain.map(ms => value('weather_code', ms)).filter(v => v !== null);
            const temp = value('temperature_2m', h.temp);
            const { icon, sky } = describeSky(codes.length ? Math.max(...codes) : null, value('is_day', h.day));
            // Pioggia arrotondata al 10% e temperatura al grado: più
            // precisione sarebbe solo apparente (e cambierebbe a ogni giro).
            sessions[t.key] = {
                rain: probs.length ? Math.round(Math.max(...probs) / 10) * 10 : null,
                temp: temp === null ? null : Math.round(temp),
                icon,
                sky,
            };
        });
        content = { season: calendar.season, round: race.round, circuit: race.circuit, sessions };
        break;
    }

    const existing = readJson(FORECAST_PATH);
    const same = existing && JSON.stringify({ season: existing.season, round: existing.round, circuit: existing.circuit, sessions: existing.sessions }) === JSON.stringify(content);
    const ageHours = existing && existing.updatedAt ? (now - new Date(existing.updatedAt)) / HOUR : Infinity;
    const hasSessions = Object.keys(content.sessions).length > 0;
    if (same && (!hasSessions || ageHours < REFRESH_HOURS)) {
        console.log('Nessuna modifica: forecast.json era già aggiornato.');
        return;
    }

    fs.writeFileSync(FORECAST_PATH, JSON.stringify({ source: 'Open-Meteo', updatedAt: now.toISOString(), ...content }, null, 2) + '\n', 'utf-8');
    if (!hasSessions) {
        console.log('✅ forecast.json aggiornato: nessun GP nei prossimi giorni.');
        return;
    }
    console.log(`✅ forecast.json aggiornato: ${content.round}. ${content.circuit}`);
    for (const [key, s] of Object.entries(content.sessions)) {
        console.log(`  - ${key}: ${s.icon || '?'} ${s.sky || '-'}, pioggia ${s.rain ?? '-'}%, ${s.temp ?? '-'}°C`);
    }
}

main().catch(err => {
    console.error('❌ Errore durante l\'aggiornamento del meteo previsto:', err.message);
    process.exit(1);
});
