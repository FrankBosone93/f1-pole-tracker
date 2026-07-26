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

const CALENDAR_JSON_PATH = path.join(__dirname, '..', 'calendar.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, { allow404 = false } = {}) {
    const res = await fetch(url);
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
    return res.json();
}

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
    const existingByRound = new Map();
    if (existingCalendar && Array.isArray(existingCalendar.races)) {
        existingCalendar.races.forEach(r => existingByRound.set(r.round, r));
    }

    const now = new Date();
    const calendarRaces = [];

    for (const race of races) {
        const round = race.round;
        const mappedCircuit = matchCircuitById(race.circuit?.circuitId) || race.circuit?.circuitName || 'Sconosciuto';
        const date = race.schedule?.race?.date || null;
        // Inizio del weekend di gara (venerdì delle prove libere), usato dal
        // sito per decidere quando mostrare di default questo circuito invece
        // dell'ultimo GP disputato.
        const weekendStart = race.schedule?.fp1?.date || race.schedule?.qualy?.date || date;

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

        const existingRace = existingByRound.get(round);

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
            const cached = existingRace?.results?.[key];
            if (cached) {
                results[key] = cached;
                continue;
            }
            const sessionInfo = schedule[key];
            if (!sessionInfo?.date || !sessionInfo?.time) continue; // sessione non prevista in questo weekend
            const sessionStart = new Date(`${sessionInfo.date}T${sessionInfo.time}`);
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

main().catch(err => {
    console.error('❌ Errore durante l\'aggiornamento calendario:', err.message);
    process.exit(1);
});
