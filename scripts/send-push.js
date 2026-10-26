// scripts/send-push.js
//
// Invio manuale di una notifica alla web app (Web Push), usato dal Mac di
// sviluppo per la notifica delle Novità (nuovo changelog) e per le prove.
// Legge iscrizioni e chiave privata dalla cartella private/ (esclusa da git,
// vedi private/LEGGIMI.txt).
//
// Uso:
//   node scripts/send-push.js --to Francesco --title "..." --body "..." [--url "#novita"]
//   node scripts/send-push.js --all --title "..." --body "..." --url "#novita"
//
// --to accetta uno o più nomi separati da virgola (campo "name" delle
// iscrizioni); senza --to né --all non invia nulla. --url relativo al sito.

const fs = require('fs');
const path = require('path');
const { sendWebPush } = require('./lib/webpush');

const ROOT = path.join(__dirname, '..');
const SITE_URL = 'https://frankbosone93.github.io/f1-pole-tracker/';

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : null;
}

async function main() {
    const title = arg('title'), body = arg('body') || '';
    const to = arg('to'), all = process.argv.includes('--all');
    if (!title || (!to && !all)) throw new Error('servono --title e uno tra --to <nomi> e --all');
    const subs = JSON.parse(fs.readFileSync(path.join(ROOT, 'private', 'webpush-subscriptions.json'), 'utf-8'));
    const key = fs.readFileSync(path.join(ROOT, 'private', 'vapid-private-key.txt'), 'utf-8').trim();
    const names = to ? to.split(',').map(s => s.trim()) : null;
    const targets = all ? subs : subs.filter(s => names.includes(s.name));
    if (!targets.length) throw new Error(`nessuna iscrizione con nome ${to}`);
    const url = new URL(arg('url') || '', SITE_URL).href;
    for (const s of targets) {
        const r = await sendWebPush(s, { title, body, url }, key);
        console.log(`${s.name || s.endpoint.slice(0, 40)}: HTTP ${r.status}${r.text ? ' ' + r.text : ''}`);
    }
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
