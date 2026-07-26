// scripts/lib/session-results.js
//
// Normalizzazione dei risultati di sessione (prove libere, qualifiche, gara)
// dal formato f1api.dev al formato usato dal sito: array di
// {position, driver, team, time, retired?}. Condivisa tra update-calendar.js
// (stagione in corso) e build-history.js (stagioni passate) per non
// duplicare la stessa logica in due posti.

const { matchTeam } = require('./f1-mapping');

// Sessioni di cui scarichiamo i risultati completi: niente sprint, l'API non
// espone un endpoint dedicato ai loro risultati (provati vari nomi
// plausibili - sprint, sprintQualy, sprintRace, sprint-qualifying - tutti 404).
const SESSION_RESULT_KEYS = ['fp1', 'fp2', 'fp3', 'qualy', 'race'];

function driverFullName(driver) {
    return [driver?.name, driver?.surname].filter(Boolean).join(' ').trim();
}

// L'API restituisce i tempi di giro secco con la virgola dei millesimi come
// ":" invece di "." per alcune stagioni/round (es. "1:29:179" invece di
// "1:29.179", osservato su round del 2024): normalizziamo per la sola
// visualizzazione (non serve il valore numerico qui, solo la stringa).
function normalizeLapTimeDisplay(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const m = raw.match(/^(\d{1,2}):(\d{2}):(\d{1,3})$/);
    if (m) return `${m[1]}:${m[2]}.${m[3]}`;
    return raw;
}

// Normalizza i risultati di una sessione (già scaricata) nel formato usato
// dal sito: array di {position, driver, team, time, retired?}.
function normalizeSessionResults(key, racesNode) {
    if (!racesNode) return null;

    if (key === 'qualy') {
        const rows = racesNode.qualyResults;
        if (!Array.isArray(rows) || rows.length === 0) return null;
        return rows
            .slice()
            .sort((a, b) => (Number(a.gridPosition) || 999) - (Number(b.gridPosition) || 999))
            .map((r, i) => ({
                position: Number(r.gridPosition) || i + 1,
                driver: driverFullName(r.driver),
                team: matchTeam(r.team?.teamName || r.team?.teamId || ''),
                time: normalizeLapTimeDisplay(r.q3 || r.q2 || r.q1) || '-',
            }));
    }

    if (key === 'race') {
        const rows = racesNode.results;
        if (!Array.isArray(rows) || rows.length === 0) return null;
        return rows
            .slice()
            .sort((a, b) => (Number(a.position) || 999) - (Number(b.position) || 999))
            .map((r, i) => ({
                position: Number(r.position) || i + 1,
                driver: driverFullName(r.driver),
                team: matchTeam(r.team?.teamName || r.team?.teamId || ''),
                time: r.retired ? null : (r.time || '-'),
                retired: r.retired || null,
            }));
    }

    // fp1 / fp2 / fp3: niente campo "position" nella risposta. L'array è già
    // ordinato per tempo (il più veloce prima) TRA chi un tempo l'ha segnato,
    // ma i piloti senza tempo (time: null, es. sessione saltata) possono
    // comparire mescolati in mezzo agli altri invece che in fondo: li
    // spostiamo esplicitamente alla fine prima di assegnare la posizione.
    const rows = racesNode[`${key}Results`];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const withTime = rows.filter(r => r.time);
    const withoutTime = rows.filter(r => !r.time);
    return [...withTime, ...withoutTime].map((r, i) => ({
        position: i + 1,
        driver: driverFullName(r.driver),
        team: matchTeam(r.team?.teamName || r.team?.teamId || ''),
        time: normalizeLapTimeDisplay(r.time) || '-',
    }));
}

module.exports = {
    SESSION_RESULT_KEYS,
    driverFullName,
    normalizeLapTimeDisplay,
    normalizeSessionResults,
};
