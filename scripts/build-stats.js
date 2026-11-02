// scripts/build-stats.js
//
// Calcola stats.json per la sezione "Statistiche" del sito:
//   - lastGp: i fatti dell'ultimo GP disputato (pole confrontata con gli anni
//     passati sullo stesso circuito, pole e vincitore in gara, rimonte,
//     doppiette, giro più veloce, velocità massima, strategie, mondiale) e un
//     breve racconto scritto da Claude con gli stessi dati (lib/gp-story.js);
//   - gps: l'elenco dei GP archiviati in stats/{anno}/{circuito}.json (fatti,
//     direzione gara e racconto di ogni GP della stagione, vedi main);
//   - season: la stagione in numeri (vittorie, podi e pole per pilota e
//     squadra, pole trasformate in vittoria, prime file monopolizzate, duelli
//     in qualifica tra compagni di squadra).
//
// Legge i file già scaricati dalle altre automazioni (calendar.json,
// data.json, standings.json, telemetry.json, pace/). Richieste esterne: i
// messaggi della direzione gara dell'ultimo GP da OpenF1, per il racconto
// (lib/race-control.js), e la classifica delle qualifiche della stagione da
// Jolpica, per i duelli tra compagni (calendar.json ha la griglia di partenza, che con le
// penalità non dice chi è andato più forte in qualifica). Se Jolpica non
// risponde si tengono i duelli calcolati al giro precedente.
//
// Gira in .github/workflows/update-stats.yml dopo ogni aggiornamento dei
// dati. Uso manuale: node scripts/build-stats.js

const fs = require('fs');
const path = require('path');
const { jolpicaRaces, jolpicaDriver } = require('./lib/jolpica');
const { knownDriverNames, surnameKey } = require('./lib/driver-names');
const { matchTeam } = require('./lib/f1-mapping');
const { writeStatus } = require('./lib/status');
const { raceControlEvents } = require('./lib/race-control');
const { circuitSlug } = require('./lib/openf1');

const ROOT = path.join(__dirname, '..');
const readJson = (rel, fallback = null) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : fallback;
};

// Anni di inizio dei regolamenti tecnici: i tempi sul giro si confrontano solo
// dentro la stessa era (le auto 2026 sono 2-3 s più lente delle 2025). Con un
// nuovo regolamento basta aggiungere l'anno.
const REGULATION_ERAS = [2014, 2022, 2026];
const eraOf = year => Math.max(...REGULATION_ERAS.filter(y => y <= year));

const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const MAX_RACE = 25, MAX_SPRINT = 8;
const MAX_TEAM_RACE = 25 + 18, MAX_TEAM_SPRINT = 8 + 7;
const TYRES = { SOFT: 'Soft', MEDIUM: 'Medium', HARD: 'Hard', INTERMEDIATE: 'Intermedia', WET: 'Da bagnato' };

const isWet = weather => /Pioggia|Piovoso/.test(weather || '');
const same = (a, b) => surnameKey(a) === surnameKey(b);
const secs = d => Math.abs(d).toFixed(3).replace('.', ',');
const lapStr = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
const hasSprint = r => !!r.schedule?.sprintRace?.date;
const surname = name => String(name).trim().split(/\s+/).pop();

// --- Ultimo GP ---------------------------------------------------------------

