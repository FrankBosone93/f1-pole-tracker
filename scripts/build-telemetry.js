// scripts/build-telemetry.js
//
// Scarica la telemetria (velocità, acceleratore, freno, marcia) del giro di
// pole di ogni GP di cui la qualifica è già stata disputata, da OpenF1
// (openf1.org, pubblica e gratuita, nessuna chiave richiesta - API diversa
// da f1api.dev, usata solo per questa funzione). Solo qualifiche (non prove
// libere, non sprint). Scrive telemetry.json, organizzato per stagione:
// { updatedAt, seasons: { "2023": {...}, "2024": {...}, "2025": {...}, "2026": {...} } }.
// Permette il confronto/sovrapposizione tra il giro di pole di stagioni
// diverse per lo stesso circuito nel sito.
//
// OpenF1 non ha ALCUN dato (nemmeno i metadati di sessione) per il 2021 e il
// 2022 ("No results found" su /sessions) - lacuna strutturale e permanente
// della fonte, non un problema temporaneo. 2023 in poi è invece coperto
// con la stessa granularità di 2025/2026 (verificato: giri e telemetria
// completa presenti).
//
// A differenza degli altri script, qui non serve incrociare i circuiti con
// CIRCUIT_ID_MAP di f1api.dev: OpenF1 usa nomi propri di circuito
// (circuit_short_name), mappati qui direttamente sui nomi usati dal sito.
//
// Le stagioni già presenti in telemetry.json vengono riusate circuito per
// circuito (non riscaricate), quindi ogni run scarica solo le gare nuove.
//
// Uso:
//   node scripts/build-telemetry.js            (2023-2026)
//   node scripts/build-telemetry.js 2026        (solo il 2026, es. per
//                                                 aggiungere i round nuovi)

const fs = require('fs');
const path = require('path');
const { writeStatus } = require('./lib/status');

const OUT_PATH = path.join(__dirname, '..', 'telemetry.json');
const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');
const DEFAULT_SEASONS = [2023, 2024, 2025, 2026];
// Concorrenza bassa apposta: OpenF1 ha un rate limit reale (visto un 429
// durante un test con concorrenza 4) - meglio andare piano che perdere gare
// per errori di troppe richieste ravvicinate.
const CIRCUIT_CONCURRENCY = 2;

// circuit_short_name (OpenF1) -> nome circuito usato dal sito.
const CIRCUIT_MAP = {
    'Imola': 'Imola',
    'Melbourne': 'Melbourne (Australia)',
    'Shanghai': 'Shanghai (Cina)',
    'Suzuka': 'Suzuka',
    'Sakhir': 'Bahrain (Sakhir)',
    'Jeddah': 'Jeddah (Arabia Saudita)',
    'Miami': 'Miami',
    'Montreal': 'Montreal (Canada)',
    'Monte Carlo': 'Monaco',
    'Catalunya': 'Barcellona',
    'Spielberg': 'Red Bull Ring',
    'Silverstone': 'Silverstone',
    'Spa-Francorchamps': 'Spa-Francorchamps',
    'Hungaroring': 'Hungaroring',
    'Zandvoort': 'Zandvoort',
    'Monza': 'Monza',
    'Madring': 'Madrid',
    'Baku': 'Baku (Azerbaijan)',
    'Singapore': 'Singapore',
    'Austin': 'Austin (COTA)',
    'Mexico City': 'Città del Messico',
    'Interlagos': 'Interlagos (San Paolo)',
    'Las Vegas': 'Las Vegas',
    'Lusail': 'Qatar (Lusail)',
    'Yas Marina Circuit': 'Abu Dhabi (Yas Marina)',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let poleDataCache = null;
// Il pilota realmente in pole (già verificato in data.json, fonte f1api.dev)
// per anno+circuito, o null se non presente. Serve sia il nome (per trovare
// il pilota giusto tra quelli OpenF1) sia il tempo (per trovare il giro
// giusto tra quelli di quel pilota - vedi buildCircuitTelemetry).
function getPoleEntry(season, circuitName) {
    if (!poleDataCache) poleDataCache = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
    return poleDataCache.find(r => r.year === season && r.circuit === circuitName) || null;
}

function normalizeName(s) {
    return (s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z]/g, '');
}

