// scripts/update-calendar.js
//
// Scarica il calendario della stagione IN CORSO (rilevata automaticamente
// tramite /api/current, quindi passa da sola a una nuova stagione l'anno
// prossimo) da f1api.dev, con il vincitore di ogni gara già disputata, e
// aggiorna calendar.json. Gira dopo la gara (domenica), insieme a
// check-pole-penalty.js e update-standings.js.
//
// Scarica anche i risultati completi (prove libere, qualifiche, gara) di
// ogni sessione già disputata, riutilizzati poi dal sito per l'espansione
// "Risultati" nel calendario e nel widget prossimo GP. I risultati sprint
// non sono inclusi: l'API non espone un endpoint dedicato ai loro risultati
// (provati vari nomi plausibili, tutti 404).
//
// Uso manuale: node scripts/update-calendar.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById, matchTeam, CIRCUIT_ID_MAP } = require('./lib/f1-mapping');
const { driverFullName, normalizeSessionResults } = require('./lib/session-results');
const { writeStatus } = require('./lib/status');
const { sleep, fetchJson } = require('./lib/http');
const { openf1Json, CIRCUIT_MAP } = require('./lib/openf1');
const { CIRCUIT_INFO } = require('./lib/weather');
const { loadAutoCircuits, saveAutoCircuits } = require('./lib/auto-circuits');
const { knownDriverNames, siteDriverName } = require('./lib/driver-names');

// Nomi delle sessioni OpenF1 -> chiavi di schedule. ("Day 1/2/3" sono i test
// invernali e si ignorano.)
const OPENF1_SESSION_KEYS = {
    'Practice 1': 'fp1',
    'Practice 2': 'fp2',
    'Practice 3': 'fp3',
    'Sprint Qualifying': 'sprintQualy',
    'Sprint': 'sprintRace',
    'Qualifying': 'qualy',
    'Race': 'race',
};

