// scripts/update-calendar.js
//
// Aggiorna calendar.json: calendario della stagione IN CORSO (rilevata da
// sola, quindi passa all'anno nuovo appena il suo calendario è pubblicato)
// con orari ufficiali di ogni sessione, vincitore e risultati completi di
// prove libere (solo GP in evidenza), qualifiche e gara.
//
// Fonti: calendario da lib/season-calendar.js (OpenF1, ripiego Jolpica);
// risultati da OpenF1 (lib/openf1-results.js), ripiego Jolpica per qualifica
// e gara (Jolpica non ha le prove libere). f1api.dev, la fonte di prima, è
// stata eliminata il 2026-10-26 (orari sbagliati, risultati in ritardo di
// giorni, penalità mancanti). I risultati sprint non sono ancora inclusi.
//
// Uso manuale: node scripts/update-calendar.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById } = require('./lib/f1-mapping');
const { writeStatus } = require('./lib/status');
const { openf1Json, CIRCUIT_MAP } = require('./lib/openf1');
const { loadSeasonCalendar } = require('./lib/season-calendar');
const { jolpicaRaces, jolpicaRaceRows, jolpicaQualyRows } = require('./lib/jolpica');
const { knownDriverNames } = require('./lib/driver-names');
const { openf1PracticeResults, openf1RaceResults, openf1QualyResults } = require('./lib/openf1-results');

