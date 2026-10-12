// scripts/check-pole-penalty.js
//
// Gira DOPO la gara (a differenza di update-poles.js, che gira dopo la
// qualifica), quando f1api.dev ha anche i risultati di gara con la griglia di
// partenza REALE (campo "grid" in "{anno}/{round}/race"). Se il pilota che ha
// ottenuto la pole in qualifica non è partito P1 in griglia (penalità), lo
// segnala aggiungendo un campo "penaltyNote" alla entry corrispondente in
// data.json — la pole resta assegnata al più veloce in qualifica (invariata),
// si aggiunge solo un avviso sintetico su chi è partito davanti per davvero.
//
// Uso manuale: node scripts/check-pole-penalty.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById, normalize, driverFullName } = require('./lib/f1-mapping');
const { writeStatus } = require('./lib/status');
const { HttpError, fetchJson } = require('./lib/http');

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');
const CURRENT_URL = 'https://f1api.dev/api/current';

// Quante delle ultime gare già disputate ricontrollare a ogni run: coprono un
// run saltato o un 404 temporaneo senza riscaricare l'intera stagione.
const RECENT_RACES = 3;

// Dopo la gara l'API può dare 404 per ore prima di pubblicare i risultati.
// Entro questa finestra non è un errore: si riprova al run successivo.
const PENDING_GRACE_HOURS = 72;

// Controlla la penalità di un singolo round. Ritorna true se currentData
// (in memoria) è cambiato.
async function checkRound(season, round, currentData) {
    const url = `https://f1api.dev/api/${season}/${round}/race`;
    console.log(`Richiesta a ${url} ...`);
    const payload = await fetchJson(url);

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
        console.log(`Round ${round}: nessun risultato di gara ancora disponibile. Nessuna azione.`);
        return false;
    }

    // --- Carica la entry già scritta da update-poles.js per questo anno+circuito ---
    const existingIndex = currentData.findIndex(d => d.year === year && d.circuit === mappedCircuit);
    if (existingIndex === -1) {
        console.log(`Nessuna entry in data.json per ${year} - ${mappedCircuit} (la qualifica non è ancora stata registrata?). Nessuna azione.`);
        return false;
    }
    const entry = currentData[existingIndex];

    // Trova il polista registrato (fastest in qualifica) tra i risultati di gara,
    // confrontando per nome (case/accenti-insensitive tramite normalize).
    const poleNormalized = normalize(entry.driver);
    const poleResultRow = results.find(r => normalize(driverFullName(r.driver)) === poleNormalized);

    if (!poleResultRow) {
        console.log(`⚠️  Pilota "${entry.driver}" (pole in qualifica) non trovato tra i risultati di gara. Impossibile verificare la griglia di partenza. Nessuna azione.`);
        return false;
    }

    const poleGrid = parseInt(poleResultRow.grid, 10);
    const frontRowRow = results.find(r => parseInt(r.grid, 10) === 1);

    if (!frontRowRow || poleGrid === 1) {
        // Nessuna penalità: il polista è partito davanti. Rimuovi un eventuale
        // avviso stale (non dovrebbe succedere, ma per sicurezza).
        if (entry.penaltyNote) {
            delete entry.penaltyNote;
            console.log(`Nessuna penalità: rimosso un penaltyNote obsoleto per ${year} - ${mappedCircuit}.`);
            return true;
        }
        console.log(`Nessuna penalità per ${entry.driver} (${year} - ${mappedCircuit}): partito regolarmente P1. Nessuna azione.`);
        return false;
    }

    const frontRowName = driverFullName(frontRowRow.driver);
    const note = `Pole in qualifica, ma partito P${poleGrid} in griglia per una penalità: il via al palo è stato di ${frontRowName}.`;
    if (entry.penaltyNote !== note) {
        entry.penaltyNote = note;
        console.log(`🚩 Penalità rilevata per ${entry.driver} (${year} - ${mappedCircuit}): ${note}`);
        return true;
    }
    console.log('penaltyNote già presente e corretto. Nessuna azione.');
    return false;
}

async function main() {
    // Non usiamo /api/current/last/race: come per last/qualy si è rivelato
    // inaffidabile (404 per ore/giorni dopo la gara, mentre l'endpoint per
    // round esplicito aveva già i dati). Si trovano nel calendario le ultime
    // gare disputate e si interrogano per round.
    console.log(`Richiesta a ${CURRENT_URL} ...`);
    const currentPayload = await fetchJson(CURRENT_URL);
    const season = currentPayload.season;
    const races = currentPayload.races || [];
    if (!season || races.length === 0) {
        throw new Error('Calendario stagione corrente vuoto o senza campo "season".');
    }

    const now = new Date();
    // Gara senza orario nel calendario: disputata dal giorno dopo la sua data.
    const raceStart = r => {
        const q = r.schedule?.race;
        if (!q?.date) return null;
        const d = q.time ? new Date(`${q.date}T${q.time}`) : new Date(`${q.date}T23:59:59Z`);
        return isNaN(d) ? null : d;
    };
    const recent = races
        .filter(r => { const d = raceStart(r); return d && d <= now; })
        .sort((a, b) => a.round - b.round)
        .slice(-RECENT_RACES);
    if (recent.length === 0) {
        console.log('Nessuna gara ancora disputata nella stagione corrente. Nessuna azione.');
        return;
    }

    const currentData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
    let changed = false;
    const errors = [];
    for (const race of recent) {
        try {
            if (await checkRound(season, race.round, currentData)) changed = true;
        } catch (err) {
            const hoursSince = (now - raceStart(race)) / 3600000;
            if (err instanceof HttpError && err.status === 404 && hoursSince < PENDING_GRACE_HOURS) {
                console.warn(`⏳ Round ${race.round}: risultati di gara non ancora pubblicati (404, gara conclusa ${hoursSince.toFixed(1)}h fa): riproverò al prossimo run.`);
            } else {
                console.error(`❌ Round ${race.round}: ${err.message}`);
                errors.push(`round ${race.round}: ${err.message}`);
            }
        }
    }

    if (changed) {
        fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(currentData, null, 2) + '\n', 'utf-8');
        console.log(`✅ data.json aggiornato: ${DATA_JSON_PATH}`);
    }

    if (errors.length > 0) throw new Error(errors.join(' | '));
}

main()
    .then(() => writeStatus('penalty', true))
    .catch(err => {
        console.error('❌ Errore durante il controllo penalità:', err.message);
        writeStatus('penalty', false, err.message);
        process.exit(1);
    });
