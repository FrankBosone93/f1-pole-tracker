// scripts/lib/season-calendar.js
//
// Calendario di una stagione nel formato usato dagli script: gare in ordine,
// con round, circuito (nome del sito), data e orari di ogni sessione (UTC).
//
//   - fonte principale OpenF1 (meetings + sessions): stessa fonte di tutti gli
//     altri dati del weekend, orari ufficiali dal live timing F1. Test
//     invernali e gare annullate esclusi; il round è la posizione in ordine di
//     data (verificato identico a quello ufficiale su tutto il 2026);
//   - ripiego Jolpica, quando OpenF1 non risponde (bloccata durante le
//     sessioni live) e per le stagioni prima del 2023.
//
// Prima la fonte era f1api.dev (/api/current), eliminata il 2026-10-26: orari
// sbagliati, risultati pubblicati con giorni di ritardo, round rinumerati.
//
// Circuiti nuovi: con { learn: true } un circuito che non è nelle tabelle
// (openf1.js, f1-mapping.js, weather.js) viene riconosciuto e salvato in
// auto-circuits.json: nome del sito = città, coordinate del circuito da
// Jolpica, fuso orario da Open-Meteo. Vedi lib/auto-circuits.js.

const { openf1Json, CIRCUIT_MAP } = require('./openf1');
const { CIRCUIT_ID_MAP, matchCircuitById } = require('./f1-mapping');
const { CIRCUIT_INFO } = require('./weather');
const { jolpicaRaces } = require('./jolpica');
const { fetchJson } = require('./http');
const { loadAutoCircuits, saveAutoCircuits } = require('./auto-circuits');

const OPENF1_SESSION_KEYS = {
    'Practice 1': 'fp1', 'Practice 2': 'fp2', 'Practice 3': 'fp3',
    'Sprint Qualifying': 'sprintQualy', 'Sprint': 'sprintRace',
    'Qualifying': 'qualy', 'Race': 'race',
};
const JOLPICA_SESSION_KEYS = {
    FirstPractice: 'fp1', SecondPractice: 'fp2', ThirdPractice: 'fp3',
    SprintQualifying: 'sprintQualy', Sprint: 'sprintRace', Qualifying: 'qualy',
};
const emptySchedule = () => ({ fp1: null, fp2: null, fp3: null, sprintQualy: null, sprintRace: null, qualy: null, race: null });
const isoParts = d => { const iso = new Date(d).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 19) + 'Z' }; };
const DAY_MS = 86400000;

// Stagione "in corso": l'anno attuale se ha già un calendario, altrimenti
// quello prima (a gennaio, finché il nuovo calendario non è pubblicato).
async function currentSeason() {
    const year = new Date().getUTCFullYear();
    try {
        const meetings = await openf1Json(`https://api.openf1.org/v1/meetings?year=${year}`);
        if (meetings.some(m => !/testing/i.test(m.meeting_name))) return year;
        return year - 1;
    } catch (err) {
        const races = await jolpicaRaces(`${year}`).catch(() => []);
        return races.length ? year : year - 1;
    }
}

async function fromOpenF1(year, learner) {
    const meetings = await openf1Json(`https://api.openf1.org/v1/meetings?year=${year}`);
    const sessions = await openf1Json(`https://api.openf1.org/v1/sessions?year=${year}`);
    const real = meetings
        .filter(m => !/testing/i.test(m.meeting_name) && !m.is_cancelled)
        .sort((a, b) => a.date_start.localeCompare(b.date_start));
    if (!real.length) return null;
    const races = [];
    for (const [i, m] of real.entries()) {
        let circuit = CIRCUIT_MAP[m.circuit_short_name];
        if (!circuit && learner) circuit = await learner.fromOpenF1(m, sessions);
        const schedule = emptySchedule();
        for (const s of sessions.filter(s => s.meeting_key === m.meeting_key)) {
            const key = OPENF1_SESSION_KEYS[s.session_name];
            if (key) schedule[key] = isoParts(s.date_start);
        }
        races.push({ round: i + 1, circuit: circuit || m.circuit_short_name, raceName: m.meeting_name, date: schedule.race?.date || m.date_start.slice(0, 10), schedule });
    }
    return races;
}

async function fromJolpica(year, learner) {
    const list = await jolpicaRaces(`${year}`);
    if (!list.length) return null;
    const races = [];
    for (const r of list) {
        let circuit = matchCircuitById(r.Circuit?.circuitId);
        if (!circuit && learner) circuit = await learner.fromJolpica(r);
        const schedule = emptySchedule();
        for (const [k, key] of Object.entries(JOLPICA_SESSION_KEYS)) {
            if (r[k]?.date) schedule[key] = { date: r[k].date, time: r[k].time || null };
        }
        schedule.race = { date: r.date, time: r.time || null };
        races.push({ round: Number(r.round), circuit: circuit || r.Circuit?.circuitName, raceName: r.raceName, date: r.date, schedule });
    }
    return races;
}

