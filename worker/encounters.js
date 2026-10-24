/* Krótka runda „poznaj kogoś nowego” na trwającym wydarzeniu +1.
   Kolejka i rezerwacja obojga uczestników są w jednej transakcji D1. */
const INTENTS = ['talk', 'dance', 'discover', 'surprise'];
const PACES = ['calm', 'spontaneous'];
const MARKS = ['ORBITA', 'FALA', 'ISKRA', 'ECHO', 'PULS', 'KOMETA'];
const MISSIONS = {
  talk: ['Po jednym utworze, który pasuje do tego wieczoru. Co za nim stoi?', 'Dokończcie po kolei: „Dobrze, że dziś tu jestem, bo…”', 'Każde ma minutę: opowiedz o wyjściu, które skończyło się inaczej niż w planie.'],
  dance: ['Wybierzcie jeden utwór tego wieczoru, który zostanie z Wami na jutro.', 'Pierwsze cześć przy punkcie +1. Potem zdecydujcie, czy łapiecie razem kolejny utwór.', 'Każde wybiera jeden numer, przy którym trudno ustać w miejscu. Porównajcie typy.'],
  discover: ['Znajdźcie po jednym detalu tego wydarzenia, którego druga osoba jeszcze nie zauważyła.', 'Porównajcie swoje odkrycia wieczoru. Co warto zobaczyć albo usłyszeć razem?', 'Wybierzcie jeden moment tego wydarzenia, który polecilibyście komuś spoza niego.']
};
const selfQueue = (env, uid) => env.DB.prepare('SELECT * FROM social_encounter_queue WHERE user_id = ?').bind(uid).first();
const getRound = (env, token) => env.DB.prepare('SELECT * FROM social_encounters WHERE token = ?').bind(token).first();
const peerId = (r, uid) => r.user_a === uid ? r.user_b : r.user_a;
const side = (r, uid) => r.user_a === uid ? 'a' : 'b';
const done = r => r.status === 'connected';

async function state(env, uid, h) {
  const q = await selfQueue(env, uid);
  if (!q) return { state: 'idle' };
  const e = await h.event(env, q.event_id);
  if (!h.active(e) || !await h.eligible(env, q.event_id, uid)) return { state: 'closed', token: q.round_token, reason: 'To spotkanie jest teraz niedostępne. Możesz wrócić do swoich znajomości.' };
  const context = { event: { id: e.id, title: e.title, venue: e.venue, meetingPoint: e.meeting_point }, intent: q.intent, pace: q.pace };
  if (!q.round_token) return q.expires_at > Date.now()
    ? { ...context, state: 'waiting', expiresAt: q.expires_at }
    : { state: 'closed', token: null, reason: 'Zrobiliśmy pauzę w szukaniu. Włącz +1 ponownie, gdy masz ochotę.' };
  const r = await getRound(env, q.round_token);
  if (!r || r.status === 'cancelled' || (!done(r) && r.expires_at <= Date.now()) ||
      !await h.eligible(env, q.event_id, peerId(r, uid)) || await h.blocked(env, uid, peerId(r, uid))) {
    return { state: 'closed', token: q.round_token, reason: 'Ta runda się zakończyła. Możesz zrobić pauzę albo poznać kogoś nowego.' };
  }
  const s = side(r, uid), payload = { ...context, state: r.status, token: r.token, intent: r.intent, expiresAt: r.expires_at, accepted: !!r['accepted_' + s], met: !!r['met_' + s], kept: !!r['kept_' + s] };
  // Dane drugiej osoby i znak rozpoznawczy dopiero po dwóch zgodach.
  if (r.status !== 'proposed') {
    const p = await h.profile(env, peerId(r, uid));
    payload.person = h.publicProfile(p);
    payload.signal = { shape: r.id % MARKS.length, word: MARKS[r.id % MARKS.length], code: r.id.toString(36).toUpperCase().padStart(3, '0') };
    const tasks = MISSIONS[r.intent] || MISSIONS.talk;
    payload.mission = tasks[r.id % tasks.length];
  }
  return payload;
}