// Sessioni della stagione da OpenF1 (per i risultati). Se OpenF1 non
// risponde (es. sessione in corso): lista vuota, e i risultati arrivano da
// Jolpica o restano quelli già salvati.
async function loadOpenF1Sessions(season) {
    try {
        return await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}`);
    } catch (err) {
        console.warn(`⚠️  Sessioni OpenF1 non disponibili (${err.message}): risultati da Jolpica o in cache.`);
        return [];
    }
}

// Risultati di un round da Jolpica (ripiego), solo se il circuito coincide.
async function jolpicaRound(season, round, circuit, kind) {
    try {
        const [race] = await jolpicaRaces(`${season}/${round}/${kind === 'race' ? 'results' : 'qualifying'}`);
        if (!race || matchCircuitById(race.Circuit?.circuitId) !== circuit) return null;
        return race;
    } catch (err) {
        console.warn(`⚠️  ${circuit}: ${kind} Jolpica non disponibile - ${err.message}`);
        return null;
    }
}

const CALENDAR_JSON_PATH = path.join(__dirname, '..', 'calendar.json');
// Prove libere e gara da OpenF1: vedi lib/openf1-results.js.
const PRACTICE_SESSION_NAMES = { fp1: 'Practice 1', fp2: 'Practice 2', fp3: 'Practice 3' };

// Le penalità post-gara possono arrivare anche giorni dopo: i risultati
// OpenF1 di una gara si ricontrollano per una settimana, poi restano in cache.
const RACE_RECHECK_DAYS = 7;
// node scripts/update-calendar.js --refresh-race: ricontrolla da OpenF1 tutte
// le gare della stagione, anche quelle oltre i 7 giorni (es. dopo una
// modifica alla conversione dei risultati).
const FORCE_RACE_REFRESH = process.argv.includes('--refresh-race');

async function main() {
    const { season, source, races } = await loadSeasonCalendar(null, { learn: true });
    console.log(`Stagione corrente: ${season} (${races.length} gare, calendario da ${source === 'openf1' ? 'OpenF1' : 'Jolpica'})`);

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
        const mappedCircuit = race.circuit;
        // Orari ufficiali UTC di ogni sessione: la conversione al fuso
        // italiano (ora legale compresa) avviene nel sito, in index.html.
        const schedule = race.schedule;

        const date = schedule.race?.date || race.date || null;
        // Inizio del weekend di gara (venerdì delle prove libere), usato dal
        // sito per decidere quando mostrare di default questo circuito invece
        // dell'ultimo GP disputato.
        const weekendStart = schedule.fp1?.date || schedule.qualy?.date || date;

        const existingRace = existingByCircuit.get(mappedCircuit);

        let winner = null;
        const results = { fp1: null, fp2: null, fp3: null, qualy: null, race: null };

        // Gara: OpenF1 come fonte principale, Jolpica come ripiego (vedi
        // openf1RaceResults). raceSource dice da dove vengono i risultati
        // salvati: quelli non OpenF1 (anche se già in cache) vengono
        // sostituiti appena OpenF1 li ha, e quelli OpenF1 si ricontrollano
        // per RACE_RECHECK_DAYS giorni (penalità post-gara).
        const cachedRaceResults = existingRace?.results?.race;
        const raceStart = race.schedule?.race?.date ? new Date(`${race.schedule.race.date}T${race.schedule.race.time || '23:59:59Z'}`) : null;
        const raceIsPast = raceStart && raceStart <= now;
        let raceSource = existingRace?.raceSource || (cachedRaceResults ? 'f1api' : null);
        if (cachedRaceResults) results.race = cachedRaceResults;
        const settled = !FORCE_RACE_REFRESH && cachedRaceResults && raceSource === 'openf1' && raceStart && (now - raceStart) > RACE_RECHECK_DAYS * 86400000;

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
                        console.log(`📥 ${mappedCircuit}: classifica di gara da OpenF1 al posto di ${raceSource || 'altra fonte'}${firstDiff ? ` (prima differenza: P${firstDiff.position} ${firstDiff.driver})` : ' (distacchi/formato)'}.`);
                    }
                } else if (!cachedRaceResults) {
                    console.log(`📥 ${mappedCircuit}: classifica di gara da OpenF1.`);
                }
                results.race = fromOpenF1;
                raceSource = 'openf1';
            } else if (!cachedRaceResults) {
                // Ripiego: Jolpica.
                const j = await jolpicaRound(season, round, mappedCircuit, 'race');
                if (j && j.Results.length) {
                    results.race = jolpicaRaceRows(j, driverNames);
                    raceSource = 'jolpica';
                    console.log(`📥 ${mappedCircuit}: classifica di gara da Jolpica (OpenF1 non disponibile).`);
                }
            }
        }
        if (!results.race) raceSource = null;
        const winnerRow = (results.race || []).find(r => r.position === 1);
        if (winnerRow) winner = { driver: winnerRow.driver, team: winnerRow.team };

        // Prove libere e qualifiche: una richiesta per sessione, solo se non
        // già in cache e solo se la sessione è già passata (niente 404 inutili
        // per i weekend futuri).
        // Qualifica: come la gara, OpenF1 principale (qualySource) e Jolpica
        // ripiego; si ricontrolla per RACE_RECHECK_DAYS giorni.
        const cachedQualy = existingRace?.results?.qualy;
        let qualySource = existingRace?.qualySource || (cachedQualy ? 'f1api' : null);
        if (cachedQualy) results.qualy = cachedQualy;
        const qualyStart = schedule.qualy?.date ? new Date(`${schedule.qualy.date}T${schedule.qualy.time || '23:59:59Z'}`) : null;
        const qualySettled = !FORCE_RACE_REFRESH && cachedQualy && qualySource === 'openf1' && qualyStart && (now - qualyStart) > RACE_RECHECK_DAYS * 86400000;
        if (qualyStart && qualyStart <= now && !qualySettled) {
            const session = openf1Sessions.find(s => s.session_name === 'Qualifying'
                && CIRCUIT_MAP[s.circuit_short_name] === mappedCircuit && new Date(s.date_end) < now);
            let fromOpenF1 = null;
            if (session) {
                try { fromOpenF1 = await openf1QualyResults(session, driverNames); }
                catch (err) { console.warn(`⚠️  ${mappedCircuit}: qualifica OpenF1 non disponibile - ${err.message}`); }
            }
            if (fromOpenF1) {
                if (JSON.stringify(cachedQualy) !== JSON.stringify(fromOpenF1)) {
                    const firstDiff = fromOpenF1.find((r, i) => !cachedQualy?.[i] || cachedQualy[i].driver !== r.driver);
                    console.log(`📥 ${mappedCircuit}: qualifica da OpenF1${cachedQualy && qualySource !== 'openf1' ? ` al posto di ${qualySource}` : ''}${firstDiff && cachedQualy ? ` (prima differenza: P${firstDiff.position} ${firstDiff.driver})` : ''}.`);
                }
                results.qualy = fromOpenF1;
                qualySource = 'openf1';
            } else if (!cachedQualy) {
                // Ripiego: Jolpica (ordine di qualifica, senza griglia).
                const j = await jolpicaRound(season, round, mappedCircuit, 'qualy');
                if (j && j.QualifyingResults.length) {
                    results.qualy = jolpicaQualyRows(j, driverNames);
                    qualySource = 'jolpica';
                    console.log(`📥 ${mappedCircuit}: qualifica da Jolpica (OpenF1 non disponibile).`);
                }
            }
        }
        if (!results.qualy) qualySource = null;

        for (const key of ['fp1', 'fp2', 'fp3']) {
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

            // Prove libere: solo OpenF1 (classifica ufficiale, di solito
            // pubblicata poco dopo la sessione; Jolpica non le ha). Se OpenF1
            // non risponde si riprova al run successivo.
            const session = openf1Sessions.find(s => s.session_name === PRACTICE_SESSION_NAMES[key]
                && CIRCUIT_MAP[s.circuit_short_name] === mappedCircuit && new Date(s.date_end) < now);
            if (session) {
                try {
                    results[key] = await openf1PracticeResults(session, driverNames);
                    if (results[key]) console.log(`📥 ${mappedCircuit} ${key}: risultati da OpenF1`);
                } catch (err) {
                    console.warn(`⚠️  ${mappedCircuit} ${key}: risultati OpenF1 non disponibili - ${err.message}`);
                }
            }
        }

        calendarRaces.push({ round, circuit: mappedCircuit, raceName: race.raceName || '', date, weekendStart, winner, schedule, results, ...(raceSource ? { raceSource } : {}), ...(qualySource ? { qualySource } : {}) });
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
