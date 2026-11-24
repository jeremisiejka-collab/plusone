# +1 (plusoneapp.pl) — dokumentacja projektu

Ten plik to punkt startowy dla zespołu, który przejmuje projekt. **Zasady produktowe i każda decyzja „dlaczego tak, a nie inaczej” są w [`CLAUDE.md`](../CLAUDE.md)** — to obowiązujący regulamin projektu (np. brak emoji, brak słowa „Going”, zamrożony wygląd aplikacji, zakaz pasów wokół plakatów). Przeczytajcie go w całości przed pierwszą zmianą.

Stan na 23.11.2026: około 6 400 nadchodzących wydarzeń w ponad 40 miastach, 8 źródeł, wszystkie działają.

---

## 1. Co to jest

| Adres | Co | Plik |
|---|---|---|
| `plusoneapp.pl/` | publiczna strona z wydarzeniami (komputer i telefon) | `public/index.html` + `public/desktop.css` |
| `plusoneapp.pl/app` | aplikacja na telefon (PWA), tylko dla kont z dostępem (`preview_access`) | `private/app.html` + `public/app.css` + `public/premium.js/.css` |
| `plusoneapp.pl/admin` | panel administratora i organizatora (wspólny dla strony i aplikacji) | `public/admin.js` + `public/admin.css` |
| `plusoneapp.pl/api/*` | API (konta, bilety, skaner, powiadomienia, statystyki, …) | `worker/*.js` |
| `plusoneapp.pl/e/<id>`, `/miejsce/<nazwa>` | linki do udostępniania z podglądem (og:*) | `worker/share.js` |

Wszystko działa na **Cloudflare Workers** (pliki statyczne z `public/` + Worker `worker/index.js`) i bazie **Cloudflare D1** (SQLite). Dane wydarzeń produkuje **pipeline w Node.js** uruchamiany w **GitHub Actions**; wynikiem jest statyczny plik `public/data/events.json`, który czyta strona i aplikacja. Nie ma frameworka ani kroku budowania — HTML/CSS/JS piszemy bezpośrednio.

```
źródła (Going, eBilet, RA, go2warsaw, ligi sportowe, allevents.in, PIK, strony klubów)
   │  GitHub Actions „Aktualizacja wydarzeń” (.github/workflows/events.yml), ok. co godzinę
   ▼
pipeline/run.mjs  → pobiera, czyści, łączy duplikaty, sprawdza linki, dodaje zdjęcia miejsc
   │  commit public/data/events.json (+ pamięci w pipeline/data/, zdjęcia, public/data/og/)
   ▼
GitHub Actions „Publikacja na Cloudflare” (deploy.yml) → wrangler deploy + migracje D1
   ▼
plusoneapp.pl  (Worker + pliki statyczne + D1)
```

## 2. Dostępy, które musi przekazać właściciel

Repozytorium jest **publiczne**. Nie ma w nim żadnych haseł ani kluczy i tak ma zostać (gitleaks sprawdza każdy push). Poniższe rzeczy przekazuje się osobno, bezpiecznym kanałem:

| Co | Do czego | Gdzie |
|---|---|---|
| GitHub: dostęp do `jeremisiejka-collab/plusone` (Settings → Collaborators) | kod, Actions, sekrety | github.com |
| Cloudflare: zaproszenie do konta (Manage Account → Members) z prawami Workers, D1, DNS | hosting, baza, domena, logi (Observability) | dash.cloudflare.com, konto `3b85c6d8…` |
| Sekret repo `CLOUDFLARE_API_TOKEN` | publikacja z GitHub Actions (uprawnienia: Workers Scripts Edit, D1 Edit, Zone/Workers Routes Edit) | GitHub → Settings → Secrets → Actions |
| Poczta (serwer SMTP) | wszystkie maile: kody logowania, zaproszenia, newsletter | Panel admina → Główny e-mail (zapis w tabeli `settings`). Awaryjnie sekrety Workera `RESEND_API_KEY` + `MAIL_FROM` |
| Klucz operacji (`OPS_KEY`) | `POST /api/ops/*` (linki do haseł administratorów) — w repo jest tylko jego sha256 | tylko u właściciela |
| Lista administratorów | `ADMIN_EMAIL_SHA256` w `wrangler.jsonc` — sha256 adresów, nigdy adresy jawnie | `wrangler.jsonc` |
| Domena `plusoneapp.pl` | DNS jest w Cloudflare, rejestrator — u właściciela | |
| Konto Apple Developer (do zrobienia) | publikacja w App Store (patrz pkt 10) | developer.apple.com |

