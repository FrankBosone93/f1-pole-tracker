// scripts/lib/openf1-results.js
//
// Classifiche di sessione da OpenF1 (session_result + drivers) nel formato
// del sito, condivise tra update-calendar.js (stagione in corso) e
// build-history.js (stagioni passate, dal 2023: OpenF1 non ha dati prima).

const { openf1Json } = require('./openf1');
const { matchTeam } = require('./f1-mapping');
const { siteDriverName } = require('./driver-names');

// Prove libere da OpenF1 quando f1api.dev non le ha (Austin 2026: ancora
// nessun risultato la domenica, e dal lunedì il GP non è più in evidenza,
// quindi le libere non sarebbero mai state salvate). Stesso formato del sito:
// [{position, driver, team, time}], con i nomi dei piloti riportati a quelli
// già usati sul sito (lib/driver-names.js).
const fmtLap = sec => {
    const m = Math.floor(sec / 60), rest = sec - m * 60;
    return `${m}:${rest.toFixed(3).padStart(6, '0')}`;
};
async function openf1PracticeResults(session, driverNames) {
    const [rows, drivers] = [
        await openf1Json(`https://api.openf1.org/v1/session_result?session_key=${session.session_key}`),
        await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`),
    ];
    if (!rows.length) return null;
    const byNumber = new Map(drivers.map(d => [d.driver_number, d]));
    const withTime = rows.filter(r => typeof r.duration === 'number').sort((a, b) => a.duration - b.duration);
    const withoutTime = rows.filter(r => typeof r.duration !== 'number');
    return [...withTime, ...withoutTime].map((r, i) => {
        const d = byNumber.get(r.driver_number) || {};
        return {
            position: i + 1,
            driver: siteDriverName(d, driverNames) || `#${r.driver_number}`,
            team: matchTeam(d.team_name || ''),
            time: typeof r.duration === 'number' ? fmtLap(r.duration) : '-',
        };
    });
}

// Risultati di gara da OpenF1 (classifica ufficiale, penalità post-gara
// comprese). Confronto del 2026-10-25 su 87 gare 2023-2026: in tutte le 10
// gare in cui le due fonti non coincidevano aveva ragione OpenF1 (verificato
// sulle classifiche ufficiali), mentre f1api.dev aveva penalità post-gara
// mancanti (Brasile 2024, Singapore 2025, Bahrain 2025, Barcellona e Miami
// 2026), distacchi sbagliati (Canada 2023, Brasile 2024) e ritirati in ordine
// sbagliato. f1api.dev resta il ripiego (OpenF1 è bloccata durante le
// sessioni live). Stesso formato del sito: {position, driver, team, time, retired}.
const fmtGap = sec => {
    if (sec < 60) return `+${sec.toFixed(3)}`;
    const m = Math.floor(sec / 60);
    return `+${m}:${(sec - m * 60).toFixed(3).padStart(6, '0')}`;
};
const fmtRaceTime = sec => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), rest = sec - h * 3600 - m * 60;
    return `${h}:${String(m).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
};
async function openf1RaceResults(session, driverNames) {
    const rows = await openf1Json(`https://api.openf1.org/v1/session_result?session_key=${session.session_key}`);
    if (!rows.length) return null;
    const drivers = await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`);
    const byNumber = new Map(drivers.map(d => [d.driver_number, d]));
    // Classificati in ordine di posizione; poi i non classificati (posizione
    // null), come nella classifica ufficiale: ritirati per giri percorsi,
    // poi i non partiti, ultimi gli squalificati (es. Hamilton e Leclerc ad
    // Austin 2023, che avevano completato tutti i giri).
    // Non classificati senza indicazione (OpenF1 non sempre mette dsq/dnf):
    // con quasi tutti i giri (>= 90% del vincitore) erano squalificati
    // (Austin 2023: Hamilton e Leclerc), con meno erano ancora in pista ma
    // sotto il 90% della distanza, quindi "Non classificato" (Melbourne 2026
    // Stroll, Barcellona 2026 Albon).
    const winnerLaps = Math.max(0, ...rows.filter(r => r.position).map(r => r.number_of_laps || 0));
    rows.forEach(r => {
        if (r.position || r.dnf || r.dns || r.dsq) return;
        if ((r.number_of_laps || 0) >= 0.9 * winnerLaps) r.dsq = true; else r.nc = true;
    });
    const classified = rows.filter(r => r.position).sort((a, b) => a.position - b.position);
    const rank = r => (r.dsq ? 2 : r.dns ? 1 : 0);
    const others = rows.filter(r => !r.position)
        .sort((a, b) => rank(a) - rank(b) || (b.number_of_laps || 0) - (a.number_of_laps || 0));
    return [...classified, ...others].map((r, i) => {
        const d = byNumber.get(r.driver_number) || {};
        const retired = r.dsq ? 'Squalificato' : r.dns ? 'Non partito' : r.dnf ? 'Ritirato' : r.nc ? 'Non classificato' : null;
        let time = null;
        if (!retired) {
            if (i === 0 && typeof r.duration === 'number') time = fmtRaceTime(r.duration);
            else if (typeof r.gap_to_leader === 'number') time = fmtGap(r.gap_to_leader);
            else if (typeof r.gap_to_leader === 'string') {
                const laps = parseInt(r.gap_to_leader.replace(/\D/g, ''), 10) || 1;
                time = `+${laps} ${laps === 1 ? 'giro' : 'giri'}`;
            } else time = '-';
        }
        return { position: i + 1, driver: siteDriverName(d, driverNames) || `#${r.driver_number}`, team: matchTeam(d.team_name || ''), time, retired };
    });
}

