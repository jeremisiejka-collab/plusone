/* +1 — posty na Instagram @plusoneapp.pl z publicznych wydarzeń.

   Droga wydarzenia: pipeline/run.mjs → public/data/events.json (commit bota) → deploy.yml (wrangler deploy).
   Wydarzenie jest publiczne, gdy jest w opublikowanym events.json i nie jest ukryte w moderacji (tabela curation).
   Grafika, którą widzi użytkownik, to pole e.image (strona i aplikacja wstawiają je wprost do <img>).

   Ten moduł (cron co 10 min, IG_CRON) czyta opublikowany events.json z ASSETS, wybiera najlepsze wydarzenia
   i zapisuje trwałe zadania w ig_posts (jedno na profil + wydarzenie). Meta przyjmuje tylko JPEG o proporcjach
   4:5–1,91:1, więc pipeline/tools/ig-images.mjs robi z e.image pochodną JPEG bez obcinania plakatu
   (public/ig/<image_key>.jpg) dla zadań z /api/ig/wanted. Wysyłka (Graph API) jest domyślnie wyłączona.

   Token: sekret Workera IG_ACCESS_TOKEN (Cloudflare → Workers → plusone → Settings → Variables and Secrets
   albo `npx wrangler secret put IG_ACCESS_TOKEN`). Nigdy w kodzie, logach, bazie ani przeglądarce. */
import { stripEmoji } from '../pipeline/lib/normalize.mjs';

export const IG_CRON = '*/10 * * * *';
const SITE = 'https://plusoneapp.pl';
const DAY = 864e5;
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

/* ---------------- ustawienia (settings.instagram) ---------------- */
export const IG_DEFAULTS = {
  igUserId: '17841412007314040',
  username: 'plusoneapp.pl',
  graph: 'https://graph.facebook.com/v25.0',
  autoSelect: false,        // automatyczny wybór nowych wydarzeń do kolejki
  sendEnabled: false,       // rzeczywista wysyłka do Meta — włącza się osobną decyzją
  requireApproval: true,    // wybrane automatycznie czekają na akceptację w panelu
  activatedAt: null,        // brane są tylko wydarzenia, które pojawiły się po aktywacji (firstSeen)
  authError: null,          // błąd autoryzacji wstrzymuje wysyłkę do ponownego sprawdzenia konta
  minScore: 14,
  dailyLimit: 2,
  weeklyLimit: 8,
  perSync: 4,               // ile nowych zadań może dodać jeden przebieg wyboru
  leadMin: 3,               // dni do wydarzenia: od…
  leadMax: 35,              // …do
  cities: [],               // puste = cała Polska
  categories: ['Concerts', 'Festivals', 'Clubs', 'Theatre', 'Comedy', 'Sport'],
  excludeWords: 'warsztat, kurs, szkolenie, webinar, zwiedzanie, karnet, voucher, parking, wystawa',
  slots: ['11:00', '19:00'],// godziny publikacji (czas polski)
  template: '{tytul}\n{kiedy} · {miejsce}, {miasto}\n\n{opis}\n\n{cena}\nSzczegóły i bilety: link w bio · plusoneapp.pl/e/{id}\n\n{hashtagi}',
  hashtags: '#plusoneapp #gdziedzisidziemy #wydarzenia',
  examples: []              // zatwierdzone ręcznie poprawione podpisy — wzorce stylu
};
const NUM = { minScore: [0, 60], dailyLimit: [0, 25], weeklyLimit: [0, 100], perSync: [1, 20], leadMin: [0, 120], leadMax: [1, 180] };

export async function igConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'instagram'").first();
  let saved = {}; try { saved = row ? JSON.parse(row.value) : {}; } catch {}
  return { ...IG_DEFAULTS, ...saved };
}
async function saveConfig(env, cfg) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('instagram', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(cfg)).run();
  return cfg;
}
/* tylko znane pola, w granicach */
export function mergeConfig(cfg, patch, now = Date.now()) {
  const out = { ...cfg };
  for (const k of ['autoSelect', 'sendEnabled', 'requireApproval']) if (typeof patch[k] === 'boolean') out[k] = patch[k];
  for (const [k, [lo, hi]] of Object.entries(NUM)) if (patch[k] != null && isFinite(+patch[k])) out[k] = Math.min(hi, Math.max(lo, Math.round(+patch[k] * 10) / 10));
  if (out.leadMax < out.leadMin) out.leadMax = out.leadMin;
  if (Array.isArray(patch.cities)) out.cities = patch.cities.map(s => stripEmoji(String(s)).trim()).filter(Boolean).slice(0, 40);
  if (Array.isArray(patch.categories)) out.categories = patch.categories.filter(c => typeof c === 'string').slice(0, 12);
  if (Array.isArray(patch.slots)) out.slots = patch.slots.filter(s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)).sort().slice(0, 8);
  for (const k of ['excludeWords', 'hashtags']) if (typeof patch[k] === 'string') out[k] = stripEmoji(patch[k]).slice(0, 600);
  if (typeof patch.template === 'string' && patch.template.trim()) out.template = stripEmoji(patch.template).slice(0, 1500);
  if (patch.authError === null) out.authError = null;
  // pierwsze włączenie automatycznego wyboru = aktywacja: od teraz tylko nowe wydarzenia
  if (out.autoSelect && !out.activatedAt) out.activatedAt = now;
  if (patch.resetActivation === true) out.activatedAt = now;
  return out;
}

