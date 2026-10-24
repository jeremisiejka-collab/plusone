import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { socialApi, socialAge } from './social.js';

// Prawdziwy SQLite i migracje aplikacji, z interfejsem zgodnym z D1.
function fixture(t, { encountersLive = true } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  db.exec('DELETE FROM users');
  const DB = {
    prepare(sql) {
      const stmt = db.prepare(sql); let args = [];
      return {
        bind(...v) { args = v; return this; },
        async first(key) { const row = stmt.get(...args); return key ? row?.[key] ?? null : row || null; },
        async all() { return { results: stmt.all(...args) }; },
        runSync() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
        async run() { return this.runSync(); }
      };
    },
    async batch(ops) {
      db.exec('BEGIN');
      try { const r = ops.map(op => op.runSync()); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
  const users = [1, 2, 3, 4, 5].map(id => ({ id, role: id === 4 ? 'admin' : 'user', perm_scan: id === 5 ? 1 : 0 }));
  for (const u of users) db.prepare('INSERT INTO users (id, email, name, pass, role, perm_scan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, 'test-' + u.id + '@example.invalid', 'Osoba ' + u.id, 'unused', u.role, u.perm_scan, Date.now());
  const call = async (suffix, user = users[0], data, method = data === undefined ? 'GET' : 'POST') => {
    const req = new Request('https://plusone.test/api/social/' + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(data) });
    const r = await socialApi(new URL(req.url).pathname, method, req, { DB, ...(encountersLive ? { ENCOUNTERS_LIVE: 'true' } : {}) }, user);
    return { status: r.status, ...await r.json() };
  };
  const addProfile = async (u, override = {}) => {
    const r = await call('me', u, { name: 'Osoba ' + u.id, birthDate: '2000-01-01', bio: 'Koncerty', opener: 'Jaki koncert pamiętasz najlepiej?', ...override }, 'PUT');
    assert.equal(r.status, 200, r.error); return r.profile;
  };
  const addEvent = async () => {
    const r = await call('admin/events', users[3], { title: 'Testowe spotkanie +1', city: 'Warszawa', venue: 'Testowe miejsce', meetingPoint: 'Punkt +1', startsAt: Date.now() - 60000, endsAt: Date.now() + 3600000 });
    assert.equal(r.status, 201, r.error); return r.id;
  };
  const join = async (u, eventId) => assert.equal((await call('join', u, { eventId, on: true })).status, 200);
  const verify = async (u, eventId) => {
    const { code } = await call('code', u, {});
    const info = await call('verify', users[4], { code, eventId });
    assert.equal(info.status, 200, info.error);
    const r = await call('verify', users[4], { code, eventId, birthDate: info.birthDate, name: info.name, confirmed: true }, 'PUT');
    assert.equal(r.status, 200, r.error); return code;
  };
  const ready = async () => {
    const eventId = await addEvent();
    for (const u of users.slice(0, 3)) { await addProfile(u); await join(u, eventId); await verify(u, eventId); }
    return eventId;
  };
  const match = async eventId => {
    await call('plus', users[0], { eventId, userId: 2 });
    assert.equal((await call('plus', users[1], { eventId, userId: 1 })).matched, true);
  };
  return { db, call, users, addProfile, addEvent, join, verify, ready, match };
}

test('wiek uwzględnia urodziny i odrzuca niemożliwe daty', () => {
  assert.equal(socialAge('2008-10-24', '2026-10-24'), 18);
  assert.equal(socialAge('2008-10-25', '2026-10-24'), 17);
  assert.equal(socialAge('2000-02-29', '2026-02-28'), 25);
  for (const date of ['2001-02-29', '2000-04-31', 'bad', '2027-01-01', '1800-01-01']) assert.equal(socialAge(date, '2026-10-24'), null);
});

test('profil wymaga 18+, nie przyjmuje potwierdzenia od użytkownika i usuwa emoji', async t => {
  const f = fixture(t);
  assert.equal((await f.call('me', f.users[0], { name: 'A', opener: 'Hej', birthDate: '2015-01-01' }, 'PUT')).status, 400);
  const p = await f.addProfile(f.users[0], { name: 'A \u{1F44B}', bio: 'Koncert \u{1F3B5}', verified_at: Date.now(), verified: true });
  assert.equal(p.verified, false); assert.equal(p.name, 'A'); assert.equal(p.bio, 'Koncert');
  assert.equal((await f.call('me', null)).status, 401);
  assert.equal((await f.call('me', { ...f.users[0], must_change: 1 })).status, 403);
  assert.equal((await f.call('me', f.users[0], null, 'PUT')).status, 400);
});

test('tylko admin publikuje spotkania; rejestracja i bilet nie wystarczą do odkrywania osób', async t => {
  const f = fixture(t), id = await f.addEvent();
  assert.equal((await f.call('admin/events', f.users[0], {})).status, 403);
  assert.equal((await f.call('admin/events', f.users[4], {})).status, 403);
  assert.equal((await f.call('admin/events', f.users[3], {})).status, 400);
  assert.equal((await f.call('join', f.users[0], { eventId: id, on: true })).status, 403);
  await f.addProfile(f.users[0]); await f.join(f.users[0], id);
  assert.equal((await f.call('people?event=' + id)).status, 403);
  assert.equal((await f.call('plus', f.users[0], { eventId: id, userId: 2 })).status, 403);
});

test('obsługa sprawdza dokument i jednorazowy kod; potwierdzonych danych nie da się podmienić', async t => {
  const f = fixture(t), id = await f.addEvent();
  await f.addProfile(f.users[0]); await f.join(f.users[0], id);
  const { code } = await f.call('code', f.users[0], {});
  const data = { code, eventId: id };
  assert.equal((await f.call('verify', f.users[1], data)).status, 403);
  assert.equal((await f.call('verify', f.users[4], { ...data, confirmed: false }, 'PUT')).status, 409);
  assert.equal((await f.call('verify', f.users[4], data)).birthDate, '2000-01-01');
  assert.equal((await f.call('verify', f.users[4], { ...data, confirmed: true, birthDate: '1999-01-01', name: 'Osoba 1' }, 'PUT')).status, 409);
  assert.equal((await f.call('verify', f.users[4], { ...data, confirmed: true, birthDate: '2000-01-01', name: 'Osoba 1' }, 'PUT')).status, 200);
  assert.equal((await f.call('verify', f.users[4], data)).status, 410);
  assert.equal((await f.call('me')).profile.verified, true);
  assert.equal((await f.call('me', f.users[0], { name: 'Osoba 1', opener: 'Hej', birthDate: '1990-01-01' }, 'PUT')).status, 409);
  await f.addProfile(f.users[4]); await f.join(f.users[4], id);
  const selfCode = (await f.call('code', f.users[4], {})).code;
  assert.equal((await f.call('verify', f.users[4], { code: selfCode, eventId: id })).status, 403);
  const expired = (await f.call('code', f.users[0], {})).code;
  f.db.prepare('UPDATE social_codes SET expires_at = 0 WHERE user_id = 1').run();
  assert.equal((await f.call('verify', f.users[4], { code: expired, eventId: id })).status, 410);
});

test('uczestnicy widzą tylko obecne, potwierdzone osoby z własnego spotkania, bez dat urodzenia', async t => {
  const f = fixture(t), id = await f.ready(), other = await f.addEvent();
  const r = await f.call('people?event=' + id);
  assert.deepEqual(r.people.map(p => p.id), [2, 3]);
  for (const p of r.people) {
    assert.equal(p.verified, true); assert.equal(p.birthDate, undefined); assert.equal(p.birth_date, undefined);
    assert.equal(p.verified_by, undefined); assert.equal(p.email, undefined);
  }
  assert.equal((await f.call('people?event=' + other)).status, 403);
  await f.join(f.users[0], other);
  assert.equal((await f.call('people?event=' + other)).status, 403);
  await f.verify(f.users[0], other);
  assert.deepEqual((await f.call('people?event=' + other)).people, []);
});

test('rozmowa wymaga wzajemnych plusików, zapisuje wiadomości i nie jest widoczna dla trzeciej osoby', async t => {
  const f = fixture(t), id = await f.ready(), data = { eventId: id, userId: 2, text: 'Cześć \u{1F44B}' };
  assert.equal((await f.call('messages', f.users[0], data)).status, 403);
  assert.equal((await f.call('plus', f.users[0], { eventId: id, userId: 2 })).matched, false);
  assert.equal((await f.call('messages', f.users[0], data)).status, 403);
  assert.equal((await f.call('people?event=' + id, f.users[1])).people.find(p => p.id === 1).received, true);
  assert.equal((await f.call('plus', f.users[1], { eventId: id, userId: 1 })).matched, true);
  assert.equal((await f.call('matches')).matches[0].id, 2);
  assert.equal((await f.call('messages', f.users[0], data)).messages[0].text, 'Cześć');
  const received = await f.call('messages?event=' + id + '&user=1', f.users[1]);
  assert.equal(received.messages[0].mine, false);
  assert.equal((await f.call('messages?event=' + id + '&user=1', f.users[2])).status, 403);
  assert.equal((await f.call('messages?event=' + id + '&user=bad')).status, 403);
  await f.call('plus', f.users[1], { eventId: id, userId: 1, on: false });
  assert.equal((await f.call('messages', f.users[0], data)).status, 403);
});

test('blokada odcina widoczność i rozmowę w obie strony; zgłoszenie ma działającą moderację', async t => {
  const f = fixture(t), id = await f.ready(); await f.match(id);
  assert.equal((await f.call('block', f.users[0], { eventId: id, userId: 2, reason: 'Niechciany kontakt' })).status, 200);
  for (const [a, b] of [[1, 2], [2, 1]]) {
    assert.ok(!(await f.call('people?event=' + id, f.users[a - 1])).people.some(p => p.id === b));
    assert.deepEqual((await f.call('matches', f.users[a - 1])).matches, []);
    assert.equal((await f.call('plus', f.users[a - 1], { eventId: id, userId: b })).status, 403);
    assert.equal((await f.call('messages?event=' + id + '&user=' + b, f.users[a - 1])).status, 403);
  }
  assert.equal((await f.call('admin/reports')).status, 403);
  const reports = (await f.call('admin/reports', f.users[3])).reports;
  assert.equal(reports.length, 1);
  await f.call('admin/reports', f.users[3], { id: reports[0].id, suspend: true });
  assert.equal((await f.call('me', f.users[1])).profile.suspended, true);
  assert.equal((await f.call('me', f.users[1], {}, 'DELETE')).status, 403);
  assert.ok(!(await f.call('people?event=' + id, f.users[2])).people.some(p => p.id === 2));
});

test('wyłączenie poznawania usuwa połączenia, a ponowne włączenie nie przywraca zgody', async t => {
  const f = fixture(t), id = await f.ready(); await f.match(id);
  await f.call('join', f.users[0], { eventId: id, on: false });
  assert.equal((await f.call('people?event=' + id)).status, 403);
  assert.equal((await f.call('messages?event=' + id + '&user=1', f.users[1])).status, 403);
  await f.join(f.users[0], id);
  assert.deepEqual((await f.call('matches')).matches, []);
});

test('koniec spotkania zatrzymuje poznawanie; wyłączenie przez admina odcina także rozmowy', async t => {
  const f = fixture(t), id = await f.ready(); await f.match(id);
  f.db.prepare('UPDATE social_events SET ends_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal((await f.call('people?event=' + id)).status, 403);
  assert.equal((await f.call('plus', f.users[0], { eventId: id, userId: 3 })).status, 403);
  assert.equal((await f.call('matches')).matches.length, 1);
  await f.call('admin/events', f.users[3], { eventId: id }, 'DELETE');
  assert.deepEqual((await f.call('matches')).matches, []);
  assert.equal((await f.call('messages?event=' + id + '&user=2')).status, 403);
});

test('usunięcie profilu kasuje rozmowy i weryfikację, zachowując konto; usunięcie konta respektuje FK', async t => {
  const f = fixture(t), id = await f.ready(); await f.match(id);
  await f.call('messages', f.users[0], { eventId: id, userId: 2, text: 'Hej' });
  assert.equal((await f.call('me', f.users[0], {}, 'DELETE')).status, 200);
  assert.equal((await f.call('me')).profile, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_messages').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users WHERE id = 1').get().n, 1);
  // Usuwanie osoby, która potwierdziła wiek, nie usuwa profili uczestników.
  f.db.prepare('DELETE FROM users WHERE id = 5').run();
  assert.equal((await f.call('me', f.users[1])).profile.verified, true);
  f.db.prepare('DELETE FROM users WHERE id = 2').run();
  assert.equal((await f.call('me', f.users[1])).profile, null);
});

const queue = (f, user, eventId, intent = 'talk', pace = 'calm') => f.call('encounter', user, { action: 'queue', eventId, intent, pace });
const roundAct = (f, user, token, action) => f.call('encounter', user, { action, token });
async function liveRound(f, id) {
  await queue(f, f.users[0], id);
  const r = await queue(f, f.users[1], id);
  await roundAct(f, f.users[0], r.token, 'accept');
  const live = await roundAct(f, f.users[1], r.token, 'accept');
  assert.equal(live.state, 'live'); return live;
}

test('runda wymaga potwierdzonej obecności i odpowiedzi na oba pytania', async t => {
  const f = fixture(t), id = await f.addEvent();
  assert.equal((await queue(f, f.users[0], id)).status, 403);
  await f.addProfile(f.users[0]); await f.join(f.users[0], id);
  assert.equal((await queue(f, f.users[0], id)).status, 403);
  await f.verify(f.users[0], id);
  assert.equal((await queue(f, f.users[0], id, 'invalid')).status, 400);
  assert.equal((await queue(f, f.users[0], id, 'talk', '')).status, 400);
  assert.equal((await queue(f, f.users[0], id)).state, 'waiting');
  assert.equal((await f.call('encounter')).state, 'waiting');
});

test('jedna para ma wspólny znak dopiero po dwóch zgodach, a kontakt dopiero po spotkaniu i dwóch plusikach', async t => {
  const f = fixture(t), id = await f.ready();
  assert.equal((await queue(f, f.users[0], id)).state, 'waiting');
  const proposal = await queue(f, f.users[1], id);
  assert.equal(proposal.state, 'proposed'); assert.equal(proposal.signal, undefined); assert.equal(proposal.person, undefined);
  assert.equal((await f.call('encounter')).token, proposal.token);
  // Trzecia osoba nie może odczytać ani przyjąć propozycji innej pary.
  assert.equal((await queue(f, f.users[2], id)).state, 'waiting');
  assert.equal((await roundAct(f, f.users[2], proposal.token, 'accept')).status, 409);
  const yes = await roundAct(f, f.users[0], proposal.token, 'accept');
  assert.equal(yes.accepted, true); assert.equal(yes.state, 'proposed'); assert.equal(yes.person, undefined);
  const live = await roundAct(f, f.users[1], proposal.token, 'accept');
  assert.equal(live.state, 'live');
  const other = await f.call('encounter');
  assert.deepEqual(live.signal, other.signal); assert.equal(live.mission, other.mission);
  assert.equal(live.person.id, 1); assert.equal(other.person.id, 2); assert.equal(live.person.birthDate, undefined);
  assert.equal((await roundAct(f, f.users[0], proposal.token, 'keep')).status, 409);
  await roundAct(f, f.users[0], proposal.token, 'met');
  assert.equal((await f.call('encounter')).state, 'live');
  assert.equal((await roundAct(f, f.users[1], proposal.token, 'met')).state, 'met');
  await roundAct(f, f.users[0], proposal.token, 'keep');
  assert.deepEqual((await f.call('matches')).matches, []);
  assert.equal((await f.call('messages?event=' + id + '&user=2')).status, 403);
  assert.equal((await roundAct(f, f.users[1], proposal.token, 'keep')).state, 'connected');
  assert.equal((await f.call('matches')).matches[0].id, 2);
  await roundAct(f, f.users[0], proposal.token, 'cancel');
  assert.equal((await f.call('encounter')).state, 'idle');
  assert.equal((await f.call('matches')).matches[0].id, 2);
});

test('równoczesne wejście kilku osób nie przydziela tej samej osoby do dwóch par', async t => {
  const f = fixture(t), id = await f.ready();
  await Promise.all(f.users.slice(0, 3).map(u => queue(f, u, id)));
  const states = await Promise.all(f.users.slice(0, 3).map(u => f.call('encounter', u)));
  const paired = states.filter(s => s.state === 'proposed');
  assert.equal(paired.length, 2); assert.equal(paired[0].token, paired[1].token);
  assert.equal(states.filter(s => s.state === 'waiting').length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_encounters').get().n, 1);
  const index = states.findIndex(s => s.state === 'proposed');
  assert.equal((await queue(f, f.users[index], id)).token, paired[0].token);
});

test('dobieranie respektuje wydarzenie, intencję, obecność w kolejce i blokady', async t => {
  const f = fixture(t), id = await f.ready(), other = await f.addEvent();
  await f.join(f.users[2], other); await f.verify(f.users[2], other);
  await queue(f, f.users[0], id, 'dance');
  assert.equal((await queue(f, f.users[1], id, 'talk')).state, 'waiting');
  assert.equal((await queue(f, f.users[2], other, 'dance')).state, 'waiting');
  f.db.prepare('UPDATE social_encounter_queue SET heartbeat_at = 0 WHERE user_id = 1').run();
  assert.equal((await queue(f, f.users[1], id, 'surprise')).state, 'waiting');
  await f.call('block', f.users[0], { userId: 2 });
  assert.equal((await f.call('encounter', f.users[0], { action: 'pulse' })).state, 'waiting');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_encounters').get().n, 0);
});

test('pauza kończy propozycję obojgu i nie dobiera ponownie tej samej osoby', async t => {
  const f = fixture(t), id = await f.ready();
  await queue(f, f.users[0], id);
  const r = await queue(f, f.users[1], id);
  await roundAct(f, f.users[0], r.token, 'cancel');
  assert.equal((await f.call('encounter', f.users[1])).state, 'closed');
  assert.equal((await queue(f, f.users[0], id)).state, 'waiting');
  assert.equal((await queue(f, f.users[1], id)).state, 'waiting');
  const next = await queue(f, f.users[2], id);
  assert.equal(next.state, 'proposed'); assert.notEqual(next.token, r.token);
});

test('wygasła propozycja, wyłączony udział i usunięcie profilu odcinają rundę', async t => {
  const f = fixture(t), id = await f.ready();
  let r = await liveRound(f, id);
  f.db.prepare('UPDATE social_encounters SET expires_at = 0 WHERE token = ?').run(r.token);
  assert.equal((await f.call('encounter')).state, 'closed');
  assert.equal((await roundAct(f, f.users[0], r.token, 'met')).status, 409);
  await queue(f, f.users[0], id);
  r = await queue(f, f.users[2], id);
  await roundAct(f, f.users[0], r.token, 'accept'); await roundAct(f, f.users[2], r.token, 'accept');
  await f.call('join', f.users[0], { eventId: id, on: false });
  const closed = await f.call('encounter', f.users[2]);
  assert.equal(closed.state, 'closed'); assert.equal(closed.person, undefined); assert.equal(closed.signal, undefined);
  await f.call('me', f.users[0], {}, 'DELETE');
  assert.equal((await f.call('encounter', f.users[2])).state, 'idle');
});

test('dobieranie pomija już poznane osoby i znajomych, a blokada usuwa aktywny znak', async t => {
  const f = fixture(t), id = await f.ready();
  await f.match(id);
  await queue(f, f.users[0], id);
  assert.equal((await queue(f, f.users[1], id)).state, 'waiting');
  f.db.prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (3, 1, ?)').run(Date.now());
  const r = await queue(f, f.users[2], id);
  assert.equal(r.state, 'proposed'); // osoba 3 trafia na osobę 2, nie znajomego 1
  assert.equal((await f.call('encounter', f.users[0])).state, 'waiting');
  await roundAct(f, f.users[1], r.token, 'accept'); await roundAct(f, f.users[2], r.token, 'accept');
  await f.call('block', f.users[2], { userId: 2 });
  const blocked = await f.call('encounter', f.users[1]);
  assert.equal(blocked.state, 'closed'); assert.equal(blocked.signal, undefined); assert.equal(blocked.person, undefined);
});

test('przed premierą API pokazuje zapowiedź i nie uruchamia ani nie odświeża dobierania', async t => {
  const f = fixture(t, { encountersLive: false }), id = await f.ready();
  const preview = await f.call('encounter');
  assert.equal(preview.state, 'closed');
  assert.match(preview.reason, /już wkrótce na naszych wydarzeniach/);
  for (const action of ['queue', 'pulse', 'accept', 'met', 'keep']) {
    const r = await f.call('encounter', f.users[0], { action, eventId: id, intent: 'talk', pace: 'calm' });
    assert.equal(r.status, 503);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_encounter_queue').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_encounters').get().n, 0);
});
