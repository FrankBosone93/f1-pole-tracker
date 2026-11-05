// scripts/archive-finished-season.js
//
// Gira ogni settimana, stessa schedulazione di update-calendar.js (dopo la
// gara): controlla se la stagione in corso (calendar.json) è appena
// terminata - l'ultima gara del calendario ha un risultato - e se sì:
//   1. genera lo storico di quell'annata (history/{anno}.json), riusando
//      buildYear() da build-history.js;
//   2. aggiunge quell'anno a history/index.json, il manifest che il sito
//      legge per popolare in automatico il pannello "Stagioni precedenti"
//      (niente più elenco fisso da aggiornare a mano).
//
// Idempotente: se history/{anno}.json esiste già, non fa nulla. Per la
// stragrande maggioranza delle esecuzioni (stagione ancora in corso) è un
// no-op istantaneo - scatta solo la settimana in cui l'ultima gara è stata
// disputata. Nelle prime settimane dopo l'ultima gara lo storico si scrive
// solo con i risultati di tutte le gare (vedi COMPLETE_DATA_WAIT_DAYS), e una
// stagione precedente rimasta senza storico (es. dopo il cambio di calendario
// di gennaio) si archivia subito.
//
// Uso manuale: node scripts/archive-finished-season.js

const fs = require('fs');
const path = require('path');
const { buildYear, HISTORY_DIR } = require('./build-history');
const { writeStatus } = require('./lib/status');

const CALENDAR_JSON_PATH = path.join(__dirname, '..', 'calendar.json');
const HISTORY_INDEX_PATH = path.join(HISTORY_DIR, 'index.json');

// Per queste settimane dopo l'ultima gara lo storico si scrive solo con i
// risultati di tutte le gare (subito dopo il GP le fonti possono non averli
// ancora tutti). Dopo si archivia comunque con quello che c'è: una gara
// rimasta senza risultati non deve bloccare l'archivio per sempre.
const COMPLETE_DATA_WAIT_DAYS = 21;
const FIRST_HISTORY_YEAR = 2021;

// Genera history/{anno}.json e aggiunge l'anno a history/index.json.
async function archiveSeason(season, { requireComplete }) {
    const outPath = path.join(HISTORY_DIR, `${season}.json`);
    await buildYear(season, { requireComplete });

    if (!fs.existsSync(outPath)) {
        // Dati ancora incompleti (o nessuna gara trovata): il manifest non si
        // aggiorna, ci riprova la settimana prossima.
        console.warn(`⚠️  history/${season}.json non è stato scritto (dati non ancora completi su OpenF1/Jolpica?), riproverò al prossimo giro.`);
        return;
    }

    let index = { years: [] };
    if (fs.existsSync(HISTORY_INDEX_PATH)) {
        index = JSON.parse(fs.readFileSync(HISTORY_INDEX_PATH, 'utf-8'));
    }
    if (!index.years.includes(season)) {
        index.years.push(season);
        index.years.sort((a, b) => b - a);
    }
    fs.writeFileSync(HISTORY_INDEX_PATH, JSON.stringify(index, null, 2) + '\n', 'utf-8');
    console.log(`✅ history/index.json aggiornato: ${JSON.stringify(index.years)}`);
}

async function main() {
    const calendar = JSON.parse(fs.readFileSync(CALENDAR_JSON_PATH, 'utf-8'));
    const season = Number(calendar.season);
    const races = calendar.races || [];

    // Rete di sicurezza: la stagione precedente non ancora archiviata (dati
    // rimasti incompleti fino al cambio di calendario di gennaio, o un run
    // saltato) si archivia adesso, con quello che le fonti hanno.
    const prev = season - 1;
    if (prev >= FIRST_HISTORY_YEAR && !fs.existsSync(path.join(HISTORY_DIR, `${prev}.json`))) {
        console.log(`Stagione ${prev} non ancora archiviata: costruisco history/${prev}.json...`);
        await archiveSeason(prev, { requireComplete: false });
    }

    if (races.length === 0) {
        console.log('Nessuna gara in calendar.json, niente da controllare.');
        return;
    }

    const lastRace = races.reduce((latest, r) => (r.round > latest.round ? r : latest));
    const seasonFinished = !!(lastRace.results && lastRace.results.race);
    if (!seasonFinished) {
        console.log(`Stagione ${season} non ancora conclusa (ultima gara: round ${lastRace.round}, ${lastRace.circuit}). Niente da fare.`);
        return;
    }

    const outPath = path.join(HISTORY_DIR, `${season}.json`);
    if (fs.existsSync(outPath)) {
        console.log(`Stagione ${season} già archiviata (history/${season}.json esiste). Niente da fare.`);
        return;
    }

    const daysSinceLastRace = (Date.now() - new Date(`${lastRace.date}T00:00:00Z`).getTime()) / 86400000;
    const requireComplete = !(daysSinceLastRace >= COMPLETE_DATA_WAIT_DAYS);
    console.log(`Stagione ${season} conclusa (ultima gara: round ${lastRace.round}, ${lastRace.circuit}) e non ancora archiviata: costruisco history/${season}.json${requireComplete ? ' (solo con dati completi)' : ''}...`);
    await archiveSeason(season, { requireComplete });
}

main()
    .then(() => writeStatus('history', true))
    .catch(err => {
        console.error('❌ Errore durante l\'archiviazione della stagione conclusa:', err.message);
        writeStatus('history', false, err.message);
        process.exit(1);
    });
