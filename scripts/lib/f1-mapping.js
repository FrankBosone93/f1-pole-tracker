// scripts/lib/f1-mapping.js
//
// Mappature condivise tra update-poles.js, check-pole-penalty.js e verify-data.js,
// per evitare di duplicare (e disallineare) la stessa logica in più file.

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
    'sepang': 'Sepang (Malesia)', // round 16 del 2026 ("Bahrain GP in Malaysia"): gara spostata a Sepang
    // Circuiti storici non più in calendario, ma presenti in data.json (stagione 2021)
    'ricard': 'Paul Ricard (Francia)',
    'sochi': 'Sochi (Russia)',
    'portimao': 'Portimão (Portogallo)',
    'istanbul': 'Istanbul (Turchia)',
};

// Circuiti nuovi riconosciuti in automatico da update-calendar.js (vedi
// lib/auto-circuits.js): si aggiungono solo dove la tabella sopra non ha già
// una voce, che resta sempre la scelta di riferimento.
for (const [id, entry] of Object.entries(require('./auto-circuits').loadAutoCircuits().f1api)) {
    if (!(id in CIRCUIT_ID_MAP) && entry && entry.name) CIRCUIT_ID_MAP[id] = entry.name;
}

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
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // rimuove accenti
        .replace(/[^a-z0-9]+/g, '_');
}

function matchCircuitById(circuitId) {
    if (!circuitId || typeof circuitId !== 'string') return null;
    return CIRCUIT_ID_MAP[circuitId.toLowerCase()] || null;
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

function matchTeam(teamRaw) {
    return matchByKeywords([teamRaw], TEAM_KEYWORDS) || teamRaw;
}

// Converte una stringa tempo in formato M:SS.mmm (o simili) in {timeStr, seconds}
// Ritorna null se il formato non è riconosciuto o il valore non è un tempo valido (es. "-").
function parseQualyTime(raw) {
    if (!raw || typeof raw !== 'string' || raw === '-' || raw.trim() === '') return null;

    // Formato atteso più comune per un giro secco di qualifica: M:SS.mmm.
    // Per alcune stagioni (es. 2024) l'API usa i due punti anche prima dei
    // millesimi ("1:29:179"): accettati entrambi, altrimenti la pole veniva
    // letta come "tempo non valido".
    const simple = raw.match(/^(\d{1,2}):(\d{2})[.:](\d{1,3})$/);
    if (simple) {
        const mins = parseInt(simple[1], 10);
        const secs = parseInt(simple[2], 10);
        const ms = parseInt(simple[3].padEnd(3, '0'), 10);
        const seconds = mins * 60 + secs + ms / 1000;
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
        return { timeStr, seconds: Math.round(seconds * 1000) / 1000 };
    }

    return null;
}

function driverFullName(driver) {
    return [driver?.name, driver?.surname].filter(Boolean).join(' ').trim();
}

module.exports = {
    CIRCUIT_ID_MAP,
    TEAM_KEYWORDS,
    normalize,
    matchCircuitById,
    matchByKeywords,
    matchTeam,
    parseQualyTime,
    driverFullName,
};