/* ---------------- wydarzenia publiczne ---------------- */
let EV = null, EV_AT = 0;
export async function publicEvents(env, now = Date.now()) {
  if (!EV || now - EV_AT > 5 * 60e3) {
    const r = await env.ASSETS.fetch(new Request(SITE + '/data/events.json'));
    const d = await r.json();
    EV = { list: d.events || [], byId: new Map((d.events || []).map(e => [e.id, e])) };
    EV_AT = now;
  }
  const cur = await env.DB.prepare('SELECT event_id, action FROM curation').all();
  const hidden = new Set(), featured = new Set();
  for (const r of cur.results) (r.action === 'hide' ? hidden : r.action === 'feature' ? featured : new Set()).add(r.event_id);
  const pop = await env.DB.prepare('SELECT event_id, COUNT(*) AS n FROM saved GROUP BY event_id ORDER BY n DESC LIMIT 300').all();
  return { ...EV, hidden, featured, popular: new Map(pop.results.map(r => [r.event_id, r.n])) };
}
export function _resetEventsCache() { EV = null; }

/* ---------------- filtr: czy wydarzenie nadaje się na Instagram ---------------- */
const localNow = now => new Date(now + warsawOffset(now)).toISOString().slice(0, 16); // "YYYY-MM-DDTHH:mm" w Polsce
function warsawOffset(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60e3) * 60e3;
}
const daysUntil = (e, now) => (Date.parse(e.start.slice(0, 10) + 'T12:00:00Z') - Date.parse(localNow(now).slice(0, 10) + 'T12:00:00Z')) / DAY;
export const isVenuePhoto = src => /(^|plusoneapp\.pl)\/img\/obiekty\//.test(String(src || ''));
export const dedupKey = e => fold(e.title).replace(/[^a-z0-9]+/g, '').slice(0, 48) + '|' + String(e.start).slice(0, 10) + '|' + fold(e.city);
/* to samo wydarzenie z innego serwisu pod innym tytułem („OKI MOSHPIT…” / „OKI in Wrocław”): miasto + dzień + pierwsze słowo */
export const slotKey = (title, start, city) => fold(city) + '|' + String(start).slice(0, 10) + '|' + (fold(title).match(/[a-z0-9]{2,}/) || [''])[0];
async function takenKeys(env, cfg) {
  const t = await env.DB.prepare("SELECT event_id, dedup_key, title, event_start, city FROM ig_posts WHERE ig_user = ? AND status != 'skipped'").bind(cfg.igUserId).all();
  const all = await env.DB.prepare('SELECT event_id, dedup_key FROM ig_posts WHERE ig_user = ?').bind(cfg.igUserId).all();
  return { ids: new Set(all.results.map(r => r.event_id)), keys: new Set(all.results.map(r => r.dedup_key)), slots: new Set(t.results.map(r => slotKey(r.title, r.event_start, r.city))) };
}

/* wynik: popularność z pipeline (hot), polecone przez redakcję, duże wydarzenie, kilka serwisów, zapisy użytkowników */
export function igScore(e, ctx = {}) {
  const reasons = [];
  let s = e.hot || 0; if (s) reasons.push('Na topie ' + s);
  if (ctx.featured?.has(e.id)) { s += 6; reasons.push('polecane +6'); }
  if (e.big) { s += 3; reasons.push('duże wydarzenie +3'); }
  const n = (e.sources || []).length;
  if (n > 1) { s += 1.5 * (n - 1); reasons.push(n + ' serwisy +' + 1.5 * (n - 1)); }
  const pop = ctx.popular?.get(e.id) || 0;
  if (pop) { s += Math.min(pop, 5); reasons.push('zapisane ' + pop + '×'); }
  if (String(e.start).slice(11, 16) === '00:00') { s -= 1; reasons.push('bez godziny −1'); }
  if (e.end && Date.parse(e.end) - Date.parse(e.start) > 7 * DAY) { s -= 3; reasons.push('trwa tygodniami −3'); }
  return { score: Math.round(s * 10) / 10, reasons };
}
/* null = przechodzi; inaczej powód odrzucenia (pokazywany w panelu) */
export function igReject(e, cfg, ctx = {}, now = Date.now()) {
  if (!e.image) return 'brak plakatu';
  if (cfg.postersOnly !== false && isVenuePhoto(e.image)) return 'tylko zdjęcie miejsca, bez plakatu';
  if (ctx.hidden?.has(e.id)) return 'ukryte w moderacji';
  const d = daysUntil(e, now);
  if (d < cfg.leadMin) return 'za blisko terminu';
  if (d > cfg.leadMax) return 'za daleko w czasie';
  if (cfg.categories?.length && !cfg.categories.includes(e.category)) return 'kategoria poza filtrem';
  if (cfg.cities?.length && !cfg.cities.some(c => fold(c) === fold(e.city))) return 'miasto poza filtrem';
  const words = String(cfg.excludeWords || '').split(',').map(w => fold(w.trim())).filter(Boolean);
  const text = fold(e.title + ' ' + (e.tags || []).join(' '));
  const w = words.find(x => text.includes(x));
  if (w) return 'słowo wykluczone: ' + w;
  if (cfg.activatedAt && !ctx.ignoreActivation && Date.parse(e.firstSeen || 0) < cfg.activatedAt) return 'było przed aktywacją';
  return null;
}

