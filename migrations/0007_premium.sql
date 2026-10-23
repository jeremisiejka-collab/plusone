-- Funkcje premium aplikacji: zainteresowania, obserwowanie, powiadomienia, znajomi ("Idziesz z kimś?"),
-- organizatorzy z listą gości, newsletter i reset hasła.
ALTER TABLE users ADD COLUMN interests TEXT NOT NULL DEFAULT '[]';     -- ["clubbing","koncerty",…]
ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1;  -- alerty także mailem
ALTER TABLE users ADD COLUMN newsletter INTEGER NOT NULL DEFAULT 0;    -- „Na topie w Twoim mieście” co tydzień
ALTER TABLE users ADD COLUMN last_alert_mail INTEGER;
ALTER TABLE users ADD COLUMN perm_org INTEGER NOT NULL DEFAULT 0;      -- organizator

-- „Mam bilet”: zapamiętane dane wydarzenia (do podsumowania wyjść — minione wydarzenia znikają z events.json)
ALTER TABLE saved ADD COLUMN meta TEXT;

-- obserwowane: wydarzenie, miasto albo okolica (miasto + promień w km)
CREATE TABLE follows (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('event', 'city', 'area')),
  value      TEXT NOT NULL,
  radius     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, value)
);

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                -- new | price | reminder | crew | info
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  event_id   TEXT,
  dedup      TEXT,                         -- ten sam alert tylko raz
  created_at INTEGER NOT NULL,
  read_at    INTEGER,
  mailed_at  INTEGER,
  UNIQUE (user_id, dedup)
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

-- znajomi (para zapisana w obie strony) i zaproszenia "idziesz ze mną?"
CREATE TABLE friends (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE crew_invites (
  token_hash TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  from_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- organizator: miejsca/nazwy, których wydarzenia widzi w swoim panelu
CREATE TABLE org_venues (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue   TEXT NOT NULL,
  PRIMARY KEY (user_id, venue)
);
-- lista gości organizatora: bilet z kodem QR bez konta w +1
CREATE TABLE guests (
  code       TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  org_user   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  email      TEXT,
  created_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX guests_event ON guests(event_id);

-- reset hasła mailem
CREATE TABLE resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
