-- Ustawienia aplikacji (np. konfiguracja serwera poczty SMTP do wysyłki zaproszeń).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