/* ---------------- podpis: deterministycznie z danych, które widzi użytkownik ---------------- */
const MIES = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const DNI = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const CAT_TAG = { Clubs: 'klubowe', Concerts: 'koncert', Festivals: 'festiwal', Theatre: 'teatr', Comedy: 'standup', Culture: 'kultura', Sport: 'sport', Family: 'dladzieci' };
const tag = s => '#' + fold(s).replace(/[^a-z0-9]+/g, '');
export function whenText(e) {
  const [y, mo, d] = e.start.slice(0, 10).split('-').map(Number), t = e.start.slice(11, 16);
  const dow = DNI[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${dow}, ${d} ${MIES[mo - 1]}${t && t !== '00:00' ? ', ' + t : ''}`;
}
export function buildCaption(e, cfg = IG_DEFAULTS) {
  const desc = String(e.description || '').replace(/\s+/g, ' ').trim();
  const first = desc.split(/(?<=[.!?])\s/)[0] || '';
  const opis = e.artists?.length > 1 ? 'Na scenie: ' + e.artists.slice(0, 6).join(', ') + '.' : first.length >= 20 && first.length <= 260 ? first : desc.length > 260 ? desc.slice(0, 257).replace(/\s\S*$/, '') + '…' : desc;
  const cena = e.priceFrom == null ? '' : e.priceFrom === 0 ? 'Wstęp wolny.' : `Bilety od ${Math.round(e.priceFrom)} zł.`;
  const tags = [...String(cfg.hashtags || '').split(/\s+/), tag(e.city), CAT_TAG[e.category] && '#' + CAT_TAG[e.category], ...(e.artists || []).slice(0, 2).map(tag)]
    .filter(t => t && /^#[\p{L}\p{N}_]{2,40}$/u.test(t)).filter((t, i, a) => a.findIndex(x => x.toLowerCase() === t.toLowerCase()) === i).slice(0, 30);
  const vals = { tytul: e.title, kiedy: whenText(e), miejsce: e.venue || '', miasto: e.city && !fold(e.venue).includes(fold(e.city)) ? e.city : '', opis, cena, id: e.id, link: SITE + '/e/' + e.id, hashtagi: tags.join(' ') };
  let text = String(cfg.template || IG_DEFAULTS.template).replace(/\{(\w+)\}/g, (m, k) => k in vals ? vals[k] : m);
  text = stripEmoji(text).split('\n').map(l => l.replace(/[ \t]+/g, ' ').replace(/\s*[,·]\s*$/, '').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return clampCaption(text);
}
/* limity Instagrama: 2200 znaków, 30 hashtagów, 20 oznaczeń */
export function clampCaption(text) {
  let n = 0;
  text = String(text).replace(/#[\p{L}\p{N}_]+/gu, h => ++n > 30 ? '' : h);
  let m = 0;
  text = text.replace(/@[\w.]+/g, h => ++m > 20 ? '' : h);
  return text.length > 2200 ? text.slice(0, 2199).replace(/\s\S*$/, '') + '…' : text;
}

/* ---------------- grafika: pochodna JPEG dla Meta ---------------- */
export const imageKey = async src => (await sha256(String(src))).slice(0, 24);
export const derivativeUrl = key => SITE + '/ig/' + key + '.jpg';
async function imageReady(env, key) {
  try { const r = await env.ASSETS.fetch(new Request(derivativeUrl(key))); return r.status === 200 && (r.headers.get('Content-Type') || '').includes('jpeg'); }
  catch { return false; }
}

/* ---------------- kolejka ---------------- */
const ACTIVE = ['review', 'queued', 'container', 'publishing', 'unknown'];
const log = (env, postId, kind, msg, now = Date.now()) =>
  env.DB.prepare('INSERT INTO ig_log (post_id, at, kind, msg) VALUES (?, ?, ?, ?)').bind(postId, now, kind, String(msg || '').slice(0, 500)).run();

/* jedno zadanie na profil + wydarzenie; INSERT OR IGNORE przy UNIQUE = bez duplikatów także przy równoległych przebiegach */
export async function enqueue(env, cfg, e, { score = 0, reasons = [], origin = 'auto', status, caption, byUser = null, now = Date.now() } = {}) {
  const { slots } = await takenKeys(env, cfg);
  if (slots.has(slotKey(e.title, e.start, e.city))) {
    const same = (await env.DB.prepare("SELECT * FROM ig_posts WHERE ig_user = ? AND city IS ? AND substr(event_start, 1, 10) = ? AND status != 'skipped'").bind(cfg.igUserId, e.city || null, e.start.slice(0, 10)).all())
      .results.find(r => slotKey(r.title, r.event_start, r.city) === slotKey(e.title, e.start, e.city));
    if (same) return { created: false, row: same };
  }
  const key = await imageKey(e.image);
  const st = status || (origin === 'manual' || !cfg.requireApproval ? 'queued' : 'review');
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO ig_posts (ig_user, event_id, dedup_key, title, event_start, city, image_src, image_key, caption, caption_edited,
      score, reasons, origin, status, by_user, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(cfg.igUserId, e.id, dedupKey(e), e.title, e.start, e.city || null, e.image, key, caption || buildCaption(e, cfg), caption ? 1 : 0,
      score, JSON.stringify(reasons), origin, st, byUser, now, now).run();
  const created = (r.meta?.changes || 0) > 0;
  const row = await env.DB.prepare('SELECT * FROM ig_posts WHERE ig_user = ? AND (event_id = ? OR dedup_key = ?)').bind(cfg.igUserId, e.id, dedupKey(e)).first();
  if (created) await log(env, row.id, 'queued', (origin === 'manual' ? 'dodane ręcznie' : 'wybrane automatycznie') + ' · wynik ' + score, now);
  return { created, row };
}

/* kandydaci: przechodzą filtr, nie mają jeszcze zadania; najlepszy termin z trasy (ten sam tytuł) */
export async function candidates(env, cfg, ev, { now = Date.now(), ignoreActivation = false, limit = 50 } = {}) {
  const { ids, keys, slots } = await takenKeys(env, cfg);
  const rejected = {}, seenTitle = new Set(), out = [];
  const ctx = { hidden: ev.hidden, featured: ev.featured, popular: ev.popular, ignoreActivation };
  const scored = [];
  for (const e of ev.list) {
    const why = igReject(e, cfg, ctx, now);
    if (why) { const k = why.startsWith('słowo') ? 'słowo wykluczone' : why; rejected[k] = (rejected[k] || 0) + 1; continue; }
    if (ids.has(e.id) || keys.has(dedupKey(e)) || slots.has(slotKey(e.title, e.start, e.city))) continue;
    const { score, reasons } = igScore(e, ctx);
    if (score < cfg.minScore) { rejected['wynik poniżej progu'] = (rejected['wynik poniżej progu'] || 0) + 1; continue; }
    scored.push({ e, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score || a.e.start.localeCompare(b.e.start));
  for (const c of scored) {
    const t = (fold(c.e.title).match(/[a-z0-9]{2,}/g) || []).slice(0, 2).join(' ');   // „HYPE RAP FEST Warszawa” i „Hype Rap Fest II” = jedna trasa
    const sk = slotKey(c.e.title, c.e.start, c.e.city);
    if (seenTitle.has(t) || seenTitle.has(sk)) continue;   // trasa w kilku miastach i ten sam koncert z kilku serwisów = jeden post
    seenTitle.add(t); seenTitle.add(sk); out.push(c);
    if (out.length >= limit) break;
  }
  return { list: out, rejected };
}

/* automatyczny wybór: dopisuje najlepszych kandydatów, nie więcej niż perSync i niż zapas na tydzień */
export async function syncQueue(env, cfg, { now = Date.now(), manual = false } = {}) {
  if (!cfg.autoSelect && !manual) return { added: 0, reason: 'automatyczny wybór wyłączony' };
  const ev = await publicEvents(env, now);
  const pending = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ig_posts WHERE ig_user = ? AND status IN ('review','queued')").bind(cfg.igUserId).first()).n;
  const room = Math.max(0, Math.min(cfg.perSync, cfg.weeklyLimit - pending));
  if (!room) return { added: 0, reason: 'kolejka pełna na tydzień' };
  const { list } = await candidates(env, cfg, ev, { now, limit: room });
  let added = 0;
  for (const c of list) if ((await enqueue(env, cfg, c.e, { score: c.score, reasons: c.reasons, now })).created) added++;
  return { added };
}

/* ---------------- Graph API ---------------- */
/* rodzaje błędów: auth (token/uprawnienia — wstrzymuje wysyłkę), transient (ponów później), permanent (zadanie do poprawy) */
export function classify(status, err) {
  const code = err?.code, sub = err?.error_subcode;
  if (status === 401 || code === 190 || code === 102 || code === 10 || (code >= 200 && code <= 299) || sub === 463 || sub === 467) return 'auth';
  if (status === 429 || status >= 500 || err?.is_transient || [1, 2, 4, 17, 32, 341, 368, 613, 9007].includes(code) || sub === 2207027) return 'transient';
  return 'permanent';
}
async function graph(env, cfg, method, path, params = {}, fx = fetch) {
  const url = new URL(cfg.graph.replace(/\/$/, '') + path);
  const init = { method, headers: { Authorization: 'Bearer ' + env.IG_ACCESS_TOKEN }, signal: AbortSignal.timeout(25000) };
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(params).toString(); }
  let r;
  try { r = await fx(url.toString(), init); }
  catch (e) { return { ok: false, network: true, kind: 'transient', msg: e?.name === 'TimeoutError' ? 'przekroczony czas odpowiedzi' : 'brak połączenia z Meta' }; }
  let data = {}; try { data = await r.json(); } catch {}
  if (r.ok && !data.error) return { ok: true, status: r.status, data };
  const err = data.error || {};
  return { ok: false, status: r.status, kind: classify(r.status, err), code: err.code, msg: (err.error_user_msg || err.message || 'HTTP ' + r.status).slice(0, 300) };
}

/* ---------------- wysyłka ---------------- */
const isFinal = s => ['published', 'failed', 'skipped', 'needs_check'].includes(s);
async function setRow(env, id, fields, now = Date.now()) {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE ig_posts SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).bind(...keys.map(k => fields[k]), now, id).run();
}
async function pauseAuth(env, cfg, msg, now) {
  await saveConfig(env, { ...(await igConfig(env)), authError: { at: now, msg } });
}
/* blokada jednego wysyłającego naraz (cron i „Publikuj teraz” mogą ruszyć równocześnie) */
async function lock(env, now) {
  const r = await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('ig_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE CAST(settings.value AS INTEGER) < ?`).bind(String(now + 5 * 60e3), now).run();
  return (r.meta?.changes || 0) > 0;
}
const unlock = env => env.DB.prepare("DELETE FROM settings WHERE key = 'ig_lock'").run();

