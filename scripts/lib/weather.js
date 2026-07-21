// scripts/lib/weather.js
//
// Meteo storico reale via Open-Meteo (https://open-meteo.com, gratuito, senza
// chiave API, dati ERA5 dal 1940 in poi). Usato sia per correggere lo storico
// (scripts/backfill-weather.js) sia per le gare future (update-poles.js).

// Coordinate approssimative del circuito (lat, lon) e se la sessione si
// disputa tipicamente in notturna/twilight (per la descrizione "Notturno").
const CIRCUIT_INFO = {
    'Bahrain (Sakhir)': { lat: 26.0325, lon: 50.5106, night: true },
    'Jeddah (Arabia Saudita)': { lat: 21.6319, lon: 39.1044, night: true },
    'Melbourne (Australia)': { lat: -37.8497, lon: 144.9680, night: false },
    'Shanghai (Cina)': { lat: 31.3389, lon: 121.2211, night: false },
    'Miami': { lat: 25.9581, lon: -80.2389, night: false },
    'Imola': { lat: 44.3439, lon: 11.7167, night: false },
    'Monaco': { lat: 43.7347, lon: 7.4206, night: false },
    'Barcellona': { lat: 41.5700, lon: 2.2611, night: false },
    'Madrid': { lat: 40.4200, lon: -3.6300, night: false },
    'Montreal (Canada)': { lat: 45.5000, lon: -73.5228, night: false },
    'Red Bull Ring': { lat: 47.2197, lon: 14.7647, night: false },
    'Silverstone': { lat: 52.0786, lon: -1.0169, night: false },
    'Hungaroring': { lat: 47.5789, lon: 19.2486, night: false },
    'Spa-Francorchamps': { lat: 50.4372, lon: 5.9714, night: false },
    'Zandvoort': { lat: 52.3888, lon: 4.5409, night: false },
    'Monza': { lat: 45.6156, lon: 9.2811, night: false },
    'Baku (Azerbaijan)': { lat: 40.3725, lon: 49.8533, night: false },
    'Singapore': { lat: 1.2914, lon: 103.8640, night: true },
    'Austin (COTA)': { lat: 30.1328, lon: -97.6411, night: false },
    'Città del Messico': { lat: 19.4042, lon: -99.0907, night: false },
    'Interlagos (San Paolo)': { lat: -23.7036, lon: -46.6997, night: false },
    'Las Vegas': { lat: 36.1147, lon: -115.1728, night: true },
    'Qatar (Lusail)': { lat: 25.4900, lon: 51.4542, night: true },
    'Abu Dhabi (Yas Marina)': { lat: 24.4672, lon: 54.6031, night: true },
    'Sochi (Russia)': { lat: 43.4057, lon: 39.9578, night: false },
    'Portimão (Portogallo)': { lat: 37.2306, lon: -8.6267, night: false },
    'Istanbul (Turchia)': { lat: 40.9517, lon: 29.4050, night: false },
    'Paul Ricard (Francia)': { lat: 43.2506, lon: 5.7917, night: false },
    'Suzuka': { lat: 34.8431, lon: 136.5410, night: false },
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

async function fetchWeatherForCircuit(circuitName, dateStr) {
    const info = CIRCUIT_INFO[circuitName];
    if (!info) return null;

    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${info.lat}&longitude=${info.lon}` +
        `&start_date=${dateStr}&end_date=${dateStr}&daily=weathercode,precipitation_sum,temperature_2m_max&timezone=UTC`;

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
        raw: { weathercode, precipSum, tempMax },
    };
}

module.exports = { CIRCUIT_INFO, describeWeather, fetchWeatherForCircuit };
