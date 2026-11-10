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
// solo quelle nuove (e ricontrolla quelle degli ultimi 2 giorni, scrivendo
// solo se qualcosa è cambiato). Una gara senza pole in data.json e senza
// risultati di gara salvati è stata annullata (OpenF1 elenca comunque la
// sessione, ma senza giri): si salta senza richieste.
//
// Uso:
//   node scripts/build-race-pace.js             (2023 - stagione in corso)
//   node scripts/build-race-pace.js 2025        (solo il 2025)
//   node scripts/build-race-pace.js 2026 --refresh
//                                               (riscarica anche le gare già
//                                               presenti, es. dopo una correzione)
//   node scripts/build-race-pace.js 2026 --refresh --only=monza,citta-del-messico
//                                               (riscarica solo quelle gare)

const fs = require('fs');
const path = require('path');
const { writeStatus } = require('./lib/status');
const { openf1Json, CIRCUIT_MAP, circuitSlug } = require('./lib/openf1');
const { HttpError } = require('./lib/http');
const { knownDriverNames, siteDriverName } = require('./lib/driver-names');
const { matchTeam } = require('./lib/f1-mapping');

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
const REFRESH = process.argv.includes('--refresh');
// --only=slug1,slug2: solo queste gare (slug del file, es. citta-del-messico).
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const PACE_DIR = path.join(ROOT, 'pace');
const INDEX_PATH = path.join(PACE_DIR, 'index.json');
const DATA_JSON_PATH = path.join(ROOT, 'data.json');
const FIRST_SEASON = 2023; // OpenF1 non ha dati prima del 2023
const PENDING_GRACE_HOURS = 72;
// Gare degli ultimi 2 giorni riscaricate a ogni run: il primo download, la
// notte dopo la gara, può avere la classifica provvisoria e piloti non ancora
// in OpenF1 (Città del Messico 2026: Piastri 7° invece di 13° dopo le
// penalità, Hirakawa senza squadra). Il run del lunedì mattina la corregge.
const RECHECK_DAYS = 2;

const poleData = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
const hasPole = (season, circuit) => poleData.some(d => d.year === season && d.circuit === circuit);
// Risultati di gara già salvati (calendar.json per la stagione in corso,
// history/{anno}.json per le passate): una gara con i risultati si è corsa,
// anche se la sua pole non è ancora in data.json. Fino al 2026-11-10 serviva
// la pole, e se la pole arrivava dopo i risultati della gara il passo gara
// restava indietro fino al giro successivo.
const raceResultsFiles = [path.join(ROOT, 'calendar.json')];
const raceCircuitsWithResults = new Map();
for (const f of fs.existsSync(path.join(ROOT, 'history')) ? fs.readdirSync(path.join(ROOT, 'history')) : []) {
    if (/^\d{4}\.json$/.test(f)) raceResultsFiles.push(path.join(ROOT, 'history', f));
}
for (const f of raceResultsFiles) {
    try {
        const cal = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const set = raceCircuitsWithResults.get(Number(cal.season)) || new Set();
        (cal.races || []).filter(r => Array.isArray(r.results?.race) && r.results.race.length).forEach(r => set.add(r.circuit));
        raceCircuitsWithResults.set(Number(cal.season), set);
    } catch (err) { /* file illeggibile: conta solo la pole */ }
}
// Una gara annullata (Imola 2023) non ha né pole né risultati: OpenF1 elenca
// comunque la sessione, ma senza giri, e si salta senza richieste.
const raceWasRun = (season, circuit) => hasPole(season, circuit) || !!raceCircuitsWithResults.get(season)?.has(circuit);

// Nomi di piloti e squadre come nel resto del sito ("Andrea Kimi Antonelli",
// "Red Bull"), non quelli di OpenF1 ("Kimi Antonelli", "Red Bull Racing"):
// fino al 2026-11-10 la classifica del passo gara li mostrava diversi dalle
// altre tabelle. Stagione in corso: i nomi già sul sito (classifica,
// calendario, pole); stagioni passate: quelli del loro file storico e delle
// loro pole.
const SITE_SEASON = (() => { try { return Number(JSON.parse(fs.readFileSync(path.join(ROOT, 'calendar.json'), 'utf-8')).season); } catch (err) { return null; } })();
const namesCache = new Map();
function namesForSeason(season) {
    if (namesCache.has(season)) return namesCache.get(season);
    let names;
    if (season === SITE_SEASON) {
        names = knownDriverNames();
    } else {
        const list = poleData.filter(d => d.year === season).map(d => d.driver);
        try {
            const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'history', `${season}.json`), 'utf-8'));
            (h.races || []).forEach(r => Object.values(r.results || {}).forEach(rows => (rows || []).forEach(x => list.push(x.driver))));
        } catch (err) { /* nessuno storico: solo le pole */ }
        names = knownDriverNames(list.filter(Boolean));
    }
    namesCache.set(season, names);
    return names;
}
const paceDriverName = (d, season) => siteDriverName(d, namesForSeason(season)) || displayName(d);

