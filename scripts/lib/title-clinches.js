// scripts/lib/title-clinches.js
//
// Punti ancora in palio e gara in cui un titolo è diventato matematico.
// Usato da build-stats.js (frasi sul mondiale nei fatti del GP, titoli decisi
// nel racconto della stagione) e da notify-season.js (notifica di fine
// stagione: "deciso a ..."), così i due dicono sempre la stessa cosa.

// Punti massimi in una gara e in una Sprint: per un pilota (primo posto) e
// per una squadra (primo e secondo posto).
const MAX_RACE = 25, MAX_SPRINT = 8;
const MAX_TEAM_RACE = 25 + 18, MAX_TEAM_SPRINT = 8 + 7;
const hasSprint = r => !!r.schedule?.sprintRace?.date;

// Gara in cui un titolo è diventato matematico: la prima dopo la quale il
// distacco tra primo e secondo supera i punti ancora in palio (gare e Sprint
// rimaste nel calendario). progress = classifica dopo ogni gara (stats.json,
// season.progress: piloti e squadre con i punti).
function titleClinches(progress, races) {
    const find = team => {
        for (const p of progress) {
            const rows = team ? p.teams : p.drivers;
            const race = races.find(r => r.circuit === p.circuit);
            if (rows.length < 2 || !race) continue;
            const after = races.filter(r => r.date > race.date);
            const left = after.length * (team ? MAX_TEAM_RACE : MAX_RACE) + after.filter(hasSprint).length * (team ? MAX_TEAM_SPRINT : MAX_SPRINT);
            if (rows[0].points - rows[1].points > left) {
                return { [team ? 'squadra' : 'pilota']: team ? rows[0].team : rows[0].driver, decisoA: p.circuit, garaNumero: p.round, gareDAnticipo: after.length };
            }
        }
        return null;
    };
    return { piloti: find(false), costruttori: find(true) };
}

module.exports = { MAX_RACE, MAX_SPRINT, MAX_TEAM_RACE, MAX_TEAM_SPRINT, hasSprint, titleClinches };
