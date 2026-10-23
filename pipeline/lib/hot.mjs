/* "Na topie": ile wydarzenie jest warte pokazania na początku (im więcej, tym wyżej).
   Znani artyści i duże marki, prestiżowe miejsca i duże sceny w górę; targi, food festy, warsztaty i wystawy w dół.
   Listy są ręczne — dopisuj tu nowe gwiazdy i miejsca. Admin może też polecić wydarzenie w panelu. */

const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

// wykonawcy i marki, na które się chodzi (młodzieżowe i najpopularniejsze w Polsce + duże gwiazdy zagraniczne)
const STARS = `bambi, mata, young leosia, sobel, kizo, oki, quebonafide, taco hemingway, white 2115, pezet, otsochodzi, szpaku, malik montana,
 kukon, zabson, bedoes, schafter, gibbs, frank leen, kuqe 2115, vito bambino, sanah, dawid podsiadlo, podsiadlo, daria zawialow, kwiat jabloni,
 ralph kaminski, brodka, margaret, sarsa, roxie, natalia szroeder, mrozu, kayah, doda, kuba badach, artur rojek, organek, hey, myslovitz,
 lady pank, perfect, dzem, kult, t.love, krzysztof zalewski, zalewski, igo, lanberry, viki gabor, blanka, ania karwan, smolasty, sentino,
 tribbs, kaz balagane, palucH, paluch, peja, o.s.t.r., ostr, sokol, tede, kaliber 44, paktofonika, fisz emade, vtss, kris baha, catz n dogz,
 meskie granie, opener, open'er, orange warsaw, audioriver, tauron nowa muzyka, polandrock, fest festival, hype festival, clout, unsound,
 wwoff, b-day festival, sun festival, summer contrast, intro festival, mystic festival, rock for people,
 dua lipa, coldplay, the weeknd, travis scott, ed sheeran, imagine dragons, metallica, linkin park, billie eilish, sabrina carpenter,
 olivia rodrigo, post malone, kendrick lamar, eminem, rammstein, guns n' roses, ac/dc, depeche mode, iron maiden, slipknot,
 bring me the horizon, hurts, skunk anansie, madison beer, conan gray, sabaton, kygo, martin garrix, david guetta, tiesto,
 armin van buuren, charlotte de witte, amelie lens, boris brejcha, fred again, central cee, sfera ebbasta, bad gyal, lana del rey,
 the killers, muse, arctic monkeys, twenty one pilots, shawn mendes, lewis capaldi, sam smith, harry styles, katy perry, pink, shakira,
 andrea bocelli, hans zimmer, ludovico einaudi, cirque du soleil, disney on ice, harlem globetrotters,
 abelard giza, rafal pacze, kacper rucinski, mateusz socha, karol kopiec, cezary jurkiewicz, stand-up polska, kabaret moralnego niepokoju,
 kabaret neo-nowka, kabaret skeczow meczacych, polska noc kabaretowa`.split(',').map(s => fold(s.trim())).filter(Boolean);

// prestiżowe miejsca i duże sceny
const VENUES = `teatr wielki, opera narodowa, filharmonia narodowa, pge narodowy, stadion, tauron arena, atlas arena, ergo arena, torwar,
 progresja, stodola, palladium, ice krakow, narodowe forum muzyki, nospr, teatr narodowy, teatr dramatyczny, och-teatr, teatr polski,
 hala stulecia, spodek, arena gliwice, polsat plus arena, expo xxi, lotnisko bemowo, tor sluzewiec, smolna, jasna 1, luzztro, new age,
 proxima, hydrozagadka, b90, klub wytwornia, centrum spotkania kultur, filharmonia, opera`.split(',').map(s => fold(s.trim())).filter(Boolean);

const TOP_HALLS = ['teatr wielki', 'opera narodowa', 'filharmonia narodowa', 'narodowe forum muzyki', 'nospr'];

// mniej "wyjściowe": targi, jedzenie, warsztaty, edukacja, wystawy stałe
const MEH = /\b(food|targi|kiermasz|jarmark|warsztat|zwiedzani|wycieczk|spacer|kurs|szkoleni|konferencj|webinar|wyklad|wystawa|ekspozycj|spotkanie autorskie|kino|seans|bazar|giełd|gield|degustacj|mecz towarzyski)/;

const CAT = { Concerts: 3, Festivals: 3, Clubs: 2.5, Comedy: 2, Theatre: 2, Sport: 2, Family: 1, Culture: 0.5, Other: 0 };

export function hotScore(e) {
  const text = fold([e.title, ...(e.artists || []), ...(e.tags || [])].join(' | '));
  const venue = fold(e.venue);
  let s = CAT[e.category] ?? 0;
  if (e.big) s += 3;
  if (STARS.some(x => x.length > 3 ? text.includes(x) : new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text))) s += 6;
  if (VENUES.some(v => venue.includes(v))) s += 3;
  if (TOP_HALLS.some(v => venue.includes(v))) s += 3; // opera i najlepsze filharmonie — kultura wysoka na równi z dużymi koncertami
  if (e.priceFrom >= 150) s += 1;
  if (e.priceFrom >= 300) s += 1.5;
  if (MEH.test(text)) s -= 4;
  // wielomiesięczne wystawy i "trwa do" — mniej pilne
  if (e.end && new Date(e.end) - new Date(e.start) > 7 * 864e5) s -= 2;
  if (!e.image) s -= 1;
  return Math.round(s * 10) / 10;
}
