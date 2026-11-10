// scripts/lib/gp-data.js
//
// I dati di un GP dopo la gara, controllati allo stesso modo dalla notifica
// (notify-gp.js) e dal racconto del GP (build-stats.js): pole, risultati di
// gara, classifica aggiornata dopo la gara, telemetria della pole e passo
// gara. Dal 2026-11-10 il racconto si scrive solo quando ci sono tutti,
// oppure dalla scadenza qui sotto con quelli che ci sono: prima si scriveva
// subito e si riscriveva quando arrivava il passo gara, e chi toccava la
// notifica poteva leggere il racconto senza i fatti di strategia.

const { standingsIncludeRace } = require('./standings-fresh');

// Scadenza: il giorno dopo la gara alle 7:00 UTC (8:00 in Italia d'inverno),
// dopo i run di recupero del mattino. Prima la notifica aspetta i dati
// completi; da lì parte il ⚠️ con i dati che ci sono, e il racconto si scrive
// con quelli.
const warnDeadline = race => new Date(`${race.date}T07:00:00Z`).getTime() + 86400000;

// [[etichetta, presente], ...] nell'ordine mostrato dalla notifica.
function gpDataChecks({ year, race, poles, standings, telemetry, paceIndex }) {
    const circuit = race.circuit;
    return [
        ['Pole', (poles || []).some(d => d.year === year && d.circuit === circuit)],
        ['Gara', Array.isArray(race.results?.race) && race.results.race.length > 0],
        ['Classifica', !!standingsIncludeRace(standings, year, race)],
        ['Telemetria', !!telemetry?.seasons?.[year]?.circuits?.[circuit]],
        ['Passo gara', (paceIndex?.races?.[year] || []).some(r => r.circuit === circuit)],
    ];
}

module.exports = { warnDeadline, gpDataChecks };
