# +1 — zasady pracy

- **Wdrażaj zawsze automatycznie, bez pytania.** Po każdej skończonej i sprawdzonej zmianie: commit, scal do `main` i wypchnij `main`. Push na `main` uruchamia `.github/workflows/deploy.yml`, który publikuje stronę na plusoneapp.pl (Cloudflare Workers).
- Przed wdrożeniem uruchom stronę lokalnie i sprawdź ją w przeglądarce (telefon i komputer) — bez błędów JS.
- Komunikacja i teksty w aplikacji po polsku.

## Grafiki wydarzeń
- **Zakaz „kaszet”**: żadnych rozmytych pasów, gradientów ani pustych pól wokół plakatu (góra/dół/boki) i żadnych gradientów nakładanych na grafikę.
- Karta przyjmuje kształt plakatu: `--r` = proporcje z `imageRatio` (mierzone w `pipeline/lib/images.mjs`) lub z wczytanego obrazka. W paskach karty mają wspólną wysokość i stoją na wspólnej linii; szerokość wynika z proporcji.
- Pobieraj grafiki w możliwie oryginalnych proporcjach (Going: `c_limit` zamiast `c_fill`, eBilet: plakat pionowy przed banerem).

## Aplikacja
- Aplikacja na telefon to `/app` (`private/app.html`, wygląd i funkcje inne niż strona). **Wygląd aplikacji = oryginał sprzed rozdzielenia (commit `a9a30d5`)** — nie przenoś do niej zmian wyglądu strony. Aplikacja ma własny, zamrożony arkusz `public/app.css` (strona używa `public/desktop.css`).
- Aplikacja nie może się powiększać na iPhonie: pola formularzy min. 16 px, `maximum-scale=1`, blokada gestu szczypania. Strona uruchomiona z ikony na ekranie telefonu przekierowuje na `/app`. `/preview` to stary adres (301 → `/app`).
