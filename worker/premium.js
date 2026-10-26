/* +1 — funkcje premium aplikacji (API) i zadania w tle (cron).
   Obserwowanie (wydarzenie / miasto / okolica), powiadomienia i alerty mailem, znajomi („Idziesz z kimś?”),
   panel organizatora z listą gości, newsletter „Na topie w Twoim mieście”, reset hasła, wykrywanie serwera poczty.
   Dane wydarzeń bierzemy z public/data/events.json (env.ASSETS). Schemat: migrations/0007_premium.sql. */
/* narzędzia z worker/index.js (przekazane przez initPremium — główny moduł Workera może eksportować tylko obsługę żądań) */
let json, fail, body, sha256, randomToken, hashPassword, startSession, cleanText, cleanEmail, EMAIL_RE, DAY, siteUrl,
  sendMail, savedIds, isAdmin, isOwner, isOrg, parseList, escHtml, ticketCode, warsawMidnight;
export function initPremium(h) {
  ({ json, fail, body, sha256, randomToken, hashPassword, startSession, cleanText, cleanEmail, EMAIL_RE, DAY, siteUrl,
    sendMail, savedIds, isAdmin, isOwner, isOrg, parseList, escHtml, ticketCode, warsawMidnight } = h);
}

import { vapidKeys, pushUser } from './push.js';
import { socialApi } from './social.js';

const SITE = 'https://plusoneapp.pl';
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const seriesKey = e => fold(e.title) + '|' + e.city + '|' + fold(e.venue);

/* ---------------- wydarzenia (events.json, pamięć podręczna na 10 min) ---------------- */
let EV = null, EV_AT = 0;
export async function loadEvents(env) {
  if (EV && Date.now() - EV_AT < 10 * 60e3) return EV;
  const r = await env.ASSETS.fetch(new Request(SITE + '/data/events.json'));
  const d = await r.json();
  EV = { list: d.events, byId: new Map(d.events.map(e => [e.id, e])), geo: d.geo || {} };
  EV_AT = Date.now();
  return EV;
}
const today = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10); // dzień w Polsce (w przybliżeniu)

/* zainteresowania → które wydarzenia do nich pasują (te same klucze co INTERESTS w public/premium.js) */
const txt = e => fold([e.title, e.venue, ...(e.tags || []), ...(e.artists || [])].join(' '));
const KINO = /\b(kino|film|seans|pokaz filmu|premiera filmu)/;
const INTEREST = {
  clubbing: e => e.category === 'Clubs',
  koncerty: e => e.category === 'Concerts',
  festiwale: e => e.category === 'Festivals',
  teatr: e => e.category === 'Theatre',
  standup: e => e.category === 'Comedy',
  kino: e => KINO.test(txt(e)),
  sztuka: e => e.category === 'Culture' && !KINO.test(txt(e)),
  klasyka: e => /filharmon|opera|symfoni|orkiestr|recital|chopin|klasyk/.test(txt(e)),
  sport: e => e.category === 'Sport',
  dzieci: e => e.category === 'Family' || /dla dzieci|rodzinn/.test(txt(e)),
  rap: e => /\brap|hip.?hop|trap\b/.test(txt(e)),
  rock: e => /\brock|metal|punk|grunge/.test(txt(e)),
  jazz: e => /jazz|blues|swing|soul/.test(txt(e)),
  techno: e => /techno|house|electro|rave|\bdj\b|drum.?n.?bass|trance/.test(txt(e)) || e.category === 'Clubs',
  pop: e => /\bpop\b|k-pop/.test(txt(e))
};
const matchesInterests = (e, keys) => keys.some(k => INTEREST[k] && INTEREST[k](e));

