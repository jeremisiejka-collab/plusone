/* +1 — Panel założyciela: kto jest teraz na stronie, ile osób weszło, skąd i co klikali.
   Bez ciasteczek i bez zapisywania IP: osobę w danym dniu rozpoznajemy po skrócie (IP + przeglądarka + dzień + sól),
   który zmienia się codziennie. Miasto i kraj podaje Cloudflare (req.cf). Boty i podglądy linków są pomijane.
   POST /api/t — sygnały z przeglądarki (public/admin.js → STATS), GET /api/admin/live — dane panelu (tylko właściciel). */
const DAY = 864e5, LIVE_MS = 75e3, KEEP_DAYS = 90;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|node-fetch|axios|go-http/i;
const clean = (s, n = 60) => String(s ?? '').replace(/[\u0000-\u001f<>"`]/g, '').trim().slice(0, n) || null;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

function deviceOf(ua) {
  if (/iPad|Tablet|Nexus (7|9|10)|SM-T/i.test(ua)) return 'tablet';
  return /Mobi|Android|iPhone|iPod/i.test(ua) ? 'telefon' : 'komputer';
}
async function salt(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'stats_salt'").first();
  if (row) return row.value;
  const s = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('stats_salt', ?)").bind(s).run();
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'stats_salt'").first()).value;
}

/* POST /api/t { app, src, now: {s, e}, items: [{k: 'view'|'click', s, a, e, t}] } */
export async function track(req, env, json) {
  const ua = req.headers.get('User-Agent') || '';
  if (!ua || BOT.test(ua)) return json({ ok: true });
  let b; try { b = await req.json(); } catch { return json({ ok: true }); }
  const now = Date.now(), day = new Date(now + 3600e3).toISOString().slice(0, 10);
  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'local';
  const vid = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${ua}|${day}|${await salt(env)}`))).slice(0, 20);
  const cf = req.cf || {}, city = clean(cf.city ? cf.city + (cf.country && cf.country !== 'PL' ? ', ' + cf.country : '') : cf.country, 60);
  const device = deviceOf(ua), app = b.app ? 1 : 0, src = clean(b.src, 60) || 'bezpośrednio';
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).filter(x => x && (x.k === 'view' || x.k === 'click'));
  const ops = items.map(x => env.DB.prepare('INSERT INTO stat_hits (ts, vid, kind, screen, act, event_id, src, city, device, app) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(Math.min(now, Math.max(now - 120e3, +x.t || now)), vid, x.k, clean(x.s, 30), clean(x.a, 60), clean(x.e, 140), src, city, device, app));
  const n = b.now || {};
  ops.push(env.DB.prepare(`INSERT INTO stat_live (vid, last, first, screen, event_id, src, city, device, app) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vid) DO UPDATE SET last = excluded.last, screen = excluded.screen, event_id = excluded.event_id, city = excluded.city, device = excluded.device, app = excluded.app`)
    .bind(vid, now, now, clean(n.s, 30), clean(n.e, 140), src, city, device, app));
  if (b.bye) ops.push(env.DB.prepare('UPDATE stat_live SET last = ? WHERE vid = ?').bind(now - LIVE_MS, vid));
  await env.DB.batch(ops);
  return json({ ok: true });
}

const rows = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const top = (env, col, from, kind, limit = 10, extra = '') => rows(env,
  `SELECT ${col} AS k, COUNT(*) AS n, COUNT(DISTINCT vid) AS v FROM stat_hits WHERE ts >= ? AND ${col} IS NOT NULL ${kind ? 'AND kind = ?' : ''} ${extra} GROUP BY ${col} ORDER BY n DESC LIMIT ${limit}`,
  ...(kind ? [from, kind] : [from]));

/* GET /api/admin/live?days=1|7|30 */
export async function liveStats(req, env, json, warsawMidnight) {
  const now = Date.now(), days = Math.min(30, Math.max(1, +new URL(req.url).searchParams.get('days') || 1));
  const from = warsawMidnight(days - 1), today = warsawMidnight(0), d30 = warsawMidnight(29);
  const [live, sum, prev, hours, series, screens, acts, events, srcs, cities, devices, feed] = await Promise.all([
    rows(env, 'SELECT screen, event_id, src, city, device, app, last, first FROM stat_live WHERE last > ? ORDER BY last DESC LIMIT 300', now - LIVE_MS),
    env.DB.prepare(`SELECT COUNT(DISTINCT vid) AS visitors, SUM(kind = 'view') AS views, SUM(kind = 'click') AS clicks FROM stat_hits WHERE ts >= ?`).bind(from).first(),
    env.DB.prepare('SELECT COUNT(DISTINCT vid) AS visitors FROM stat_hits WHERE ts >= ? AND ts < ?').bind(from - days * DAY, from).first(),
    rows(env, `SELECT CAST((ts - ?) / 3600000 AS INTEGER) AS h, COUNT(DISTINCT vid) AS v, SUM(kind = 'view') AS n FROM stat_hits WHERE ts >= ? GROUP BY h`, today, today),
    rows(env, `SELECT CAST((ts - ?) / ${DAY} AS INTEGER) AS d, COUNT(DISTINCT vid) AS v, SUM(kind = 'view') AS n FROM stat_hits WHERE ts >= ? GROUP BY d`, d30, d30),
    top(env, 'screen', from, 'view', 12),
    top(env, 'act', from, 'click', 15),
    top(env, 'event_id', from, '', 10),
    rows(env, 'SELECT src AS k, COUNT(DISTINCT vid) AS v FROM stat_hits WHERE ts >= ? GROUP BY src ORDER BY v DESC LIMIT 12', from),
    rows(env, 'SELECT city AS k, COUNT(DISTINCT vid) AS v FROM stat_hits WHERE ts >= ? AND city IS NOT NULL GROUP BY city ORDER BY v DESC LIMIT 12', from),
    rows(env, 'SELECT device AS k, COUNT(DISTINCT vid) AS v FROM stat_hits WHERE ts >= ? GROUP BY device ORDER BY v DESC', from),
    rows(env, 'SELECT ts, kind, screen, act, event_id, city, device, src FROM stat_hits ORDER BY id DESC LIMIT 40')
  ]);
  const perHour = Array(24).fill(0), daily = { v: Array(30).fill(0), n: Array(30).fill(0) };
  for (const r of hours) if (r.h >= 0 && r.h < 24) perHour[r.h] = r.v;
  for (const r of series) if (r.d >= 0 && r.d < 30) { daily.v[r.d] = r.v; daily.n[r.d] = r.n; }
  // średni czas wizyty: od pierwszego do ostatniego sygnału danej osoby (dziś/zakres), tylko wizyty > 0 s
  const dur = await env.DB.prepare('SELECT AVG(d) AS avg FROM (SELECT MAX(ts) - MIN(ts) AS d FROM stat_hits WHERE ts >= ? GROUP BY vid HAVING d > 0)').bind(from).first('avg');
  return json({ now, days, hourNow: Math.floor((now - today) / 3600e3), live, visitors: +sum?.visitors || 0, views: +sum?.views || 0, clicks: +sum?.clicks || 0, prevVisitors: +prev?.visitors || 0,
    avgMs: Math.round(+dur || 0), perHour, daily, dailyFrom: d30, screens, acts, events, srcs, cities, devices, feed });
}

export async function cleanupStats(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM stat_hits WHERE ts < ?').bind(Date.now() - KEEP_DAYS * DAY),
    env.DB.prepare('DELETE FROM stat_live WHERE last < ?').bind(Date.now() - DAY)
  ]);
}
