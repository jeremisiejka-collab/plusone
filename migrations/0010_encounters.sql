-- Jedna osoba = jedna aktywna runda poznawania. Numer rundy jest wspólnym
-- znakiem pary, a zgody na spotkanie i zachowanie kontaktu są oddzielne.
CREATE TABLE social_encounters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','live','met','connected','cancelled')),
  accepted_a INTEGER NOT NULL DEFAULT 0,
  accepted_b INTEGER NOT NULL DEFAULT 0,
  met_a INTEGER NOT NULL DEFAULT 0,
  met_b INTEGER NOT NULL DEFAULT 0,
  kept_a INTEGER NOT NULL DEFAULT 0,
  kept_b INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (user_a <> user_b)
);
CREATE INDEX social_encounters_pair ON social_encounters(event_id, user_a, user_b);
CREATE TABLE social_encounter_queue (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  intent TEXT NOT NULL CHECK (intent IN ('talk','dance','discover','surprise')),
  pace TEXT NOT NULL CHECK (pace IN ('calm','spontaneous')),
  round_token TEXT REFERENCES social_encounters(token) ON DELETE CASCADE,
  queued_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX social_encounter_waiting ON social_encounter_queue(event_id, round_token, heartbeat_at);
