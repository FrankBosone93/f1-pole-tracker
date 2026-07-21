// scripts/lib/weather.js
//
// Meteo storico reale via Open-Meteo (https://open-meteo.com, gratuito, senza
// chiave API, dati ERA5 dal 1940 in poi). Usato sia per correggere lo storico
// (scripts/backfill-weather.js) sia per le gare future (update-poles.js).

// Coordinate e fuso orario IANA del circuito, più se la sessione si disputa
// tipicamente in notturna/twilight (per la descrizione "Notturno").
//
// NOTA IMPORTANTE: f1api.dev fornisce data e ora della qualifica in UTC
// (es. "2024-11-23" + "06:00:00Z" per Las Vegas). Per circuiti lontani da UTC
// la data del calendario UTC può differire dalla data locale del circuito
// (Las Vegas: 06:00 UTC del 23 novembre è le 22:00 locali del 22 novembre,
// un giorno prima!). Serve quindi calcolare la data locale corretta con il
// fuso orario del circuito PRIMA di interrogare Open-Meteo, altrimenti si
// rischia di prendere il meteo del giorno sbagliato (successo per errore con
// il GP Australia 2025, corretto durante lo sviluppo).
const CIRCUIT_INFO = {
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

function describeWeather(weathercode, precipSum, tempMax, isNight) {
    // La classificazione pioggia/sereno si basa sulla quantità di precipitazione
    // misurata (mm), non sul solo codice meteo: un codice "drizzle" con 0.1mm
    // di pioggia è una traccia trascurabile, non una sessione "piovosa".
    const heavyRain = precipSum >= 8;
    const rainy = precipSum >= 1;
    const cloudy = !rainy && [2, 3, 45, 48].includes(weathercode);
    const hot = tempMax >= 30;

    if (isNight) {
        if (heavyRain) return '🌧️ Notturno Piovoso';
        if (rainy) return '🌧️ Notturno Umido';
        if (cloudy) return '☁️ Notturno Nuvoloso';
        return '🌙 Notturno Sereno';
    }
    if (heavyRain) return '🌧️ Pioggia Battente';
    if (rainy) return '🌧️ Pioggia';
    if (cloudy) return '☁️ Nuvoloso';
    if (hot) return '☀️ Caldo';
    return '☀️ Sereno';
}

// Converte una data+ora UTC (come fornite da f1api.dev, es. "2024-11-23" +
// "06:00:00Z") nella data di calendario LOCALE del fuso orario del circuito.
function toLocalDateString(utcDateStr, utcTimeStr, timeZone) {
    const timePart = (utcTimeStr || '00:00:00Z').replace('Z', '');
    const dt = new Date(`${utcDateStr}T${timePart}Z`);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(dt); // formato YYYY-MM-DD
}

async function fetchWeatherForCircuit(circuitName, utcDateStr, utcTimeStr) {
    const info = CIRCUIT_INFO[circuitName];
    if (!info) return null;

    const localDate = toLocalDateString(utcDateStr, utcTimeStr, info.tz);

    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${info.lat}&longitude=${info.lon}` +
        `&start_date=${localDate}&end_date=${localDate}&daily=weathercode,precipitation_sum,temperature_2m_max&timezone=${encodeURIComponent(info.tz)}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const payload = await res.json();
    const d = payload.daily;
    if (!d || !Array.isArray(d.time) || d.time.length === 0) return null;

    const weathercode = d.weathercode[0];
    const precipSum = d.precipitation_sum[0];
    const tempMax = d.temperature_2m_max[0];

    return {
        description: describeWeather(weathercode, precipSum, tempMax, info.night),
        raw: { weathercode, precipSum, tempMax, localDate },
    };
}

module.exports = { CIRCUIT_INFO, describeWeather, fetchWeatherForCircuit };
