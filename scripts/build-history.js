// scripts/build-history.js
//
// Scarica il calendario con vincitori e risultati di qualifiche e gara (SOLO
// queste due sessioni per le stagioni passate: niente prove libere né
// sprint, su richiesta esplicita - a differenza di calendar.json, che per la
// stagione in corso include anche le prove libere) di una o più stagioni
// PASSATE da f1api.dev, e scrive un file history/{anno}.json per ognuna.
// Usato dal pannello "Stagioni precedenti" del sito, che li scarica uno alla
// volta al primo click su quell'anno.
//
// buildYear() è anche importato da scripts/archive-finished-season.js, che
// gira ogni settimana (stessa schedulazione di update-calendar.js) e la
// richiama in automatico non appena la stagione in corso finisce - non serve
// più lanciare questo script a mano quando termina un mondiale.
//
// L'API f1api.dev risponde piuttosto lenta (alcuni secondi a richiesta): le
// gare di una stagione vengono quindi processate in parallelo (con un limite
// di concorrenza) invece che una alla volta, altrimenti un'intera stagione
// richiederebbe ore. Scrittura incrementale (file .partial aggiornato dopo
// ogni gara completata, poi rinominato alla fine): se il processo viene
// interrotto, i dati delle gare già scaricate non vanno persi - basta
// rilanciare lo script, che riparte dal file .partial rimasto a metà.
//
// Uso:
//   node scripts/build-history.js            (tutti gli anni in PREVIOUS_YEARS)
//   node scripts/build-history.js 2025       (solo il 2025)
//   node scripts/build-history.js 2025 2024  (più anni specifici)
//
// Se history/{anno}.json esiste già (completo), viene saltato. Per
// rigenerare un anno da zero, cancellare prima il file corrispondente.

const fs = require('fs');
const path = require('path');
const { matchCircuitById, matchTeam } = require('./lib/f1-mapping');
const { driverFullName, normalizeSessionResults } = require('./lib/session-results');
const { fetchJson } = require('./lib/http');
const { openf1Json, CIRCUIT_MAP } = require('./lib/openf1');
const { openf1RaceResults } = require('./lib/openf1-results');
const { knownDriverNames } = require('./lib/driver-names');

// Risultati di gara dal 2023: fonte principale OpenF1 (classifica ufficiale
// con le penalità post-gara; f1api.dev ne ha perse diverse, es. Brasile 2024
// e Singapore 2025), ripiego f1api.dev. Prima del 2023 OpenF1 non ha dati.
const OPENF1_FIRST_YEAR = 2023;
async function openf1RaceSessions(year) {
    if (year < OPENF1_FIRST_YEAR) return [];
    try {
        return await openf1Json(`https://api.openf1.org/v1/sessions?year=${year}&session_name=Race`);
    } catch (err) {
        console.warn(`⚠️  ${year}: gare OpenF1 non disponibili (${err.message}), uso f1api.dev.`);
        return [];
    }
}
// Gara OpenF1 dello stesso circuito e della stessa data (±2 giorni: nello
// stesso anno un circuito può ospitare due GP, es. Red Bull Ring 2021).
function findRaceSession(sessions, circuit, date) {
    return sessions.find(s => CIRCUIT_MAP[s.circuit_short_name] === circuit && date
        && Math.abs(new Date(s.date_start.slice(0, 10)) - new Date(date)) <= 2 * 86400000);
}

const HISTORY_DIR = path.join(__dirname, '..', 'history');
const PREVIOUS_YEARS = [2025, 2024, 2023, 2022, 2021];
const ROUND_CONCURRENCY = 4; // quante gare scaricare in parallelo per stagione

async function buildRaceEntry(year, race, raceSessions = []) {
    const round = race.round;
    const mappedCircuit = matchCircuitById(race.circuit?.circuitId) || race.circuit?.circuitName || 'Sconosciuto';
    const date = race.schedule?.race?.date || null;
    const weekendStart = race.schedule?.qualy?.date || date;

    // Solo qualifiche e gara per le stagioni passate: niente prove libere né
    // sprint (su richiesta esplicita), quindi quei campi restano null e le
    // relative righe non compaiono nella lista sessioni (renderSessionsBlock
    // le salta già quando schedule[key] è null, nessuna modifica lì serve).
    const schedule = {
        fp1: null,
        fp2: null,
        fp3: null,
        sprintQualy: null,
        sprintRace: null,
        qualy: race.schedule?.qualy?.date ? race.schedule.qualy : null,
        race: race.schedule?.race?.date ? race.schedule.race : null,
    };

    // Le due richieste non dipendono l'una dall'altra: le lanciamo insieme
    // invece che in sequenza (l'API è lenta, farlo in serie renderebbe
    // un'intera stagione questione di ore).
    const [racePayload, qualyPayload] = await Promise.all([
        fetchJson(`https://f1api.dev/api/${year}/${round}/race`, { allow404: true })
            .catch(err => { console.warn(`⚠️  Round ${round} (${mappedCircuit}): errore risultati gara - ${err.message}`); return null; }),
        fetchJson(`https://f1api.dev/api/${year}/${round}/qualy`, { allow404: true })
            .catch(err => { console.warn(`⚠️  Round ${round} (${mappedCircuit}) - risultati qualy: errore - ${err.message}`); return null; }),
    ]);

    let winner = null;
    const results = { fp1: null, fp2: null, fp3: null, qualy: null, race: null };

    const rawResults = racePayload?.races?.results;
    if (Array.isArray(rawResults) && rawResults.length > 0) {
        const winnerRow = rawResults.find(r => String(r.position) === '1') || rawResults[0];
        winner = {
            driver: driverFullName(winnerRow.driver),
            team: matchTeam(winnerRow.team?.teamName || winnerRow.team?.teamId || ''),
        };
        results.race = normalizeSessionResults('race', racePayload.races);
    }
    results.qualy = normalizeSessionResults('qualy', qualyPayload?.races);

    let raceSource = results.race ? 'f1api' : null;
    const session = findRaceSession(raceSessions, mappedCircuit, date);
    if (session) {
        try {
            const names = knownDriverNames([...(results.race || []), ...(results.qualy || [])].map(r => r.driver));
            const fromOpenF1 = await openf1RaceResults(session, names);
            if (fromOpenF1) {
                results.race = fromOpenF1;
                raceSource = 'openf1';
                winner = { driver: fromOpenF1[0].driver, team: fromOpenF1[0].team };
            }
        } catch (err) {
            console.warn(`⚠️  Round ${round} (${mappedCircuit}): gara OpenF1 non disponibile - ${err.message}`);
        }
    }

    return { round, circuit: mappedCircuit, raceName: race.raceName || '', date, weekendStart, winner, schedule, results, ...(raceSource ? { raceSource } : {}) };
}

