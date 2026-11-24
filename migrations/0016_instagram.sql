-- Instagram @plusoneapp.pl: trwała kolejka postów z publicznych wydarzeń (worker/instagram.js).
-- Jeden post na wydarzenie i profil: klucz (ig_user, event_id) i zapasowy (ig_user, dedup_key) —
-- powtórny import, edycja ani równoległe przebiegi nie utworzą drugiego posta.
CREATE TABLE ig_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user TEXT NOT NULL,              -- IG User ID profilu docelowego
  event_id TEXT NOT NULL,             -- kanoniczny id wydarzenia z public/data/events.json
  dedup_key TEXT NOT NULL,            -- tytuł + dzień + miasto (gdy pipeline zmieni id tego samego wydarzenia)
  title TEXT NOT NULL,
  event_start TEXT NOT NULL,
  city TEXT,
  image_src TEXT NOT NULL,            -- dokładnie e.image, który widzi użytkownik
  image_key TEXT NOT NULL,            -- sha256(image_src)[0..24] → /ig/<image_key>.jpg (pochodna JPEG dla Meta)
  caption TEXT NOT NULL,
  caption_edited INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  reasons TEXT,                       -- JSON: dlaczego wybrane
  origin TEXT NOT NULL DEFAULT 'auto',-- auto | manual
  status TEXT NOT NULL,               -- review | queued | container | publishing | unknown | published | needs_check | failed | skipped
  container_id TEXT,                  -- ID kontenera Meta (POST /{ig}/media)
  media_id TEXT,                      -- potwierdzone ID medium po media_publish
  permalink TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_kind TEXT,               -- transient | permanent | auth | ambiguous
  last_attempt_at INTEGER,
  next_try_at INTEGER,
  by_user INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (ig_user, event_id),
  UNIQUE (ig_user, dedup_key)
);
CREATE INDEX ig_posts_status ON ig_posts (status, next_try_at);

-- dziennik prób (ostatnie zdarzenia przy zadaniu, bez tokenów i bez treści odpowiedzi z nagłówkami)
CREATE TABLE ig_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  msg TEXT
);
CREATE INDEX ig_log_post ON ig_log (post_id, at);