// Sessioni della stagione da OpenF1 (servono per gli orari ufficiali e per
// riconoscere i circuiti nuovi). Se OpenF1 non risponde: lista vuota, e
// restano gli orari di f1api.dev.
async function loadOpenF1Sessions(season) {
    try {
        return await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}`);
    } catch (err) {
        console.warn(`⚠️  Orari ufficiali OpenF1 non disponibili (${err.message}): uso quelli di f1api.dev.`);
        return [];
    }
}

// Orari ufficiali delle sessioni da OpenF1, per circuito: { circuito: { fp1:
// {date, time}, ... } }. f1api.dev ha a volte orari sbagliati (Austin 2026:
// gara alle 19:00 UTC invece delle 20:00 ufficiali, cioè 20:00 invece delle
// 21:00 italiane, e anche Prove Libere 2 e 3 sfasate di mezz'ora), mentre
// OpenF1 li prende dal feed ufficiale F1. Se OpenF1 non risponde, restano
// quelli di f1api.dev.
function officialSchedule(sessions) {
    const bySessions = new Map();
    for (const s of sessions) {
        const key = OPENF1_SESSION_KEYS[s.session_name];
        const circuit = CIRCUIT_MAP[s.circuit_short_name];
        const start = new Date(s.date_start);
        if (!key || !circuit || isNaN(start)) continue;
        const iso = start.toISOString();
        if (!bySessions.has(circuit)) bySessions.set(circuit, {});
        bySessions.get(circuit)[key] = { date: iso.slice(0, 10), time: iso.slice(11, 19) + 'Z' };
    }
    return bySessions;
}

// Circuiti nuovi: invece di fermarsi finché qualcuno non aggiunge una riga
// alle tabelle (f1-mapping.js, openf1.js, weather.js), li riconosce da solo
// appena compaiono nel calendario e li salva in auto-circuits.json (vedi
// lib/auto-circuits.js). Le tabelle scritte a mano hanno la precedenza.
const DAY_MS = 24 * 3600 * 1000;
async function learnNewCircuits(races, sessions) {
    const auto = loadAutoCircuits();
    const before = JSON.stringify(auto);
    const today = new Date().toISOString().slice(0, 10);

    // 1. f1api.dev: nome del sito = città del circuito (es. "Madrid").
    const usedNames = new Set(Object.values(CIRCUIT_ID_MAP));
    for (const race of races) {
        const c = race.circuit || {};
        const id = String(c.circuitId || '').toLowerCase();
        if (!id || CIRCUIT_ID_MAP[id]) continue;
        let name = c.city || c.circuitName;
        if (!name) continue;
        // Città già usata da un altro circuito: nome completo del circuito.
        if (usedNames.has(name)) name = c.circuitName && !usedNames.has(c.circuitName) ? c.circuitName : `${name} (${c.circuitId})`;
        auto.f1api[id] = { name, addedAt: today };
        CIRCUIT_ID_MAP[id] = name;
        usedNames.add(name);
        console.log(`🆕 Circuito nuovo riconosciuto in automatico: "${c.circuitId}" (${c.circuitName}) -> "${name}"`);
    }

    // 2. OpenF1: collegamento per data. La gara OpenF1 che si corre lo stesso
    // giorno (±1, per orari UTC a cavallo di mezzanotte) di una sola gara del
    // calendario è quel circuito.
    for (const s of sessions) {
        if (s.session_name !== 'Race' || !s.circuit_short_name || CIRCUIT_MAP[s.circuit_short_name]) continue;
        const day = new Date(s.date_start.slice(0, 10)).getTime();
        const matches = races.filter(r => r.schedule?.race?.date && Math.abs(new Date(r.schedule.race.date).getTime() - day) <= DAY_MS);
        const name = matches.length === 1 ? matchCircuitById(matches[0].circuit?.circuitId) : null;
        if (!name) {
            console.warn(`⚠️  Circuito OpenF1 "${s.circuit_short_name}" (${s.date_start.slice(0, 10)}) non collegabile a una gara del calendario: aggiungerlo a CIRCUIT_MAP in scripts/lib/openf1.js.`);
            continue;
        }
        auto.openf1[s.circuit_short_name] = name;
        CIRCUIT_MAP[s.circuit_short_name] = name;
        console.log(`🆕 Circuito OpenF1 "${s.circuit_short_name}" collegato in automatico a "${name}"`);
    }

    // 3. Meteo: coordinate e fuso orario dalla città (ricerca località di
    // Open-Meteo, stesso fornitore del meteo). "Notturno" se la gara parte
    // dalle 18 in poi, ora locale.
    for (const race of races) {
        const c = race.circuit || {};
        const name = matchCircuitById(c.circuitId);
        if (!name || CIRCUIT_INFO[name] || !c.city) continue;
        try {
            const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(c.city)}&count=10&language=en&format=json`);
            const results = geo?.results || [];
            const place = results.find(p => p.country && c.country && p.country.toLowerCase() === c.country.toLowerCase()) || results[0];
            if (!place) { console.warn(`⚠️  ${name}: località "${c.city}" non trovata per il meteo.`); continue; }
            const r = race.schedule?.race;
            const localHour = r?.date && r?.time
                ? Number(new Intl.DateTimeFormat('en-GB', { timeZone: place.timezone, hour: '2-digit', hour12: false }).format(new Date(`${r.date}T${r.time}`)))
                : 12;
            const info = { lat: place.latitude, lon: place.longitude, tz: place.timezone, night: localHour >= 18 };
            auto.weather[name] = info;
            CIRCUIT_INFO[name] = info;
            console.log(`🆕 Meteo di "${name}": ${place.name} (${place.country}) ${info.lat}, ${info.lon}, ${info.tz}${info.night ? ', notturno' : ''}`);
        } catch (err) {
            console.warn(`⚠️  ${name}: coordinate per il meteo non disponibili (${err.message}).`);
        }
    }

    if (JSON.stringify(auto) !== before) saveAutoCircuits(auto);
}

