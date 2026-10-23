/* +1 — API na Cloudflare Workers.
   /api/* obsługuje ten plik, resztę (apka, data/events.json) serwują statyczne pliki z public/.
   Baza: D1 (binding DB), schemat w migrations/. */

import previewHtml from '../private/app.html';

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
    `SELECT u.id, u.email, u.name, u.role, u.city, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256(token), Date.now()).first();
  return row || null;
}

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, city: u.city, createdAt: u.created_at });

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

async function deleteMe(req, env, user) {
  const b = await body(req);
  const u = await env.DB.prepare('SELECT pass FROM users WHERE id = ?').bind(user.id).first();
  if (!(await checkPassword(String(b.password || ''), u.pass))) return fail(401, 'Złe hasło.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM saved WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM preview_access WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('UPDATE curation SET by_user = NULL WHERE by_user = ?').bind(user.id),
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
    q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
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
    `SELECT u.id, u.email, u.name, u.role, u.city, u.created_at, u.last_seen,
            (SELECT COUNT(*) FROM saved s WHERE s.user_id = u.id) AS saves,
            EXISTS(SELECT 1 FROM preview_access p WHERE p.user_id = u.id) AS preview_access
     FROM users u WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ? ORDER BY u.created_at DESC LIMIT 200`).bind(q, q).all();
  return json({ users: results });
}

async function canPreview(env, user) {
  return !!user && (user.role === 'admin' || !!(await env.DB.prepare('SELECT 1 FROM preview_access WHERE user_id = ?').bind(user.id).first()));
}

async function adminPreviewAccess(req, env, id) {
  const b = await body(req);
  if (typeof b.allowed !== 'boolean') return fail(400, 'Podaj allowed: true lub false.');
  if (!await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(+id).first()) return fail(404, 'Nie ma takiego użytkownika.');
  if (b.allowed) await env.DB.prepare('INSERT OR IGNORE INTO preview_access (user_id, granted_at) VALUES (?, ?)').bind(+id, Date.now()).run();
  else await env.DB.prepare('DELETE FROM preview_access WHERE user_id = ?').bind(+id).run();
  return json({ ok: true, allowed: b.allowed });
}

/* Strona wejścia do aplikacji testowej. Ma własny formularz logowania, bo aplikacja dodana do ekranu
   iPhone'a nie widzi ciasteczek z Safari — tester loguje się raz, już wewnątrz aplikacji. */
const gatePage = (user) => `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#000000">
<meta name="robots" content="noindex,nofollow"><link rel="manifest" href="/app.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="+1"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="icon" href="/favicon.svg">
<title>+1 — aplikacja testowa</title>
<style>
*{box-sizing:border-box;margin:0}body{min-height:100dvh;display:grid;place-items:center;background:radial-gradient(120% 70% at 50% 0%,#2a0013,#000 60%);color:#fff;
font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:max(24px,env(safe-area-inset-top)) 22px max(24px,env(safe-area-inset-bottom))}
main{width:100%;max-width:380px;display:flex;flex-direction:column;gap:16px}
svg{width:72px;height:72px;border-radius:18px;align-self:center;margin-bottom:8px}
h1{font-size:28px;line-height:1.1;letter-spacing:-.02em;text-align:center}p{color:rgba(255,255,255,.7);text-align:center;font-size:15px}
label{display:flex;flex-direction:column;gap:6px;font-size:12px;letter-spacing:.06em;color:rgba(255,255,255,.7)}
input{height:52px;border-radius:14px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#fff;padding:0 16px;font:inherit;outline:0}
input:focus{border-color:#FF0059}button{height:54px;border:0;border-radius:16px;background:#FF0059;color:#000;font-weight:700;font-size:16px;cursor:pointer}
button:disabled{opacity:.6}.err{color:#ff7aa5;font-size:14px;text-align:center;min-height:20px}a{color:rgba(255,255,255,.6);text-align:center;font-size:14px}
</style></head><body><main>
<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#000"/><g fill="#FF0059" transform="translate(6.45 8.3)"><rect x="13.7" y="34.8" width="40.1" height="14"/><rect x="27.4" y="22.9" width="13.2" height="37.6"/><rect x="59.4" y="22.9" width="14" height="37.6"/></g></svg>
<h1>Aplikacja +1<br>dla testerów</h1>
${user
  ? `<p>Konto <b>${user.email.replace(/[<>&"]/g, '')}</b> nie ma jeszcze dostępu. Poproś administratora o zaproszenie do testów.</p>
     <button id="out">Zaloguj się innym kontem</button>`
  : `<p>Zaloguj się kontem, które dostało zaproszenie do testów.</p>
     <form id="f" style="display:flex;flex-direction:column;gap:12px">
       <label>E-MAIL<input id="e" type="email" autocomplete="email" autocapitalize="off" required></label>
       <label>HASŁO<input id="p" type="password" autocomplete="current-password" required></label>
       <div class="err" id="m" role="alert"></div>
       <button id="b">Wejdź do aplikacji</button>
     </form>`}
<a href="/">Przejdź do strony plusoneapp.pl</a>
</main><script>
const f=document.getElementById('f'),o=document.getElementById('out');
if(f) f.onsubmit=async ev=>{ev.preventDefault();const b=document.getElementById('b'),m=document.getElementById('m');b.disabled=true;m.textContent='';
  try{const r=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:document.getElementById('e').value.trim(),password:document.getElementById('p').value})});
    const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Nie udało się zalogować.');location.reload();}
  catch(e){m.textContent=e.message;b.disabled=false;}};
if(o) o.onclick=async()=>{await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).catch(()=>{});location.reload();};
</script></body></html>`;

async function preview(req, env) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Vary': 'Cookie' };
  if (!env.DB) return new Response('Podgląd jest chwilowo niedostępny. <a href="/">Wróć do witryny</a>', { status: 503, headers });
  const user = await currentUser(req, env);
  if (!await canPreview(env, user)) return new Response(gatePage(user), { status: user ? 403 : 401, headers });
  return new Response(previewHtml, { headers });
}

async function adminSetRole(req, env, user, id) {
  const b = await body(req);
  const role = b.role === 'admin' ? 'admin' : 'user';
  if (+id === user.id && role !== 'admin') return fail(400, 'Nie możesz odebrać admina sam sobie.');
  const r = await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, +id).run();
  if (!r.meta.changes) return fail(404, 'Nie ma takiego użytkownika.');
  return json({ ok: true, role });
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

  const user = await currentUser(req, env);
  if (path === '/api/preview-access' && m === 'GET') return json({ allowed: await canPreview(env, user) });
  if (path === '/api/me' && m === 'GET') return me(req, env, user);
  if (!user) return fail(401, 'Zaloguj się.');

  if (path === '/api/me' && m === 'PATCH') return updateMe(req, env, user);
  if (path === '/api/me' && m === 'DELETE') return deleteMe(req, env, user);
  if (path === '/api/saved' && m === 'POST') return toggleSaved(req, env, user);

  if (path.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return fail(403, 'Tylko dla admina.');
    if (path === '/api/admin/stats' && m === 'GET') return adminStats(req, env);
    if (path === '/api/admin/users' && m === 'GET') return adminUsers(req, env);
    const previewUser = path.match(/^\/api\/admin\/users\/(\d+)\/preview$/);
    if (previewUser && m === 'POST') return adminPreviewAccess(req, env, previewUser[1]);
    const r = path.match(/^\/api\/admin\/users\/(\d+)\/role$/);
    if (r && m === 'POST') return adminSetRole(req, env, user, r[1]);
    if (path === '/api/admin/curation' && m === 'POST') return adminCurate(req, env, user);
  }
  return fail(404, 'Nie znaleziono.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
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
