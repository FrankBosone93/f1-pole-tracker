// scripts/update-standings.js
//
// Scarica la classifica REALE del campionato piloti e costruttori (stagione
// in corso) da f1api.dev e aggiorna standings.json. Gira dopo ogni gara
// (i punti si assegnano in gara, non in qualifica), insieme a
// check-pole-penalty.js — vedi .github/workflows/update-standings.yml.
//
// Uso manuale: node scripts/update-standings.js

const fs = require('fs');
const path = require('path');
const { matchTeam } = require('./lib/f1-mapping');

const STANDINGS_JSON_PATH = path.join(__dirname, '..', 'standings.json');
const DRIVERS_URL = 'https://f1api.dev/api/current/drivers-championship';
const CONSTRUCTORS_URL = 'https://f1api.dev/api/current/constructors-championship';

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Risposta API non valida per ${url}: ${res.status}`);
    return res.json();
}

function driverFullName(driver) {
    return [driver?.name, driver?.surname].filter(Boolean).join(' ').trim();
}

async function main() {
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

main().catch(err => {
    console.error('❌ Errore durante l\'aggiornamento classifiche:', err.message);
    process.exit(1);
});
