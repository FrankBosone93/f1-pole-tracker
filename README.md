# F1 Pole Tracker

## Struttura dei file
- `index.html` — il sito. Carica i dati da `data.json` (fetch). Se `data.json` non è raggiungibile, mostra un messaggio d'errore esplicito invece di dati incorporati nel codice (rimossi: erano solo un fallback statico, mai sincronizzato con `data.json`).
- `data.json` — i dati "ufficiali" delle pole position. È la fonte di verità. Ogni entry ha `year`, `circuit`, `driver`, `team`, `timeStr`, `seconds`, `weather`, e opzionalmente `penaltyNote` (vedi sotto).
- `scripts/lib/f1-mapping.js` — mappature condivise (circuito, team, parsing tempi) usate dagli script sotto.
- `scripts/lib/weather.js` — meteo storico reale via [Open-Meteo](https://open-meteo.com) (gratuito, senza chiave, dati ERA5 dal 1940), usato sia per il backfill che per gli aggiornamenti futuri.
- `scripts/update-poles.js` — gira dopo la qualifica (sabato): scarica l'ultima pole position da f1api.dev, calcola il meteo reale del giorno di qualifica, e aggiorna `data.json`. "Pole" = il più veloce in qualifica, a prescindere da eventuali penalità applicate dopo.
- `scripts/check-pole-penalty.js` — gira dopo la gara (domenica): controlla se il polista è partito davvero P1 in griglia. Se una penalità l'ha retrocesso, aggiunge un `penaltyNote` alla entry (senza cambiare il polista registrato).
- `scripts/verify-data.js` — strumento di controllo manuale (`node scripts/verify-data.js`): ricontrolla TUTTE le stagioni presenti in `data.json` contro l'API reale e segnala discrepanze da rivedere a mano. Non modifica mai `data.json` da solo.
- `scripts/backfill-weather.js` — strumento una tantum (`node scripts/backfill-weather.js`) che ricalcola il meteo di TUTTE le entry storiche usando Open-Meteo. Usato per correggere il meteo originariamente inventato/segnaposto; da rilanciare solo se si vuole ricalcolare tutto lo storico (es. dopo una modifica ai criteri di classificazione).
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
   scripts/backfill-weather.js
   scripts/lib/f1-mapping.js
   scripts/lib/weather.js
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

## Meteo

Il campo `weather` di ogni entry viene da dati meteo storici reali ([Open-Meteo](https://open-meteo.com), basati sulle coordinate del circuito e sulla data di qualifica), non da un placeholder inventato come in origine. La classificazione (`scripts/lib/weather.js`) usa la precipitazione giornaliera in mm per decidere tra sereno/nuvoloso/pioggia/pioggia battente, più un flag "notturno" per i circuiti che corrono tipicamente in notturna (Bahrain, Jeddah, Singapore, Qatar, Abu Dhabi, Las Vegas).

Limiti da tenere presenti:
- È un dato aggregato sull'intera giornata, non sull'ora esatta della sessione — resta una buona approssimazione, non una ricostruzione minuto per minuto.
- Le coordinate dei circuiti in `CIRCUIT_INFO` sono approssimative (posizione del tracciato, non del meteo esatto sul rettilineo).
- Se vuoi rivedere i criteri di classificazione, modifica `describeWeather()` in `scripts/lib/weather.js` e rilancia `node scripts/backfill-weather.js` per ricalcolare tutto lo storico.

## Controllo periodico di tutti i dati

Oltre alle due automazioni sopra (che toccano solo l'ultima gara disputata), c'è uno strumento di controllo manuale che ricontrolla **tutte** le stagioni presenti in `data.json` contro l'API reale, gara per gara:

```
node scripts/verify-data.js
```

Stampa un report delle discrepanze trovate ma **non modifica mai `data.json` da solo** — le correzioni storiche richiedono giudizio umano (es. distinguere un vero errore di battitura da un caso di penalità, o da un doppio GP sullo stesso circuito nello stesso anno). Utile da rilanciare ogni tanto per un controllo generale, non solo settimanale.

⚠️ **Nota**: se l'API restituisce dati con nomi di campo diversi da quelli previsti (circuito non riconosciuto, formato tempo inatteso, ecc.), gli script segnalano chiaramente l'errore nei log invece di scrivere dati sbagliati — controlla i log dell'Action (Actions → click sull'esecuzione → log dello step) in caso di fallimento.

## Aggiornamenti manuali / correzioni

Il sito non ha (più) alcun pannello di inserimento dati lato client: `data.json` nel repository è l'unica fonte di verità, per tutti i visitatori.

Se vuoi correggere un dato a mano: modifica direttamente `data.json` nel repository (anche dall'editor web di GitHub, senza bisogno di git in locale) e salva/commit — il sito lo rifletterà al prossimo caricamento. Richiede le tue credenziali GitHub.
