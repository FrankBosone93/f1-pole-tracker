// scripts/verify-data.js
//
// Strumento di controllo manuale (NON tocca data.json, solo report a schermo):
// scarica da f1api.dev, round per round, tutte le qualifiche delle stagioni
// presenti in data.json e le confronta con quanto già registrato, segnalando
// discrepanze da rivedere a mano (i dati storici richiedono giudizio umano,
// es. casi di penalità: vedi penaltyNote e check-pole-penalty.js).
//
// Uso:
//   node scripts/verify-data.js
//
// Utile per un controllo periodico "di massa", oltre al normale aggiornamento
// automatico settimanale (che tocca solo l'ultima gara disputata).

const fs = require('fs');
const path = require('path');
const { matchCircuitById, matchTeam, parseQualyTime, driverFullName, normalize } = require('./lib/f1-mapping');

const { fetchJson: fetchJsonOnce, sleep } = require('./lib/http');
const fetchJson = url => fetchJsonOnce(url, { retries: 3 });

// Discrepanze già verificate a mano con fonti indipendenti (Formula1.com,
// Motorsport.com, ecc.): in questi casi l'errore è di f1api.dev e il valore di
// data.json è quello giusto. Non vengono più riproposte come "da rivedere".
const VERIFIED_API_ERRORS = {
    '2024|Melbourne (Australia)': 'pole 1:15.915 (f1api.dev dà 1:15.925)',
    '2024|Red Bull Ring': 'pole 1:04.314 (f1api.dev dà 1:04.426)',
};

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');

async function main() {
    const currentData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
    const years = [...new Set(currentData.map(d => d.year))].sort();

    const unmapped = [];
    const missingInJson = [];
    const mismatches = [];
    const seenKeys = new Set();
    const matchedKeys = new Set(); // anno|circuito con almeno una gara che combacia
    let checked = 0;

    for (const year of years) {
        const seasonPayload = await fetchJson(`https://f1api.dev/api/${year}`);
        const races = seasonPayload.races || [];
        for (const race of races) {
            const round = race.round;
            let qualyPayload;
            try {
                qualyPayload = await fetchJson(`https://f1api.dev/api/${year}/${round}/qualy`);
            } catch (err) {
                console.log(`[SKIP] ${year} round ${round} (${race.raceName}): ${err.message}`);
                continue;
            }
            const r = qualyPayload.races;
            if (!r || !Array.isArray(r.qualyResults) || r.qualyResults.length === 0) {
                continue; // gara non ancora disputata
            }
            const circuitInfo = Array.isArray(r.circuit) ? r.circuit[0] : r.circuit;
            const mappedCircuit = matchCircuitById(circuitInfo?.circuitId);
            if (!mappedCircuit) {
                unmapped.push(`${year} round ${round}: circuitId="${circuitInfo?.circuitId}" (${race.raceName})`);
                continue;
            }

            const poleResult = r.qualyResults.find(x => Number(x.gridPosition) === 1) || r.qualyResults[0];
            const driver = driverFullName(poleResult.driver);
            const team = matchTeam(poleResult.team?.teamName || poleResult.team?.teamId || '');
            const timeCandidate = poleResult.q3 || poleResult.q2 || poleResult.q1 || poleResult.time || poleResult.fastLap;
            const parsedTime = parseQualyTime(timeCandidate);

            checked++;

            const jsonEntry = currentData.find(d => d.year === year && d.circuit === mappedCircuit);
            if (!jsonEntry) {
                missingInJson.push(`${year} - ${mappedCircuit} (${r.raceName}): API ha pole=${driver}/${team}/${parsedTime?.timeStr}, assente in data.json`);
                continue;
            }
            seenKeys.add(`${year}|${mappedCircuit}`);

            const driverMatches = normalize(jsonEntry.driver) === normalize(driver);
            const teamMatches = jsonEntry.team === team;
            const timeMatches = parsedTime && jsonEntry.timeStr === parsedTime.timeStr;

            if (driverMatches && teamMatches && timeMatches) matchedKeys.add(`${year}|${mappedCircuit}`);

            if (!driverMatches || !teamMatches || !timeMatches) {
                mismatches.push({
                    year, circuit: mappedCircuit, raceName: r.raceName,
                    json: { driver: jsonEntry.driver, team: jsonEntry.team, timeStr: jsonEntry.timeStr },
                    api: { driver, team, timeStr: parsedTime?.timeStr, timeRaw: timeCandidate },
                });
            }

            await sleep(150); // rate limit gentile verso l'API pubblica
        }
    }

    // Stesso circuito due volte nello stesso anno (es. Red Bull Ring 2021:
    // GP di Stiria e GP d'Austria) ma data.json ha una sola voce per
    // anno+circuito: se UNA delle due gare combacia, l'altra non è un errore.
    const verified = [];
    for (let i = mismatches.length - 1; i >= 0; i--) {
        const key = `${mismatches[i].year}|${mismatches[i].circuit}`;
        if (matchedKeys.has(key)) {
            mismatches.splice(i, 1);
        } else if (VERIFIED_API_ERRORS[key]) {
            verified.push(`${mismatches[i].year} ${mismatches[i].circuit}: ${VERIFIED_API_ERRORS[key]}`);
            mismatches.splice(i, 1);
        }
    }

    const orphanEntries = currentData.filter(d => !seenKeys.has(`${d.year}|${d.circuit}`));

    console.log('\n========== RISULTATO VERIFICA ==========');
    console.log(`Round controllati: ${checked}`);
    console.log(`Circuiti non mappabili (${unmapped.length}):`);
    unmapped.forEach(u => console.log('  - ' + u));
    console.log(`Entry mancanti in data.json (${missingInJson.length}):`);
    missingInJson.forEach(m => console.log('  - ' + m));
    console.log(`Entry in data.json mai incontrate nello scan (${orphanEntries.length}, spesso perché la stagione non è ancora arrivata a quel round):`);
    orphanEntries.forEach(o => console.log(`  - ${o.year} ${o.circuit}: ${o.driver}`));
    console.log(`Errori noti di f1api.dev, già verificati (${verified.length}):`);
    verified.forEach(v => console.log('  - ' + v));
    console.log(`\nDISCREPANZE DA RIVEDERE (${mismatches.length}):`);
    mismatches.forEach(m => {
        console.log(`\n--- ${m.year} ${m.circuit} (${m.raceName}) ---`);
        console.log(`  data.json: ${m.json.driver} | ${m.json.team} | ${m.json.timeStr}`);
        console.log(`  API:       ${m.api.driver} | ${m.api.team} | ${m.api.timeStr}`);
    });
    console.log('==========================================');
    console.log('\nNOTA: questo script segnala solo — non modifica data.json. Le discrepanze');
    console.log('vanno valutate a mano (potrebbero essere errori di battitura, ma anche casi');
    console.log('di penalità post-qualifica: vedi il campo penaltyNote e check-pole-penalty.js).');
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
