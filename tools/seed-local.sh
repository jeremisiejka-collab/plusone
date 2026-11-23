#!/usr/bin/env bash
# Lokalna baza D1 z dwoma kontami testowymi i sesjami o stałych tokenach (tylko na komputerze programisty).
#   admin@lokalnie.test  — administrator (właściciel), sesja sid=lokalnyadmin0000000000
#   user@lokalnie.test   — zwykły użytkownik z dostępem do /app, sesja sid=lokalnyuser00000000000
# Uruchom potem serwer z:  npx wrangler@4 dev --local --port 8799 --var ADMIN_EMAIL_SHA256:$(printf admin@lokalnie.test | sha256sum | cut -d' ' -f1)
# Ciasteczko ustawisz w przeglądarce (DevTools → Application → Cookies) albo w Playwright (tools/audit-app.cjs).
set -euo pipefail
cd "$(dirname "$0")/.."
npx --yes wrangler@4 d1 migrations apply plusone --local
h() { printf %s "$1" | sha256sum | cut -d' ' -f1; }
NOW=$(date +%s000); EXP=$(( $(date +%s) * 1000 + 30*86400000 ))
npx --yes wrangler@4 d1 execute plusone --local --command "
INSERT OR IGNORE INTO users (email, name, pass, role, created_at) VALUES
  ('admin@lokalnie.test', 'Admin Test', 'brak-hasla', 'admin', $NOW),
  ('user@lokalnie.test',  'Ola Test',   'brak-hasla', 'user',  $NOW);
INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at)
  SELECT '$(h lokalnyadmin0000000000)', id, $EXP FROM users WHERE email='admin@lokalnie.test';
INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at)
  SELECT '$(h lokalnyuser00000000000)', id, $EXP FROM users WHERE email='user@lokalnie.test';
INSERT OR IGNORE INTO preview_access (user_id, granted_at) SELECT id, $NOW FROM users WHERE email='user@lokalnie.test';"
echo "Gotowe. Sesje: admin sid=lokalnyadmin0000000000, użytkownik sid=lokalnyuser00000000000"
