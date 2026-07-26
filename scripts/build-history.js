// scripts/build-history.js
//
// Strumento una tantum (non schedulato, a differenza degli altri script):
// scarica il calendario con vincitori e risultati di qualifiche e gara (SOLO
// queste due sessioni per le stagioni passate: niente prove libere né
// sprint, su richiesta esplicita - a differenza di calendar.json, che per la
// stagione in corso include anche le prove libere) di una o più stagioni
// PASSATE da f1api.dev, e scrive un file history/{anno}.json per ognuna.
// Usato dal pannello "Stagioni precedenti" del sito, che li scarica uno alla
// volta al primo click su quell'anno.
//
// A differenza di update-calendar.js (che gira automaticamente ogni
// settimana sulla stagione in corso), qui i dati di una stagione passata non
// cambiano più una volta scritti: non serve schedulazione, va lanciato a
// mano quando si vuole aggiungere/ricostruire un anno.
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

const HISTORY_DIR = path.join(__dirname, '..', 'history');
const PREVIOUS_YEARS = [2025, 2024, 2023, 2022, 2021];
const ROUND_CONCURRENCY = 4; // quante gare scaricare in parallelo per stagione

async function fetchJson(url, { allow404 = false } = {}) {
    const res = await fetch(url);
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
    return res.json();
}

async function buildRaceEntry(year, race) {
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

    return { round, circuit: mappedCircuit, raceName: race.raceName || '', date, weekendStart, winner, schedule, results };
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
            const entry = await buildRaceEntry(year, race);
            resultsByRound.set(entry.round, entry);
            console.log(`Round ${entry.round} - ${entry.circuit}: ${entry.winner ? `${entry.winner.driver} (${entry.winner.team})` : 'nessun vincitore trovato'}`);
            writePartial();
        }
    }

    await Promise.all(Array.from({ length: Math.min(ROUND_CONCURRENCY, races.length) }, worker));

    fs.renameSync(partialPath, outPath);
    console.log(`✅ history/${year}.json scritto (${races.length} gare).`);
}

async function main() {
    const argYears = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
    const years = argYears.length > 0 ? argYears : PREVIOUS_YEARS;
    for (const year of years) {
        await buildYear(year);
    }
}

main().catch(err => {
    console.error('❌ Errore durante la costruzione dello storico:', err.message);
    process.exit(1);
});
