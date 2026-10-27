// scripts/build-telemetry.js
//
// Scarica la telemetria (velocità, acceleratore, freno, marcia) del giro di
// pole di ogni GP di cui la qualifica è già stata disputata, da OpenF1
// (openf1.org, pubblica e gratuita, nessuna chiave richiesta - API diversa
// da Jolpica, usata per telemetria, risultati e calendario). Solo qualifiche (non prove
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
// CIRCUIT_ID_MAP (id Jolpica): OpenF1 usa nomi propri di circuito
// (circuit_short_name), mappati qui direttamente sui nomi usati dal sito.
//
// Le stagioni già presenti in telemetry.json vengono riusate circuito per
// circuito (non riscaricate), quindi ogni run scarica solo le gare nuove.
//
// Uso:
//   node scripts/build-telemetry.js            (dal 2023 all'anno in corso)
//   node scripts/build-telemetry.js 2026        (solo il 2026, es. per
//                                                 aggiungere i round nuovi)

const fs = require('fs');
const path = require('path');
const { writeStatus } = require('./lib/status');
const { openf1Json, CIRCUIT_MAP, circuitSlug } = require('./lib/openf1');
const { fetchJson } = require('./lib/http');

const OUT_PATH = path.join(__dirname, '..', 'telemetry.json');
// Tracciati dei giri di pole: un file per circuito e anno in
// tracks/{anno}/{circuito}.json (~2,5 KB compressi), caricato dal sito solo
// per il giro aperto. In telemetry.json (letto all'avvio) non finiscono.
// Formato: { rotation, corners: [[etichetta, x, y, angolo], ...], points:
// [[t, x, y], ...] } (i file più vecchi erano solo l'array dei punti).
const TRACKS_DIR = path.join(__dirname, '..', 'tracks');
const trackFile = (season, circuitName) => path.join(TRACKS_DIR, String(season), `${circuitSlug(circuitName)}.json`);
const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');
// Stagioni dal 2023 (OpenF1 non ha dati prima) all'anno in corso: con una
// lista fissa la telemetria si sarebbe fermata a gennaio dell'anno nuovo.
const FIRST_SEASON = 2023;
const defaultSeasons = () => Array.from({ length: new Date().getFullYear() - FIRST_SEASON + 1 }, (_, i) => FIRST_SEASON + i);
// Concorrenza bassa apposta: OpenF1 ha un rate limit reale (visto un 429
// durante un test con concorrenza 4) - meglio andare piano che perdere gare
// per errori di troppe richieste ravvicinate.
const CIRCUIT_CONCURRENCY = 2;
// Scarto massimo tra il tempo di pole in data.json e la durata del giro
// OpenF1 scelto. Le due fonti differiscono al più di pochi millesimi (tutti
// gli 85 giri attuali combaciano entro 0.05s): una soglia più larga (era 0.5)
// permetteva di scegliere un giro di Q1/Q2 quando il tempo in data.json era
// sbagliato (successo con Las Vegas e Abu Dhabi 2023).
const POLE_LAP_TOLERANCE_S = 0.1;

// Sessioni per cui OpenF1 non ha (e non avrà) i giri: restituisce 404 per
// sempre, quindi inutile ritentare a ogni run.
const KNOWN_UNAVAILABLE = new Set([
    '2025|Baku (Azerbaijan)',
]);

