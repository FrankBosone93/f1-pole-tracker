# F1 Pole Tracker

## Struttura dei file
- `index.html` — il sito. Carica i dati da `data.json` (fetch). Se `data.json` non è raggiungibile, mostra un messaggio d'errore esplicito invece di dati incorporati nel codice (rimossi: erano solo un fallback statico, mai sincronizzato con `data.json`). Sotto il titolo, un indicatore mostra lo stato di salute delle automazioni (vedi sezione dedicata più sotto): 🟢 "Dati aggiornati al [giorno] alle [ora]. API correttamente funzionanti." se tutte le automazioni hanno girato con successo, oppure 🔴 con il nome di quella in errore. Include anche il widget "Prossimo GP" (sempre visibile, in alto a destra su desktop, allineato in larghezza ai riquadri di "Dettagli Qualifiche" / sotto i pulsanti Classifica-Calendario su mobile): orari di tutte le sessioni del weekend in ora italiana, con indicatore live per la sessione in corso. Accanto alla data del weekend, un countdown (giorni/ore/minuti) fino all'orario esatto di partenza della gara, calcolato da `race.schedule.race` (UTC); scompare da solo una volta che la gara è iniziata, e si aggiorna ogni minuto insieme al resto del widget. Resta sul weekend corrente/prossimo fino alla domenica di gara, poi passa al successivo da lunedì. Sia nel widget che nel pannello "Calendario", ogni sessione già disputata mostra "Risultati" (bianco, cliccabile) al posto della data: espande la classifica completa di quella sessione (posizione, pilota, scuderia, tempo/distacco), letta da `calendar.json`. Il grafico principale ha un tasto "🏎️ Telemetria" (visibile se il circuito scelto ha dati in `telemetry.json`; di default si apre sulla stagione più recente con dati per quel circuito, calcolata dai dati e non scritta a mano) che sostituisce il grafico con 3 pannelli — velocità, acceleratore/freno, marcia — del giro di pole in qualifica, letti da OpenF1. In vista telemetria, se il circuito ha dati anche per almeno un'altra stagione (2023-2025), compare un select "vs..." con una voce per ogni altra stagione disponibile: sceglierne una sovrappone quel giro di pole alla stagione principale nei pannelli velocità e marcia (acceleratore/freno resta solo sulla principale, per non affollare il grafico con 4 tracce), colorati diversamente (rosso = principale, blu tratteggiato = confronto) con didascalia che mostra entrambi i piloti e tempi. La scelta resta valida cambiando circuito, finché quella stagione ha dati anche per il nuovo circuito. Cliccando su un box "Anno YYYY" in "Dettagli Qualifiche" che ha telemetria disponibile (segnalato da "🏎️ Clicca per la telemetria" in fondo al box) si apre direttamente la vista Telemetria con QUELL'anno come principale — utile per rivedere il giro di pole di una stagione passata. I box degli anni coinvolti nel grafico Telemetria restano evidenziati con lo stesso stile delle rispettive tracce - bordo pieno rosso per l'anno principale, bordo tratteggiato blu per l'anno di confronto (se scelto) - per essere sempre chiaro quali due anni si stanno guardando/confrontando. Cambiando circuito dal menu a tendina la stagione principale torna al default (la più recente con dati). Gli anni nel titolo della pagina e nel sottotitolo "Qualifiche & Passo Gara 2021-…" vengono dai dati delle pole: l'ultimo anno si aggiorna da solo. Quarto pannello "📰 News" (accanto a Classifica/Calendario/Stagioni precedenti, stesso stile e mutua esclusività): le ultime 5 notizie F1 da FormulaPassion.it, lette da `news.json`.
- `manifest.json` — web app manifest per installare il sito come PWA (icona, nome, colori, modalità a schermo intero) su iOS/Android tramite "Aggiungi a Home" — vedi sezione dedicata più sotto.
- `sw.js` — service worker minimo, usato solo per abilitare l'installazione PWA e dare una resilienza offline di base. Strategia sempre "network-first, mai cache-first": la cache scatta solo come ripiego quando la rete non risponde, mai come prima scelta mentre si è online, per non compromettere la freschezza di `data.json`/`calendar.json`/ecc. Mette in cache solo risposte valide (200) dello stesso sito (non le librerie da CDN né gli errori), ignorando i parametri di query nella chiave.
- `icons/` — icone dell'app ("P1" in Helvetica Neue Light, rosso su sfondo scuro, coerente con i colori del sito): `icon-192.png`/`icon-512.png` generiche, `icon-512-maskable.png` per le icone adattive Android, `apple-touch-icon.png` per iOS, `favicon-32.png` per la scheda del browser. Generate da uno script Python una tantum (non nel repo, solo le immagini finali).
- `data.json` — i dati "ufficiali" delle pole position. È la fonte di verità. Ogni entry ha `year`, `circuit`, `driver`, `team`, `timeStr`, `seconds`, `weather`, e opzionalmente `penaltyNote` (vedi sotto).
- `standings.json` — classifica REALE del campionato piloti e costruttori della stagione in corso (posizione, punti, vittorie), mostrata nel pannello "Classifica" del sito.
- `calendar.json` — calendario della stagione IN CORSO (rilevata automaticamente, quindi passa da sola alla stagione successiva ogni anno), con il vincitore di ogni gara già disputata, la data di inizio weekend (`weekendStart`, prove libere del venerdì), l'orario UTC di ogni sessione (`schedule`: fp1/fp2/fp3/sprintQualy/sprintRace/qualy/race) e, per le sessioni già disputate, i risultati completi (`results`: fp1/fp2/fp3/qualy/race, ognuno un array di `{position, driver, team, time}` o `null` se non ancora disponibili — niente risultati sprint, l'API non li espone). I risultati delle prove libere (fp1/fp2/fp3) vengono scaricati e conservati SOLO per il GP in evidenza (l'ultimo disputato/in corso, la stessa gara del widget "Prossimo GP"): per le gare precedenti `update-calendar.js` li scarta anche se già in cache da un run precedente, così il file si alleggerisce da solo non appena un GP passa il turno. Usato per il pannello "Calendario & Risultati", che mostra anche l'intervallo di date del weekend (es. "6-8 Marzo") e, cliccando su una gara, gli orari di tutte le sessioni convertiti in ora italiana (cambio CET/CEST gestito automaticamente) con "Risultati" al posto della data per le sessioni già disputate; le prove libere vengono mostrate solo per il GP in evidenza (coerentemente con i dati disponibili), nascoste per tutte le altre gare della stagione; e per decidere quale circuito mostrare di default all'apertura del sito (l'ultimo GP disputato, oppure quello del weekend in corso se le prove libere sono già iniziate).
- `history/{anno}.json` (2021-2025, cresce da solo di un anno ogni fine mondiale) — stesso formato di `calendar.json`, ma per una stagione PASSATA e SOLO con qualifiche e gara (niente prove libere né sprint, a differenza della stagione in corso): non cambia più una volta scritto. Scaricato da `scripts/build-history.js` e usato dal pannello "Stagioni precedenti" del sito, che carica un anno solo al primo click su quell'anno (non tutti insieme).
- `history/index.json` — manifest con l'elenco degli anni disponibili (`{"years": [2025, 2024, ...]}`), letto dal sito per popolare l'elenco cliccabile del pannello "Stagioni precedenti": niente più elenco fisso da aggiornare a mano, si aggiorna da solo quando `scripts/archive-finished-season.js` archivia una nuova stagione conclusa.
- `telemetry.json` — telemetria (velocità, acceleratore, freno, marcia) del giro di pole in qualifica di ogni GP dal 2023 in poi già disputato, da [OpenF1](https://openf1.org) (API pubblica diversa da f1api.dev, usata solo per questa funzione). Solo qualifiche (niente prove libere, sprint o gara). Formato multi-stagione: `{updatedAt, seasons: {"2023": {...}, "2024": {...}, "2025": {...}, "2026": {...}}}`. **2021 e 2022 non sono ottenibili**: OpenF1 non ha alcun dato (nemmeno i metadati di sessione) per quei due anni — lacuna strutturale e permanente della fonte, non un gap da colmare in futuro. Acceleratore e freno sono percentuali 0-100: OpenF1 restituisce a volte `104` (valore fuori scala, dato non valido; visto su Monza/Suzuka/Shanghai 2026 e Las Vegas 2023-24), che viene scartato e salvato come `null` (buco nel grafico invece di acceleratore e freno a 100% insieme). Quando acceleratore e freno sono entrambi non validi la telemetria dell'auto si è interrotta alla fonte (velocità e marcia restano congelate all'ultimo valore, es. Monza 2026 tra 27,2 e 30,8 s, Suzuka 2026 per ~27 s): in quei campioni anche velocità e marcia diventano `null`, i tre grafici mostrano lo stesso buco e sopra il grafico compare un avviso ⚠️ con i secondi mancanti. Non c'è un dato corretto da recuperare (OpenF1 lo restituisce così), quindi non si interpola. Scaricato da `scripts/build-telemetry.js`, che scarica solo le sessioni con una pole in `data.json` (le gare annullate, che OpenF1 elenca comunque, si saltano senza richieste) e sceglie il giro del pilota giusto con durata entro 0,1 s dal tempo di `data.json`; se nessun giro combacia salta il circuito con un avviso invece di ripiegare sul giro più veloce della sessione (si rischiava un giro di Q1/Q2). Baku 2025 è nell'elenco `KNOWN_UNAVAILABLE` perché OpenF1 non ha i suoi giri. Usato dal tasto "🏎️ Telemetria" e dal select "vs..." del grafico principale. Sotto i tre grafici ci sono quattro riquadri: a riposo velocità minima, velocità massima, % del giro a gas pieno e secondi in frenata (medie pesate sul tempo, solo sui tratti con dati validi); passando col mouse o col dito sui grafici mostrano velocità, marcia, acceleratore e freno nel punto indicato, con il secondo del giro, e tornano al riepilogo uscendo o alzando il dito. Il freno è "Premuto/Rilasciato" perché OpenF1 lo registra solo come 0 o 100%. In confronto rosso = giro principale e blu = giro di confronto, allineati per tempo come i grafici. Sotto i riquadri c'è la **mappa del tracciato**, disegnata con le posizioni reali dell'auto durante il giro di pole (OpenF1 `/location`, ~4 al secondo): passando sui grafici un puntino rosso (e blu per l'anno di confronto) scorre sulla mappa nel punto esatto di quell'istante, interpolato tra due posizioni consecutive; un punto bianco segna l'inizio del giro. Funziona anche al contrario: scorrendo col mouse o col dito sul tracciato (sul telefono, se il tocco parte sulla pista la pagina resta ferma; da una zona vuota della mappa scorre normalmente), il punto più vicino della pista (entro un piccolo margine) dà il secondo del giro, e riquadri e puntini mostrano quell'istante (sui grafici solo la linea verticale, senza tooltip: i valori sono già nei riquadri). Una linea verticale segna lo stesso istante su tutti e tre i grafici, sia scorrendo su un grafico sia sulla mappa. La mappa è orientata come nelle grafiche ufficiali F1 del live timing e mostra i numeri delle curve: rotazione e posizione delle curve vengono dall'API pubblica di [MultiViewer](https://multiviewer.app) (`api.multiviewer.app/api/v1/circuits/{circuit_key}/{anno}`, stesse coordinate di OpenF1), scaricate una volta per circuito e anno e salvate nel file del tracciato, così il sito non dipende da MultiViewer mentre lo si consulta (rotazione applicata con la formula di f1-dash: angolo + 90°, assi scambiati). I tracciati sono in `tracks/{anno}/{circuito}.json` (`{rotation, corners: [[curva, x, y, angolo], ...], points: [[t, x, y], ...]}`, un file per giro, ~3 KB compressi, caricato solo quando serve), scaricati da `build-telemetry.js` insieme alla telemetria (per i giri già in archivio vengono recuperati senza riscaricare la telemetria, e ai file senza orientamento vengono aggiunti rotazione e curve). Madrid e Sepang 2026 non sono ancora su MultiViewer: restano con il nord in alto e senza numeri delle curve, e ogni run riprova (una richiesta per circuito).
- `news.json` — le ultime 5 notizie F1 (titolo, link, data, autore, immagine) dal feed RSS di [FormulaPassion.it](https://www.formulapassion.it/f1/feed) (fonte scelta esplicitamente, nessuna chiave richiesta). Scaricato da `scripts/update-news.js`, mostrato nel pannello "📰 News".
- `status/{poles,penalty,standings,calendar,history,telemetry,pace}.json` — un file per automazione (il feed news escluso di proposito), scritto da `scripts/lib/status.js` ad ogni esecuzione del rispettivo script, successo o errore: `{ok, lastRun, error}`. Il sito li combina nell'indicatore in alto (vedi sezione dedicata).
- `scripts/lib/f1-mapping.js` — mappature condivise (circuito, team, parsing tempi) usate dagli script sotto.
- `auto-circuits.json` — circuiti nuovi riconosciuti in automatico (vedi "Circuiti nuovi" più sotto); il file nasce solo quando serve.
- `scripts/lib/session-results.js` — normalizzazione dei risultati di sessione (prove libere, qualifiche, gara) dal formato f1api.dev al formato del sito. Condivisa tra `update-calendar.js` e `build-history.js`.
- `scripts/lib/weather.js` — meteo storico reale via [Open-Meteo](https://open-meteo.com) (gratuito, senza chiave, dati ERA5 dal 1940), usato sia per il backfill che per gli aggiornamenti futuri.
- `scripts/lib/http.js` — `fetchJson` (con `allow404`, ritentativi su errori di rete e backoff automatico sui 429), `HttpError` e `sleep`, condivisi da tutti gli script (prima copiati, con piccole varianti, in 8 file).
- `scripts/lib/status.js` — scrive `status/{key}.json` per l'automazione corrente (successo o errore), ad ogni esecuzione. Usata da tutti gli script tranne `update-news.js` (vedi sezione "Indicatore di stato API").
- `scripts/lib/push-with-retry.sh` — usata da ogni workflow (non da script Node, è bash) per il commit finale: se il `git push` viene respinto perché un altro workflow ha già pushato nello stesso momento (i cron di GitHub Actions possono ritardare molto e far scattare workflow diversi quasi in contemporanea - successo davvero in produzione), si riallinea da sola (fetch + rebase) e riprova fino a 5 volte invece di far fallire il run.
- `scripts/update-poles.js` — gira dopo la qualifica (sabato, più run di recupero domenica e lunedì mattina): scarica da f1api.dev la pole di ogni qualifica già disputata e non ancora in `data.json` (non solo l'ultima, così una pole persa per un 404 temporaneo dell'API o un run saltato viene recuperata al giro dopo; un 404 nelle 72 ore successive alla qualifica non è considerato errore), calcola il meteo reale del giorno di qualifica, e aggiorna `data.json`. "Pole" = il più veloce in qualifica, a prescindere da eventuali penalità applicate dopo.
- `scripts/check-pole-penalty.js` — gira dopo la gara (domenica): controlla, per le ultime 3 gare disputate (per round esplicito, non via `current/last/race`, instabile; un 404 entro 72 ore dalla gara non è errore), se il polista è partito davvero P1 in griglia. Se una penalità l'ha retrocesso, aggiunge un `penaltyNote` alla entry (senza cambiare il polista registrato).
- `scripts/update-standings.js` — gira dopo la gara (domenica): scarica la classifica piloti/costruttori aggiornata da f1api.dev e aggiorna `standings.json`.
- `scripts/update-calendar.js` — (orari delle sessioni presi da OpenF1, che li legge dal feed ufficiale F1 e segue anche i cambi dell'ultimo minuto: f1api.dev ha a volte orari sbagliati o vecchi, es. Austin 2026 con la gara alle 20:00 italiane invece delle 21:00, Miami 2026 senza l'anticipo di 3 ore per maltempo; f1api.dev resta come ripiego e ogni correzione viene scritta nel log; nessuna richiesta per le gare future; risultati in cache per circuito, non per numero di round: l'API può rinumerare il calendario in stagione, come successo nel 2026 con Sepang; una sessione senza orario nel calendario conta come disputata dal giorno dopo) gira ogni 2 ore venerdì e sabato (prove libere, sprint, qualifiche) e dopo la gara la domenica sera: scarica il calendario della stagione in corso con i vincitori e i risultati completi di qualifiche/gara delle sessioni già disputate (e delle prove libere solo per il GP in evidenza, vedi sopra), e aggiorna `calendar.json`. I risultati già scaricati in run precedenti vengono riusati (non ridownload ogni volta), quindi ogni run fa solo le richieste per le sessioni nuove concluse dall'ultimo giro.
- `scripts/verify-data.js` — strumento di controllo manuale (`node scripts/verify-data.js`): ricontrolla TUTTE le stagioni presenti in `data.json` contro l'API reale e segnala discrepanze da rivedere a mano. Non modifica mai `data.json` da solo. Conosce gli errori già verificati a mano di f1api.dev (`VERIFIED_API_ERRORS`: 2024 Melbourne e Red Bull Ring, dove l'API sbaglia il tempo e `data.json` è giusto) e il caso di due gare sullo stesso circuito nello stesso anno (Red Bull Ring 2021: Stiria e Austria, `data.json` ha una sola voce per anno+circuito, quella del GP d'Austria). Accetta anche i tempi con i due punti ("1:29:179") usati dall'API per alcune stagioni.
- `scripts/backfill-weather.js` — strumento una tantum (`node scripts/backfill-weather.js`) che ricalcola il meteo di TUTTE le entry storiche usando Open-Meteo. Usato per correggere il meteo originariamente inventato/segnaposto; da rilanciare solo se si vuole ricalcolare tutto lo storico (es. dopo una modifica ai criteri di classificazione).
- `scripts/build-history.js` — scarica calendario, vincitori e risultati di qualifiche e gara (solo queste due sessioni, su richiesta esplicita) di una o più stagioni PASSATE e scrive `history/{anno}.json`. Le gare di una stagione vengono processate in parallelo (l'API è lenta, farlo in sequenza richiederebbe ore) con scrittura incrementale, quindi un'interruzione a metà non fa perdere le gare già scaricate. Se `history/{anno}.json` esiste già viene saltato; cancellarlo per rigenerare quell'anno. Richiamabile a mano (`node scripts/build-history.js [anno...]`), ma la sua funzione principale (`buildYear`) è anche importata ed eseguita in automatico da `scripts/archive-finished-season.js`.
- `scripts/archive-finished-season.js` — gira ogni settimana (stessa schedulazione di `update-calendar.js`, dopo la gara): controlla se l'ultima gara del calendario in corso ha un risultato (= la stagione è appena finita) e, se sì e `history/{anno}.json` non esiste già, genera lo storico di quell'annata (riusando `build-history.js`) e aggiunge l'anno a `history/index.json`. Idempotente e no-op istantaneo per la stragrande maggioranza delle esecuzioni (stagione ancora in corso); scatta solo la settimana in cui l'ultima gara è stata disputata. Questo è il meccanismo che rende automatico l'aggiornamento di "Stagioni precedenti" a ogni fine mondiale, senza bisogno di lanciare nulla a mano.
- `scripts/build-telemetry.js` — gira dopo la qualifica (sabato, via `update-telemetry.yml`), ma è anche uno strumento richiamabile a mano (`node scripts/build-telemetry.js` per tutte le stagioni dal 2023 all'anno in corso, calcolate da sole, `node scripts/build-telemetry.js 2026` per una sola stagione): scarica da OpenF1 la telemetria del giro di pole in qualifica di ogni GP già disputato dal 2023 in poi, e scrive `telemetry.json`. Il giro di pole viene identificato incrociando sia il **pilota** che il **tempo** ufficiali da `data.json`: non il giro più veloce in assoluto della sessione (può essere stato cancellato per track limits, promuovendo un giro più lento a pole — successo davvero all'Ungheria 2025), e nemmeno semplicemente il giro più veloce del pilota giusto nell'intera sessione (in condizioni miste/in evoluzione un giro di Q1/Q2 può risultare più veloce del vero giro di pole senza esserlo — successo davvero a Montreal 2023, sessione bagnata); si cerca invece, tra i giri di quel pilota, quello con durata più vicina al tempo ufficiale. Scrittura incrementale (una stagione/circuito alla volta) e retry con backoff sui 429 di OpenF1, così un'interruzione a metà non fa perdere i circuiti già scaricati; già scaricati vengono saltati, quindi ogni run fa solo le richieste per i round nuovi.
- `scripts/update-news.js` — gira ogni 4 ore (via `update-news.yml`), ma è anche richiamabile a mano (`node scripts/update-news.js`): scarica il feed RSS di FormulaPassion.it (solo categoria F1), prende i 5 articoli più recenti e scrive `news.json`. Nessuna libreria di parsing XML: il feed RSS ha una struttura semplice, estratta con regex e con decodifica delle entity HTML/numeriche più comuni.
- `.github/workflows/update-poles.yml` — automazione GitHub Actions che esegue `update-poles.js` ogni sabato sera, più un run di recupero domenica e lunedì mattina.
- `.github/workflows/update-telemetry.yml` — automazione GitHub Actions che esegue `build-telemetry.js` ogni sabato sera (stesse ore di `update-poles.yml` ma 16 minuti dopo, perché usa la pole appena scritta in `data.json`, essendo la telemetria dello stesso giro di pole), più un run di recupero domenica e lunedì mattina.
- `.github/workflows/check-pole-penalty.yml` — automazione GitHub Actions che esegue `check-pole-penalty.js` ogni domenica sera / lunedì mattina.
- `.github/workflows/update-standings.yml` — automazione GitHub Actions che esegue `update-standings.js` ogni domenica sera / lunedì mattina.
- `.github/workflows/update-calendar.yml` — automazione GitHub Actions che esegue `update-calendar.js` ogni 2 ore venerdì e sabato, poi domenica sera / lunedì mattina.
- `.github/workflows/update-news.yml` — automazione GitHub Actions che esegue `update-news.js` ogni 4 ore.
- `.github/workflows/update-all.yml` — solo manuale (nessuno schedule proprio): esegue in sequenza tutti e sette gli script sopra in un unico run, per aggiornare tutto con un solo "Run workflow" invece di lanciarli uno alla volta. È il workflow a cui punta il tasto "🔄 Full Update" del sito.

## Come pubblicare il sito online (GitHub Pages)

1. Crea un repository su GitHub (es. `f1-pole-tracker`), pubblico o privato (con Pages funziona in entrambi i casi se hai un piano che lo supporta; con repo pubblico è gratuito senza limitazioni).
2. Carica dentro tutti questi file mantenendo la stessa struttura di cartelle:
   ```
   index.html
   manifest.json
   sw.js
   icons/icon-192.png
   icons/icon-512.png
   icons/icon-512-maskable.png
   icons/apple-touch-icon.png
   icons/favicon-32.png
   data.json
   standings.json
   calendar.json
   history/2021.json ... history/2025.json
   history/index.json
   telemetry.json
   news.json
   status/poles.json
   status/penalty.json
   status/standings.json
   status/calendar.json
   status/history.json
   status/telemetry.json
   scripts/update-poles.js
   scripts/check-pole-penalty.js
   scripts/update-standings.js
   scripts/update-calendar.js
   scripts/verify-data.js
   scripts/backfill-weather.js
   scripts/build-history.js
   scripts/archive-finished-season.js
   scripts/build-telemetry.js
   scripts/update-news.js
   scripts/lib/f1-mapping.js
   scripts/lib/weather.js
   scripts/lib/session-results.js
   scripts/lib/status.js
   scripts/lib/push-with-retry.sh
   .github/workflows/update-poles.yml
   .github/workflows/update-telemetry.yml
   .github/workflows/check-pole-penalty.yml
   .github/workflows/update-standings.yml
   .github/workflows/update-calendar.yml
   .github/workflows/archive-finished-season.yml
   .github/workflows/update-news.yml
   .github/workflows/update-all.yml
   ```
3. Vai su **Settings → Pages** del repository, e in "Build and deployment" seleziona come source il branch principale (es. `main`), cartella `/ (root)`.
4. Dopo un paio di minuti il sito sarà raggiungibile su `https://<tuo-utente>.github.io/<nome-repo>/`.

## Installazione come app (PWA)

Il sito è installabile su iOS e Android come una vera app, senza passare dagli store:

- **iOS (Safari)**: apri il sito → icona di condivisione → "Aggiungi a Home". A differenza di un semplice segnalibro, l'icona apre l'app a schermo intero (niente barra di Safari), con icona e nome propri e una schermata di avvio dedicata.
- **Android (Chrome)**: Chrome può proporre da solo "Installa app" quando rileva il sito; in alternativa, menu ⋮ → "Installa app" / "Aggiungi a schermata Home".

Tecnicamente non è un'app separata da mantenere: è lo stesso sito, con in più `manifest.json` (nome, icone, colori, modalità a schermo intero) e `sw.js` (service worker minimo, solo per l'installabilità e una resilienza offline di base — vedi sopra). Nessuna build, nessun account sviluppatore, nessuna pubblicazione su App Store/Play Store: si aggiorna da sola ogni volta che il sito viene ripubblicato.

## Modalità "Passo gara"

L'interruttore **Qualifiche / Passo gara** (su desktop a destra del menu del circuito e alto quanto il menu, qualunque sia il browser; su mobile sotto il box del prossimo GP e sopra il menu; modalità attiva in grigio chiaro pieno con testo bianco in grassetto) cambia tutto il contenuto del sito (classe `pace-mode` sul `body`): la vista Qualifiche resta com'è, la vista Passo gara mostra i tempi di ogni giro di due piloti in una gara, a confronto.

- **Dati:** `pace/{anno}/{circuito}.json` (un file per gara, ~13 KB, caricato solo quando la si apre) e `pace/index.json` (elenco delle gare per anno). Scaricati da `scripts/build-race-pace.js` da OpenF1, quindi **solo dal 2023** (87 gare al momento). Ogni file contiene la classifica ufficiale (con ritiri e squalifiche), i piloti con colore della scuderia, il tempo di ogni giro, i giri di ingresso e uscita dai box, gli stint con le mescole e i periodi di safety car / VSC e bandiere rosse. I giri di gara sono quelli del vincitore in classifica: OpenF1 conta anche il giro dopo la bandiera a scacchi, che viene scartato. Dati accessori mancanti per alcune gare (es. soste di alcune gare 2023) non fanno scartare la gara: le soste si ricavano dai giri di uscita dai box.
- **Vista:** in alto anno, circuito e i piloti (B facoltativo: "nessuno", o B premuto di nuovo in classifica, mostra un solo pilota); a sinistra:
  - il grafico dei tempi sul giro (A rosso, B blu tratteggiato, come la telemetria), con la scala tarata sui giri "puliti" (senza primo giro, soste e safety car), così le differenze di passo non vengono schiacciate dai giri lenti; bande arancioni per safety car (piena) e VSC (tenue), linea rossa tratteggiata per le bandiere rosse, triangoli sul fondo per le soste e, sopra il grafico, una striscia per pilota con le mescole usate (colori Pirelli); il tooltip di ogni giro riporta tempo, mescola ed eventuale sosta;
  - il distacco di B da A a fine giro (somma dei tempi sul giro; sopra lo zero = B dietro), che si interrompe dove manca un giro di uno dei due; nascosto con un solo pilota;
  - quattro riquadri: passo medio e costanza (deviazione standard) sui giri puliti (esclusi anche i giri oltre il 110% della mediana), giro più veloce, soste con i giri.

  A destra (su mobile sotto) la classifica della gara con i tasti A/B. Passando dalle Qualifiche con l'interruttore si apre sullo stesso circuito scelto lì (anno già aperto nel passo gara se ha quel circuito, altrimenti il più recente; piloti mantenuti se hanno corso); per un circuito senza dati (prima del 2023) resta la gara aperta prima, o l'ultima disputata, con un avviso. La prima apertura senza circuito noto mostra l'ultima gara con i primi due classificati.
- **Link:** `#mode=pace&y=2025&c=Monza&a=VER&b=NOR` apre direttamente quella gara e quei piloti (sigle a tre lettere); `b=-` = un solo pilota. Il titolo riporta sempre alla vista Qualifiche.
- **Automazione:** `.github/workflows/update-race-pace.yml` dopo ogni gara (domenica 18:27 e 22:27 UTC, lunedì 6:27), più un passo in `update-all.yml`. Scarica solo le gare nuove; una gara appena finita senza dati su OpenF1 resta in attesa per 72 ore senza far fallire il run. Scrive `status/pace.json` per l'indicatore in alto.
- `scripts/lib/openf1.js` raccoglie il codice condiviso con la telemetria: richieste distanziate per il limite del piano gratuito, mappa dei nomi dei circuiti, nome dei file per circuito.

## Notifica dopo ogni GP (ntfy)

Lunedì alle 8:13 UTC (dopo tutti i run di recupero, con un secondo controllo martedì) `.github/workflows/notify-gp.yml` esegue `scripts/notify-gp.js`, che controlla l'ultima gara corsa: pole in `data.json`, risultati di gara, classifica aggiornata dopo la gara, telemetria della pole e passo gara. Poi invia una notifica push con [ntfy](https://ntfy.sh) (gratuito, nessun account):

- **✅ "GP di Austin 2026"** (titolo = solo il nome del GP, l'esito lo dice l'emoji) con pole, podio e leader del mondiale piloti e costruttori; toccandola si apre il sito su quel circuito.
- **⚠️ "GP di Austin 2026"**, a priorità più alta, se qualcosa non c'è: stesso riepilogo e in fondo "❌ Non aggiornati: …" con i soli dati mancanti. Si avvisa una volta; se il dato arriva dopo (es. martedì) parte il ✅.
- **Una sola notifica per GP:** l'ultimo GP notificato è in `status/notified.json`.
- **Canale:** nome lungo e casuale nel segreto del repository `NTFY_TOPIC` (Settings → Secrets and variables → Actions), mai nel codice pubblico: chi conosce il nome può leggere e scrivere nel canale. Per ricevere le notifiche: app ntfy (iPhone, Android, web) → "+" → iscrizione a quel canale sul server ntfy.sh. Per aggiungere persone basta dar loro il nome del canale; per toglierle, si cambia nome (nuovo segreto). Senza segreto lo script non invia nulla e non fallisce.
- **ℹ️ "Circuito nuovo aggiunto in automatico: …"** in più se il GP si è corso su un circuito riconosciuto in automatico quest'anno (vedi sotto), per poterne cambiare il nome.
- Prova senza inviare: `node scripts/notify-gp.js --dry-run`.

### Notifiche nella web app (schermata Home)

Lo stesso messaggio arriva anche alla web app installata sulla schermata Home, in parallelo a ntfy (Web Push; su iPhone da iOS 16.4, solo con il sito aggiunto alla Home da Safari). Toccando la notifica si apre la web app sul GP.

- **Attivazione:** nella web app il tasto **🔔 Notifiche** (accanto a Full Update) chiede il permesso e mostra un codice (l'iscrizione del telefono) da copiare. Il sito è statico e non può salvarlo da solo: va messo nel segreto `WEBPUSH_SUBSCRIPTIONS` (JSON, una iscrizione o un array per più telefoni). Il riquadro chiede anche il nome di chi si iscrive e lo inserisce nel codice (campo `name`), usato nei log dell'automazione per sapere di chi è un'iscrizione scaduta: i log sono pubblici, quindi solo nomi brevi. Fuori dalla Home, su iPhone il tasto spiega come aggiungerla. Se il permesso è negato, spiega come riattivarlo con il percorso giusto per il dispositivo (iPhone, app Android installata, Chrome su Android, computer). Provato anche su Android (Chrome): consegna e apertura della web app funzionano.
- **Invio:** `scripts/lib/webpush.js`, senza librerie esterne: cifratura RFC 8291 (verificabile con `node scripts/lib/webpush.js --self-test`, che la confronta con l'esempio ufficiale) e firma VAPID. Chiave pubblica nel codice (`webpush.js` e `index.html`), privata solo nel segreto `VAPID_PRIVATE_KEY`.
- **Ricezione:** `sw.js` mostra la notifica e al tocco apre o porta in primo piano la web app.
- **Iscrizione scaduta** (iOS può invalidarla): il log dice "iscrizione scaduta", si riattiva dal tasto 🔔 e si aggiorna il segreto.
- Basta un canale riuscito (ntfy o web app) perché il GP risulti notificato.
- Prova solo alla web app, senza toccare lo stato: `node scripts/notify-gp.js --test-push` (con `VAPID_PRIVATE_KEY` e `WEBPUSH_SUBSCRIPTIONS` nell'ambiente).
- In futuro, per aprire l'attivazione a chiunque senza passare dai segreti, servirà un piccolo servizio che raccolga le iscrizioni (es. Cloudflare Workers).
- Idea per il futuro: lo stesso controllo potrebbe anche scrivere un commento su una issue fissa con @menzione, per ricevere il riepilogo via email da GitHub.

## Circuiti nuovi (riconosciuti in automatico)

Ogni fonte chiama i circuiti a modo suo, e tre tabelle scritte a mano li traducono nei nomi del sito: `CIRCUIT_ID_MAP` in `scripts/lib/f1-mapping.js` (f1api.dev: pole, calendario, risultati), `CIRCUIT_MAP` in `scripts/lib/openf1.js` (OpenF1: telemetria, mappa, passo gara, orari ufficiali) e `CIRCUIT_INFO` in `scripts/lib/weather.js` (coordinate e fuso orario per il meteo). Un circuito assente da queste tabelle prima bloccava la pole (errore e mail "Run failed") e lasciava senza telemetria, passo gara e meteo.

Ora `update-calendar.js` (`scripts/lib/auto-circuits.js`) li riconosce da solo appena compaiono nel calendario, in genere mesi prima della gara:

- **Nome del sito:** la città indicata da f1api.dev (es. "Madrid"); se già usata da un altro circuito, il nome completo del circuito.
- **Nome OpenF1:** collegato per data: la gara OpenF1 dello stesso giorno (±1) di una sola gara del calendario è quel circuito.
- **Meteo:** coordinate e fuso orario dalla città con la ricerca località di Open-Meteo (gratuita, senza chiave); "notturno" se la gara parte dalle 18 ora locale.

Quanto imparato va in `auto-circuits.json` e viene usato da tutti gli script, ma le tabelle scritte a mano hanno sempre la precedenza: per cambiare il nome automatico basta aggiungere la voce nelle tabelle (lo stesso nome nelle tre). La notifica del lunedì lo segnala con una riga ℹ️. Se il collegamento per data non riesce, il log lo dice e si torna al caso di prima (⚠️ nella notifica, riga da aggiungere a mano). Verificato togliendo Madrid dalle tre tabelle: riconosciuto con lo stesso nome, gli stessi orari ufficiali e un `calendar.json` identico.

## Telefono: verticale e ruotato

- **Verticale:** nella telemetria l'asse Y è compatto (numeri senza "km/h", font più piccolo, unità già nei riquadri sotto) e i margini sono ridotti: le curve occupano circa il 75% della larghezza dello schermo invece del 58%.
- **Ruotato in orizzontale:** riconosciuto come schermo orizzontale, alto meno di 500px e touch (`isPhoneLandscape()` in `index.html`). Anche se per larghezza sarebbe "desktop", si usa una colonna sola (classe `phone-landscape` sul `body`): grafico a tutta larghezza e alto quanto lo schermo, così i tre pannelli della telemetria si vedono interi, widget "Prossimo GP" in versione mobile, quattro riquadri di statistiche in una riga. Ruotando il telefono la telemetria si ridisegna da sola.
- L'altezza del grafico è calcolata in un solo punto (`chartContainerHeight()`): prima ogni evento di ridimensionamento, compresa la barra di Safari che si nasconde scorrendo, riportava la telemetria su mobile all'altezza normale (200px).
- `manifest.json` ha `orientation: any`, quindi anche l'app installata sulla schermata Home può ruotare.

## Link condivisibili

Lo stato della vista è nell'indirizzo della pagina (la parte dopo `#`), che si aggiorna da solo mentre navighi: copiandolo, o col tasto **Condividi** (icona a tre pallini collegati, in alto a destra nel riquadro del grafico, dopo il tasto del delta), si manda a qualcuno esattamente quello che si sta guardando. Su telefono il tasto apre il foglio di condivisione nativo, altrove copia il link negli appunti.

Formato: `#c=Monza&view=telemetry&y=2023&vs=2024`
- `c` — circuito, con il nome del menu a tendina (spazi e parentesi codificati, es. `Baku%20%28Azerbaijan%29`).
- `view` — `telemetry` o `delta`; assente = grafico dei tempi.
- `y` — anno principale della telemetria; assente = 2026.
- `vs` — anno di confronto della telemetria.

Cliccando sul titolo **F1 POLE TRACKER** il sito si ricarica aggiornato e torna alla home (indirizzo senza circuito né vista), cancellando le personalizzazioni della sessione di consultazione; prima di ricaricare rivalida `index.html` saltando la cache HTTP (GitHub Pages la tiene 10 minuti).

Link non validi non rompono nulla: un circuito inesistente viene ignorato (si apre il circuito di default), un anno senza telemetria ripiega sul 2026, e se il circuito non ha telemetria si apre il grafico normale. L'hash non viene mai inviato al server (il sito è statico) e si aggiorna con `history.replaceState`, quindi non riempie la cronologia del browser. Modificare l'hash a mano nella stessa scheda applica subito la nuova vista.

## Come funziona l'aggiornamento automatico

Ci sono quattro momenti distinti, perché prove libere, qualifica e gara di un weekend F1 non finiscono mai nello stesso momento, e le news escono in continuazione:

**0. Durante tutto il weekend di gara (venerdì e sabato, ogni 2 ore)** — `update-calendar.yml` esegue `scripts/update-calendar.js`. Gira a orario fisso tutto il giorno (non solo subito dopo ogni sessione) perché gli orari delle sessioni cambiano moltissimo da circuito a circuito (es. Melbourne alle prime ore UTC, Austin nel tardo pomeriggio UTC): non è possibile agganciarsi all'orario esatto di fine di ogni sessione per tutti i 22 GP con un cron fisso, quindi si accetta un ritardo massimo di circa 2 ore rispetto alla fine reale della sessione. Ogni run scarica solo le sessioni nuove già disputate dall'ultimo giro, quindi nei weekend senza gara è un no-op istantaneo.

**1. Dopo la qualifica (sabato)** — girano due workflow, con 16 minuti di scarto (prima la pole, poi la telemetria che la usa):
- `update-poles.yml` esegue `scripts/update-poles.js`:
  1. Interroga l'API pubblica e gratuita [f1api.dev](https://f1api.dev) per l'ultima qualifica disputata.
  2. Estrae pilota, team e tempo del più veloce in qualifica (= la pole, per definizione, a prescindere da eventuali penalità che verranno applicate dopo).
  3. Se il dato non è già presente (o è cambiato) in `data.json`, lo aggiorna e fa un commit automatico al repository.
- `update-telemetry.yml` esegue `scripts/build-telemetry.js`: scarica da OpenF1 la telemetria del giro di pole appena disputato e aggiorna `telemetry.json` (vedi sopra).

**2. Dopo la gara (domenica)** — girano quattro workflow separati, tutti nella stessa finestra oraria (stesse ore, minuti diversi):
- `check-pole-penalty.yml` esegue `scripts/check-pole-penalty.js`: interroga l'API per i risultati di gara (che includono la griglia di partenza reale, campo `grid`), confronta il polista registrato con chi è partito davvero P1, e se sono persone diverse (penalità post-qualifica) aggiunge un `penaltyNote` alla entry — il polista registrato NON cambia.
- `update-standings.yml` esegue `scripts/update-standings.js`: scarica la classifica piloti e costruttori aggiornata e la scrive in `standings.json`, mostrata nel pannello "🏆 Classifica" del sito.
- `update-calendar.yml` esegue `scripts/update-calendar.js`: un ulteriore giro (oltre a quelli già fatti venerdì/sabato, vedi punto 0) per scaricare il vincitore e i risultati di gara appena disputata, e lo scrive in `calendar.json`, mostrato nel pannello "📅 Calendario" del sito. Il calendario della stagione in corso viene rilevato automaticamente tramite `/api/current`, quindi non serve aggiornare l'anno a mano ogni stagione.
- `archive-finished-season.yml` esegue `scripts/archive-finished-season.js`: controlla se l'ultima gara del calendario in corso ha appena avuto un risultato (= la stagione è finita) e, se sì, genera `history/{anno}.json` per quell'annata e lo aggiunge a `history/index.json` — questo è ciò che rende automatico l'aggiornamento del pannello "🕰️ Stagioni precedenti" a ogni fine mondiale, senza bisogno di lanciare nulla a mano. No-op istantaneo per il resto dell'anno.

**3. Continuamente (ogni 4 ore)** — `update-news.yml` esegue `scripts/update-news.js`: scarica il feed RSS di FormulaPassion.it e aggiorna `news.json` con gli ultimi 5 articoli, mostrati nel pannello "📰 News".

Puoi lanciare ciascuno manualmente in qualsiasi momento da GitHub: **Actions → (nome workflow) → Run workflow**.

Per lanciarli tutti e sette insieme senza ripetere l'operazione volta per volta, c'è un ottavo workflow, `update-all.yml` ("Aggiorna tutto"), **solo manuale** (nessuno schedule proprio): esegue gli stessi sette script in sequenza in un unico run. È anche il workflow a cui punta il tasto "🔄 Full Update" in fondo al sito.

**Librerie da CDN:** `index.html` carica Tailwind (browser build) e Chart.js a versione FISSA e con controllo di integrità SRI (4.3.3 e 4.5.1): una release nuova o un file alterato sul CDN non può più rompere il sito senza un commit. Per aggiornarle vanno cambiati sia la versione sia l'hash (`openssl dgst -sha384 -binary file | openssl base64 -A`).

**Orari dei cron:** tutti usano minuti fuori dall'ora tonda (:07, :17, :23, :31, :41, :47, :53). I cron alle ore tonde sono quelli che GitHub Actions ritarda di più nei momenti di carico, ed è una delle cause delle collisioni di push viste in passato. I minuti sono scelti anche per rispettare le dipendenze: la telemetria parte dopo le pole (legge `data.json`), l'archiviazione stagione dopo il calendario (legge `calendar.json`). I workflow usano Node 22 (Node 20 non è più supportato).

## Indicatore di stato API

Il sito non chiama mai direttamente le API esterne (f1api.dev, OpenF1, Open-Meteo): è statico, quindi può solo riflettere l'esito dell'ultima volta che un nostro script le ha interrogate. Ognuno dei 7 script legati alle pole/classifica/calendario/storico/telemetria/passo gara (`update-poles.js`, `check-pole-penalty.js`, `update-standings.js`, `update-calendar.js`, `archive-finished-season.js`, `build-telemetry.js`, `build-race-pace.js` — **non** `update-news.js`, escluso di proposito) scrive, tramite `scripts/lib/status.js`, un proprio file `status/{key}.json` ad ogni esecuzione:
```json
{ "ok": true, "lastRun": "2026-07-28T18:23:11.979Z", "error": null }
```
`ok:true` significa "lo script ha girato e l'API ha risposto correttamente", non "c'erano dati nuovi": anche un run che non trova nulla da aggiornare conta come `ok:true`, per non generare falsi allarmi nei periodi senza gare. Per non produrre un commit (e un deploy di Pages) a ogni esecuzione a vuoto, il file viene però riscritto solo se cambiano `ok`/`error` oppure se l'ultimo `lastRun` ha più di 6 ore: l'orario mostrato dal sito può quindi essere fino a 6 ore indietro rispetto all'ultimo run reale.

Un file per automazione (mai uno condiviso) evita che due workflow schedulati a ridosso l'uno dell'altro (es. `update-poles.yml` e `update-telemetry.yml`) rischino di scontrarsi al push su git.

Il sito scarica i 6 file all'avvio e li combina in un solo indicatore sotto il titolo:
- 🟢 se tutti `ok:true` → "Dati aggiornati al [giorno] alle [ora]. API correttamente funzionanti." (l'orario mostrato è il più vecchio tra i 7 `lastRun`: il momento fino al quale TUTTE le automazioni sono confermate funzionanti).
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