Klucze VAPID do powiadomień push Worker generuje sam i trzyma w tabeli `settings`.

## 3. Struktura repozytorium

```
public/                pliki statyczne (to, co widzi przeglądarka)
  index.html           strona (cały kod strony w jednym pliku)
  desktop.css          wygląd strony
  app.css              zamrożony wygląd aplikacji (nie zmieniać pod stronę)
  admin.js/.css        panel admina/organizatora, logowanie, skaner, bilet QR — wspólne dla strony i aplikacji
  premium.js/.css      funkcje tylko w aplikacji (obserwowanie, znajomi, plan na wieczór, powiadomienia)
  app-sw.js            service worker aplikacji (offline, push)
  data/events.json     WYNIK pipeline'u — nie edytować ręcznie
  data/og/*.json       dane podglądów linków (256 części), zapisuje pipeline
  data/venues.json     plany sal i stadionów (Capitol, PGE Narodowy, Legia)
  img/obiekty/         zdjęcia miejsc z Wikimedia Commons (autor i licencja w venue-photos.json)
  vendor/              biblioteki i czcionki trzymane u nas (Leaflet, jsQR, qrcode, Space Grotesk, JetBrains Mono)
  admin/moduly/        moduły 3D (Mapa targów, Obiekty 3D) — patrz CLAUDE.md, nie edytować ręcznie
private/app.html       aplikacja na telefon (podawana przez Worker tylko zalogowanym z dostępem)
worker/
  index.js             router, konta, sesje, admin, poczta, proxy allevents, cron
  premium.js           API aplikacji, przewodnik po wydarzeniu, strefy biletów, alerty, newsletter, cron
  social.js            „Znajdź swoje +1” (profile, wiadomości) — na razie zapowiedź
  encounters.js        poznawanie na wydarzeniach — wyłączone (ENCOUNTERS_LIVE)
  stats.js             ruch na stronie (bez ciasteczek, bez IP)
  push.js              Web Push (VAPID)
  nearby.js            lokale w pobliżu wydarzenia (Nominatim)
  share.js             podgląd linków og:*
  security.js          nagłówki bezpieczeństwa (CSP…) i limity zapytań
  smtp.js              klient SMTP
migrations/            schemat D1 (0001…0015), nakładany automatycznie przy publikacji
pipeline/
  run.mjs              główny skrypt pobierania
  sources/*.mjs        jedno źródło = jeden plik
  lib/                 normalizacja, duplikaty, linki, zdjęcia, geolokalizacja, „na topie”, og
  data/                pamięci między przebiegami (commitowane przez bota)
  tools/health.mjs     strażnik źródeł
  venues/, venue3d/    generatory planów sal i modeli 3D
tools/                 narzędzia programisty: seed-local.sh, audit-app.cjs
.github/workflows/     events.yml (pobieranie), deploy.yml (publikacja), security.yml
CLAUDE.md              zasady projektu (obowiązujące!)
```

## 4. Uruchomienie lokalne

Wymagania: Node.js ≥ 22.13, `npx wrangler@4` (pobiera się sam), do audytu — Playwright z Chromium (`npm i -g playwright && npx playwright install chromium`).

```sh
# 1. baza lokalna + dwa konta testowe z gotowymi sesjami
tools/seed-local.sh

# 2. serwer (Worker + pliki + lokalna D1) na http://localhost:8799
npx wrangler@4 dev --local --port 8799 \
  --var ADMIN_EMAIL_SHA256:$(printf admin@lokalnie.test | sha256sum | cut -d' ' -f1)

# 3. w przeglądarce ustaw ciasteczko sid na localhost:8799:
#    lokalnyuser00000000000  — zwykły użytkownik z dostępem do /app
#    lokalnyadmin0000000000  — administrator
```

