// scripts/lib/standings-fresh.js
//
// standings.json comprende già la gara indicata? updatedAt è l'ultima
// modifica del file (update-standings.js lo riscrive solo quando la classifica
// cambia), quindi basta che sia successivo alla fine della gara. Confrontare
// solo il giorno non bastava: nei weekend sprint in America (gara alle 19-20
// UTC) il run della domenica alle 18:47 UTC aggiunge i punti della sprint
// prima del via, con la stessa data della gara. Usato da notify-gp.js e
// build-stats.js.

// Margine dopo il via: nessuna gara finisce prima di un'ora.
const MIN_RACE_DURATION_MS = 60 * 60000;

function standingsIncludeRace(standings, season, race) {
    if (!standings?.updatedAt || String(standings.season) !== String(season)) return false;
    const date = race?.schedule?.race?.date || race?.date;
    if (!date) return false;
    const start = new Date(`${date}T${race.schedule?.race?.time || '00:00:00Z'}`).getTime();
    return new Date(standings.updatedAt).getTime() >= start + MIN_RACE_DURATION_MS;
}

module.exports = { standingsIncludeRace };
