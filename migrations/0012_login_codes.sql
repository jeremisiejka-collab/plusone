-- Logowanie kodem z maila (zamiast hasła): jednorazowy 6-cyfrowy kod, ważny 10 minut, max 5 prób.
CREATE TABLE login_codes (
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,          -- sha256(email + ':' + kod)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    INTEGER
);
CREATE INDEX login_codes_email ON login_codes(email, created_at);