- Strona: `http://localhost:8799/`, aplikacja: `/app` (na komputerze w ramce telefonu; najlepiej tryb urządzenia w DevTools), panel: `/admin`.
- Lokalnie nie ma poczty — logowanie hasłem/kodem nie wyśle maila; używajcie sesji z `seed-local.sh`.
- Pipeline lokalnie: `node pipeline/run.mjs` (całość, 5–10 min) albo `node pipeline/run.mjs --only=pik,kluby`. Zapisuje `public/data/events.json` — **nie commitujcie wyniku z lokalnego przebiegu**, robi to bot.
- Testy: `npm test` (normalizacja danych, brak emoji, logika „social”).
- Audyt wyglądu aplikacji (wszystkie ekrany × iPhone SE / 13 / Pro Max × jasny / ciemny, wykrywa nachodzący i ucięty tekst, błędy JS, robi zrzuty): `node tools/audit-app.cjs` przy działającym serwerze. Kod wyjścia ≠ 0, gdy coś znajdzie.

## 5. Wdrożenie

- Każdy push na `main` → `deploy.yml`: test, założenie bazy D1 (jeśli brak), `wrangler d1 migrations apply --remote`, `wrangler deploy`. Trwa ok. 1 min.
- Zasada projektu: po każdej sprawdzonej zmianie commit i push na `main` (bez długich gałęzi). Przed pushem sprawdzić lokalnie stronę i aplikację na telefonie i komputerze, bez błędów JS.
- Nowa tabela/kolumna = nowy plik `migrations/00NN_nazwa.sql` (nigdy nie zmieniać starych migracji).
- Logi produkcji: Cloudflare → Workers → plusone → Observability. `GET /api/health` pokazuje stan bazy i poczty.
- Zapasowy adres Workera: `plusone.jeremi-3b8.workers.dev`.

## 6. Pobieranie wydarzeń (scraping)

### Harmonogram — „non stop”
- `events.yml` ma harmonogram co godzinę, ale GitHub w praktyce uruchamia takie zadania co 6–9 h. Dlatego **każdy przebieg sam zamawia następny ~55 min po swoim starcie** (zadanie `next`, `workflow_dispatch` z `GITHUB_TOKEN`), także po błędzie. Harmonogram zostaje jako zapas, gdyby łańcuch się przerwał. `concurrency: events` pilnuje, żeby nigdy nie szły dwa przebiegi naraz.
- Po zapisaniu danych przebieg od razu zleca publikację (`deploy.yml`), więc nowe wydarzenia są na stronie po ok. 10–15 min od startu.
- Ręczne uruchomienie: Actions → „Aktualizacja wydarzeń” → Run workflow.
- Repo jest publiczne, więc minuty GitHub Actions są bezpłatne.

### Odporność i nadzór
- Źródło, które padnie, nie usuwa wydarzeń: `run.mjs` bierze jego wydarzenia z poprzedniego przebiegu. Stan każdego źródła jest w `events.json` → `sources` (`ok`, `count`, `error`).
- **Strażnik** (`pipeline/tools/health.mjs`, krok w `events.yml`): gdy źródło zwraca błąd, ma mniej niż połowę zwykłej liczby wydarzeń albo razem jest < 4000 wydarzeń, otwiera na GitHubie zgłoszenie **„Pobieranie wydarzeń: problem”** (z linkiem do przebiegu), dopisuje zmiany i **sam je zamyka**, gdy wszystko wróci do normy. Włączcie powiadomienia o issues w repo (Watch → Custom → Issues). Progi (`MIN`) poprawiajcie razem ze wzrostem bazy.
- Przebieg kończy się błędem, jeśli `npm test` znajdzie problem w danych (np. emoji) — wtedy dane się nie zapisują, a strona pokazuje poprzednią wersję.

### Źródła

