-- Konta, sesje, zapisane wydarzenia i moderacja (Cloudflare D1 / SQLite)

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  pass       TEXT NOT NULL,              -- pbkdf2$iteracje$sól$hash (base64)
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  city       TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,           -- sha256 tokenu z ciasteczka
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE saved (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX saved_event ON saved(event_id);

-- decyzje admina: ukryj / poleć wydarzenie
CREATE TABLE curation (
  event_id TEXT PRIMARY KEY,
  action   TEXT NOT NULL CHECK (action IN ('hide', 'feature')),
  by_user  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at       INTEGER NOT NULL
);

-- nieudane logowania (prosty limit prób)
CREATE TABLE login_fail (
  email TEXT NOT NULL,
  at    INTEGER NOT NULL
);
CREATE INDEX login_fail_email ON login_fail(email, at);
