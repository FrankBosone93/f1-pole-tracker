# F1 Pole Tracker

## Struttura dei file
- `index.html` — il sito. Carica i dati da `data.json` (fetch). Se `data.json` non è raggiungibile (es. apri il file in locale con doppio click), usa i dati incorporati nel codice come fallback.
- `data.json` — i dati "ufficiali" delle pole position. È la fonte di verità.
- `scripts/update-poles.js` — script Node che scarica l'ultima pole position da f1api.dev e aggiorna `data.json`.
- `.github/workflows/update-poles.yml` — automazione GitHub Actions che esegue lo script ogni sabato sera e pubblica in automatico eventuali aggiornamenti.

## Come pubblicare il sito online (GitHub Pages)

1. Crea un repository su GitHub (es. `f1-pole-tracker`), pubblico o privato (con Pages funziona in entrambi i casi se hai un piano che lo supporta; con repo pubblico è gratuito senza limitazioni).
2. Carica dentro tutti questi file mantenendo la stessa struttura di cartelle:
   ```
   index.html
   data.json
   scripts/update-poles.js
   .github/workflows/update-poles.yml
   ```
3. Vai su **Settings → Pages** del repository, e in "Build and deployment" seleziona come source il branch principale (es. `main`), cartella `/ (root)`.
4. Dopo un paio di minuti il sito sarà raggiungibile su `https://<tuo-utente>.github.io/<nome-repo>/`.

## Come funziona l'aggiornamento automatico

Ogni sabato alle 18:00 e alle 22:00 (ora UTC) GitHub esegue automaticamente `scripts/update-poles.js`, che:
1. Interroga l'API pubblica e gratuita [f1api.dev](https://f1api.dev) per l'ultima qualifica disputata.
2. Estrae pilota, team e tempo del poleman.
3. Se il dato non è già presente (o è cambiato) in `data.json`, lo aggiorna e fa un commit automatico al repository.

Puoi anche lanciarlo manualmente in qualsiasi momento da GitHub: **Actions → "Aggiorna pole position F1" → Run workflow**.

⚠️ **Nota**: lo script è stato scritto sulla base della documentazione pubblica di f1api.dev, ma non è stato possibile testarlo dal vivo contro l'API reale durante lo sviluppo (ambiente senza accesso a internet). È stato progettato in modo difensivo, con log dettagliati della risposta ricevuta ad ogni esecuzione. **La prima volta che gira su una qualifica reale**, controlla i log dell'Action (Actions → click sull'esecuzione → log dello step "Esegui script di aggiornamento pole position") per verificare che tutto funzioni correttamente. Se l'API restituisce dati con nomi di campo diversi da quelli previsti, lo script segnala chiaramente l'errore nei log invece di scrivere dati sbagliati.

## Aggiornamenti manuali / correzioni

Il pannello "🔧 Aggiornamento Live" nel sito resta disponibile per chiunque lo visiti, ma scrive solo nel **localStorage del browser di chi lo usa** — non modifica mai il `data.json` condiviso. Quindi:
- Ogni visitatore può "giocare" col pannello e vedere modifiche solo nella propria sessione, senza alcun impatto su ciò che vedono gli altri.
- Per aggiornare davvero il sito per tutti, l'unico modo è modificare `data.json` nel repository GitHub (a mano, o lasciando fare all'automazione) — cosa che richiede le tue credenziali GitHub.

Se vuoi correggere un dato a mano: modifica direttamente `data.json` nel repository (anche dall'editor web di GitHub, senza bisogno di git in locale) e salva/commit — il sito lo rifletterà al prossimo caricamento.