let poleDataCache = null;
// Il pilota realmente in pole (già verificato in data.json)
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
// Trova il giro di pole e ne scarica la telemetria completa, campione per
// campione. Il giro di pole NON è semplicemente il più veloce in assoluto
// tra tutti i piloti: un giro più veloce può essere stato cancellato per
// limiti di pista (successo davvero: Ungheria 2025, Norris più veloce di
// Leclerc ma con il giro annullato, pole a Leclerc). E non è nemmeno
// semplicemente il giro più veloce del pilota giusto nell'intera sessione:
// in condizioni miste/in evoluzione un giro di Q1/Q2 può risultare più
// veloce del vero giro di pole senza esserlo (successo davvero: Montreal
// 2023, sessione bagnata). Pilota E tempo vengono quindi letti entrambi da
// data.json (già verificato con altre fonti): si cerca il
// pilota giusto, poi tra i suoi giri quello con durata più vicina al tempo
// ufficiale.
// Trova il giro di pole (vedi commento sopra) e il pilota. null se non si
// può determinare con certezza. Usata sia per la telemetria sia per il
// tracciato (posizioni dell'auto).
async function findPoleLap(session, season, circuitName) {
    const laps = await openf1Json(`https://api.openf1.org/v1/laps?session_key=${session.session_key}`);
    const validLaps = laps.filter(l => typeof l.lap_duration === 'number' && l.lap_duration > 0);
    if (validLaps.length === 0) {
        console.warn(`⚠️  ${circuitName}: nessun giro valido trovato.`);
        return null;
    }

    // La pole in data.json (già verificata con una seconda fonte) è
    // OBBLIGATORIA: serve sia per trovare il pilota sia per scegliere il giro.
    // Prima, senza pole o senza un giro abbastanza vicino, si ripiegava sul
    // giro più veloce della sessione: una scelta che può essere sbagliata
    // (giro cancellato per track limits, sessione bagnata, Q1/Q2) e produceva
    // telemetria del giro sbagliato senza nessun avviso. Meglio nessuna
    // telemetria che quella di un altro giro.
    const poleEntry = getPoleEntry(season, circuitName);
    if (!poleEntry) {
        console.warn(`⚠️  ${circuitName}: nessuna pole in data.json per il ${season}, salto.`);
        return null;
    }
    const allDrivers = await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${session.session_key}`);
    const poleSurname = normalizeName(poleEntry.driver.trim().split(' ').pop());
    const matchedDriver = allDrivers.find(d => normalizeName(d.last_name) === poleSurname);
    if (!matchedDriver) {
        console.warn(`⚠️  ${circuitName}: pilota "${poleEntry.driver}" (pole da data.json) non trovato tra i piloti OpenF1, salto.`);
        return null;
    }
    const driverLaps = validLaps.filter(l => l.driver_number === matchedDriver.driver_number);
    if (driverLaps.length === 0) {
        console.warn(`⚠️  ${circuitName}: nessun giro valido per ${poleEntry.driver}, salto.`);
        return null;
    }
    // Giro del pilota giusto con durata più vicina al tempo ufficiale (non il
    // più veloce in assoluto: un giro di Q1/Q2, o uno cancellato per track
    // limits, può risultare più veloce del vero giro di pole).
    const poleLap = driverLaps.reduce((best, l) =>
        Math.abs(l.lap_duration - poleEntry.seconds) < Math.abs(best.lap_duration - poleEntry.seconds) ? l : best
    );
    if (Math.abs(poleLap.lap_duration - poleEntry.seconds) > POLE_LAP_TOLERANCE_S) {
        console.warn(`⚠️  ${circuitName}: nessun giro di ${poleEntry.driver} entro ${POLE_LAP_TOLERANCE_S}s dal tempo ufficiale (${poleEntry.seconds}s, più vicino ${poleLap.lap_duration}s): salto. Controllare il tempo in data.json (verify-data.js).`);
        return null;
    }

    // Stesso elenco già scaricato sopra: niente seconda richiesta.
    const driverInfo = allDrivers.find(d => d.driver_number === poleLap.driver_number) || null;
    return { poleLap, driverInfo };
}

// Tracciato del giro di pole: posizioni x/y dell'auto (OpenF1 /location, ~4
// al secondo) come [[secondi dall'inizio del giro, x, y], ...]. Serve alla
// mappa sotto la telemetria, dove un puntino segue l'istante indicato sui
// grafici: stessa frequenza e stessa origine dei tempi dei campioni.
async function fetchTrack(session, poleLap) {
    const lapStart = new Date(poleLap.date_start);
    const lapEnd = new Date(lapStart.getTime() + poleLap.lap_duration * 1000 + 500);
    const loc = await openf1Json(
        `https://api.openf1.org/v1/location?session_key=${session.session_key}&driver_number=${poleLap.driver_number}` +
        `&date>=${lapStart.toISOString()}&date<=${lapEnd.toISOString()}`
    );
    const pts = [];
    for (const p of loc) {
        const t = Math.round((new Date(p.date) - lapStart) / 10) / 100;
        if (t < 0 || t > poleLap.lap_duration + 0.5 || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
        const last = pts[pts.length - 1];
        if (last && last[1] === p.x && last[2] === p.y) continue; // punto ripetuto (auto ferma o campione doppio)
        pts.push([t, p.x, p.y]);
    }
    return pts.length >= 20 ? pts : null;
}

