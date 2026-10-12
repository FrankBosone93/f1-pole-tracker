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
const { writeStatus } = require('./lib/status');

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');

class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} per ${url}`);
        this.status = status;
    }
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new HttpError(res.status, url);
    return res.json();
}

// Dopo la fine di una qualifica l'API può restituire 404 per ore (a volte
// oltre un giorno: visto su Singapore 2026) prima di pubblicare i risultati.
// Entro questa finestra un 404 non è un errore: la qualifica resta "in
// attesa" e verrà ripresa dai run successivi. Oltre, diventa un errore vero.
const PENDING_GRACE_HOURS = 72;

// Scarica e registra la pole di un singolo round. Ritorna true se data.json
// (in memoria) è cambiato.
async function processRound(season, round, raceLabel, currentData) {
    const API_URL = `https://f1api.dev/api/${season}/${round}/qualy`;
    console.log(`Round ${round} (${raceLabel}): richiesta a ${API_URL} ...`);
    const payload = await fetchJson(API_URL);

    // Log per debug: se la struttura reale differisce da quella attesa,
    // questo output nei log della GitHub Action aiuta a correggere lo script.
    console.log('Struttura risposta ricevuta (troncata):', JSON.stringify(payload).slice(0, 500));

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

    // --- Aggiornamento data.json (in memoria) ---
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

    if (existingIndex > -1) {
        const existing = currentData[existingIndex];
        const isSame = existing.driver === newEntry.driver &&
            existing.team === newEntry.team &&
            existing.timeStr === newEntry.timeStr &&
            existing.weather === newEntry.weather;
        if (isSame) {
            console.log('Nessuna modifica: i dati erano già aggiornati.');
            return false;
        }
        currentData[existingIndex] = newEntry;
        console.log('Voce esistente aggiornata.');
        return true;
    }
    currentData.push(newEntry);
    console.log('Nuova voce aggiunta.');
    return true;
}

async function main() {
    // Non usiamo /api/current/last/qualy: si è rivelato inaffidabile in
    // pratica (rimasto 404 per giorni dopo una qualifica reale, mentre
    // l'endpoint diretto per il round aveva già i dati completi - visto sul
    // GP Ungheria 2026, round 11). Cerchiamo noi nel calendario le qualifiche
    // già disputate e chiediamo i risultati per round esplicito (stesso
    // approccio usato da update-calendar.js e build-history.js).
    //
    // Si elaborano TUTTE le qualifiche disputate non ancora in data.json, non
    // solo l'ultima: se un run cade quando l'API non ha ancora pubblicato i
    // risultati (404) o salta per qualunque motivo, la pole viene recuperata
    // dal run successivo invece di andare persa per sempre quando arriva il
    // GP dopo. L'ultima qualifica viene comunque sempre rielaborata, per
    // intercettare eventuali correzioni dei dati.
    console.log('Richiesta a https://f1api.dev/api/current ...');
    const currentPayload = await fetchJson('https://f1api.dev/api/current');
    const season = currentPayload.season;
    const races = currentPayload.races || [];
    if (!season || races.length === 0) {
        throw new Error('Calendario stagione corrente vuoto o senza campo "season".');
    }

    const now = new Date();
    // Una qualifica senza orario nel calendario (visto sul round 16 2026,
    // Sepang) conta come disputata dal giorno dopo la sua data.
    const qualyEnd = q => {
        if (!q?.date) return null;
        const start = q.time ? new Date(`${q.date}T${q.time}`) : new Date(`${q.date}T23:59:59Z`);
        return isNaN(start) ? null : start;
    };
    const pastQualyRaces = races.filter(r => {
        const start = qualyEnd(r.schedule?.qualy);
        return start && start <= now;
    });
    if (pastQualyRaces.length === 0) {
        throw new Error('Nessuna qualifica già disputata trovata nel calendario della stagione corrente.');
    }
    const lastRace = pastQualyRaces.reduce((latest, r) => r.schedule.qualy.date > latest.schedule.qualy.date ? r : latest);

    const currentData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
    const year = parseInt(season, 10);

    const toProcess = pastQualyRaces
        .filter(r => {
            if (r.round === lastRace.round) return true;
            const mapped = matchCircuitById(r.circuit?.circuitId);
            // Circuito non mappato: lo si elabora comunque, così processRound
            // segnala l'errore esplicito "aggiungere a CIRCUIT_ID_MAP".
            return !mapped || !currentData.some(d => d.year === year && d.circuit === mapped);
        })
        .sort((a, b) => a.round - b.round);

    let changed = false;
    const errors = [];
    for (const race of toProcess) {
        const label = race.raceName || race.circuit?.circuitName || 'sconosciuto';
        try {
            if (await processRound(season, race.round, label, currentData)) changed = true;
        } catch (err) {
            const hoursSince = (now - qualyEnd(race.schedule.qualy)) / 3600000;
            if (err instanceof HttpError && err.status === 404 && hoursSince < PENDING_GRACE_HOURS) {
                console.warn(`⏳ Round ${race.round}: risultati qualifica non ancora pubblicati dall'API (404, qualifica conclusa ${hoursSince.toFixed(1)}h fa): riproverò al prossimo run.`);
            } else {
                console.error(`❌ Round ${race.round} (${label}): ${err.message}`);
                errors.push(`round ${race.round}: ${err.message}`);
            }
        }
    }

    if (changed) {
        fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(currentData, null, 2) + '\n', 'utf-8');
        console.log(`✅ data.json aggiornato: ${DATA_JSON_PATH}`);
    }

    if (errors.length > 0) throw new Error(errors.join(' | '));
}

main()
    .then(() => writeStatus('poles', true))
    .catch(err => {
        console.error('❌ Errore durante l\'aggiornamento:', err.message);
        writeStatus('poles', false, err.message);
        process.exit(1);
    });
