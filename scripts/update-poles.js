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
//   - Jolpica è il ripiego: OpenF1 gratuita non risponde a nulla mentre è in
//     corso una qualsiasi sessione F1 (401), e può non avere ancora il dato
//     (prima il ripiego era f1api.dev, eliminato il 2026-10-26).
// Se entrambe rispondono e danno pilota o tempo diversi, si usa OpenF1 e il
// log lo segnala ("Fonti discordanti"). Il calendario viene da
// lib/season-calendar.js (OpenF1, ripiego Jolpica).
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
const { loadSeasonCalendar } = require('./lib/season-calendar');
const { jolpicaRaces, jolpicaDriver } = require('./lib/jolpica');
const { fetchQualyWeather } = require('./lib/weather');
const { writeStatus } = require('./lib/status');
const { HttpError } = require('./lib/http');
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
        openf1: { sessionKey: session.session_key, driverNumber: p1.driver_number },
    };
}

// Pole da Jolpica (ripiego): primo della classifica di qualifica, tempo
// dell'ultima fase disputata. HttpError 404 se il risultato non c'è ancora.
async function poleFromJolpica(season, race, names) {
    const path = `${season}/${race.round}/qualifying`;
    console.log(`   Jolpica: ${path}`);
    const [j] = await jolpicaRaces(path);
    const p1 = j && matchCircuitById(j.Circuit?.circuitId) === race.circuit
        ? j.QualifyingResults.find(r => r.position === '1') : null;
    if (!p1) throw new HttpError(404, `https://api.jolpi.ca/ergast/f1/${path}`);
    const timeCandidate = p1.Q3 || p1.Q2 || p1.Q1;
    return {
        driver: jolpicaDriver(p1.Driver, names),
        team: matchTeam(p1.Constructor?.name || ''),
        parsedTime: parseQualyTime(timeCandidate),
        timeCandidate,
        qualyDate: race.schedule?.qualy?.date,
        qualyTime: race.schedule?.qualy?.time,
    };
}

// Scarica e registra la pole di un singolo round. Ritorna true se data.json
// (in memoria) è cambiato.
async function processRound(season, race, raceLabel, currentData, openf1Sessions, names) {
    const round = race.round;
    const mappedCircuit = race.circuit;
    console.log(`Round ${round} (${raceLabel}):`);

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

    // 2. Jolpica (ripiego, e controllo incrociato quando c'è)
    let fromJolpica = null, jolpicaError = null;
    try {
        fromJolpica = await poleFromJolpica(season, race, names);
    } catch (err) {
        jolpicaError = err;
        if (fromOpenF1) console.log(`   Jolpica: non disponibile (${err.message}), basta OpenF1.`);
    }

    const pole = fromOpenF1 || fromJolpica;
    if (!pole) throw jolpicaError || new Error('risultato della qualifica non disponibile né su OpenF1 né su Jolpica');
    if (fromOpenF1 && fromJolpica?.parsedTime &&
        (fromOpenF1.parsedTime.seconds !== fromJolpica.parsedTime.seconds || surnameKey(fromOpenF1.driver) !== surnameKey(fromJolpica.driver))) {
        console.warn(`   ⚠️  Fonti discordanti: OpenF1 ${fromOpenF1.driver} ${fromOpenF1.parsedTime.timeStr}, Jolpica ${fromJolpica.driver} ${fromJolpica.parsedTime.timeStr} - uso OpenF1.`);
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

    console.log(`Pole rilevata (${fromOpenF1 ? 'OpenF1' : 'Jolpica'}): ${year} - ${mappedCircuit} - ${driverFullName} (${mappedTeam}) - ${parsedTime.timeStr}`);

    // --- Meteo della qualifica (lib/weather.js): pioggia e gomma da OpenF1,
    // nuvole e temperatura da Open-Meteo all'ora della qualifica ---
    const qualyDate = pole.qualyDate;
    const qualyTime = pole.qualyTime;
    const existingIndex = currentData.findIndex(d => d.year === year && d.circuit === mappedCircuit);
    let weatherDescription = null;
    if (qualyDate) {
        try {
            const start = new Date(`${qualyDate}T${qualyTime || '12:00:00Z'}`);
            const weather = await fetchQualyWeather(mappedCircuit, start, pole.openf1 || null);
            if (!weather) {
                console.warn(`⚠️  Nessuna coordinata nota per "${mappedCircuit}", impossibile calcolare il meteo.`);
            } else if (!weather.complete && existingIndex > -1) {
                // Senza i dati di pista non si sa se ha piovuto: si tiene il
                // meteo già salvato (magari calcolato con OpenF1 in un run precedente).
                console.log(`Meteo: dati di pista OpenF1 non disponibili, tengo "${currentData[existingIndex].weather}".`);
            } else {
                weatherDescription = weather.description;
                const r = weather.raw;
                console.log(`Meteo: ${weather.description} [gomma=${r.tyre} pioggia=${r.rainFrac == null ? 'n.d.' : Math.round(r.rainFrac * 100) + '%'} temp=${r.temp}°C nuvole=${r.cloud}%]`);
            }
        } catch (err) {
            console.warn(`⚠️  Errore nel recupero meteo: ${err.message}`);
        }
    } else {
        console.warn('⚠️  Nessuna data di qualifica nella risposta API, impossibile calcolare il meteo.');
    }

    // --- Aggiornamento data.json (in memoria) ---
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
    // Si elaborano TUTTE le qualifiche disputate non ancora in data.json, non
    // solo l'ultima: se un run cade quando le fonti non hanno ancora il
    // risultato o salta per qualunque motivo, la pole viene recuperata dal
    // run successivo invece di andare persa. L'ultima qualifica viene
    // comunque sempre rielaborata, per intercettare eventuali correzioni.
    const { season, races } = await loadSeasonCalendar();

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
    // risponde (es. sessione F1 in corso) si va avanti solo con Jolpica.
    let openf1Sessions = null;
    try {
        openf1Sessions = await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}&session_name=Qualifying`);
    } catch (err) {
        console.warn(`⚠️  OpenF1 non disponibile (${err.message}): pole solo da Jolpica in questo run.`);
    }
    const names = knownDriverNames();

    const toProcess = pastQualyRaces
        .filter(r => {
            if (r.round === lastRace.round) return true;
            return !currentData.some(d => d.year === year && d.circuit === r.circuit);
        })
        .sort((a, b) => a.round - b.round);

    let changed = false;
    const errors = [];
    for (const race of toProcess) {
        const label = race.raceName || race.circuit;
        try {
            if (await processRound(season, race, label, currentData, openf1Sessions, names)) changed = true;
        } catch (err) {
            const hoursSince = (now - qualyEnd(race.schedule.qualy)) / 3600000;
            if (err instanceof HttpError && err.status === 404 && hoursSince < PENDING_GRACE_HOURS) {
                console.warn(`⏳ Round ${race.round}: risultati qualifica non ancora pubblicati (né OpenF1 né Jolpica; qualifica conclusa ${hoursSince.toFixed(1)}h fa): riproverò al prossimo run.`);
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
