/* +1 — API na Cloudflare Workers.
   /api/* obsługuje ten plik, resztę (apka, data/events.json) serwują statyczne pliki z public/.
   Baza: D1 (binding DB), schemat w migrations/. */

import previewHtml from '../private/app.html';
import { smtpSend } from './smtp.js';

const DAY = 864e5;
const SESSION_DAYS = 60;
const PBKDF2_ITER = 100000; // maksimum dozwolone w Workers
const enc = new TextEncoder();

/* ---------------- odpowiedzi ---------------- */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, error) => json({ error }, status);

/* ---------------- kryptografia ---------------- */
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
async function checkPassword(password, stored) {
  const [, iter, salt, hash] = stored.split('$');
  const got = b64(await pbkdf2(password, unb64(salt), +iter));
  // porównanie w stałym czasie
  let diff = got.length ^ hash.length;
  for (let i = 0; i < Math.min(got.length, hash.length); i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

/* ---------------- sesje ---------------- */
function cookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
const sessionCookie = (token, maxAge) =>
  `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function startSession(env, userId) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * DAY).run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}

async function currentUser(req, env) {
  const token = cookie(req, 'sid');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.city, u.created_at, u.owner, u.perm_curate, u.must_change FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256(token), Date.now()).first();
  return row || null;
}

/* uprawnienia: owner = główny administrator, admin, moderator (perm_curate), tester (preview_access) */
const isOwner = u => !!u && !!u.owner;
const isAdmin = u => !!u && (u.role === 'admin' || !!u.owner);
const canCurate = u => isAdmin(u) || (!!u && !!u.perm_curate);
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, city: u.city, createdAt: u.created_at,
  owner: !!u.owner, curate: canCurate(u), mustChange: !!u.must_change });

/* ---------------- walidacja ---------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanEmail = e => String(e || '').trim().toLowerCase();
const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const EVENT_ID_RE = /^[a-z0-9]+-[\w.-]{1,120}$/;

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

/* czy e-mail jest na liście adminów (w konfiguracji trzymamy tylko skróty sha256) */
async function isAdminEmail(env, email) {
  const list = String(env.ADMIN_EMAIL_SHA256 || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(await sha256(email));
}

/* ---------------- handlery ---------------- */
async function register(req, env) {
  const b = await body(req);
  const email = cleanEmail(b.email), name = cleanText(b.name, 60), password = String(b.password || '');
  if (!EMAIL_RE.test(email) || email.length > 200) return fail(400, 'Podaj poprawny adres e-mail.');
  if (password.length < 8) return fail(400, 'Hasło musi mieć co najmniej 8 znaków.');
  if (password.length > 200) return fail(400, 'Hasło jest za długie.');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
    return fail(409, 'To konto już istnieje — zaloguj się.');

  const role = (await isAdminEmail(env, email)) ? 'admin' : 'user';
  const city = cleanText(b.city, 60) || null;
  const now = Date.now();
  const res = await env.DB.prepare('INSERT INTO users (email, name, pass, role, city, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(email, name, await hashPassword(password), role, city, now, now).run();
  const id = res.meta.last_row_id;
  const set = await startSession(env, id);
  return json({ user: { id, email, name, role, city, createdAt: now }, saved: [], going: [] }, 201, { 'Set-Cookie': set });
}

async function login(req, env) {
  const b = await body(req);
  const email = cleanEmail(b.email), password = String(b.password || '');
  const since = Date.now() - 15 * 60e3;
  const fails = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_fail WHERE email = ? AND at > ?').bind(email, since).first('n');
  if (fails >= 8) return fail(429, 'Za dużo prób. Spróbuj za 15 minut.');

  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!u || !(await checkPassword(password, u.pass))) {
    await env.DB.prepare('INSERT INTO login_fail (email, at) VALUES (?, ?)').bind(email, Date.now()).run();
    return fail(401, 'Zły e-mail albo hasło.');
  }
  // admin z konfiguracji dostaje rolę także przy logowaniu (np. gdy konto powstało wcześniej)
  if (u.role !== 'admin' && (await isAdminEmail(env, email))) {
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(u.id).run();
    u.role = 'admin';
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_fail WHERE email = ?').bind(email),
    env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(Date.now(), u.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(u.id, Date.now())
  ]);
  const set = await startSession(env, u.id);
  return json({ user: publicUser(u), ...await savedIds(env, u.id) }, 200, { 'Set-Cookie': set });
}

async function logout(req, env) {
  const token = cookie(req, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

/* { saved: [...], going: [...] } — "Zapisane" i "Mam bilet" użytkownika */
async function savedIds(env, userId) {
  const { results } = await env.DB.prepare('SELECT event_id, kind FROM saved WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
  return {
    saved: results.filter(r => r.kind !== 'going').map(r => r.event_id),
    going: results.filter(r => r.kind === 'going').map(r => r.event_id)
  };
}

async function me(req, env, user) {
  if (!user) return json({ user: null, saved: [], going: [] });
  await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(Date.now(), user.id).run();
  return json({ user: publicUser(user), ...await savedIds(env, user.id) });
}

async function updateMe(req, env, user) {
  const b = await body(req);
  const name = b.name !== undefined ? cleanText(b.name, 60) : user.name;
  const city = b.city !== undefined ? (cleanText(b.city, 60) || null) : user.city;
  await env.DB.prepare('UPDATE users SET name = ?, city = ? WHERE id = ?').bind(name, city, user.id).run();
  return json({ user: publicUser({ ...user, name, city }) });
}

async function changePassword(req, env, user) {
  const b = await body(req);
  const next = String(b.password || '');
  if (next.length < 8) return fail(400, 'Nowe hasło musi mieć co najmniej 8 znaków.');
  if (next.length > 200) return fail(400, 'Hasło jest za długie.');
  const u = await env.DB.prepare('SELECT pass FROM users WHERE id = ?').bind(user.id).first();
  if (!(await checkPassword(String(b.current || ''), u.pass))) return fail(401, 'Obecne hasło jest niepoprawne.');
  if (await checkPassword(next, u.pass)) return fail(400, 'Nowe hasło musi być inne niż obecne.');
  await env.DB.prepare('UPDATE users SET pass = ?, must_change = 0 WHERE id = ?').bind(await hashPassword(next), user.id).run();
  return json({ user: publicUser({ ...user, must_change: 0 }) });
}

async function deleteMe(req, env, user) {
  const b = await body(req);
  if (isOwner(user) && (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE owner = 1').first('n')) <= 1)
    return fail(400, 'Jesteś ostatnim głównym administratorem — najpierw nadaj tę rolę komuś innemu.');
  const u = await env.DB.prepare('SELECT pass FROM users WHERE id = ?').bind(user.id).first();
  if (!(await checkPassword(String(b.password || ''), u.pass))) return fail(401, 'Złe hasło.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM saved WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM preview_access WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('UPDATE curation SET by_user = NULL WHERE by_user = ?').bind(user.id),
    env.DB.prepare('UPDATE invites SET invited_by = NULL WHERE invited_by = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id)
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function toggleSaved(req, env, user) {
  const b = await body(req);
  const id = String(b.eventId || '');
  if (!EVENT_ID_RE.test(id)) return fail(400, 'Złe wydarzenie.');
  if (b.on) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM saved WHERE user_id = ?').bind(user.id).first('n');
    if (n >= 1000) return fail(400, 'Masz już 1000 zapisanych wydarzeń.');
    const kind = b.kind === 'going' ? 'going' : 'saved';
    await env.DB.prepare(`INSERT INTO saved (user_id, event_id, created_at, kind) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, event_id) DO UPDATE SET kind = excluded.kind`).bind(user.id, id, Date.now(), kind).run();
  } else {
    await env.DB.prepare('DELETE FROM saved WHERE user_id = ? AND event_id = ?').bind(user.id, id).run();
  }
  return json(await savedIds(env, user.id));
}

/* publiczne: decyzje admina + popularność (ile osób zapisało) */
async function publicState(env) {
  const [cur, pop] = await Promise.all([
    env.DB.prepare('SELECT event_id, action FROM curation').all(),
    env.DB.prepare('SELECT event_id, COUNT(*) AS n FROM saved GROUP BY event_id ORDER BY n DESC LIMIT 300').all()
  ]);
  return json({
    hidden: cur.results.filter(r => r.action === 'hide').map(r => r.event_id),
    featured: cur.results.filter(r => r.action === 'feature').map(r => r.event_id),
    popular: Object.fromEntries(pop.results.map(r => [r.event_id, r.n]))
  });
}

/* ---------------- admin ---------------- */
async function adminStats(req, env) {
  const now = Date.now();
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).first('n');
  const [users, admins, active7, new7, saves, hidden, featured] = await Promise.all([
    q('SELECT COUNT(*) AS n FROM users'),
    q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' OR owner = 1"),
    q('SELECT COUNT(*) AS n FROM users WHERE last_seen > ?', now - 7 * DAY),
    q('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', now - 7 * DAY),
    q('SELECT COUNT(*) AS n FROM saved'),
    q("SELECT COUNT(*) AS n FROM curation WHERE action = 'hide'"),
    q("SELECT COUNT(*) AS n FROM curation WHERE action = 'feature'")
  ]);
  const top = await env.DB.prepare('SELECT event_id, COUNT(*) AS n FROM saved GROUP BY event_id ORDER BY n DESC LIMIT 10').all();
  return json({ users, admins, active7, new7, saves, hidden, featured, topSaved: top.results });
}

async function adminUsers(req, env) {
  const url = new URL(req.url);
  const q = '%' + cleanText(url.searchParams.get('q'), 100).toLowerCase() + '%';
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.owner, u.perm_curate, u.must_change, u.city, u.created_at, u.last_seen,
            (SELECT COUNT(*) FROM saved s WHERE s.user_id = u.id) AS saves,
            EXISTS(SELECT 1 FROM preview_access p WHERE p.user_id = u.id) AS preview_access
     FROM users u WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ? ORDER BY u.created_at DESC LIMIT 200`).bind(q, q).all();
  return json({ users: results });
}