const round3 = v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);

// Giri senza tempo su OpenF1 (record assente o lap_duration null, es.
// Città del Messico 2026: giro 5 mancante per 9 piloti, e il distacco tra
// due piloti si fermava lì): tempo = inizio del giro dopo - inizio di
// questo, dagli orari date_start. L'inizio di un giro senza record è la
// fine del giro prima. Solo i buchi prima dell'ultimo giro con il tempo del
// pilota: il primo giro resta vuoto (nessun giro prima), e dopo l'ultimo
// giro con il tempo gli orari di OpenF1 non sono affidabili (Monza 2023: il
// record dopo la bandiera a scacchi ha lo stesso orario per tutti, 8 minuti
// dopo, e a 7 piloti senza il record del giro 51 veniva un giro di ~400 s).
// Solo se gli orari tornano: il giro dopo deve finire quando inizia quello
// successivo (entro 1 s) e il tempo ricavato non può essere più veloce del
// giro migliore del pilota. Zandvoort 2026, Lindblad giro 4: orari OpenF1
// incoerenti dopo la bandiera rossa, sarebbe venuto 55 s (giro normale
// ~77 s), quindi resta vuoto.
function fillLapsFromStarts(lapsByDriver, laps) {
    const starts = {};
    for (const l of laps) {
        if (l.date_start && l.lap_number >= 1) (starts[l.driver_number] = starts[l.driver_number] || [])[l.lap_number - 1] = Date.parse(l.date_start);
    }
    for (const n in lapsByDriver) {
        const st = starts[n] || [], lt = lapsByDriver[n];
        const best = Math.min(...lt.filter(v => v !== null));
        const last = lt.findLastIndex(v => v !== null);
        const fits = (k, ms) => st[k] == null || Math.abs(st[k] - ms) <= 1000;
        for (let k = 1; k < last; k++) {
            if (lt[k] !== null) continue;
            const from = st[k] ?? (st[k - 1] != null && lt[k - 1] != null ? st[k - 1] + lt[k - 1] * 1000 : null);
            const to = st[k + 1];
            if (from == null || to == null) continue;
            const sec = (to - from) / 1000;
            const nextOk = lt[k + 1] == null || fits(k + 2, to + lt[k + 1] * 1000);
            if (sec >= best && nextOk) lt[k] = round3(sec);
        }
    }
}

// Tempi sul giro di ogni pilota: numero -> [giro 1, giro 2, ...] (null =
// mancante), più i giri ricostruiti dagli orari. lapsDone: giri completati
// nella classifica ufficiale; quelli dopo non fanno parte della gara del
// pilota (Silverstone 2026, Sainz doppiato: il giro 52 di 125 s era il giro
// di rientro dopo la bandiera a scacchi).
function lapTimesFrom(laps, totalLaps, lapsDone = new Map()) {
    const out = {};
    for (const l of laps) {
        const n = l.driver_number;
        if (!out[n]) out[n] = new Array(totalLaps).fill(null);
        const done = lapsDone.get(n);
        const lastLap = typeof done === 'number' ? Math.min(done, totalLaps) : totalLaps;
        if (l.lap_number >= 1 && l.lap_number <= lastLap) out[n][l.lap_number - 1] = round3(l.lap_duration);
    }
    fillLapsFromStarts(out, laps);
    return out;
}

