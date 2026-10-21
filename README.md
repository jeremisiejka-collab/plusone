# +1

Aplikacja z wydarzeniami — imprezy, koncerty, teatr, stand-up, festiwale — najpierw w Warszawie, potem w całej Polsce.

## Jak to działa

```
źródła (Going., eBilet, Resident Advisor)
   → pipeline/run.mjs   pobiera, czyści, łączy duplikaty, sortuje
   → public/data/events.json   jeden plik z wszystkimi wydarzeniami
   → public/index.html         apka wczytuje plik i pokazuje wydarzenia
```

- **GitHub Actions** (`.github/workflows/events.yml`) uruchamia pipeline co 4 godziny i commituje świeży `public/data/events.json`. Cloudflare publikuje nową wersję po każdym commicie na `main`.
- Ręczne uruchomienie: zakładka **Actions → Aktualizacja wydarzeń → Run workflow**.
- Duplikaty (ten sam koncert w kilku serwisach) są łączone w jeden wpis z kilkoma linkami do biletów.

### Źródła

| Źródło | Co daje | Plik |
|---|---|---|
| Going. (goingapp.pl) | koncerty, teatr, stand-up, sport — cała Polska | `pipeline/sources/going.mjs` |
| eBilet | koncerty, teatr, rodzina — 13 miast | `pipeline/sources/ebilet.mjs` |
| Resident Advisor | kluby i elektronika — Warszawa, Kraków, Trójmiasto, Wrocław, Poznań, Łódź | `pipeline/sources/ra.mjs` |

Nowe źródło = nowy plik w `pipeline/sources/`, który zwraca listę wydarzeń przez `makeEvent()` (format opisany w `pipeline/lib/normalize.mjs`), i dopisanie go w `pipeline/run.mjs`.

## Lokalnie

```sh
node pipeline/run.mjs          # odświeża public/data/events.json (Node 20+)
npx serve public               # apka na http://localhost:3000
```

## Hosting

- Domena **plusoneapp.pl**: rejestrator GoDaddy, DNS w Cloudflare.
- Strona: **Cloudflare Workers** (static assets, `wrangler.jsonc`), publikowany jest tylko folder `public/`. `public/_headers` ustawia cache.
- Publikuje GitHub Actions (`.github/workflows/deploy.yml`) po każdym pushu na `main` i po każdej aktualizacji danych. Wymaga sekretu repo `CLOUDFLARE_API_TOKEN` (szablon „Edit Cloudflare Workers”).
- Adres zapasowy: https://plusone.jeremi-3b8.workers.dev

## Demo

Bilety, portfel, PAY, BLIK i zaproszenia +1 to wciąż makiety (bez realnych płatności). Publicznie są ukryte; pokazuje je `?demo`, chowa `?demo=0`.
