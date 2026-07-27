// scripts/build-telemetry.js
//
// Scarica la telemetria (velocità, acceleratore, freno, marcia) del giro di
// pole di ogni GP 2026 di cui la qualifica è già stata disputata, da OpenF1
// (openf1.org, pubblica e gratuita, nessuna chiave richiesta - API diversa
// da f1api.dev, usata solo per questa funzione). Solo qualifiche (non prove
// libere, non sprint) e solo la stagione 2026, su richiesta esplicita.
// Scrive telemetry.json.
//
// A differenza degli altri script, qui non serve incrociare i circuiti con
// CIRCUIT_ID_MAP di f1api.dev: OpenF1 usa nomi propri di circuito
// (circuit_short_name), mappati qui direttamente sui nomi usati dal sito.
//
// Uso: node scripts/build-telemetry.js

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'telemetry.json');
const SEASON = 2026;

// circuit_short_name (OpenF1) -> nome circuito usato dal sito.
const CIRCUIT_MAP = {
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

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
    return res.json();
}

// Trova il giro di pole (il più veloce tra tutti quelli con un tempo
// registrato) e ne scarica la telemetria completa, campione per campione.
async function buildCircuitTelemetry(session) {
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
    const poleLap = validLaps.reduce((best, l) => (l.lap_duration < best.lap_duration ? l : best));

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

async function main() {
    console.log(`Richiesta sessioni di qualifica ${SEASON} a OpenF1...`);
    const sessions = await fetchJson(`https://api.openf1.org/v1/sessions?year=${SEASON}&session_type=Qualifying`);
    // OpenF1 marca anche le qualifiche sprint con session_type "Qualifying":
    // si distinguono solo dal session_name ("Sprint Qualifying" vs "Qualifying").
    const mainQualy = sessions.filter(s => s.session_name === 'Qualifying');
    console.log(`${mainQualy.length} sessioni di qualifica (esclusa sprint) trovate.`);

    const now = new Date();
    const circuits = {};
    for (const session of mainQualy) {
        if (new Date(session.date_end) > now) {
            console.log(`⏭️  ${session.circuit_short_name}: qualifica non ancora disputata, salto.`);
            continue;
        }
        console.log(`Elaboro ${session.circuit_short_name} (session_key ${session.session_key})...`);
        try {
            const result = await buildCircuitTelemetry(session);
            if (result) {
                circuits[result.circuit] = result;
                console.log(`  ✅ ${result.circuit}: ${result.driver} (${result.team}) - ${result.samples.length} campioni, giro ${result.lapTime}s`);
            }
        } catch (err) {
            console.warn(`⚠️  ${session.circuit_short_name}: errore - ${err.message}`);
        }
    }

    const output = { season: SEASON, updatedAt: new Date().toISOString(), circuits };
    fs.writeFileSync(OUT_PATH, JSON.stringify(output) + '\n', 'utf-8');
    console.log(`✅ telemetry.json scritto (${Object.keys(circuits).length} circuiti).`);
}

main().catch(err => {
    console.error('❌ Errore durante la costruzione della telemetria:', err.message);
    process.exit(1);
});
