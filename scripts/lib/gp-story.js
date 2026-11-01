// scripts/lib/gp-story.js
//
// Racconto dell'ultimo GP per la sezione "Statistiche": un breve paragrafo
// scritto da Claude (API di Anthropic) partendo SOLO dai dati del sito
// (pole, griglia, risultati, ritiri, fatti già calcolati, classifica) e dai
// messaggi della direzione gara di OpenF1 (safety car, bandiere rosse,
// penalità: lib/race-control.js). Sopra
// l'elenco dei fatti, che resta comunque: se l'API non risponde o la chiave
// non c'è, il sito mostra solo l'elenco come prima.
//
// Chiave nella variabile d'ambiente ANTHROPIC_API_KEY (segreto del
// repository, account API separato dall'abbonamento a Claude). Il testo si
// rigenera solo quando cambiano i dati passati a Claude (hash dell'input):
// update-stats.yml gira dopo ogni aggiornamento, ma la chiamata si paga solo
// a GP nuovo o con risultati corretti (pochi centesimi a GP).

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

const SYSTEM = `Sei un giornalista di Formula 1 che scrive per un sito italiano di statistiche.
Scrivi un breve racconto del Gran Premio in italiano: un solo paragrafo, 3-4 frasi, al massimo 90 parole, testo semplice senza titoli, elenchi, grassetti o emoji.
Usa SOLO i dati forniti. Non aggiungere nulla che non sia nei dati: niente sorpassi specifici, meteo in gara, dichiarazioni o cause dei ritiri.
Safety car, virtual safety car, bandiere rosse e penalità solo se compaiono in "direzioneGara" (messaggi ufficiali in inglese, con il giro): citali solo se contano per il racconto, senza inventarne cause, dinamiche o conseguenze sulla classifica che i dati non dicono. Se "direzioneGara" è null o vuoto, non parlarne. Non inventare record o confronti con altri anni oltre a quelli già presenti nei fatti.
Riporta nomi, posizioni, tempi e punti esattamente come nei dati. Scrivi i distacchi con la virgola come in italiano (1,525 s). Usa "ad" davanti a parole che iniziano per a (ad Austin, ad Abu Dhabi).
Dai al racconto un filo: chi ha vinto e come, il risultato dell'autore della pole, la cosa più notevole tra i fatti, cosa cambia nel mondiale.`;

const inputHash = input => crypto.createHash('sha256').update(JSON.stringify({ MODEL, SYSTEM, input })).digest('hex').slice(0, 16);

// previous = la storia salvata al giro precedente ({ text, model, hash }).
// Ritorna la storia da salvare, oppure null se non c'è.
async function gpStory(input, previous) {
    const hash = inputHash(input);
    if (previous?.hash === hash && previous.text) return previous;
    if (!process.env.ANTHROPIC_API_KEY) {
        console.log('Racconto del GP: ANTHROPIC_API_KEY non impostata, salto.');
        return null;
    }

    const client = new Anthropic();
    const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        // Se i filtri di sicurezza rifiutano la richiesta (improbabile per un
        // testo sportivo), l'API la ripete su un altro modello.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: `Dati del GP in JSON:\n${JSON.stringify(input, null, 2)}` }],
    });
    if (response.stop_reason === 'refusal') throw new Error(`richiesta rifiutata (${response.stop_details?.category || 'senza categoria'})`);
    if (response.stop_reason === 'max_tokens') throw new Error('risposta troncata');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) throw new Error('risposta vuota');
    console.log(`Racconto del GP: scritto da ${response.model} (${response.usage.input_tokens} token in entrata, ${response.usage.output_tokens} in uscita).`);
    return { text, model: response.model, hash };
}

module.exports = { gpStory };
