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
// Due canali in parallelo, stesso messaggio:
//   - ntfy: canale nella variabile d'ambiente NTFY_TOPIC (segreto del
//     repository: chi conosce il nome del canale può leggerne i messaggi);
//   - web app sulla schermata Home (Web Push, lib/webpush.js): iscrizioni
//     nel segreto WEBPUSH_SUBSCRIPTIONS (JSON, una o un array, copiate dal
//     tasto "🔔 Notifiche" del sito) e chiave privata in VAPID_PRIVATE_KEY.
// Un canale non configurato si salta senza errori.
//
// Uso:
//   node scripts/notify-gp.js              (controlla e, se serve, invia)
//   node scripts/notify-gp.js --dry-run    (mostra il messaggio senza inviarlo)
//   node scripts/notify-gp.js --test-push  (notifica di prova solo alla web
//                                           app, senza toccare lo stato)

const fs = require('fs');
const path = require('path');
const { autoCircuitsAddedIn } = require('./lib/auto-circuits');
const { sendWebPush } = require('./lib/webpush');

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
    // Circuito nuovo riconosciuto in automatico quest'anno (nome = città):
    // si segnala, così il nome si può cambiare se non piace.
    if (autoCircuitsAddedIn(year).includes(circuit)) lines.push(`ℹ️ Circuito nuovo aggiunto in automatico: ${circuit}`);
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

function webPushSubscriptions() {
    const raw = (process.env.WEBPUSH_SUBSCRIPTIONS || '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(s => s && s.endpoint && s.keys);
}

// Notifica alla web app: una richiesta per iscrizione. 404/410 = iscrizione
// scaduta (iOS può invalidarla): va riattivata dal tasto 🔔 del sito e il
// segreto aggiornato.
async function sendWebPushAll(report) {
    const key = process.env.VAPID_PRIVATE_KEY;
    const subs = webPushSubscriptions();
    if (!key || !subs.length) { console.log('Web app: nessuna iscrizione configurata, salto.'); return { configured: false, delivered: 0 }; }
    let delivered = 0;
    for (const [i, sub] of subs.entries()) {
        const { status, text } = await sendWebPush(sub, { title: report.title, body: report.message, url: report.click }, key);
        if (status >= 200 && status < 300) delivered++;
        else if (status === 404 || status === 410) console.warn(`⚠️  Web app #${i + 1}: iscrizione scaduta (HTTP ${status}), va riattivata dal tasto 🔔 Notifiche del sito.`);
        else console.warn(`⚠️  Web app #${i + 1}: HTTP ${status} ${text}`);
    }
    console.log(`Web app: ${delivered}/${subs.length} notifiche consegnate.`);
    return { configured: true, delivered };
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
    console.log(`Ultimo GP: ${report.key} - ${report.complete ? 'dati completi' : 'dati incompleti'}`);
    console.log(`--- ${report.title}\n${report.message}\n(apre ${report.click})`);

    // Già notificato come completo, o già avvisato come incompleto e ancora
    // incompleto: niente doppioni.
    if (state.gp === report.key && (state.result === 'ok' || (state.result === 'warned' && !report.complete))) {
        console.log('Già notificato per questo GP: niente da inviare.');
        return;
    }
    if (DRY_RUN) { console.log('(--dry-run: notifica non inviata)'); return; }

    // Basta un canale andato a buon fine per considerare il GP notificato
    // (un errore sull'altro resta nel log). Nessun canale configurato non è
    // un errore: lo stato non cambia, così si invierà appena ce n'è uno.
    const topic = process.env.NTFY_TOPIC;
    let delivered = 0, configured = false;
    if (topic) {
        configured = true;
        try { await send(report, topic); delivered++; console.log('ntfy: notifica inviata.'); }
        catch (err) { console.warn(`⚠️  ntfy: ${err.message}`); }
    } else {
        console.warn('⚠️  NTFY_TOPIC non impostato: ntfy saltato.');
    }
    const web = await sendWebPushAll(report);
    configured = configured || web.configured;
    delivered += web.delivered;
    if (!configured) { console.warn('⚠️  Nessun canale di notifica configurato: notifica non inviata.'); return; }
    if (!delivered) throw new Error('notifica non consegnata su nessun canale');
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
