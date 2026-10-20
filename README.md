# +1

Aplikacja z wydarzeniami — imprezy, koncerty, teatr, stand-up, festiwale — najpierw w Warszawie, potem w całej Polsce.

## Jak to działa

```
źródła (Going., eBilet, Resident Advisor)
   → pipeline/run.mjs   pobiera, czyści, łączy duplikaty, sortuje
   → data/events.json   jeden plik z wszystkimi wydarzeniami
   → index.html         apka wczytuje plik i pokazuje wydarzenia
```

- **GitHub Actions** (`.github/workflows/events.yml`) uruchamia pipeline co 4 godziny i commituje świeży `data/events.json`. Vercel publikuje nową wersję po każdym commicie.
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
node pipeline/run.mjs          # odświeża data/events.json (Node 20+)
npx serve .                    # apka na http://localhost:3000
```

Ekrany biletów, portfela, BLIK i zaproszeń +1 to nadal demo (mock danych, bez realnych płatności).