// Soste: il giro prima di ogni giro di uscita dai box (is_pit_out_lap di
// /laps; il giro 1 è la partenza, anche dalla pit lane). Le soste di OpenF1
// /pit si aggiungono solo se non si possono verificare, cioè se il giro dopo
// non ha il tempo (Miami 2025: giri senza dati, soste giuste solo in /pit):
// con il giro dopo cronometrato e non di uscita dai box sono sbagliate.
// Melbourne 2026: Leclerc fermo al giro 18 invece del 25, a Stroll mancavano
// le soste dei giri 26, 34 e 39; Città del Messico 2026: 9 piloti fermi al
// giro 1. Tutto entro i giri completati: un giro di uscita mai finito non
// conta (Zandvoort 2025, Leclerc ritirato nel giro dopo la sosta del 52).
// Verificato sulle soste ufficiali (Jolpica) di otto gare, comprese le tre
// sopra e tre con bandiera rossa.
function pitLapsFrom(laps, pits, totalLaps, lapsDone = new Map()) {
    const lastLapOf = n => { const done = lapsDone.get(n); return typeof done === 'number' ? Math.min(done, totalLaps) : totalLaps; };
    const timed = new Set(laps.filter(l => typeof l.lap_duration === 'number').map(l => `${l.driver_number}:${l.lap_number}`));
    const pitIn = {}, pitOut = {};
    const add = (obj, n, lap) => (obj[n] = obj[n] || []).push(lap);
    for (const l of laps) {
        if (!l.is_pit_out_lap || l.lap_number < 2 || l.lap_number > lastLapOf(l.driver_number)) continue;
        add(pitOut, l.driver_number, l.lap_number);
        add(pitIn, l.driver_number, l.lap_number - 1);
    }
    for (const p of pits) {
        const n = p.driver_number, lap = p.lap_number;
        if (lap >= 1 && lap <= lastLapOf(n) && !timed.has(`${n}:${lap + 1}`)) add(pitIn, n, lap);
    }
    for (const obj of [pitIn, pitOut]) for (const n in obj) obj[n] = [...new Set(obj[n])].sort((a, b) => a - b);
    return { pitIn, pitOut };
}

// Distacco di ogni pilota alla fine del giro 1, in secondi (0 = il primo a
// passare sul traguardo), dagli orari di inizio del giro 2. Il tempo del
// giro 1 manca spesso su OpenF1 (partenza; bandiera rossa al primo giro,
// Monaco 2024), e senza un punto di partenza il grafico dei distacchi del
// sito restava vuoto. Verificato su Monaco 2024: distacco finale
// Piastri-Leclerc 7,20 s (ufficiale 7,152), Sainz-Leclerc 7,60 s (7,585).
function lap1EndFrom(laps) {
    const lap2 = laps.filter(l => l.lap_number === 2 && l.date_start)
        .map(l => [l.driver_number, Date.parse(l.date_start)])
        .filter(([, t]) => !isNaN(t));
    if (!lap2.length) return {};
    const t0 = Math.min(...lap2.map(([, t]) => t));
    return Object.fromEntries(lap2.map(([n, t]) => [n, round3((t - t0) / 1000)]));
}

// "Max VERSTAPPEN" -> "Max Verstappen" (OpenF1 scrive il cognome maiuscolo).
function displayName(d) {
    if (d.first_name && d.last_name) return `${d.first_name} ${d.last_name}`;
    return (d.full_name || '').toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase());
}

// Periodi neutralizzati dai messaggi della direzione gara: "SAFETY CAR
// DEPLOYED" ... "SAFETY CAR IN THIS LAP", "VIRTUAL SAFETY CAR DEPLOYED" ...
// "VIRTUAL SAFETY CAR ENDING" (dal 2026 abbreviato in "VSC DEPLOYED" ...
// "VSC ENDING": prima della correzione del 2026-11-01 nessuna VSC 2026 veniva
// riconosciuta). Un periodo ancora aperto a fine gara si chiude sull'ultimo
// giro.
// Bandiere rosse: fino al 2025 messaggi con flag "RED"; dal 2026 "RED FLAG -
// RACE SUSPENDED" senza flag (Monaco, Zandvoort, Monza e Città del Messico
// 2026 risultavano senza bandiera rossa). La bandiera rossa chiude la safety
// car in corso: la gara riparte con la partenza da fermo, senza "SAFETY CAR
// IN THIS LAP", e il periodo restava aperto fino alla safety car successiva
// (Città del Messico 2026: giri 44-59 invece di 44-45).
const isRedFlag = m => m.flag === 'RED' || /^RED FLAG\b/i.test(m.message || '');

