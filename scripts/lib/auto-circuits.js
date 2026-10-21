// scripts/lib/auto-circuits.js
//
// Circuiti nuovi riconosciuti in automatico, senza aggiungere righe a mano
// alle tabelle di f1-mapping.js (f1api.dev), openf1.js (OpenF1) e weather.js
// (meteo). Li "impara" update-calendar.js appena compaiono nel calendario e
// li salva in auto-circuits.json; tutte le tabelle scritte a mano hanno
// sempre la precedenza.
//
//   - nome del sito: la città indicata da f1api.dev (es. "Madrid")
//   - nome OpenF1: collegato per data, la gara OpenF1 dello stesso giorno
//     di quella del calendario è lo stesso circuito
//   - meteo: coordinate e fuso orario dalla ricerca località di Open-Meteo
//
// Formato di auto-circuits.json:
// { f1api: { circuitId: { name, addedAt } },
//   openf1: { circuit_short_name: name },
//   weather: { name: { lat, lon, tz, night } } }

const fs = require('fs');
const path = require('path');

const AUTO_PATH = path.join(__dirname, '..', '..', 'auto-circuits.json');
const EMPTY = () => ({ f1api: {}, openf1: {}, weather: {} });

function loadAutoCircuits() {
    try {
        return { ...EMPTY(), ...JSON.parse(fs.readFileSync(AUTO_PATH, 'utf-8')) };
    } catch {
        return EMPTY();
    }
}

function saveAutoCircuits(data) {
    fs.writeFileSync(AUTO_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// Nomi dei circuiti aggiunti in automatico in un dato anno (per la riga
// informativa della notifica del lunedì).
function autoCircuitsAddedIn(year) {
    return Object.values(loadAutoCircuits().f1api)
        .filter(e => String(e.addedAt || '').startsWith(String(year)))
        .map(e => e.name);
}

module.exports = { AUTO_PATH, loadAutoCircuits, saveAutoCircuits, autoCircuitsAddedIn };
