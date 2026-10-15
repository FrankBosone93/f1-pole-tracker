// scripts/build-race-pace.js
//
// Scarica da OpenF1 (gratuito, dati dal 2023) i giri di ogni pilota in ogni
// gara già disputata e scrive un file compatto per gara, usato dalla modalità
// "Passo gara" del sito:
//   pace/{anno}/{circuito}.json   es. pace/2025/monza.json
//   pace/index.json               elenco delle gare disponibili per anno
//
// Per ogni gara: classifica ufficiale (session_result), piloti, tempo di ogni
// giro, soste (giro di ingresso e di uscita dai box), stint con le mescole e
// periodi di safety car / virtual safety car e bandiere rosse.
// 6 richieste per gara, distanziate per il rate limit (vedi lib/openf1.js).
//
// Le gare già presenti nell'indice non vengono riscaricate: ogni run scarica
// solo quelle nuove. Una gara senza pole in data.json è stata annullata
// (OpenF1 elenca comunque la sessione, ma senza giri): si salta senza
// richieste, come per la telemetria.
//
// Uso:
//   node scripts/build-race-pace.js             (2023 - stagione in corso)
//   node scripts/build-race-pace.js 2025        (solo il 2025)

const fs = require('fs');
const path = require('path');
const { writeStatus } = require('./lib/status');
const { openf1Json, CIRCUIT_MAP, circuitSlug } = require('./lib/openf1');
const { HttpError } = require('./lib/http');

// Dati accessori che OpenF1 non ha per tutte le gare (es. le soste di alcune
// gare 2023 danno 404): mancanti = elenco vuoto, non una gara scartata.
async function openf1Optional(url) {
    try {
        return await openf1Json(url);
    } catch (err) {
        if (err instanceof HttpError && err.status === 404) return [];
        throw err;
    }
}

const ROOT = path.join(__dirname, '..');
const PACE_DIR = path.join(ROOT, 'pace');
const INDEX_PATH = path.join(PACE_DIR, 'index.json');
const DATA_JSON_PATH = path.join(ROOT, 'data.json');
const FIRST_SEASON = 2023; // OpenF1 non ha dati prima del 2023
const PENDING_GRACE_HOURS = 72;

const poleData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
const hasPole = (season, circuit) => poleData.some(d => d.year === season && d.circuit === circuit);

const round3 = v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);

// "Max VERSTAPPEN" -> "Max Verstappen" (OpenF1 scrive il cognome maiuscolo).
function displayName(d) {
    if (d.first_name && d.last_name) return `${d.first_name} ${d.last_name}`;
    return (d.full_name || '').toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase());
}

// Periodi neutralizzati dai messaggi della direzione gara: "SAFETY CAR
// DEPLOYED" ... "SAFETY CAR IN THIS LAP", "VIRTUAL SAFETY CAR DEPLOYED" ...
// "VIRTUAL SAFETY CAR ENDING". Un periodo ancora aperto a fine gara si chiude
// sull'ultimo giro.
function neutralizedPeriods(raceControl, totalLaps) {
    const periods = [];
    let open = null;
    const sorted = raceControl.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const m of sorted) {
        const msg = (m.message || '').toUpperCase();
        const lap = m.lap_number || null;
        if (!lap) continue;
        const isVsc = msg.includes('VIRTUAL SAFETY CAR');
        if (msg.includes('SAFETY CAR DEPLOYED')) {
            if (open) periods.push({ ...open, to: lap });
            open = { type: isVsc ? 'VSC' : 'SC', from: lap };
        } else if (open && (msg.includes('SAFETY CAR IN THIS LAP') || msg.includes('VIRTUAL SAFETY CAR ENDING'))) {
            periods.push({ ...open, to: lap });
            open = null;
        }
    }
    if (open) periods.push({ ...open, to: totalLaps });
    const redFlags = [...new Set(sorted.filter(m => m.flag === 'RED' && m.lap_number).map(m => m.lap_number))];
    return { periods, redFlags };
}

