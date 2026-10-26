// scripts/update-standings.js
//
// Scarica la classifica REALE del campionato piloti e costruttori (stagione
// in corso) e aggiorna standings.json. Fonti, in ordine:
//   1. OpenF1 (championship_drivers / championship_teams dopo l'ultima gara
//      o sprint): stessa fonte di tutti gli altri dati del weekend, aggiornata
//      subito dopo la gara; bloccata però durante le sessioni live;
//   2. Jolpica (api.jolpi.ca, archivio erede di Ergast);
//   3. f1api.dev (omette i piloti non più in griglia: Tsunoda nel 2026).
// Le tre classifiche coincidevano al 2026-10-26 (dopo Austin). Gira dopo ogni gara
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
const { openf1Json } = require('./lib/openf1');

// Squadra di ogni pilota e vittorie, dai risultati di gara in calendar.json
// (OpenF1): la squadra è quella dell'ultima gara (l'elenco delle squadre di
// Jolpica non è in ordine affidabile: Lawson 2026 "RB F1 Team", "Red Bull").
function calendarFacts() {
    const lastTeam = new Map(), driverWins = new Map(), teamWins = new Map();
    try {
        const cal = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'calendar.json'), 'utf-8'));
        cal.races.filter(r => r.results?.race).sort((a, b) => a.date.localeCompare(b.date)).forEach(r => {
            r.results.race.forEach(x => lastTeam.set(x.driver, x.team));
            const w = r.results.race.find(x => x.position === 1);
            if (w) { driverWins.set(w.driver, (driverWins.get(w.driver) || 0) + 1); teamWins.set(w.team, (teamWins.get(w.team) || 0) + 1); }
        });
    } catch (e) { /* senza calendario: squadre dalla fonte, vittorie 0 */ }
    return { lastTeam, driverWins, teamWins };
}

// Classifica da OpenF1, o null se non disponibile.
async function standingsFromOpenF1(season) {
    const now = new Date();
    const races = (await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}&session_type=Race`))
        .filter(s => new Date(s.date_end) < now)
        .sort((a, b) => b.date_start.localeCompare(a.date_start));
    for (const session of races.slice(0, 3)) { // l'ultima, o la precedente se non ancora calcolata
        const drv = await openf1Json(`https://api.openf1.org/v1/championship_drivers?session_key=${session.session_key}`).catch(() => []);
        const teams = await openf1Json(`https://api.openf1.org/v1/championship_teams?session_key=${session.session_key}`).catch(() => []);
        if (!drv.length || !teams.length) continue;
        const info = new Map((await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`)).map(d => [d.driver_number, d]));
        // Piloti in classifica ma assenti dall'ultima gara (es. Tsunoda 2026):
        // nome dalla loro ultima sessione nota.
        for (const d of drv.filter(x => !info.has(x.driver_number))) {
            const all = await openf1Json(`https://api.openf1.org/v1/drivers?driver_number=${d.driver_number}`).catch(() => []);
            const last = all.sort((a, b) => b.session_key - a.session_key)[0];
            if (last) info.set(d.driver_number, last);
        }
        const names = knownDriverNames();
        const { lastTeam, driverWins, teamWins } = calendarFacts();
        console.log(`Classifica OpenF1 dopo: ${session.session_name} di ${session.circuit_short_name} (${session.date_start.slice(0, 10)})`);
        return {
            season: Number(season),
            drivers: drv.sort((a, b) => a.position_current - b.position_current).map(x => {
                const d = info.get(x.driver_number) || {};
                const driver = siteDriverName(d, names) || `#${x.driver_number}`;
                return { position: x.position_current, driver, team: lastTeam.get(driver) || matchTeam(d.team_name || ''), points: x.points_current, wins: driverWins.get(driver) || 0 };
            }),
            constructors: teams.sort((a, b) => a.position_current - b.position_current).map(x => {
                const team = matchTeam(x.team_name);
                return { position: x.position_current, team, points: x.points_current, wins: teamWins.get(team) || 0 };
            }),
        };
    }
    return null;
}

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
    const { lastTeam } = calendarFacts();
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
    try {
        console.log('Richiesta classifica a OpenF1 ...');
        const fromOpenF1 = await standingsFromOpenF1(new Date().getFullYear());
        if (fromOpenF1) return save(fromOpenF1);
        console.warn('⚠️  OpenF1 senza classifica per l\'ultima gara: provo Jolpica.');
    } catch (err) {
        console.warn(`⚠️  OpenF1 non disponibile (${err.message}): provo Jolpica.`);
    }

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
