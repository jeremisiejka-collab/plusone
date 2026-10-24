-- Poznawanie ludzi na autorskich spotkaniach +1. Zdjęć dokumentów nie zapisujemy.
CREATE TABLE social_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  opener TEXT NOT NULL DEFAULT '',
  suspended INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE social_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  city TEXT NOT NULL,
  venue TEXT NOT NULL,
  meeting_point TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE social_attendees (
  event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opted_in INTEGER NOT NULL DEFAULT 1,
  checked_at INTEGER,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE social_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE social_pluses (
  event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, from_user, to_user),
  CHECK (from_user <> to_user)
);
CREATE INDEX social_pluses_recipient ON social_pluses(to_user, event_id);
CREATE TABLE social_blocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, blocked_id),
  CHECK (user_id <> blocked_id)
);
CREATE TABLE social_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX social_messages_pair ON social_messages(event_id, from_user, to_user, id);
CREATE TABLE social_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
  from_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (event_id, from_user, to_user)
);