/* ile postów w dzisiejszym dniu (Polska) i w 7 dniach — liczą się opublikowane i rozpoczęte */
async function usage(env, cfg, now) {
  const dayStart = now - ((Date.parse(localNow(now) + ':00Z') - Date.parse(localNow(now).slice(0, 10) + 'T00:00:00Z')));
  const q = from => env.DB.prepare(`SELECT COUNT(*) AS n FROM ig_posts WHERE ig_user = ? AND (published_at >= ? OR (status IN ('container','publishing','unknown') AND last_attempt_at >= ?))`)
    .bind(cfg.igUserId, from, from).first();
  return { today: (await q(dayStart)).n, week: (await q(now - 7 * DAY)).n, dayStart };
}
/* czy wypada teraz godzina publikacji, w której jeszcze nic nie wyszło */
async function slotDue(env, cfg, now, dayStart) {
  const hm = localNow(now).slice(11, 16);
  const past = (cfg.slots || []).filter(s => s <= hm);
  if (!past.length) return false;
  const last = past[past.length - 1], [h, m] = last.split(':').map(Number);
  const slotAt = dayStart + (h * 60 + m) * 60e3;
  if (now - slotAt > 3 * 3600e3) return false;  // nie nadrabiamy starych godzin
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM ig_posts WHERE ig_user = ? AND last_attempt_at >= ?').bind(cfg.igUserId, slotAt).first();
  return r.n === 0;
}

