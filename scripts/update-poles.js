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

// --- Mappatura Circuito: da parole chiave (circuitId/circuitName/country) al nome usato nel sito ---
const CIRCUIT_KEYWORDS = [
    { keywords: ['red_bull_ring', 'red bull ring', 'spielberg'], name: 'Red Bull Ring' },
    { keywords: ['americas', 'austin', 'cota'], name: 'Austin (COTA)' },
    { keywords: ['las_vegas', 'las vegas'], name: 'Las Vegas' },
    { keywords: ['miami'], name: 'Miami' },
    { keywords: ['rodriguez', 'mexico', 'messico'], name: 'Città del Messico' },
    { keywords: ['interlagos', 'sao_paulo', 'sao paulo', 'brazil', 'brasile'], name: 'Interlagos (San Paolo)' },
    { keywords: ['yas_marina', 'yas marina', 'abu_dhabi', 'abu dhabi'], name: 'Abu Dhabi (Yas Marina)' },
    { keywords: ['losail', 'qatar'], name: 'Qatar (Lusail)' },
    { keywords: ['marina_bay', 'marina bay', 'singapore'], name: 'Singapore' },
    { keywords: ['suzuka'], name: 'Suzuka' },
    { keywords: ['monza'], name: 'Monza' },
    { keywords: ['zandvoort'], name: 'Zandvoort' },
    { keywords: ['spa'], name: 'Spa-Francorchamps' },
    { keywords: ['hungaroring', 'hungary', 'ungheria'], name: 'Hungaroring' },
    { keywords: ['silverstone'], name: 'Silverstone' },
    { keywords: ['catalunya', 'barcelona', 'spain', 'spagna'], name: 'Barcellona' },
    { keywords: ['villeneuve', 'montreal', 'canada'], name: 'Montreal (Canada)' },
    { keywords: ['monaco'], name: 'Monaco' },
    { keywords: ['imola', 'emilia'], name: 'Imola' },
    { keywords: ['baku', 'azerbaijan'], name: 'Baku (Azerbaijan)' },
    { keywords: ['shanghai', 'china', 'cina'], name: 'Shanghai (Cina)' },
    { keywords: ['albert_park', 'melbourne', 'australia'], name: 'Melbourne (Australia)' },
    { keywords: ['jeddah', 'saudi'], name: 'Jeddah (Arabia Saudita)' },
    { keywords: ['bahrain', 'sakhir'], name: 'Bahrain (Sakhir)' },
];

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
    const circuitCandidates = [
        circuitInfo?.circuitId,
        circuitInfo?.circuitName,
        circuitInfo?.country,
        raceName,
    ];
    const mappedCircuit = matchByKeywords(circuitCandidates, CIRCUIT_KEYWORDS);

    if (!mappedCircuit) {
        throw new Error(
            `Impossibile mappare il circuito. Candidati trovati: ${JSON.stringify(circuitCandidates)}. ` +
            `Aggiungere una nuova voce a CIRCUIT_KEYWORDS in questo script.`
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