function poleFact(season, circuit, poles) {
    const pole = poles.find(p => p.year === season && p.circuit === circuit);
    if (!pole) return null;
    if (isWet(pole.weather)) {
        return { icon: '🌧️', text: `**Pole sul bagnato** per ${pole.driver} (${pole.timeStr}): tempo non confrontabile con le qualifiche asciutte.` };
    }
    const past = poles.filter(p => p.circuit === circuit && p.year < season && !isWet(p.weather)).sort((a, b) => b.year - a.year);
    if (!past.length) return { icon: '⏱️', text: `**Prima pole di sempre** a ${circuit} nei nostri dati: ${pole.driver} in ${pole.timeStr}.` };
    const era = eraOf(season);
    const sameEra = past.filter(p => eraOf(p.year) === era);
    if (!sameEra.length) {
        const prev = past[0];
        const d = pole.seconds - prev.seconds;
        return { icon: '⏱️', text: `**Pole ${pole.timeStr}**: ${secs(d)} s ${d > 0 ? 'più lenta' : 'più veloce'} della pole ${prev.year} (${prev.driver}), prima stagione qui con le regole ${era}.` };
    }
    const best = sameEra.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    if (pole.seconds < best.seconds) {
        return { icon: '⏱️', text: `**Pole più veloce** a ${circuit} con le regole attuali (dal ${era}): ${pole.timeStr}, ${secs(best.seconds - pole.seconds)} s meglio di ${best.driver} nel ${best.year}.` };
    }
    const prev = sameEra[0];
    const d = pole.seconds - prev.seconds;
    const vsPrev = `${secs(d)} s ${d > 0 ? 'più lenta' : 'più veloce'} della pole ${prev.year}`;
    const record = best === prev ? '' : `; il riferimento dal ${era} resta ${best.timeStr} di ${best.driver} (${best.year})`;
    return { icon: '⏱️', text: `**Pole ${pole.timeStr}**: ${vsPrev}${record}.` };
}

function raceFacts(race, pole) {
    const facts = [];
    const results = race.results.race;
    const grid = race.results.qualy || [];
    const gridOf = driver => grid.find(g => same(g.driver, driver))?.position;
    const winner = results.find(r => r.position === 1);

    if (pole) {
        const row = results.find(r => same(r.driver, pole.driver));
        if (row && row.position === 1) facts.push({ icon: '🏁', text: `**Pole e vittoria**: ${pole.driver}.` });
        else if (row?.retired) facts.push({ icon: '🏁', text: `**${pole.driver}**, autore della pole: ${row.retired.toLowerCase()}.` });
        else if (row) facts.push({ icon: '🏁', text: `**${pole.driver}**, autore della pole, chiude ${row.position}°.` });
    }

    const winnerGrid = winner && gridOf(winner.driver);
    if (winner && winnerGrid > 1 && !(pole && same(pole.driver, winner.driver))) {
        facts.push({ icon: '🚀', text: `**${winner.driver}** vince partendo ${winnerGrid}°${winnerGrid >= 6 ? `: rimonta di ${winnerGrid - 1} posizioni` : ''}.` });
    }

    const moves = results.filter(r => !r.retired && gridOf(r.driver)).map(r => ({ r, gain: gridOf(r.driver) - r.position }));
    const up = moves.reduce((a, b) => (!a || b.gain > a.gain ? b : a), null);
    const down = moves.reduce((a, b) => (!a || b.gain < a.gain ? b : a), null);
    if (up && up.gain >= 3) facts.push({ icon: '📈', text: `**Più posizioni guadagnate**: ${up.r.driver}, da ${up.r.position + up.gain}° a ${up.r.position}° (+${up.gain}).` });
    if (down && down.gain <= -3) facts.push({ icon: '📉', text: `**Più posizioni perse**: ${down.r.driver}, da ${down.r.position + down.gain}° a ${down.r.position}° (${down.gain}).` });

    const p2 = results.find(r => r.position === 2);
    if (winner && p2 && winner.team === p2.team) facts.push({ icon: '🤝', text: `**Doppietta ${winner.team}**: ${surname(winner.driver)} davanti ${/^a/i.test(surname(p2.driver)) ? 'ad' : 'a'} ${surname(p2.driver)}.` });
    const front = grid.filter(g => g.position <= 2);
    if (front.length === 2 && front[0].team === front[1].team) facts.push({ icon: '🔒', text: `**Prima fila** tutta ${front[0].team}.` });
    return facts;
}

