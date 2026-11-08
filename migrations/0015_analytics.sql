-- Panel założyciela: statystyki odwiedzin bez ciasteczek i bez adresów IP.
-- vid = skrót (IP + przeglądarka + dzień + sól) — zmienia się codziennie, nie da się z niego odtworzyć IP ani śledzić osoby między dniami.
CREATE TABLE IF NOT EXISTS stat_hits (
  id       INTEGER PRIMARY KEY,
  ts       INTEGER NOT NULL,
  vid      TEXT NOT NULL,
  kind     TEXT NOT NULL,            -- view (wejście na ekran) | click (kliknięcie)
  screen   TEXT,
  act      TEXT,                     -- co kliknięto (data-act bez danych osobowych)
  event_id TEXT,
  src      TEXT,                     -- skąd przyszedł: utm_source albo domena odsyłająca albo „bezpośrednio”
  city     TEXT,
  device   TEXT,                     -- telefon | komputer | tablet
  app      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stat_hits_ts ON stat_hits(ts);
CREATE INDEX IF NOT EXISTS stat_hits_vid ON stat_hits(vid, ts);
-- kto jest teraz na stronie (ostatni sygnał z karty przeglądarki)
CREATE TABLE IF NOT EXISTS stat_live (
  vid      TEXT PRIMARY KEY,
  last     INTEGER NOT NULL,
  first    INTEGER NOT NULL,
  screen   TEXT,
  event_id TEXT,
  src      TEXT,
  city     TEXT,
  device   TEXT,
  app      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stat_live_last ON stat_live(last);