/* odległość w km między miastami (współrzędne z geo: [x, y, woj., lat, lon]) */
function km(geo, a, b) {
  const p = geo[a], q = geo[b];
  if (!p || !q || p[3] == null || q[3] == null) return a === b ? 0 : Infinity;
  const r = Math.PI / 180, dLat = (q[3] - p[3]) * r, dLon = (q[4] - p[4]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p[3] * r) * Math.cos(q[3] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/* ---------------- obserwowane ---------------- */
async function follows(env, user) {
  const { results } = await env.DB.prepare('SELECT kind, value, radius FROM follows WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all();
  return json({ follows: results });
}
async function setFollow(req, env, user) {
  const b = await body(req);
  const kind = ['event', 'city', 'area'].includes(b.kind) ? b.kind : null, value = cleanText(b.value, 120);
  if (!kind || !value) return fail(400, 'Co obserwować?');
  if (b.on === false) await env.DB.prepare('DELETE FROM follows WHERE user_id = ? AND kind = ? AND value = ?').bind(user.id, kind, value).run();
  else {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?').bind(user.id).first('n');
    if (n >= 300) return fail(400, 'Obserwujesz już 300 rzeczy.');
    const radius = kind === 'area' ? Math.min(150, Math.max(5, +b.radius || 30)) : 0;
    await env.DB.prepare(`INSERT INTO follows (user_id, kind, value, radius, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, kind, value) DO UPDATE SET radius = excluded.radius`).bind(user.id, kind, value, radius, Date.now()).run();
  }
  return follows(env, user);
}

/* ---------------- powiadomienia ---------------- */
async function notifications(env, user) {
  const { results } = await env.DB.prepare('SELECT id, kind, title, body, event_id, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 60').bind(user.id).all();
  return json({ notifications: results, unread: results.filter(n => !n.read_at).length });
}
const notify = (env, userId, kind, title, bodyText, eventId, dedup) =>
  env.DB.prepare('INSERT OR IGNORE INTO notifications (user_id, kind, title, body, event_id, dedup, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(userId, kind, title, bodyText || '', eventId || null, dedup || null, Date.now());

/* ---------------- „Idziesz z kimś?” ---------------- */
async function crewInvite(req, env, user) {
  const b = await body(req), id = String(b.eventId || '').slice(0, 140);
  if (!id) return fail(400, 'Złe wydarzenie.');
  const token = randomToken();
  await env.DB.prepare('INSERT INTO crew_invites (token_hash, event_id, from_user, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), id, user.id, Date.now(), Date.now() + 30 * DAY).run();
  return json({ link: siteUrl(req, '/app?join=' + token) });
}
async function findCrew(env, token) {
  if (!token || token.length > 100) return null;
  return env.DB.prepare(`SELECT c.event_id, c.from_user, u.name, u.email FROM crew_invites c JOIN users u ON u.id = c.from_user
    WHERE c.token_hash = ? AND c.expires_at > ?`).bind(await sha256(token), Date.now()).first();
}
/* GET /api/crew/join?token= — publiczne: kto zaprasza i na co */
export async function crewInfo(req, env) {
  const c = await findCrew(env, new URL(req.url).searchParams.get('token'));
  if (!c) return fail(410, 'Zaproszenie wygasło.');
  return json({ eventId: c.event_id, from: c.name || c.email.split('@')[0] });
}
async function crewJoin(req, env, user) {
  const b = await body(req), c = await findCrew(env, String(b.token || ''));
  if (!c) return fail(410, 'Zaproszenie wygasło.');
  const now = Date.now(), ops = [
    env.DB.prepare(`INSERT INTO saved (user_id, event_id, created_at, kind) VALUES (?, ?, ?, 'going')
      ON CONFLICT(user_id, event_id) DO UPDATE SET kind = 'going'`).bind(user.id, c.event_id, now)
  ];
  if (c.from_user !== user.id) {
    ops.push(env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').bind(user.id, c.from_user, now));
    ops.push(env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').bind(c.from_user, user.id, now));
    const ev = (await loadEvents(env)).byId.get(c.event_id);
    ops.push(notify(env, c.from_user, 'crew', `${user.name || user.email.split('@')[0]} idzie z Tobą`, ev ? ev.title : '', c.event_id, `crew:${user.id}:${c.event_id}`));
  }
  await env.DB.batch(ops);
  if (c.from_user !== user.id) await pushUser(env, c.from_user, { urgency: 'high' });
  return json({ ok: true, eventId: c.event_id, ...await savedIds(env, user.id) });
}
async function crewForEvent(req, env, user) {
  const id = new URL(req.url).searchParams.get('event') || '';
  const { results } = await env.DB.prepare(`SELECT u.id, u.name, u.email FROM friends f JOIN users u ON u.id = f.friend_id
    JOIN saved s ON s.user_id = u.id AND s.event_id = ? AND s.kind = 'going' WHERE f.user_id = ? LIMIT 50`).bind(id, user.id).all();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM saved WHERE event_id = ? AND kind = 'going'").bind(id).first('n');
  return json({ friends: results.map(f => ({ id: f.id, name: f.name || f.email.split('@')[0] })), going: total });
}
async function friendsList(env, user) {
  const { results } = await env.DB.prepare(`SELECT u.id, u.name, u.email, f.created_at FROM friends f JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 200`).bind(user.id).all();
  return json({ friends: results.map(f => ({ id: f.id, name: f.name || f.email.split('@')[0], since: f.created_at })) });
}

/* ---------------- organizator ---------------- */
async function venuesOf(env, userId) {
  const { results } = await env.DB.prepare('SELECT venue FROM org_venues WHERE user_id = ?').bind(userId).all();
  return results.map(r => r.venue);
}
/* wydarzenia organizatora: miejsce albo nazwa wydarzenia pasuje do jego listy (od 30 dni wstecz) */
async function orgEvents(env, venues) {
  const ev = await loadEvents(env), keys = venues.map(fold).filter(k => k.length > 2), from = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  return ev.list.filter(e => (e.end || e.start).slice(0, 10) >= from && keys.some(k => fold(e.venue).includes(k) || fold(e.title).includes(k)));
}
/* jak countBy, ale zwraca wiersze (np. dzienne kubełki) z dwoma parametrami czasu przed listą wydarzeń */
async function countRows(env, sql, ids, from) {
  const out = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(sql.replace('(?)', '(' + part.map(() => '?').join(',') + ')')).bind(from, from, ...part).all();
    out.push(...results);
  }
  return out;
}
async function countBy(env, sql, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(sql.replace('(?)', '(' + part.map(() => '?').join(',') + ')')).bind(...part).all();
    for (const r of results) out[r.event_id] = r;
  }
  return out;
}
async function orgTarget(req, env, user) {
  const q = new URL(req.url).searchParams.get('user');
  if (q && +q !== user.id) {
    if (!isAdmin(user)) return null;
    return env.DB.prepare('SELECT id, name, email FROM users WHERE id = ? AND perm_org = 1').bind(+q).first();
  }
  return { id: user.id, name: user.name, email: user.email };
}
async function orgDashboard(req, env, user) {
  const t = await orgTarget(req, env, user);
  if (!t) return fail(404, 'Nie ma takiego organizatora.');
  const venues = await venuesOf(env, t.id), events = await orgEvents(env, venues), ids = events.map(e => e.id);
  const [saved, tickets, guests, fol] = await Promise.all([
    countBy(env, "SELECT event_id, SUM(kind = 'going') AS going, SUM(kind = 'saved') AS saves FROM saved WHERE event_id IN (?) GROUP BY event_id", ids),
    countBy(env, 'SELECT event_id, COUNT(*) AS tickets, SUM(used_at IS NOT NULL) AS used FROM tickets WHERE event_id IN (?) GROUP BY event_id', ids),
    countBy(env, 'SELECT event_id, COUNT(*) AS guests, SUM(used_at IS NOT NULL) AS guests_used FROM guests WHERE event_id IN (?) GROUP BY event_id', ids),
    countBy(env, "SELECT value AS event_id, COUNT(*) AS followers FROM follows WHERE kind = 'event' AND value IN (?) GROUP BY value", ids)
  ]);
  // dzienne zainteresowanie wydarzeniami organizatora z 30 dni: zapisy, „Mam bilet”, wejścia
  const from = warsawMidnight(29), series = { saves: Array(30).fill(0), going: Array(30).fill(0), scans: Array(30).fill(0) };
  const bucket = (sql, fn) => countRows(env, sql, ids, from).then(rs => rs.forEach(r => { if (r.d >= 0 && r.d < 30) fn(r); }));
  await Promise.all([
    bucket(`SELECT CAST((created_at - ?) / ${DAY} AS INTEGER) AS d, SUM(kind = 'saved') AS s, SUM(kind = 'going') AS g FROM saved WHERE created_at >= ? AND event_id IN (?) GROUP BY d`,
      r => { series.saves[r.d] += +r.s || 0; series.going[r.d] += +r.g || 0; }),
    bucket(`SELECT CAST((used_at - ?) / ${DAY} AS INTEGER) AS d, COUNT(*) AS n FROM tickets WHERE used_at >= ? AND event_id IN (?) GROUP BY d`, r => { series.scans[r.d] += r.n; }),
    bucket(`SELECT CAST((used_at - ?) / ${DAY} AS INTEGER) AS d, COUNT(*) AS n FROM guests WHERE used_at >= ? AND event_id IN (?) GROUP BY d`, r => { series.scans[r.d] += r.n; })
  ]);
  const rows = events.map(e => ({ id: e.id, title: e.title, start: e.start, venue: e.venue, city: e.city, hot: e.hot || 0, image: e.image || null, priceFrom: e.priceFrom ?? null,
    going: +(saved[e.id]?.going || 0), saves: +(saved[e.id]?.saves || 0), followers: +(fol[e.id]?.followers || 0),
    tickets: +(tickets[e.id]?.tickets || 0), used: +(tickets[e.id]?.used || 0), guests: +(guests[e.id]?.guests || 0), guestsUsed: +(guests[e.id]?.guests_used || 0) }));
  return json({ organizer: t, venues, events: rows, series, seriesFrom: from });
}
async function canTouchEvent(env, user, eventId) {
  if (isAdmin(user)) return true;
  const e = (await loadEvents(env)).byId.get(eventId);
  if (!e) return false;
  const keys = (await venuesOf(env, user.id)).map(fold);
  return keys.some(k => k.length > 2 && (fold(e.venue).includes(k) || fold(e.title).includes(k)));
}
async function guestList(req, env, user) {
  const id = new URL(req.url).searchParams.get('event') || '';
  if (!await canTouchEvent(env, user, id)) return fail(403, 'To nie Twoje wydarzenie.');
  const { results } = await env.DB.prepare('SELECT code, name, email, created_at, used_at FROM guests WHERE event_id = ? ORDER BY created_at DESC').bind(id).all();
  return json({ guests: results });
}
async function addGuest(req, env, user) {
  const b = await body(req), id = String(b.eventId || ''), name = cleanText(b.name, 80), email = cleanEmail(b.email);
  if (!name) return fail(400, 'Podaj imię i nazwisko gościa.');
  if (email && !EMAIL_RE.test(email)) return fail(400, 'Zły adres e-mail.');
  if (!await canTouchEvent(env, user, id)) return fail(403, 'To nie Twoje wydarzenie.');
  const code = ticketCode(), e = (await loadEvents(env)).byId.get(id);
  const zone = b.zone && (await zonesOf(env, id)).some(z => z.key === b.zone) ? b.zone : null;
  await env.DB.prepare('INSERT INTO guests (code, event_id, org_user, name, email, zone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(code, id, user.id, name, email || null, zone, Date.now()).run();
  let emailed = false;
  if (email) {
    const link = siteUrl(req, '/t/' + code);
    emailed = await sendMail(env, email, `Twoje wejście: ${e ? e.title : 'wydarzenie'}`,
      `Cześć ${name}!\n\nJesteś na liście gości${e ? ': ' + e.title + ', ' + e.venue : ''}.\nTwój bilet z kodem QR: ${link}\n\nPokaż go przy wejściu.\n\n+1 · plusoneapp.pl`,
      `<div style="font:16px/1.6 -apple-system,Segoe UI,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">
       <div style="width:56px;height:56px;border-radius:14px;background:#000;color:#FF0059;font:700 28px/56px sans-serif;text-align:center">+1</div>
       <h1 style="font-size:24px;margin:20px 0 8px">Jesteś na liście gości</h1><p>${escHtml(e ? e.title + ' · ' + e.venue : '')}</p>
       <p><a href="${link}" style="display:inline-block;background:#FF0059;color:#000;padding:14px 22px;border-radius:12px;font-weight:700;text-decoration:none">Pokaż bilet z kodem QR</a></p></div>`);
  }
  return json({ ok: true, code, link: siteUrl(req, '/t/' + code), emailed });
}
async function removeGuest(req, env, user) {
  const b = await body(req), g = await env.DB.prepare('SELECT event_id FROM guests WHERE code = ?').bind(String(b.code || '')).first();
  if (!g || !await canTouchEvent(env, user, g.event_id)) return fail(404, 'Nie ma takiego gościa.');
  await env.DB.prepare('DELETE FROM guests WHERE code = ?').bind(String(b.code)).run();
  return json({ ok: true });
}
/* skan: kod z listy gości (wywoływane z /api/scan, gdy kod nie jest biletem użytkownika) */
export async function scanGuest(env, user, code, undo) {
  const g = await env.DB.prepare('SELECT g.*, s.email AS by_email FROM guests g LEFT JOIN users s ON s.id = g.used_by WHERE g.code = ?').bind(code).first();
  if (!g) return json({ status: 'invalid', message: 'Nie ma takiego biletu.' });
  const who = { name: g.name + ' · lista gości', email: g.email, eventId: g.event_id, zone: await zoneInfo(env, g.event_id, g.zone) };
  if (undo) { await env.DB.prepare('UPDATE guests SET used_at = NULL, used_by = NULL WHERE code = ?').bind(code).run(); return json({ status: 'undone', ...who }); }
  if (g.used_at) return json({ status: 'used', usedAt: g.used_at, usedBy: g.by_email, ...who });
  await env.DB.prepare('UPDATE guests SET used_at = ?, used_by = ? WHERE code = ? AND used_at IS NULL').bind(Date.now(), user.id, code).run();
  return json({ status: 'ok', ...who });
}
/* strona biletu gościa: /t/<kod> (bez logowania; kod jest długi i losowy) */
export async function guestTicketPage(env, code) {
  const g = /^P1-[\w-]{8,40}$/.test(code) ? await env.DB.prepare('SELECT * FROM guests WHERE code = ?').bind(code).first() : null;
  const e = g && (await loadEvents(env)).byId.get(g.event_id), z = g && await zoneInfo(env, g.event_id, g.zone);
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><link rel="stylesheet" href="/vendor/fonts/fonts.css"><title>Bilet +1</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#000;color:#fff;
font:16px/1.5 'Space Grotesk',system-ui,-apple-system,sans-serif;padding:24px;text-align:center}main{max-width:360px;display:flex;flex-direction:column;gap:12px;align-items:center}
#q{width:260px;height:260px;background:#fff;border-radius:22px;padding:16px;box-sizing:border-box}#q svg{width:100%;height:100%}
small{color:#FF0059;letter-spacing:.14em;font-weight:700}p{color:rgba(255,255,255,.7);margin:0}</style></head><body><main>
${g ? `<small style="${z ? 'color:' + z.color : ''}">BILET +1 · ${z ? 'STREFA ' + escHtml(z.name.toUpperCase()) : 'LISTA GOŚCI'}</small><h2 style="margin:0">${escHtml(e ? e.title : 'Wydarzenie')}</h2><p>${escHtml(e ? e.venue + ' · ' + e.start.replace('T', ' ') : '')}</p>
<div id="q" style="${z ? 'box-shadow:0 0 0 6px ' + z.color : ''}"></div><b>${escHtml(g.name)}</b><p style="font-family:'JetBrains Mono',monospace">${escHtml(code)}</p><p>${g.used_at ? 'Bilet został już użyty.' : 'Pokaż kod przy wejściu.'}</p>
<script src="/vendor/qr/qrcode.js"></script><script>var q=qrcode(0,'M');q.addData(${JSON.stringify(code)});q.make();document.getElementById('q').innerHTML=q.createSvgTag({cellSize:6,margin:0,scalable:true});</script>`
  : '<h2>Nie ma takiego biletu</h2><p>Sprawdź link od organizatora.</p>'}
<a href="/" style="color:rgba(255,255,255,.5)">plusoneapp.pl</a></main></body></html>`;
  return new Response(html, { status: g ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' } });
}

/* lista organizatorów dla admina: ile wydarzeń, ile osób idzie */
export async function adminOrganizers(env) {
  const { results } = await env.DB.prepare(`SELECT u.id, u.name, u.email, (SELECT json_group_array(venue) FROM org_venues o WHERE o.user_id = u.id) AS venues
    FROM users u WHERE u.perm_org = 1 ORDER BY u.created_at DESC LIMIT 500`).all();
  const t = today(), out = [];
  for (const o of results) {
    const venues = parseList(o.venues), events = (await orgEvents(env, venues)).filter(e => (e.end || e.start).slice(0, 10) >= t);
    const ids = events.map(e => e.id), going = ids.length ? await countBy(env, "SELECT event_id, SUM(kind = 'going') AS going FROM saved WHERE event_id IN (?) GROUP BY event_id", ids) : {};
    out.push({ id: o.id, name: o.name, email: o.email, venues, upcoming: events.length, going: Object.values(going).reduce((s, r) => s + (+r.going || 0), 0) });
  }
  return json({ organizers: out });
}

/* ---------------- reset hasła ---------------- */
export async function forgotPassword(req, env) {
  const b = await body(req), email = cleanEmail(b.email);
  const u = EMAIL_RE.test(email) && await env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
  if (u) {
    const token = randomToken();
    await env.DB.prepare('INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), u.id, Date.now() + 3600e3).run();
    const link = siteUrl(req, '/app?reset=' + token);
    await sendMail(env, email, 'Nowe hasło do +1', `Ustaw nowe hasło (link ważny godzinę):\n${link}\n\nJeśli to nie Ty, zignoruj tę wiadomość.`,
      `<div style="font:16px/1.6 sans-serif;max-width:480px;margin:auto;padding:24px"><h2>Nowe hasło do +1</h2><p><a href="${link}" style="display:inline-block;background:#FF0059;color:#000;padding:14px 22px;border-radius:12px;font-weight:700;text-decoration:none">Ustaw nowe hasło</a></p><p style="color:#666;font-size:14px">Link jest ważny godzinę. Jeśli to nie Ty, zignoruj tę wiadomość.</p></div>`);
  }
  // zawsze ta sama odpowiedź — nie zdradzamy, czy konto istnieje
  return json({ ok: true });
}
export async function findReset(env, token) {
  if (!token || token.length > 100) return null;
  return env.DB.prepare('SELECT r.user_id, u.email FROM resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.expires_at > ?').bind(await sha256(token), Date.now()).first();
}
export async function resetPassword(req, env) {
  const b = await body(req), r = await findReset(env, String(b.token || '')), pass = String(b.password || '');
  if (!r) return fail(410, 'Link wygasł. Poproś o nowy.');
  if (pass.length < 8) return fail(400, 'Hasło musi mieć co najmniej 8 znaków.');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass = ?, must_change = 0 WHERE id = ?').bind(await hashPassword(pass), r.user_id),
    env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(r.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(r.user_id)
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(env, r.user_id) });
}

/* ---------------- poczta: podpowiedź serwera po adresie (rekordy MX) ---------------- */
const PROVIDERS = [
  [/google\.com|googlemail/, { provider: 'Google (Gmail / Workspace)', host: 'smtp.gmail.com', port: 465, note: 'Potrzebne hasło aplikacji (Konto Google → Bezpieczeństwo → Hasła do aplikacji).' }],
  [/outlook\.com|office365|microsoft/, { provider: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, note: 'Na koncie musi być włączone „SMTP AUTH”.' }],
  [/home\.pl/, { provider: 'home.pl', host: '', port: 465, note: 'Serwer SMTP (np. serwer123456.home.pl) jest w panelu home.pl → Poczta → Konfiguracja programu.' }],
  [/ovh\./, { provider: 'OVH', host: 'ssl0.ovh.net', port: 465 }],
  [/zoho/, { provider: 'Zoho', host: 'smtp.zoho.eu', port: 465 }],
  [/cyberfolks|cfolks/, { provider: 'cyber_Folks', host: '', port: 465, note: 'Serwer SMTP znajdziesz w panelu cyber_Folks (np. s123.cyber-folks.pl).' }],
  [/nazwa\.pl/, { provider: 'nazwa.pl', host: '', port: 465, note: 'Serwer SMTP: w panelu nazwa.pl (np. serwer1234567.nazwa.pl).' }],
  [/icloud|me\.com/, { provider: 'iCloud', host: 'smtp.mail.me.com', port: 587 }],
  [/wp\.pl/, { provider: 'WP Poczta', host: 'smtp.wp.pl', port: 465 }],
  [/onet|op\.pl/, { provider: 'Onet Poczta', host: 'smtp.poczta.onet.pl', port: 465 }],
  [/interia/, { provider: 'Interia', host: 'poczta.interia.pl', port: 465 }]
];
export async function mailDetect(req) {
  const email = cleanEmail(new URL(req.url).searchParams.get('email')), domain = email.split('@')[1];
  if (!EMAIL_RE.test(email)) return fail(400, 'Podaj adres e-mail.');
  let mx = '';
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { headers: { Accept: 'application/dns-json' } });
    mx = ((await r.json()).Answer || []).map(a => a.data).join(' ').toLowerCase();
  } catch {}
  const hit = PROVIDERS.find(([re]) => re.test(mx) || re.test(domain));
  return json({ mx, ...(hit ? hit[1] : { provider: '', host: 'mail.' + domain, port: 465, note: 'Nie rozpoznaliśmy dostawcy — sprawdź serwer SMTP w ustawieniach poczty.' }) });
}

/* ---------------- newsletter „Na topie w Twoim mieście” ---------------- */
function topFor(ev, city, days = 7, n = 8) {
  const t = today(), lim = new Date(Date.now() + days * DAY).toISOString().slice(0, 10), seen = new Set();
  return ev.list.filter(e => e.city === city && e.start.slice(0, 10) >= t && e.start.slice(0, 10) <= lim)
    .sort((a, b) => (b.hot || 0) - (a.hot || 0)).filter(e => { const k = seriesKey(e); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, n);
}
function newsletterMail(city, list) {
  const rows = list.map(e => `• ${e.title} — ${e.start.slice(8, 10)}.${e.start.slice(5, 7)} ${e.start.slice(11, 16)} · ${e.venue}`).join('\n');
  const html = `<div style="font:16px/1.5 -apple-system,Segoe UI,sans-serif;max-width:560px;margin:auto;padding:24px;color:#111">
    <div style="width:56px;height:56px;border-radius:14px;background:#000;color:#FF0059;font:700 28px/56px sans-serif;text-align:center">+1</div>
    <h1 style="font-size:26px;margin:18px 0 4px">Na topie: ${escHtml(city)}</h1><p style="color:#666;margin:0 0 16px">Najfajniejsze wydarzenia na najbliższy tydzień</p>
    ${list.map(e => `<a href="${SITE}/?web" style="display:flex;gap:14px;align-items:center;padding:12px 0;border-top:1px solid #eee;color:#111;text-decoration:none">
      ${e.image ? `<img src="${escHtml(e.image)}" width="64" height="64" style="border-radius:12px;object-fit:cover;flex:none" alt="">` : ''}
      <span><b>${escHtml(e.title)}</b><br><span style="color:#666;font-size:14px">${e.start.slice(8, 10)}.${e.start.slice(5, 7)} ${e.start.slice(11, 16)} · ${escHtml(e.venue)}</span></span></a>`).join('')}
    <p style="margin-top:20px"><a href="${SITE}/app" style="display:inline-block;background:#FF0059;color:#000;padding:14px 22px;border-radius:12px;font-weight:700;text-decoration:none">Otwórz +1</a></p>
    <p style="color:#999;font-size:12px">Newsletter wyłączysz w aplikacji: Konto → Powiadomienia.</p></div>`;
  return { subject: `Na topie w ${city} w tym tygodniu`, text: `Na topie: ${city}\n\n${rows}\n\n${SITE}`, html };
}
async function sendNewsletter(env, users) {
  const ev = await loadEvents(env), week = new Date().toISOString().slice(0, 10);
  let sent = 0;
  for (const u of users) {
    const list = topFor(ev, u.city || 'Warszawa');
    if (!list.length) continue;
    const m = newsletterMail(u.city || 'Warszawa', list);
    if (await sendMail(env, u.email, m.subject, m.text, m.html)) sent++;
    await notify(env, u.id, 'info', m.subject, list.slice(0, 3).map(e => e.title).join(' · '), list[0].id, 'news:' + week).run();
  }
  return sent;
}
export async function adminNewsletter(req, env, user) {
  const b = await body(req);
  if (b.test) return json({ sent: await sendNewsletter(env, [user]), test: true });
  const { results } = await env.DB.prepare('SELECT id, email, city FROM users WHERE newsletter = 1 LIMIT 2000').all();
  return json({ sent: await sendNewsletter(env, results), of: results.length });
}

/* ---------------- alerty (cron co kilka godzin) ----------------
   nowe wydarzenia z Twoich zainteresowań w obserwowanych miastach/okolicach (albo w Twoim mieście),
   tańsze bilety na obserwowane i wcześniej odwiedzane wydarzenia, przypomnienie dzień przed. */
async function runAlerts(env) {
  const ev = await loadEvents(env), now = Date.now(), since = now - 26 * 3600e3, t = today();
  const tomorrow = new Date(now + 2 * 3600e3 + DAY).toISOString().slice(0, 10);
  const { results: users } = await env.DB.prepare('SELECT id, email, name, city, interests, notify_email, last_alert_mail FROM users LIMIT 5000').all();
  const { results: fol } = await env.DB.prepare('SELECT user_id, kind, value, radius FROM follows').all();
  const { results: sav } = await env.DB.prepare('SELECT user_id, event_id, kind FROM saved').all();
  const by = (rows) => rows.reduce((m, r) => ((m[r.user_id] = m[r.user_id] || []).push(r), m), {});
  const F = by(fol), SV = by(sav);
  const fresh = ev.list.filter(e => e.firstSeen && Date.parse(e.firstSeen) >= since && e.start.slice(0, 10) >= t);
  const cheaper = ev.list.filter(e => e.priceDrop && Date.parse(e.priceDrop.at) >= since && e.start.slice(0, 10) >= t);
  let made = 0, mailed = 0, pushed = 0;
  for (const u of users) {
    const interests = parseList(u.interests), f = F[u.id] || [], s = SV[u.id] || [], ops = [], items = [];
    const followedEv = new Set(f.filter(x => x.kind === 'event').map(x => x.value));
    let places = f.filter(x => x.kind !== 'event');
    if (!places.length && u.city) places = [{ kind: 'city', value: u.city, radius: 0 }];
    const near = e => places.some(p => p.kind === 'city' ? e.city === p.value : km(ev.geo, p.value, e.city) <= p.radius);
    if (interests.length) {
      for (const e of fresh.filter(e => near(e) && matchesInterests(e, interests)).sort((a, b) => (b.hot || 0) - (a.hot || 0)).slice(0, 6)) {
        ops.push(notify(env, u.id, 'new', 'Nowe: ' + e.title, `${e.start.slice(8, 10)}.${e.start.slice(5, 7)} · ${e.venue}, ${e.city}`, e.id, 'new:' + e.id)); items.push(e.title);
      }
    }
    // „już odwiedzałeś”: ta sama seria (tytuł + miejsce) co Twoje wcześniejsze „Mam bilet”
    const mine = new Set(s.map(x => ev.byId.get(x.event_id)).filter(Boolean).map(seriesKey));
    for (const e of cheaper.filter(e => followedEv.has(e.id) || mine.has(seriesKey(e)))) {
      ops.push(notify(env, u.id, 'price', 'Taniej: ' + e.title, `teraz od ${e.priceFrom} zł (było ${e.priceDrop.was} zł)`, e.id, `price:${e.id}:${e.priceFrom}`)); items.push('Taniej: ' + e.title);
    }
    for (const id of new Set([...followedEv, ...s.filter(x => x.kind === 'going').map(x => x.event_id)])) {
      const e = ev.byId.get(id);
      if (e && e.start.slice(0, 10) === tomorrow) { ops.push(notify(env, u.id, 'reminder', 'Jutro: ' + e.title, `${e.start.slice(11, 16)} · ${e.venue}`, e.id, 'rem:' + e.id)); items.push('Jutro: ' + e.title); }
    }
    if (!ops.length) continue;
    const res = await env.DB.batch(ops), added = res.reduce((n, r) => n + (r.meta.changes || 0), 0);
    made += added;
    if (added) pushed += await pushUser(env, u.id);
    // mail: najwyżej raz na ~20 h, tylko jeśli doszło coś nowego
    if (added && u.notify_email && (!u.last_alert_mail || now - u.last_alert_mail > 20 * 3600e3)) {
      const ok = await sendMail(env, u.email, items.length === 1 ? items[0] : `${items.length} nowości dla Ciebie w +1`,
        `${items.join('\n')}\n\nZobacz w aplikacji: ${SITE}/app\nAlerty wyłączysz w Konto → Powiadomienia.`,
        `<div style="font:16px/1.6 sans-serif;max-width:520px;margin:auto;padding:24px"><h2 style="margin:0 0 10px">Dla Ciebie w +1</h2>${items.map(x => `<p style="margin:6px 0">• ${escHtml(x)}</p>`).join('')}
         <p><a href="${SITE}/app" style="display:inline-block;background:#FF0059;color:#000;padding:12px 20px;border-radius:12px;font-weight:700;text-decoration:none">Otwórz aplikację</a></p>
         <p style="color:#999;font-size:12px">Alerty wyłączysz w Konto → Powiadomienia.</p></div>`);
      if (ok) { mailed++; await env.DB.prepare('UPDATE users SET last_alert_mail = ? WHERE id = ?').bind(now, u.id).run(); }
    }
  }
  console.log(`alerty: ${made} powiadomień, ${mailed} maili, ${pushed} push`);
}

export const NEWSLETTER_CRON = '3 8 * * 4'; // czwartek ok. 10:00 w Polsce
export async function scheduled(event, env) {
  if (!env.DB) return;
  if (event.cron === NEWSLETTER_CRON) {
    const { results } = await env.DB.prepare('SELECT id, email, city FROM users WHERE newsletter = 1 LIMIT 2000').all();
    console.log('newsletter:', await sendNewsletter(env, results));
  } else await runAlerts(env);
}
export { runAlerts };

/* ---------------- przewodnik po wydarzeniu i komunikaty do uczestników ----------------
   Uczestnik = ma bilet +1 albo „Mam bilet” na to wydarzenie. Edytuje i wysyła administrator albo organizator tego wydarzenia. */
const GUIDE_KINDS = ['stage', 'bar', 'wc', 'coat', 'exit', 'info', 'food', 'medic'];
const ZONE_COLORS = ['#F5B73B', '#B8BCC6', '#8B5CF6', '#14B8A6', '#3B82F6', '#EF4444', '#22C55E', '#EC4899'];
/* strefy wydarzenia: [{key, name, color}] */
async function zonesOf(env, eventId) {
  return parseList((await env.DB.prepare('SELECT zones FROM event_guides WHERE event_id = ?').bind(eventId).first())?.zones);
}
export async function zoneInfo(env, eventId, key) {
  if (!key) return null;
  const z = (await zonesOf(env, eventId)).find(x => x.key === key);
  return z ? { key: z.key, name: z.name, color: z.color } : null;
}
const MAP_MAX = 900 * 1024;
async function participantIds(env, eventId, audience) {
  const sql = audience === 'inside'
    ? 'SELECT user_id AS id FROM tickets WHERE event_id = ? AND used_at IS NOT NULL'
    : "SELECT user_id AS id FROM tickets WHERE event_id = ?1 UNION SELECT user_id AS id FROM saved WHERE event_id = ?1 AND kind = 'going'";
  return (await env.DB.prepare(sql).bind(eventId).all()).results.map(r => r.id);
}
async function guideAccess(env, user, eventId) {
  const edit = await canTouchEvent(env, user, eventId) && (isAdmin(user) || !!user.perm_org);
  if (edit || user.perm_scan) return { edit, ticket: null };
  const ticket = await env.DB.prepare('SELECT code, used_at, zone FROM tickets WHERE user_id = ? AND event_id = ?').bind(user.id, eventId).first();
  const going = ticket || await env.DB.prepare("SELECT 1 FROM saved WHERE user_id = ? AND event_id = ? AND kind = 'going'").bind(user.id, eventId).first();
  return going ? { edit: false, ticket } : null;
}
async function guideGet(req, env, user) {
  const id = new URL(req.url).searchParams.get('event') || '';
  const acc = await guideAccess(env, user, id);
  if (!acc) return fail(403, 'Przewodnik po wydarzeniu jest dla osób z biletem. Kliknij „Mam bilet”.');
  const [g, posts, e] = await Promise.all([
    env.DB.prepare('SELECT info, schedule, points, zones, map_ratio, map_image IS NOT NULL AS has_map, updated_at FROM event_guides WHERE event_id = ?').bind(id).first(),
    env.DB.prepare(`SELECT p.id, p.title, p.body, p.audience, p.channel, p.recipients, p.created_at,
      (SELECT COUNT(*) FROM event_mail_queue q WHERE q.post_id = p.id AND q.sent_at IS NOT NULL) AS mailed
      FROM event_posts p WHERE p.event_id = ? ORDER BY p.created_at DESC LIMIT 50`).bind(id).all(),
    loadEvents(env).then(ev => ev.byId.get(id))
  ]);
  const inside = !!acc.ticket?.used_at;
  const out = { event: e ? { id: e.id, title: e.title, start: e.start, end: e.end, venue: e.venue, address: e.address, city: e.city, image: e.image } : { id },
    guide: { info: g?.info || '', schedule: parseList(g?.schedule), points: parseList(g?.points), zones: parseList(g?.zones), hasMap: !!g?.has_map, mapRatio: g?.map_ratio || null, updatedAt: g?.updated_at || null },
    posts: posts.results.filter(p => p.audience === 'all' || inside || acc.edit),
    mailer: acc.edit ? !!(await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'smtp'").first() || (env.RESEND_API_KEY && env.MAIL_FROM)) : undefined,
    ticket: acc.ticket ? { code: acc.ticket.code, usedAt: acc.ticket.used_at, zone: parseList(g?.zones).find(z => z.key === acc.ticket.zone) || null } : null, canEdit: acc.edit };
  if (acc.edit) {
    const t = (await env.DB.prepare('SELECT zone, COUNT(*) AS n FROM tickets WHERE event_id = ? AND zone IS NOT NULL GROUP BY zone').bind(id).all()).results;
    const gz = (await env.DB.prepare('SELECT zone, COUNT(*) AS n FROM guests WHERE event_id = ? AND zone IS NOT NULL GROUP BY zone').bind(id).all()).results;
    out.zoneCounts = {}; for (const r of [...t, ...gz]) out.zoneCounts[r.zone] = (out.zoneCounts[r.zone] || 0) + r.n;
  }
  if (acc.edit) out.audience = { all: (await participantIds(env, id, 'all')).length, inside: (await participantIds(env, id, 'inside')).length };
  return json(out);
}
async function guideMap(req, env, user) {
  const id = new URL(req.url).searchParams.get('event') || '';
  if (!await guideAccess(env, user, id)) return fail(403, 'Brak dostępu.');
  const g = await env.DB.prepare('SELECT map_image FROM event_guides WHERE event_id = ?').bind(id).first();
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(g?.map_image || '');
  if (!m) return fail(404, 'Brak planu.');
  const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=300' } });
}
async function guideSave(req, env, user) {
  const b = await body(req), id = String(b.eventId || '');
  if (!(await guideAccess(env, user, id))?.edit) return fail(403, 'Przewodnik edytuje administrator albo organizator tego wydarzenia.');
  const schedule = (Array.isArray(b.schedule) ? b.schedule : []).slice(0, 40)
    .map(x => ({ time: cleanText(x.time, 20), title: cleanText(x.title, 120) })).filter(x => x.title);
  const num = v => Math.min(100, Math.max(0, Math.round((+v || 0) * 10) / 10));
  const points = (Array.isArray(b.points) ? b.points : []).slice(0, 40)
    .map(x => ({ x: num(x.x), y: num(x.y), label: cleanText(x.label, 60), kind: GUIDE_KINDS.includes(x.kind) ? x.kind : 'info' })).filter(x => x.label);
  // akapity zostają: czyścimy każdą linię osobno
  const info = String(b.info || '').replace(/\r/g, '').split('\n').map(l => cleanText(l, 400)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
  let map = undefined;
  if (b.map === null) map = null;
  else if (typeof b.map === 'string') {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.map)) return fail(400, 'Plan musi być obrazkiem JPG, PNG albo WebP.');
    if (b.map.length > MAP_MAX * 1.37) return fail(400, 'Plan jest za duży. Wybierz mniejszy obrazek.');
    map = b.map;
  }
  const ratio = +b.mapRatio > 0 && +b.mapRatio < 10 ? +b.mapRatio : null;
  const zones = (Array.isArray(b.zones) ? b.zones : []).slice(0, 8).map(z => ({ key: String(z.key || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24),
    name: cleanText(z.name, 30), color: ZONE_COLORS.includes(z.color) ? z.color : ZONE_COLORS[0] })).filter(z => z.key && z.name);
  await env.DB.prepare(`INSERT INTO event_guides (event_id, info, schedule, points, zones, map_image, map_ratio, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET info = excluded.info, schedule = excluded.schedule, points = excluded.points, zones = excluded.zones,
      ${map === undefined ? '' : 'map_image = excluded.map_image, map_ratio = excluded.map_ratio,'} updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(id, info, JSON.stringify(schedule), JSON.stringify(points), JSON.stringify(zones), map ?? null, map ? ratio : null, Date.now(), user.id).run();
  // usunięta strefa: jej bilety wracają do wejścia ogólnego
  const keys = zones.map(z => z.key);
  for (const tb of ['tickets', 'guests'])
    await env.DB.prepare(`UPDATE ${tb} SET zone = NULL WHERE event_id = ? AND zone IS NOT NULL${keys.length ? ` AND zone NOT IN (${keys.map(() => '?').join(',')})` : ''}`).bind(id, ...keys).run();
  return json({ ok: true });
}
/* POST /api/guide/zone { eventId, zone ('' = wejście ogólne), emails[] } — przypisuje strefę biletom kont i gościom z listy */
async function guideZone(req, env, user) {
  const b = await body(req), id = String(b.eventId || ''), zone = String(b.zone || '');
  if (!(await guideAccess(env, user, id))?.edit) return fail(403, 'Strefy przypisuje administrator albo organizator tego wydarzenia.');
  if (zone && !(await zonesOf(env, id)).some(z => z.key === zone)) return fail(400, 'Najpierw zapisz strefę w przewodniku.');
  const emails = [...new Set((Array.isArray(b.emails) ? b.emails : []).map(cleanEmail).filter(e => EMAIL_RE.test(e)))].slice(0, 500);
  if (!emails.length) return fail(400, 'Wpisz adresy e-mail (po przecinku albo w osobnych liniach).');
  let updated = 0; const found = new Set();
  for (const email of emails) {
    const u = await env.DB.prepare("SELECT u.id FROM users u WHERE u.email = ? AND (EXISTS(SELECT 1 FROM tickets t WHERE t.user_id = u.id AND t.event_id = ?) OR EXISTS(SELECT 1 FROM saved s WHERE s.user_id = u.id AND s.event_id = ? AND s.kind = 'going'))")
      .bind(email, id, id).first();
    if (u) {
      // bilet tworzymy od razu, gdy ktoś ma „Mam bilet”, ale nie otworzył jeszcze kodu QR
      await env.DB.prepare('INSERT OR IGNORE INTO tickets (code, user_id, event_id, created_at) VALUES (?, ?, ?, ?)').bind(ticketCode(), u.id, id, Date.now()).run();
      updated += (await env.DB.prepare('UPDATE tickets SET zone = ? WHERE user_id = ? AND event_id = ?').bind(zone || null, u.id, id).run()).meta.changes; found.add(email);
    }
    const g = (await env.DB.prepare('UPDATE guests SET zone = ? WHERE event_id = ? AND email = ?').bind(zone || null, id, email).run()).meta.changes;
    if (g) { updated += g; found.add(email); }
  }
  return json({ ok: true, updated, notFound: emails.filter(e => !found.has(e)) });
}
async function guideNotify(req, env, user) {
  const b = await body(req), id = String(b.eventId || ''), audience = b.audience === 'inside' ? 'inside' : 'all';
  const channel = ['push', 'mail', 'both'].includes(b.channel) ? b.channel : 'push';
  if (!(await guideAccess(env, user, id))?.edit) return fail(403, 'Komunikaty wysyła administrator albo organizator tego wydarzenia.');
  const title = cleanText(b.title, 120);
  const text = String(b.body || '').replace(/\r/g, '').split('\n').map(l => cleanText(l, 600)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, channel === 'push' ? 400 : 3000);
  if (!title) return fail(400, 'Wpisz tytuł komunikatu.');
  if (channel !== 'push' && !(await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'smtp'").first() || (env.RESEND_API_KEY && env.MAIL_FROM)))
    return fail(400, 'Poczta nie jest jeszcze podłączona. Administrator ustawia ją w Panel admina → Główny e-mail.');
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM event_posts WHERE event_id = ? AND created_at > ?').bind(id, Date.now() - 3600e3).first('n');
  if (recent >= 10) return fail(429, 'Wysłano już 10 komunikatów w tej godzinie. Spróbuj później.');
  const ids = await participantIds(env, id, audience);
  // maile: konta z biletem + goście z listy organizatora (z adresem)
  let mails = [];
  if (channel !== 'push') {
    const users = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      users.push(...(await env.DB.prepare(`SELECT email, name FROM users WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results);
    }
    const guests = (await env.DB.prepare(`SELECT email, name FROM guests WHERE event_id = ? AND email IS NOT NULL AND email <> ''${audience === 'inside' ? ' AND used_at IS NOT NULL' : ''}`).bind(id).all()).results;
    const seen = new Set();
    mails = [...users, ...guests].filter(r => r.email && !seen.has(r.email.toLowerCase()) && seen.add(r.email.toLowerCase()));
  }
  const total = channel === 'mail' ? mails.length : Math.max(ids.length, mails.length);
  const res = await env.DB.prepare('INSERT INTO event_posts (event_id, title, body, audience, channel, recipients, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, title, text, audience, channel, total, user.id, Date.now()).run();
  const post = res.meta.last_row_id;
  let pushed = 0;
  if (channel !== 'mail') {
    const short = text.length > 400 ? text.slice(0, 397) + '…' : text;
    for (let i = 0; i < ids.length; i += 50) await env.DB.batch(ids.slice(i, i + 50).map(u => notify(env, u, 'event', title, short, id, 'post:' + post)));
    for (const u of ids.slice(0, 300)) pushed += await pushUser(env, u, { urgency: 'high' });
  }
  for (let i = 0; i < mails.length; i += 50)
    await env.DB.batch(mails.slice(i, i + 50).map(r => env.DB.prepare('INSERT OR IGNORE INTO event_mail_queue (post_id, email, name) VALUES (?, ?, ?)').bind(post, r.email, r.name || '')));
  const m = mails.length ? await mailBatch(req, env, post) : { sent: 0, failed: 0, remaining: 0 };
  return json({ ok: true, post, recipients: ids.length, pushed, mails: mails.length, ...m });
}
/* wysyła kolejną partię maili komunikatu (limit połączeń na jedno żądanie Workera) */
async function mailBatch(req, env, post) {
  const p = await env.DB.prepare('SELECT * FROM event_posts WHERE id = ?').bind(post).first();
  const e = p && (await loadEvents(env)).byId.get(p.event_id);
  const { results } = await env.DB.prepare('SELECT email, name FROM event_mail_queue WHERE post_id = ? AND sent_at IS NULL AND failed < 2 LIMIT 20').bind(post).all();
  const link = siteUrl(req, '/?guide=' + encodeURIComponent(p.event_id));
  const when = e ? new Date(e.start + ':00').toLocaleString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  const paras = p.body ? p.body.split(/\n{2,}/).map(x => `<p style="margin:0 0 14px">${escHtml(x).replace(/\n/g, '<br>')}</p>`).join('') : '';
  let sent = 0, failed = 0;
  for (const r of results) {
    const hi = r.name ? `Cześć ${r.name.split(' ')[0]}!` : 'Cześć!';
    const text = `${hi}\n\n${p.title}\n\n${p.body ? p.body + '\n\n' : ''}${e ? e.title + '\n' + when + ' · ' + e.venue + '\n\n' : ''}Przewodnik po wydarzeniu: ${link}\n\n+1 · plusoneapp.pl`;
    const html = `<div style="font:16px/1.6 -apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111">
<div style="width:56px;height:56px;border-radius:14px;background:#000;color:#FF0059;font:700 28px/56px sans-serif;text-align:center">+1</div>
${e ? `<p style="margin:22px 0 0;color:#FF0059;font:700 12px/1.4 monospace;letter-spacing:.12em;text-transform:uppercase">${escHtml(e.title)}</p><p style="margin:4px 0 0;color:#666;font-size:14px">${escHtml(when)} · ${escHtml(e.venue)}</p>` : ''}
<h1 style="font-size:24px;line-height:1.2;margin:18px 0 12px">${escHtml(p.title)}</h1><p style="margin:0 0 14px">${escHtml(hi)}</p>${paras}
<p style="margin:22px 0"><a href="${link}" style="display:inline-block;background:#FF0059;color:#000;padding:14px 22px;border-radius:12px;font-weight:700;text-decoration:none">Plan, harmonogram i komunikaty</a></p>
<p style="color:#888;font-size:13px">Dostajesz tę wiadomość, bo masz bilet na to wydarzenie w +1.</p></div>`;
    const ok = await sendMail(env, r.email, p.title, text, html);
    await env.DB.prepare(ok ? 'UPDATE event_mail_queue SET sent_at = ? WHERE post_id = ? AND email = ?' : 'UPDATE event_mail_queue SET failed = failed + 1 WHERE post_id = ? AND email = ? AND ? > 0')
      .bind(...(ok ? [Date.now(), post, r.email] : [post, r.email, 1])).run();
    ok ? sent++ : failed++;
  }
  const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM event_mail_queue WHERE post_id = ? AND sent_at IS NULL AND failed < 2').bind(post).first('n');
  const done = await env.DB.prepare('SELECT COUNT(*) AS n FROM event_mail_queue WHERE post_id = ? AND sent_at IS NOT NULL').bind(post).first('n');
  return { sent, failed, remaining, mailed: done };
}
async function guideMailContinue(req, env, user) {
  const b = await body(req), p = await env.DB.prepare('SELECT event_id FROM event_posts WHERE id = ?').bind(+b.post || 0).first();
  if (!p || !(await guideAccess(env, user, p.event_id))?.edit) return fail(403, 'Brak dostępu.');
  return json(await mailBatch(req, env, +b.post));
}
/* po wpuszczeniu: powitanie z linkiem do przewodnika (worker/index.js → scanTicket) */
export async function welcomeInside(env, userId, eventId) {
  const e = (await loadEvents(env)).byId.get(eventId);
  await notify(env, userId, 'checkin', 'Jesteś w środku' + (e ? ': ' + e.title : ''), 'Otwórz przewodnik: plan miejsca, harmonogram i komunikaty.', eventId, 'in:' + eventId).run();
  await pushUser(env, userId, { urgency: 'high' });
}

/* ---------------- router ---------------- */
export async function premiumApi(path, m, req, env, user) {
  if (path.startsWith('/api/social/')) return socialApi(path, m, req, env, user);
  if (path === '/api/follows' && m === 'GET') return follows(env, user);
  if (path === '/api/follows' && m === 'POST') return setFollow(req, env, user);
  if (path === '/api/notifications' && m === 'GET') return notifications(env, user);
  if (path === '/api/guide' && m === 'GET') return guideGet(req, env, user);
  if (path === '/api/guide' && m === 'POST') return guideSave(req, env, user);
  if (path === '/api/guide/map' && m === 'GET') return guideMap(req, env, user);
  if (path === '/api/guide/notify' && m === 'POST') return guideNotify(req, env, user);
  if (path === '/api/guide/mail' && m === 'POST') return guideMailContinue(req, env, user);
  if (path === '/api/guide/zone' && m === 'POST') return guideZone(req, env, user);
  if (path === '/api/push/key' && m === 'GET') return json({ publicKey: (await vapidKeys(env)).publicKey });
  if (path === '/api/push/subscribe' && m === 'POST') {
    const b = await body(req), ep = String(b.endpoint || '');
    if (!/^https:\/\/[\w.-]+\//.test(ep) || ep.length > 1000) return fail(400, 'Zła subskrypcja.');
    await env.DB.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, ua, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`).bind(ep, user.id, cleanText(b.keys?.p256dh, 200), cleanText(b.keys?.auth, 100),
      cleanText(req.headers.get('User-Agent'), 200), Date.now()).run();
    return json({ ok: true });
  }
  if (path === '/api/push/unsubscribe' && m === 'POST') {
    const b = await body(req);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint || ''), user.id).run();
    return json({ ok: true });
  }
  if (path === '/api/push/test' && m === 'POST') {
    await notify(env, user.id, 'info', 'Powiadomienia działają', 'Tak będziemy dawać znać o nowościach z Twoich zainteresowań.', null, 'pushtest:' + Date.now()).run();
    return json({ sent: await pushUser(env, user.id, { urgency: 'high' }) });
  }
  if (path === '/api/notifications/read' && m === 'POST') {
    await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(Date.now(), user.id).run();
    return notifications(env, user);
  }
  if (path === '/api/crew/invite' && m === 'POST') return crewInvite(req, env, user);
  if (path === '/api/crew/join' && m === 'POST') return crewJoin(req, env, user);
  if (path === '/api/crew' && m === 'GET') return crewForEvent(req, env, user);
  if (path === '/api/friends' && m === 'GET') return friendsList(env, user);
  if (path === '/api/wrapped' && m === 'GET') {
    const { results } = await env.DB.prepare("SELECT event_id, meta, created_at FROM saved WHERE user_id = ? AND kind = 'going' ORDER BY created_at").bind(user.id).all();
    const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND used_at IS NOT NULL').bind(user.id).first('n');
    const friends = await env.DB.prepare('SELECT COUNT(*) AS n FROM friends WHERE user_id = ?').bind(user.id).first('n');
    return json({ going: results.map(r => ({ id: r.event_id, at: r.created_at, ...(parseList('[' + (r.meta || '') + ']')[0] || {}) })), scanned: used, friends });
  }
  if (path.startsWith('/api/org/')) {
    if (!isOrg(user)) return fail(403, 'Panel organizatora jest dla organizatorów.');
    if (path === '/api/org/me' && m === 'GET') return orgDashboard(req, env, user);
    if (path === '/api/org/guests' && m === 'GET') return guestList(req, env, user);
    if (path === '/api/org/guests' && m === 'POST') return addGuest(req, env, user);
    if (path === '/api/org/guests' && m === 'DELETE') return removeGuest(req, env, user);
  }
  // test alertów na żądanie (główny administrator)
  if (path === '/api/admin/alerts/run' && m === 'POST' && isOwner(user)) { await runAlerts(env); return json({ ok: true }); }
  return null;
}