async function buildRace(session, season, circuit) {
    const sk = session.session_key;
    const [results, drivers, laps, stints, pits, raceControl] = [
        await openf1Optional(`https://api.openf1.org/v1/session_result?session_key=${sk}`),
        await openf1Optional(`https://api.openf1.org/v1/drivers?session_key=${sk}`),
        await openf1Json(`https://api.openf1.org/v1/laps?session_key=${sk}`),
        await openf1Optional(`https://api.openf1.org/v1/stints?session_key=${sk}`),
        await openf1Optional(`https://api.openf1.org/v1/pit?session_key=${sk}`),
        await openf1Optional(`https://api.openf1.org/v1/race_control?session_key=${sk}`),
    ];
    if (!laps.length) throw new Error('nessun giro');

    // Giri della gara: quelli del vincitore nella classifica ufficiale. Il
    // massimo lap_number di OpenF1 non va bene: include anche il giro dopo la
    // bandiera a scacchi (Montreal 2023 risultava di 71 giri invece di 70).
    const classifiedLaps = results.map(r => r.number_of_laps || 0);
    const totalLaps = classifiedLaps.length && Math.max(...classifiedLaps) > 0
        ? Math.max(...classifiedLaps)
        : Math.max(...laps.filter(l => typeof l.lap_duration === 'number').map(l => l.lap_number || 0));
    const byNumber = new Map(drivers.map(d => [d.driver_number, d]));

    // Classifica: classificati per posizione, poi i non classificati per giri
    // percorsi (ritirati), poi chi non è partito.
    const statusOf = r => r.dsq ? 'DSQ' : r.dns ? 'DNS' : r.dnf ? 'DNF' : '';
    // Senza classifica ufficiale (non c'è per tutte le gare): ordine
    // ricostruito dai giri - più giri completati, poi tempo totale minore.
    if (!results.length) {
        const totals = new Map();
        for (const l of laps) {
            const t = totals.get(l.driver_number) || { laps: 0, time: 0 };
            if (typeof l.lap_duration === 'number') { t.laps++; t.time += l.lap_duration; }
            totals.set(l.driver_number, t);
        }
        [...totals.entries()]
            .sort((a, b) => b[1].laps - a[1].laps || a[1].time - b[1].time)
            .forEach(([n, t], i) => results.push({ driver_number: n, position: i + 1, number_of_laps: t.laps }));
    }
    const ordered = results.slice().sort((a, b) =>
        (a.position ?? 999) - (b.position ?? 999) || (b.number_of_laps ?? 0) - (a.number_of_laps ?? 0));

    const out = {
        year: season,
        circuit,
        date: (session.date_start || '').slice(0, 10),
        totalLaps,
        drivers: ordered.map(r => {
            const d = byNumber.get(r.driver_number) || {};
            return {
                n: r.driver_number,
                code: d.name_acronym || String(r.driver_number),
                name: displayName(d) || String(r.driver_number),
                team: d.team_name || '',
                color: d.team_colour ? `#${d.team_colour}` : null,
                pos: r.position ?? null,
                status: statusOf(r),
                laps: r.number_of_laps ?? null,
            };
        }),
        laps: {},     // numero pilota -> [tempo giro 1, giro 2, ...] (null = mancante)
        pitIn: {},    // numero pilota -> giri in cui è entrato ai box
        pitOut: {},   // numero pilota -> giri di uscita dai box
        stints: {},   // numero pilota -> [[primo giro, ultimo giro, mescola], ...]
        ...neutralizedPeriods(raceControl, totalLaps),
    };

    for (const l of laps) {
        const n = l.driver_number;
        if (!out.laps[n]) out.laps[n] = new Array(totalLaps).fill(null);
        if (l.lap_number >= 1 && l.lap_number <= totalLaps) out.laps[n][l.lap_number - 1] = round3(l.lap_duration);
        if (l.is_pit_out_lap && l.lap_number > 1) (out.pitOut[n] = out.pitOut[n] || []).push(l.lap_number);
    }
    for (const p of pits) {
        if (p.lap_number) (out.pitIn[p.driver_number] = out.pitIn[p.driver_number] || []).push(p.lap_number);
    }
    for (const s of stints.slice().sort((a, b) => a.stint_number - b.stint_number)) {
        (out.stints[s.driver_number] = out.stints[s.driver_number] || []).push([s.lap_start, s.lap_end, s.compound || null]);
    }
    // Senza dati delle soste per un pilota: il giro di ingresso ai box è
    // quello prima del giro di uscita.
    for (const n in out.pitOut) if (!out.pitIn[n]) out.pitIn[n] = out.pitOut[n].map(l => l - 1);
    for (const k of ['pitIn', 'pitOut']) for (const n in out[k]) out[k][n] = [...new Set(out[k][n])].filter(l => l <= totalLaps).sort((a, b) => a - b);
    out.periods = out.periods.filter(p => p.from <= totalLaps).map(p => ({ ...p, to: Math.min(p.to, totalLaps) }));
    out.redFlags = out.redFlags.filter(l => l <= totalLaps);
    return out;
}

