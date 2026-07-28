// scripts/update-news.js
//
// Scarica le ultime notizie F1 dal feed RSS di FormulaPassion.it (fonte
// scelta esplicitamente dall'utente) e scrive news.json con le 5 più
// recenti. Nessuna chiave richiesta: è un feed RSS pubblico.
//
// Pensato per essere eseguito da una GitHub Action pianificata più volte al
// giorno (vedi .github/workflows/update-news.yml), ma funziona anche a mano:
//   node scripts/update-news.js

const fs = require('fs');
const path = require('path');

const FEED_URL = 'https://www.formulapassion.it/f1/feed';
const NEWS_JSON_PATH = path.join(__dirname, '..', 'news.json');
const ITEM_COUNT = 5;

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
    return res.text();
}

// Decodifica le entity HTML/numeriche più comuni nei feed RSS (es. &#8220;
// per le virgolette tipografiche, &#8217; per l'apostrofo, &#8230; per "…").
// Non serve una libreria: il set di entity usato da WordPress è piccolo e
// stabile.
function decodeEntities(str) {
    return str
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;|&apos;/g, "'");
}

function extractTag(block, tag) {
    const match = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, 's'));
    return match ? decodeEntities(match[1].trim()) : null;
}

function parseItems(xml) {
    const rawItems = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    return rawItems.map(block => ({
        title: extractTag(block, 'title'),
        link: extractTag(block, 'link'),
        date: extractTag(block, 'pubDate'),
        author: extractTag(block, 'dc:creator'),
        excerpt: extractTag(block, 'description'),
        image: extractTag(block, 'image_medium') || extractTag(block, 'image'),
    }));
}

async function main() {
    console.log(`Richiesta a ${FEED_URL} ...`);
    const xml = await fetchText(FEED_URL);
    const items = parseItems(xml).slice(0, ITEM_COUNT);

    if (items.length === 0) {
        throw new Error('Nessun articolo trovato nel feed RSS.');
    }
    if (items.some(i => !i.title || !i.link)) {
        throw new Error('Uno o più articoli senza titolo/link: formato del feed cambiato?');
    }

    const newNews = {
        source: 'FormulaPassion.it',
        updatedAt: new Date().toISOString(),
        items: items.map(i => ({
            title: i.title,
            link: i.link,
            date: i.date ? new Date(i.date).toISOString() : null,
            author: i.author,
            excerpt: i.excerpt,
            image: i.image,
        })),
    };

    let existing = null;
    if (fs.existsSync(NEWS_JSON_PATH)) {
        existing = JSON.parse(fs.readFileSync(NEWS_JSON_PATH, 'utf-8'));
    }
    const isSame = existing && JSON.stringify(existing.items) === JSON.stringify(newNews.items);
    if (isSame) {
        console.log('Nessuna modifica: le news erano già aggiornate.');
        return;
    }

    fs.writeFileSync(NEWS_JSON_PATH, JSON.stringify(newNews, null, 2) + '\n', 'utf-8');
    console.log(`✅ news.json aggiornato (${newNews.items.length} articoli).`);
    newNews.items.forEach(i => console.log(`  - ${i.title}`));
}

main().catch(err => {
    console.error('❌ Errore durante l\'aggiornamento news:', err.message);
    process.exit(1);
});
