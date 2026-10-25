// scripts/lib/driver-names.js
//
// OpenF1 scrive i nomi dei piloti in modo diverso da f1api.dev e da
// data.json ("Kimi Antonelli" invece di "Andrea Kimi Antonelli",
// "Alexander Albon" invece di "Alex Albon"). Per non avere lo stesso pilota
// con due nomi sul sito, i nomi OpenF1 vengono riportati a quelli già usati,
// abbinandoli per cognome. Usato da update-calendar.js (prove libere) e
// update-poles.js (pole).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const readJson = rel => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8')); } catch (e) { return null; } };

const surnameKey = name => String(name || '').trim().split(/\s+/).pop()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Cognome -> nome completo già usato sul sito (classifica, calendario, pole).
// Un cognome con due nomi diversi (omonimi) viene escluso: meglio il nome
// OpenF1 che un abbinamento sbagliato. Con `only` (elenco di nomi) si usano
// solo quelli: per una stagione passata, i nomi già nel suo file storico.
function knownDriverNames(only = null) {
    const names = new Map(), clash = new Set();
    const add = full => {
        const k = surnameKey(full);
        if (!k) return;
        if (names.has(k) && names.get(k) !== full) clash.add(k);
        names.set(k, full);
    };
    if (only) {
        only.forEach(add);
        clash.forEach(k => names.delete(k));
        return names;
    }
    (readJson('standings.json')?.drivers || []).forEach(d => add(d.driver));
    (readJson('calendar.json')?.races || []).forEach(r => Object.values(r.results || {}).forEach(rows => (rows || []).forEach(x => add(x.driver))));
    const year = new Date().getFullYear();
    (readJson('data.json') || []).filter(d => d.year >= year - 1).forEach(d => add(d.driver));
    clash.forEach(k => names.delete(k));
    return names;
}

// Nome da mostrare per un pilota OpenF1 (oggetto di /drivers).
function siteDriverName(openf1Driver, names) {
    const own = [openf1Driver?.first_name, openf1Driver?.last_name].filter(Boolean).join(' ');
    return names.get(surnameKey(openf1Driver?.last_name || own)) || own;
}

module.exports = { surnameKey, knownDriverNames, siteDriverName };