// Giro più veloce, strategia del vincitore e strategia più usata, dal file del
// passo gara (giri per numero di gara, stint, ingressi ai box).
function paceFacts(year, circuit, results) {
    const entry = (readJson('pace/index.json')?.races?.[year] || []).find(r => r.circuit === circuit);
    const pace = entry && readJson(entry.file);
    if (!pace) return [];
    const facts = [];
    const nameOf = n => {
        const d = pace.drivers.find(x => String(x.n) === String(n));
        return d ? (results.find(r => same(r.driver, d.name))?.driver || d.name) : `#${n}`;
    };
    let best = null;
    for (const [n, laps] of Object.entries(pace.laps || {})) {
        laps.forEach((t, i) => { if (typeof t === 'number' && (!best || t < best.t)) best = { n, t, lap: i + 1 }; });
    }
    if (best) facts.push({ icon: '⚡', text: `**Giro più veloce**: ${nameOf(best.n)} in ${lapStr(best.t)} (giro ${best.lap}).` });

    const winner = pace.drivers.find(d => d.pos === 1);
    if (winner) {
        const stops = (pace.pitIn?.[winner.n] || []).length;
        // Sequenza delle gomme solo se OpenF1 ha la mescola di ogni stint
        // (Melbourne 2026: primo stint senza mescola, usciva "( → Hard)").
        const stints = pace.stints?.[winner.n] || [];
        const tyres = stints.every(st => st[2]) ? stints.map(st => TYRES[st[2]] || st[2]).join(' → ') : '';
        facts.push({ icon: '🛞', text: `**${nameOf(winner.n)}** ha vinto con ${stops === 1 ? '1 sosta' : `${stops} soste`}${tyres ? ` (${tyres})` : ''}.` });
    }
    const finishers = pace.drivers.filter(d => d.pos);
    const byStops = {};
    finishers.forEach(d => { const s = (pace.pitIn?.[d.n] || []).length; byStops[s] = (byStops[s] || 0) + 1; });
    const common = Object.entries(byStops).sort((a, b) => b[1] - a[1])[0];
    if (common && finishers.length) facts.push({ icon: '🔧', text: `**Strategia più usata**: ${common[0] === '1' ? '1 sosta' : `${common[0]} soste`} (${common[1]} piloti su ${finishers.length} classificati).` });
    return facts;
}

function topSpeedFact(year, circuit) {
    const tel = readJson('telemetry.json')?.seasons || {};
    const top = y => {
        const s = tel[y]?.circuits?.[circuit]?.samples;
        return s?.length ? Math.max(...s.map(x => x.speed || 0)) : null;
    };
    const now = top(year);
    if (!now) return null;
    const prevYear = Object.keys(tel).map(Number).filter(y => y < year && top(y)).sort((a, b) => b - a)[0];
    return { icon: '💨', text: `**Velocità massima** nel giro di pole: ${now} km/h${prevYear ? ` (${prevYear}: ${top(prevYear)} km/h)` : ''}.` };
}

// Mondiale dopo la gara: distacco, variazione nel GP (solo senza sprint nel
// weekend, perché la classifica non dice i punti della sprint), titolo deciso
// o decidibile al prossimo GP.
function championshipFacts(season, race, races, standings) {
    if (!standings || String(standings.season) !== String(season) || standings.updatedAt.slice(0, 10) < race.date) return [];
    const [d1, d2] = standings.drivers;
    if (!d1 || !d2) return [];
    const facts = [];
    const remaining = races.filter(r => r.date > race.date);
    const maxLeft = remaining.length * MAX_RACE + remaining.filter(hasSprint).length * MAX_SPRINT;
    const gap = d1.points - d2.points;
    if (gap > maxLeft) {
        facts.push({ icon: '🏆', text: remaining.length
            ? `**${d1.driver}** è matematicamente Campione del Mondo ${season}, con ${remaining.length} ${remaining.length === 1 ? 'gara' : 'gare'} d'anticipo.`
            : `**${d1.driver}** è Campione del Mondo ${season}.` });
    } else {
        let text = `**${d1.driver}** guida il mondiale con ${gap} punti su ${d2.driver}`;
        if (!hasSprint(race)) {
            const pts = name => RACE_POINTS[(race.results.race.find(r => same(r.driver, name))?.position || 99) - 1] || 0;
            const delta = pts(d1.driver) - pts(d2.driver);
            if (delta) text += ` (${delta > 0 ? '+' : ''}${delta} in questo GP)`;
        }
        facts.push({ icon: '📊', text: `${text}.` });
        const next = remaining[0];
        if (next) {
            const after = remaining.slice(1);
            const threshold = after.length * MAX_RACE + after.filter(hasSprint).length * MAX_SPRINT;
            if (threshold < gap + MAX_RACE + (hasSprint(next) ? MAX_SPRINT : 0)) {
                facts.push({ icon: '🏆', text: `**Titolo già a ${next.circuit}** se ${surname(d1.driver)} ne esce con più di ${threshold} punti di vantaggio su tutti gli avversari.` });
            }
        }
    }
    const [c1, c2] = standings.constructors || [];
    if (c1 && c2) {
        const teamMax = remaining.length * MAX_TEAM_RACE + remaining.filter(hasSprint).length * MAX_TEAM_SPRINT;
        if (c1.points - c2.points > teamMax) facts.push({ icon: '🏆', text: `**${c1.team}** è Campione del Mondo Costruttori ${season}.` });
    }
    return facts;
}

