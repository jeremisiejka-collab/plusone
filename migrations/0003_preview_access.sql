-- Dostęp do prototypu niezależny od uprawnień administratora.
CREATE TABLE preview_access (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL
);