/* sprawdzenie przed wysyłką: wydarzenie nadal publiczne, przyszłe i z tą samą grafiką */
async function stillPublic(env, row, now) {
  const ev = await publicEvents(env, now);
  const e = ev.byId.get(row.event_id);
  if (!e || ev.hidden.has(row.event_id)) return { skip: 'wydarzenie nie jest już publiczne' };
  if (Date.parse(e.start + ':00Z') - warsawOffset(now) < now + 2 * 3600e3) return { skip: 'wydarzenie już się zaczyna' };
  if (e.image !== row.image_src) return { e, imageChanged: true };
  return { e };
}

export async function checkProfile(env, cfg, fx = fetch) {
  if (!env.IG_ACCESS_TOKEN) return { ok: false, kind: 'auth', msg: 'Brak sekretu IG_ACCESS_TOKEN w Workerze.' };
  const r = await graph(env, cfg, 'GET', '/' + cfg.igUserId, { fields: 'id,username' }, fx);
  if (!r.ok) return r;
  if (String(r.data.username).toLowerCase() !== cfg.username.toLowerCase()) return { ok: false, kind: 'auth', msg: `Token prowadzi do @${r.data.username}, a nie @${cfg.username}.` };
  return { ok: true, username: r.data.username };
}

/* jeden krok zadania; zwraca true, gdy coś wysłano do Meta */
async function advance(env, cfg, row, now, fx, sleep) {
  // 1) niepewny wynik media_publish: najpierw ustal stan kontenera, dopiero potem ewentualna ponowna próba
  if (row.status === 'unknown' || (row.status === 'publishing' && now - (row.last_attempt_at || 0) > 5 * 60e3)) return reconcile(env, cfg, row, now, fx);
  if (row.status === 'publishing') return false;

  if (row.status === 'queued') {
    const chk = await stillPublic(env, row, now);
    if (chk.skip) { await setRow(env, row.id, { status: 'skipped', last_error: chk.skip, last_error_kind: 'permanent' }, now); await log(env, row.id, 'skipped', chk.skip, now); return false; }
    if (chk.imageChanged) {
      const key = await imageKey(chk.e.image);
      await setRow(env, row.id, { image_src: chk.e.image, image_key: key, last_error: 'grafika wydarzenia zmieniona — czeka na nowy JPEG' }, now);
      await log(env, row.id, 'image', 'grafika zmieniona w aplikacji', now);
      return false;
    }
    if (!(await imageReady(env, row.image_key))) {
      await setRow(env, row.id, { last_error: 'czeka na grafikę JPEG (pipeline, do godziny)' }, now);
      return false;
    }
    const prof = await checkProfile(env, cfg, fx);
    if (!prof.ok) {
      if (prof.kind === 'auth') { await pauseAuth(env, cfg, prof.msg, now); await log(env, row.id, 'auth', prof.msg, now); }
      else await setRow(env, row.id, { last_error: prof.msg, last_error_kind: prof.kind, next_try_at: now + 30 * 60e3 }, now);
      return false;
    }
    // przejęcie zadania (atomowo) i utworzenie kontenera
    const claim = await env.DB.prepare("UPDATE ig_posts SET status = 'container', attempts = attempts + 1, last_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").bind(now, now, row.id).run();
    if (!claim.meta?.changes) return false;
    const c = await graph(env, cfg, 'POST', `/${cfg.igUserId}/media`, { image_url: derivativeUrl(row.image_key), caption: row.caption }, fx);
    if (!c.ok || !c.data.id) {
      const kind = c.ok ? 'permanent' : c.kind;
      await setRow(env, row.id, { status: kind === 'permanent' ? 'failed' : 'queued', last_error: c.msg || 'Meta nie zwróciła ID kontenera', last_error_kind: kind,
        next_try_at: kind === 'transient' ? now + Math.min(6, (row.attempts || 0) + 1) * 30 * 60e3 : null }, now);
      if (kind === 'auth') await pauseAuth(env, cfg, c.msg, now);
      await log(env, row.id, 'container_error', `${kind}: ${c.msg}`, now);
      return true;
    }
    await setRow(env, row.id, { container_id: c.data.id, last_error: null, last_error_kind: null }, now);
    await log(env, row.id, 'container', 'kontener ' + c.data.id, now);
    row = { ...row, status: 'container', container_id: c.data.id };
  }

  if (row.status === 'container') {
    // 2) czekamy, aż Meta przetworzy grafikę
    let st = null;
    for (let i = 0; i < 5; i++) {
      const s = await graph(env, cfg, 'GET', '/' + row.container_id, { fields: 'status_code' }, fx);
      if (!s.ok) { if (s.kind === 'auth') await pauseAuth(env, cfg, s.msg, now); await setRow(env, row.id, { last_error: s.msg, last_error_kind: s.kind }, now); return true; }
      st = s.data.status_code;
      if (st !== 'IN_PROGRESS') break;
      await sleep(3000);
    }
    if (st === 'IN_PROGRESS') return true;                       // dokończymy w następnym przebiegu
    if (st === 'PUBLISHED') return reconcile(env, cfg, row, now, fx);
    if (st === 'EXPIRED') { await setRow(env, row.id, { status: 'queued', container_id: null, last_error: 'kontener wygasł, utworzymy nowy' }, now); return true; }
    if (st !== 'FINISHED') {
      await setRow(env, row.id, { status: 'failed', last_error: 'Meta nie przyjęła grafiki (status ' + st + ')', last_error_kind: 'permanent' }, now);
      await log(env, row.id, 'failed', 'status kontenera ' + st, now);
      return true;
    }
    // 3) punkt kontrolny PRZED media_publish — po niejasnym wyniku wiemy, że trzeba uzgadniać, a nie ponawiać
    await setRow(env, row.id, { status: 'publishing', last_attempt_at: now }, now);
    const p = await graph(env, cfg, 'POST', `/${cfg.igUserId}/media_publish`, { creation_id: row.container_id }, fx);
    if (p.ok && p.data.id) return confirm(env, cfg, row, p.data.id, now, fx);
    if (p.network || p.status >= 500 || (p.ok && !p.data.id)) {
      await setRow(env, row.id, { status: 'unknown', last_error: (p.msg || 'brak ID medium') + ' — sprawdzam, czy post wyszedł', last_error_kind: 'ambiguous' }, now);
      await log(env, row.id, 'unknown', p.msg || 'odpowiedź bez ID', now);
      return true;
    }
    if (p.kind === 'auth') await pauseAuth(env, cfg, p.msg, now);
    await setRow(env, row.id, { status: p.kind === 'permanent' ? 'failed' : 'container', last_error: p.msg, last_error_kind: p.kind }, now);
    await log(env, row.id, 'publish_error', `${p.kind}: ${p.msg}`, now);
    return true;
  }
  return false;
}

