// scripts/notify-season.js
//
// Notifica di fine stagione (dal 2026-11-08): una volta sola, la mattina dopo
// l'ultima gara del calendario, con campione del mondo, squadra campione (con
// il GP in cui hanno chiuso i conti) e i numeri del campione. Il tocco apre
// Statistiche sulla scheda del racconto della stagione (#mode=stats&s=stagione).
// Testo solo con i dati del sito, senza IA:
//   🏆 Stagione 2026 conclusa
//   👑 Campione del Mondo: <pilota> (<squadra>), <punti> pt, +<distacco> su <secondo> · deciso a <GP>
//   🏆 Costruttori: <squadra>, <punti> pt · deciso a <GP>
//   📊 <campione>: N vittorie, N podi, N pole · N vincitori diversi in N GP
//
// Condizioni, tutte insieme:
//   - l'ultima gara del calendario ha i risultati (calendar.json);
//   - è almeno il giorno dopo alle 8:00 UTC (in inverno le 9:00 in Italia):
//     la domenica sera arriva già la notifica del GP (notify-gp.js);
//   - standings.json comprende l'ultima gara (classifica finale) e stats.json
//     conta tutte le gare disputate;
//   - il racconto della stagione è stato riscritto dopo l'ultima gara
//     (build-stats.js lo riscrive quando Jolpica ha la classifica dell'ultimo
//     round), così il tocco apre il bilancio finale. Se dopo un giorno non è
//     ancora pronto (es. API di Anthropic non disponibile) si invia comunque:
//     il testo della notifica non dipende dal racconto;
//   - non è già partita: stato in status/notified-season.json.
// Se manca qualcosa si riprova al run successivo di notify-gp.yml (dopo ogni
// aggiornamento di dati e statistiche, e lunedì e martedì alle 8:13 UTC, che
// GitHub però fa partire anche con ore di ritardo).
//
// Stessi canali delle notifiche dei GP (lib/notify-channels.js).
//
// Uso:
//   node scripts/notify-season.js            (controlla e, se serve, invia)
//   node scripts/notify-season.js --dry-run  (mostra messaggio e condizioni
//                                             senza inviare; a stagione in
//                                             corso è un'anteprima con i
//                                             dati di oggi)

const fs = require('fs');
const path = require('path');
const { sendAll } = require('./lib/notify-channels');
const { standingsIncludeRace } = require('./lib/standings-fresh');
const { titleClinches, atCircuit } = require('./lib/title-clinches');
const { surnameKey } = require('./lib/driver-names');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'status', 'notified-season.json');
const SITE_URL = 'https://frankbosone93.github.io/f1-pole-tracker/';
const DRY_RUN = process.argv.includes('--dry-run');

const readJson = (rel, fallback = null) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : fallback;
};

const DAY_MS = 86400000;
// Invio dal giorno dopo l'ultima gara alle 8:00 UTC (data UTC del via).
const sendFrom = race => Date.parse(`${race.schedule?.race?.date || race.date}T08:00:00Z`) + DAY_MS;
// Attesa massima del racconto della stagione dopo l'orario di invio.
const STORY_WAIT_MS = DAY_MS;

const surname = name => String(name).trim().split(/\s+/).pop();
const pts = n => String(n).replace('.', ',');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const iso = ms => new Date(ms).toISOString();

