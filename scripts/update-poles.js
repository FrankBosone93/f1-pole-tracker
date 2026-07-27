// scripts/update-poles.js
//
// Scarica automaticamente il risultato dell'ultima qualifica F1 da f1api.dev
// (API pubblica e gratuita, nessuna chiave richiesta) e aggiorna data.json
// con la pole position più recente, se non è già presente.
//
// "Pole position" = il pilota più veloce in qualifica, indipendentemente da
// eventuali penalità applicate dopo (che spostano la partenza in griglia ma
// non il risultato della qualifica). Le penalità che spostano il polista dalla
// prima casella in griglia vengono rilevate a parte da check-pole-penalty.js,
// che gira la domenica sera dopo la gara.
//
// Pensato per essere eseguito da una GitHub Action pianificata
// (vedi .github/workflows/update-poles.yml), ma funziona anche a mano:
//   node scripts/update-poles.js

const fs = require('fs');
const path = require('path');
const { matchCircuitById, matchTeam, parseQualyTime } = require('./lib/f1-mapping');
const { fetchWeatherForCircuit } = require('./lib/weather');

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
    return res.json();
}

async function main() {
    // Non usiamo /api/current/last/qualy: si è rivelato inaffidabile in
    // pratica (rimasto 404 per giorni dopo una qualifica reale, mentre
    // l'endpoint diretto per il round aveva già i dati completi - visto sul
    // GP Ungheria 2026, round 11). Troviamo noi l'ultimo round con qualifica
    // già disputata dal calendario, e chiediamo i suoi risultati per round
    // esplicito (stesso approccio, già affidabile, usato da
    // update-calendar.js e build-history.js).
    console.log('Richiesta a https://f1api.dev/api/current ...');
    const currentPayload = await fetchJson('https://f1api.dev/api/current');
    const season = currentPayload.season;
    const races = currentPayload.races || [];
    if (!season || races.length === 0) {
        throw new Error('Calendario stagione corrente vuoto o senza campo "season".');
    }

    const now = new Date();
    const pastQualyRaces = races.filter(r => {
        const q = r.schedule?.qualy;
        if (!q?.date || !q?.time) return false;
        const qualyStart = new Date(`${q.date}T${q.time}`);
        return !isNaN(qualyStart) && qualyStart <= now;
    });
    if (pastQualyRaces.length === 0) {
        throw new Error('Nessuna qualifica già disputata trovata nel calendario della stagione corrente.');
    }
    const lastRace = pastQualyRaces.reduce((latest, r) => r.schedule.qualy.date > latest.schedule.qualy.date ? r : latest);
    const round = lastRace.round;

    console.log(`Ultima qualifica rilevata: round ${round} (${lastRace.raceName || lastRace.circuit?.circuitName || 'sconosciuto'}).`);
    const API_URL = `https://f1api.dev/api/${season}/${round}/qualy`;
    console.log(`Richiesta a ${API_URL} ...`);
    const payload = await fetchJson(API_URL);

    // Log completo per debug: se la struttura reale differisce da quella attesa,
    // questo output nei log della GitHub Action aiuta a correggere lo script.
    console.log('Struttura risposta ricevuta (troncata):', JSON.stringify(payload).slice(0, 2000));

    const racesNode = payload.races;
    if (!racesNode) {
        throw new Error('Campo "races" non trovato nella risposta API. Controllare i log sopra per la struttura reale.');
    }

    const raceName = racesNode.raceName || '';
    const circuitInfo = Array.isArray(racesNode.circuit) ? racesNode.circuit[0] : racesNode.circuit;
    const mappedCircuit = matchCircuitById(circuitInfo?.circuitId);

    if (!mappedCircuit) {
        throw new Error(
            `Circuito con circuitId="${circuitInfo?.circuitId}" non riconosciuto ` +
            `(gara: "${raceName}", circuitName: "${circuitInfo?.circuitName}", country: "${circuitInfo?.country}"). ` +
            `Aggiungere una nuova voce a CIRCUIT_ID_MAP in scripts/lib/f1-mapping.js.`
        );
    }

    // I risultati della qualifica possono comparire sotto nomi di campo diversi
    // a seconda della versione dell'API: proviamo le alternative più plausibili.
    const results = racesNode.qualyResults || racesNode.results || racesNode.qualy || [];
    if (!Array.isArray(results) || results.length === 0) {
        throw new Error('Nessun risultato di qualifica trovato nella risposta API.');
    }

    const poleResult = results.find(r => Number(r.gridPosition) === 1) || results[0];

    const driverFullName = [poleResult.driver?.name, poleResult.driver?.surname]
        .filter(Boolean).join(' ').trim();
    const teamRaw = poleResult.team?.teamName || poleResult.team?.teamId || '';
    const mappedTeam = matchTeam(teamRaw);

    // Tempo di pole: preferiamo q3, poi q2, poi q1, poi altri campi generici.
    const timeCandidate = poleResult.q3 || poleResult.q2 || poleResult.q1 || poleResult.time || poleResult.fastLap;
    const parsedTime = parseQualyTime(timeCandidate);

    if (!driverFullName || !mappedTeam || !parsedTime) {
        throw new Error(
            `Dati incompleti per la pole: driver="${driverFullName}", team="${mappedTeam}", ` +
            `tempo grezzo="${timeCandidate}". Controllare la struttura della risposta API nei log sopra.`
        );
    }

    const year = parseInt(season, 10);
    if (!year || isNaN(year)) {
        throw new Error(`Anno stagione non valido: "${season}"`);
    }

    console.log(`Pole rilevata: ${year} - ${mappedCircuit} - ${driverFullName} (${mappedTeam}) - ${parsedTime.timeStr}`);

    // --- Meteo reale (Open-Meteo) del giorno locale di qualifica, non un placeholder ---
    const qualyDate = racesNode.qualyDate;
    const qualyTime = racesNode.qualyTime;
    let weatherDescription = null;
    if (qualyDate) {
        try {
            const weather = await fetchWeatherForCircuit(mappedCircuit, qualyDate, qualyTime);
            if (weather) {
                weatherDescription = weather.description;
                console.log(`Meteo (${weather.raw.localDate} locale): ${weather.description} [wc=${weather.raw.weathercode} precip=${weather.raw.precipSum}mm tmax=${weather.raw.tempMax}°C]`);
            } else {
                console.warn(`⚠️  Nessuna coordinata nota per "${mappedCircuit}", impossibile calcolare il meteo.`);
            }
        } catch (err) {
            console.warn(`⚠️  Errore nel recupero meteo: ${err.message}`);
        }
    } else {
        console.warn('⚠️  Nessuna data di qualifica nella risposta API, impossibile calcolare il meteo.');
    }

    // --- Aggiornamento data.json ---
    const currentData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));

    const existingIndex = currentData.findIndex(d => d.year === year && d.circuit === mappedCircuit);
    const existingWeather = existingIndex > -1 ? currentData[existingIndex].weather : '☀️ Sereno';
    const finalWeather = weatherDescription || existingWeather;

    const newEntry = {
        year,
        circuit: mappedCircuit,
        driver: driverFullName,
        team: mappedTeam,
        timeStr: parsedTime.timeStr,
        seconds: parsedTime.seconds,
        weather: finalWeather,
    };

    let changed = false;
    if (existingIndex > -1) {
        const existing = currentData[existingIndex];
        const isSame = existing.driver === newEntry.driver &&
            existing.team === newEntry.team &&
            existing.timeStr === newEntry.timeStr &&
            existing.weather === newEntry.weather;
        if (!isSame) {
            currentData[existingIndex] = newEntry;
            changed = true;
            console.log('Voce esistente aggiornata.');
        } else {
            console.log('Nessuna modifica: i dati erano già aggiornati.');
        }
    } else {
        currentData.push(newEntry);
        changed = true;
        console.log('Nuova voce aggiunta.');
    }

    if (changed) {
        fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(currentData, null, 2) + '\n', 'utf-8');
        console.log(`✅ data.json aggiornato: ${DATA_JSON_PATH}`);
    }
}

main().catch(err => {
    console.error('❌ Errore durante l\'aggiornamento:', err.message);
    process.exit(1);
});
