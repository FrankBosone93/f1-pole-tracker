// scripts/check-pole-penalty.js
//
// Controlla la griglia di partenza REALE delle ultime gare: fonte principale
// OpenF1 (starting_grid della qualifica, penalità già applicate, pubblicata
// prima della gara), ripiego Jolpica (campo "grid" dei risultati di gara;
// prima era f1api.dev, eliminato il 2026-10-26).
// Se il pilota che ha
// ottenuto la pole in qualifica non è partito P1 in griglia (penalità), lo
// segnala aggiungendo un campo "penaltyNote" alla entry corrispondente in
// data.json — la pole resta assegnata al più veloce in qualifica (invariata),
// si aggiunge solo un avviso sintetico su chi è partito davanti per davvero.
//
// Uso manuale: node scripts/check-pole-penalty.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById } = require('./lib/f1-mapping');
const { loadSeasonCalendar } = require('./lib/season-calendar');
const { jolpicaRaces } = require('./lib/jolpica');
const { writeStatus } = require('./lib/status');
const { HttpError } = require('./lib/http');
const { openf1Json, CIRCUIT_MAP } = require('./lib/openf1');
const { surnameKey } = require('./lib/driver-names');

// Griglia da OpenF1: { poleGrid, frontRowName } del polista registrato, o
// null se OpenF1 non ha (ancora) la griglia.
async function gridFromOpenF1(session, poleDriver) {
    let grid;
    try { grid = await openf1Json(`https://api.openf1.org/v1/starting_grid?session_key=${session.session_key}`); }
    catch (err) { if (err.status === 404) return null; throw err; }
    if (!grid.length) return null;
    const drivers = await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`);
    const byNumber = new Map(drivers.map(d => [d.driver_number, d]));
    const pole = grid.find(g => surnameKey(byNumber.get(g.driver_number)?.last_name) === surnameKey(poleDriver));
    const front = grid.find(g => g.position === 1);
    if (!pole || !front) return null;
    const f = byNumber.get(front.driver_number) || {};
    return { poleGrid: pole.position, frontRowName: [f.first_name, f.last_name].filter(Boolean).join(' ') };
}

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');

// Quante delle ultime gare già disputate ricontrollare a ogni run: coprono un
// run saltato o un 404 temporaneo senza riscaricare l'intera stagione.
const RECENT_RACES = 3;

// Dopo la gara l'API può dare 404 per ore prima di pubblicare i risultati.
// Entro questa finestra non è un errore: si riprova al run successivo.
const PENDING_GRACE_HOURS = 72;

// Controlla la penalità di un singolo round. Ritorna true se currentData
// (in memoria) è cambiato. Il circuito viene dal calendario (/current), così
// OpenF1 si può interrogare anche se Jolpica non ha ancora i risultati.
async function checkRound(season, race, currentData, openf1Sessions) {
    const round = race.round;
    const mappedCircuit = race.circuit;
    const year = parseInt(season, 10);
    if (!year || isNaN(year)) {
        throw new Error(`Anno stagione non valido: "${season}"`);
    }
    console.log(`Round ${round} (${mappedCircuit}):`);

    // --- Carica la entry già scritta da update-poles.js per questo anno+circuito ---
    const entry = currentData.find(d => d.year === year && d.circuit === mappedCircuit);
    if (!entry) {
        console.log(`Nessuna entry in data.json per ${year} - ${mappedCircuit} (la qualifica non è ancora stata registrata?). Nessuna azione.`);
        return false;
    }

    // 1. OpenF1 (principale)
    const session = (openf1Sessions || []).find(s => CIRCUIT_MAP[s.circuit_short_name] === mappedCircuit);
    if (session) {
        try {
            const g = await gridFromOpenF1(session, entry.driver);
            if (g) {
                console.log(`   griglia da OpenF1: ${entry.driver} parte ${g.poleGrid}°`);
                return applyGrid(entry, year, mappedCircuit, g);
            }
        } catch (err) {
            console.warn(`   ⚠️  OpenF1: ${err.message} - uso Jolpica.`);
        }
    }

    // 2. Jolpica (ripiego): griglia dai risultati di gara.
    const path = `${season}/${round}/results`;
    console.log(`   Jolpica: ${path}`);
    const [j] = await jolpicaRaces(path);
    const results = j && matchCircuitById(j.Circuit?.circuitId) === mappedCircuit ? j.Results : [];
    if (!results.length) throw new HttpError(404, `https://api.jolpi.ca/ergast/f1/${path}`);
    const poleRow = results.find(r => surnameKey(r.Driver.familyName) === surnameKey(entry.driver));
    if (!poleRow) {
        console.log(`⚠️  Pilota "${entry.driver}" (pole in qualifica) non trovato tra i risultati di gara. Impossibile verificare la griglia di partenza. Nessuna azione.`);
        return false;
    }
    const front = results.find(r => r.grid === '1');
    return applyGrid(entry, year, mappedCircuit, {
        poleGrid: parseInt(poleRow.grid, 10),
        frontRowName: front ? `${front.Driver.givenName} ${front.Driver.familyName}` : null,
    });
}

function applyGrid(entry, year, mappedCircuit, grid) {
    if (!grid) return false;
    const { poleGrid, frontRowName } = grid;
    if (!frontRowName || poleGrid === 1) {
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

    // Una nota già presente (spesso scritta a mano con il motivo preciso) non
    // si sovrascrive con quella generica.
    if (entry.penaltyNote) {
        console.log(`Polista partito ${poleGrid}°: nota già presente, lasciata com'è.`);
        return false;
    }
    const note = `Pole in qualifica, ma partito ${poleGrid}° in griglia per una penalità: il via al palo è stato di ${frontRowName}.`;
    if (entry.penaltyNote !== note) {
        entry.penaltyNote = note;
        console.log(`🚩 Penalità rilevata per ${entry.driver} (${year} - ${mappedCircuit}): ${note}`);
        return true;
    }
    console.log('penaltyNote già presente e corretto. Nessuna azione.');
    return false;
}

async function main() {
    const { season, races } = await loadSeasonCalendar();

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
    let openf1Sessions = null;
    try {
        openf1Sessions = await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}&session_name=Qualifying`);
    } catch (err) {
        console.warn(`⚠️  OpenF1 non disponibile (${err.message}): griglia da Jolpica.`);
    }
    let changed = false;
    const errors = [];
    for (const race of recent) {
        try {
            if (await checkRound(season, race, currentData, openf1Sessions)) changed = true;
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