// OpenF1 ha un rate limit reale (429 osservato durante lo sviluppo): un 429
// viene ritentato con backoff invece di far fallire l'intero circuito.
async function fetchJson(url, attempt = 1) {
    const res = await fetch(url);
    if (res.status === 429 && attempt <= 5) {
        const waitMs = 1000 * attempt;
        console.warn(`   ⏳ 429 (troppe richieste), riprovo tra ${waitMs}ms...`);
        await sleep(waitMs);
        return fetchJson(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
    return res.json();
}

// Trova il giro di pole e ne scarica la telemetria completa, campione per
// campione. Il giro di pole NON è semplicemente il più veloce in assoluto
// tra tutti i piloti: un giro più veloce può essere stato cancellato per
// limiti di pista (successo davvero: Ungheria 2025, Norris più veloce di
// Leclerc ma con il giro annullato, pole a Leclerc). E non è nemmeno
// semplicemente il giro più veloce del pilota giusto nell'intera sessione:
// in condizioni miste/in evoluzione un giro di Q1/Q2 può risultare più
// veloce del vero giro di pole senza esserlo (successo davvero: Montreal
// 2023, sessione bagnata). Pilota E tempo vengono quindi letti entrambi da
// data.json (già verificato da un'altra fonte, f1api.dev): si cerca il
// pilota giusto, poi tra i suoi giri quello con durata più vicina al tempo
// ufficiale.
async function buildCircuitTelemetry(session, season) {
    const circuitName = CIRCUIT_MAP[session.circuit_short_name];
    if (!circuitName) {
        console.warn(`⚠️  Circuito OpenF1 "${session.circuit_short_name}" non mappato, salto.`);
        return null;
    }

    const laps = await fetchJson(`https://api.openf1.org/v1/laps?session_key=${session.session_key}`);
    const validLaps = laps.filter(l => typeof l.lap_duration === 'number' && l.lap_duration > 0);
    if (validLaps.length === 0) {
        console.warn(`⚠️  ${circuitName}: nessun giro valido trovato.`);
        return null;
    }

    const poleEntry = getPoleEntry(season, circuitName);
    let poleLap = null;
    if (poleEntry) {
        const allDrivers = await fetchJson(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`);
        const poleSurname = normalizeName(poleEntry.driver.trim().split(' ').pop());
        const matchedDriver = allDrivers.find(d => normalizeName(d.last_name) === poleSurname);
        if (matchedDriver) {
            const driverLaps = validLaps.filter(l => l.driver_number === matchedDriver.driver_number);
            if (driverLaps.length > 0) {
                // Il giro di pole è quello del pilota giusto la cui durata è
                // più vicina al tempo ufficiale di data.json - NON il suo
                // giro più veloce in assoluto nella sessione: un giro di
                // Q1/Q2 (asfalto diverso, prima che venisse cancellato per
                // track limits, o - visto realmente a Montreal 2023 - una
                // sessione bagnata con condizioni molto diverse tra un
                // segmento e l'altro) può risultare più veloce del vero
                // giro di pole senza esserlo davvero.
                const closest = driverLaps.reduce((best, l) =>
                    Math.abs(l.lap_duration - poleEntry.seconds) < Math.abs(best.lap_duration - poleEntry.seconds) ? l : best
                );
                if (Math.abs(closest.lap_duration - poleEntry.seconds) <= 0.5) {
                    poleLap = closest;
                } else {
                    console.warn(`⚠️  ${circuitName}: nessun giro di ${poleEntry.driver} vicino al tempo ufficiale (${poleEntry.seconds}s, più vicino trovato ${closest.lap_duration}s), uso il minimo assoluto come ripiego.`);
                }
            } else {
                console.warn(`⚠️  ${circuitName}: nessun giro valido per ${poleEntry.driver} (pole da data.json), uso il minimo assoluto come ripiego.`);
            }
        } else {
            console.warn(`⚠️  ${circuitName}: pilota "${poleEntry.driver}" (pole da data.json) non trovato tra i piloti OpenF1, uso il minimo assoluto come ripiego.`);
        }
    }
    // Ripiego (nessuna voce in data.json per questo anno+circuito, o pilota
    // non riconosciuto): il minimo assoluto resta una stima ragionevole.
    if (!poleLap) {
        poleLap = validLaps.reduce((best, l) => (l.lap_duration < best.lap_duration ? l : best));
    }

    const drivers = await fetchJson(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}&driver_number=${poleLap.driver_number}`);
    const driverInfo = drivers[0] || null;

    const lapStart = new Date(poleLap.date_start);
    // Margine di mezzo secondo oltre la durata del giro: i campioni di
    // car_data non arrivano esattamente al decimo di secondo del traguardo.
    const lapEnd = new Date(lapStart.getTime() + poleLap.lap_duration * 1000 + 500);

    const carData = await fetchJson(
        `https://api.openf1.org/v1/car_data?session_key=${session.session_key}&driver_number=${poleLap.driver_number}` +
        `&date>=${lapStart.toISOString()}&date<=${lapEnd.toISOString()}`
    );
    if (carData.length === 0) {
        console.warn(`⚠️  ${circuitName}: nessun dato telemetrico trovato per il giro di pole.`);
        return null;
    }

    const samples = carData
        .map(d => ({
            t: Math.round((new Date(d.date) - lapStart) / 10) / 100, // secondi dall'inizio del giro, 2 decimali
            speed: d.speed,
            throttle: d.throttle,
            brake: d.brake,
            gear: d.n_gear,
        }))
        .filter(s => s.t >= 0 && s.t <= poleLap.lap_duration + 1);

    return {
        circuit: circuitName,
        driver: driverInfo ? `${driverInfo.first_name} ${driverInfo.last_name}` : null,
        team: driverInfo ? driverInfo.team_name : null,
        lapTime: Math.round(poleLap.lap_duration * 1000) / 1000,
        samples,
    };
}

async function buildSeason(season, existingCircuits, saveProgress) {
    console.log(`\n=== Stagione ${season} ===`);
    console.log(`Richiesta sessioni di qualifica ${season} a OpenF1...`);
    const sessions = await fetchJson(`https://api.openf1.org/v1/sessions?year=${season}&session_type=Qualifying`);
    // OpenF1 marca anche le qualifiche sprint con session_type "Qualifying":
    // si distinguono solo dal session_name ("Sprint Qualifying" vs "Qualifying").
    const mainQualy = sessions.filter(s => s.session_name === 'Qualifying');
    console.log(`${mainQualy.length} sessioni di qualifica (esclusa sprint) trovate.`);

    const now = new Date();
    const toProcess = mainQualy.filter(session => {
        const circuitName = CIRCUIT_MAP[session.circuit_short_name];
        if (circuitName && existingCircuits[circuitName]) return false; // già scaricato in un run precedente
        if (new Date(session.date_end) > now) return false; // non ancora disputata
        return true;
    });
    console.log(`${toProcess.length} circuiti da scaricare (gli altri sono già in cache o non ancora disputati).`);

    const circuits = { ...existingCircuits };
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= toProcess.length) return;
            const session = toProcess[i];
            try {
                const result = await buildCircuitTelemetry(session, season);
                if (result) {
                    circuits[result.circuit] = result;
                    console.log(`  ✅ ${result.circuit}: ${result.driver} (${result.team}) - ${result.samples.length} campioni, giro ${result.lapTime}s`);
                    // Scrittura incrementale: un errore/interruzione più
                    // avanti non fa perdere i circuiti già scaricati.
                    saveProgress(circuits);
                }
            } catch (err) {
                console.warn(`⚠️  ${session.circuit_short_name}: errore - ${err.message}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(CIRCUIT_CONCURRENCY, toProcess.length) }, worker));

    return circuits;
}

async function main() {
    const argSeasons = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
    const seasons = argSeasons.length > 0 ? argSeasons : DEFAULT_SEASONS;

    let existing = { updatedAt: null, seasons: {} };
    if (fs.existsSync(OUT_PATH)) {
        existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
        if (!existing.seasons) {
            // Formato precedente (un solo season/circuits piatto, prima del
            // confronto multi-stagione): migra in "seasons" invece di
            // ributtare via dati già validati e riscaricarli inutilmente.
            existing = { updatedAt: existing.updatedAt, seasons: existing.season ? { [existing.season]: { circuits: existing.circuits || {} } } : {} };
        }
    }

    const outputSeasons = { ...existing.seasons };
    function saveProgress(season, circuits) {
        outputSeasons[season] = { circuits };
        const output = { updatedAt: new Date().toISOString(), seasons: outputSeasons };
        fs.writeFileSync(OUT_PATH, JSON.stringify(output) + '\n', 'utf-8');
    }

    for (const season of seasons) {
        const existingCircuits = (outputSeasons[season] && outputSeasons[season].circuits) || {};
        const circuits = await buildSeason(season, existingCircuits, (c) => saveProgress(season, c));
        saveProgress(season, circuits);
    }

    const totalCircuits = Object.values(outputSeasons).reduce((sum, s) => sum + Object.keys(s.circuits).length, 0);
    console.log(`\n✅ telemetry.json scritto (${Object.keys(outputSeasons).length} stagioni, ${totalCircuits} circuiti totali).`);
}

main()
    .then(() => writeStatus('telemetry', true))
    .catch(err => {
        console.error('❌ Errore durante la costruzione della telemetria:', err.message);
        writeStatus('telemetry', false, err.message);
        process.exit(1);
    });
