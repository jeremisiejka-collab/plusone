-- Przewodnik po wydarzeniu dla uczestników (plan z punktami, harmonogram, informacje) i komunikaty do uczestników.
CREATE TABLE event_guides (
  event_id   TEXT PRIMARY KEY,
  info       TEXT NOT NULL DEFAULT '',     -- zasady, szatnia, bar, kontakt (zwykły tekst)
  schedule   TEXT NOT NULL DEFAULT '[]',   -- [{time, title}]
  points     TEXT NOT NULL DEFAULT '[]',   -- punkty na planie: [{x, y, label, kind}] (x, y w % szerokości/wysokości)
  map_image  TEXT,                         -- plan miejsca: data URL JPEG (zmniejszony w przeglądarce)
  map_ratio  REAL,                         -- szerokość / wysokość planu
  zones      TEXT NOT NULL DEFAULT '[]',   -- strefy biletów: [{key, name, color}] np. VIP, Golden
  updated_at INTEGER,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE event_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  audience   TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'inside')),  -- wszyscy z biletem / tylko wpuszczeni
  channel    TEXT NOT NULL DEFAULT 'push' CHECK (channel IN ('push', 'mail', 'both')),  -- powiadomienie / e-mail / oba
  recipients INTEGER NOT NULL DEFAULT 0,
  by_user    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX event_posts_event ON event_posts(event_id, created_at);

-- kolejka maili do uczestników: wysyłamy partiami (limit połączeń Workera), przeglądarka prosi o kolejne partie
CREATE TABLE event_mail_queue (
  post_id INTEGER NOT NULL REFERENCES event_posts(id) ON DELETE CASCADE,
  email   TEXT NOT NULL,
  name    TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,
  failed  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, email)
);

-- strefa biletu (klucz z event_guides.zones); NULL = wejście ogólne. Przypisuje organizator albo administrator.
ALTER TABLE tickets ADD COLUMN zone TEXT;
ALTER TABLE guests ADD COLUMN zone TEXT;
