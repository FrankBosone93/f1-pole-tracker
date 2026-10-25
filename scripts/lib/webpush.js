// scripts/lib/webpush.js
//
// Invio di notifiche Web Push alla web app installata sulla schermata Home
// (iPhone da iOS 16.4, ma anche Android/desktop), senza librerie esterne:
// solo il modulo crypto di Node.
//
//   - cifratura del messaggio: RFC 8291 (aes128gcm), verificata con l'esempio
//     ufficiale dell'Appendice A (node scripts/lib/webpush.js --self-test)
//   - autenticazione del mittente: VAPID, RFC 8292 (token JWT firmato ES256)
//
// La chiave pubblica VAPID è anche in index.html (serve al browser per
// iscriversi); la privata sta solo nel segreto VAPID_PRIVATE_KEY.

const crypto = require('crypto');

const VAPID_PUBLIC_KEY = 'BG3V2TNhsjePVjINPgQXt_xqW18B-FQYYmX1wOqAMi-NJRvayErTAd36gB_PgL2IDjhPrvV5zVLM_jFVAAV09tA';
// "sub" del token VAPID: un contatto del mittente (mailto: o https).
// L'indirizzo del sito evita di pubblicare un'email.
const VAPID_SUBJECT = 'https://frankbosone93.github.io/f1-pole-tracker/';

const fromB64u = s => Buffer.from(s, 'base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// Cifra il testo per un'iscrizione ({ p256dh, auth } in base64url).
// asPrivate e salt si passano solo nel test con i valori dell'RFC: di norma
// sono generati a caso a ogni messaggio.
function encrypt(plaintext, keys, { asPrivate, salt } = {}) {
    const uaPublic = fromB64u(keys.p256dh);
    const authSecret = fromB64u(keys.auth);
    const ecdh = crypto.createECDH('prime256v1');
    if (asPrivate) ecdh.setPrivateKey(asPrivate); else ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    salt = salt || crypto.randomBytes(16);

    const ecdhSecret = ecdh.computeSecret(uaPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
    const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

    // Un solo record: testo + delimitatore 0x02 (ultimo record), poi il tag.
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(4096, 16); // dimensione del record
    header.writeUInt8(asPublic.length, 20);
    return Buffer.concat([header, asPublic, body]);
}

// Token VAPID (JWT ES256) per il servizio push dell'iscrizione.
function vapidAuthorization(endpoint, privateKeyB64u) {
    const pub = fromB64u(VAPID_PUBLIC_KEY);
    const key = crypto.createPrivateKey({
        format: 'jwk',
        key: { kty: 'EC', crv: 'P-256', d: privateKeyB64u, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') },
    });
    const enc = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: VAPID_SUBJECT,
    })}`;
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `vapid t=${unsigned}.${sig}, k=${VAPID_PUBLIC_KEY}`;
}

// Invia { title, body, url } a un'iscrizione. Ritorna lo stato HTTP: 201 =
// consegnata al servizio push, 404/410 = iscrizione scaduta (va riattivata
// dall'app).
async function sendWebPush(subscription, payload, privateKeyB64u) {
    const res = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
            Authorization: vapidAuthorization(subscription.endpoint, privateKeyB64u),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(3 * 24 * 3600), // se il telefono è spento, consegna entro 3 giorni
            Urgency: 'normal',
        },
        body: encrypt(JSON.stringify(payload), subscription.keys),
    });
    return { status: res.status, text: res.ok ? '' : await res.text().catch(() => '') };
}

module.exports = { VAPID_PUBLIC_KEY, encrypt, vapidAuthorization, sendWebPush };

// Verifica con l'esempio dell'RFC 8291 (Sezione 5 / Appendice A).
if (require.main === module && process.argv.includes('--self-test')) {
    const out = encrypt('When I grow up, I want to be a watermelon',
        { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
        { asPrivate: fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw') });
    const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
        'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
    const ok = out.toString('base64url') === expected;
    console.log(ok ? '✅ Cifratura conforme all\'esempio RFC 8291' : `❌ Diverso dall'RFC:\n${out.toString('base64url')}`);
    process.exit(ok ? 0 : 1);
}