async function findPartner(env, uid) {
  const now = Date.now(), token = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO social_encounters (token, event_id, user_a, user_b, intent, created_at, expires_at)
      SELECT ?, a.event_id, a.user_id, b.user_id,
        CASE WHEN a.intent = 'surprise' THEN CASE WHEN b.intent = 'surprise' THEN 'talk' ELSE b.intent END ELSE a.intent END,
        ?, MIN(e.ends_at, ?)
      FROM social_encounter_queue a JOIN social_encounter_queue b ON b.event_id = a.event_id AND b.user_id <> a.user_id
      JOIN social_events e ON e.id = a.event_id
      JOIN social_profiles pa ON pa.user_id = a.user_id JOIN social_profiles pb ON pb.user_id = b.user_id
      JOIN social_attendees aa ON aa.user_id = a.user_id AND aa.event_id = a.event_id
      JOIN social_attendees ab ON ab.user_id = b.user_id AND ab.event_id = a.event_id
      WHERE a.user_id = ? AND a.round_token IS NULL AND b.round_token IS NULL
        AND a.expires_at > ? AND b.expires_at > ? AND a.heartbeat_at > ? AND b.heartbeat_at > ?
        AND e.enabled = 1 AND e.starts_at <= ? AND e.ends_at > ?
        AND pa.suspended = 0 AND pb.suspended = 0 AND pa.verified_at IS NOT NULL AND pb.verified_at IS NOT NULL
        AND aa.opted_in = 1 AND ab.opted_in = 1 AND aa.checked_at IS NOT NULL AND ab.checked_at IS NOT NULL
        AND (a.intent = b.intent OR a.intent = 'surprise' OR b.intent = 'surprise')
        AND NOT EXISTS(SELECT 1 FROM social_blocks x WHERE (x.user_id = a.user_id AND x.blocked_id = b.user_id) OR (x.user_id = b.user_id AND x.blocked_id = a.user_id))
        AND NOT EXISTS(SELECT 1 FROM social_encounters x WHERE x.event_id = a.event_id AND ((x.user_a = a.user_id AND x.user_b = b.user_id) OR (x.user_a = b.user_id AND x.user_b = a.user_id)))
        AND NOT EXISTS(SELECT 1 FROM friends x WHERE x.user_id = a.user_id AND x.friend_id = b.user_id)
        AND NOT EXISTS(SELECT 1 FROM social_pluses x JOIN social_pluses y ON y.event_id = x.event_id AND y.from_user = x.to_user AND y.to_user = x.from_user WHERE x.from_user = a.user_id AND x.to_user = b.user_id)
      ORDER BY (a.pace = b.pace) DESC, b.queued_at, b.user_id LIMIT 1`)
      .bind(token, now, now + 90000, uid, now, now, now - 30000, now - 30000, now, now),
    env.DB.prepare(`UPDATE social_encounter_queue SET round_token = ?
      WHERE round_token IS NULL AND user_id IN (SELECT user_a FROM social_encounters WHERE token = ? UNION SELECT user_b FROM social_encounters WHERE token = ?)`)
      .bind(token, token, token)
  ]);
}

export async function encounterApi(method, b, env, user, h) {
  const uid = user.id, now = Date.now();
  if (method === 'GET') return h.json(await state(env, uid, h));
  if (method !== 'POST') return h.fail(405, 'Niedozwolona metoda.');
  const action = b.action;
  if (!['queue', 'pulse', 'accept', 'cancel', 'met', 'keep'].includes(action)) return h.fail(400, 'Wybierz działanie.');
  if (action === 'queue') {
    const eid = typeof b.eventId === 'string' ? b.eventId : '';
    if (!INTENTS.includes(b.intent) || !PACES.includes(b.pace)) return h.fail(400, 'Wybierz, na co masz ochotę i w jakim tempie.');
    if (!h.active(await h.event(env, eid)) || !await h.eligible(env, eid, uid)) return h.fail(403, 'Włącz poznawanie na trwającym spotkaniu i potwierdź profil u obsługi.');
    const old = await selfQueue(env, uid), current = await state(env, uid, h);
    if (['proposed', 'live', 'met', 'connected'].includes(current.state)) return h.json(current);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM social_encounters WHERE (user_a = ? OR user_b = ?) AND created_at > ?').bind(uid, uid, now - 60000).first('n');
    if (count >= 6) return h.fail(429, 'Zrób chwilę przerwy. Kolejna runda za minutę.');
    // Powtórzone kliknięcie nie usuwa przydzielonej w międzyczasie pary.
    if (old?.round_token && current.state === 'closed') {
      await env.DB.prepare('DELETE FROM social_encounter_queue WHERE user_id = ? AND round_token = ?').bind(uid, old.round_token).run();
    }
    await env.DB.prepare(`INSERT INTO social_encounter_queue (user_id, event_id, intent, pace, queued_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET event_id = excluded.event_id, intent = excluded.intent, pace = excluded.pace,
        heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at WHERE social_encounter_queue.round_token IS NULL`)
      .bind(uid, eid, b.intent, b.pace, now, now, now + 10 * 60000).run();
    await findPartner(env, uid);
    return h.json(await state(env, uid, h));
  }
  if (action === 'pulse') {
    await env.DB.prepare('UPDATE social_encounter_queue SET heartbeat_at = ? WHERE user_id = ? AND expires_at > ?').bind(now, uid, now).run();
    const q = await selfQueue(env, uid);
    if (q && !q.round_token && q.expires_at > now) await findPartner(env, uid);
    return h.json(await state(env, uid, h));
  }
  const q = await selfQueue(env, uid);
  if (!q) return h.json({ state: 'idle' });
  if ((q.round_token || null) !== (b.token || null)) return h.fail(409, 'Runda się zmieniła. Odśwież swój znak.');
  if (action === 'cancel') {
    const ops = [env.DB.prepare('DELETE FROM social_encounter_queue WHERE user_id = ? AND COALESCE(round_token, \'\') = ?').bind(uid, q.round_token || '')];
    if (q.round_token) ops.unshift(env.DB.prepare("UPDATE social_encounters SET status = 'cancelled' WHERE token = ? AND status <> 'connected'").bind(q.round_token));
    await env.DB.batch(ops);
    return h.json({ state: 'idle' });
  }
  const st = await state(env, uid, h);
  if (['idle', 'closed', 'waiting'].includes(st.state)) return h.fail(409, 'Ta runda nie jest już dostępna.');
  const r = await getRound(env, q.round_token), s = side(r, uid);
  if (action === 'accept') {
    if (r.status !== 'proposed') return h.json(st);
    const e = await h.event(env, r.event_id);
    await env.DB.batch([
      env.DB.prepare(`UPDATE social_encounters SET accepted_${s} = 1 WHERE token = ? AND status = 'proposed' AND expires_at > ?`).bind(r.token, now),
      env.DB.prepare("UPDATE social_encounters SET status = 'live', expires_at = ? WHERE token = ? AND status = 'proposed' AND accepted_a = 1 AND accepted_b = 1 AND expires_at > ?")
        .bind(Math.min(e.ends_at, now + 8 * 60000), r.token, now)
    ]);
  } else if (action === 'met') {
    if (r.status !== 'live') return h.json(st);
    const e = await h.event(env, r.event_id);
    await env.DB.batch([
      env.DB.prepare(`UPDATE social_encounters SET met_${s} = 1 WHERE token = ? AND status = 'live' AND expires_at > ?`).bind(r.token, now),
      env.DB.prepare("UPDATE social_encounters SET status = 'met', expires_at = ? WHERE token = ? AND status = 'live' AND met_a = 1 AND met_b = 1 AND expires_at > ?")
        .bind(e.ends_at, r.token, now)
    ]);
  } else if (action === 'keep') {
    if (!['met', 'connected'].includes(r.status)) return h.fail(409, 'Najpierw oboje potwierdźcie, że się spotkaliście.');
    await env.DB.batch([
      env.DB.prepare(`UPDATE social_encounters SET kept_${s} = 1 WHERE token = ? AND status = 'met' AND expires_at > ?`).bind(r.token, now),
      ...[['user_a', 'user_b'], ['user_b', 'user_a']].map(([from, to]) =>
        env.DB.prepare(`INSERT OR IGNORE INTO social_pluses (event_id, from_user, to_user, created_at)
          SELECT event_id, ${from}, ${to}, ? FROM social_encounters WHERE token = ? AND status = 'met' AND kept_a = 1 AND kept_b = 1 AND expires_at > ?`)
          .bind(now, r.token, now)),
      env.DB.prepare("UPDATE social_encounters SET status = 'connected' WHERE token = ? AND status = 'met' AND kept_a = 1 AND kept_b = 1 AND expires_at > ?").bind(r.token, now)
    ]);
  }
  return h.json(await state(env, uid, h));
}
