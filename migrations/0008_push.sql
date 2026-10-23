-- Powiadomienia push (Web Push: Android, iPhone z aplikacją na ekranie początkowym, komputer).
-- Klucze VAPID serwer generuje sam przy pierwszym użyciu i zapisuje w settings ('vapid').
CREATE TABLE push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT,
  auth       TEXT,
  ua         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subs_user ON push_subs(user_id);
