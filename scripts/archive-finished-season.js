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
// disputata.
//
// Uso manuale: node scripts/archive-finished-season.js

const fs = require('fs');
const path = require('path');
const { buildYear, HISTORY_DIR } = require('./build-history');
const { writeStatus } = require('./lib/status');

const CALENDAR_JSON_PATH = path.join(__dirname, '..', 'calendar.json');
const HISTORY_INDEX_PATH = path.join(HISTORY_DIR, 'index.json');

async function main() {
    const calendar = JSON.parse(fs.readFileSync(CALENDAR_JSON_PATH, 'utf-8'));
    const season = calendar.season;
    const races = calendar.races || [];
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

    console.log(`Stagione ${season} conclusa (ultima gara: round ${lastRace.round}, ${lastRace.circuit}) e non ancora archiviata: costruisco history/${season}.json...`);
    await buildYear(season);

    if (!fs.existsSync(outPath)) {
        // buildYear salta silenziosamente se f1api.dev non ha ancora dati
        // completi per quell'anno (raro, ma possibile a ridosso della fine
        // stagione): non aggiorniamo il manifest in questo caso, ci riprova
        // la settimana prossima.
        console.warn(`⚠️  history/${season}.json non è stato scritto (dati non ancora completi su f1api.dev?), riproverò al prossimo giro.`);
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

main()
    .then(() => writeStatus('history', true))
    .catch(err => {
        console.error('❌ Errore durante l\'archiviazione della stagione conclusa:', err.message);
        writeStatus('history', false, err.message);
        process.exit(1);
    });
