// scripts/notify-gp.js
//
// Dopo ogni GP controlla che i dati del sito siano aggiornati e invia una
// notifica push con il riepilogo: "✅ GP di Austin 2026" con pole, podio e
// leader del mondiale, oppure "⚠️ GP di Austin 2026" con in fondo l'elenco di
// cosa manca.
//
// Controlli sull'ultimo GP con risultato di gara in calendar.json:
//   - pole in data.json            (update-poles.js)
//   - risultati di gara            (update-calendar.js)
//   - classifica aggiornata dopo la gara (update-standings.js)
//   - telemetria del giro di pole  (build-telemetry.js)
//   - passo gara                   (build-race-pace.js)
//
// Una sola notifica per GP: lo stato è in status/notified.json. Il ✅ parte
// appena i dati sono completi; se il giorno dopo la gara alle 7:00 UTC manca
// ancora qualcosa (es. il passo gara) parte il ⚠️ con i dati che ci sono e
// "❌ Non aggiornati: …". Dal 2026-11-08 dopo il ⚠️ non parte più il ✅
// quando i dati si completano (prima arrivavano due notifiche), e senza i
// risultati di gara non parte nulla: si aspetta.
//
// Il tocco apre il racconto del GP nelle Statistiche: dal 2026-11-10 la
// notifica aspetta che il sito online abbia le statistiche di questo GP
// (lib/live-site.js). Prima partiva insieme al loro ricalcolo
// (update-stats.yml, avviato dallo stesso aggiornamento dei dati): l'8
// novembre 16 secondi prima che fossero salvate, e chi la toccava subito
// vedeva il racconto vecchio o quello del GP precedente.
//
// Due canali in parallelo, stesso messaggio: ntfy e web app sulla schermata
// Home (vedi lib/notify-channels.js, condiviso con notify-pole.js).
//
// Uso:
//   node scripts/notify-gp.js              (controlla e, se serve, invia)
//   node scripts/notify-gp.js --dry-run    (mostra il messaggio senza inviarlo)
//   node scripts/notify-gp.js --test-push  (notifica di prova solo alla web
//                                           app, senza toccare lo stato)

const fs = require('fs');
const path = require('path');
const { autoCircuitsAddedIn } = require('./lib/auto-circuits');
const { sendAll, sendWebPushAll } = require('./lib/notify-channels');
const { standingsIncludeRace } = require('./lib/standings-fresh');
const { liveJson, waitForLive } = require('./lib/live-site');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'status', 'notified.json');
const SITE_URL = 'https://frankbosone93.github.io/f1-pole-tracker/';
const DRY_RUN = process.argv.includes('--dry-run');
const TEST_PUSH = process.argv.includes('--test-push');

const readJson = (rel, fallback = null) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : fallback;
};

function lastCompletedGp(calendar) {
    const done = (calendar.races || []).filter(r => Array.isArray(r.results?.race) && r.results.race.length);
    return done.length ? done.reduce((a, b) => (b.date > a.date ? b : a)) : null;
}

// Ultima gara del calendario già finita (anche senza risultati ancora): serve
// a capire se i risultati dell'ultimo weekend mancano del tutto. "Finita" =
// almeno 2 ore e mezza dopo il via (orario UTC del calendario), così il
// controllo può partire già la domenica sera, subito dopo i dati.
const RACE_DURATION_MS = 2.5 * 3600000;
const raceStart = r => new Date(`${r.schedule?.race?.date || r.date}T${r.schedule?.race?.time || '23:59:59Z'}`);
function lastRaceByDate(calendar, now) {
    const past = (calendar.races || []).filter(r => r.date && raceStart(r).getTime() + RACE_DURATION_MS < now.getTime());
    return past.length ? past.reduce((a, b) => (b.date > a.date ? b : a)) : null;
}

// Fino a questo momento un GP con dati incompleti aspetta: il controllo parte
// dopo ogni aggiornamento dei dati (anche la domenica sera, quando alcune
// automazioni non hanno ancora girato). Con i dati completi invece la notifica
// parte subito. Scadenza: il giorno dopo la gara alle 7:00 UTC, dopo i run di
// recupero del mattino; da lì parte con i dati che ci sono.
const warnDeadline = race => new Date(`${race.date}T07:00:00Z`).getTime() + 86400000;

// Dove porta il tocco (dal 2026-11-08): la sezione Statistiche, che si apre
// sull'ultimo GP con il racconto e i fatti (sul telefono è la prima scheda),
// con o senza passo gara. Prima portava al passo gara con il confronto tra i
// primi due, o all'andamento dei tempi del circuito senza passo gara.
const CLICK_URL = `${SITE_URL}#mode=stats`;

// Le statistiche (stats.json) sono già quelle di questo GP?
const statsHaveGp = (stats, year, circuit) => !!stats && Number(stats.year) === year && stats.lastGp?.circuit === circuit;

