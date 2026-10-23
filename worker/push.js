/* Web Push bez zewnętrznych usług: VAPID (ES256) podpisany WebCrypto, wiadomość bez treści.
   Telefon po otrzymaniu sygnału sam pobiera najnowsze powiadomienie z /api/notifications (public/app-sw.js),
   więc nie trzeba szyfrować treści (RFC 8291). Klucze VAPID: generowane raz i trzymane w settings ('vapid'). */

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = new TextEncoder();

export async function vapidKeys(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
  if (row) return JSON.parse(row.value);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  // INSERT OR IGNORE: gdy dwa żądania wygenerują klucze naraz, zostaje pierwszy
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(keys)).run();
  return JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid'").first()).value);
}

async function vapidAuth(keys, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

/* wysyła sygnał do wszystkich telefonów użytkownika; nieaktualne subskrypcje (404/410) usuwa */
export async function pushUser(env, userId, { urgency = 'normal' } = {}) {
  const { results } = await env.DB.prepare('SELECT endpoint FROM push_subs WHERE user_id = ?').bind(userId).all();
  if (!results.length) return 0;
  const keys = await vapidKeys(env);
  let sent = 0;
  for (const { endpoint } of results) {
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: {
        Authorization: await vapidAuth(keys, endpoint, 'mailto:kontakt@plusoneapp.pl'), TTL: '86400', Urgency: urgency, 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
      else if (r.ok) sent++;
      else console.error('push', r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.error('push', e); }
  }
  return sent;
}
