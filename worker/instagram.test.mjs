import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { igTick, syncQueue, enqueue, igConfig, mergeConfig, buildCaption, igReject, classify, imageKey, instagramApi, igWanted, _resetEventsCache, IG_DEFAULTS } from './instagram.js';

const NOW = Date.parse('2026-11-24T10:05:00Z');            // 11:05 w Polsce, tuż po godzinie publikacji 11:00
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (status, error) => json({ error }, status);
const body = async req => { try { return await req.json(); } catch { return {}; } };

const EVENT = {
  id: 'ebilet-e1-AAA', title: 'Koncert Testowy', start: '2026-12-12T20:00', end: null, city: 'Warszawa', venue: 'Torwar', address: null,
  category: 'Concerts', tags: [], artists: ['Zespół A', 'Zespół B'], priceFrom: 129, image: 'https://www.ebilet.pl/media/plakat.webp',
  description: 'Wielki koncert w stolicy. Dalej szczegóły.', links: [{ source: 'ebilet', url: 'https://www.ebilet.pl/x' }], sources: ['ebilet', 'going'],
  big: true, firstSeen: '2026-11-24T09:00:00.000Z', hot: 12, imageRatio: 0.75
};

function fixture(t, { events = [EVENT], jpg = true, token = 'test-token' } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      const stmt = db.prepare(sql); let args = [];
      return {
        bind(...v) { args = v; return this; },
        async first(key) { const row = stmt.get(...args); return key ? row?.[key] ?? null : row || null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; }
      };
    }
  };
  const state = { events, jpg };
  const ASSETS = {
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === '/data/events.json') return json({ events: state.events });
      if (u.pathname.startsWith('/ig/')) return state.jpg ? new Response('x', { headers: { 'Content-Type': 'image/jpeg' } }) : new Response('', { status: 404 });
      return new Response('', { status: 404 });
    }
  };
  _resetEventsCache();
  const env = { DB, ASSETS, ...(token ? { IG_ACCESS_TOKEN: token } : {}) };
  const setCfg = async patch => db.prepare("INSERT INTO settings (key, value) VALUES ('instagram', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ ...(await igConfig(env)), ...patch }));
  const rows = () => db.prepare('SELECT * FROM ig_posts ORDER BY id').all();
  return { db, env, state, setCfg, rows };
}

/* atrapa Graph API: kolejka odpowiedzi po (metoda, ścieżka); zapisuje wywołania */
function meta(script = {}) {
  const calls = [];
  const fx = async (url, init) => {
    const u = new URL(url), key = init.method + ' ' + u.pathname.replace(/^\/v[\d.]+/, '');
    calls.push({ key, url, init });
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.ok(!u.search.includes('test-token') && !(init.body || '').includes('test-token'), 'token tylko w nagłówku');
    const h = script[key];
    const r = typeof h === 'function' ? h(calls.filter(c => c.key === key).length, u, init) : h;
    if (r instanceof Error) throw r;
    if (!r) throw new Error('nieoczekiwane wywołanie ' + key);
    return json(r.body ?? r, r.status || 200);
  };
  return { fx, calls, count: k => calls.filter(c => c.key === k).length };
}
const OK = {
  'GET /17841412007314040': { id: '17841412007314040', username: 'plusoneapp.pl' },
  'POST /17841412007314040/media': { id: 'C1' },
  'GET /C1': { status_code: 'FINISHED' },
  'POST /17841412007314040/media_publish': { id: 'M1' },
  'GET /M1': { permalink: 'https://www.instagram.com/p/abc/' }
};
const noSleep = async () => {};