function buildReport() {
    const calendar = readJson('calendar.json');
    if (!calendar) throw new Error('calendar.json non trovato');
    const now = new Date();
    const year = Number(calendar.season);

    // Il GP da notificare è l'ultima gara già corsa. Se i suoi risultati non ci
    // sono ancora, è comunque quella (e il report dirà che mancano).
    const race = lastRaceByDate(calendar, now) || lastCompletedGp(calendar);
    if (!race) return null;
    const circuit = race.circuit;

    const poles = readJson('data.json', []);
    const standings = readJson('standings.json');
    const telemetry = readJson('telemetry.json');
    const paceIndex = readJson('pace/index.json');

    const pole = poles.find(d => d.year === year && d.circuit === circuit);
    const results = Array.isArray(race.results?.race) && race.results.race.length ? race.results.race : null;
    const standingsFresh = standingsIncludeRace(standings, year, race);
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
    // La pole già arrivata con la notifica del sabato (notify-pole.js) non si
    // ripete; resta comunque tra i dati controllati qui sopra.
    // (sent: false = segnata senza inviarla, la pole va mostrata qui).
    const poleState = readJson('status/notified-pole.json', {});
    const poleNotified = poleState.pole === `${year}|${circuit}` && poleState.sent !== false;
    if (pole && !poleNotified) lines.push(`🏁 Pole: ${pole.driver} (${pole.team}) ${pole.timeStr}${pole.penaltyNote ? ' · penalità in griglia' : ''}`);
    if (results) {
        const podium = results.slice(0, 3).map(r => `${r.position}° ${r.driver}`).join(' · ');
        lines.push(`🏆 Gara: ${podium}`);
    }
    if (standingsFresh && standings.drivers?.length && standings.constructors?.length) {
        const d = standings.drivers[0], c = standings.constructors[0];
        lines.push(`📊 Mondiale: ${d.driver} ${d.points} pt · Costruttori: ${c.team} ${c.points} pt`);
    }
    // Circuito nuovo riconosciuto in automatico quest'anno (nome = città):
    // si segnala, così il nome si può cambiare se non piace.
    if (autoCircuitsAddedIn(year).includes(circuit)) lines.push(`ℹ️ Circuito nuovo aggiunto in automatico: ${circuit}`);
    // Elenco dei dati solo se manca qualcosa, in fondo e solo con ciò che
    // manca: con tutto aggiornato basta il ✅ del titolo.
    const missingLabels = checks.filter(([, ok]) => !ok).map(([label]) => label);
    if (missingLabels.length) lines.push(`❌ Non aggiornati: ${missingLabels.join(', ')}`);
    lines.push('Tocca per il racconto del GP.');

    return {
        key: `${year}|${circuit}`,
        year,
        circuit,
        // stats.json del repository ha già questo GP (fatti e racconto)?
        statsReady: statsHaveGp(readJson('stats.json'), year, circuit),
        complete,
        hasResults: !!results,
        missing,
        warnAfter: warnDeadline(race),
        // Titolo = solo il nome del GP: l'esito lo dice l'emoji (✅ tutto
        // aggiornato, ⚠️ manca qualcosa, elencato in fondo al messaggio).
        title: `${complete ? '✅' : '⚠️'} GP di ${circuit} ${year}`,
        message: lines.join('\n'),
        click: CLICK_URL,
    };
}

async function main() {
    if (TEST_PUSH) {
        const r = await sendWebPushAll({ title: '🔔 Notifica di prova', message: 'Le notifiche della web app funzionano.', click: SITE_URL });
        if (!r.delivered) throw new Error('nessuna notifica di prova consegnata');
        return;
    }
    const report = buildReport();
    if (!report) { console.log('Nessun GP disputato in calendario: niente da notificare.'); return; }

    const state = readJson('status/notified.json', {});
    console.log(`Ultimo GP: ${report.key} - ${report.complete ? 'dati completi' : `dati incompleti (mancano: ${report.missing.join(', ')})`}`);
    console.log(`--- ${report.title}\n${report.message}\n(apre ${report.click})`);

    // Una sola notifica per GP: dopo un ⚠️ niente ✅ quando i dati si
    // completano.
    if (state.gp === report.key) {
        console.log('Già notificato per questo GP: niente da inviare.');
        return;
    }
    if (!report.complete && Date.now() < report.warnAfter) {
        console.log(`Dati ancora incompleti: niente ⚠️ prima di ${new Date(report.warnAfter).toISOString()} (si riprova dopo il prossimo aggiornamento).`);
        return;
    }
    if (!report.hasResults) {
        console.log('Risultati di gara ancora assenti: niente ⚠️ senza podio (si riprova dopo il prossimo aggiornamento).');
        return;
    }
    // Statistiche del GP non ancora salvate: le sta ricalcolando
    // update-stats.yml, che alla fine fa ripartire questo controllo. Dalla
    // scadenza del ⚠️ in poi non si aspetta più un altro run (se il calcolo
    // delle statistiche è fermo la notifica non deve restare bloccata).
    if (!report.statsReady && Date.now() < report.warnAfter) {
        console.log('Statistiche di questo GP non ancora salvate (stats.json): la notifica aspetta il loro aggiornamento, che fa ripartire questo controllo.');
        return;
    }
    if (DRY_RUN) {
        console.log(`(statistiche del GP sul sito online: ${statsHaveGp(await liveJson('stats.json'), report.year, report.circuit) ? 'sì' : 'non ancora'})`);
        console.log('(--dry-run: notifica non inviata)');
        return;
    }
    if (!await waitForLive('stats.json', stats => statsHaveGp(stats, report.year, report.circuit), 'le statistiche di questo GP')) {
        console.warn('⚠️  Il sito online non ha ancora le statistiche di questo GP: la notifica parte comunque.');
    }

    // Nessun canale configurato non è un errore: lo stato non cambia, così si
    // invierà appena ce n'è uno.
    const { configured, delivered } = await sendAll({ ...report, priority: report.complete ? 3 : 4 });
    if (!configured) { console.warn('⚠️  Nessun canale di notifica configurato: notifica non inviata.'); return; }
    if (!delivered) throw new Error('notifica non consegnata su nessun canale');
    fs.writeFileSync(STATE_PATH, JSON.stringify({
        gp: report.key,
        result: report.complete ? 'ok' : 'warned',
        ...(report.complete ? {} : { missing: report.missing }),
        at: new Date().toISOString(),
    }, null, 2) + '\n', 'utf-8');
    console.log('✅ Notifica inviata.');
}

main().catch(err => {
    console.error('❌ Errore durante la notifica:', err.message);
    process.exit(1);
});
