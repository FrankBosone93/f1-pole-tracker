// scripts/lib/sprint-check.js
//
// Classifica della Sprint da OpenF1 controllata con Jolpica (dal 2026-11-08).
// Nessuna delle due fonti è sempre giusta: confrontate le 30 Sprint 2021-2026
// e verificate le differenze sulle classifiche ufficiali di formula1.com.
//   - OpenF1 non ha le penalità di 5 s date dopo la Sprint di Interlagos 2025
//     a Bearman (resta 12°) e Lawson (da 13° a 16°), e a Baku 2023 non ha
//     Sargeant, né tra i risultati né tra i piloti della sessione;
//   - Jolpica non ha la penalità di 5 s di Stroll al Qatar 2023 (da 13° a
//     15°) e a Baku 2023 ha due distacchi sbagliati (Russell 4° a +3,467,
//     meno del 2°).
// Quindi si parte da OpenF1 e da Jolpica si prende solo:
//   - il distacco, quando è quello di OpenF1 più 5, 10, 15... secondi: una
//     penalità che OpenF1 non ha (l'ordine si rifà con i distacchi nuovi);
//   - i piloti che OpenF1 non ha, con il loro esito.
// Ogni altra differenza resta come in OpenF1.

const { jolpicaRaceRows } = require('./jolpica');
const { surnameKey } = require('./driver-names');

// "+8.532" o "+1:00.621" -> secondi; null per il vincitore (tempo totale),
// i doppiati ("+1 giro") e i ritirati.
const gapSeconds = time => {
    const m = /^\+(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(time || '');
    return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
};

// Ordine della classifica: vincitore, distacchi in secondi, doppiati, poi
// ritirati e non classificati, non partiti, squalificati (come
// openf1RaceResults).
const group = r => (r.retired === 'Squalificato' ? 5 : r.retired === 'Non partito' ? 4 : r.retired ? 3
    : gapSeconds(r.time) !== null ? 1 : /^\+/.test(r.time || '') ? 2 : 0);

// rows = Sprint da OpenF1 (formato del sito), jolpicaRace = la stessa Sprint
// da Jolpica (con SprintResults). Ritorna { rows, changes }: changes elenca
// le correzioni, per il log.
function checkSprintWithJolpica(rows, jolpicaRace, names) {
    if (!rows?.length || !jolpicaRace?.SprintResults?.length) return { rows, changes: [] };
    const jRows = jolpicaRaceRows({ ...jolpicaRace, Results: jolpicaRace.SprintResults }, names);
    const same = (a, b) => surnameKey(a.driver) === surnameKey(b.driver);
    const changes = [];
    const out = rows.map(r => ({ ...r }));
    for (const r of out) {
        const j = jRows.find(x => same(x, r));
        const ours = gapSeconds(r.time), theirs = gapSeconds(j?.time);
        if (ours === null || theirs === null) continue;
        const k = Math.round((theirs - ours) / 5);
        if (k >= 1 && Math.abs(theirs - ours - 5 * k) < 0.002) {
            changes.push(`${r.driver} ${r.time} -> ${j.time} (penalità di ${5 * k} s)`);
            r.time = j.time;
        }
    }
    for (const j of jRows) {
        if (out.some(r => same(r, j))) continue;
        changes.push(`${j.driver} aggiunto (${j.retired || j.time})`);
        out.push({ ...j });
    }
    if (!changes.length) return { rows, changes };
    // Chiave d'ordine di ogni riga. Vincitore = solo la prima riga: un
    // classificato con un tempo che non si legge (es. "-") prima finiva nel
    // gruppo del vincitore e saliva al 2° posto; ora resta subito dopo la
    // riga che aveva davanti.
    let prev = { g: 0, gap: 0 };
    const keyed = out.map((r, i) => {
        let k;
        if (i === 0 && !r.retired) k = { g: 0, gap: 0 };
        else if (r.retired || gapSeconds(r.time) !== null || /^\+/.test(r.time || '')) k = { g: group(r), gap: gapSeconds(r.time) ?? 0 };
        else k = { ...prev };
        prev = k;
        return { r, i, k };
    });
    const sorted = keyed
        .sort((a, b) => a.k.g - b.k.g
            || (a.k.g === 1 ? a.k.gap - b.k.gap : 0)
            || a.i - b.i)
        .map(({ r }, i) => ({ ...r, position: i + 1 }));
    return { rows: sorted, changes };
}

module.exports = { checkSprintWithJolpica };
