// scripts/lib/live-site.js
//
// Il sito online ha già un certo dato? Le notifiche partono appena i dati
// sono salvati nel repository, ma GitHub Pages li pubblica circa un minuto
// dopo: chi toccava subito la notifica apriva il sito ancora con i dati di
// prima (l'8 novembre 2026 la notifica del GP è partita 16 secondi prima che
// le statistiche con il racconto fossero salvate). Dal 2026-11-10 le
// notifiche aspettano che il sito online abbia il dato che annunciano.
// Usato da notify-gp.js, notify-pole.js e notify-season.js.

const SITE_URL = 'https://frankbosone93.github.io/f1-pole-tracker/';
// Un controllo ogni 15 secondi, per 4 minuti al massimo.
const POLL_MS = 15000;
const POLL_MAX = 16;

// Un file JSON del sito online, o null se non è raggiungibile. Indirizzo con
// un numero sempre diverso: altrimenti GitHub Pages può rispondere con la
// copia che tiene in cache per 10 minuti.
async function liveJson(file) {
    try {
        const res = await fetch(`${SITE_URL}${file}?t=${Date.now()}`, { cache: 'no-store' });
        return res.ok ? await res.json() : null;
    } catch (err) {
        return null;
    }
}

// Aspetta che il file online soddisfi isReady (che riceve il JSON, o null).
// what = cosa si aspetta, per il log (es. "le statistiche di questo GP").
// true se il sito online è aggiornato, false se dopo 4 minuti non lo è
// ancora: chi chiama invia comunque la notifica, il sito arriverà a momenti.
async function waitForLive(file, isReady, what) {
    for (let attempt = 1; ; attempt++) {
        if (isReady(await liveJson(file))) return true;
        if (attempt >= POLL_MAX) return false;
        if (attempt === 1) console.log(`Il sito online non ha ancora ${what}: aspetto la pubblicazione (4 minuti al massimo)...`);
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

module.exports = { liveJson, waitForLive };
