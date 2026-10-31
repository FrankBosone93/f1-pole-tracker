// scripts/lib/weather.js
//
// Meteo della qualifica, usato da update-poles.js per ogni nuova pole.
// Revisione del 2026-10-31: prima si usava il meteo GIORNALIERO di Open-Meteo
// (pioggia in mm su tutta la giornata), che sbagliava spesso: 21 pole dal 2023
// risultavano "pioggia" pur essendo state fatte con gomme da asciutto. Ora:
//   - pioggia: dati meteo misurati in pista durante la qualifica (OpenF1
//     /weather, campo rainfall) più la gomma del giro di pole (OpenF1 /stints).
//     Gomma intermedia o da bagnato = qualifica sul bagnato; pioggia in pista
//     ma pole con le slick = "Pista umida";
//   - nuvole e temperatura: Open-Meteo ORARIO all'ora della qualifica
//     (temperatura dell'aria misurata in pista quando OpenF1 c'è).
// Le pole 2021-2022 (senza dati OpenF1) sono state ricontrollate a mano.

// Coordinate e fuso orario IANA del circuito, più se la sessione si disputa
// tipicamente in notturna/twilight (per la descrizione "Notturno").
//
// NOTA IMPORTANTE: il calendario fornisce data e ora della qualifica in UTC
// (es. "2024-11-23" + "06:00:00Z" per Las Vegas). Per circuiti lontani da UTC
// la data del calendario UTC può differire dalla data locale del circuito
// (Las Vegas: 06:00 UTC del 23 novembre è le 22:00 locali del 22 novembre,
// un giorno prima!). Serve quindi calcolare la data locale corretta con il
// fuso orario del circuito PRIMA di interrogare Open-Meteo, altrimenti si
// rischia di prendere il meteo del giorno sbagliato (successo per errore con
// il GP Australia 2025, corretto durante lo sviluppo).
const CIRCUIT_INFO = {
    'Sepang (Malesia)': { lat: 2.7608, lon: 101.7380, tz: 'Asia/Kuala_Lumpur', night: false },
    'Bahrain (Sakhir)': { lat: 26.0325, lon: 50.5106, tz: 'Asia/Bahrain', night: true },
    'Jeddah (Arabia Saudita)': { lat: 21.6319, lon: 39.1044, tz: 'Asia/Riyadh', night: true },
    'Melbourne (Australia)': { lat: -37.8497, lon: 144.9680, tz: 'Australia/Melbourne', night: false },
    'Shanghai (Cina)': { lat: 31.3389, lon: 121.2211, tz: 'Asia/Shanghai', night: false },
    'Miami': { lat: 25.9581, lon: -80.2389, tz: 'America/New_York', night: false },
    'Imola': { lat: 44.3439, lon: 11.7167, tz: 'Europe/Rome', night: false },
    'Monaco': { lat: 43.7347, lon: 7.4206, tz: 'Europe/Monaco', night: false },
    'Barcellona': { lat: 41.5700, lon: 2.2611, tz: 'Europe/Madrid', night: false },
    'Madrid': { lat: 40.4200, lon: -3.6300, tz: 'Europe/Madrid', night: false },
    'Montreal (Canada)': { lat: 45.5000, lon: -73.5228, tz: 'America/Toronto', night: false },
    'Red Bull Ring': { lat: 47.2197, lon: 14.7647, tz: 'Europe/Vienna', night: false },
    'Silverstone': { lat: 52.0786, lon: -1.0169, tz: 'Europe/London', night: false },
    'Hungaroring': { lat: 47.5789, lon: 19.2486, tz: 'Europe/Budapest', night: false },
    'Spa-Francorchamps': { lat: 50.4372, lon: 5.9714, tz: 'Europe/Brussels', night: false },
    'Zandvoort': { lat: 52.3888, lon: 4.5409, tz: 'Europe/Amsterdam', night: false },
    'Monza': { lat: 45.6156, lon: 9.2811, tz: 'Europe/Rome', night: false },
    'Baku (Azerbaijan)': { lat: 40.3725, lon: 49.8533, tz: 'Asia/Baku', night: false },
    'Singapore': { lat: 1.2914, lon: 103.8640, tz: 'Asia/Singapore', night: true },
    'Austin (COTA)': { lat: 30.1328, lon: -97.6411, tz: 'America/Chicago', night: false },
    'Città del Messico': { lat: 19.4042, lon: -99.0907, tz: 'America/Mexico_City', night: false },
    'Interlagos (San Paolo)': { lat: -23.7036, lon: -46.6997, tz: 'America/Sao_Paulo', night: false },
    'Las Vegas': { lat: 36.1147, lon: -115.1728, tz: 'America/Los_Angeles', night: true },
    'Qatar (Lusail)': { lat: 25.4900, lon: 51.4542, tz: 'Asia/Qatar', night: true },
    'Abu Dhabi (Yas Marina)': { lat: 24.4672, lon: 54.6031, tz: 'Asia/Dubai', night: true },
    'Sochi (Russia)': { lat: 43.4057, lon: 39.9578, tz: 'Europe/Moscow', night: false },
    'Portimão (Portogallo)': { lat: 37.2306, lon: -8.6267, tz: 'Europe/Lisbon', night: false },
    'Istanbul (Turchia)': { lat: 40.9517, lon: 29.4050, tz: 'Europe/Istanbul', night: false },
    'Paul Ricard (Francia)': { lat: 43.2506, lon: 5.7917, tz: 'Europe/Paris', night: false },
    'Suzuka': { lat: 34.8431, lon: 136.5410, tz: 'Asia/Tokyo', night: false },
};

