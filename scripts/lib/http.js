// scripts/lib/http.js
//
// Richieste HTTP condivise da tutti gli script (prima fetchJson era copiato,
// con piccole varianti, in 8 file diversi).

class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} per ${url}`);
        this.status = status;
        this.url = url;
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// GET + JSON.
//  - allow404: un 404 non è un errore, restituisce null (es. risultati di
//    una sessione non ancora pubblicati dall'API).
//  - retries: tentativi totali per errori di rete/5xx (pausa 1s); i 404 non
//    si ritentano mai (non cambierebbero).
// Un 429 (troppe richieste: OpenF1 ha un rate limit reale) viene sempre
// ritentato con backoff crescente, fino a 5 tentativi.
async function fetchJson(url, { allow404 = false, retries = 1 } = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url);
            if (res.status === 404 && allow404) return null;
            if (res.status === 429 && attempt < 5) {
                const waitMs = 1000 * attempt;
                console.warn(`   ⏳ 429 (troppe richieste), riprovo tra ${waitMs}ms...`);
                await sleep(waitMs);
                continue;
            }
            if (!res.ok) throw new HttpError(res.status, url);
            return await res.json();
        } catch (err) {
            const is404 = err instanceof HttpError && err.status === 404;
            if (attempt >= retries || is404) throw err;
            await sleep(1000);
        }
    }
}

module.exports = { HttpError, sleep, fetchJson };
