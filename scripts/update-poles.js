// scripts/update-poles.js
//
// Scarica automaticamente il risultato dell'ultima qualifica F1 da f1api.dev
// (API pubblica e gratuita, nessuna chiave richiesta) e aggiorna data.json
// con la pole position più recente, se non è già presente.
//
// "Pole position" = il pilota più veloce in qualifica, indipendentemente da
// eventuali penalità applicate dopo (che spostano la partenza in griglia ma
// non il risultato della qualifica). Le penalità che spostano il polista dalla
// prima casella in griglia vengono rilevate a parte da check-pole-penalty.js,
// che gira la domenica sera dopo la gara.
//
// Pensato per essere eseguito da una GitHub Action pianificata
// (vedi .github/workflows/update-poles.yml), ma funziona anche a mano:
//   node scripts/update-poles.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById, matchTeam, parseQualyTime } = require('./lib/f1-mapping');

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');
const API_URL = 'https://f1api.dev/api/current/last/qualy';

async function main() {
    console.log(`Richiesta a ${API_URL} ...`);
    const response = await fetch(API_URL);
    if (!response.ok) {
        throw new Error(`Risposta API non valida: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();

    // Log completo per debug: se la struttura reale differisce da quella attesa,
    // questo output nei log della GitHub Action aiuta a correggere lo script.
    console.log('Struttura risposta ricevuta (troncata):', JSON.stringify(payload).slice(0, 2000));

    const season = payload.season || payload?.races?.season;
    const racesNode = payload.races;
    if (!racesNode) {
        throw new Error('Campo "races" non trovato nella risposta API. Controllare i log sopra per la struttura reale.');
    }

    const raceName = racesNode.raceName || '';
    const circuitInfo = Array.isArray(racesNode.circuit) ? racesNode.circuit[0] : racesNode.circuit;
    const mappedCircuit = matchCircuitById(circuitInfo?.circuitId);

    if (!mappedCircuit) {
        throw new Error(
            `Circuito con circuitId="${circuitInfo?.circuitId}" non riconosciuto ` +
            `(gara: "${raceName}", circuitName: "${circuitInfo?.circuitName}", country: "${circuitInfo?.country}"). ` +
            `Aggiungere una nuova voce a CIRCUIT_ID_MAP in scripts/lib/f1-mapping.js.`
        );
    }

    // I risultati della qualifica possono comparire sotto nomi di campo diversi
    // a seconda della versione dell'API: proviamo le alternative più plausibili.
    const results = racesNode.qualyResults || racesNode.results || racesNode.qualy || [];
    if (!Array.isArray(results) || results.length === 0) {
        throw new Error('Nessun risultato di qualifica trovato nella risposta API.');
    }

    const poleResult = results.find(r => Number(r.gridPosition) === 1) || results[0];

    const driverFullName = [poleResult.driver?.name, poleResult.driver?.surname]
        .filter(Boolean).join(' ').trim();
    const teamRaw = poleResult.team?.teamName || poleResult.team?.teamId || '';
    const mappedTeam = matchTeam(teamRaw);

    // Tempo di pole: preferiamo q3, poi q2, poi q1, poi altri campi generici.
    const timeCandidate = poleResult.q3 || poleResult.q2 || poleResult.q1 || poleResult.time || poleResult.fastLap;
    const parsedTime = parseQualyTime(timeCandidate);

    if (!driverFullName || !mappedTeam || !parsedTime) {
        throw new Error(
            `Dati incompleti per la pole: driver="${driverFullName}", team="${mappedTeam}", ` +
            `tempo grezzo="${timeCandidate}". Controllare la struttura della risposta API nei log sopra.`
        );
    }

    const year = parseInt(season, 10);
    if (!year || isNaN(year)) {
        throw new Error(`Anno stagione non valido: "${season}"`);
    }

    console.log(`Pole rilevata: ${year} - ${mappedCircuit} - ${driverFullName} (${mappedTeam}) - ${parsedTime.timeStr}`);

    // --- Aggiornamento data.json ---
    const currentData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));

    const existingIndex = currentData.findIndex(d => d.year === year && d.circuit === mappedCircuit);
    const existingWeather = existingIndex > -1 ? currentData[existingIndex].weather : '☀️ Sereno';

    const newEntry = {
        year,
        circuit: mappedCircuit,
        driver: driverFullName,
        team: mappedTeam,
        timeStr: parsedTime.timeStr,
        seconds: parsedTime.seconds,
        weather: existingWeather,
    };

    let changed = false;
    if (existingIndex > -1) {
        const existing = currentData[existingIndex];
        const isSame = existing.driver === newEntry.driver &&
            existing.team === newEntry.team &&
            existing.timeStr === newEntry.timeStr;
        if (!isSame) {
            currentData[existingIndex] = newEntry;
            changed = true;
            console.log('Voce esistente aggiornata.');
        } else {
            console.log('Nessuna modifica: i dati erano già aggiornati.');
        }
    } else {
        currentData.push(newEntry);
        changed = true;
        console.log('Nuova voce aggiunta.');
    }

    if (changed) {
        fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(currentData, null, 2) + '\n', 'utf-8');
        console.log(`✅ data.json aggiornato: ${DATA_JSON_PATH}`);
    }
}

main().catch(err => {
    console.error('❌ Errore durante l\'aggiornamento:', err.message);
    process.exit(1);
});
