// build-css.js - genera styles.css, la grafica del sito, con Tailwind
// precompilato. Fino al 2026-11-05 la costruiva il browser a ogni apertura
// (@tailwindcss/browser dal CDN): lavoro in più a ogni visita, soprattutto
// sul telefono, e una versione che Tailwind indica solo per lo sviluppo.
//
// Uso: npm run build:css   (serve npm ci: @tailwindcss/cli è una
// devDependency, con la versione fissata in package-lock.json)
//
// Va lanciato dopo OGNI modifica alle classi in index.html, e styles.css va
// committato insieme a index.html. Il workflow check-css.yml lo rigenera a
// ogni push e fallisce se il risultato non coincide.
//
// Aggiorna anche il ?v= del <link> in index.html con l'impronta del nuovo
// styles.css: così una pagina nuova non usa mai un styles.css vecchio
// rimasto nella cache del browser.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(__dirname, 'tailwind-input.css');
const OUTPUT = path.join(ROOT, 'styles.css');
const HTML = path.join(ROOT, 'index.html');
const LINK = /href="styles\.css\?v=[0-9a-f]*"/;

const cli = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
if (!fs.existsSync(cli)) {
    console.error('Manca @tailwindcss/cli: lanciare prima "npm ci".');
    process.exit(1);
}

const html = fs.readFileSync(HTML, 'utf8');
if (!LINK.test(html)) {
    console.error('In index.html manca <link rel="stylesheet" href="styles.css?v=...">.');
    process.exit(1);
}

execFileSync(cli, ['--input', INPUT, '--output', OUTPUT, '--minify'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });

const hash = crypto.createHash('sha256').update(fs.readFileSync(OUTPUT)).digest('hex').slice(0, 10);
const updated = html.replace(LINK, `href="styles.css?v=${hash}"`);
if (updated !== html) fs.writeFileSync(HTML, updated);
console.log(`styles.css: ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB, v=${hash}${updated !== html ? ' (index.html aggiornato)' : ''}`);