| Źródło (`sources[]`) | Plik | Jak | Uwagi |
|---|---|---|---|
| `going` (pokazywane jako „Bilety online”) | `sources/going.mjs` | goingapp.pl | słowa „Going” nie pokazujemy ludziom; grafiki `c_limit` |
| `ebilet` | `sources/ebilet.mjs` | ebilet.pl, 13 miast + strony ogólnopolskie | wpuszcza mało zapytań naraz → katalog dociągany partiami co przebieg (`pipeline/data/ebilet-titles.json`); cena 0 = brak ceny |
| `ra` | `sources/ra.mjs` | Resident Advisor (GraphQL) | kluby i elektronika |
| `go2warsaw` | `sources/go2warsaw.mjs` | oficjalny serwis Warszawy | |
| `sport` | `sources/sport.mjs` | Ekstraklasa, PlusLiga, PLK | zdjęcia stadionów z Wikimedia; hale w `data/sport-venues.json` |
| `allevents` | `sources/allevents.mjs` | allevents.in (publiczne wydarzenia, w dużej części z Facebooka), 15 miast | blokuje IP GitHub Actions → idzie przez nasz Worker `GET /api/feed/allevents` (limit 1500/h); 50 stron na przebieg, pamięć `data/allevents.json` |
| `pik` | `sources/pik.mjs` | pik.warszawa.pl, schema.org/Event | odrzucamy linki do widżetów osadzanych |
| `kluby` | `sources/kluby.mjs` | własne czytniki: Sektor 6D, Progresja, Stodoła | nowy klub z schema.org/Event = wpis w `SITES` |

Facebooka i Instagrama nie pobieramy bezpośrednio (wymagają logowania, regulaminy zabraniają automatów). Lista miejsc bez danych do odczytu i wyłączonych lig — w `CLAUDE.md`.

### Po pobraniu (kolejność w `run.mjs`)
1. `cleanEventText` — czyszczenie tytułów i opisów, usuwanie emoji.
2. `dedup(dedup(…))` (`lib/dedup.mjs`) — to samo wydarzenie z kilku serwisów = jeden wpis z kilkoma linkami do biletów.
3. `checkLinks` (`lib/links.mjs`) — martwe linki (404/410, przekierowanie na stronę główną) wypadają; wydarzenie bez żadnego działającego linku znika. 403/429/5xx = „nie wiadomo”, link zostaje.
4. `addVenuePhotos` (`lib/venue-photos.mjs`) — każde wydarzenie bez plakatu dostaje prawdziwe zdjęcie miejsca albo miasta (Wikipedia/Commons). **Nie ukrywamy wydarzeń bez zdjęcia.**
5. `measureImages` — proporcje plakatów (`imageRatio`).
6. `hotScore`, `isBig` — sekcje „Na topie” i „Duże wydarzenia”.
7. `writeOg` — dane do podglądów linków.

### Dodanie źródła
Nowy plik w `pipeline/sources/` eksportujący `async () => [...]` z wydarzeniami zrobionymi przez `makeEvent()` (format w `pipeline/lib/normalize.mjs`), wpis w `SOURCES` w `run.mjs`, próg w `pipeline/tools/health.mjs` → `MIN`, nowe pliki pamięci dopisać do `git add` w `events.yml`, opis w `CLAUDE.md`. Grzecznie: własny User-Agent bez danych osobowych, przerwy między zapytaniami, pamięć zamiast pobierania wszystkiego co godzinę.

## 7. API Workera (skrót)

