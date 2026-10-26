// scripts/verify-data.js
//
// Strumento di controllo manuale (NON tocca data.json, solo report a schermo):
// confronta ogni pole di data.json con due fonti indipendenti e segnala cosa
// rivedere a mano.
//
//   - Jolpica (tutti gli anni): pilota, tempo e squadra del primo in
//     qualifica; griglia di partenza della gara, per verificare che i polisti
//     non partiti primi abbiano la nota (penaltyNote).
//   - OpenF1 (dal 2023): pilota e tempo del primo in qualifica.
//
// Regola del sito: pole = il più veloce in qualifica, a prescindere dalle
// penalità in griglia (segnalate solo dalla penaltyNote).
//
// Uso:
//   node scripts/verify-data.js            (tutti gli anni di data.json)
//   node scripts/verify-data.js 2024 2025  (solo alcuni anni)

const fs = require('fs');
const path = require('path');
const { matchCircuitById, matchTeam, parseQualyTime } = require('./lib/f1-mapping');
const { openf1Json, CIRCUIT_MAP } = require('./lib/openf1');
const { jolpicaRaces } = require('./lib/jolpica');
const { surnameKey } = require('./lib/driver-names');

// Differenze già verificate a mano: il valore di data.json è quello giusto
// (errore o scelta nota della fonte). Non vengono più riproposte.
const KNOWN = {
    'jolpica|2021|Red Bull Ring': 'nel 2021 a Spielberg si corsero due GP: data.json ha il GP d\'Austria, non quello di Stiria (scelta voluta)',
    'jolpica|2025|Miami': 'Jolpica non ha il tempo di pole (1:26.204, confermato da OpenF1)',
};

const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');

async function main() {
    const data = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf-8'));
    const argYears = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
    const years = argYears.length ? argYears : [...new Set(data.map(d => d.year))].sort();
    const issues = [], known = [];
    const report = (source, year, circuit, msg) => {
        const k = `${source}|${year}|${circuit}`;
        (KNOWN[k] ? known : issues).push(`${year} ${circuit} [${source}]: ${msg}${KNOWN[k] ? ` — ${KNOWN[k]}` : ''}`);
    };
    let checked = 0;

    for (const year of years) {
        console.log(`Stagione ${year}...`);
        const qualy = await jolpicaRaces(`${year}/qualifying`);
        const results = await jolpicaRaces(`${year}/results`);
        for (const q of qualy) {
            const circuit = matchCircuitById(q.Circuit?.circuitId);
            if (!circuit) { issues.push(`${year} round ${q.round}: circuito Jolpica "${q.Circuit?.circuitId}" non mappato`); continue; }
            const entry = data.find(d => d.year === year && d.circuit === circuit);
            const p1 = q.QualifyingResults.find(r => r.position === '1');
            if (!entry) { if (p1) report('jolpica', year, circuit, `pole assente in data.json (Jolpica: ${p1.Driver.familyName} ${p1.Q3 || p1.Q2 || p1.Q1})`); continue; }
            if (!p1) continue;
            checked++;
            const t = parseQualyTime(p1.Q3 || p1.Q2 || p1.Q1);
            if (surnameKey(entry.driver) !== surnameKey(p1.Driver.familyName)) report('jolpica', year, circuit, `pilota ${entry.driver} vs ${p1.Driver.givenName} ${p1.Driver.familyName}`);
            if (!t || t.seconds !== entry.seconds) report('jolpica', year, circuit, `tempo ${entry.timeStr} vs ${t ? t.timeStr : 'assente'}`);
            if (matchTeam(p1.Constructor?.name || '') !== entry.team) report('jolpica', year, circuit, `squadra "${entry.team}" vs "${p1.Constructor?.name}"`);
            const race = results.find(r => r.round === q.round);
            const row = race?.Results.find(r => surnameKey(r.Driver.familyName) === surnameKey(entry.driver));
            if (row) {
                const grid = parseInt(row.grid, 10);
                if (grid !== 1 && !entry.penaltyNote) report('jolpica', year, circuit, `${entry.driver} partito ${grid ? grid + '°' : 'dalla pit lane'} ma senza penaltyNote`);
                if (grid === 1 && entry.penaltyNote) report('jolpica', year, circuit, 'penaltyNote presente ma il polista è partito primo');
            }
        }

        if (year >= 2023) {
            const sessions = (await openf1Json(`https://api.openf1.org/v1/sessions?year=${year}&session_name=Qualifying`))
                .filter(s => new Date(s.date_end) < new Date());
            for (const s of sessions) {
                const circuit = CIRCUIT_MAP[s.circuit_short_name];
                const entry = circuit && data.find(d => d.year === year && d.circuit === circuit);
                if (!entry) continue;
                const p1 = (await openf1Json(`https://api.openf1.org/v1/session_result?session_key=${s.session_key}`)).find(r => r.position === 1);
                if (!p1) continue;
                const best = [].concat(p1.duration).reverse().find(v => typeof v === 'number');
                const d = (await openf1Json(`https://api.openf1.org/v1/drivers?session_key=${s.session_key}&driver_number=${p1.driver_number}`))[0] || {};
                if (surnameKey(d.last_name) !== surnameKey(entry.driver)) report('openf1', year, circuit, `pilota ${entry.driver} vs ${d.first_name} ${d.last_name}`);
                if (Math.abs((best || 0) - entry.seconds) > 0.0005) report('openf1', year, circuit, `tempo ${entry.seconds} vs ${best}`);
            }
        }
    }

    console.log('\n========== RISULTATO VERIFICA ==========');
    console.log(`Pole controllate su Jolpica: ${checked}`);
    console.log(`Differenze note, già verificate (${known.length}):`);
    known.forEach(k => console.log('  - ' + k));
    console.log(`\nDA RIVEDERE (${issues.length}):`);
    issues.forEach(i => console.log('  - ' + i));
    console.log('==========================================');
    console.log('Questo script segnala soltanto: data.json non viene modificato.');
}

main().catch(err => { console.error('FATAL', err.message); process.exit(1); });
