// scripts/notify-pole.js
//
// Notifica della pole, appena è salvata in data.json dopo la qualifica (di
// solito il sabato): pilota, tempo, squadra, gomma, meteo e orario della gara.
// Gira nel workflow notify-gp.yml, che parte dopo ogni aggiornamento dei dati
// (calendario, pole, telemetria...); stessi canali della notifica dopo il GP
// (lib/notify-channels.js).
//
// Regole:
//   - solo per una pole della stagione in corso la cui gara NON è ancora
//     partita: una pole salvata in ritardo (lunedì) è già nella notifica
//     dopo il GP, inutile mandarla da sola;
//   - una sola volta per GP: stato in status/notified-pole.json;
//   - la gomma (da telemetry.json) c'è solo se la telemetria è già pronta,
//     senza aspettarla; senza telemetria l'ultima riga non promette il giro
//     di pole ("Tocca per i dettagli."), che sul sito non ci sarebbe ancora.
//
// Uso:
//   node scripts/notify-pole.js            (controlla e, se serve, invia)
//   node scripts/notify-pole.js --dry-run  (mostra il messaggio senza inviarlo;
//                                           --gp "Città del Messico" per una
//                                           pole qualsiasi della stagione)

const fs = require('fs');
const path = require('path');
const { sendAll } = require('./lib/notify-channels');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'status', 'notified-pole.json');
const SITE_URL = 'https://frankbosone93.github.io/f1-pole-tracker/';
const DRY_RUN = process.argv.includes('--dry-run');
const gpArg = process.argv.includes('--gp') ? process.argv[process.argv.indexOf('--gp') + 1] : null;

const readJson = (rel, fallback = null) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : fallback;
};

const TYRES = {
    SOFT: '🔴 Soft', MEDIUM: '🟡 Medium', HARD: '⚪ Hard',
    INTERMEDIATE: '🟢 Intermedia', WET: '🔵 Da bagnato',
};

const sessionStart = s => (s?.date ? new Date(`${s.date}T${s.time || '23:59:59Z'}`) : null);

// "domenica 8 novembre alle 18:00", ora italiana.
function italianDateTime(d) {
    const day = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Rome' });
    const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    return `${day} alle ${time}`;
}

function buildReport() {
    const calendar = readJson('calendar.json');
    if (!calendar) throw new Error('calendar.json non trovato');
    const year = Number(calendar.season);
    const poles = readJson('data.json', []);
    const now = new Date();

    // La gara più vicina con la qualifica già disputata, la pole salvata e il
    // via ancora da dare (con --gp: quella indicata, per le prove).
    const race = (calendar.races || [])
        .filter(r => gpArg ? r.circuit === gpArg : (sessionStart(r.schedule?.qualy) <= now && sessionStart(r.schedule?.race || { date: r.date }) > now))
        .filter(r => poles.some(p => p.year === year && p.circuit === r.circuit))
        .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!race) return null;

    const pole = poles.find(p => p.year === year && p.circuit === race.circuit);
    const telemetry = readJson('telemetry.json')?.seasons?.[year]?.circuits?.[race.circuit];
    const tyre = telemetry?.tyre;
    const raceAt = sessionStart(race.schedule?.race);

    const lines = [`⏱️ ${pole.timeStr} · ${pole.team}`];
    const conditions = [tyre && TYRES[tyre], pole.weather].filter(Boolean).join(' · ');
    if (conditions) lines.push(conditions);
    if (raceAt) lines.push(`🏎️ Gara: ${italianDateTime(raceAt)}`);
    lines.push(telemetry ? 'Tocca per vedere il giro di pole.' : 'Tocca per i dettagli.');

    return {
        key: `${year}|${race.circuit}`,
        title: `🏁 Pole a ${race.circuit}: ${pole.driver}`,
        message: lines.join('\n'),
        click: `${SITE_URL}#c=${encodeURIComponent(race.circuit)}`,
    };
}

async function main() {
    const report = buildReport();
    if (!report) { console.log('Nessuna pole nuova con la gara ancora da disputare: niente da notificare.'); return; }

    console.log(`Pole: ${report.key}`);
    console.log(`--- ${report.title}\n${report.message}\n(apre ${report.click})`);
    if (DRY_RUN) { console.log('(--dry-run: notifica non inviata)'); return; }

    const state = readJson('status/notified-pole.json', {});
    if (state.pole === report.key) { console.log('Pole già notificata: niente da inviare.'); return; }

    const { configured, delivered } = await sendAll(report);
    if (!configured) { console.warn('⚠️  Nessun canale di notifica configurato: notifica non inviata.'); return; }
    if (!delivered) throw new Error('notifica non consegnata su nessun canale');
    fs.writeFileSync(STATE_PATH, JSON.stringify({ pole: report.key, at: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
    console.log('✅ Notifica della pole inviata.');
}

main().catch(err => {
    console.error('❌ Errore durante la notifica della pole:', err.message);
    process.exit(1);
});
