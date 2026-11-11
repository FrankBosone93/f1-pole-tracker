// scripts/lib/race-control.js
//
// Messaggi della direzione gara (OpenF1 race_control) per il racconto del GP
// (lib/gp-story.js): safety car e virtual safety car, bandiere rosse e
// penalità decise dai commissari. Esclusi i messaggi di routine (bandiere
// gialle e blu, limiti della pista, incidenti "notati", indagini senza
// sanzione, penalità scontate). Numeri di gara sostituiti con i nomi del sito
// ("CAR 63 (RUS)" -> "George Russell"), orari finali tolti.

const { openf1Json, openf1Sessions, CIRCUIT_MAP } = require('./openf1');
const { surnameKey } = require('./driver-names');

const relevant = m =>
    m.category === 'SafetyCar' ||
    m.flag === 'RED' || /^RED FLAG\b/.test(m.message) || // dal 2026 senza flag
    (/^FIA STEWARDS: .*(PENALTY FOR|DRIVE THROUGH|STOP AND GO|DISQUALIFIED)/.test(m.message) && !/PENALTY SERVED/.test(m.message));


// raceResults = righe di calendar.json (results.race), per i nomi.
async function raceControlEvents(season, circuit, raceResults) {
    // Gare della stagione su OpenF1 (lista della stagione in cache, vedi lib/openf1.js).
    const sessions = (await openf1Sessions(season)).filter(s => s.session_name === 'Race');
    const session = sessions.find(s => CIRCUIT_MAP[s.circuit_short_name] === circuit);
    if (!session) throw new Error(`gara OpenF1 non trovata per ${circuit}`);
    const messages = await openf1Json(`https://api.openf1.org/v1/race_control?session_key=${session.session_key}`);
    const drivers = await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`);

    const names = {};
    for (const d of drivers) {
        const row = raceResults.find(r => surnameKey(r.driver) === surnameKey(d.last_name));
        names[d.driver_number] = row ? row.driver : d.full_name;
    }
    return messages
        .filter(relevant)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(m => ({
            giro: m.lap_number,
            messaggio: m.message
                .replace(/(?:CARS? )?(\d+) \(([A-Z]{3})\)/g, (all, n) => names[n] || all)
                .replace(/\s*\(\d\d:\d\d:\d\d\)$/, ''),
        }));
}

module.exports = { raceControlEvents };