// Circuiti nuovi riconosciuti in automatico (lib/auto-circuits.js), solo se
// non già presenti sopra.
for (const [name, info] of Object.entries(require('./auto-circuits').loadAutoCircuits().weather)) {
    if (!(name in CIRCUIT_INFO)) CIRCUIT_INFO[name] = info;
}

const { openf1Json } = require('./openf1');
const { fetchJson } = require('./http');

// Pioggia per una frazione dei campioni meteo di pista >= RAIN_FRAC: la
// sessione è considerata bagnata (soglia scelta sullo storico 2023-2026:
// sotto il 15% sono gocce sporadiche che non toccano la qualifica).
const RAIN_FRAC = 0.15;
const HEAVY_RAIN_FRAC = 0.6;

// tyre: mescola del giro di pole (SOFT/MEDIUM/HARD/INTERMEDIATE/WET) o null;
// rainFrac: frazione dei campioni OpenF1 con pioggia, null se non disponibile;
// temp: temperatura dell'aria (°C); cloud: copertura nuvolosa (%).
function describeQualyWeather({ tyre, rainFrac, temp, cloud, night }) {
    const wetTyre = tyre === 'INTERMEDIATE' || tyre === 'WET';
    const rain = wetTyre
        ? (tyre === 'WET' || rainFrac >= HEAVY_RAIN_FRAC ? 'heavy' : 'wet')
        : (rainFrac >= RAIN_FRAC ? 'damp' : null);
    const hot = temp >= 30;
    const cloudy = cloud >= 60;

    if (night) {
        if (rain === 'heavy' || rain === 'wet') return '🌧️ Notturno Piovoso';
        if (rain === 'damp') return '🌧️ Notturno Umido';
        if (cloudy) return '☁️ Notturno Nuvoloso';
        return '🌙 Notturno Sereno';
    }
    if (rain === 'heavy') return '🌧️ Pioggia Battente';
    if (rain === 'wet') return '🌧️ Pioggia';
    if (rain === 'damp') return '🌦️ Pista umida';
    if (hot) return '☀️ Caldo';
    if (cloudy) return '☁️ Nuvoloso';
    return '☀️ Sereno';
}

// Nuvole (media) e temperatura (massima) di Open-Meteo nell'ora di inizio
// della qualifica e in quella successiva. L'archivio storico arriva con
// qualche giorno di ritardo: per le date recenti si usa l'API forecast, che
// conserva anche i giorni passati.
async function fetchHourlyConditions(info, start) {
    const day = start.toISOString().slice(0, 10);
    const recent = Date.now() - start.getTime() < 60 * 86400000;
    const host = recent ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive';
    const j = await fetchJson(`${host}?latitude=${info.lat}&longitude=${info.lon}&start_date=${day}&end_date=${day}` +
        '&hourly=cloudcover,temperature_2m&timezone=UTC', { retries: 3 });
    const h = start.getUTCHours();
    const idx = [h, Math.min(h + 1, 23)];
    const clouds = idx.map(i => j?.hourly?.cloudcover?.[i]).filter(v => typeof v === 'number');
    const temps = idx.map(i => j?.hourly?.temperature_2m?.[i]).filter(v => typeof v === 'number');
    return {
        cloud: clouds.length ? Math.round(clouds.reduce((a, b) => a + b, 0) / clouds.length) : null,
        temp: temps.length ? Math.max(...temps) : null,
    };
}

// Pioggia, temperatura e gomma del giro di pole da OpenF1 per la sessione di
// qualifica (session_key) e il polista (driver_number).
async function fetchSessionConditions(sessionKey, driverNumber) {
    const w = await openf1Json(`https://api.openf1.org/v1/weather?session_key=${sessionKey}`);
    const laps = await openf1Json(`https://api.openf1.org/v1/laps?session_key=${sessionKey}&driver_number=${driverNumber}`);
    const best = laps.filter(l => l.lap_duration).sort((a, b) => a.lap_duration - b.lap_duration)[0];
    let tyre = null;
    if (best) {
        const stints = await openf1Json(`https://api.openf1.org/v1/stints?session_key=${sessionKey}&driver_number=${driverNumber}`);
        tyre = stints.filter(s => s.lap_start <= best.lap_number && best.lap_number <= s.lap_end)
            .sort((a, b) => b.stint_number - a.stint_number)[0]?.compound || null;
    }
    return {
        rainFrac: w.length ? w.filter(x => x.rainfall).length / w.length : null,
        airMax: w.length ? Math.max(...w.map(x => x.air_temperature)) : null,
        tyre,
    };
}

// Meteo della qualifica di un circuito. start: inizio della qualifica (Date,
// UTC). openf1: { sessionKey, driverNumber } se la pole viene da OpenF1,
// altrimenti null: senza OpenF1 non si sa se ha piovuto, e il risultato ha
// complete=false (update-poles.js in quel caso non sovrascrive un meteo già
// calcolato con i dati di pista). null se il circuito non ha coordinate.
async function fetchQualyWeather(circuitName, start, openf1 = null) {
    const info = CIRCUIT_INFO[circuitName];
    if (!info) return null;
    const hourly = await fetchHourlyConditions(info, start);
    const session = openf1 ? await fetchSessionConditions(openf1.sessionKey, openf1.driverNumber) : null;
    const raw = {
        tyre: session?.tyre ?? null,
        rainFrac: session?.rainFrac ?? null,
        temp: session?.airMax ?? hourly.temp,
        cloud: hourly.cloud,
        night: info.night,
    };
    return { description: describeQualyWeather(raw), complete: session?.rainFrac != null, raw };
}

module.exports = { CIRCUIT_INFO, describeQualyWeather, fetchQualyWeather };
