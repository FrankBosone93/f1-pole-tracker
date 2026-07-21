// scripts/backfill-weather.js
//
// Corregge il meteo di TUTTE le entry storiche in data.json usando dati reali
// (Open-Meteo, vedi scripts/lib/weather.js), invece del placeholder generico
// che c'era prima. Va lanciato una volta sola per il backfill; gli
// aggiornamenti futuri calcolano il meteo automaticamente in update-poles.js.
//
// Uso: node scripts/backfill-weather.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById } = require('./lib/f1-mapping');
const { fetchWeatherForCircuit } = require('./lib/weather');

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            if (i === retries - 1) throw err;
            await sleep(1000);
        }
    }
}

async function main() {
    const currentData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
    const years = [...new Set(currentData.map(d => d.year))].sort();

    let updated = 0, skipped = 0, failed = 0;

    for (const year of years) {
        const seasonPayload = await fetchJson(`https://f1api.dev/api/${year}`);
        const races = seasonPayload.races || [];
        for (const race of races) {
            const mappedCircuit = matchCircuitById(race.circuit?.circuitId);
            if (!mappedCircuit) continue;

            const entry = currentData.find(d => d.year === year && d.circuit === mappedCircuit);
            if (!entry) continue;

            const qualyDate = race.schedule?.qualy?.date || race.schedule?.race?.date;
            if (!qualyDate) {
                console.log(`[SKIP] ${year} ${mappedCircuit}: nessuna data di qualifica trovata`);
                skipped++;
                continue;
            }

            try {
                const weather = await fetchWeatherForCircuit(mappedCircuit, qualyDate);
                if (!weather) {
                    console.log(`[SKIP] ${year} ${mappedCircuit}: circuito senza coordinate note`);
                    skipped++;
                    continue;
                }
                const before = entry.weather;
                entry.weather = weather.description;
                updated++;
                console.log(`${year} ${mappedCircuit} (${qualyDate}): "${before}" -> "${weather.description}" ` +
                    `[wc=${weather.raw.weathercode} precip=${weather.raw.precipSum}mm tmax=${weather.raw.tempMax}°C]`);
            } catch (err) {
                console.log(`[ERRORE] ${year} ${mappedCircuit}: ${err.message}`);
                failed++;
            }

            await sleep(200); // rate limit gentile verso Open-Meteo
        }
    }

    fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(currentData, null, 2) + '\n', 'utf-8');
    console.log(`\n✅ data.json aggiornato. Corrette: ${updated}, saltate: ${skipped}, errori: ${failed}`);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