// Dati passati a Claude per il racconto del GP: solo quello che il sito sa.
// La classifica solo se aggiornata dopo la gara (come championshipFacts).
function storyInput(season, race, pole, facts, standings, raceControl) {
    const results = race.results.race;
    const grid = race.results.qualy || [];
    const gridOf = driver => grid.find(g => same(g.driver, driver))?.position ?? null;
    const fresh = standings && String(standings.season) === String(season) && standings.updatedAt.slice(0, 10) >= race.date;
    return {
        gp: `${race.circuit} ${season}, gara ${race.round} della stagione`,
        pole: pole ? { pilota: pole.driver, squadra: pole.team, tempo: pole.timeStr, meteoQualifica: pole.weather || null } : null,
        arrivo: results.filter(r => !r.retired).slice(0, 10).map(r => ({ pos: r.position, pilota: r.driver, squadra: r.team, griglia: gridOf(r.driver), tempo: r.time })),
        nonClassificati: results.filter(r => r.retired).map(r => ({ pilota: r.driver, squadra: r.team, esito: r.retired, griglia: gridOf(r.driver) })),
        fatti: facts.map(f => f.text.replace(/\*\*/g, '')), // senza il grassetto del sito
        direzioneGara: raceControl || null,
        mondialePilotiDopoLaGara: fresh ? standings.drivers.slice(0, 5).map(d => ({ pos: d.position, pilota: d.driver, punti: d.points })) : null,
    };
}

// --- Stagione ----------------------------------------------------------------

function seasonStats(season, races, poles) {
    const done = races.filter(r => r.results?.race?.length);
    const seasonPoles = poles.filter(p => p.year === season);
    const drivers = new Map(), teams = new Map();
    const bump = (map, key, team, field) => {
        if (!map.has(key)) map.set(key, { name: key, team, wins: 0, podiums: 0, poles: 0 });
        const e = map.get(key);
        if (team) e.team = team;
        e[field]++;
    };
    for (const r of done) {
        r.results.race.filter(x => x.position <= 3 && !x.retired).forEach(x => {
            bump(drivers, x.driver, x.team, 'podiums');
            bump(teams, x.team, null, 'podiums');
            if (x.position === 1) { bump(drivers, x.driver, x.team, 'wins'); bump(teams, x.team, null, 'wins'); }
        });
    }
    for (const p of seasonPoles) {
        const key = [...drivers.keys()].find(k => same(k, p.driver)) || p.driver;
        bump(drivers, key, drivers.get(key)?.team || p.team, 'poles');
        bump(teams, p.team, null, 'poles');
    }
    const sortRows = rows => rows.sort((a, b) => b.wins - a.wins || b.podiums - a.podiums || b.poles - a.poles || a.name.localeCompare(b.name));

    const converted = done.filter(r => {
        const pole = seasonPoles.find(p => p.circuit === r.circuit);
        const win = r.results.race.find(x => x.position === 1);
        return pole && win && same(pole.driver, win.driver);
    }).length;
    const withPole = done.filter(r => seasonPoles.some(p => p.circuit === r.circuit)).length;
    const lockouts = done.filter(r => {
        const f = (r.results.qualy || []).filter(g => g.position <= 2);
        return f.length === 2 && f[0].team === f[1].team;
    }).length;

    return {
        racesDone: done.length,
        racesTotal: races.length,
        winners: new Set(done.map(r => r.results.race.find(x => x.position === 1)?.driver).filter(Boolean)).size,
        poleSitters: new Set(seasonPoles.map(p => surnameKey(p.driver))).size,
        poleToWin: { converted, of: withPole },
        frontRowLockouts: lockouts,
        wetQualifyings: seasonPoles.filter(p => isWet(p.weather)).length,
        drivers: sortRows([...drivers.values()]),
        teams: sortRows([...teams.values()]).map(({ team, ...t }) => t),
    };
}