async function confirm(env, cfg, row, mediaId, now, fx) {
  let permalink = null;
  const m = await graph(env, cfg, 'GET', '/' + mediaId, { fields: 'permalink' }, fx);
  if (m.ok) permalink = m.data.permalink || null;
  await setRow(env, row.id, { status: 'published', media_id: String(mediaId), permalink, published_at: now, last_error: null, last_error_kind: null }, now);
  await log(env, row.id, 'published', 'medium ' + mediaId, now);
  return true;
}

/* uzgodnienie po niejasnym wyniku: kontener PUBLISHED → szukamy medium; FINISHED → można bezpiecznie opublikować; nie da się rozstrzygnąć → do sprawdzenia */
async function reconcile(env, cfg, row, now, fx) {
  const tries = (row.attempts || 0) + 1;
  const s = row.container_id ? await graph(env, cfg, 'GET', '/' + row.container_id, { fields: 'status_code' }, fx) : { ok: false, kind: 'permanent', msg: 'brak ID kontenera' };
  if (!s.ok) {
    if (s.kind === 'auth') await pauseAuth(env, cfg, s.msg, now);
    const give = s.kind === 'permanent' || tries > 6;
    await setRow(env, row.id, { status: give ? 'needs_check' : 'unknown', attempts: tries, last_error: (give ? 'Nie da się ustalić, czy post wyszedł: ' : '') + s.msg, last_error_kind: 'ambiguous' }, now);
    if (give) await log(env, row.id, 'needs_check', s.msg, now);
    return true;
  }
  const st = s.data.status_code;
  if (st === 'FINISHED') { await setRow(env, row.id, { status: 'container', last_error: 'kontener nieopublikowany — ponawiam publikację' }, now); return true; }
  if (st === 'EXPIRED') { await setRow(env, row.id, { status: 'queued', container_id: null, last_error: 'kontener wygasł bez publikacji' }, now); return true; }
  if (st === 'PUBLISHED') {
    const list = await graph(env, cfg, 'GET', `/${cfg.igUserId}/media`, { fields: 'id,caption,permalink,timestamp', limit: '15' }, fx);
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const hit = list.ok && (list.data.data || []).find(m => norm(m.caption) === norm(row.caption));
    if (hit) return confirm(env, cfg, row, hit.id, now, fx);
    await setRow(env, row.id, { status: 'needs_check', last_error: 'Meta zgłasza publikację, ale nie znaleziono medium na profilu', last_error_kind: 'ambiguous' }, now);
    await log(env, row.id, 'needs_check', 'PUBLISHED bez medium', now);
    return true;
  }
  if (st === 'IN_PROGRESS') { await setRow(env, row.id, { status: 'container' }, now); return true; }
  await setRow(env, row.id, { status: 'needs_check', last_error: 'status kontenera ' + st, last_error_kind: 'ambiguous' }, now);
  await log(env, row.id, 'needs_check', 'status ' + st, now);
  return true;
}