// Orientamento e curve del circuito come nelle grafiche ufficiali F1 (live
// timing), dall'API pubblica di MultiViewer: rotazione in gradi e posizione
// di ogni curva, nelle stesse coordinate di OpenF1 /location. Una richiesta
// per circuito e anno, salvata nel file del tracciato: il sito non dipende
// da MultiViewer mentre lo si consulta.
async function fetchCircuitMap(session, season) {
    if (!session.circuit_key) return null;
    try {
        const info = await fetchJson(`https://api.multiviewer.app/api/v1/circuits/${session.circuit_key}/${season}`, { allow404: true, retries: 2 });
        if (!info || typeof info.rotation !== 'number') return null;
        const corners = (info.corners || [])
            .filter(c => c.trackPosition && typeof c.trackPosition.x === 'number')
            .map(c => [`${c.number}${c.letter || ''}`, Math.round(c.trackPosition.x), Math.round(c.trackPosition.y), Math.round(c.angle || 0)]);
        return { rotation: info.rotation, corners };
    } catch (err) {
        console.warn(`  ⚠️  Orientamento/curve MultiViewer non disponibili (circuito ${session.circuit_key}, ${season}): ${err.message}`);
        return null;
    }
}

async function buildTrack(session, season, poleLap) {
    const points = await fetchTrack(session, poleLap);
    if (!points) return null;
    return { ...((await fetchCircuitMap(session, season)) || {}), points };
}

// Gomma del giro di pole (OpenF1 /stints): mescola dello stint che contiene
// quel giro, es. "SOFT", "INTERMEDIATE". null se OpenF1 non ha gli stint.
// I confini tra stint sono giri di rientro/uscita, mai il giro di pole,
// quindi un giro che cade su due stint non è mai quello cercato.
async function fetchPoleTyre(session, poleLap) {
    const stints = await openf1Json(`https://api.openf1.org/v1/stints?session_key=${session.session_key}&driver_number=${poleLap.driver_number}`);
    const n = poleLap.lap_number;
    const stint = stints.filter(s => s.lap_start <= n && n <= s.lap_end)
        .sort((a, b) => b.stint_number - a.stint_number)[0];
    return stint?.compound || null;
}

async function buildCircuitTelemetry(session, season) {
    const circuitName = CIRCUIT_MAP[session.circuit_short_name];
    if (!circuitName) {
        console.warn(`⚠️  Circuito OpenF1 "${session.circuit_short_name}" non mappato, salto.`);
        return null;
    }
    const found = await findPoleLap(session, season, circuitName);
    if (!found) return null;
    const { poleLap, driverInfo } = found;

    const lapStart = new Date(poleLap.date_start);
    // Margine di mezzo secondo oltre la durata del giro: i campioni di
    // car_data non arrivano esattamente al decimo di secondo del traguardo.
    const lapEnd = new Date(lapStart.getTime() + poleLap.lap_duration * 1000 + 500);

    const carData = await openf1Json(
        `https://api.openf1.org/v1/car_data?session_key=${session.session_key}&driver_number=${poleLap.driver_number}` +
        `&date>=${lapStart.toISOString()}&date<=${lapEnd.toISOString()}`
    );
    if (carData.length === 0) {
        console.warn(`⚠️  ${circuitName}: nessun dato telemetrico trovato per il giro di pole.`);
        return null;
    }

    // OpenF1 restituisce a volte 104 (valore fuori scala, non una percentuale
    // reale: osservato su Monza/Suzuka/Shanghai 2026 e Las Vegas 2023-24) per
    // acceleratore/freno quando il dato non è valido. Va scartato (null =
    // buco nel grafico): lasciato com'è, il grafico (max 100%) mostrava
    // acceleratore e freno a 100% insieme per diversi secondi.
    const validPercent = v => (typeof v === 'number' && v >= 0 && v <= 100) ? v : null;

    const samples = carData
        .map(d => {
            const throttle = validPercent(d.throttle);
            const brake = validPercent(d.brake);
            // Throttle e brake entrambi non validi = la telemetria dell'auto
            // si è interrotta in quel momento: nel dropout di Monza 2026
            // velocità e marcia restavano congelate all'ultimo valore (308
            // km/h, 8ª) mentre l'auto frenava davvero fino a 118 km/h. Anche
            // loro vanno scartati, altrimenti il grafico mostra un tratto falso.
            const dropout = throttle === null && brake === null;
            return {
                t: Math.round((new Date(d.date) - lapStart) / 10) / 100, // secondi dall'inizio del giro, 2 decimali
                speed: dropout ? null : d.speed,
                throttle,
                brake,
                gear: dropout ? null : d.n_gear,
            };
        })
        .filter(s => s.t >= 0 && s.t <= poleLap.lap_duration + 1);

    return {
        circuit: circuitName,
        driver: driverInfo ? `${driverInfo.first_name} ${driverInfo.last_name}` : null,
        team: driverInfo ? driverInfo.team_name : null,
        lapTime: Math.round(poleLap.lap_duration * 1000) / 1000,
        samples,
        track: await buildTrack(session, season, poleLap),
        tyre: await fetchPoleTyre(session, poleLap).catch(() => null),
    };
}