async function main() {
    const now = new Date();
    const argSeasons = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
    const seasons = argSeasons.length ? argSeasons
        : Array.from({ length: now.getFullYear() - FIRST_SEASON + 1 }, (_, i) => FIRST_SEASON + i);

    let index = { updatedAt: null, races: {} };
    if (fs.existsSync(INDEX_PATH)) index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));

    let changed = false;
    const errors = [];
    for (const season of seasons) {
        const sessions = await openf1Json(`https://api.openf1.org/v1/sessions?year=${season}&session_name=Race`);
        const known = new Set((index.races[season] || []).map(r => r.circuit));
        const todo = sessions
            .filter(s => new Date(s.date_end) < now)
            .map(s => ({ session: s, circuit: CIRCUIT_MAP[s.circuit_short_name] }))
            .filter(({ session, circuit }) => {
                if (!circuit) { console.warn(`⚠️  ${season}: circuito OpenF1 "${session.circuit_short_name}" non mappato, salto.`); return false; }
                return !known.has(circuit) && hasPole(season, circuit);
            });
        console.log(`=== ${season}: ${todo.length} gare da scaricare (${known.size} già presenti)`);

        for (const { session, circuit } of todo) {
            try {
                const race = await buildRace(session, season, circuit);
                const file = `pace/${season}/${circuitSlug(circuit)}.json`;
                fs.mkdirSync(path.join(ROOT, 'pace', String(season)), { recursive: true });
                fs.writeFileSync(path.join(ROOT, file), JSON.stringify(race) + '\n', 'utf-8');
                index.races[season] = (index.races[season] || []).filter(r => r.circuit !== circuit);
                index.races[season].push({ circuit, date: race.date, file });
                index.races[season].sort((a, b) => a.date.localeCompare(b.date));
                index.updatedAt = new Date().toISOString();
                // Scrittura incrementale: un errore più avanti non fa perdere
                // le gare già scaricate.
                fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n', 'utf-8');
                changed = true;
                console.log(`  ✅ ${circuit}: ${race.drivers.length} piloti, ${race.totalLaps} giri, ${race.periods.length} periodi SC/VSC`);
            } catch (err) {
                // Subito dopo la gara OpenF1 può non avere ancora i dati
                // (la finestra "live" è riservata al piano a pagamento): entro
                // 72 ore non è un errore, la gara verrà ripresa al run successivo.
                const hoursSince = (now - new Date(session.date_end)) / 3600000;
                if (hoursSince < PENDING_GRACE_HOURS) {
                    console.warn(`  ⏳ ${circuit}: dati non ancora disponibili (gara finita ${hoursSince.toFixed(1)}h fa), riproverò.`);
                } else {
                    console.warn(`  ⚠️  ${circuit}: errore - ${err.message}`);
                    errors.push(`${season} ${circuit}: ${err.message}`);
                }
            }
        }
    }
    console.log(changed ? '✅ Dati del passo gara aggiornati.' : 'Nessuna gara nuova.');
    if (errors.length) throw new Error(errors.join(' | '));
}

main()
    .then(() => writeStatus('pace', true))
    .catch(err => {
        console.error('❌ Errore durante la costruzione del passo gara:', err.message);
        writeStatus('pace', false, err.message);
        process.exit(1);
    });