/* przebieg crona / „Publikuj teraz”. Bez sendEnabled albo bez tokenu nie łączy się z Meta. */
export async function igTick(env, { now = Date.now(), fx = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), forceId = null } = {}) {
  if (!env.DB) return { skipped: 'brak bazy' };
  let cfg = await igConfig(env);
  const out = { sync: null, sent: 0 };
  try { out.sync = await syncQueue(env, cfg, { now }); } catch (e) { console.error('ig sync', e?.message); }
  if (!cfg.sendEnabled) return { ...out, skipped: 'wysyłka wyłączona' };
  if (!env.IG_ACCESS_TOKEN) return { ...out, skipped: 'brak tokenu' };
  if (cfg.authError) return { ...out, skipped: 'wstrzymane: ' + cfg.authError.msg };
  if (!(await lock(env, now))) return { ...out, skipped: 'inny przebieg trwa' };
  try {
    // najpierw zadania w toku (kontener, niepewny wynik)
    const open = await env.DB.prepare("SELECT * FROM ig_posts WHERE ig_user = ? AND status IN ('container','publishing','unknown') ORDER BY id").bind(cfg.igUserId).all();
    for (const row of open.results) { if (await advance(env, cfg, row, now, fx, sleep)) out.sent++; cfg = await igConfig(env); if (cfg.authError) return out; }
    if (open.results.some(r => !isFinal(r.status))) {
      const still = await env.DB.prepare("SELECT COUNT(*) AS n FROM ig_posts WHERE ig_user = ? AND status IN ('container','publishing','unknown')").bind(cfg.igUserId).first();
      if (still.n) return out;        // jeden post naraz
    }
    const u = await usage(env, cfg, now);
    const forced = forceId ? await env.DB.prepare("SELECT * FROM ig_posts WHERE id = ? AND status = 'queued'").bind(forceId).first() : null;
    if (!forced) {
      if (u.today >= cfg.dailyLimit || u.week >= cfg.weeklyLimit) return { ...out, skipped: 'limit' };
      if (!(await slotDue(env, cfg, now, u.dayStart))) return { ...out, skipped: 'poza godziną publikacji' };
    }
    const next = forced || await env.DB.prepare(`SELECT * FROM ig_posts WHERE ig_user = ? AND status = 'queued' AND (next_try_at IS NULL OR next_try_at <= ?)
        ORDER BY origin = 'manual' DESC, score DESC, event_start ASC LIMIT 5`).bind(cfg.igUserId, now).all().then(r => r.results);
    for (const row of [].concat(next)) {
      const sent = await advance(env, cfg, row, now, fx, sleep);
      if (sent) { out.sent++; break; }
    }
    return out;
  } finally { await unlock(env); }
}

/* ---------------- API ---------------- */
async function eventById(env, id, now) { const ev = await publicEvents(env, now); return { ev, e: ev.byId.get(id) }; }
export async function preview(env, cfg, e, ev, now = Date.now()) {
  const key = await imageKey(e.image || '');
  const { score, reasons } = igScore(e, { featured: ev.featured, popular: ev.popular });
  return { eventId: e.id, title: e.title, when: whenText(e), city: e.city, venue: e.venue, image: e.image, derivative: derivativeUrl(key), derivativeReady: e.image ? await imageReady(env, key) : false,
    caption: buildCaption(e, cfg), score, reasons, reject: igReject(e, cfg, { hidden: ev.hidden, ignoreActivation: true }, now), account: '@' + cfg.username, igUserId: cfg.igUserId };
}

/* publiczne: lista grafik do przygotowania dla pipeline (tylko klucze i adresy publicznych plakatów) */
export async function igWanted(env, json) {
  const rows = await env.DB.prepare(`SELECT image_key, image_src, status, published_at FROM ig_posts WHERE status IN ('review','queued','container','publishing','unknown','needs_check')
      OR (status = 'published' AND published_at > ?)`).bind(Date.now() - 3 * DAY).all();
  const render = [];
  for (const r of rows.results) if (['review', 'queued'].includes(r.status) && !(await imageReady(env, r.image_key))) render.push({ key: r.image_key, src: r.image_src });
  return json({ render: render.slice(0, 40), keep: [...new Set(rows.results.map(r => r.image_key))] }, 200, { 'Cache-Control': 'no-store' });
}

