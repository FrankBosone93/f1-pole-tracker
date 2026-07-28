# F1 Pole Tracker

## Struttura dei file
- `index.html` — il sito. Carica i dati da `data.json` (fetch). Se `data.json` non è raggiungibile, mostra un messaggio d'errore esplicito invece di dati incorporati nel codice (rimossi: erano solo un fallback statico, mai sincronizzato con `data.json`). Sotto il titolo, un indicatore mostra lo stato di salute delle automazioni (vedi sezione dedicata più sotto): 🟢 "Dati aggiornati al [giorno] alle [ora]. API correttamente funzionanti." se tutte le automazioni hanno girato con successo, oppure 🔴 con il nome di quella in errore. Include anche il widget "Prossimo GP" (sempre visibile, in alto a destra su desktop, allineato in larghezza ai riquadri di "Dettagli Qualifiche" / sotto i pulsanti Classifica-Calendario su mobile): orari di tutte le sessioni del weekend in ora italiana, con indicatore live per la sessione in corso. Resta sul weekend corrente/prossimo fino alla domenica di gara, poi passa al successivo da lunedì. Sia nel widget che nel pannello "Calendario", ogni sessione già disputata mostra "Risultati" (bianco, cliccabile) al posto della data: espande la classifica completa di quella sessione (posizione, pilota, scuderia, tempo/distacco), letta da `calendar.json`. Il grafico principale ha un tasto "🏎️ Telemetria" (visibile solo se il circuito scelto ha dati in `telemetry.json`) che sostituisce il grafico con 3 pannelli — velocità, acceleratore/freno, marcia — del giro di pole in qualifica, letti da OpenF1. In vista telemetria, se il circuito ha dati anche per la stagione 2025, compare un secondo tasto "🆚 2025" che sovrappone il giro di pole 2025 su quello 2026 nei pannelli velocità e marcia (acceleratore/freno resta solo 2026, per non affollare il grafico con 4 tracce), colorati diversamente (rosso 2026, blu tratteggiato 2025) con didascalia che mostra entrambi i piloti e tempi. Quarto pannello "📰 News" (accanto a Classifica/Calendario/Stagioni precedenti, stesso stile e mutua esclusività): le ultime 5 notizie F1 da FormulaPassion.it, lette da `news.json`.
- `data.json` — i dati "ufficiali" delle pole position. È la fonte di verità. Ogni entry ha `year`, `circuit`, `driver`, `team`, `timeStr`, `seconds`, `weather`, e opzionalmente `penaltyNote` (vedi sotto).
- `standings.json` — classifica REALE del campionato piloti e costruttori della stagione in corso (posizione, punti, vittorie), mostrata nel pannello "Classifica" del sito.
- `calendar.json` — calendario della stagione IN CORSO (rilevata automaticamente, quindi passa da sola alla stagione successiva ogni anno), con il vincitore di ogni gara già disputata, la data di inizio weekend (`weekendStart`, prove libere del venerdì), l'orario UTC di ogni sessione (`schedule`: fp1/fp2/fp3/sprintQualy/sprintRace/qualy/race) e, per le sessioni già disputate, i risultati completi (`results`: fp1/fp2/fp3/qualy/race, ognuno un array di `{position, driver, team, time}` o `null` se non ancora disponibili — niente risultati sprint, l'API non li espone). Usato per il pannello "Calendario & Risultati", che mostra anche l'intervallo di date del weekend (es. "6-8 Marzo") e, cliccando su una gara, gli orari di tutte le sessioni convertiti in ora italiana (cambio CET/CEST gestito automaticamente) con "Risultati" al posto della data per le sessioni già disputate; e per decidere quale circuito mostrare di default all'apertura del sito (l'ultimo GP disputato, oppure quello del weekend in corso se le prove libere sono già iniziate).
- `history/{anno}.json` (2021-2025) — stesso formato di `calendar.json`, ma per una stagione PASSATA e SOLO con qualifiche e gara (niente prove libere né sprint, a differenza della stagione in corso): non cambia più una volta scritto, quindi non è schedulato/aggiornato dai workflow automatici. Scaricato da `scripts/build-history.js` e usato dal pannello "Stagioni precedenti" del sito, che carica un anno solo al primo click su quell'anno (non tutti insieme).
- `telemetry.json` — telemetria (velocità, acceleratore, freno, marcia) del giro di pole in qualifica di ogni GP 2025 e 2026 già disputato, da [OpenF1](https://openf1.org) (API pubblica diversa da f1api.dev, usata solo per questa funzione). Solo qualifiche (niente prove libere, sprint o gara). Formato multi-stagione: `{updatedAt, seasons: {"2025": {circuits: {...}}, "2026": {circuits: {...}}}}`. Scaricato da `scripts/build-telemetry.js`, usato dai tasti "🏎️ Telemetria" e "🆚 2025" del grafico principale.
- `news.json` — le ultime 5 notizie F1 (titolo, link, data, autore, immagine) dal feed RSS di [FormulaPassion.it](https://www.formulapassion.it/f1/feed) (fonte scelta esplicitamente, nessuna chiave richiesta). Scaricato da `scripts/update-news.js`, mostrato nel pannello "📰 News".
- `status/{poles,penalty,standings,calendar,telemetry}.json` — un file per automazione (il feed news escluso di proposito), scritto da `scripts/lib/status.js` ad ogni esecuzione del rispettivo script, successo o errore: `{ok, lastRun, error}`. Il sito li combina nell'indicatore in alto (vedi sezione dedicata).
- `scripts/lib/f1-mapping.js` — mappature condivise (circuito, team, parsing tempi) usate dagli script sotto.
- `scripts/lib/session-results.js` — normalizzazione dei risultati di sessione (prove libere, qualifiche, gara) dal formato f1api.dev al formato del sito. Condivisa tra `update-calendar.js` e `build-history.js`.
- `scripts/lib/weather.js` — meteo storico reale via [Open-Meteo](https://open-meteo.com) (gratuito, senza chiave, dati ERA5 dal 1940), usato sia per il backfill che per gli aggiornamenti futuri.
- `scripts/lib/status.js` — scrive `status/{key}.json` per l'automazione corrente (successo o errore), ad ogni esecuzione. Usata da tutti gli script tranne `update-news.js` (vedi sezione "Indicatore di stato API").
- `scripts/update-poles.js` — gira dopo la qualifica (sabato): scarica l'ultima pole position da f1api.dev, calcola il meteo reale del giorno di qualifica, e aggiorna `data.json`. "Pole" = il più veloce in qualifica, a prescindere da eventuali penalità applicate dopo.
- `scripts/check-pole-penalty.js` — gira dopo la gara (domenica): controlla se il polista è partito davvero P1 in griglia. Se una penalità l'ha retrocesso, aggiunge un `penaltyNote` alla entry (senza cambiare il polista registrato).
- `scripts/update-standings.js` — gira dopo la gara (domenica): scarica la classifica piloti/costruttori aggiornata da f1api.dev e aggiorna `standings.json`.
- `scripts/update-calendar.js` — gira dopo la gara (domenica): scarica il calendario della stagione in corso con i vincitori e i risultati completi di prove libere/qualifiche/gara delle sessioni già disputate, e aggiorna `calendar.json`. I risultati già scaricati in run precedenti vengono riusati (non ridownload ogni volta), quindi ogni run fa solo le richieste per le sessioni nuove.
- `scripts/verify-data.js` — strumento di controllo manuale (`node scripts/verify-data.js`): ricontrolla TUTTE le stagioni presenti in `data.json` contro l'API reale e segnala discrepanze da rivedere a mano. Non modifica mai `data.json` da solo.
- `scripts/backfill-weather.js` — strumento una tantum (`node scripts/backfill-weather.js`) che ricalcola il meteo di TUTTE le entry storiche usando Open-Meteo. Usato per correggere il meteo originariamente inventato/segnaposto; da rilanciare solo se si vuole ricalcolare tutto lo storico (es. dopo una modifica ai criteri di classificazione).
- `scripts/build-history.js` — strumento una tantum (`node scripts/build-history.js [anno...]`) che scarica calendario, vincitori e risultati di qualifiche e gara (solo queste due sessioni, su richiesta esplicita) di una o più stagioni PASSATE e scrive `history/{anno}.json`. Le gare di una stagione vengono processate in parallelo (l'API è lenta, farlo in sequenza richiederebbe ore) con scrittura incrementale, quindi un'interruzione a metà non fa perdere le gare già scaricate. Se `history/{anno}.json` esiste già viene saltato; cancellarlo per rigenerare quell'anno.
- `scripts/build-telemetry.js` — gira dopo la qualifica (sabato, via `update-telemetry.yml`), ma è anche uno strumento richiamabile a mano (`node scripts/build-telemetry.js` per 2025+2026, `node scripts/build-telemetry.js 2026` per una sola stagione): scarica da OpenF1 la telemetria del giro di pole in qualifica di ogni GP già disputato delle stagioni 2025 e 2026, e scrive `telemetry.json`. Il giro di pole viene identificato incrociando il pilota poleman reale da `data.json` (non il giro più veloce in assoluto: quest'ultimo può essere stato cancellato per track limits, promuovendo un giro più lento a pole — successo davvero all'Ungheria 2025) e prendendo il suo giro più veloce valido. Scrittura incrementale (una stagione/circuito alla volta) e retry con backoff sui 429 di OpenF1, così un'interruzione a metà non fa perdere i circuiti già scaricati; già scaricati vengono saltati, quindi ogni run fa solo le richieste per i round nuovi.
- `scripts/update-news.js` — gira ogni 4 ore (via `update-news.yml`), ma è anche richiamabile a mano (`node scripts/update-news.js`): scarica il feed RSS di FormulaPassion.it (solo categoria F1), prende i 5 articoli più recenti e scrive `news.json`. Nessuna libreria di parsing XML: il feed RSS ha una struttura semplice, estratta con regex e con decodifica delle entity HTML/numeriche più comuni.
- `.github/workflows/update-poles.yml` — automazione GitHub Actions che esegue `update-poles.js` ogni sabato sera.
- `.github/workflows/update-telemetry.yml` — automazione GitHub Actions che esegue `build-telemetry.js` ogni sabato sera (stesso orario di `update-poles.yml`, essendo la telemetria dello stesso giro di pole).
- `.github/workflows/check-pole-penalty.yml` — automazione GitHub Actions che esegue `check-pole-penalty.js` ogni domenica sera / lunedì mattina.
- `.github/workflows/update-standings.yml` — automazione GitHub Actions che esegue `update-standings.js` ogni domenica sera / lunedì mattina.
- `.github/workflows/update-calendar.yml` — automazione GitHub Actions che esegue `update-calendar.js` ogni domenica sera / lunedì mattina.
- `.github/workflows/update-news.yml` — automazione GitHub Actions che esegue `update-news.js` ogni 4 ore.
- `.github/workflows/update-all.yml` — solo manuale (nessuno schedule proprio): esegue in sequenza tutti e sei gli script sopra in un unico run, per aggiornare tutto con un solo "Run workflow" invece di lanciarli uno alla volta. È il workflow a cui punta il tasto "🔄 Full Update" del sito.

## Come pubblicare il sito online (GitHub Pages)

1. Crea un repository su GitHub (es. `f1-pole-tracker`), pubblico o privato (con Pages funziona in entrambi i casi se hai un piano che lo supporta; con repo pubblico è gratuito senza limitazioni).
2. Carica dentro tutti questi file mantenendo la stessa struttura di cartelle:
   ```
   index.html
   data.json
   standings.json
   calendar.json
   history/2021.json ... history/2025.json
   telemetry.json
   news.json
   status/poles.json
   status/penalty.json
   status/standings.json
   status/calendar.json
   status/telemetry.json
   scripts/update-poles.js
   scripts/check-pole-penalty.js
   scripts/update-standings.js
   scripts/update-calendar.js
   scripts/verify-data.js
   scripts/backfill-weather.js
   scripts/build-history.js
   scripts/build-telemetry.js
   scripts/update-news.js
   scripts/lib/f1-mapping.js
   scripts/lib/weather.js
   scripts/lib/session-results.js
   scripts/lib/status.js
   .github/workflows/update-poles.yml
   .github/workflows/update-telemetry.yml
   .github/workflows/check-pole-penalty.yml
   .github/workflows/update-standings.yml
   .github/workflows/update-calendar.yml
   .github/workflows/update-news.yml
   .github/workflows/update-all.yml
   ```
3. Vai su **Settings → Pages** del repository, e in "Build and deployment" seleziona come source il branch principale (es. `main`), cartella `/ (root)`.
4. Dopo un paio di minuti il sito sarà raggiungibile su `https://<tuo-utente>.github.io/<nome-repo>/`.

## Come funziona l'aggiornamento automatico

Ci sono tre momenti distinti, perché qualifica e gara di un weekend F1 non finiscono mai nello stesso momento, e le news escono in continuazione:

**1. Dopo la qualifica (sabato)** — girano due workflow, allo stesso orario:
- `update-poles.yml` esegue `scripts/update-poles.js`:
  1. Interroga l'API pubblica e gratuita [f1api.dev](https://f1api.dev) per l'ultima qualifica disputata.
  2. Estrae pilota, team e tempo del più veloce in qualifica (= la pole, per definizione, a prescindere da eventuali penalità che verranno applicate dopo).
  3. Se il dato non è già presente (o è cambiato) in `data.json`, lo aggiorna e fa un commit automatico al repository.
- `update-telemetry.yml` esegue `scripts/build-telemetry.js`: scarica da OpenF1 la telemetria del giro di pole appena disputato e aggiorna `telemetry.json` (vedi sopra).

**2. Dopo la gara (domenica)** — girano tre workflow separati, tutti sullo stesso orario:
- `check-pole-penalty.yml` esegue `scripts/check-pole-penalty.js`: interroga l'API per i risultati di gara (che includono la griglia di partenza reale, campo `grid`), confronta il polista registrato con chi è partito davvero P1, e se sono persone diverse (penalità post-qualifica) aggiunge un `penaltyNote` alla entry — il polista registrato NON cambia.
- `update-standings.yml` esegue `scripts/update-standings.js`: scarica la classifica piloti e costruttori aggiornata e la scrive in `standings.json`, mostrata nel pannello "🏆 Classifica" del sito.
- `update-calendar.yml` esegue `scripts/update-calendar.js`: scarica il calendario della stagione in corso (rilevata automaticamente tramite `/api/current`, quindi non serve aggiornare l'anno a mano ogni stagione) con il vincitore di ogni gara già disputata, e lo scrive in `calendar.json`, mostrato nel pannello "📅 Calendario" del sito.

**3. Continuamente (ogni 4 ore)** — `update-news.yml` esegue `scripts/update-news.js`: scarica il feed RSS di FormulaPassion.it e aggiorna `news.json` con gli ultimi 5 articoli, mostrati nel pannello "📰 News".

Puoi lanciare ciascuno manualmente in qualsiasi momento da GitHub: **Actions → (nome workflow) → Run workflow**.

Per lanciarli tutti e sei insieme senza ripetere l'operazione volta per volta, c'è un settimo workflow, `update-all.yml` ("Aggiorna tutto"), **solo manuale** (nessuno schedule proprio): esegue gli stessi sei script in sequenza in un unico run. È anche il workflow a cui punta il tasto "🔄 Full Update" in fondo al sito.

## Indicatore di stato API

Il sito non chiama mai direttamente le API esterne (f1api.dev, OpenF1, Open-Meteo): è statico, quindi può solo riflettere l'esito dell'ultima volta che un nostro script le ha interrogate. Ognuno dei 5 script legati alle pole/classifica/calendario/telemetria (`update-poles.js`, `check-pole-penalty.js`, `update-standings.js`, `update-calendar.js`, `build-telemetry.js` — **non** `update-news.js`, escluso di proposito) scrive, tramite `scripts/lib/status.js`, un proprio file `status/{key}.json` ad ogni esecuzione:
```json
{ "ok": true, "lastRun": "2026-07-28T18:23:11.979Z", "error": null }
```
`ok:true` significa "lo script ha girato e l'API ha risposto correttamente", non "c'erano dati nuovi": anche un run che non trova nulla da aggiornare scrive `ok:true` con `lastRun` aggiornato, per non generare falsi allarmi nei periodi senza gare.

Un file per automazione (mai uno condiviso) evita che due workflow schedulati alla stessa ora (es. `update-poles.yml` e `update-telemetry.yml`, stesso cron) rischino di scontrarsi al push su git.

Il sito scarica i 5 file all'avvio e li combina in un solo indicatore sotto il titolo:
- 🟢 se tutti `ok:true` → "Dati aggiornati al [giorno] alle [ora]. API correttamente funzionanti." (l'orario mostrato è il più vecchio tra i 5 `lastRun`: il momento fino al quale TUTTE le automazioni sono confermate funzionanti).
- 🔴 se anche solo una è `ok:false` → mostra quale, col messaggio d'errore nel tooltip.

Ogni workflow schedulato usa `continue-on-error` sullo step dello script e committa comunque il file di stato (con `ok:false` se lo script è fallito) prima di far fallire esplicitamente il run — altrimenti, in caso di errore, lo step del commit non verrebbe mai raggiunto e il sito non saprebbe mai che quell'automazione è KO.

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

In fondo alla colonna "Dettagli Qualifiche" (sotto l'ultima card, sia su mobile che su desktop) c'è un tasto **🔄 Full Update** ("Aggiornamento Dati completo") che apre la pagina del workflow combinato `update-all.yml` su GitHub Actions, pronta per il "Run workflow": un solo click da lì aggiorna pole position, penalità, classifica, calendario, telemetria e news in sequenza, senza aspettare l'orario schedulato. Il sito è statico (GitHub Pages, nessun backend): il tasto è solo un collegamento diretto alla pagina Actions, non lancia nulla automaticamente — non contiene (e non potrebbe contenere in sicurezza) alcun token GitHub.
