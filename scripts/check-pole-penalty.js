// scripts/check-pole-penalty.js
//
// Gira DOPO la gara (a differenza di update-poles.js, che gira dopo la
// qualifica), quando f1api.dev ha anche i risultati di gara con la griglia di
// partenza REALE (campo "grid" in "current/last/race"). Se il pilota che ha
// ottenuto la pole in qualifica non è partito P1 in griglia (penalità), lo
// segnala aggiungendo un campo "penaltyNote" alla entry corrispondente in
// data.json — la pole resta assegnata al più veloce in qualifica (invariata),
// si aggiunge solo un avviso sintetico su chi è partito davanti per davvero.
//
// Uso manuale: node scripts/check-pole-penalty.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById, normalize, driverFullName } = require('./lib/f1-mapping');

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');
const API_URL = 'https://f1api.dev/api/current/last/race';

async function main() {
    console.log(`Richiesta a ${API_URL} ...`);
    const response = await fetch(API_URL);
    if (!response.ok) {
        throw new Error(`Risposta API non valida: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    console.log('Struttura risposta ricevuta (troncata):', JSON.stringify(payload).slice(0, 1500));

    const season = payload.season || payload?.races?.season;
    const racesNode = payload.races;
    if (!racesNode) {
        throw new Error('Campo "races" non trovato nella risposta API.');
    }

    const circuitInfo = Array.isArray(racesNode.circuit) ? racesNode.circuit[0] : racesNode.circuit;
    const mappedCircuit = matchCircuitById(circuitInfo?.circuitId);
    if (!mappedCircuit) {
        throw new Error(
            `Circuito con circuitId="${circuitInfo?.circuitId}" non riconosciuto. ` +
            `Aggiungere una voce a CIRCUIT_ID_MAP in scripts/lib/f1-mapping.js.`
        );
    }

    const year = parseInt(season, 10);
    if (!year || isNaN(year)) {
        throw new Error(`Anno stagione non valido: "${season}"`);
    }

    const results = racesNode.results || [];
    if (!Array.isArray(results) || results.length === 0) {
        console.log('Nessun risultato di gara ancora disponibile per questo round (probabilmente la gara non è ancora stata disputata). Nessuna azione.');
        return;
    }

    // --- Carica la entry già scritta da update-poles.js per questo anno+circuito ---
    const currentData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
    const existingIndex = currentData.findIndex(d => d.year === year && d.circuit === mappedCircuit);
    if (existingIndex === -1) {
        console.log(`Nessuna entry in data.json per ${year} - ${mappedCircuit} (la qualifica non è ancora stata registrata?). Nessuna azione.`);
        return;
    }
    const entry = currentData[existingIndex];

    // Trova il polista registrato (fastest in qualifica) tra i risultati di gara,
    // confrontando per nome (case/accenti-insensitive tramite normalize).
    const poleNormalized = normalize(entry.driver);
    const poleResultRow = results.find(r => normalize(driverFullName(r.driver)) === poleNormalized);

    if (!poleResultRow) {
        console.log(`⚠️  Pilota "${entry.driver}" (pole in qualifica) non trovato tra i risultati di gara. Impossibile verificare la griglia di partenza. Nessuna azione.`);
        return;
    }

    const poleGrid = parseInt(poleResultRow.grid, 10);
    const frontRowRow = results.find(r => parseInt(r.grid, 10) === 1);

    let changed = false;

    if (!frontRowRow || poleGrid === 1) {
        // Nessuna penalità: il polista è partito davanti. Rimuovi un eventuale
        // avviso stale (non dovrebbe succedere, ma per sicurezza).
        if (entry.penaltyNote) {
            delete entry.penaltyNote;
            changed = true;
            console.log(`Nessuna penalità: rimosso un penaltyNote obsoleto per ${year} - ${mappedCircuit}.`);
        } else {
            console.log(`Nessuna penalità per ${entry.driver} (${year} - ${mappedCircuit}): partito regolarmente P1. Nessuna azione.`);
        }
    } else {
        const frontRowName = driverFullName(frontRowRow.driver);
        const note = `Pole in qualifica, ma partito P${poleGrid} in griglia per una penalità: il via al palo è stato di ${frontRowName}.`;
        if (entry.penaltyNote !== note) {
            entry.penaltyNote = note;
            changed = true;
            console.log(`🚩 Penalità rilevata per ${entry.driver} (${year} - ${mappedCircuit}): ${note}`);
        } else {
            console.log('penaltyNote già presente e corretto. Nessuna azione.');
        }
    }

    if (changed) {
        fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(currentData, null, 2) + '\n', 'utf-8');
        console.log(`✅ data.json aggiornato: ${DATA_JSON_PATH}`);
    }
}

main().catch(err => {
    console.error('❌ Errore durante il controllo penalità:', err.message);
    process.exit(1);
});
