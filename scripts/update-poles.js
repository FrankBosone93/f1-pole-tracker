// scripts/update-poles.js
//
// Scarica automaticamente il risultato delle qualifiche F1 della stagione in
// corso e aggiorna data.json con le pole position non ancora presenti.
//
// Fonti (confronto del 2026-10-25 sulle 87 pole 2023-2026 già verificate in
// data.json: OpenF1 87/87 corrette, f1api.dev 2 tempi sbagliati e risultati
// pubblicati con ore o giorni di ritardo, Austin 2026 ancora assente il giorno
// dopo):
//   - OpenF1 (classifica ufficiale della qualifica, dal live timing F1) è la
//     fonte principale;
//   - f1api.dev è il ripiego: OpenF1 gratuita non risponde a nulla mentre è in
//     corso una qualsiasi sessione F1 (401), e può non avere ancora il dato.
// Se entrambe rispondono e danno pilota o tempo diversi, si usa OpenF1 e il
// log lo segnala ("Fonti discordanti"). Il calendario (round, circuiti,
// orari) resta quello di f1api.dev.
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
const { HttpError, fetchJson } = require('./lib/http');
const { openf1Json, CIRCUIT_MAP } = require('./lib/openf1');
const { knownDriverNames, siteDriverName, surnameKey } = require('./lib/driver-names');

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');

// Dopo la fine di una qualifica l'API può restituire 404 per ore (a volte
// oltre un giorno: visto su Singapore 2026) prima di pubblicare i risultati.
// Entro questa finestra un 404 non è un errore: la qualifica resta "in
// attesa" e verrà ripresa dai run successivi. Oltre, diventa un errore vero.
const PENDING_GRACE_HOURS = 72;

// Pole da OpenF1: pilota in posizione 1 nella classifica ufficiale della
// qualifica, con il suo tempo migliore nell'ultima fase disputata (Q3, o Q2/Q1
// se la sessione si è fermata prima). null se OpenF1 non ha il risultato.
async function poleFromOpenF1(session, names) {
    const rows = await openf1Json(`https://api.openf1.org/v1/session_result?session_key=${session.session_key}`);
    const p1 = rows.find(r => r.position === 1);
    if (!p1) return null;
    const best = [].concat(p1.duration).reverse().find(v => typeof v === 'number');
    const driver = (await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}&driver_number=${p1.driver_number}`))[0];
    if (!best || !driver) return null;
    const m = Math.floor(best / 60);
    const parsedTime = parseQualyTime(`${m}:${(best - m * 60).toFixed(3).padStart(6, '0')}`);
    const start = new Date(session.date_start);
    return {
        driver: siteDriverName(driver, names),
        team: matchTeam(driver.team_name || ''),
        parsedTime,
        qualyDate: start.toISOString().slice(0, 10),
        qualyTime: start.toISOString().slice(11, 19) + 'Z',
    };
}

// Pole da f1api.dev (ripiego). Lancia HttpError 404 se i risultati non sono
// ancora pubblicati.
async function poleFromF1api(season, round) {
    const API_URL = `https://f1api.dev/api/${season}/${round}/qualy`;
    console.log(`   f1api.dev: ${API_URL}`);
    const payload = await fetchJson(API_URL);
    const racesNode = payload.races;
    if (!racesNode) throw new Error('Campo "races" non trovato nella risposta di f1api.dev.');
    // I risultati della qualifica possono comparire sotto nomi di campo diversi
    // a seconda della versione dell'API: proviamo le alternative più plausibili.
    const results = racesNode.qualyResults || racesNode.results || racesNode.qualy || [];
    if (!Array.isArray(results) || results.length === 0) throw new Error('Nessun risultato di qualifica nella risposta di f1api.dev.');
    const poleResult = results.find(r => Number(r.gridPosition) === 1) || results[0];
    // Tempo di pole: preferiamo q3, poi q2, poi q1, poi altri campi generici.
    const timeCandidate = poleResult.q3 || poleResult.q2 || poleResult.q1 || poleResult.time || poleResult.fastLap;
    return {
        driver: [poleResult.driver?.name, poleResult.driver?.surname].filter(Boolean).join(' ').trim(),
        team: matchTeam(poleResult.team?.teamName || poleResult.team?.teamId || ''),
        parsedTime: parseQualyTime(timeCandidate),
        timeCandidate,
        qualyDate: racesNode.qualyDate,
        qualyTime: racesNode.qualyTime,
    };
}

