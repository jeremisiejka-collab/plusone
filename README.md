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
| eBilet | koncerty, teatr, rodzina — 13 miast + ogólnopolskie strony muzyki i festiwali | `pipeline/sources/ebilet.mjs` |
| Resident Advisor | kluby i elektronika — cała Polska | `pipeline/sources/ra.mjs` |
| go2warsaw.pl | wystawy, koncerty, spotkania w Warszawie (oficjalny serwis miasta) | `pipeline/sources/go2warsaw.mjs` |

- **Grafiki**: pipeline zapisuje `imageRatio` (szerokość/wysokość, `pipeline/lib/images.mjs`); karty w aplikacji mają kształt plakatu, bez przycinania i pasów.
- **Wielkie wydarzenia** (`big` w events.json): festiwale oraz koncerty na stadionach i arenach albo z biletami od 350 zł — reguła `isBig()` w `pipeline/lib/normalize.mjs`.
- **Mapa**: granice województw w `public/data/poland.json`, współrzędne miejscowości (GeoNames) w `pipeline/data/places.json`; pipeline dopisuje do events.json pole `geo` (`pipeline/lib/geo.mjs`).

Nowe źródło = nowy plik w `pipeline/sources/`, który zwraca listę wydarzeń przez `makeEvent()` (format opisany w `pipeline/lib/normalize.mjs`), i dopisanie go w `pipeline/run.mjs`.

## Lokalnie

```sh
node pipeline/run.mjs          # odświeża public/data/events.json (Node 20+)
npx serve public               # apka na http://localhost:3000
```

## Hosting

### Publiczna witryna i zamknięty prototyp

`plusoneapp.pl` pokazuje tę samą witrynę w przeglądarce na komputerze i telefonie. Układ dopasowuje się do szerokości; katalog, mapa, bilety, konto i logowanie korzystają z tego samego API. Parametr `?demo` i wcześniej zapamiętany tryb demo nie przełączają publicznej witryny w aplikację.

Prototyp aplikacji jest osobnym dokumentem `private/app.html`, dołączanym do Workera jako tekst, poza katalogiem statycznym `public/`. Adres `/app` wymaga ważnej sesji i uprawnienia administratora lub wpisu w `preview_access`. Administrator nadaje i odbiera to uprawnienie w **Konto → Panel admina → Użytkownicy → Daj/Odbierz podgląd**. Tester najpierw zakłada zwykłe konto. Przyznanie dostępu nie nadaje praw administratora. Link do prototypu pojawia się w koncie testera i w sekcji **Aplikacja na telefon**. Odpowiedzi podglądu mają `Cache-Control: private, no-store` i zakaz indeksowania.

Przed uruchomieniem zastosuj wszystkie migracje D1, w tym `0003_preview_access.sql`. Bez dostępnej bazy podgląd pozostaje zamknięty. Publiczna witryna i prototyp mają osobne dokumenty — zmiany wyglądu strony nie powinny automatycznie modyfikować makiet aplikacji.

### Aplikacja na telefon (PWA, zamknięte testy)

`/app` to instalowalna aplikacja (PWA) — za darmo, na Androidzie i iPhonie, bez sklepu:

- `public/app.webmanifest` (zakres `/app`) i `public/app-sw.js` (service worker: ekran aplikacji i `events.json` najpierw z sieci, bez zasięgu z pamięci; strona logowania nie jest zapisywana).
- Strona główna uruchomiona z ikony na ekranie telefonu przekierowuje na `/app`, więc ikona zawsze otwiera aplikację, nie stronę WWW. `/preview` przekierowuje na `/app`.
- Bez sesji `/app` pokazuje własny formularz logowania. Aplikacja dodana do ekranu iPhone'a nie widzi ciasteczek z Safari, więc tester loguje się raz w aplikacji.
- **Android**: Chrome → przycisk „Instaluj” w aplikacji albo menu ⋮ → „Zainstaluj aplikację”. **iPhone**: Safari → Udostępnij → „Do ekranu początkowego”.
- Instrukcja dla testerów jest w zakładce **Aplikacja** na stronie.

Następny krok (opcjonalnie): pakiet APK przez Capacitor/TWA dla Androida. Natywna aplikacja na iOS (TestFlight) wymaga płatnego konta Apple Developer i macOS/Xcode.

- Domena **plusoneapp.pl**: rejestrator GoDaddy, DNS w Cloudflare.
- Strona: **Cloudflare Workers** (static assets, `wrangler.jsonc`), publikowany jest tylko folder `public/`. `public/_headers` ustawia cache.
- Publikuje GitHub Actions (`.github/workflows/deploy.yml`) po każdym pushu na `main` i po każdej aktualizacji danych. Wymaga sekretu repo `CLOUDFLARE_API_TOKEN` (szablon „Edit Cloudflare Workers”).
- Adres zapasowy: https://plusone.jeremi-3b8.workers.dev

## Konta i panel admina

- API w `worker/index.js` (Cloudflare Worker, ścieżki `/api/*`), baza **D1** `plusone`, schemat w `migrations/`.
- Rejestracja e-mail + hasło (PBKDF2), sesja w ciasteczku HttpOnly na 60 dni, limit prób logowania.
- Uprawnienia: **Tester aplikacji** (`preview_access`), **Moderator** (`perm_curate`: poleca/ukrywa wydarzenia), **Administrator** (`role = 'admin'`: panel, użytkownicy, zaproszenia), **Główny administrator** (`owner`: jako jedyny nadaje i odbiera admina; zawsze zostaje co najmniej jeden). Admin z konfiguracji: `ADMIN_EMAIL_SHA256` w `wrangler.jsonc`.
- Główni administratorzy startowi (migracja `0004`): jeremi@tooday.pl, lukasz@tooday.pl, p.puchalski@tooday.pl — hasło startowe `1234`, zmiana wymuszona przy pierwszym logowaniu (`must_change`; do tego czasu panel admina jest zablokowany).
- **Zaproszenia** (Panel admina → Zaproszenia): e-mail + uprawnienia → link `/app?invite=…` ważny 14 dni; zaproszony ustawia hasło i od razu ma dostęp. Istniejące konto dostaje uprawnienia od razu.
- **Wysyłka maili**: przez [Resend](https://resend.com) — ustaw sekrety Workera `RESEND_API_KEY` i `MAIL_FROM` (np. `+1 <zaproszenia@plusoneapp.pl>`, domena zweryfikowana w Resend): `npx wrangler secret put RESEND_API_KEY`. Bez nich panel pokazuje link do skopiowania i przycisk „Wyślij z poczty”.
- **Moje bilety**: na wydarzeniu „Mam bilet” i „Zapisz” (tabela `saved`, kolumna `kind` = `going`/`saved`, migracja `0002`). Gość trzyma je w `localStorage`, po zalogowaniu przechodzą na konto. Zakładka Bilety pokazuje najbliższe wydarzenie z odliczaniem, dojazdem i plikiem do kalendarza; PAY pojawia się tylko w dniu wydarzenia z biletem.
- Panel admina (Profil → Panel admina): statystyki, użytkownicy i role, polecanie/ukrywanie wydarzeń, stan źródeł danych.
- Lokalnie: `npx wrangler d1 migrations apply plusone --local && npx wrangler dev`.

## Demo

Portfel, PAY, BLIK i zaproszenia +1 to wciąż makiety (publicznie Portfel ma ekran „Wkrótce”) (bez realnych płatności). Publicznie są ukryte; pokazuje je `?demo`, chowa `?demo=0`.