const CALENDAR_JSON_PATH = path.join(__dirname, '..', 'calendar.json');
// Prove libere da OpenF1 quando f1api.dev non le ha (Austin 2026: ancora
// nessun risultato la domenica, e dal lunedì il GP non è più in evidenza,
// quindi le libere non sarebbero mai state salvate). Stesso formato del sito:
// [{position, driver, team, time}], con i nomi dei piloti riportati a quelli
// già usati sul sito (lib/driver-names.js).
const PRACTICE_SESSION_NAMES = { fp1: 'Practice 1', fp2: 'Practice 2', fp3: 'Practice 3' };
const fmtLap = sec => {
    const m = Math.floor(sec / 60), rest = sec - m * 60;
    return `${m}:${rest.toFixed(3).padStart(6, '0')}`;
};
async function openf1PracticeResults(session, driverNames) {
    const [rows, drivers] = [
        await openf1Json(`https://api.openf1.org/v1/session_result?session_key=${session.session_key}`),
        await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`),
    ];
    if (!rows.length) return null;
    const byNumber = new Map(drivers.map(d => [d.driver_number, d]));
    const withTime = rows.filter(r => typeof r.duration === 'number').sort((a, b) => a.duration - b.duration);
    const withoutTime = rows.filter(r => typeof r.duration !== 'number');
    return [...withTime, ...withoutTime].map((r, i) => {
        const d = byNumber.get(r.driver_number) || {};
        return {
            position: i + 1,
            driver: siteDriverName(d, driverNames) || `#${r.driver_number}`,
            team: matchTeam(d.team_name || ''),
            time: typeof r.duration === 'number' ? fmtLap(r.duration) : '-',
        };
    });
}

// Risultati di gara da OpenF1 (classifica ufficiale, penalità post-gara
// comprese). Confronto del 2026-10-25 su 87 gare 2023-2026: in tutte le 10
// gare in cui le due fonti non coincidevano aveva ragione OpenF1 (verificato
// sulle classifiche ufficiali), mentre f1api.dev aveva penalità post-gara
// mancanti (Brasile 2024, Singapore 2025, Bahrain 2025, Barcellona e Miami
// 2026), distacchi sbagliati (Canada 2023, Brasile 2024) e ritirati in ordine
// sbagliato. f1api.dev resta il ripiego (OpenF1 è bloccata durante le
// sessioni live). Stesso formato del sito: {position, driver, team, time, retired}.
const fmtGap = sec => {
    if (sec < 60) return `+${sec.toFixed(3)}`;
    const m = Math.floor(sec / 60);
    return `+${m}:${(sec - m * 60).toFixed(3).padStart(6, '0')}`;
};
const fmtRaceTime = sec => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), rest = sec - h * 3600 - m * 60;
    return `${h}:${String(m).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
};
async function openf1RaceResults(session, driverNames) {
    const rows = await openf1Json(`https://api.openf1.org/v1/session_result?session_key=${session.session_key}`);
    if (!rows.length) return null;
    const drivers = await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`);
    const byNumber = new Map(drivers.map(d => [d.driver_number, d]));
    // Classificati in ordine di posizione; i non classificati (posizione
    // null: ritirati presto, non partiti, squalificati) in fondo, per giri.
    const classified = rows.filter(r => r.position).sort((a, b) => a.position - b.position);
    const others = rows.filter(r => !r.position).sort((a, b) => (b.number_of_laps || 0) - (a.number_of_laps || 0));
    return [...classified, ...others].map((r, i) => {
        const d = byNumber.get(r.driver_number) || {};
        const retired = r.dsq ? 'Squalificato' : r.dns ? 'Non partito' : r.dnf ? 'Ritirato' : null;
        let time = null;
        if (!retired) {
            if (i === 0 && typeof r.duration === 'number') time = fmtRaceTime(r.duration);
            else if (typeof r.gap_to_leader === 'number') time = fmtGap(r.gap_to_leader);
            else if (typeof r.gap_to_leader === 'string') {
                const laps = parseInt(r.gap_to_leader.replace(/\D/g, ''), 10) || 1;
                time = `+${laps} ${laps === 1 ? 'giro' : 'giri'}`;
            } else time = '-';
        }
        return { position: i + 1, driver: siteDriverName(d, driverNames) || `#${r.driver_number}`, team: matchTeam(d.team_name || ''), time, retired };
    });
}
// Le penalità post-gara possono arrivare anche giorni dopo: i risultati
// OpenF1 di una gara si ricontrollano per una settimana, poi restano in cache.
const RACE_RECHECK_DAYS = 7;

