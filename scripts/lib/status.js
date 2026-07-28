// scripts/lib/status.js
//
// Scrive lo stato di salute di un'automazione (una per file, in status/) dopo
// ogni esecuzione, sia in caso di successo che di errore. Il sito legge
// questi file per mostrare l'indicatore "API correttamente funzionanti" in
// alto a sinistra: un file per script, mai condiviso, così due workflow
// schedulati alla stessa ora (es. update-poles.yml e update-telemetry.yml)
// non rischiano mai di scriversi a vicenda sopra o di scontrarsi al push.
//
// "ok:true" significa "lo script ha girato e l'API ha risposto
// correttamente", non "c'erano dati nuovi": anche un run che non trova
// nulla da aggiornare scrive ok:true con lastRun aggiornato, per non far
// scattare falsi allarmi nei periodi senza gare.

const fs = require('fs');
const path = require('path');

const STATUS_DIR = path.join(__dirname, '..', '..', 'status');

function writeStatus(key, ok, error = null) {
    if (!fs.existsSync(STATUS_DIR)) fs.mkdirSync(STATUS_DIR, { recursive: true });
    const filePath = path.join(STATUS_DIR, `${key}.json`);
    const payload = { ok, lastRun: new Date().toISOString(), error: ok ? null : error };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

module.exports = { writeStatus };