async function buildYear(year) {
    const outPath = path.join(HISTORY_DIR, `${year}.json`);
    const partialPath = `${outPath}.partial`;
    if (fs.existsSync(outPath)) {
        console.log(`⏭️  ${year}: history/${year}.json esiste già, salto (cancellalo per rigenerarlo).`);
        return;
    }

    console.log(`\n=== Stagione ${year} ===`);
    console.log(`Richiesta a https://f1api.dev/api/${year} ...`);
    const seasonPayload = await fetchJson(`https://f1api.dev/api/${year}`);
    const races = seasonPayload?.races || [];
    if (races.length === 0) {
        console.warn(`⚠️  ${year}: nessuna gara trovata, salto.`);
        return;
    }
    console.log(`${races.length} gare trovate per il ${year}. Concorrenza: ${ROUND_CONCURRENCY} gare in parallelo.`);

    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

    const raceSessions = await openf1RaceSessions(year);
    const resultsByRound = new Map();
    function writePartial() {
        const sorted = races.map(r => resultsByRound.get(r.round)).filter(Boolean);
        const output = { season: year, updatedAt: new Date().toISOString(), races: sorted };
        fs.writeFileSync(partialPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
    }

    let nextIndex = 0;
    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= races.length) return;
            const race = races[i];
            const entry = await buildRaceEntry(year, race, raceSessions);
            resultsByRound.set(entry.round, entry);
            console.log(`Round ${entry.round} - ${entry.circuit}: ${entry.winner ? `${entry.winner.driver} (${entry.winner.team})` : 'nessun vincitore trovato'}`);
            writePartial();
        }
    }

    await Promise.all(Array.from({ length: Math.min(ROUND_CONCURRENCY, races.length) }, worker));

    fs.renameSync(partialPath, outPath);
    console.log(`✅ history/${year}.json scritto (${races.length} gare).`);
}

// Sostituisce nei file storici già scritti i risultati di gara di f1api.dev
// con quelli OpenF1 (dal 2023), senza riscaricare il resto della stagione.
// Uso: node scripts/build-history.js --refresh-race 2023 2024 2025
async function refreshRaceResults(year) {
    const file = path.join(HISTORY_DIR, `${year}.json`);
    if (!fs.existsSync(file)) { console.warn(`⚠️  history/${year}.json non esiste, salto.`); return; }
    const history = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const sessions = await openf1RaceSessions(year);
    if (!sessions.length) return;
    const names = knownDriverNames(history.races.flatMap(r => [...(r.results?.race || []), ...(r.results?.qualy || [])]).map(r => r.driver));
    let changed = 0;
    for (const race of history.races) {
        const session = findRaceSession(sessions, race.circuit, race.date);
        if (!session) continue;
        let fromOpenF1 = null;
        try { fromOpenF1 = await openf1RaceResults(session, names); }
        catch (err) { console.warn(`⚠️  ${year} ${race.circuit}: ${err.message}`); continue; }
        if (!fromOpenF1) continue;
        const before = race.results.race || [];
        const diffs = fromOpenF1.filter((r, i) => !before[i] || before[i].driver !== r.driver || before[i].time !== r.time || before[i].retired !== r.retired);
        const moved = fromOpenF1.filter((r, i) => before[i] && before[i].driver !== r.driver).map(r => `P${r.position} ${r.driver}`);
        race.results.race = fromOpenF1;
        race.winner = { driver: fromOpenF1[0].driver, team: fromOpenF1[0].team };
        race.raceSource = 'openf1';
        changed++;
        console.log(`${year} ${race.circuit}: ${diffs.length} righe cambiate${moved.length ? ` - ordine: ${moved.join(', ')}` : ''}`);
    }
    history.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(history, null, 2) + '\n', 'utf-8');
    console.log(`✅ history/${year}.json: ${changed} gare con risultati OpenF1.`);
}

async function main() {
    if (process.argv.includes('--refresh-race')) {
        for (const year of process.argv.slice(2).map(Number).filter(n => !isNaN(n))) await refreshRaceResults(year);
        return;
    }
    const argYears = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
    const years = argYears.length > 0 ? argYears : PREVIOUS_YEARS;
    for (const year of years) {
        await buildYear(year);
    }
}

module.exports = { buildYear, HISTORY_DIR };

// require.main === module: esegue main() solo se lo script è lanciato
// direttamente (node scripts/build-history.js), non quando viene importato
// da archive-finished-season.js per riusare solo buildYear().
if (require.main === module) {
    main().catch(err => {
        console.error('❌ Errore durante la costruzione dello storico:', err.message);
        process.exit(1);
    });
}
