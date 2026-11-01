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
//       in telemetry.json (OpenF1 la pubblica a volte dopo i risultati).
//
// Stampa "false" altrimenti. Gli orari fissi restano come recupero.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf-8'));
const RECENT_HOURS = 72;

function qualyStart(race) {
    const q = race.schedule?.qualy;
    return q?.date ? new Date(`${q.date}T${q.time || '23:59:59Z'}`) : null;
}

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
    } else {
        throw new Error('uso: node scripts/pole-pending.js poles|telemetry');
    }
}

main();
