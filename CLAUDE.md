# +1 — zasady pracy

- **Wdrażaj zawsze automatycznie, bez pytania.** Po każdej skończonej i sprawdzonej zmianie: commit, scal do `main` i wypchnij `main`. Push na `main` uruchamia `.github/workflows/deploy.yml`, który publikuje stronę na plusoneapp.pl (Cloudflare Workers).
- Przed wdrożeniem uruchom stronę lokalnie i sprawdź ją w przeglądarce (telefon i komputer) — bez błędów JS.
- Komunikacja i teksty w aplikacji po polsku.
- **Bez emoji na stronie i w aplikacji.** Dotyczy również tytułów i opisów pobieranych z zewnętrznych źródeł. Używaj tekstu lub istniejących ikon SVG; importowane treści muszą być oczyszczane z emoji.

## Grafiki wydarzeń
- **Zakaz „kaszet”**: żadnych rozmytych pasów, gradientów ani pustych pól wokół plakatu (góra/dół/boki) i żadnych gradientów nakładanych na grafikę.
- Na stronie podglądy wydarzeń mają tylko dwa formaty: pionowy **3:4** i poziomy **4:3**, ze wspólną wysokością we wszystkich sekcjach. Kadruj przez `object-fit: cover`, bez rozciągania i pasów. Pełny plakat na stronie wydarzenia zachowuje oryginalne proporcje z `imageRatio` lub wczytanego obrazka.
- Pobieraj grafiki w możliwie oryginalnych proporcjach (Going: `c_limit` zamiast `c_fill`, eBilet: plakat pionowy przed banerem).

## Aplikacja
- Zachętę do instalacji odkładamy do publikacji w App Store. Na stronie zostaje zwykły przycisk „Aplikacja” po prawej stronie nagłówka; bez wyskakującego komunikatu instalacyjnego.
- Aplikacja na telefon to `/app` (`private/app.html`, wygląd i funkcje inne niż strona). **Wygląd aplikacji = oryginał sprzed rozdzielenia (commit `a9a30d5`)** — nie przenoś do niej zmian wyglądu strony. Aplikacja ma własny, zamrożony arkusz `public/app.css` (strona używa `public/desktop.css`).
- Aplikacja nie może się powiększać na iPhonie: pola formularzy min. 16 px, `maximum-scale=1`, blokada gestu szczypania. Strona uruchomiona z ikony na ekranie telefonu przekierowuje na `/app`. `/preview` to stary adres (301 → `/app`).

## Konta i panel admina
- Role: **Użytkownik**, **Obsługa biletów** (`perm_scan`, skaner biletów), **Administrator** (`role='admin'`); główni administratorzy (`owner`) nadają admina i mają „Zobacz jako”.
- Panel admina, zaproszenia, poczta, skaner biletów i bilet z QR są w jednym pliku `public/admin.js` (+ `public/admin.css`), ładowanym przez stronę i aplikację — zmieniaj je tylko tam.
- Role także **Organizator** (`perm_org` + miejsca w `org_venues`): panel organizatora ze statystykami i listą gości; admin widzi listę organizatorów i wchodzi w każdego.
- **Aplikacja = premium**: funkcje tylko dla aplikacji są w `public/premium.js` (+ `premium.css`), ładowanym wyłącznie przez `private/app.html` — zainteresowania, obserwowanie, powiadomienia, znajomi („Idziesz z kimś?”), plan na wieczór, „Twoje wyjścia”. Na stronie tylko newsletter i zachęta do aplikacji. API premium i zadania cron: `worker/premium.js`.
- **„Znajdź swoje +1”** to ważna część aplikacji obok odkrywania wydarzeń, nie zastępuje jej głównej funkcji. Autorskie spotkania Plus Jeden dodaje administrator (Konto → Spotkania Plus Jeden). Profile i rozmowy są prawdziwe, bez przykładowych osób. Backend: `worker/social.js`, migracja `0009_social.sql`.
- Poznawanie na spotkaniach jest dobrowolne i dostępne od 18 lat. Obsługa potwierdza imię, datę urodzenia i obecność na miejscu na podstawie dokumentu ze zdjęciem i jednorazowego kodu z aplikacji. Nie zapisuj zdjęć ani numerów dokumentów, nie pokazuj pełnej daty urodzenia innym uczestnikom. Rozmowa wymaga wzajemnych plusików; blokady i wyłączenie widoczności muszą odcinać kontakt także po stronie API.
- Cała poczta (zaproszenia, alerty, newsletter, bilety gości, reset hasła) wychodzi z jednego „Głównego e-maila” ustawianego w Panel admina → Główny e-mail.
- Biblioteki i czcionki trzymamy u siebie w `public/vendor/` (Leaflet, jsQR, qrcode-generator, `fonts/` — Space Grotesk i JetBrains Mono), nie z CDN. Wszystkie ekrany aplikacji (też logowanie i bilet gościa) używają tylko tych dwóch krojów.
- Powiadomienia push: `worker/push.js` (VAPID w `settings`, sygnał bez treści), subskrypcje `push_subs` (migracja `0008`), odbiór w `public/app-sw.js`.