// Riconoscimento dei circuiti nuovi (vedi intestazione).
function makeLearner(year) {
    const auto = loadAutoCircuits();
    const before = JSON.stringify(auto);
    const today = new Date().toISOString().slice(0, 10);
    let jolpicaList = null;
    const usedNames = new Set([...Object.values(CIRCUIT_MAP), ...Object.values(CIRCUIT_ID_MAP)]);
    const jolpicaSeason = async () => (jolpicaList = jolpicaList || await jolpicaRaces(`${year}`).catch(() => []));

    async function weatherFor(name, loc, raceUtc) {
        if (CIRCUIT_INFO[name] || !loc?.lat) return;
        const lat = Number(loc.lat), lon = Number(loc.long);
        try {
            const tz = (await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1`))?.timezone;
            if (!tz) return;
            const localHour = raceUtc ? Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(raceUtc))) : 12;
            const info = { lat, lon, tz, night: localHour >= 18 };
            auto.weather[name] = info;
            CIRCUIT_INFO[name] = info;
            console.log(`🆕 Meteo di "${name}": ${lat}, ${lon}, ${tz}${info.night ? ', notturno' : ''}`);
        } catch (err) {
            console.warn(`⚠️  ${name}: fuso orario per il meteo non disponibile (${err.message}).`);
        }
    }
    function register(name, { openf1, jolpicaId }) {
        if (openf1 && !CIRCUIT_MAP[openf1]) { auto.openf1[openf1] = name; CIRCUIT_MAP[openf1] = name; }
        if (jolpicaId && !CIRCUIT_ID_MAP[jolpicaId]) { auto.jolpica[jolpicaId] = name; CIRCUIT_ID_MAP[jolpicaId] = name; }
        if (!auto.added[name]) auto.added[name] = today;
        usedNames.add(name);
    }
    const sameDay = (a, b) => a && b && Math.abs(new Date(a) - new Date(b)) <= 2 * DAY_MS;

    return {
        // Circuito OpenF1 sconosciuto: si cerca la stessa gara (stessa data)
        // su Jolpica per id, città e coordinate; nome del sito = città.
        async fromOpenF1(meeting, sessions) {
            const race = sessions.find(s => s.meeting_key === meeting.meeting_key && s.session_name === 'Race');
            const raceDate = (race?.date_start || meeting.date_start).slice(0, 10);
            const j = (await jolpicaSeason()).find(r => sameDay(r.date, raceDate));
            const jolpicaId = j?.Circuit?.circuitId;
            let name = (jolpicaId && CIRCUIT_ID_MAP[jolpicaId]) || j?.Circuit?.Location?.locality || meeting.location || meeting.circuit_short_name;
            if (usedNames.has(name) && !(jolpicaId && CIRCUIT_ID_MAP[jolpicaId] === name)) name = `${name} (${meeting.circuit_short_name})`;
            register(name, { openf1: meeting.circuit_short_name, jolpicaId });
            console.log(`🆕 Circuito nuovo riconosciuto in automatico: OpenF1 "${meeting.circuit_short_name}"${jolpicaId ? `, Jolpica "${jolpicaId}"` : ''} -> "${name}"`);
            await weatherFor(name, j?.Circuit?.Location, race?.date_start);
            return name;
        },
        // Circuito Jolpica sconosciuto (ripiego): nome = città.
        async fromJolpica(r) {
            let name = r.Circuit?.Location?.locality || r.Circuit?.circuitName;
            if (!name) return null;
            if (usedNames.has(name)) name = `${name} (${r.Circuit.circuitId})`;
            register(name, { jolpicaId: r.Circuit.circuitId });
            console.log(`🆕 Circuito nuovo riconosciuto in automatico: Jolpica "${r.Circuit.circuitId}" -> "${name}"`);
            await weatherFor(name, r.Circuit.Location, r.time ? `${r.date}T${r.time}` : null);
            return name;
        },
        save() { if (JSON.stringify(auto) !== before) saveAutoCircuits(auto); },
    };
}

// { season, source, races } della stagione indicata (o di quella in corso).
async function loadSeasonCalendar(year = null, { learn = false } = {}) {
    const season = year || await currentSeason();
    const learner = learn ? makeLearner(season) : null;
    let races = null, source = null;
    if (season >= 2023) {
        try {
            races = await fromOpenF1(season, learner);
            source = 'openf1';
        } catch (err) {
            console.warn(`⚠️  Calendario OpenF1 ${season} non disponibile (${err.message}): uso Jolpica.`);
        }
    }
    if (!races) {
        races = await fromJolpica(season, learner);
        source = 'jolpica';
    }
    if (learner) learner.save();
    if (!races || !races.length) throw new Error(`Calendario ${season} vuoto su OpenF1 e Jolpica.`);
    return { season, source, races };
}

module.exports = { loadSeasonCalendar, currentSeason };
