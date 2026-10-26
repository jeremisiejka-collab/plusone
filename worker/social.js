/* „Znajdź swoje +1”: wyłącznie dobrowolne profile dorosłych uczestników
   autorskich spotkań. Wiek i obecność potwierdza obsługa na miejscu. */
import { stripEmoji } from '../pipeline/lib/normalize.mjs';
import { encounterApi } from './encounters.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
const fail = (status, error) => json({ error }, status);
const clean = (s, n) => stripEmoji(String(s || '').replace(/[\u0000-\u001f]/g, ' ')).trim().slice(0, n);
const admin = u => !!u && !!u.owner;
const staff = u => admin(u) || !!u?.perm_scan || !!u?.perm_org;
const dayPL = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date());
export function socialAge(birth, day = dayPL()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth || '')) return null;
  const d = new Date(birth + 'T12:00:00Z');
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== birth) return null;
  const age = +day.slice(0, 4) - +birth.slice(0, 4) - (day.slice(5) < birth.slice(5) ? 1 : 0);
  return age >= 0 && age <= 110 ? age : null;
}
const profile = (env, id) => env.DB.prepare('SELECT * FROM social_profiles WHERE user_id = ?').bind(id).first();
const publicProfile = p => ({ id: p.user_id, name: p.name, age: socialAge(p.birth_date), bio: p.bio, opener: p.opener, verified: !!p.verified_at });
const validProfile = p => !!p && !p.suspended && !!p.verified_at && socialAge(p.birth_date) >= 18;
const ownProfile = p => p ? { ...publicProfile(p), birthDate: p.birth_date, suspended: !!p.suspended } : null;
const hash = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');
const event = (env, id) => env.DB.prepare('SELECT * FROM social_events WHERE id = ? AND enabled = 1').bind(id).first();
const active = e => !!e && e.starts_at <= Date.now() && e.ends_at > Date.now();
const attendee = (env, eid, uid) => env.DB.prepare('SELECT * FROM social_attendees WHERE event_id = ? AND user_id = ?').bind(eid, uid).first();
const blocked = (env, a, b) => env.DB.prepare('SELECT 1 FROM social_blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').bind(a, b, b, a).first();
async function eligible(env, eid, uid) {
  const [p, a] = await Promise.all([profile(env, uid), attendee(env, eid, uid)]);
  return validProfile(p) && !!a?.opted_in && !!a.checked_at;
}
async function pair(env, eid, a, b) {
  if (a === b || !await event(env, eid) || await blocked(env, a, b)) return false;
  if (!await eligible(env, eid, a) || !await eligible(env, eid, b)) return false;
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM social_pluses WHERE event_id = ?
    AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))`).bind(eid, a, b, b, a).first('n')) === 2;
}
const clearPluses = (env, eid, uid) => env.DB.prepare('DELETE FROM social_pluses WHERE event_id = ? AND (from_user = ? OR to_user = ?)').bind(eid, uid, uid);

export async function socialApi(path, method, req, env, user) {
  if (!path.startsWith('/api/social/')) return null;
  if (!user) return fail(401, 'Zaloguj się.');
  if (user.must_change) return fail(403, 'Najpierw ustaw nowe hasło.');
  let b = {};
  if (method !== 'GET') { try { b = await req.json(); } catch { return fail(400, 'Nieprawidłowe dane.'); } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'Nieprawidłowe dane.');
  if (path === '/api/social/encounter') {
    if (env.ENCOUNTERS_LIVE !== 'true') {
      const message = 'Znajdź swoje +1 — już wkrótce na naszych wydarzeniach.';
      return method === 'GET' ? json({ state: 'closed', reason: message }) : fail(503, message);
    }
    return encounterApi(method, b, env, user, { json, fail, event, active, eligible, profile, publicProfile, blocked });
  }
  const q = new URL(req.url).searchParams, uid = user.id, eid = clean(b.eventId || q.get('event'), 100);
  const rawTarget = Number(b.userId || q.get('user'));
  const target = Number.isSafeInteger(rawTarget) && rawTarget > 0 ? rawTarget : 0;

  if (path === '/api/social/me' && method === 'GET') {
    return json({ profile: ownProfile(await profile(env, uid)) });
  }
  if (path === '/api/social/me' && method === 'PUT') {
    const name = clean(b.name, 40), bio = clean(b.bio, 160), opener = clean(b.opener, 100), birth = String(b.birthDate || '');
    const age = socialAge(birth), old = await profile(env, uid);
    if (!name || !opener) return fail(400, 'Podaj imię i krótki początek rozmowy.');
    if (age === null || age < 18) return fail(400, 'Poznawanie osób na spotkaniach +1 jest dostępne od 18 lat. Sprawdź datę urodzenia.');
    if (old?.suspended) return fail(403, 'Profil jest zawieszony. Skontaktuj się z obsługą spotkania.');
    if (old?.verified_at && (old.birth_date !== birth || old.name !== name)) return fail(409, 'Potwierdzone imię i datę urodzenia zmienisz po ponownym utworzeniu i weryfikacji profilu.');
    await env.DB.prepare(`INSERT INTO social_profiles (user_id, name, birth_date, bio, opener) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, birth_date = excluded.birth_date, bio = excluded.bio, opener = excluded.opener`)
      .bind(uid, name, birth, bio, opener).run();
    return json({ profile: ownProfile(await profile(env, uid)) });
  }
  if (path === '/api/social/me' && method === 'DELETE') {
    // Zawieszenia nie da się obejść usuwając sam profil.
    if ((await profile(env, uid))?.suspended) return fail(403, 'Profil jest zawieszony. Skontaktuj się z obsługą spotkania.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM social_encounters WHERE user_a = ? OR user_b = ?').bind(uid, uid),
      ...['social_encounter_queue', 'social_profiles', 'social_attendees', 'social_codes'].map(t => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(uid)),
      ...['social_pluses', 'social_messages'].map(t => env.DB.prepare(`DELETE FROM ${t} WHERE from_user = ? OR to_user = ?`).bind(uid, uid))
    ]);
    return json({ ok: true });
  }
  if (path === '/api/social/events' && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT e.*, a.opted_in, a.checked_at FROM social_events e
      LEFT JOIN social_attendees a ON a.event_id = e.id AND a.user_id = ?
      WHERE e.enabled = 1 AND e.ends_at > ? ORDER BY e.starts_at LIMIT 80`).bind(uid, Date.now()).all();
    return json({ events: results.map(e => ({ id: e.id, title: e.title, city: e.city, venue: e.venue, meetingPoint: e.meeting_point,
      startsAt: e.starts_at, endsAt: e.ends_at, live: active(e), joined: !!e.opted_in, checkedIn: !!e.checked_at })) });
  }
  if (path === '/api/social/join' && method === 'POST') {
    if (typeof b.on !== 'boolean') return fail(400, 'Wybierz widoczność.');
    if (!b.on) {
      await env.DB.batch([
        env.DB.prepare("UPDATE social_encounters SET status = 'cancelled' WHERE event_id = ? AND (user_a = ? OR user_b = ?)").bind(eid, uid, uid),
        env.DB.prepare('DELETE FROM social_encounter_queue WHERE event_id = ? AND user_id = ?').bind(eid, uid),
        env.DB.prepare('UPDATE social_attendees SET opted_in = 0 WHERE event_id = ? AND user_id = ?').bind(eid, uid), clearPluses(env, eid, uid)
      ]);
      return json({ ok: true });
    }
    const e = await event(env, eid), p = await profile(env, uid);
    if (!e || e.ends_at <= Date.now()) return fail(410, 'To spotkanie jest już niedostępne.');
    if (!p || p.suspended || socialAge(p.birth_date) < 18) return fail(403, 'Najpierw uzupełnij profil +1.');
    await env.DB.prepare(`INSERT INTO social_attendees (event_id, user_id) VALUES (?, ?)
      ON CONFLICT(event_id, user_id) DO UPDATE SET opted_in = 1`).bind(eid, uid).run();
    return json({ ok: true });
  }
  if (path === '/api/social/code' && method === 'POST') {
    const p = await profile(env, uid);
    if (!p || p.suspended) return fail(403, 'Najpierw uzupełnij profil +1.');
    const code = [...crypto.getRandomValues(new Uint8Array(5))].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    const expiresAt = Date.now() + 10 * 60e3;
    await env.DB.prepare(`INSERT INTO social_codes (user_id, code_hash, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`).bind(uid, await hash(code), expiresAt).run();
    return json({ code, expiresAt });
  }
  if (path === '/api/social/verify' && (method === 'POST' || method === 'PUT')) {
    if (!staff(user)) return fail(403, 'Potwierdzenie jest dostępne dla obsługi.');
    const code = String(b.code || '').replace(/\s/g, '').toUpperCase();
    if (!/^[A-F0-9]{10}$/.test(code)) return fail(400, 'Wpisz 10 znaków kodu z telefonu uczestnika.');
    const c = await env.DB.prepare('SELECT * FROM social_codes WHERE code_hash = ? AND expires_at > ?').bind(await hash(code), Date.now()).first();
    if (!c) return fail(410, 'Kod wygasł lub jest nieprawidłowy.');
    if (c.user_id === uid) return fail(403, 'Profil musi potwierdzić inna osoba z obsługi.');
    const p = await profile(env, c.user_id), e = await event(env, eid), a = await attendee(env, eid, c.user_id);
    if (!p || p.suspended || socialAge(p.birth_date) < 18 || !active(e) || !a?.opted_in) return fail(403, 'Uczestnik musi mieć profil 18+ i dołączyć do trwającego spotkania.');
    if (method === 'POST') return json({ name: p.name, birthDate: p.birth_date, age: socialAge(p.birth_date) });
    if (b.confirmed !== true || b.birthDate !== p.birth_date || b.name !== p.name) return fail(409, 'Sprawdź dokument, osobę i aktualne dane na ekranie.');
    const now = Date.now();
    // Warunki powtarzamy w transakcji: równoległe żądanie nie może wykorzystać
    // zużytego kodu ani potwierdzić danych zmienionych po odczycie dokumentu.
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE social_profiles SET verified_at = ?, verified_by = ?
        WHERE user_id = ? AND name = ? AND birth_date = ? AND suspended = 0
        AND EXISTS(SELECT 1 FROM social_codes WHERE user_id = ? AND code_hash = ? AND expires_at > ?)
        AND EXISTS(SELECT 1 FROM social_attendees a JOIN social_events e ON e.id = a.event_id
          WHERE a.event_id = ? AND a.user_id = ? AND a.opted_in = 1 AND e.enabled = 1 AND e.starts_at <= ? AND e.ends_at > ?)`)
        .bind(now, uid, c.user_id, p.name, p.birth_date, c.user_id, c.code_hash, now, eid, c.user_id, now, now),
      env.DB.prepare(`UPDATE social_attendees SET checked_at = ? WHERE event_id = ? AND user_id = ? AND opted_in = 1
        AND EXISTS(SELECT 1 FROM social_profiles WHERE user_id = ? AND verified_at = ? AND verified_by = ?)`)
        .bind(now, eid, c.user_id, c.user_id, now, uid),
      env.DB.prepare('DELETE FROM social_codes WHERE user_id = ? AND code_hash = ?').bind(c.user_id, c.code_hash)
    ]);
    if (!result[0].meta.changes) return fail(409, 'Kod lub dane zmieniły się. Poproś o nowy kod i sprawdź dokument ponownie.');
    return json({ ok: true });
  }
  if (path === '/api/social/people' && method === 'GET') {
    if (!active(await event(env, eid)) || !await eligible(env, eid, uid)) return fail(403, 'Osoby zobaczysz na miejscu, po potwierdzeniu wieku i obecności przez obsługę.');
    const { results } = await env.DB.prepare(`SELECT p.*,
      EXISTS(SELECT 1 FROM social_pluses l WHERE l.event_id = a.event_id AND l.from_user = ? AND l.to_user = p.user_id) AS sent,
      EXISTS(SELECT 1 FROM social_pluses l WHERE l.event_id = a.event_id AND l.from_user = p.user_id AND l.to_user = ?) AS received
      FROM social_attendees a JOIN social_profiles p ON p.user_id = a.user_id
      WHERE a.event_id = ? AND a.opted_in = 1 AND a.checked_at IS NOT NULL AND p.verified_at IS NOT NULL AND p.suspended = 0 AND p.user_id <> ?
      AND NOT EXISTS(SELECT 1 FROM social_blocks b WHERE (b.user_id = ? AND b.blocked_id = p.user_id) OR (b.user_id = p.user_id AND b.blocked_id = ?))
      ORDER BY received DESC, p.user_id LIMIT 200`).bind(uid, uid, eid, uid, uid, uid).all();
    return json({ people: results.filter(validProfile).map(p => ({ ...publicProfile(p), sent: !!p.sent, received: !!p.received, matched: !!p.sent && !!p.received })) });
  }
  if (path === '/api/social/plus' && method === 'POST') {
    if (!Number.isInteger(target) || target === uid) return fail(400, 'Wybierz inną osobę.');
    if (b.on === false) {
      await env.DB.prepare('DELETE FROM social_pluses WHERE event_id = ? AND from_user = ? AND to_user = ?').bind(eid, uid, target).run();
      return json({ matched: false });
    }
    if (!active(await event(env, eid)) || !await eligible(env, eid, uid) || !await eligible(env, eid, target) || await blocked(env, uid, target)) return fail(403, 'Ta osoba jest teraz niedostępna.');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM social_pluses WHERE from_user = ? AND created_at > ?').bind(uid, Date.now() - 60e3).first('n');
    if (n >= 20) return fail(429, 'Zwolnij na chwilę. Kolejny plusik wyślesz za minutę.');
    await env.DB.prepare('INSERT OR IGNORE INTO social_pluses (event_id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)').bind(eid, uid, target, Date.now()).run();
    return json({ matched: await pair(env, eid, uid, target) });
  }
  if (path === '/api/social/matches' && method === 'GET') {
    if (!validProfile(await profile(env, uid))) return json({ matches: [] });
    const { results } = await env.DB.prepare(`SELECT p.*, l.event_id, e.title, e.meeting_point FROM social_pluses l
      JOIN social_pluses r ON r.event_id = l.event_id AND r.from_user = l.to_user AND r.to_user = l.from_user
      JOIN social_profiles p ON p.user_id = l.to_user JOIN social_events e ON e.id = l.event_id
      JOIN social_attendees a ON a.event_id = l.event_id AND a.user_id = l.from_user
      JOIN social_attendees t ON t.event_id = l.event_id AND t.user_id = l.to_user
      WHERE l.from_user = ? AND e.enabled = 1 AND a.opted_in = 1 AND a.checked_at IS NOT NULL
      AND t.opted_in = 1 AND t.checked_at IS NOT NULL AND p.verified_at IS NOT NULL AND p.suspended = 0
      AND NOT EXISTS(SELECT 1 FROM social_blocks b WHERE (b.user_id = ? AND b.blocked_id = p.user_id) OR (b.user_id = p.user_id AND b.blocked_id = ?))
      ORDER BY l.created_at DESC LIMIT 200`).bind(uid, uid, uid).all();
    return json({ matches: results.filter(validProfile).map(p => ({ ...publicProfile(p), eventId: p.event_id, eventTitle: p.title, meetingPoint: p.meeting_point })) });
  }
  if (path === '/api/social/messages' && ['GET', 'POST'].includes(method)) {
    if (!await pair(env, eid, uid, target)) return fail(403, 'Rozmowa wymaga wzajemnych plusików i aktywnych profili.');
    if (method === 'POST') {
      const text = clean(b.text, 500);
      if (!text) return fail(400, 'Wpisz wiadomość.');
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM social_messages WHERE from_user = ? AND created_at > ?').bind(uid, Date.now() - 60e3).first('n');
      if (n >= 20) return fail(429, 'Zwolnij na chwilę. Spróbuj ponownie za minutę.');
      await env.DB.prepare('INSERT INTO social_messages (event_id, from_user, to_user, text, created_at) VALUES (?, ?, ?, ?, ?)').bind(eid, uid, target, text, Date.now()).run();
    }
    const { results } = await env.DB.prepare(`SELECT id, from_user, text, created_at FROM social_messages WHERE event_id = ?
      AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) ORDER BY id DESC LIMIT 100`).bind(eid, uid, target, target, uid).all();
    return json({ messages: results.reverse().map(m => ({ id: m.id, mine: m.from_user === uid, text: m.text, at: m.created_at })) });
  }
  if (path === '/api/social/block' && method === 'POST') {
    if (!Number.isInteger(target) || target === uid || !await profile(env, target)) return fail(400, 'Nie ma takiej osoby.');
    const ops = [env.DB.prepare('INSERT OR IGNORE INTO social_blocks (user_id, blocked_id) VALUES (?, ?)').bind(uid, target),
      env.DB.prepare('DELETE FROM social_pluses WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)').bind(uid, target, target, uid)];
    if (b.reason) {
      if (!await event(env, eid)) return fail(400, 'Wybierz spotkanie.');
      ops.push(env.DB.prepare('INSERT OR IGNORE INTO social_reports (event_id, from_user, to_user, reason, created_at) VALUES (?, ?, ?, ?, ?)').bind(eid, uid, target, clean(b.reason, 500), Date.now()));
    }
    await env.DB.batch(ops);
    return json({ ok: true });
  }
  if (path.startsWith('/api/social/admin/')) {
    if (!admin(user)) return fail(403, 'Tylko administrator może zarządzać spotkaniami +1.');
    if (path === '/api/social/admin/events' && method === 'POST') {
      const title = clean(b.title, 100), city = clean(b.city, 60), venue = clean(b.venue, 100), point = clean(b.meetingPoint, 160);
      const start = Number(b.startsAt), end = Number(b.endsAt);
      if (!title || !city || !venue || !point || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= Date.now() || end <= start || end - start > 48 * 3600e3) return fail(400, 'Uzupełnij miejsce, punkt spotkań i prawidłowy termin (do 48 godzin).');
      const id = 'plusone-' + crypto.randomUUID();
      await env.DB.prepare('INSERT INTO social_events (id, title, city, venue, meeting_point, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, title, city, venue, point, start, end, uid).run();
      return json({ id }, 201);
    }
    if (path === '/api/social/admin/events' && method === 'DELETE') {
      await env.DB.prepare('UPDATE social_events SET enabled = 0 WHERE id = ?').bind(eid).run();
      return json({ ok: true });
    }
    if (path === '/api/social/admin/reports' && method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT r.id, r.reason, r.created_at, p.name, e.title FROM social_reports r
        LEFT JOIN social_profiles p ON p.user_id = r.to_user JOIN social_events e ON e.id = r.event_id
        WHERE r.resolved_at IS NULL ORDER BY r.created_at LIMIT 100`).all();
      return json({ reports: results });
    }
    if (path === '/api/social/admin/reports' && method === 'POST') {
      const r = await env.DB.prepare('SELECT * FROM social_reports WHERE id = ? AND resolved_at IS NULL').bind(Number(b.id) || 0).first();
      if (!r) return fail(404, 'Zgłoszenie zostało już zamknięte.');
      const ops = [env.DB.prepare('UPDATE social_reports SET resolved_at = ? WHERE id = ?').bind(Date.now(), r.id)];
      if (b.suspend === true && r.to_user) ops.push(env.DB.prepare('UPDATE social_profiles SET suspended = 1 WHERE user_id = ?').bind(r.to_user));
      await env.DB.batch(ops);
      return json({ ok: true });
    }
  }
  return fail(404, 'Nie ma takiej funkcji.');
}
