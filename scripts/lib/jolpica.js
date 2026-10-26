// scripts/lib/jolpica.js
//
// Jolpica (api.jolpi.ca, archivio storico F1 erede di Ergast, gratuito e
// senza chiave): ripiego quando OpenF1 non risponde (OpenF1 gratuita è
// bloccata durante le sessioni live) e unica fonte prima del 2023, che OpenF1
// non copre. Ha calendario con orari, qualifiche, risultati con griglia di
// partenza e classifiche; non ha le prove libere.
//
// Confronti del 2026-10-26: calendario 2026 identico a OpenF1 (anche gli
// orari); risultati 2021-2022 identici a quelli del sito tranne un distacco
// sbagliato di Jolpica (Portimão 2021, Alonso +1.808 invece di +1:04.808) e il
// tempo di pole di Miami 2025 mancante.

const { fetchJson, sleep } = require('./http');
const { matchTeam } = require('./f1-mapping');
const { siteDriverName } = require('./driver-names');

// Limite pubblico: 4 richieste al secondo (e 500 l'ora): una ogni 300 ms.
const MIN_INTERVAL_MS = 300;
let nextSlot = 0;
async function jolpicaJson(pathAndQuery) {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
    if (wait > 0) await sleep(wait);
    return fetchJson(`https://api.jolpi.ca/ergast/f1/${pathAndQuery}`, { retries: 3 });
}

// Tutte le gare di un endpoint, unendo le pagine (massimo 100 righe per
// risposta: una gara può essere divisa tra due pagine).
async function jolpicaRaces(path) {
    const byRound = new Map();
    for (let offset = 0; ; offset += 100) {
        const j = await jolpicaJson(`${path}.json?limit=100&offset=${offset}`);
        for (const r of j.MRData.RaceTable?.Races || []) {
            if (!byRound.has(r.round)) byRound.set(r.round, { ...r, QualifyingResults: [], Results: [] });
            const t = byRound.get(r.round);
            t.QualifyingResults.push(...(r.QualifyingResults || []));
            t.Results.push(...(r.Results || []));
        }
        if (offset + 100 >= Number(j.MRData.total)) break;
    }
    return [...byRound.values()].sort((a, b) => Number(a.round) - Number(b.round));
}

const jolpicaDriver = (d, names) => siteDriverName({ first_name: d.givenName, last_name: d.familyName }, names);

// Classifica di gara nel formato del sito: {position, driver, team, time, retired}.
function jolpicaRaceRows(race, names) {
    return race.Results.slice().sort((a, b) => Number(a.position) - Number(b.position)).map(r => {
        const status = r.status || '';
        let time = null, retired = null;
        if (r.Time?.time) time = r.Time.time;
        else if (/^\+\d+ Laps?$/i.test(status)) {
            const laps = parseInt(status.replace(/\D/g, ''), 10);
            time = `+${laps} ${laps === 1 ? 'giro' : 'giri'}`;
        } else if (/disqualif/i.test(status) || r.positionText === 'D') retired = 'Squalificato';
        else if (/did not start|withdrew/i.test(status) || r.positionText === 'W') retired = 'Non partito';
        else if (r.positionText === 'N') retired = 'Non classificato';
        else if (status && status !== 'Finished') retired = 'Ritirato';
        else time = '-';
        return { position: Number(r.position), driver: jolpicaDriver(r.Driver, names), team: matchTeam(r.Constructor?.name || ''), time, retired };
    });
}

// Qualifica nel formato del sito: {position, driver, team, time, penalty?}.
// Con i risultati di gara (resultsRace) l'ordine è quello della griglia di
// partenza, come per OpenF1, con penalty: true per chi parte più indietro
// della sua posizione di qualifica (griglia 0 = pit lane, in fondo); senza,
// l'ordine è quello della qualifica.
function jolpicaQualyRows(qualyRace, names, resultsRace = null) {
    const rows = qualyRace.QualifyingResults.slice().sort((a, b) => Number(a.position) - Number(b.position));
    const grid = new Map((resultsRace?.Results || []).map(r => [r.Driver.driverId, Number(r.grid) || 99]));
    const ordered = grid.size ? rows.slice().sort((a, b) => (grid.get(a.Driver.driverId) ?? 99) - (grid.get(b.Driver.driverId) ?? 99)) : rows;
    return ordered.map((r, i) => ({
        position: i + 1,
        driver: jolpicaDriver(r.Driver, names),
        team: matchTeam(r.Constructor?.name || ''),
        time: r.Q3 || r.Q2 || r.Q1 || '-',
        ...(grid.size && (grid.get(r.Driver.driverId) ?? 99) > Number(r.position) ? { penalty: true } : {}),
    }));
}

module.exports = { jolpicaJson, jolpicaRaces, jolpicaDriver, jolpicaRaceRows, jolpicaQualyRows };
