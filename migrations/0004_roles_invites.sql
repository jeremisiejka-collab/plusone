-- Uprawnienia, wymuszona zmiana hasła i zaproszenia e-mailem.
-- owner = główny administrator (nadaje i odbiera admina), perm_curate = moderator wydarzeń,
-- must_change = po zalogowaniu trzeba ustawić nowe hasło (konta startowe, hasło nadane przez kogoś innego).
ALTER TABLE users ADD COLUMN owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN perm_curate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0;

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,            -- sha256 tokenu z linku
  email      TEXT NOT NULL,
  preview    INTEGER NOT NULL DEFAULT 1,  -- tester aplikacji
  curate     INTEGER NOT NULL DEFAULT 0,  -- moderator wydarzeń
  admin      INTEGER NOT NULL DEFAULT 0,  -- administrator
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX invites_email ON invites(email);

-- główni administratorzy; hasło startowe 1234 trzeba zmienić przy pierwszym logowaniu
INSERT INTO users (email, name, pass, role, owner, must_change, perm_curate, created_at) VALUES
  ('jeremi@tooday.pl', '', 'pbkdf2$100000$ClOCCTZIJ0NczYO693CoKg==$c2qKKyg1KM6Ao4Z1ASOUefyrSA3jf03IJcr82bjPOqQ=', 'admin', 1, 1, 1, 1792800000000),
  ('lukasz@tooday.pl', '', 'pbkdf2$100000$MpCGUOGxdS7D0hcxZLhZHw==$gkm++Psk/6r3clczVFO960oBKX5r+CpMQLusvx5gcn8=', 'admin', 1, 1, 1, 1792800000000),
  ('p.puchalski@tooday.pl', '', 'pbkdf2$100000$1J5Mv1vgkya4gMU0WBeM7Q==$Hg5K/Cdiwkdg0FmsVa1luZNY0n75PUAsiItEvRDiv78=', 'admin', 1, 1, 1, 1792800000000)
ON CONFLICT(email) DO UPDATE SET role = 'admin', owner = 1, perm_curate = 1;
