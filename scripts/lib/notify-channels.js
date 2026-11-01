// scripts/lib/notify-channels.js
//
// Canali di invio condivisi da notify-gp.js (dopo il GP) e notify-pole.js
// (sabato, dopo la qualifica). Stesso messaggio su entrambi:
//   - ntfy: canale nella variabile d'ambiente NTFY_TOPIC (segreto del
//     repository: chi conosce il nome del canale può leggerne i messaggi);
//   - web app sulla schermata Home (Web Push, lib/webpush.js): iscrizioni
//     nel segreto WEBPUSH_SUBSCRIPTIONS (JSON, una o un array, ognuna con un
//     campo "name" facoltativo usato nei log) e chiave privata in
//     VAPID_PRIVATE_KEY.
// Un canale non configurato si salta senza errori.
//
// report = { title, message, click, priority? }

const { sendWebPush } = require('./webpush');

async function sendNtfy(report, topic) {
    // Pubblicazione in JSON (non con le intestazioni HTTP, che non accettano
    // emoji e lettere accentate senza codifiche speciali).
    const res = await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            topic,
            title: report.title,
            message: report.message,
            // Nessun tag: ntfy li mostra come emoji davanti al titolo, che ha
            // già la sua.
            priority: report.priority || 3,
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
        // Nome breve dell'iscrizione (i log sono pubblici: niente cognomi).
        const who = sub.name || `#${i + 1}`;
        const { status, text } = await sendWebPush(sub, { title: report.title, body: report.message, url: report.click }, key);
        if (status >= 200 && status < 300) delivered++;
        else if (status === 404 || status === 410) console.warn(`⚠️  Web app ${who}: iscrizione scaduta (HTTP ${status}), va riattivata dal tasto 🔔 Notifiche del sito.`);
        else console.warn(`⚠️  Web app ${who}: HTTP ${status} ${text}`);
    }
    console.log(`Web app: ${delivered}/${subs.length} notifiche consegnate.`);
    return { configured: true, delivered };
}

// Invia su tutti i canali configurati. Ritorna { configured, delivered }:
// basta un canale andato a buon fine perché la notifica conti come inviata
// (un errore sull'altro resta nel log).
async function sendAll(report) {
    const topic = process.env.NTFY_TOPIC;
    let delivered = 0, configured = false;
    if (topic) {
        configured = true;
        try { await sendNtfy(report, topic); delivered++; console.log('ntfy: notifica inviata.'); }
        catch (err) { console.warn(`⚠️  ntfy: ${err.message}`); }
    } else {
        console.warn('⚠️  NTFY_TOPIC non impostato: ntfy saltato.');
    }
    const web = await sendWebPushAll(report);
    return { configured: configured || web.configured, delivered: delivered + web.delivered };
}

module.exports = { sendAll, sendWebPushAll };
