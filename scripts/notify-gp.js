// scripts/notify-gp.js
//
// Dopo ogni GP controlla che i dati del sito siano aggiornati e invia una
// notifica push (ntfy.sh) con il riepilogo: "✅ GP di Austin 2026: dati
// aggiornati" con pole, podio e leader del mondiale, oppure "⚠️ ... dati
// incompleti" con l'elenco di cosa manca.
//
// Controlli sull'ultimo GP con risultato di gara in calendar.json:
//   - pole in data.json            (update-poles.js)
//   - risultati di gara            (update-calendar.js)
//   - classifica aggiornata dopo la gara (update-standings.js)
//   - telemetria del giro di pole  (build-telemetry.js)
//   - passo gara                   (build-race-pace.js)
//
// Una sola notifica per GP: lo stato è in status/notified.json. Se i dati sono
// incompleti si avvisa una volta (⚠️) e si ricontrolla ai run successivi; quando
// diventano completi arriva il ✅.
//
// Il canale ntfy è nella variabile d'ambiente NTFY_TOPIC (segreto del
// repository: chi conosce il nome del canale può leggerne i messaggi).
//
// Uso:
//   node scripts/notify-gp.js            (controlla e, se serve, invia)
//   node scripts/notify-gp.js --dry-run  (mostra il messaggio senza inviarlo)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'status', 'notified.json');
const SITE_URL = 'https://frankbosone93.github.io/f1-pole-tracker/';
const DRY_RUN = process.argv.includes('--dry-run');

const readJson = (rel, fallback = null) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : fallback;
};

function lastCompletedGp(calendar) {
    const done = (calendar.races || []).filter(r => Array.isArray(r.results?.race) && r.results.race.length);
    return done.length ? done.reduce((a, b) => (b.date > a.date ? b : a)) : null;
}

// Ultima gara del calendario già corsa (anche senza risultati ancora): serve
// a capire se i risultati dell'ultimo weekend mancano del tutto.
function lastRaceByDate(calendar, today) {
    const past = (calendar.races || []).filter(r => r.date && r.date < today);
    return past.length ? past.reduce((a, b) => (b.date > a.date ? b : a)) : null;
}

function buildReport() {
    const calendar = readJson('calendar.json');
    if (!calendar) throw new Error('calendar.json non trovato');
    const today = new Date().toISOString().slice(0, 10);
    const year = Number(calendar.season);

    // Il GP da notificare è l'ultima gara già corsa. Se i suoi risultati non ci
    // sono ancora, è comunque quella (e il report dirà che mancano).
    const race = lastRaceByDate(calendar, today) || lastCompletedGp(calendar);
    if (!race) return null;
    const circuit = race.circuit;

    const poles = readJson('data.json', []);
    const standings = readJson('standings.json');
    const telemetry = readJson('telemetry.json');
    const paceIndex = readJson('pace/index.json');

    const pole = poles.find(d => d.year === year && d.circuit === circuit);
    const results = Array.isArray(race.results?.race) && race.results.race.length ? race.results.race : null;
    const standingsFresh = standings && String(standings.season) === String(year) && standings.updatedAt.slice(0, 10) >= race.date;
    const hasTelemetry = !!telemetry?.seasons?.[year]?.circuits?.[circuit];
    const hasPace = !!(paceIndex?.races?.[year] || []).some(r => r.circuit === circuit);

    const checks = [
        ['Pole', !!pole],
        ['Gara', !!results],
        ['Classifica', !!standingsFresh],
        ['Telemetria', hasTelemetry],
        ['Passo gara', hasPace],
    ];
    const missing = checks.filter(([, ok]) => !ok).map(([label]) => label.toLowerCase());
    const complete = missing.length === 0;

    const lines = [];
    if (pole) lines.push(`🏁 Pole: ${pole.driver} (${pole.team}) ${pole.timeStr}${pole.penaltyNote ? ' · penalità in griglia' : ''}`);
    if (results) {
        const podium = results.slice(0, 3).map(r => `${r.position}° ${r.driver}`).join(' · ');
        lines.push(`🏆 Gara: ${podium}`);
    }
    if (standingsFresh && standings.drivers?.length && standings.constructors?.length) {
        const d = standings.drivers[0], c = standings.constructors[0];
        lines.push(`📊 Mondiale: ${d.driver} ${d.points} pt · Costruttori: ${c.team} ${c.points} pt`);
    }
    // Elenco dei dati solo se manca qualcosa, in fondo e solo con ciò che
    // manca: con tutto aggiornato basta il ✅ del titolo.
    const missingLabels = checks.filter(([, ok]) => !ok).map(([label]) => label);
    if (missingLabels.length) lines.push(`❌ Non aggiornati: ${missingLabels.join(', ')}`);

    return {
        key: `${year}|${circuit}`,
        complete,
        // Titolo = solo il nome del GP: l'esito lo dice l'emoji (✅ tutto
        // aggiornato, ⚠️ manca qualcosa, elencato in fondo al messaggio).
        title: `${complete ? '✅' : '⚠️'} GP di ${circuit} ${year}`,
        message: lines.join('\n'),
        click: `${SITE_URL}#c=${encodeURIComponent(circuit)}`,
    };
}

async function send(report, topic) {
    // Pubblicazione in JSON (non con le intestazioni HTTP, che non accettano
    // emoji e lettere accentate senza codifiche speciali).
    const res = await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            topic,
            title: report.title,
            message: report.message,
            // Nessun tag: ntfy li mostra come emoji davanti al titolo (una
            // bandiera a scacchi prima del ✅, un secondo ⚠️ prima del ⚠️).
            // Il titolo ha già la sua emoji.
            priority: report.complete ? 3 : 4,
            click: report.click,
        }),
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${await res.text()}`);
}

async function main() {
    const report = buildReport();
    if (!report) { console.log('Nessun GP disputato in calendario: niente da notificare.'); return; }

    const state = readJson('status/notified.json', {});
    console.log(`Ultimo GP: ${report.key} - ${report.complete ? 'dati completi' : 'dati incompleti'}`);
    console.log(`--- ${report.title}\n${report.message}\n(apre ${report.click})`);

    // Già notificato come completo, o già avvisato come incompleto e ancora
    // incompleto: niente doppioni.
    if (state.gp === report.key && (state.result === 'ok' || (state.result === 'warned' && !report.complete))) {
        console.log('Già notificato per questo GP: niente da inviare.');
        return;
    }
    if (DRY_RUN) { console.log('(--dry-run: notifica non inviata)'); return; }

    const topic = process.env.NTFY_TOPIC;
    if (!topic) {
        // Non è un errore dell'automazione: semplicemente il canale non è
        // ancora configurato. Lo stato non cambia, così si invierà appena c'è.
        console.warn('⚠️  NTFY_TOPIC non impostato: notifica non inviata.');
        return;
    }
    await send(report, topic);
    fs.writeFileSync(STATE_PATH, JSON.stringify({
        gp: report.key,
        result: report.complete ? 'ok' : 'warned',
        at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf-8');
    console.log('✅ Notifica inviata.');
}

main().catch(err => {
    console.error('❌ Errore durante la notifica:', err.message);
    process.exit(1);
});