async function buildSeason(season, existingCircuits, saveProgress) {
    console.log(`\n=== Stagione ${season} ===`);
    console.log(`Richiesta sessioni di qualifica ${season} a OpenF1...`);
    const sessions = await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}&session_type=Qualifying`);
    // OpenF1 marca anche le qualifiche sprint con session_type "Qualifying":
    // si distinguono solo dal session_name ("Sprint Qualifying" vs "Qualifying").
    const mainQualy = sessions.filter(s => s.session_name === 'Qualifying');
    console.log(`${mainQualy.length} sessioni di qualifica (esclusa sprint) trovate.`);

    const now = new Date();
    const toProcess = mainQualy.filter(session => {
        const circuitName = CIRCUIT_MAP[session.circuit_short_name];
        if (circuitName && existingCircuits[circuitName]) return false; // già scaricato in un run precedente
        if (new Date(session.date_end) > now) return false; // non ancora disputata
        if (circuitName && KNOWN_UNAVAILABLE.has(`${season}|${circuitName}`)) return false;
        // Nessuna pole in data.json = gara annullata (OpenF1 elenca comunque
        // la sessione ma non ha i giri: Sakhir/Jeddah 2026, Imola 2023). Si
        // salta senza richieste, invece di fallire con un 404 a ogni run.
        if (circuitName && !getPoleEntry(season, circuitName)) return false;
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

    // Tracciati mancanti per giri già in archivio (scaricati prima che
    // esistesse la mappa, o un download del tracciato andato male): si
    // recuperano senza riscaricare la telemetria.
    const trackTodo = mainQualy.filter(session => {
        const name = CIRCUIT_MAP[session.circuit_short_name];
        return name && circuits[name] && !circuits[name].track && !fs.existsSync(trackFile(season, name));
    });
    if (trackTodo.length) console.log(`${trackTodo.length} tracciati da recuperare per giri già in archivio.`);
    for (const session of trackTodo) {
        const name = CIRCUIT_MAP[session.circuit_short_name];
        try {
            const found = await findPoleLap(session, season, name);
            const track = found ? await buildTrack(session, season, found.poleLap) : null;
            if (track) {
                circuits[name] = { ...circuits[name], track };
                saveProgress(circuits);
                console.log(`  🗺️  ${name}: tracciato di ${track.points.length} punti`);
            } else {
                console.warn(`  ⚠️  ${name}: tracciato non disponibile`);
            }
        } catch (err) {
            console.warn(`  ⚠️  ${name}: errore tracciato - ${err.message}`);
        }
    }

    // Gomma del giro di pole per i giri già in archivio (aggiunta il
    // 2026-10-28): una volta sola per circuito; tyre: null = OpenF1 senza
    // dati sugli stint, non si riprova.
    const tyreTodo = mainQualy.filter(session => {
        const name = CIRCUIT_MAP[session.circuit_short_name];
        return name && circuits[name] && !('tyre' in circuits[name]);
    });
    if (tyreTodo.length) console.log(`${tyreTodo.length} gomme del giro di pole da recuperare.`);
    for (const session of tyreTodo) {
        const name = CIRCUIT_MAP[session.circuit_short_name];
        try {
            const found = await findPoleLap(session, season, name);
            if (!found) continue;
            const tyre = await fetchPoleTyre(session, found.poleLap);
            circuits[name] = { ...circuits[name], tyre };
            saveProgress(circuits);
            console.log(`  🛞 ${name}: ${tyre || 'gomma non disponibile'}`);
        } catch (err) {
            console.warn(`  ⚠️  ${name}: errore gomma - ${err.message}`);
        }
    }

    // Tracciati già salvati senza orientamento/curve (file nel formato
    // vecchio, o MultiViewer non rispondeva al momento del download): si
    // aggiungono senza riscaricare le posizioni. Se MultiViewer non ha il
    // circuito si riprova al run successivo (una sola richiesta).
    for (const session of mainQualy) {
        const name = CIRCUIT_MAP[session.circuit_short_name];
        const file = name && trackFile(season, name);
        if (!file || !fs.existsSync(file)) continue;
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!Array.isArray(saved) && typeof saved.rotation === 'number') continue;
        const map = await fetchCircuitMap(session, season);
        if (!map) continue;
        const points = Array.isArray(saved) ? saved : saved.points;
        fs.writeFileSync(file, JSON.stringify({ ...map, points }) + '\n', 'utf-8');
        console.log(`  🧭 ${name}: orientamento ${map.rotation}° e ${map.corners.length} curve`);
    }

    return circuits;
}

async function main() {
    const argSeasons = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
    const seasons = argSeasons.length > 0 ? argSeasons : defaultSeasons();

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
    // Ultima versione SERIALIZZATA scritta per ogni stagione. Si confrontano
    // stringhe e non oggetti: "circuits" viene modificato in place dai worker,
    // quindi confrontare l'oggetto con sé stesso dava sempre "uguale" e
    // saltava la scrittura dei circuiti nuovi (bug trovato in test).
    const lastSerialized = {};
    for (const [season, value] of Object.entries(outputSeasons)) lastSerialized[season] = JSON.stringify(value);
    function saveProgress(season, circuits) {
        // Niente scrittura se i dati di questa stagione non sono cambiati:
        // il file pesa 1,5 MB e riscriverlo solo per aggiornare updatedAt
        // produceva un commit pesante (e un deploy) a ogni esecuzione, anche
        // senza nessun giro nuovo.
        // Il tracciato (campo "track") va nel suo file in tracks/, non in
        // telemetry.json; riscritto solo se cambia.
        const clean = {};
        for (const [name, entry] of Object.entries(circuits)) {
            const { track, ...rest } = entry;
            clean[name] = rest;
            if (track) {
                const file = trackFile(season, name);
                const content = JSON.stringify(track) + '\n';
                if (!fs.existsSync(file) || fs.readFileSync(file, 'utf-8') !== content) {
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, content, 'utf-8');
                }
            }
        }
        const serialized = JSON.stringify({ circuits: clean });
        if (lastSerialized[season] === serialized) return;
        lastSerialized[season] = serialized;
        outputSeasons[season] = { circuits: clean };
        const output = { updatedAt: new Date().toISOString(), seasons: outputSeasons };
        fs.writeFileSync(OUT_PATH, JSON.stringify(output) + '\n', 'utf-8');
    }

    for (const season of seasons) {
        const existingCircuits = (outputSeasons[season] && outputSeasons[season].circuits) || {};
        const circuits = await buildSeason(season, existingCircuits, (c) => saveProgress(season, c));
        saveProgress(season, circuits);
    }

    const totalCircuits = Object.values(outputSeasons).reduce((sum, s) => sum + Object.keys(s.circuits).length, 0);
    console.log(`\n✅ telemetry.json pronto (${Object.keys(outputSeasons).length} stagioni, ${totalCircuits} circuiti totali).`);
}

main()
    .then(() => writeStatus('telemetry', true))
    .catch(err => {
        console.error('❌ Errore durante la costruzione della telemetria:', err.message);
        writeStatus('telemetry', false, err.message);
        process.exit(1);
    });
