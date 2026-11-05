-- Limity zapytań do API (worker/security.js): licznik na klucz (ścieżka + sesja lub IP) w oknie godzinowym.
CREATE TABLE IF NOT EXISTS rate_limits (
  k     TEXT PRIMARY KEY,
  n     INTEGER NOT NULL,
  reset INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset ON rate_limits(reset);
