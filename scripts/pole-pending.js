// scripts/pole-pending.js
//
// Controllo rapido (solo file locali, nessuna API) usato dal workflow del
// calendario subito dopo aver salvato calendar.json, per non aspettare gli
// orari fissi di update-poles / update-telemetry (che su GitHub partono anche
// con ore di ritardo: Messico 2026, qualifica finita alle 22 UTC, pole salvata
// solo alle 01 di notte):
//
//   node scripts/pole-pending.js poles      -> stampa "true" se in calendar.json
//       c'è una qualifica con i risultati ma la sua pole non è in data.json;
//   node scripts/pole-pending.js telemetry  -> stampa "true" se una pole della
//       stagione con qualifica nelle ultime 72 ore non ha ancora la telemetria
//       in telemetry.json (OpenF1 la pubblica a volte dopo i risultati);
//   node scripts/pole-pending.js race       -> stampa "true" se una gara delle
//       ultime 72 ore ha i risultati in calendar.json ma la classifica non è
//       ancora aggiornata dopo la gara (standings.json) o manca il passo gara
//       (pace/index.json). Dal 2026-11-10: prima classifica, penalità e passo
//       gara aspettavano i loro orari fissi della domenica sera (dalle 18:27
//       UTC), e una gara corsa di notte o al mattino in Italia (Las Vegas,
//       Melbourne, Suzuka) restava senza dati e senza notifica per tutto il
//       giorno.
//
// Stampa "false" altrimenti. Gli orari fissi restano come recupero.

const fs = require('fs');
const path = require('path');
const { standingsIncludeRace } = require('./lib/standings-fresh');

const ROOT = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf-8'));
const RECENT_HOURS = 72;

// File che può non esserci ancora (o non essere leggibile): null.
const readOptional = f => { try { return read(f); } catch (err) { return null; } };

function sessionStart(race, key) {
    const q = race.schedule?.[key];
    return q?.date ? new Date(`${q.date}T${q.time || '23:59:59Z'}`) : null;
}
const qualyStart = race => sessionStart(race, 'qualy');

function main() {
    const mode = process.argv[2];
    const calendar = read('calendar.json');
    const season = Number(calendar.season);
    const poles = read('data.json').filter(d => d.year === season);
    const withQualy = calendar.races.filter(r => Array.isArray(r.results?.qualy) && r.results.qualy.length);

    if (mode === 'poles') {
        const missing = withQualy.filter(r => !poles.some(p => p.circuit === r.circuit));
        missing.forEach(r => console.error(`Pole mancante: ${r.circuit} (risultati qualifica già in calendar.json)`));
        console.log(missing.length > 0);
    } else if (mode === 'telemetry') {
        const telemetry = read('telemetry.json');
        const now = Date.now();
        const missing = withQualy.filter(r => {
            const start = qualyStart(r);
            return start && now - start.getTime() < RECENT_HOURS * 3600000 &&
                poles.some(p => p.circuit === r.circuit) &&
                !telemetry.seasons?.[season]?.circuits?.[r.circuit];
        });
        missing.forEach(r => console.error(`Telemetria mancante: ${r.circuit}`));
        console.log(missing.length > 0);
    } else if (mode === 'race') {
        const standings = readOptional('standings.json');
        const paceRaces = readOptional('pace/index.json')?.races?.[season] || [];
        const now = Date.now();
        const missing = calendar.races.filter(r => {
            if (!Array.isArray(r.results?.race) || !r.results.race.length) return false;
            const start = sessionStart(r, 'race');
            if (!start || start.getTime() > now || now - start.getTime() >= RECENT_HOURS * 3600000) return false;
            const what = [
                standingsIncludeRace(standings, season, r) ? null : 'classifica',
                paceRaces.some(p => p.circuit === r.circuit) ? null : 'passo gara',
            ].filter(Boolean);
            if (what.length) console.error(`Dati della gara mancanti: ${r.circuit} (${what.join(', ')}; risultati già in calendar.json)`);
            return what.length > 0;
        });
        console.log(missing.length > 0);
    } else {
        throw new Error('uso: node scripts/pole-pending.js poles|telemetry|race');
    }
}

main();
