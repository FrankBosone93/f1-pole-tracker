// scripts/update-poles.js
//
// Scarica automaticamente il risultato dell'ultima qualifica F1 da f1api.dev
// (API pubblica e gratuita, nessuna chiave richiesta) e aggiorna data.json
// con la pole position più recente, se non è già presente.
//
// Pensato per essere eseguito da una GitHub Action pianificata
// (vedi .github/workflows/update-poles.yml), ma funziona anche a mano:
//   node scripts/update-poles.js
//
// NOTA IMPORTANTE: questo script è stato scritto sulla base della
// documentazione pubblica di f1api.dev (endpoint "[year]/[round]/qualy" e
// "current/last/qualy"), ma non è stato possibile testarlo dal vivo in fase
// di sviluppo (ambiente senza accesso rete). Il parsing è scritto in modo
// difensivo con log dettagliati: la prima esecuzione reale nella GitHub
// Action va controllata nei log per verificare che tutto combaci.

const fs = require('fs');
const path = require('path');

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');
const API_URL = 'https://f1api.dev/api/current/last/qualy';

// --- Mappatura Circuito: circuitId dell'API (match ESATTO, case-insensitive) -> nome usato nel sito ---
// NOTA: in passato questa tabella funzionava per parole chiave cercate anche dentro
// "country" e "raceName", ma è un approccio fragile: "country: Spain" contiene la
// sottostringa "spa" (Spagna veniva scambiata per Spa-Francorchamps) e molte gare
// usano "Qatar Airways" come sponsor del titolo anche quando il circuito non è il
// Qatar (es. "Qatar Airways Australian Grand Prix", venendo scambiate per Qatar/Lusail).
// Il circuitId invece è stabile e univoco: si mappa 1:1, senza ambiguità.
const CIRCUIT_ID_MAP = {
    'red_bull_ring': 'Red Bull Ring',
    'americas': 'Austin (COTA)',
    'austin': 'Austin (COTA)',
    'las_vegas': 'Las Vegas',
    'vegas': 'Las Vegas',
    'miami': 'Miami',
    'rodriguez': 'Città del Messico',
    'hermanos_rodriguez': 'Città del Messico',
    'interlagos': 'Interlagos (San Paolo)',
    'yas_marina': 'Abu Dhabi (Yas Marina)',
    'losail': 'Qatar (Lusail)',
    'lusail': 'Qatar (Lusail)',
    'marina_bay': 'Singapore',
    'suzuka': 'Suzuka',
    'monza': 'Monza',
    'zandvoort': 'Zandvoort',
    'spa': 'Spa-Francorchamps',
    'hungaroring': 'Hungaroring',
    'silverstone': 'Silverstone',
    'catalunya': 'Barcellona',
    'montmelo': 'Barcellona',
    'madring': 'Madrid', // nuovo circuito dal calendario 2026 (round 14), gara distinta da Barcellona
    'villeneuve': 'Montreal (Canada)',
    'gilles_villeneuve': 'Montreal (Canada)',
    'monaco': 'Monaco',
    'imola': 'Imola',
    'baku': 'Baku (Azerbaijan)',
    'shanghai': 'Shanghai (Cina)',
    'albert_park': 'Melbourne (Australia)',
    'jeddah': 'Jeddah (Arabia Saudita)',
    'bahrain': 'Bahrain (Sakhir)',
    // Circuiti storici non più in calendario, ma presenti in data.json (stagione 2021)
    'ricard': 'Paul Ricard (Francia)',
    'sochi': 'Sochi (Russia)',
    'portimao': 'Portimão (Portogallo)',
    'istanbul': 'Istanbul (Turchia)',
};

