// scripts/lib/auto-circuits.js
//
// Circuiti nuovi riconosciuti in automatico, senza aggiungere righe a mano
// alle tabelle di openf1.js (OpenF1), f1-mapping.js (id Jolpica) e weather.js
// (meteo). Li "impara" lib/season-calendar.js appena compaiono nel calendario
// (update-calendar.js) e li salva in auto-circuits.json; tutte le tabelle
// scritte a mano hanno sempre la precedenza.
//
//   - nome del sito: la città (es. "Madrid")
//   - id Jolpica: collegato per data, la gara Jolpica dello stesso giorno è lo
//     stesso circuito
//   - meteo: coordinate del circuito da Jolpica, fuso orario da Open-Meteo
//
// Formato di auto-circuits.json:
// { openf1: { circuit_short_name: name },
//   jolpica: { circuitId: name },
//   weather: { name: { lat, lon, tz, night } },
//   added: { name: "AAAA-MM-GG" } }

const fs = require('fs');
const path = require('path');

const AUTO_PATH = path.join(__dirname, '..', '..', 'auto-circuits.json');
const EMPTY = () => ({ openf1: {}, jolpica: {}, weather: {}, added: {} });

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
    return Object.entries(loadAutoCircuits().added)
        .filter(([, date]) => String(date).startsWith(String(year)))
        .map(([name]) => name);
}

module.exports = { AUTO_PATH, loadAutoCircuits, saveAutoCircuits, autoCircuitsAddedIn };