function neutralizedPeriods(raceControl, totalLaps) {
    const periods = [];
    let open = null;
    const sorted = raceControl.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const m of sorted) {
        const msg = (m.message || '').toUpperCase();
        const lap = m.lap_number || null;
        if (!lap) continue;
        const isVsc = msg.includes('VIRTUAL SAFETY CAR') || /^VSC\b/.test(msg);
        if (isRedFlag(m)) {
            if (open) periods.push({ ...open, to: lap });
            open = null;
        } else if (msg.includes('SAFETY CAR DEPLOYED') || msg.startsWith('VSC DEPLOYED')) {
            if (open) periods.push({ ...open, to: lap });
            open = { type: isVsc ? 'VSC' : 'SC', from: lap };
        } else if (open && (msg.includes('SAFETY CAR IN THIS LAP') || msg.includes('VIRTUAL SAFETY CAR ENDING') || msg.startsWith('VSC ENDING'))) {
            periods.push({ ...open, to: lap });
            open = null;
        }
    }
    if (open) periods.push({ ...open, to: totalLaps });
    const redFlags = [...new Set(sorted.filter(m => isRedFlag(m) && m.lap_number).map(m => m.lap_number))];
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
    // Solo dalla classifica ufficiale: quella ricostruita qui sotto conta i
    // giri con il tempo, e taglierebbe quelli dopo un giro senza tempo.
    const lapsDone = new Map(results.filter(r => typeof r.number_of_laps === 'number').map(r => [r.driver_number, r.number_of_laps]));

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
                name: paceDriverName(d, season) || String(r.driver_number),
                team: d.team_name ? matchTeam(d.team_name) : '',
                color: d.team_colour ? `#${d.team_colour}` : null,
                pos: r.position ?? null,
                status: statusOf(r),
                laps: r.number_of_laps ?? null,
            };
        }),
        laps: lapTimesFrom(laps, totalLaps, lapsDone), // numero pilota -> [tempo giro 1, giro 2, ...] (null = mancante)
        ...pitLapsFrom(laps, pits, totalLaps, lapsDone), // pitIn / pitOut: numero pilota -> giri di ingresso / uscita dai box
        stints: {},   // numero pilota -> [[primo giro, ultimo giro, mescola], ...]
        lap1End: lap1EndFrom(laps), // numero pilota -> distacco a fine giro 1 (s)
        ...neutralizedPeriods(raceControl, totalLaps),
    };

    for (const s of stints.slice().sort((a, b) => a.stint_number - b.stint_number)) {
        (out.stints[s.driver_number] = out.stints[s.driver_number] || []).push([s.lap_start, s.lap_end, s.compound || null]);
    }
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
        const recent = r => (now - new Date(`${r.date}T23:59:59Z`)) / 86400000 < RECHECK_DAYS;
        const known = new Set(REFRESH ? [] : (index.races[season] || []).filter(r => !recent(r)).map(r => r.circuit));
        const todo = sessions
            .filter(s => new Date(s.date_end) < now)
            .map(s => ({ session: s, circuit: CIRCUIT_MAP[s.circuit_short_name] }))
            .filter(({ session, circuit }) => {
                if (!circuit) { console.warn(`⚠️  ${season}: circuito OpenF1 "${session.circuit_short_name}" non mappato, salto.`); return false; }
                if (ONLY.length && !ONLY.includes(circuitSlug(circuit))) return false;
                return !known.has(circuit) && raceWasRun(season, circuit);
            });
        console.log(`=== ${season}: ${todo.length} gare da scaricare (${known.size} già presenti)`);

        for (const { session, circuit } of todo) {
            try {
                const race = await buildRace(session, season, circuit);
                const file = `pace/${season}/${circuitSlug(circuit)}.json`;
                const content = JSON.stringify(race) + '\n';
                const filePath = path.join(ROOT, file);
                // Ricontrollo dei 2 giorni dopo la gara: se OpenF1 non ha
                // cambiato nulla non si tocca niente. Fino al 2026-11-10 ogni
                // run riscriveva comunque updatedAt nell'indice, e ogni volta
                // partivano un commit, una pubblicazione del sito e un giro di
                // statistiche e notifiche senza dati nuovi.
                const alreadyIndexed = (index.races[season] || []).some(r => r.circuit === circuit && r.file === file && r.date === race.date);
                if (alreadyIndexed && fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8') === content) {
                    console.log(`  = ${circuit}: invariato`);
                    continue;
                }
                fs.mkdirSync(path.join(ROOT, 'pace', String(season)), { recursive: true });
                fs.writeFileSync(filePath, content, 'utf-8');
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

module.exports = { buildRace, lap1EndFrom, lapTimesFrom, pitLapsFrom, paceDriverName };

// Solo se lanciato direttamente, non quando è importato per riusare buildRace.
if (require.main === module) {
    main()
        .then(() => writeStatus('pace', true))
        .catch(err => {
            console.error('❌ Errore durante la costruzione del passo gara:', err.message);
            writeStatus('pace', false, err.message);
            process.exit(1);
        });
}