async function canPreview(env, user) {
  return !!user && (isAdmin(user) || !!(await env.DB.prepare('SELECT 1 FROM preview_access WHERE user_id = ?').bind(user.id).first()));
}

async function adminPreviewAccess(req, env, id) {
  const b = await body(req);
  if (typeof b.allowed !== 'boolean') return fail(400, 'Podaj allowed: true lub false.');
  if (!await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(+id).first()) return fail(404, 'Nie ma takiego użytkownika.');
  if (b.allowed) await env.DB.prepare('INSERT OR IGNORE INTO preview_access (user_id, granted_at) VALUES (?, ?)').bind(+id, Date.now()).run();
  else await env.DB.prepare('DELETE FROM preview_access WHERE user_id = ?').bind(+id).run();
  return json({ ok: true, allowed: b.allowed });
}

/* Strona wejścia do aplikacji. Ma własne formularze, bo aplikacja dodana do ekranu iPhone'a nie widzi ciasteczek z Safari.
   Tryby: login (bez sesji), denied (konto bez dostępu), invite (link z zaproszenia), change (hasło startowe do zmiany). */
const escHtml = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const gatePage = ({ mode, user, email, token, note }) => {
  const field = (id, label, type, ac, extra = '') => `<label>${label}<input id="${id}" type="${type}" autocomplete="${ac}" ${extra}${extra.includes('data-optional') ? '' : ' required'}></label>`;
  const forms = {
    login: `<p>Zaloguj się, żeby zobaczyć, co dziś się dzieje.</p>
      <form id="f" data-mode="login">${field('e', 'E-MAIL', 'email', 'email', 'autocapitalize="off"')}${field('p', 'HASŁO', 'password', 'current-password')}
      <div class="err" id="m" role="alert">${note ? escHtml(note) : ''}</div><button id="b">Wejdź do aplikacji</button></form>`,
    denied: `<p>Konto <b>${escHtml(user?.email || '')}</b> czeka na aktywację. Damy znać, gdy będzie gotowe.</p>
      <button id="out">Zaloguj się innym kontem</button>`,
    invite: `<p>Zaproszenie dla <b>${escHtml(email || '')}</b>. Ustaw hasło — to wszystko.</p>
      <form id="f" data-mode="invite" data-token="${escHtml(token || '')}">${field('n', 'IMIĘ (OPCJONALNIE)', 'text', 'given-name', 'maxlength="60" data-optional')}${field('p', 'HASŁO (MIN. 8 ZNAKÓW)', 'password', 'new-password', 'minlength="8"')}
      <div class="err" id="m" role="alert"></div><button id="b">Przyjmij zaproszenie</button></form>`,
    change: `<p>Konto <b>${escHtml(user?.email || '')}</b> ma hasło startowe. Ustaw własne, żeby przejść dalej.</p>
      <form id="f" data-mode="change">${field('c', 'OBECNE HASŁO', 'password', 'current-password')}${field('p', 'NOWE HASŁO (MIN. 8 ZNAKÓW)', 'password', 'new-password', 'minlength="8"')}
      <div class="err" id="m" role="alert"></div><button id="b">Zapisz i wejdź</button></form>`
  };
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#000000">
<meta name="robots" content="noindex,nofollow"><link rel="manifest" href="/app.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="+1"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="icon" href="/favicon.svg">
<title>+1</title>
<style>
*{box-sizing:border-box;margin:0}body{min-height:100dvh;display:grid;place-items:center;background:#000;color:#fff;
font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:max(24px,env(safe-area-inset-top)) 22px max(24px,env(safe-area-inset-bottom))}
main{width:100%;max-width:380px;display:flex;flex-direction:column;gap:16px}form{display:flex;flex-direction:column;gap:12px}
svg{width:84px;height:84px;border-radius:22px;align-self:center;margin-bottom:6px}
h1{font-size:40px;line-height:1.02;letter-spacing:-.035em;text-align:center;font-weight:700}h1 span{color:#FF0059}
p{color:rgba(255,255,255,.66);text-align:center;font-size:15px}
.reg{font-size:15px;color:rgba(255,255,255,.66);margin-top:4px}.reg a{color:#FF0059;font-weight:700;text-decoration:none;font-size:15px}
a.site{color:rgba(255,255,255,.4);font-size:13px;text-decoration:none;letter-spacing:.04em}
label{display:flex;flex-direction:column;gap:6px;font-size:12px;letter-spacing:.06em;color:rgba(255,255,255,.7)}
input{height:52px;border-radius:14px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#fff;padding:0 16px;font:inherit;outline:0}
input:focus{border-color:#FF0059}button{height:54px;border:0;border-radius:16px;background:#FF0059;color:#000;font-weight:700;font-size:16px;cursor:pointer}
button:disabled{opacity:.6}.err{color:#ff7aa5;font-size:14px;text-align:center;min-height:20px}a{color:rgba(255,255,255,.6);text-align:center;font-size:14px}
</style></head><body><main>
<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#000"/><g fill="#FF0059" transform="translate(6.45 8.3)"><rect x="13.7" y="34.8" width="40.1" height="14"/><rect x="27.4" y="22.9" width="13.2" height="37.6"/><rect x="59.4" y="22.9" width="14" height="37.6"/></g></svg>
<h1>${mode === 'invite' ? 'Witaj w +1' : mode === 'change' ? 'Nowe hasło' : mode === 'denied' ? 'Już prawie' : 'Gdzie dziś<br><span>idziemy?</span>'}</h1>
${forms[mode]}
<p id="ios" style="display:none;font-size:13px">Dodaj +1 do ekranu: w Safari stuknij <b>Udostępnij</b> → <b>Do ekranu początkowego</b>.</p>
${mode === 'login' ? '<p class="reg">Nie masz konta? <a href="/?web&amp;register" target="_blank" rel="noopener">Zarejestruj się</a></p>' : ''}
<a class="site" href="/?web" target="_blank" rel="noopener">plusoneapp.pl</a>
</main><script>
const $=id=>document.getElementById(id),f=$('f'),o=$('out');
if(/iphone|ipad|ipod/i.test(navigator.userAgent)&&!navigator.standalone) $('ios').style.display='block';
const post=(u,d)=>fetch(u,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})
  .then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Coś poszło nie tak.');return j;});
if(f) f.onsubmit=async ev=>{ev.preventDefault();const b=$('b'),m=$('m'),k=f.dataset.mode;b.disabled=true;m.textContent='';
  try{
    if(k==='login') await post('/api/auth/login',{email:$('e').value.trim(),password:$('p').value});
    if(k==='invite'){ await post('/api/invite/accept',{token:f.dataset.token,name:$('n').value.trim(),password:$('p').value}); location.replace('/app'); return; }
    if(k==='change') await post('/api/me/password',{current:$('c').value,password:$('p').value});
    location.reload();
  }catch(e){m.textContent=e.message;b.disabled=false;}};
if(o) o.onclick=async()=>{await post('/api/auth/logout',{}).catch(()=>{});location.reload();};
</script></body></html>`;
};

async function preview(req, env) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Vary': 'Cookie' };
  if (!env.DB) return new Response('Podgląd jest chwilowo niedostępny. <a href="/?web" target="_blank">Wróć do witryny</a>', { status: 503, headers });
  const url = new URL(req.url), token = url.searchParams.get('invite');
  if (token) {
    const inv = await findInvite(env, token);
    if (inv) return new Response(gatePage({ mode: 'invite', email: inv.email, token }), { headers });
  }
  const user = await currentUser(req, env);
  const note = token ? 'Zaproszenie wygasło albo zostało już użyte. Zaloguj się.' : '';
  if (!user) return new Response(gatePage({ mode: 'login', note }), { status: 401, headers });
  if (user.must_change) return new Response(gatePage({ mode: 'change', user }), { status: 403, headers });
  if (!await canPreview(env, user)) return new Response(gatePage({ mode: 'denied', user }), { status: 403, headers });
  return new Response(previewHtml, { headers });
}

/* POST /api/admin/users/:id/perms { preview?, curate?, admin?, owner? } — admin nadaje tester/moderator,
   tylko główny administrator nadaje i odbiera admina oraz rolę głównego administratora */
async function adminSetPerms(req, env, user, id) {
  const b = await body(req);
  const t = await env.DB.prepare('SELECT id, role, owner FROM users WHERE id = ?').bind(+id).first();
  if (!t) return fail(404, 'Nie ma takiego użytkownika.');
  if (t.owner && !isOwner(user)) return fail(403, 'Uprawnienia głównego administratora zmienia tylko inny główny administrator.');
  if ((b.admin !== undefined || b.owner !== undefined) && !isOwner(user)) return fail(403, 'Admina nadaje i odbiera tylko główny administrator.');
  if (t.id === user.id && (b.admin === false || b.owner === false)) return fail(400, 'Nie możesz odebrać uprawnień sam sobie.');
  if (b.owner === false && t.owner && (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE owner = 1').first('n')) <= 1)
    return fail(400, 'Musi zostać co najmniej jeden główny administrator.');
  const ops = [];
  if (typeof b.preview === 'boolean') ops.push(b.preview
    ? env.DB.prepare('INSERT OR IGNORE INTO preview_access (user_id, granted_at) VALUES (?, ?)').bind(t.id, Date.now())
    : env.DB.prepare('DELETE FROM preview_access WHERE user_id = ?').bind(t.id));
  if (typeof b.curate === 'boolean') ops.push(env.DB.prepare('UPDATE users SET perm_curate = ? WHERE id = ?').bind(b.curate ? 1 : 0, t.id));
  if (typeof b.admin === 'boolean') ops.push(env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.admin ? 'admin' : 'user', t.id));
  if (typeof b.owner === 'boolean') ops.push(env.DB.prepare('UPDATE users SET owner = ?' + (b.owner ? ", role = 'admin'" : '') + ' WHERE id = ?').bind(b.owner ? 1 : 0, t.id));
  if (!ops.length) return fail(400, 'Brak zmian.');
  await env.DB.batch(ops);
  return json({ ok: true });
}

/* ---------------- zaproszenia ---------------- */
const INVITE_DAYS = 14;
/* link zawsze po https (poza lokalnym testem) */
const siteUrl = (req, path) => { const u = new URL(path, req.url); if (u.hostname !== 'localhost') u.protocol = 'https:'; return u.href; };
const inviteLink = (req, token) => siteUrl(req, '/app?invite=' + token);
const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));

/* ---------------- poczta ----------------
   Najpierw serwer SMTP ustawiony w panelu (Panel admina → Poczta), awaryjnie Resend (sekrety RESEND_API_KEY, MAIL_FROM).
   Bez żadnego z nich admin dostaje link do przekazania ręcznie. */
async function mailConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'smtp'").first().catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
const hasMailer = async env => !!(await mailConfig(env))?.host || !!(env.RESEND_API_KEY && env.MAIL_FROM);

async function sendMail(env, to, subject, text, html, { raise = false } = {}) {
  const cfg = await mailConfig(env);
  try {
    if (cfg?.host) { await smtpSend(cfg, { to, subject, text, html }); return true; }
    if (env.RESEND_API_KEY && env.MAIL_FROM) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, html })
      });
      if (!r.ok) throw new Error('Resend: ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return true;
    }
    if (raise) throw new Error('Poczta nie jest skonfigurowana.');
    return false;
  } catch (e) {
    console.error('mail', e);
    if (raise) throw e;
    return false;
  }
}

/* GET/POST/DELETE /api/admin/mail — ustawienia SMTP; hasło nigdy nie wraca do przeglądarki */
async function adminMailGet(env) {
  const c = await mailConfig(env);
  return json({ smtp: c ? { host: c.host, port: c.port, secure: c.secure, user: c.user, from: c.from, fromName: c.fromName, hasPass: !!c.pass } : null,
    resend: !!(env.RESEND_API_KEY && env.MAIL_FROM) });
}
async function adminMailSave(req, env) {
  const b = await body(req), old = await mailConfig(env) || {};
  const host = cleanText(b.host, 200).toLowerCase(), port = +b.port, from = cleanEmail(b.from);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return fail(400, 'Podaj adres serwera, np. smtp.twojadomena.pl');
  if (![465, 587, 2525, 25].includes(port)) return fail(400, 'Port: 465 (SSL) albo 587 (STARTTLS).');
  if (port === 25) return fail(400, 'Port 25 jest zablokowany w Cloudflare — użyj 465 albo 587.');
  if (!EMAIL_RE.test(from)) return fail(400, 'Podaj adres nadawcy.');
  const cfg = { host, port, secure: ['ssl', 'starttls', 'none'].includes(b.secure) ? b.secure : (port === 465 ? 'ssl' : 'starttls'),
    user: cleanText(b.user, 200), pass: b.pass ? String(b.pass).slice(0, 500) : old.pass || '', from, fromName: cleanText(b.fromName, 80) || '+1' };
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('smtp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(cfg)).run();
  return adminMailGet(env);
}
async function adminMailTest(req, env, user) {
  const b = await body(req), to = EMAIL_RE.test(cleanEmail(b.to)) ? cleanEmail(b.to) : user.email;
  try {
    await sendMail(env, to, 'Test poczty +1', 'Działa! Zaproszenia z +1 będą wychodzić z tego adresu.',
      '<div style="font:16px/1.6 sans-serif"><b>Działa!</b> Zaproszenia z +1 będą wychodzić z tego adresu.</div>', { raise: true });
    return json({ ok: true, to });
  } catch (e) { return fail(502, e.message); }
}

const inviteMail = (link, by, perms) => {
  const what = [perms.preview && 'aplikacji +1', perms.curate && 'moderowania wydarzeń', perms.admin && 'panelu administratora'].filter(Boolean).join(', ');
  const text = `Cześć!\n\n${by} zaprasza Cię do +1 — dostęp do: ${what}.\n\nOtwórz link, ustaw hasło i gotowe (link ważny ${INVITE_DAYS} dni):\n${link}\n\nNa iPhonie otwórz go w Safari, a potem Udostępnij → Do ekranu początkowego.\n\n+1 · plusoneapp.pl`;
  const html = `<div style="font:16px/1.6 -apple-system,Segoe UI,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">
<div style="width:56px;height:56px;border-radius:14px;background:#000;color:#FF0059;font:700 28px/56px sans-serif;text-align:center">+1</div>
<h1 style="font-size:24px;margin:20px 0 8px">Zaproszenie do +1</h1>
<p>${by.replace(/[<>&]/g, '')} zaprasza Cię — dostęp do: <b>${what}</b>.</p>
<p><a href="${link}" style="display:inline-block;background:#FF0059;color:#000;padding:14px 22px;border-radius:12px;font-weight:700;text-decoration:none">Przyjmij zaproszenie</a></p>
<p style="color:#666;font-size:14px">Link jest ważny ${INVITE_DAYS} dni. Na iPhonie otwórz go w Safari, potem Udostępnij → Do ekranu początkowego.</p></div>`;
  return { subject: 'Zaproszenie do +1', text, html };
};

/* POST /api/admin/invites { email, preview, curate, admin } */
async function adminInvite(req, env, user) {
  const b = await body(req);
  const email = cleanEmail(b.email);
  if (!EMAIL_RE.test(email) || email.length > 200) return fail(400, 'Podaj poprawny adres e-mail.');
  const perms = { preview: b.preview !== false, curate: !!b.curate, admin: !!b.admin };
  if (perms.admin && !isOwner(user)) return fail(403, 'Admina może zaprosić tylko główny administrator.');
  const by = user.name || user.email;

  // konto już istnieje: od razu nadajemy uprawnienia i wysyłamy powiadomienie z linkiem do aplikacji
  const ex = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (ex) {
    const ops = [];
    if (perms.preview) ops.push(env.DB.prepare('INSERT OR IGNORE INTO preview_access (user_id, granted_at) VALUES (?, ?)').bind(ex.id, Date.now()));
    if (perms.curate) ops.push(env.DB.prepare('UPDATE users SET perm_curate = 1 WHERE id = ?').bind(ex.id));
    if (perms.admin) ops.push(env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(ex.id));
    if (ops.length) await env.DB.batch(ops);
    const link = siteUrl(req, '/app'), m = inviteMail(link, by, perms);
    const emailed = await sendMail(env, email, m.subject, m.text, m.html);
    return json({ ok: true, existing: true, link, emailed, mail: { subject: m.subject, text: m.text } });
  }

  const token = randomToken(), now = Date.now();
  await env.DB.prepare('INSERT INTO invites (token_hash, email, preview, curate, admin, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), email, +perms.preview, +perms.curate, +perms.admin, user.id, now, now + INVITE_DAYS * DAY).run();
  const link = inviteLink(req, token), m = inviteMail(link, by, perms);
  const emailed = await sendMail(env, email, m.subject, m.text, m.html);
  return json({ ok: true, existing: false, link, emailed, mail: { subject: m.subject, text: m.text } }, 201);
}

async function adminInvites(req, env) {
  const { results } = await env.DB.prepare(
    `SELECT i.rowid AS id, i.email, i.preview, i.curate, i.admin, i.created_at, i.expires_at, i.used_at, u.email AS by_email
     FROM invites i LEFT JOIN users u ON u.id = i.invited_by ORDER BY i.created_at DESC LIMIT 100`).all();
  return json({ invites: results, mailer: await hasMailer(env) });
}

async function adminRevokeInvite(req, env, id) {
  await env.DB.prepare('DELETE FROM invites WHERE rowid = ? AND used_at IS NULL').bind(+id).run();
  return json({ ok: true });
}

async function findInvite(env, token) {
  if (!token || token.length > 100) return null;
  return env.DB.prepare('SELECT rowid AS id, * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').bind(await sha256(token), Date.now()).first();
}

/* POST /api/invite/accept { token, name, password } — zakłada konto z uprawnieniami z zaproszenia */
async function acceptInvite(req, env) {
  const b = await body(req);
  const inv = await findInvite(env, String(b.token || ''));
  if (!inv) return fail(410, 'Zaproszenie wygasło albo zostało już użyte.');
  const password = String(b.password || ''), name = cleanText(b.name, 60);
  if (password.length < 8) return fail(400, 'Hasło musi mieć co najmniej 8 znaków.');
  if (password.length > 200) return fail(400, 'Hasło jest za długie.');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(inv.email).first())
    return fail(409, 'To konto już istnieje — zaloguj się.');
  const now = Date.now();
  const res = await env.DB.prepare('INSERT INTO users (email, name, pass, role, perm_curate, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(inv.email, name, await hashPassword(password), inv.admin ? 'admin' : 'user', inv.curate, now, now).run();
  const id = res.meta.last_row_id;
  await env.DB.batch([
    env.DB.prepare('UPDATE invites SET used_at = ? WHERE rowid = ?').bind(now, inv.id),
    ...(inv.preview ? [env.DB.prepare('INSERT OR IGNORE INTO preview_access (user_id, granted_at) VALUES (?, ?)').bind(id, now)] : [])
  ]);
  return json({ ok: true }, 201, { 'Set-Cookie': await startSession(env, id) });
}

async function adminCurate(req, env, user) {
  const b = await body(req);
  const id = String(b.eventId || '');
  if (!EVENT_ID_RE.test(id)) return fail(400, 'Złe wydarzenie.');
  if (b.action === 'hide' || b.action === 'feature') {
    await env.DB.prepare('INSERT INTO curation (event_id, action, by_user, at) VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET action = excluded.action, by_user = excluded.by_user, at = excluded.at')
      .bind(id, b.action, user.id, Date.now()).run();
  } else {
    await env.DB.prepare('DELETE FROM curation WHERE event_id = ?').bind(id).run();
  }
  return json({ ok: true });
}

/* ---------------- router ---------------- */
async function api(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  // zmiany stanu tylko z naszej strony (ochrona przed CSRF)
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return fail(403, 'Niedozwolone źródło żądania.');
    if (!(req.headers.get('Content-Type') || '').includes('application/json')) return fail(415, 'Wymagany JSON.');
  }

  if (path === '/api/health') return json({ ok: true, db: !!env.DB });
  if (!env.DB) return fail(503, 'Baza danych nie jest jeszcze podłączona.');

  if (path === '/api/state' && m === 'GET') return publicState(env);
  if (path === '/api/auth/register' && m === 'POST') return register(req, env);
  if (path === '/api/auth/login' && m === 'POST') return login(req, env);
  if (path === '/api/auth/logout' && m === 'POST') return logout(req, env);
  if (path === '/api/invite/accept' && m === 'POST') return acceptInvite(req, env);

  const user = await currentUser(req, env);
  if (path === '/api/preview-access' && m === 'GET') return json({ allowed: await canPreview(env, user) });
  if (path === '/api/me' && m === 'GET') return me(req, env, user);
  if (!user) return fail(401, 'Zaloguj się.');

  if (path === '/api/me/password' && m === 'POST') return changePassword(req, env, user);
  if (path === '/api/me' && m === 'PATCH') return updateMe(req, env, user);
  if (path === '/api/me' && m === 'DELETE') return deleteMe(req, env, user);
  if (path === '/api/saved' && m === 'POST') return toggleSaved(req, env, user);

  if (path.startsWith('/api/admin/')) {
    // konto z hasłem startowym: najpierw nowe hasło
    if (user.must_change) return fail(403, 'Najpierw ustaw nowe hasło (Konto → Zmień hasło).');
    if (path === '/api/admin/curation' && m === 'POST') {
      if (!canCurate(user)) return fail(403, 'Brak uprawnień moderatora.');
      return adminCurate(req, env, user);
    }
    if (!isAdmin(user)) return fail(403, 'Tylko dla admina.');
    if (path === '/api/admin/stats' && m === 'GET') return adminStats(req, env);
    if (path === '/api/admin/users' && m === 'GET') return adminUsers(req, env);
    const previewUser = path.match(/^\/api\/admin\/users\/(\d+)\/preview$/);
    if (previewUser && m === 'POST') return adminPreviewAccess(req, env, previewUser[1]);
    const r = path.match(/^\/api\/admin\/users\/(\d+)\/perms$/);
    if (r && m === 'POST') return adminSetPerms(req, env, user, r[1]);
    if (path === '/api/admin/invites' && m === 'GET') return adminInvites(req, env);
    if (path.startsWith('/api/admin/mail')) {
      if (!isOwner(user)) return fail(403, 'Pocztę ustawia główny administrator.');
      if (path === '/api/admin/mail' && m === 'GET') return adminMailGet(env);
      if (path === '/api/admin/mail' && m === 'POST') return adminMailSave(req, env);
      if (path === '/api/admin/mail' && m === 'DELETE') { await env.DB.prepare("DELETE FROM settings WHERE key = 'smtp'").run(); return adminMailGet(env); }
      if (path === '/api/admin/mail/test' && m === 'POST') return adminMailTest(req, env, user);
    }
    if (path === '/api/admin/invites' && m === 'POST') return adminInvite(req, env, user);
    const inv = path.match(/^\/api\/admin\/invites\/(\d+)$/);
    if (inv && m === 'DELETE') return adminRevokeInvite(req, env, inv[1]);
  }
  return fail(404, 'Nie znaleziono.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // stary adres aplikacji testowej
    if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) return Response.redirect(new URL('/app', url), 301);
    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
      try { return await preview(req, env); }
      catch (e) { console.error(e); return new Response('Podgląd jest chwilowo niedostępny.', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
    }
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env); }
      catch (e) { console.error(e); return fail(500, 'Coś poszło nie tak. Spróbuj ponownie.'); }
    }
    return env.ASSETS.fetch(req);
  }
};
