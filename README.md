# F1 Pole Tracker

## Struttura dei file
- `index.html` — il sito. Carica i dati da `data.json` (fetch). Se `data.json` non è raggiungibile, mostra un messaggio d'errore esplicito invece di dati incorporati nel codice (rimossi: erano solo un fallback statico, mai sincronizzato con `data.json`).
- `data.json` — i dati "ufficiali" delle pole position. È la fonte di verità. Ogni entry ha `year`, `circuit`, `driver`, `team`, `timeStr`, `seconds`, `weather`, e opzionalmente `penaltyNote` (vedi sotto).
- `scripts/lib/f1-mapping.js` — mappature condivise (circuito, team, parsing tempi) usate dagli script sotto.
- `scripts/update-poles.js` — gira dopo la qualifica (sabato): scarica l'ultima pole position da f1api.dev e aggiorna `data.json`. "Pole" = il più veloce in qualifica, a prescindere da eventuali penalità applicate dopo.
- `scripts/check-pole-penalty.js` — gira dopo la gara (domenica): controlla se il polista è partito davvero P1 in griglia. Se una penalità l'ha retrocesso, aggiunge un `penaltyNote` alla entry (senza cambiare il polista registrato).
- `scripts/verify-data.js` — strumento di controllo manuale (`node scripts/verify-data.js`): ricontrolla TUTTE le stagioni presenti in `data.json` contro l'API reale e segnala discrepanze da rivedere a mano. Non modifica mai `data.json` da solo.
- `.github/workflows/update-poles.yml` — automazione GitHub Actions che esegue `update-poles.js` ogni sabato sera.
- `.github/workflows/check-pole-penalty.yml` — automazione GitHub Actions che esegue `check-pole-penalty.js` ogni domenica sera / lunedì mattina.

## Come pubblicare il sito online (GitHub Pages)

1. Crea un repository su GitHub (es. `f1-pole-tracker`), pubblico o privato (con Pages funziona in entrambi i casi se hai un piano che lo supporta; con repo pubblico è gratuito senza limitazioni).
2. Carica dentro tutti questi file mantenendo la stessa struttura di cartelle:
   ```
   index.html
   data.json
   scripts/update-poles.js
   scripts/check-pole-penalty.js
   scripts/verify-data.js
   scripts/lib/f1-mapping.js
   .github/workflows/update-poles.yml
   .github/workflows/check-pole-penalty.yml
   ```
3. Vai su **Settings → Pages** del repository, e in "Build and deployment" seleziona come source il branch principale (es. `main`), cartella `/ (root)`.
4. Dopo un paio di minuti il sito sarà raggiungibile su `https://<tuo-utente>.github.io/<nome-repo>/`.

## Come funziona l'aggiornamento automatico

Ci sono due automazioni distinte, perché qualifica e gara di un weekend F1 non finiscono mai nello stesso momento:

**1. Dopo la qualifica (sabato)** — `update-poles.yml` esegue `scripts/update-poles.js`, che:
1. Interroga l'API pubblica e gratuita [f1api.dev](https://f1api.dev) per l'ultima qualifica disputata.
2. Estrae pilota, team e tempo del più veloce in qualifica (= la pole, per definizione, a prescindere da eventuali penalità che verranno applicate dopo).
3. Se il dato non è già presente (o è cambiato) in `data.json`, lo aggiorna e fa un commit automatico al repository.

**2. Dopo la gara (domenica)** — `check-pole-penalty.yml` esegue `scripts/check-pole-penalty.js`, che:
1. Interroga l'API per i risultati della gara, che includono la griglia di partenza reale (campo `grid`).
2. Confronta il polista registrato il giorno prima con chi è partito davvero P1.
3. Se sono persone diverse (il polista ha preso una penalità post-qualifica), aggiunge un campo `penaltyNote` alla entry — il polista registrato NON cambia, si aggiunge solo un avviso visibile nel box dei dettagli sul sito.

Puoi lanciare entrambe manualmente in qualsiasi momento da GitHub: **Actions → (nome workflow) → Run workflow**.

## Controllo periodico di tutti i dati

Oltre alle due automazioni sopra (che toccano solo l'ultima gara disputata), c'è uno strumento di controllo manuale che ricontrolla **tutte** le stagioni presenti in `data.json` contro l'API reale, gara per gara:

```
node scripts/verify-data.js
```

Stampa un report delle discrepanze trovate ma **non modifica mai `data.json` da solo** — le correzioni storiche richiedono giudizio umano (es. distinguere un vero errore di battitura da un caso di penalità, o da un doppio GP sullo stesso circuito nello stesso anno). Utile da rilanciare ogni tanto per un controllo generale, non solo settimanale.

⚠️ **Nota**: se l'API restituisce dati con nomi di campo diversi da quelli previsti (circuito non riconosciuto, formato tempo inatteso, ecc.), gli script segnalano chiaramente l'errore nei log invece di scrivere dati sbagliati — controlla i log dell'Action (Actions → click sull'esecuzione → log dello step) in caso di fallimento.

## Aggiornamenti manuali / correzioni

Il pannello "🔧 Aggiornamento Live" nel sito resta disponibile per chiunque lo visiti, ma scrive solo nel **localStorage del browser di chi lo usa** — non modifica mai il `data.json` condiviso. Quindi:
- Ogni visitatore può "giocare" col pannello e vedere modifiche solo nella propria sessione, senza alcun impatto su ciò che vedono gli altri.
- Per aggiornare davvero il sito per tutti, l'unico modo è modificare `data.json` nel repository GitHub (a mano, o lasciando fare all'automazione) — cosa che richiede le tue credenziali GitHub.

Se vuoi correggere un dato a mano: modifica direttamente `data.json` nel repository (anche dall'editor web di GitHub, senza bisogno di git in locale) e salva/commit — il sito lo rifletterà al prossimo caricamento.