// Duelli in qualifica tra compagni di squadra (posizione di qualifica, non di
// griglia), da Jolpica. Una coppia per squadra e pilota: chi sostituisce un
// titolare per qualche gara forma una coppia a parte.
async function qualyDuels(season, names) {
    const qualy = await jolpicaRaces(`${season}/qualifying`);
    const pairs = new Map();
    for (const race of qualy) {
        const byTeam = new Map();
        for (const r of race.QualifyingResults) {
            const team = matchTeam(r.Constructor?.name || '');
            if (!byTeam.has(team)) byTeam.set(team, []);
            byTeam.get(team).push({ driver: jolpicaDriver(r.Driver, names), pos: Number(r.position) });
        }
        for (const [team, ds] of byTeam) {
            if (ds.length !== 2) continue;
            const [a, b] = ds.slice().sort((x, y) => x.driver.localeCompare(y.driver));
            const key = `${team}|${a.driver}|${b.driver}`;
            if (!pairs.has(key)) pairs.set(key, { team, a: a.driver, b: b.driver, aAhead: 0, bAhead: 0 });
            pairs.get(key)[a.pos < b.pos ? 'aAhead' : 'bAhead']++;
        }
    }
    // Il più avanti nel duello per primo; squadre in ordine di duelli disputati.
    return [...pairs.values()].map(p => (p.bAhead > p.aAhead ? { team: p.team, a: p.b, b: p.a, aAhead: p.bAhead, bAhead: p.aAhead } : p))
        .sort((x, y) => (y.aAhead + y.bAhead) - (x.aAhead + x.bAhead) || x.team.localeCompare(y.team));
}

// Un GP: fatti, messaggi della direzione gara e racconto di Claude. prev = la
// stessa gara salvata in precedenza (archivio o stats.json): se OpenF1 o
// l'API di Anthropic non rispondono si tengono i suoi messaggi e il suo
// racconto. Frasi sul mondiale e classifica nel racconto solo per l'ultimo GP
// (standings.json è la classifica attuale, non quella di allora); facts = i
// fatti già archiviati, da non ricalcolare.
async function buildGp(season, race, races, poles, standings, isLast, prev, facts = null) {
    const pole = poles.find(p => p.year === season && p.circuit === race.circuit);
    const gp = {
        round: race.round,
        circuit: race.circuit,
        date: race.date,
        facts: facts || [
            poleFact(season, race.circuit, poles),
            ...raceFacts(race, pole),
            ...paceFacts(season, race.circuit, race.results.race),
            topSpeedFact(season, race.circuit),
            ...(isLast ? championshipFacts(season, race, races, standings) : []),
        ].filter(Boolean),
    };
    gp.raceControl = prev?.raceControl;
    try {
        gp.raceControl = await raceControlEvents(season, race.circuit, race.results.race);
    } catch (err) {
        console.warn(`⚠️  ${race.circuit}: direzione gara da OpenF1 non disponibile (${err.message})${gp.raceControl ? ', tengo i messaggi precedenti' : ''}.`);
    }
    try {
        const { gpStory } = require('./lib/gp-story');
        const input = storyInput(season, race, pole, gp.facts, isLast ? standings : null, gp.raceControl);
        gp.story = await gpStory(input, prev?.story) || prev?.story || undefined;
    } catch (err) {
        console.warn(`⚠️  ${race.circuit}: racconto del GP non disponibile (${err.message}).`);
        gp.story = prev?.story || undefined;
    }
    return gp;
}

