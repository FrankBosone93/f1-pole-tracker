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

// Il file va in git e ogni modifica produce un commit e un nuovo deploy di
// Pages: riscriverlo ad ogni run (anche "a vuoto") generava decine di commit
// inutili solo per aggiornare lastRun. Si riscrive quindi solo se cambia
// l'esito/l'errore, oppure se l'ultimo lastRun è più vecchio di questa soglia
// (così l'indicatore del sito resta una conferma recente di funzionamento).
const REFRESH_AFTER_HOURS = 6;

function writeStatus(key, ok, error = null) {
    if (!fs.existsSync(STATUS_DIR)) fs.mkdirSync(STATUS_DIR, { recursive: true });
    const filePath = path.join(STATUS_DIR, `${key}.json`);
    const newError = ok ? null : error;

    if (fs.existsSync(filePath)) {
        try {
            const previous = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const ageHours = (Date.now() - new Date(previous.lastRun).getTime()) / 3600000;
            if (previous.ok === ok && previous.error === newError && ageHours < REFRESH_AFTER_HOURS) return;
        } catch (err) {
            // file illeggibile: lo si riscrive sotto
        }
    }

    const payload = { ok, lastRun: new Date().toISOString(), error: newError };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

module.exports = { writeStatus };