test('podpis: dane z wydarzenia, bez emoji, w limitach Instagrama', () => {
  const c = buildCaption({ ...EVENT, title: 'Koncert \u{1F3A4} Testowy' }, IG_DEFAULTS);
  assert.match(c, /^Koncert Testowy\nsobota, 12 grudnia, 20:00 · Torwar, Warszawa/);
  assert.match(c, /Na scenie: Zespół A, Zespół B\./);
  assert.match(c, /Bilety od 129 zł\./);
  assert.match(c, /plusoneapp\.pl\/e\/ebilet-e1-AAA/);
  assert.doesNotMatch(c, /\p{Extended_Pictographic}/u);
  assert.match(buildCaption({ ...EVENT, venue: 'COS Torwar - Warszawa' }, IG_DEFAULTS), /20:00 · COS Torwar - Warszawa\n/);
  const long = buildCaption({ ...EVENT, artists: [], description: 'x'.repeat(5000) }, { ...IG_DEFAULTS, template: '{opis}\n' + Array.from({ length: 40 }, (_, i) => '#tag' + i).join(' ') });
  assert.ok(long.length <= 2200);
  assert.ok((long.match(/#\w+/g) || []).length <= 30);
});

test('filtr: plakat, termin, kategoria, słowa, aktywacja', () => {
  const cfg = { ...IG_DEFAULTS, activatedAt: Date.parse('2026-11-24T00:00:00Z') };
  assert.equal(igReject(EVENT, cfg, {}, NOW), null);
  assert.equal(igReject({ ...EVENT, image: '' }, cfg, {}, NOW), 'brak plakatu');
  assert.match(igReject({ ...EVENT, image: 'https://plusoneapp.pl/img/obiekty/torwar.jpg' }, cfg, {}, NOW), /zdjęcie miejsca/);
  assert.equal(igReject({ ...EVENT, start: '2026-11-25T20:00' }, cfg, {}, NOW), 'za blisko terminu');
  assert.equal(igReject({ ...EVENT, category: 'Culture' }, cfg, {}, NOW), 'kategoria poza filtrem');
  assert.match(igReject({ ...EVENT, title: 'Warsztaty ceramiki' }, cfg, {}, NOW), /słowo wykluczone/);
  assert.equal(igReject({ ...EVENT, firstSeen: '2026-10-01T00:00:00Z' }, cfg, {}, NOW), 'było przed aktywacją');
  assert.equal(igReject(EVENT, cfg, { hidden: new Set([EVENT.id]) }, NOW), 'ukryte w moderacji');
});

test('rodzaje błędów Meta: autoryzacja, przejściowe, trwałe', () => {
  assert.equal(classify(400, { code: 190 }), 'auth');
  assert.equal(classify(403, { code: 10 }), 'auth');
  assert.equal(classify(400, { code: 4 }), 'transient');
  assert.equal(classify(503, {}), 'transient');
  assert.equal(classify(400, { code: 9004, error_subcode: 2207052 }), 'permanent');
});

test('duplikat: powtórny import, edycja i równoległy wybór nie tworzą drugiego posta', async t => {
  const f = fixture(t);
  await f.setCfg({ autoSelect: true, activatedAt: Date.parse('2026-11-24T00:00:00Z'), minScore: 10 });
  const cfg = await igConfig(f.env);
  const [a, b] = await Promise.all([syncQueue(f.env, cfg, { now: NOW }), syncQueue(f.env, cfg, { now: NOW })]);
  assert.equal(a.added + b.added, 1);
  // ponowny import z poprawionym opisem i nowym id tego samego wydarzenia (tytuł + dzień + miasto)
  f.state.events = [{ ...EVENT, description: 'Nowy opis.', id: 'going-999' }]; _resetEventsCache();
  assert.equal((await syncQueue(f.env, cfg, { now: NOW })).added, 0);
  const again = await enqueue(f.env, cfg, EVENT, { origin: 'manual', now: NOW });
  assert.equal(again.created, false);
  // ten sam koncert z innego serwisu pod innym tytułem (miasto + dzień + pierwsze słowo)
  const other = await enqueue(f.env, cfg, { ...EVENT, id: 'allevents-1', title: 'Koncert w Warszawie', image: 'https://x.test/a.jpg' }, { origin: 'manual', now: NOW });
  assert.equal(other.created, false);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].status, 'review');   // auto-wybór czeka na akceptację
});

test('wysyłka wyłączona domyślnie: brak połączeń z Meta', async t => {
  const f = fixture(t);
  const m = meta(OK);
  await enqueue(f.env, await igConfig(f.env), EVENT, { origin: 'manual', now: NOW });
  const r = await igTick(f.env, { now: NOW, fx: m.fx, sleep: noSleep });
  assert.equal(r.skipped, 'wysyłka wyłączona');
  assert.equal(m.calls.length, 0);
  assert.equal(f.rows()[0].status, 'queued');
});

test('brak grafiki JPEG: zadanie czeka z czytelnym stanem, nic nie idzie do Meta', async t => {
  const f = fixture(t, { jpg: false });
  await f.setCfg({ sendEnabled: true });
  const m = meta(OK);
  await enqueue(f.env, await igConfig(f.env), EVENT, { origin: 'manual', now: NOW });
  await igTick(f.env, { now: NOW, fx: m.fx, sleep: noSleep });
  const row = f.rows()[0];
  assert.equal(row.status, 'queued');
  assert.match(row.last_error, /czeka na grafikę JPEG/);
  assert.equal(m.calls.length, 0);
  // pipeline pyta o tę grafikę
  const w = await (await igWanted(f.env, json)).json();
  assert.deepEqual(w.render, [{ key: await imageKey(EVENT.image), src: EVENT.image }]);
});

test('potwierdzony sukces: kontener → FINISHED → media_publish → ID medium i link', async t => {
  const f = fixture(t);
  await f.setCfg({ sendEnabled: true });
  const m = meta(OK);
  await enqueue(f.env, await igConfig(f.env), EVENT, { origin: 'manual', now: NOW });
  const r = await igTick(f.env, { now: NOW, fx: m.fx, sleep: noSleep });
  assert.equal(r.sent, 1);
  const row = f.rows()[0];
  assert.equal(row.status, 'published');
  assert.equal(row.container_id, 'C1');
  assert.equal(row.media_id, 'M1');
  assert.equal(row.permalink, 'https://www.instagram.com/p/abc/');
  const create = m.calls.find(c => c.key === 'POST /17841412007314040/media');
  const p = new URLSearchParams(create.init.body);
  assert.equal(p.get('image_url'), 'https://plusoneapp.pl/ig/' + await imageKey(EVENT.image) + '.jpg');
  assert.equal(p.get('caption'), row.caption);
  // kolejny przebieg nie publikuje ponownie
  await igTick(f.env, { now: NOW + 600e3, fx: m.fx, sleep: noSleep });
  assert.equal(m.count('POST /17841412007314040/media_publish'), 1);
});

test('timeout po media_publish: uzgodnienie stanu kontenera, bez drugiej publikacji', async t => {
  const f = fixture(t);
  await f.setCfg({ sendEnabled: true });
  const m = meta({ ...OK,
    'POST /17841412007314040/media_publish': Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    'GET /C1': n => n === 1 ? { status_code: 'FINISHED' } : { status_code: 'PUBLISHED' },
    'GET /17841412007314040/media': { data: [{ id: 'M7', caption: null }, { id: 'M1', caption: buildCaption(EVENT, IG_DEFAULTS) }] } });
  await enqueue(f.env, await igConfig(f.env), EVENT, { origin: 'manual', now: NOW });
  await igTick(f.env, { now: NOW, fx: m.fx, sleep: noSleep });
  assert.equal(f.rows()[0].status, 'unknown');
  assert.equal(f.rows()[0].last_error_kind, 'ambiguous');
  await igTick(f.env, { now: NOW + 600e3, fx: m.fx, sleep: noSleep });
  const row = f.rows()[0];
  assert.equal(row.status, 'published');
  assert.equal(row.media_id, 'M1');
  assert.equal(m.count('POST /17841412007314040/media_publish'), 1, 'bez ponownego media_publish');
});

test('timeout po media_publish, kontener nieopublikowany (FINISHED): bezpieczna ponowna publikacja', async t => {
  const f = fixture(t);
  await f.setCfg({ sendEnabled: true });
  const m = meta({ ...OK, 'POST /17841412007314040/media_publish': n => n === 1 ? Object.assign(new Error('x'), { name: 'TimeoutError' }) : { id: 'M2' } });
  await enqueue(f.env, await igConfig(f.env), EVENT, { origin: 'manual', now: NOW });
  await igTick(f.env, { now: NOW, fx: m.fx, sleep: noSleep });
  await igTick(f.env, { now: NOW + 600e3, fx: m.fx, sleep: noSleep });   // uzgodnienie: FINISHED → wraca do publikacji
  await igTick(f.env, { now: NOW + 1200e3, fx: m.fx, sleep: noSleep });
  assert.equal(f.rows()[0].status, 'published');
  assert.equal(f.rows()[0].media_id, 'M2');
  assert.equal(m.count('POST /17841412007314040/media'), 1, 'jeden kontener');
});

test('nierozstrzygnięty stan: zadanie zatrzymane do sprawdzenia', async t => {
  const f = fixture(t);
  await f.setCfg({ sendEnabled: true });
  const m = meta({ ...OK,
    'POST /17841412007314040/media_publish': Object.assign(new Error('x'), { name: 'TimeoutError' }),
    'GET /C1': n => n === 1 ? { status_code: 'FINISHED' } : { status: 500, body: { error: { message: 'boom', code: 2 } } } });
  await enqueue(f.env, await igConfig(f.env), EVENT, { origin: 'manual', now: NOW });
  for (let i = 0; i < 10; i++) await igTick(f.env, { now: NOW + i * 600e3, fx: m.fx, sleep: noSleep });
  assert.equal(f.rows()[0].status, 'needs_check');
  assert.equal(m.count('POST /17841412007314040/media_publish'), 1);
});

test('błąd autoryzacji wstrzymuje wysyłkę; zła nazwa profilu też', async t => {
  const f = fixture(t);
  await f.setCfg({ sendEnabled: true });
  const m = meta({ 'GET /17841412007314040': { id: '1', username: 'ktos.inny' } });
  await enqueue(f.env, await igConfig(f.env), EVENT, { origin: 'manual', now: NOW });
  await igTick(f.env, { now: NOW, fx: m.fx, sleep: noSleep });
  const cfg = await igConfig(f.env);
  assert.match(cfg.authError.msg, /ktos\.inny/);
  assert.equal(f.rows()[0].status, 'queued');
  const r = await igTick(f.env, { now: NOW + 600e3, fx: m.fx, sleep: noSleep });
  assert.match(r.skipped, /wstrzymane/);
  assert.equal(m.calls.length, 1);
});

test('przed wysyłką: wydarzenie ukryte albo usunięte nie wychodzi', async t => {
  const f = fixture(t);
  await f.setCfg({ sendEnabled: true });
  const m = meta(OK);
  await enqueue(f.env, await igConfig(f.env), EVENT, { origin: 'manual', now: NOW });
  f.db.prepare("INSERT INTO curation (event_id, action, at) VALUES (?, 'hide', ?)").run(EVENT.id, NOW);
  await igTick(f.env, { now: NOW, fx: m.fx, sleep: noSleep });
  assert.equal(f.rows()[0].status, 'skipped');
  assert.equal(m.calls.length, 0);
});

test('limit dzienny i godziny publikacji', async t => {
  const f = fixture(t, { events: [EVENT, { ...EVENT, id: 'e2', title: 'Inny koncert' }] });
  await f.setCfg({ sendEnabled: true, dailyLimit: 1 });
  const m = meta(OK);
  const cfg = await igConfig(f.env);
  await enqueue(f.env, cfg, EVENT, { origin: 'manual', now: NOW });
  await enqueue(f.env, cfg, { ...EVENT, id: 'e2', title: 'Inny koncert' }, { origin: 'manual', now: NOW });
  await igTick(f.env, { now: NOW, fx: m.fx, sleep: noSleep });
  const r = await igTick(f.env, { now: NOW + 600e3, fx: m.fx, sleep: noSleep });
  assert.equal(r.skipped, 'limit');
  assert.deepEqual(f.rows().map(x => x.status), ['published', 'queued']);
  // poza godziną (9:00 w Polsce) nic nie wychodzi
  const f2 = fixture(t); await f2.setCfg({ sendEnabled: true });
  await enqueue(f2.env, await igConfig(f2.env), EVENT, { origin: 'manual', now: NOW });
  assert.equal((await igTick(f2.env, { now: Date.parse('2026-11-24T08:00:00Z'), fx: meta(OK).fx, sleep: noSleep })).skipped, 'poza godziną publikacji');
});

test('panel: podgląd, ręczne dodanie, duplikat 409, poprawiony podpis zostaje wzorcem', async t => {
  const f = fixture(t);
  const user = { id: 1 };
  const call = async (path, data) => {
    const req = new Request('https://plusone.test' + path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const r = await instagramApi(path, data ? 'POST' : 'GET', req, f.env, user, { json, fail, body });
    return { status: r.status, ...await r.json() };
  };
  const p = await call('/api/admin/ig/preview', { eventId: EVENT.id });
  assert.equal(p.account, '@plusoneapp.pl');
  assert.equal(p.image, EVENT.image);
  assert.ok(p.caption.startsWith('Koncert Testowy'));
  assert.equal((await call('/api/admin/ig/add', { eventId: EVENT.id })).post.status, 'queued');
  assert.equal((await call('/api/admin/ig/add', { eventId: EVENT.id })).status, 409);
  // auto-wybrane czeka na akceptację; poprawiony podpis po akceptacji trafia do wzorców
  await f.setCfg({});
  const cfg = await igConfig(f.env);
  const { row } = await enqueue(f.env, cfg, { ...EVENT, id: 'e3', title: 'Trzeci koncert' }, { now: NOW });
  assert.equal(row.status, 'review');
  await call('/api/admin/ig/post/' + row.id, { action: 'caption', caption: 'Mój podpis ✨ #plusoneapp' });
  const ok = await call('/api/admin/ig/post/' + row.id, { action: 'approve' });
  assert.equal(ok.post.status, 'queued');
  assert.equal(ok.post.caption, 'Mój podpis #plusoneapp');
  assert.equal((await igConfig(f.env)).examples[0].caption, 'Mój podpis #plusoneapp');
  // włączenie wysyłki bez tokenu jest blokowane
  const f2 = fixture(t, { token: null });
  const req = new Request('https://plusone.test/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sendEnabled: true }) });
  assert.equal((await instagramApi('/api/admin/ig/config', 'POST', req, f2.env, user, { json, fail, body })).status, 400);
});

test('aktywacja: włączenie wyboru zapisuje moment — starsze wydarzenia nie wchodzą', () => {
  const c = mergeConfig(IG_DEFAULTS, { autoSelect: true, dailyLimit: 999, slots: ['19:00', 'zła', '11:30'] }, NOW);
  assert.equal(c.activatedAt, NOW);
  assert.equal(c.dailyLimit, 25);
  assert.deepEqual(c.slots, ['11:30', '19:00']);
  assert.equal(mergeConfig(c, { autoSelect: true }, NOW + 1).activatedAt, NOW);
});