async function main() {
    console.log('Richiesta a https://f1api.dev/api/current ...');
    const currentPayload = await fetchJson('https://f1api.dev/api/current');
    const season = currentPayload.season;
    const races = currentPayload.races || [];
    if (!season || races.length === 0) {
        throw new Error('Calendario stagione corrente vuoto o senza campo "season".');
    }
    console.log(`Stagione corrente rilevata: ${season} (${races.length} gare in calendario)`);

    // Calendario già presente: riusiamo i risultati già scaricati in run
    // precedenti invece di riscaricarli ogni volta (una volta disputata una
    // sessione i suoi risultati non cambiano più).
    let existingCalendar = null;
    if (fs.existsSync(CALENDAR_JSON_PATH)) {
        existingCalendar = JSON.parse(fs.readFileSync(CALENDAR_JSON_PATH, 'utf-8'));
    }
    // Chiave = circuito, NON numero di round: l'API può rinumerare il
    // calendario a stagione in corso (successo nel 2026: Sepang inserita come
    // round 16, Singapore passata da 16 a 17) e i risultati in cache
    // finirebbero attribuiti alla gara sbagliata. Un circuito compare una
    // sola volta per stagione, quindi è una chiave stabile.
    const existingByCircuit = new Map();
    if (existingCalendar && Array.isArray(existingCalendar.races)) {
        existingCalendar.races.forEach(r => existingByCircuit.set(r.circuit, r));
    }

    const now = new Date();
    const driverNames = knownDriverNames();
    const openf1Sessions = await loadOpenF1Sessions(season);
    await learnNewCircuits(races, openf1Sessions);
    const official = officialSchedule(openf1Sessions);
    const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

    // GP in evidenza (stessa logica di determineFeaturedRace() in index.html):
    // il prossimo GP con data >= oggi, oppure l'ultimo disputato se la
    // stagione è finita. Solo per questa gara conserviamo i risultati delle
    // prove libere (fp1/fp2/fp3) - il sito li mostra soltanto lì, per le gare
    // precedenti non servono più a nessuno e appesantirebbero solo il file.
    const racesWithDate = races.map(r => ({ round: r.round, date: r.schedule?.race?.date || null }));
    const upcomingRace = racesWithDate.find(r => r.date && r.date >= todayStr);
    let featuredRound = upcomingRace?.round;
    if (featuredRound === undefined) {
        const pastRaces = racesWithDate.filter(r => r.date).sort((a, b) => b.date.localeCompare(a.date));
        featuredRound = pastRaces.length > 0 ? pastRaces[0].round : null;
    }

    const calendarRaces = [];

    for (const race of races) {
        const round = race.round;
        const mappedCircuit = matchCircuitById(race.circuit?.circuitId) || race.circuit?.circuitName || 'Sconosciuto';

        // Orario di ogni sessione del weekend (UTC, come fornito dall'API):
        // la conversione al fuso orario italiano (con cambio ora legale
        // gestito automaticamente) avviene lato client in index.html.
        const schedule = {
            fp1: race.schedule?.fp1?.date ? race.schedule.fp1 : null,
            fp2: race.schedule?.fp2?.date ? race.schedule.fp2 : null,
            fp3: race.schedule?.fp3?.date ? race.schedule.fp3 : null,
            sprintQualy: race.schedule?.sprintQualy?.date ? race.schedule.sprintQualy : null,
            sprintRace: race.schedule?.sprintRace?.date ? race.schedule.sprintRace : null,
            qualy: race.schedule?.qualy?.date ? race.schedule.qualy : null,
            race: race.schedule?.race?.date ? race.schedule.race : null,
        };

        // Orari ufficiali (OpenF1) al posto di quelli di f1api.dev quando ci
        // sono; ogni differenza viene scritta nel log.
        const officialTimes = official.get(mappedCircuit) || {};
        for (const [key, o] of Object.entries(officialTimes)) {
            if (!(key in schedule)) continue;
            const cur = schedule[key];
            if (!cur || cur.date !== o.date || cur.time !== o.time) {
                console.log(`🕒 ${mappedCircuit} ${key}: ${cur ? `${cur.date} ${cur.time}` : '—'} -> ${o.date} ${o.time} (orario ufficiale OpenF1)`);
            }
            schedule[key] = o;
        }

        const date = schedule.race?.date || race.schedule?.race?.date || null;
        // Inizio del weekend di gara (venerdì delle prove libere), usato dal
        // sito per decidere quando mostrare di default questo circuito invece
        // dell'ultimo GP disputato.
        const weekendStart = schedule.fp1?.date || schedule.qualy?.date || date;

        const existingRace = existingByCircuit.get(mappedCircuit);

        let winner = null;
        const results = { fp1: null, fp2: null, fp3: null, qualy: null, race: null };

        // Gara: OpenF1 come fonte principale, f1api.dev come ripiego (vedi
        // openf1RaceResults). raceSource dice da dove vengono i risultati
        // salvati: quelli di f1api.dev (anche se già in cache) vengono
        // sostituiti appena OpenF1 li ha, e quelli OpenF1 si ricontrollano
        // per RACE_RECHECK_DAYS giorni (penalità post-gara).
        const cachedRaceResults = existingRace?.results?.race;
        const raceStart = race.schedule?.race?.date ? new Date(`${race.schedule.race.date}T${race.schedule.race.time || '23:59:59Z'}`) : null;
        const raceIsPast = raceStart && raceStart <= now;
        let raceSource = existingRace?.raceSource || (cachedRaceResults ? 'f1api' : null);
        if (cachedRaceResults) results.race = cachedRaceResults;
        const settled = cachedRaceResults && raceSource === 'openf1' && raceStart && (now - raceStart) > RACE_RECHECK_DAYS * 86400000;

        if (raceIsPast && !settled) {
            const session = openf1Sessions.find(s => s.session_name === 'Race'
                && CIRCUIT_MAP[s.circuit_short_name] === mappedCircuit && new Date(s.date_end) < now);
            let fromOpenF1 = null;
            if (session) {
                try { fromOpenF1 = await openf1RaceResults(session, driverNames); }
                catch (err) { console.warn(`⚠️  ${mappedCircuit}: risultati gara OpenF1 non disponibili - ${err.message}`); }
            }
            if (fromOpenF1) {
                const key = rows => (rows || []).map(r => `${r.position}|${r.driver}|${r.time}|${r.retired}`).join(';');
                if (cachedRaceResults && key(cachedRaceResults) !== key(fromOpenF1)) {
                    if (raceSource === 'openf1') console.log(`🔁 ${mappedCircuit}: classifica di gara aggiornata da OpenF1 (es. penalità post-gara).`);
                    else {
                        const firstDiff = fromOpenF1.find((r, i) => !cachedRaceResults[i] || cachedRaceResults[i].driver !== r.driver);
                        console.log(`📥 ${mappedCircuit}: classifica di gara da OpenF1 al posto di f1api.dev${firstDiff ? ` (prima differenza: P${firstDiff.position} ${firstDiff.driver})` : ' (distacchi/formato)'}.`);
                    }
                } else if (!cachedRaceResults) {
                    console.log(`📥 ${mappedCircuit}: classifica di gara da OpenF1.`);
                }
                results.race = fromOpenF1;
                raceSource = 'openf1';
            } else if (!cachedRaceResults) {
                // Ripiego: f1api.dev.
                try {
                    const racePayload = await fetchJson(`https://f1api.dev/api/${season}/${round}/race`, { allow404: true });
                    const normalized = normalizeSessionResults('race', racePayload?.races);
                    if (normalized && normalized.length) {
                        results.race = normalized;
                        raceSource = 'f1api';
                        console.log(`📥 ${mappedCircuit}: classifica di gara da f1api.dev (OpenF1 non disponibile).`);
                    }
                } catch (err) {
                    console.warn(`⚠️  Round ${round} (${mappedCircuit}): errore nel recupero risultati gara - ${err.message}`);
                }
                await sleep(150);
            }
        }
        if (!results.race) raceSource = null;
        const winnerRow = (results.race || []).find(r => r.position === 1);
        if (winnerRow) winner = { driver: winnerRow.driver, team: winnerRow.team };

        // Prove libere e qualifiche: una richiesta per sessione, solo se non
        // già in cache e solo se la sessione è già passata (niente 404 inutili
        // per i weekend futuri).
        for (const key of ['fp1', 'fp2', 'fp3', 'qualy']) {
            // I risultati delle prove libere si scartano (anche se già in
            // cache da un run precedente) per ogni gara che non è più quella
            // in evidenza: il sito li nasconde comunque, quindi non ha senso
            // continuare a scaricarli/conservarli. Così calendar.json si
            // alleggerisce da solo non appena un GP "passa il turno".
            if ((key === 'fp1' || key === 'fp2' || key === 'fp3') && round !== featuredRound) {
                continue;
            }
            const cached = existingRace?.results?.[key];
            if (cached) {
                results[key] = cached;
                continue;
            }
            const sessionInfo = schedule[key];
            // Orario assente ma data nota (visto su Sepang 2026, round 16):
            // la sessione conta come disputata dal giorno dopo la sua data.
            if (!sessionInfo?.date) continue; // sessione non prevista in questo weekend
            const sessionStart = new Date(`${sessionInfo.date}T${sessionInfo.time || '23:59:59Z'}`);
            if (isNaN(sessionStart) || sessionStart > now) continue; // ancora da disputare

            try {
                const payload = await fetchJson(`https://f1api.dev/api/${season}/${round}/${key}`, { allow404: true });
                results[key] = normalizeSessionResults(key, payload?.races);
            } catch (err) {
                console.warn(`⚠️  Round ${round} (${mappedCircuit}) - risultati ${key}: errore - ${err.message}`);
            }
            await sleep(150);

            // Prove libere senza risultati su f1api.dev: si prendono da
            // OpenF1, solo a sessione finita.
            if (!results[key] && PRACTICE_SESSION_NAMES[key]) {
                const session = openf1Sessions.find(s => s.session_name === PRACTICE_SESSION_NAMES[key]
                    && CIRCUIT_MAP[s.circuit_short_name] === mappedCircuit && new Date(s.date_end) < now);
                if (session) {
                    try {
                        results[key] = await openf1PracticeResults(session, driverNames);
                        if (results[key]) console.log(`📥 ${mappedCircuit} ${key}: risultati da OpenF1 (non ancora su f1api.dev)`);
                    } catch (err) {
                        console.warn(`⚠️  ${mappedCircuit} ${key}: risultati OpenF1 non disponibili - ${err.message}`);
                    }
                }
            }
        }

        calendarRaces.push({ round, circuit: mappedCircuit, raceName: race.raceName || '', date, weekendStart, winner, schedule, results, ...(raceSource ? { raceSource } : {}) });
        console.log(`Round ${round} - ${mappedCircuit}: ${winner ? `${winner.driver} (${winner.team})` : 'da disputare'}`);
    }

    const newCalendar = { season, updatedAt: new Date().toISOString(), races: calendarRaces };

    const isSame = existingCalendar &&
        existingCalendar.season === newCalendar.season &&
        JSON.stringify(existingCalendar.races) === JSON.stringify(newCalendar.races);

    if (isSame) {
        console.log('Nessuna modifica: il calendario era già aggiornato.');
        return;
    }

    fs.writeFileSync(CALENDAR_JSON_PATH, JSON.stringify(newCalendar, null, 2) + '\n', 'utf-8');
    console.log(`✅ calendar.json aggiornato (stagione ${season}).`);
}

main()
    .then(() => writeStatus('calendar', true))
    .catch(err => {
        console.error('❌ Errore durante l\'aggiornamento calendario:', err.message);
        writeStatus('calendar', false, err.message);
        process.exit(1);
    });
