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
const { matchCircuitById, matchTeam } = require('./lib/f1-mapping');
const { driverFullName, normalizeSessionResults } = require('./lib/session-results');
const { writeStatus } = require('./lib/status');
const { sleep, fetchJson } = require('./lib/http');
const { openf1Json, CIRCUIT_MAP } = require('./lib/openf1');

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

// Orari ufficiali delle sessioni da OpenF1, per circuito: { circuito: { fp1:
// {date, time}, ... } }. f1api.dev ha a volte orari sbagliati (Austin 2026:
// gara alle 19:00 UTC invece delle 20:00 ufficiali, cioè 20:00 invece delle
// 21:00 italiane, e anche Prove Libere 2 e 3 sfasate di mezz'ora), mentre
// OpenF1 li prende dal feed ufficiale F1. Se OpenF1 non risponde, restano
// quelli di f1api.dev.
async function loadOfficialSchedule(season) {
    const bySessions = new Map();
    try {
        const sessions = await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}`);
        for (const s of sessions) {
            const key = OPENF1_SESSION_KEYS[s.session_name];
            const circuit = CIRCUIT_MAP[s.circuit_short_name];
            const start = new Date(s.date_start);
            if (!key || !circuit || isNaN(start)) continue;
            const iso = start.toISOString();
            if (!bySessions.has(circuit)) bySessions.set(circuit, {});
            bySessions.get(circuit)[key] = { date: iso.slice(0, 10), time: iso.slice(11, 19) + 'Z' };
        }
    } catch (err) {
        console.warn(`⚠️  Orari ufficiali OpenF1 non disponibili (${err.message}): uso quelli di f1api.dev.`);
    }
    return bySessions;
}

const CALENDAR_JSON_PATH = path.join(__dirname, '..', 'calendar.json');

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
    const officialSchedule = await loadOfficialSchedule(season);
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
        const official = officialSchedule.get(mappedCircuit) || {};
        for (const [key, o] of Object.entries(official)) {
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

        // Gara: un'unica richiesta condivisa tra "vincitore" (già esistente)
        // e "risultati completi" (nuovo), per non raddoppiare la chiamata.
        const cachedRaceResults = existingRace?.results?.race;
        if (cachedRaceResults) {
            results.race = cachedRaceResults;
            // Il vincitore va comunque ricavato: se i risultati sono già in
            // cache, lo ricaviamo da lì invece di rifare la richiesta.
            const winnerRow = cachedRaceResults.find(r => r.position === 1);
            if (winnerRow) winner = { driver: winnerRow.driver, team: winnerRow.team };
        } else if (race.schedule?.race?.date && new Date(`${race.schedule.race.date}T${race.schedule.race.time || '23:59:59Z'}`) > now) {
            // Gara ancora da disputare: nessuna richiesta (prima partiva un
            // 404 inutile per ogni gara futura, a ogni run: 6 su 7 richieste).
        } else {
            try {
                const racePayload = await fetchJson(`https://f1api.dev/api/${season}/${round}/race`, { allow404: true });
                const rawResults = racePayload?.races?.results;
                if (Array.isArray(rawResults) && rawResults.length > 0) {
                    const winnerRow = rawResults.find(r => String(r.position) === '1') || rawResults[0];
                    winner = {
                        driver: driverFullName(winnerRow.driver),
                        team: matchTeam(winnerRow.team?.teamName || winnerRow.team?.teamId || ''),
                    };
                    results.race = normalizeSessionResults('race', racePayload.races);
                }
            } catch (err) {
                console.warn(`⚠️  Round ${round} (${mappedCircuit}): errore nel recupero risultati gara - ${err.message}`);
            }
            await sleep(150);
        }

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
        }

        calendarRaces.push({ round, circuit: mappedCircuit, raceName: race.raceName || '', date, weekendStart, winner, schedule, results });
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