// Si riscrive solo se cambia qualcosa oltre all'orario.
const writeStatsFile = (rel, payload) => {
    const strip = s => JSON.stringify({ ...s, updatedAt: null });
    if (strip(payload) === strip(readJson(rel, {}))) return;
    fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(payload, null, 2) + '\n', 'utf-8');
};

const writeJsonIfChanged = (rel, data) => {
    const p = path.join(ROOT, rel);
    const json = JSON.stringify(data, null, 2) + '\n';
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf-8') === json) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, json, 'utf-8');
};

async function main() {
    const calendar = readJson('calendar.json');
    if (!calendar) throw new Error('calendar.json non trovato');
    const season = Number(calendar.season);
    const races = (calendar.races || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const poles = readJson('data.json', []);
    const standings = readJson('standings.json');
    const previous = readJson('stats.json', {});

    // Archivio per GP in stats/{anno}/{circuito}.json, per rileggere i GP
    // precedenti dal sito. L'ultimo GP si ricalcola a ogni giro; un GP già
    // archiviato e non più l'ultimo resta com'era quando lo era (frasi sul
    // mondiale di allora comprese), salvo ricevere il racconto se ancora non
    // ce l'ha. Un GP passato mai archiviato (recupero del 2026-11-01) si
    // ricostruisce senza le frasi sul mondiale.
    const done = races.filter(r => r.results?.race?.length);
    const gps = [];
    let lastGp = null;
    for (const race of done) {
        const isLast = race === done[done.length - 1];
        const file = `stats/${season}/${circuitSlug(race.circuit)}.json`;
        const archived = readJson(file);
        const frozen = !isLast && archived;
        let gp = archived;
        if (!frozen || !archived.story) {
            const prev = archived || (previous.year === season && previous.lastGp?.circuit === race.circuit ? previous.lastGp : null);
            gp = await buildGp(season, race, races, poles, standings, isLast, prev, frozen ? archived.facts : null);
            writeJsonIfChanged(file, gp);
        }
        gps.push({ round: race.round, circuit: race.circuit, file });
        if (isLast) lastGp = gp;
    }

    const stats = seasonStats(season, races, poles);
    try {
        stats.qualyDuels = await qualyDuels(season, knownDriverNames());
    } catch (err) {
        console.warn(`⚠️  Duelli in qualifica da Jolpica non disponibili (${err.message}): tengo quelli precedenti.`);
        stats.qualyDuels = previous.year === season ? previous.season?.qualyDuels || [] : [];
    }

    // La stagione si salva anche in stats/{anno}/index.json: quando arriva la
    // stagione nuova quella vecchia non si tocca più e i suoi GP restano nel
    // menu del sito, divisi per anno. stats.json = stagione in corso +
    // pastSeasons (anno ed elenco dei GP di ogni stagione passata).
    const payload = { year: season, updatedAt: new Date().toISOString(), lastGp, gps, season: stats };
    writeStatsFile(`stats/${season}/index.json`, payload);
    const pastSeasons = fs.readdirSync(path.join(ROOT, 'stats'))
        .filter(y => /^\d{4}$/.test(y) && Number(y) !== season)
        .map(y => readJson(`stats/${y}/index.json`))
        .filter(Boolean)
        .sort((a, b) => b.year - a.year)
        .map(p => ({ year: p.year, gps: p.gps || [] }));
    writeStatsFile('stats.json', { ...payload, pastSeasons });
    console.log(`Ultimo GP: ${lastGp ? `${lastGp.circuit} (${lastGp.facts.length} fatti)` : 'nessuno'}`);
    if (lastGp?.story) console.log(`  📝 ${lastGp.story.text}`);
    (lastGp?.facts || []).forEach(f => console.log(`  ${f.icon} ${f.text}`));
    console.log(`Stagione ${season}: ${stats.racesDone}/${stats.racesTotal} GP, ${stats.drivers.length} piloti, ${stats.qualyDuels.length} duelli in qualifica.`);
}

main()
    .then(() => writeStatus('stats', true))
    .catch(err => {
        console.error('❌ Errore nel calcolo delle statistiche:', err.message);
        writeStatus('stats', false, err.message);
        process.exit(1);
    });