// Scarica e registra la pole di un singolo round. Ritorna true se data.json
// (in memoria) è cambiato.
async function processRound(season, race, raceLabel, currentData, openf1Sessions, names) {
    const round = race.round;
    const circuitInfo = race.circuit || {};
    const mappedCircuit = matchCircuitById(circuitInfo.circuitId);
    console.log(`Round ${round} (${raceLabel}):`);

    if (!mappedCircuit) {
        throw new Error(
            `Circuito con circuitId="${circuitInfo.circuitId}" non riconosciuto ` +
            `(gara: "${raceLabel}", circuitName: "${circuitInfo.circuitName}", country: "${circuitInfo.country}"). ` +
            `Di norma update-calendar.js lo riconosce da solo (auto-circuits.json) appena compare nel calendario; ` +
            `altrimenti aggiungere una voce a CIRCUIT_ID_MAP in scripts/lib/f1-mapping.js.`
        );
    }

    // 1. OpenF1 (principale)
    let fromOpenF1 = null;
    const session = (openf1Sessions || []).find(s => CIRCUIT_MAP[s.circuit_short_name] === mappedCircuit && new Date(s.date_end) < new Date());
    if (session) {
        try {
            fromOpenF1 = await poleFromOpenF1(session, names);
            if (!fromOpenF1) console.log('   OpenF1: risultato non ancora disponibile.');
        } catch (err) {
            console.warn(`   ⚠️  OpenF1: ${err.message}`);
        }
    }

    // 2. f1api.dev (ripiego, e controllo incrociato quando c'è)
    let fromF1api = null, f1apiError = null;
    try {
        fromF1api = await poleFromF1api(season, round);
    } catch (err) {
        f1apiError = err;
        if (fromOpenF1) console.log(`   f1api.dev: non disponibile (${err.message}), basta OpenF1.`);
    }

    const pole = fromOpenF1 || fromF1api;
    if (!pole) throw f1apiError || new Error('risultato della qualifica non disponibile né su OpenF1 né su f1api.dev');
    if (fromOpenF1 && fromF1api?.parsedTime &&
        (fromOpenF1.parsedTime.seconds !== fromF1api.parsedTime.seconds || surnameKey(fromOpenF1.driver) !== surnameKey(fromF1api.driver))) {
        console.warn(`   ⚠️  Fonti discordanti: OpenF1 ${fromOpenF1.driver} ${fromOpenF1.parsedTime.timeStr}, f1api.dev ${fromF1api.driver} ${fromF1api.parsedTime.timeStr} - uso OpenF1.`);
    }

    const driverFullName = pole.driver;
    const mappedTeam = pole.team;
    const parsedTime = pole.parsedTime;
    if (!driverFullName || !mappedTeam || !parsedTime) {
        throw new Error(
            `Dati incompleti per la pole: driver="${driverFullName}", team="${mappedTeam}", ` +
            `tempo grezzo="${pole.timeCandidate || ''}".`
        );
    }

    const year = parseInt(season, 10);
    if (!year || isNaN(year)) {
        throw new Error(`Anno stagione non valido: "${season}"`);
    }

    console.log(`Pole rilevata (${fromOpenF1 ? 'OpenF1' : 'f1api.dev'}): ${year} - ${mappedCircuit} - ${driverFullName} (${mappedTeam}) - ${parsedTime.timeStr}`);

    // --- Meteo reale (Open-Meteo) del giorno locale di qualifica, non un placeholder ---
    const qualyDate = pole.qualyDate;
    const qualyTime = pole.qualyTime;
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

    // Qualifiche della stagione su OpenF1 (escluse le sprint). Se OpenF1 non
    // risponde (es. sessione F1 in corso) si va avanti solo con f1api.dev.
    let openf1Sessions = null;
    try {
        openf1Sessions = await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}&session_name=Qualifying`);
    } catch (err) {
        console.warn(`⚠️  OpenF1 non disponibile (${err.message}): pole solo da f1api.dev in questo run.`);
    }
    const names = knownDriverNames();

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
            if (await processRound(season, race, label, currentData, openf1Sessions, names)) changed = true;
        } catch (err) {
            const hoursSince = (now - qualyEnd(race.schedule.qualy)) / 3600000;
            if (err instanceof HttpError && err.status === 404 && hoursSince < PENDING_GRACE_HOURS) {
                console.warn(`⏳ Round ${race.round}: risultati qualifica non ancora pubblicati (OpenF1 senza dato, f1api.dev 404; qualifica conclusa ${hoursSince.toFixed(1)}h fa): riproverò al prossimo run.`);
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