// Qualifica da OpenF1, mostrata come GRIGLIA DI PARTENZA (starting_grid,
// con le penalità già applicate): ordine della griglia, tempo migliore della
// qualifica nell'ultima fase disputata (Q3, Q2 o Q1), penalty: true per chi
// parte più indietro della sua posizione di qualifica (chi avanza solo per
// effetto degli arretramenti altrui non è marcato). Finché la griglia non è
// pubblicata, l'ordine è quello della qualifica. La pole del sito (data.json)
// resta invece il più veloce in qualifica, a prescindere dalle penalità.
// Formato del sito: {position, driver, team, time, penalty?}.
async function openf1QualyResults(session, driverNames) {
    const rows = await openf1Json(`https://api.openf1.org/v1/session_result?session_key=${session.session_key}`);
    if (!rows.length) return null;
    const drivers = await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`);
    let grid = [];
    try { grid = await openf1Json(`https://api.openf1.org/v1/starting_grid?session_key=${session.session_key}`); }
    catch (err) { if (err.status !== 404) throw err; } // 404 = griglia non ancora pubblicata
    const gridPos = new Map(grid.map(g => [g.driver_number, g.position]));
    const byNumber = new Map(drivers.map(d => [d.driver_number, d]));
    const classified = rows.filter(r => r.position).sort((a, b) => a.position - b.position);
    const others = rows.filter(r => !r.position);
    const qualyOrder = [...classified, ...others];
    const ordered = gridPos.size
        ? qualyOrder.slice().sort((a, b) => (gridPos.get(a.driver_number) ?? 99) - (gridPos.get(b.driver_number) ?? 99))
        : qualyOrder;
    return ordered.map((r, i) => {
        const d = byNumber.get(r.driver_number) || {};
        const best = [].concat(r.duration).reverse().find(v => typeof v === 'number');
        return {
            position: i + 1,
            driver: siteDriverName(d, driverNames) || `#${r.driver_number}`,
            team: matchTeam(d.team_name || ''),
            // Senza posizione = fuori dalla classifica. OpenF1 segna dsq solo a
            // volte, e a volte cancella anche il tempo degli squalificati
            // (Zandvoort 2024 Albon, Baku 2024 Gasly), quindi non si può
            // distinguere un incidente senza tempo da una squalifica:
            // "Squalificato" solo se OpenF1 lo dice, altrimenti "Non classificato".
            time: r.dsq ? 'Squalificato' : !r.position ? 'Non classificato' : (best ? fmtLap(best) : '-'),
            ...(gridPos.size && (!r.position || (gridPos.get(r.driver_number) ?? 99) > r.position) ? { penalty: true } : {}),
        };
    });
}

module.exports = { openf1PracticeResults, openf1RaceResults, openf1QualyResults };
