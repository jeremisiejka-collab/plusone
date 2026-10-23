-- Rola "obsługa biletów" (skanowanie wejść) i bilety +1 z kodem QR.
ALTER TABLE users ADD COLUMN perm_scan INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN scan INTEGER NOT NULL DEFAULT 0;

-- bilet = "Mam bilet" zalogowanego użytkownika; kod w QR jest losowy i jednorazowy przy wejściu
CREATE TABLE tickets (
  code       TEXT PRIMARY KEY,           -- losowy kod z QR
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, event_id)
);
CREATE INDEX tickets_event ON tickets(event_id);