Konta: `/api/auth/{login,register,logout,code,verify,forgot,reset}`, `/api/me`, `/api/me/password`, `/api/invite/accept`.
Użytkownik: `/api/saved`, `/api/tickets`, `/api/state`, `/api/follows`, `/api/notifications(/read)`, `/api/push/{key,subscribe,unsubscribe,test}`, `/api/crew(/invite|/join)`, `/api/friends`, `/api/wrapped`, `/api/guide*`.
Obsługa i organizator: `/api/scan`, `/api/scan/stats`, `/api/org/me`, `/api/org/guests`.
Administrator: `/api/admin/{users,invites,stats,live,organizers,curation,mail,mail/test,mail/detect,newsletter,alerts/run}`, `/api/preview-access`, `/api/social/admin/*`.
Publiczne: `/api/health`, `/api/nearby`, `/api/t` (licznik ruchu), `/api/feed/allevents` (tylko dla pipeline'u).
Operacje właściciela: `/api/ops/admin-links`, `/api/ops/welcome-admins` (klucz OPS).

Każda zmiana danych ma limit zapytań (`worker/security.js`, tabela `rate_limits`). Nowy zewnętrzny adres, z którym łączy się przeglądarka, trzeba dopisać do CSP `connect-src` (w `worker/security.js` **i** `public/_headers`).

Cron Workera (`wrangler.jsonc`): co 6 h alerty dla obserwujących (nowe wydarzenia, spadki cen) i sprzątanie statystyk; w czwartki rano newsletter.

## 8. Baza D1

Schemat w `migrations/`. Najważniejsze tabele: `users`, `sessions` (sha256 tokenu z ciasteczka `sid`), `saved`, `tickets`, `preview_access`, `invites`, `settings` (poczta, VAPID), `follows`, `notifications`, `friends`, `crew_invites`, `org_venues`, `guests`, `resets`, `push_subs`, `event_guides`, `event_posts`, `event_mail_queue`, `login_codes`, `rate_limits`, `stat_hits`/`stat_live` (ruch na stronie), `social_*` („Znajdź swoje +1” i poznawanie). Kopia produkcji: `npx wrangler@4 d1 export plusone --remote --output kopia.sql` (zawiera dane osobowe — nie wrzucać do repo ani nie wysyłać dalej).

## 9. Zasady, których nie wolno złamać (skrót z CLAUDE.md)

- Bez emoji nigdzie (także w danych z zewnątrz) — `esc()` je usuwa, testy pilnują.
- Słowo „Going” nie pojawia się w tekstach dla ludzi.
- Plakaty: bez rozmytych pasów i gradientów, tylko kadrowanie `object-fit: cover` (3:4 / 4:3).
- Wygląd aplikacji (`app.css`) jest zamrożony — zmiany wyglądu strony nie przechodzą do aplikacji.
- Aplikacja ma działać jak natywna: hover tylko dla myszy, pola 16 px, brak powiększania na iPhonie, przypięte paski z odstępem na pasek gestów. Po każdej zmianie wyglądu aplikacji: `node tools/audit-app.cjs`.
- Bez przykładowych/fikcyjnych treści dla prawdziwych kont; demo tylko w „Podglądzie jako” administratora.
- Bez dostępu do prawdziwych danych bez logowania; administratorzy tylko z listy sha256.
- Biblioteki i czcionki tylko z `public/vendor/`, bez CDN.

## 10. Co zostało do zrobienia

1. **App Store / Google Play.** Sama strona nie wejdzie do sklepu — potrzebna natywna otoczka (rekomendacja: Capacitor, ładujący `https://plusoneapp.pl/app` albo spakowane pliki), budowana na Macu w Xcode, konto Apple Developer. Aplikacja już wykrywa `window.Capacitor` (ukrywa podpowiedź „Dodaj do ekranu”). Do zrobienia w otoczce: natywne powiadomienia push (APNs zamiast Web Push), logowanie (ciasteczko `sid` w WebView), aparat dla skanera, linki uniwersalne `/e/<id>`, ikony i ekrany startowe, polityka prywatności, opis i zrzuty do sklepu. Ryzyko: wytyczna Apple 4.2 (aplikacja-„strona w ramce”) — bronią nas funkcje tylko w aplikacji (bilety QR, skaner, powiadomienia, przewodnik po wydarzeniu, plan na wieczór).
2. **Portfel** — obecnie „Już wkrótce” (bez płatności).
3. **„Znajdź swoje +1” / poznawanie** — backend gotowy, wyłączony (`ENCOUNTERS_COMING_SOON`, `ENCOUNTERS_LIVE`); włączać tylko na decyzję właściciela.
4. **Więcej źródeł**: kolejne kluby (wpisy w `SITES`), piłka ręczna i hokej, TAURON Liga (patrz CLAUDE.md, dlaczego wyłączona).
5. **Nominatim** (lokale w pobliżu) ma limit 1 zapytanie/s i politykę użycia dla małych serwisów; przy dużym ruchu — własna instancja albo płatne API map. Wyniki są w pamięci 7 dni.
6. **README.md** jest częściowo historyczne — aktualny opis to ten plik i `CLAUDE.md`.