function buildReport() {
    const calendar = readJson('calendar.json');
    if (!calendar) throw new Error('calendar.json non trovato');
    const season = Number(calendar.season);
    const races = (calendar.races || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const last = races[races.length - 1];
    if (!last) return null;
    const done = races.filter(r => r.results?.race?.length);
    const finished = !!last.results?.race?.length;

    const stats = readJson('stats.json', {});
    const s = stats.year === season ? stats.season : null;
    const standings = readJson('standings.json');
    const sameSeason = String(standings?.season) === String(season);
    const drivers = sameSeason ? (standings.drivers || []).slice().sort((a, b) => a.position - b.position) : [];
    const teams = sameSeason ? (standings.constructors || []).slice().sort((a, b) => a.position - b.position) : [];

    const waiting = [];
    if (!finished) waiting.push(`risultati dell'ultima gara (${last.circuit})`);
    if (!standingsIncludeRace(standings, season, last) || drivers.length < 2 || !teams.length) waiting.push('classifica finale (standings.json)');
    if (!s || s.racesDone !== done.length) waiting.push('statistiche con tutte le gare (stats.json)');

    let message = null;
    if (drivers.length >= 2 && teams.length) {
        const [champ, second] = drivers;
        const team = teams[0];
        // GP in cui il titolo è diventato matematico, solo se il campione è
        // lo stesso (una penalità dopo la gara potrebbe cambiare le cose).
        const clinch = titleClinches(s?.progress || [], races);
        const where = c => (c ? ` · deciso ${atCircuit(c.decisoA)}` : '');
        const driverClinch = clinch.piloti && surnameKey(clinch.piloti.pilota) === surnameKey(champ.driver) ? clinch.piloti : null;
        const teamClinch = clinch.costruttori?.squadra === team.team ? clinch.costruttori : null;
        const gap = champ.points - second.points;
        const lines = [
            `👑 Campione del Mondo: ${champ.driver} (${champ.team}), ${pts(champ.points)} pt, ${gap > 0 ? `+${pts(gap)} su` : 'a pari punti con'} ${surname(second.driver)}${where(driverClinch)}`,
            `🏆 Costruttori: ${team.team}, ${pts(team.points)} pt${where(teamClinch)}`,
        ];
        const row = (s?.drivers || []).find(d => surnameKey(d.name) === surnameKey(champ.driver));
        if (row) {
            const winners = s.winners === 1 ? 'un solo vincitore' : `${s.winners} vincitori diversi`;
            lines.push(`📊 ${surname(champ.driver)}: ${plural(row.wins, 'vittoria', 'vittorie')}, ${plural(row.podiums, 'podio', 'podi')}, ${row.poles} pole · ${winners} in ${s.racesDone} GP`);
        }
        lines.push('Tocca per il racconto della stagione.');
        message = lines.join('\n');
    }

    return {
        season,
        last,
        finished,
        waiting,
        storyReady: !!s?.story?.text && s.story.circuit === last.circuit,
        sendFrom: sendFrom(last),
        title: `🏆 Stagione ${season} conclusa`,
        message,
        click: `${SITE_URL}#mode=stats&s=stagione`,
    };
}

async function main() {
    const report = buildReport();
    if (!report) { console.log('Calendario senza gare: niente da notificare.'); return; }

    const state = readJson('status/notified-season.json', {});
    if (state.season === report.season) { console.log(`Fine stagione ${report.season} già notificata: niente da inviare.`); return; }
    if (!report.finished && !DRY_RUN) {
        console.log(`Stagione ${report.season} in corso (ultima gara: ${report.last.circuit}, ${report.last.date}): niente da notificare.`);
        return;
    }
    if (!report.finished) console.log(`(anteprima con i dati di oggi: la stagione ${report.season} non è ancora finita)`);
    if (report.message) console.log(`--- ${report.title}\n${report.message}\n(apre ${report.click})`);

    const now = Date.now();
    const waiting = [...report.waiting];
    if (now < report.sendFrom) waiting.push(`la mattina dopo l'ultima gara (dalle ${iso(report.sendFrom)})`);
    if (!report.storyReady) {
        if (now < report.sendFrom + STORY_WAIT_MS) waiting.push(`racconto della stagione riscritto dopo ${report.last.circuit} (al massimo fino alle ${iso(report.sendFrom + STORY_WAIT_MS)})`);
        else console.warn(`⚠️  Racconto della stagione non riscritto dopo ${report.last.circuit}: la notifica parte comunque.`);
    }
    if (waiting.length) { console.log(`In attesa di: ${waiting.join('; ')}. Si riprova al prossimo controllo.`); return; }
    if (DRY_RUN) { console.log('(--dry-run: notifica non inviata)'); return; }

    // Nessun canale configurato non è un errore: lo stato non cambia, così si
    // invierà appena ce n'è uno.
    const { configured, delivered } = await sendAll(report);
    if (!configured) { console.warn('⚠️  Nessun canale di notifica configurato: notifica non inviata.'); return; }
    if (!delivered) throw new Error('notifica non consegnata su nessun canale');
    fs.writeFileSync(STATE_PATH, JSON.stringify({ season: report.season, at: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
    console.log('✅ Notifica di fine stagione inviata.');
}

main().catch(err => {
    console.error('❌ Errore durante la notifica di fine stagione:', err.message);
    process.exit(1);
});
