// scripts/update-standings.js
//
// Scarica la classifica REALE del campionato piloti e costruttori (stagione
// in corso) e aggiorna standings.json. Fonte principale Jolpica (api.jolpi.ca,
// archivio erede di Ergast): completa, mentre f1api.dev omette i piloti che
// non sono più in griglia (Tsunoda nel 2026, 1 punto, mancava dal sito).
// f1api.dev resta il ripiego se Jolpica non risponde. Gira dopo ogni gara
// (i punti si assegnano in gara, non in qualifica), insieme a
// check-pole-penalty.js — vedi .github/workflows/update-standings.yml.
//
// Uso manuale: node scripts/update-standings.js

const fs = require('fs');
const path = require('path');
const { matchTeam, driverFullName } = require('./lib/f1-mapping');
const { writeStatus } = require('./lib/status');
const { fetchJson } = require('./lib/http');
const { knownDriverNames, siteDriverName } = require('./lib/driver-names');

// Classifica da Jolpica nel formato del sito, o null se non disponibile.
async function standingsFromJolpica() {
    const [d, c] = [
        await fetchJson('https://api.jolpi.ca/ergast/f1/current/driverStandings.json', { retries: 3 }),
        await fetchJson('https://api.jolpi.ca/ergast/f1/current/constructorStandings.json', { retries: 3 }),
    ];
    const dl = d?.MRData?.StandingsTable?.StandingsLists?.[0];
    const cl = c?.MRData?.StandingsTable?.StandingsLists?.[0];
    if (!dl?.DriverStandings?.length || !cl?.ConstructorStandings?.length) return null;
    const names = knownDriverNames();
    // Squadra del pilota: quella dell'ultima gara in calendar.json (OpenF1).
    // L'elenco delle squadre di Jolpica non è in ordine affidabile (Lawson
    // 2026: "RB F1 Team", "Red Bull" pur correndo ancora con RB).
    const lastTeam = new Map();
    try {
        const cal = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'calendar.json'), 'utf-8'));
        cal.races.filter(r => r.results?.race).sort((a, b) => a.date.localeCompare(b.date))
            .forEach(r => r.results.race.forEach(x => lastTeam.set(x.driver, x.team)));
    } catch (e) { /* senza calendario: squadra da Jolpica */ }
    return {
        season: Number(dl.season),
        drivers: dl.DriverStandings.map(x => {
            const driver = siteDriverName({ first_name: x.Driver.givenName, last_name: x.Driver.familyName }, names);
            return {
            position: Number(x.position),
            driver,
            team: lastTeam.get(driver) || matchTeam((x.Constructors || []).slice(-1)[0]?.name || ''),
            points: Number(x.points),
            wins: Number(x.wins),
            };
        }),
        constructors: cl.ConstructorStandings.map(x => ({
            position: Number(x.position),
            team: matchTeam(x.Constructor.name),
            points: Number(x.points),
            wins: Number(x.wins),
        })),
    };
}

const STANDINGS_JSON_PATH = path.join(__dirname, '..', 'standings.json');
const DRIVERS_URL = 'https://f1api.dev/api/current/drivers-championship';
const CONSTRUCTORS_URL = 'https://f1api.dev/api/current/constructors-championship';

async function main() {
    let jolpica = null;
    try {
        console.log('Richiesta classifica a Jolpica (api.jolpi.ca) ...');
        jolpica = await standingsFromJolpica();
    } catch (err) {
        console.warn(`⚠️  Jolpica non disponibile (${err.message}): uso f1api.dev.`);
    }
    if (jolpica) return save(jolpica);

    console.log(`Richiesta a ${DRIVERS_URL} ...`);
    const driversPayload = await fetchJson(DRIVERS_URL);
    console.log(`Richiesta a ${CONSTRUCTORS_URL} ...`);
    const constructorsPayload = await fetchJson(CONSTRUCTORS_URL);

    const season = driversPayload.season;
    const driversRaw = driversPayload.drivers_championship || [];
    const constructorsRaw = constructorsPayload.constructors_championship || [];

    if (driversRaw.length === 0 || constructorsRaw.length === 0) {
        throw new Error('Classifica piloti o costruttori vuota nella risposta API.');
    }

    const drivers = driversRaw
        .map(d => ({
            position: d.position,
            driver: driverFullName(d.driver),
            team: matchTeam(d.team?.teamName || d.team?.teamId || ''),
            points: d.points,
            wins: d.wins,
        }))
        .sort((a, b) => a.position - b.position);

    const constructors = constructorsRaw
        .map(c => ({
            position: c.position,
            team: matchTeam(c.team?.teamName || c.teamId || ''),
            points: c.points,
            wins: c.wins,
        }))
        .sort((a, b) => a.position - b.position);

    return save({ season, drivers, constructors });
}

function save({ season, drivers, constructors }) {
    const newStandings = { season, updatedAt: new Date().toISOString(), drivers, constructors };

    let existing = null;
    if (fs.existsSync(STANDINGS_JSON_PATH)) {
        existing = JSON.parse(fs.readFileSync(STANDINGS_JSON_PATH, 'utf-8'));
    }

    const isSame = existing &&
        existing.season === newStandings.season &&
        JSON.stringify(existing.drivers) === JSON.stringify(newStandings.drivers) &&
        JSON.stringify(existing.constructors) === JSON.stringify(newStandings.constructors);

    if (isSame) {
        console.log('Nessuna modifica: la classifica era già aggiornata.');
        return;
    }

    fs.writeFileSync(STANDINGS_JSON_PATH, JSON.stringify(newStandings, null, 2) + '\n', 'utf-8');
    console.log(`✅ standings.json aggiornato (stagione ${season}).`);
    console.log('Top 3 piloti:', drivers.slice(0, 3).map(d => `${d.driver} (${d.points}pt)`).join(', '));
    console.log('Top 3 costruttori:', constructors.slice(0, 3).map(c => `${c.team} (${c.points}pt)`).join(', '));
}

main()
    .then(() => writeStatus('standings', true))
    .catch(err => {
        console.error('❌ Errore durante l\'aggiornamento classifiche:', err.message);
        writeStatus('standings', false, err.message);
        process.exit(1);
    });
