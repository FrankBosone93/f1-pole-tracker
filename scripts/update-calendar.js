// scripts/update-calendar.js
//
// Scarica il calendario della stagione IN CORSO (rilevata automaticamente
// tramite /api/current, quindi passa da sola a una nuova stagione l'anno
// prossimo) da f1api.dev, con il vincitore di ogni gara già disputata, e
// aggiorna calendar.json. Gira dopo la gara (domenica), insieme a
// check-pole-penalty.js e update-standings.js.
//
// Uso manuale: node scripts/update-calendar.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById, matchTeam } = require('./lib/f1-mapping');

const CALENDAR_JSON_PATH = path.join(__dirname, '..', 'calendar.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, { allow404 = false } = {}) {
    const res = await fetch(url);
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
    return res.json();
}

function driverFullName(driver) {
    return [driver?.name, driver?.surname].filter(Boolean).join(' ').trim();
}

async function main() {
    console.log('Richiesta a https://f1api.dev/api/current ...');
    const currentPayload = await fetchJson('https://f1api.dev/api/current');
    const season = currentPayload.season;
    const races = currentPayload.races || [];
    if (!season || races.length === 0) {
        throw new Error('Calendario stagione corrente vuoto o senza campo "season".');
    }
    console.log(`Stagione corrente rilevata: ${season} (${races.length} gare in calendario)`);

    const calendarRaces = [];
    for (const race of races) {
        const round = race.round;
        const mappedCircuit = matchCircuitById(race.circuit?.circuitId) || race.circuit?.circuitName || 'Sconosciuto';
        const date = race.schedule?.race?.date || null;

        let winner = null;
        try {
            const racePayload = await fetchJson(`https://f1api.dev/api/${season}/${round}/race`, { allow404: true });
            const results = racePayload?.races?.results;
            if (Array.isArray(results) && results.length > 0) {
                const winnerRow = results.find(r => String(r.position) === '1') || results[0];
                winner = {
                    driver: driverFullName(winnerRow.driver),
                    team: matchTeam(winnerRow.team?.teamName || winnerRow.team?.teamId || ''),
                };
            }
        } catch (err) {
            console.warn(`⚠️  Round ${round} (${mappedCircuit}): errore nel recupero risultati - ${err.message}`);
        }

        calendarRaces.push({ round, circuit: mappedCircuit, raceName: race.raceName || '', date, winner });
        console.log(`Round ${round} - ${mappedCircuit}: ${winner ? `${winner.driver} (${winner.team})` : 'da disputare'}`);

        await sleep(150); // rate limit gentile
    }

    const newCalendar = { season, updatedAt: new Date().toISOString(), races: calendarRaces };

    let existing = null;
    if (fs.existsSync(CALENDAR_JSON_PATH)) {
        existing = JSON.parse(fs.readFileSync(CALENDAR_JSON_PATH, 'utf-8'));
    }
    const isSame = existing &&
        existing.season === newCalendar.season &&
        JSON.stringify(existing.races) === JSON.stringify(newCalendar.races);

    if (isSame) {
        console.log('Nessuna modifica: il calendario era già aggiornato.');
        return;
    }

    fs.writeFileSync(CALENDAR_JSON_PATH, JSON.stringify(newCalendar, null, 2) + '\n', 'utf-8');
    console.log(`✅ calendar.json aggiornato (stagione ${season}).`);
}

main().catch(err => {
    console.error('❌ Errore durante l\'aggiornamento calendario:', err.message);
    process.exit(1);
});
