# +1

Aplikacja z wydarzeniami — imprezy, koncerty, teatr, stand-up, festiwale — najpierw w Warszawie, potem w całej Polsce.

## Jak to działa

```
źródła (Going., eBilet, Resident Advisor, go2warsaw.pl)
   → pipeline/run.mjs   pobiera, czyści, łączy duplikaty, sortuje
   → public/data/events.json   jeden plik z wszystkimi wydarzeniami
   → public/index.html         apka wczytuje plik i pokazuje wydarzenia
```

- **GitHub Actions** (`.github/workflows/events.yml`) uruchamia pipeline 2× dziennie (ok. 6:00 i 16:00) i commituje świeży `public/data/events.json`. Cloudflare publikuje nową wersję po każdym commicie na `main`.
- Ręczne uruchomienie: zakładka **Actions → Aktualizacja wydarzeń → Run workflow**.
- Duplikaty (ten sam koncert w kilku serwisach) są łączone w jeden wpis z kilkoma linkami do biletów.

### Źródła

| Źródło | Co daje | Plik |
|---|---|---|
| Going. (goingapp.pl) | koncerty, teatr, stand-up, sport — cała Polska | `pipeline/sources/going.mjs` |
| eBilet | koncerty, teatr, rodzina — 13 miast | `pipeline/sources/ebilet.mjs` |
| Resident Advisor | kluby i elektronika — cała Polska | `pipeline/sources/ra.mjs` |
| go2warsaw.pl | wystawy, koncerty, spotkania w Warszawie (oficjalny serwis miasta) | `pipeline/sources/go2warsaw.mjs` |

Nowe źródło = nowy plik w `pipeline/sources/`, który zwraca listę wydarzeń przez `makeEvent()` (format opisany w `pipeline/lib/normalize.mjs`), i dopisanie go w `pipeline/run.mjs`.

## Lokalnie

```sh
node pipeline/run.mjs          # odświeża public/data/events.json (Node 20+)
npx serve public               # apka na http://localhost:3000
```

## Hosting

### Strona na komputerze i widok mobilny

Oba widoki działają pod `plusoneapp.pl`, korzystają z tego samego katalogu wydarzeń i API kont. Do 760 px pozostaje układ mobilny; od 761 px `public/desktop.css` włącza stronę z górną nawigacją, siatką wydarzeń i dwukolumnowymi szczegółami. Zmiana szerokości okna zachowuje wybrane miasto, filtry i otwarty ekran. Na komputerze nowe wejście otwiera od razu katalog, bez ekranu powitalnego. Tryb `?demo` zachowuje dotychczasowy prototyp.

Lokalnie uruchom Worker z bazą D1 poleceniem opisanym niżej. Sprawdź widoki przy 390, 760, 761, 1024 i 1440 px, w obu motywach: wyszukiwanie, filtry, zmianę miasta, szczegóły wydarzenia, link do sprzedawcy i logowanie. Podział dostępnych funkcji między stronę a aplikację pozostaje kolejnym etapem.

- Domena **plusoneapp.pl**: rejestrator GoDaddy, DNS w Cloudflare.
- Strona: **Cloudflare Workers** (static assets, `wrangler.jsonc`), publikowany jest tylko folder `public/`. `public/_headers` ustawia cache.
- Publikuje GitHub Actions (`.github/workflows/deploy.yml`) po każdym pushu na `main` i po każdej aktualizacji danych. Wymaga sekretu repo `CLOUDFLARE_API_TOKEN` (szablon „Edit Cloudflare Workers”).
- Adres zapasowy: https://plusone.jeremi-3b8.workers.dev

## Konta i panel admina

- API w `worker/index.js` (Cloudflare Worker, ścieżki `/api/*`), baza **D1** `plusone`, schemat w `migrations/`.
- Rejestracja e-mail + hasło (PBKDF2), sesja w ciasteczku HttpOnly na 60 dni, limit prób logowania.
- Role: `user` i `admin`. Admin z konfiguracji: `ADMIN_EMAIL_SHA256` w `wrangler.jsonc` (sha256 adresu e-mail); kolejnych adminów nadaje się w panelu.
- Gość może zapisywać wydarzenia na telefonie; po zalogowaniu przenoszą się na konto.
- Panel admina (Profil → Panel admina): statystyki, użytkownicy i role, polecanie/ukrywanie wydarzeń, stan źródeł danych.
- Lokalnie: `npx wrangler d1 migrations apply plusone --local && npx wrangler dev`.

## Demo

Bilety, portfel, PAY, BLIK i zaproszenia +1 to wciąż makiety (bez realnych płatności). Publicznie są ukryte; pokazuje je `?demo`, chowa `?demo=0`.
