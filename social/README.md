# Posty i story na Instagram

`node social/generate.mjs` wybiera wydarzenia o największym potencjale z `public/data/events.json`
i robi z nich gotowe grafiki oraz opisy:

- `post-NN.png` — post 1080×1350 (4:5),
- `story-NN.png` — story 1080×1920 (miejsce na naklejkę z linkiem nad dolnym marginesem),
- `weekend.png` — plansza „Weekend w mieście …” (5 propozycji),
- `opisy.md` — opisy z hashtagami do skopiowania i link do biletów.

**Jak wybieramy:** duże sale i areny, festiwale, wydarzenie sprzedawane w kilku serwisach (większy popyt),
znani wykonawcy, zdjęcie, wyższa cena biletu; minus za wystawy i karnety. Z jednej trasy wybieramy jeden termin,
z innych miast maks. 2 wydarzenia. Reguła: `score()` w `generate.mjs`.

**Automatycznie:** GitHub Actions „Posty na Instagram” w poniedziałki i czwartki rano.
Pobierasz: Actions → ostatni przebieg → Artifacts → `instagram`. Ręcznie: Run workflow (można podać miasto).

Opcje: `--days=21 --count=6 --city=Warszawa`. Lokalnie potrzebny jest pakiet `playwright` z Chromium.
Plakaty należą do organizatorów — używamy ich do promowania ich wydarzeń, z oznaczeniem miejsca i daty.
