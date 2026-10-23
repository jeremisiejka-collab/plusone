-- "Mam bilet" (going) obok "Zapisane" (saved): jeden wpis na wydarzenie, going ma pierwszeństwo
ALTER TABLE saved ADD COLUMN kind TEXT NOT NULL DEFAULT 'saved' CHECK (kind IN ('saved', 'going'));