// --- Mappatura Team: nome completo restituito dall'API -> nome breve usato nel sito ---
const TEAM_KEYWORDS = [
    { keywords: ['mercedes'], name: 'Mercedes' },
    { keywords: ['red_bull', 'red bull'], name: 'Red Bull' },
    { keywords: ['ferrari'], name: 'Ferrari' },
    { keywords: ['mclaren'], name: 'McLaren' },
    { keywords: ['aston_martin', 'aston martin'], name: 'Aston Martin' },
    { keywords: ['alpine'], name: 'Alpine' },
    { keywords: ['williams'], name: 'Williams' },
    { keywords: ['haas'], name: 'Haas' },
    { keywords: ['racing bulls', 'rb f1', 'visa cash app'], name: 'RB' },
    { keywords: ['audi'], name: 'Audi' },
    { keywords: ['cadillac'], name: 'Cadillac' },
];

function normalize(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rimuove accenti
        .replace(/[^a-z0-9]+/g, '_');
}

// Usata solo per il team (un'unica stringa affidabile, il nome ufficiale del team,
// non inquinata da sponsor/nomi di gara come invece accade per circuitName/raceName).
function matchByKeywords(candidates, table) {
    const normalizedCandidates = candidates.filter(Boolean).map(normalize);
    for (const entry of table) {
        for (const kw of entry.keywords) {
            const normalizedKw = normalize(kw);
            if (normalizedCandidates.some(c => c.includes(normalizedKw))) {
                return entry.name;
            }
        }
    }
    return null;
}

function matchCircuitById(circuitId) {
    if (!circuitId || typeof circuitId !== 'string') return null;
    return CIRCUIT_ID_MAP[circuitId.toLowerCase()] || null;
}

// Converte una stringa tempo in formato M:SS.mmm (o simili) in {timeStr, seconds}
// Ritorna null se il formato non è riconosciuto o il valore non è un tempo valido (es. "-").
function parseQualyTime(raw) {
    if (!raw || typeof raw !== 'string' || raw === '-' || raw.trim() === '') return null;

    // Formato atteso più comune per un giro secco di qualifica: M:SS.mmm
    const simple = raw.match(/^(\d{1,2}):(\d{2})\.(\d{1,3})$/);
    if (simple) {
        const mins = parseInt(simple[1], 10);
        const secs = parseInt(simple[2], 10);
        const ms = parseInt(simple[3].padEnd(3, '0'), 10);
        const seconds = mins * 60 + secs + ms / 1000;
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
        return { timeStr, seconds: Math.round(seconds * 1000) / 1000 };
    }

    console.warn(`⚠️  Formato tempo non riconosciuto, ignorato: "${raw}"`);
    return null;
}

async function main() {
    console.log(`Richiesta a ${API_URL} ...`);
    const response = await fetch(API_URL);
    if (!response.ok) {
        throw new Error(`Risposta API non valida: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();

    // Log completo per debug: se la struttura reale differisce da quella attesa,
    // questo output nei log della GitHub Action aiuta a correggere lo script.
    console.log('Struttura risposta ricevuta (troncata):', JSON.stringify(payload).slice(0, 2000));

    const season = payload.season || payload?.races?.season;
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
            `Aggiungere una nuova voce a CIRCUIT_ID_MAP in questo script.`
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
    const mappedTeam = matchByKeywords([teamRaw], TEAM_KEYWORDS) || teamRaw;

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

    // --- Aggiornamento data.json ---
    const currentData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));

    const existingIndex = currentData.findIndex(d => d.year === year && d.circuit === mappedCircuit);
    const existingWeather = existingIndex > -1 ? currentData[existingIndex].weather : '☀️ Sereno';

    const newEntry = {
        year,
        circuit: mappedCircuit,
        driver: driverFullName,
        team: mappedTeam,
        timeStr: parsedTime.timeStr,
        seconds: parsedTime.seconds,
        weather: existingWeather,
    };

    let changed = false;
    if (existingIndex > -1) {
        const existing = currentData[existingIndex];
        const isSame = existing.driver === newEntry.driver &&
            existing.team === newEntry.team &&
            existing.timeStr === newEntry.timeStr;
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
        // Segnale per il workflow GitHub Actions (vedi update-poles.yml)
        console.log('::set-output name=changed::true');
    } else {
        console.log('::set-output name=changed::false');
    }
}

main().catch(err => {
    console.error('❌ Errore durante l\'aggiornamento:', err.message);
    process.exit(1);
});