export async function instagramApi(path, m, req, env, user, { json, fail, body }) {
  const now = Date.now();
  let cfg = await igConfig(env);
  if (path === '/api/admin/ig' && m === 'GET') {
    const [posts, logs, counts] = await Promise.all([
      env.DB.prepare('SELECT * FROM ig_posts ORDER BY CASE WHEN status IN (\'review\',\'queued\',\'container\',\'publishing\',\'unknown\',\'needs_check\') THEN 0 ELSE 1 END, updated_at DESC LIMIT 80').all(),
      env.DB.prepare('SELECT * FROM ig_log ORDER BY id DESC LIMIT 40').all(),
      env.DB.prepare('SELECT status, COUNT(*) AS n FROM ig_posts GROUP BY status').all()
    ]);
    const ev = await publicEvents(env, now);
    const cand = await candidates(env, cfg, ev, { now, ignoreActivation: true, limit: 12 });
    const u = await usage(env, cfg, now);
    for (const p of posts.results) p.imageReady = ['review', 'queued'].includes(p.status) ? await imageReady(env, p.image_key) : null;
    return json({ cfg, token: !!env.IG_ACCESS_TOKEN, usage: { today: u.today, week: u.week }, posts: posts.results, log: logs.results,
      counts: Object.fromEntries(counts.results.map(r => [r.status, r.n])),
      candidates: cand.list.map(c => ({ id: c.e.id, title: c.e.title, when: whenText(c.e), city: c.e.city, venue: c.e.venue, image: c.e.image, score: c.score, reasons: c.reasons,
        afterActivation: !cfg.activatedAt || Date.parse(c.e.firstSeen || 0) >= cfg.activatedAt })),
      rejected: cand.rejected });
  }
  if (path === '/api/admin/ig/config' && m === 'POST') {
    const b = await body(req);
    if (b.sendEnabled === true && !env.IG_ACCESS_TOKEN) return fail(400, 'Najpierw dodaj sekret IG_ACCESS_TOKEN w Workerze.');
    cfg = await saveConfig(env, mergeConfig(cfg, b, now));
    return json({ cfg });
  }
  if (path === '/api/admin/ig/preview' && m === 'POST') {
    const b = await body(req);
    const { ev, e } = await eventById(env, String(b.eventId || ''), now);
    if (!e) return fail(404, 'Nie ma takiego publicznego wydarzenia.');
    const existing = await env.DB.prepare('SELECT id, status FROM ig_posts WHERE ig_user = ? AND (event_id = ? OR dedup_key = ?)').bind(cfg.igUserId, e.id, dedupKey(e)).first();
    return json({ ...(await preview(env, cfg, e, ev, now)), existing });
  }
  if (path === '/api/admin/ig/add' && m === 'POST') {
    const b = await body(req);
    const { ev, e } = await eventById(env, String(b.eventId || ''), now);
    if (!e) return fail(404, 'Nie ma takiego publicznego wydarzenia.');
    if (ev.hidden.has(e.id)) return fail(400, 'Wydarzenie jest ukryte w moderacji.');
    if (!e.image) return fail(400, 'Wydarzenie nie ma plakatu.');
    const caption = typeof b.caption === 'string' && b.caption.trim() ? clampCaption(stripEmoji(b.caption).trim()) : null;
    const { score, reasons } = igScore(e, ev);
    const r = await enqueue(env, cfg, e, { score, reasons, origin: 'manual', caption, byUser: user.id, now });
    if (!r.created) return json({ error: 'To wydarzenie już jest w kolejce Instagrama (' + r.row.status + ').', post: r.row }, 409);
    return json({ post: r.row });
  }
  if (path === '/api/admin/ig/sync' && m === 'POST') return json(await syncQueue(env, cfg, { now, manual: true }));
  if (path === '/api/admin/ig/check' && m === 'POST') {
    const r = await checkProfile(env, cfg);
    if (r.ok && cfg.authError) cfg = await saveConfig(env, { ...cfg, authError: null });
    return json({ ok: r.ok, username: r.username || null, error: r.ok ? null : r.msg, kind: r.kind || null });
  }
  if (path === '/api/admin/ig/tick' && m === 'POST') {
    const b = await body(req);
    if (!cfg.sendEnabled) return fail(400, 'Wysyłka na Instagram jest wyłączona.');
    return json(await igTick(env, { now, forceId: b.id ? +b.id : null }));
  }
  const pm = path.match(/^\/api\/admin\/ig\/post\/(\d+)$/);
  if (pm && m === 'POST') {
    const id = +pm[1], b = await body(req);
    const row = await env.DB.prepare('SELECT * FROM ig_posts WHERE id = ?').bind(id).first();
    if (!row) return fail(404, 'Nie ma takiego zadania.');
    const editable = ['review', 'queued'].includes(row.status);
    switch (b.action) {
      case 'caption': {
        if (!editable) return fail(409, 'Tego posta nie można już zmienić.');
        const c = clampCaption(stripEmoji(String(b.caption || '')).trim());
        if (!c) return fail(400, 'Podpis nie może być pusty.');
        await setRow(env, id, { caption: c, caption_edited: 1 }, now);
        break;
      }
      case 'approve': {
        if (row.status !== 'review') return fail(409, 'To zadanie nie czeka na akceptację.');
        await setRow(env, id, { status: 'queued', by_user: user.id }, now);
        // poprawiony ręcznie podpis = wzorzec stylu na później
        if (row.caption_edited) cfg = await saveConfig(env, { ...cfg, examples: [{ eventId: row.event_id, title: row.title, caption: row.caption, at: now }, ...(cfg.examples || []).filter(x => x.eventId !== row.event_id)].slice(0, 12) });
        await log(env, id, 'approved', 'zaakceptowane', now);
        break;
      }
      case 'skip':
        if (!editable && row.status !== 'needs_check' && row.status !== 'failed') return fail(409, 'Tego zadania nie można pominąć.');
        await setRow(env, id, { status: 'skipped', last_error: 'pominięte w panelu' }, now); await log(env, id, 'skipped', 'w panelu', now); break;
      case 'requeue':
        if (!['skipped', 'failed', 'needs_check'].includes(row.status)) return fail(409, 'To zadanie jest już w kolejce.');
        if (row.status === 'needs_check' && row.container_id) return fail(409, 'Najpierw sprawdź na profilu, czy post wyszedł, i oznacz wynik.');
        await setRow(env, id, { status: 'queued', container_id: null, next_try_at: null, last_error: null, last_error_kind: null }, now); await log(env, id, 'queued', 'ponownie w kolejce', now); break;
      case 'resolve': {   // ręczne rozstrzygnięcie „do sprawdzenia”: post jest na profilu
        if (row.status !== 'needs_check' && row.status !== 'unknown') return fail(409, 'To zadanie nie czeka na sprawdzenie.');
        if (b.published) {
          await setRow(env, id, { status: 'published', media_id: String(b.mediaId || row.media_id || ''), permalink: b.permalink ? String(b.permalink).slice(0, 300) : row.permalink, published_at: now, last_error: null }, now);
          await log(env, id, 'published', 'potwierdzone ręcznie', now);
        } else { await setRow(env, id, { status: 'queued', container_id: null, last_error: null }, now); await log(env, id, 'queued', 'sprawdzone: posta nie ma, ponownie w kolejce', now); }
        break;
      }
      default: return fail(400, 'Nieznana akcja.');
    }
    return json({ post: await env.DB.prepare('SELECT * FROM ig_posts WHERE id = ?').bind(id).first() });
  }
  return null;
}
