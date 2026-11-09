/* Sport — oficjalne terminarze lig (mecze z datą, godziną i miejscem):
   - piłka nożna: Ekstraklasa (ekstraklasa.org — dane meczów w kodzie strony Next.js: data, stadion, miasto, adres)
   - siatkówka: PlusLiga (strona terminarza + strona meczu z halą, adresem i miastem; TAURON Liga na razie wyłączona)
   - koszykówka: PGE Polska Liga Koszykówki (plk.pl — terminarz w kodzie strony, hala ze strony drużyny)
   Hale i stadiony gospodarzy pamiętamy w pipeline/data/sport-venues.json, żeby nie pobierać ich przy każdym przebiegu.
   Tylko nadchodzące mecze z najbliższych 8 tygodni. Ligi nie publikują grafik meczów (herby nie są plakatami), więc zdjęciem meczu
   jest prawdziwe zdjęcie stadionu / hali (pipeline/lib/venue-photos.mjs, wspólne dla wszystkich wydarzeń bez grafiki). */
import { readFile, writeFile } from 'node:fs/promises';
import { request, sleep } from '../lib/http.mjs';
import { makeEvent } from '../lib/normalize.mjs';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; plusone-events-bot/1.0; +https://plusoneapp.pl)' };
const DAY = 864e5, HORIZON = 56 * DAY;
const CACHE = new URL('../data/sport-venues.json', import.meta.url);
const page = url => request(url, { type: 'text', headers: UA, retries: 1, timeout: 25000 });
/* dane z kodu strony Next.js (app router): self.__next_f.push([1,"…"]) sklejone w jeden tekst */
function flight(html) {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map(m => { try { return JSON.parse('"' + m[1] + '"'); } catch { return ''; } }).join('');
}
const soon = iso => { const t = Date.parse(iso); return t > Date.now() - 3 * 3600e3 && t < Date.now() + HORIZON; };
const local = (d, t) => `${d}T${t.slice(0, 5)}`;               // „2026-11-14” + „18:00” → „2026-11-14T18:00”
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------- Ekstraklasa ---------- */
function enrichedMatches(fl) {
  const out = [];
  let i = 0;
  while ((i = fl.indexOf('"enrichedMatches":[', i)) >= 0) {
    let j = i + 19, d = 1;
    while (d && j < fl.length) { const c = fl[j]; if (c === '"') { j++; while (j < fl.length && fl[j] !== '"') j += fl[j] === '\\' ? 2 : 1; } else if (c === '[') d++; else if (c === ']') d--; j++; }
    try { out.push(...JSON.parse(fl.slice(i + 18, j))); } catch { /* inny kształt — pomijamy */ }
    i = j;
  }
  return out;
}
async function ekstraklasa() {
  const first = flight(await page('https://www.ekstraklasa.org/terminarz'));
  // bieżący sezon i kolejka z tytułu strony („Terminarz — sezon 2026-2027, kolejka 14”); lista sezonów w kodzie zawiera też stare
  const head = first.match(/Terminarz — sezon (\d{4}-\d{4}), kolejka (\d+)/);
  const season = head?.[1], current = +(head?.[2] || 1);
  const matches = enrichedMatches(first);
  for (let r = current + 1; r <= current + 8 && season; r++) {
    try { matches.push(...enrichedMatches(flight(await page(`https://www.ekstraklasa.org/terminarz/${season}/kolejka-${r}`)))); } catch { /* kolejka jeszcze nieopublikowana */ }
    await sleep(600);
  }
  const seen = new Set();
  return matches.filter(m => m && m.matchId && !seen.has(m.matchId) && seen.add(m.matchId) && m.status !== 'played' && !m.postponed
    && m.matchDatetime && soon(m.matchDatetime) && m.localTime).map(m => makeEvent({
    id: 'sport-ekstraklasa-' + m.matchId,
    source: 'sport',
    title: `${m.homeTeam.name} – ${m.awayTeam.name}`,
    start: local(m.date, m.localTime),
    city: m.venue?.city,
    venue: m.venue?.name,
    address: m.venue?.address?.replace(/, Poland$/, ''),
    category: 'Sport',
    tags: ['Piłka nożna', 'Ekstraklasa', m.week ? `${m.week}. kolejka` : ''],
    description: `Ekstraklasa${m.week ? ', ' + m.week + '. kolejka' : ''}: ${m.homeTeam.name} podejmuje ${m.awayTeam.name}${m.venue?.name ? ' na stadionie ' + m.venue.name : ''}.`,
    url: `https://www.ekstraklasa.org/terminarz/${season}/kolejka-${m.week || current}`
  }));
}

/* ---------- siatkówka: PlusLiga i TAURON Liga ---------- */
async function volley(host, league, venues) {
  const html = await page(`https://www.${host}/games.html`);
  const games = [...html.matchAll(/data-game-id="(\d+)"[\s\S]*?<div class="game-date">[\s\S]*?<span>(\d{2})\.(\d{2})\.(\d{4}), (\d{2}:\d{2})<\/span>[\s\S]*?game-team left[^>]*>\s*([^<]+?)\s*<\/div>[\s\S]*?game-team right[^>]*>\s*([^<]+?)\s*<\/div>/g)]
    .map(m => ({ id: m[1], start: `${m[4]}-${m[3]}-${m[2]}T${m[5]}`, home: m[6].trim(), away: m[7].trim() }))
    .filter(g => soon(g.start + ':00+01:00'));
  const out = [];
  for (const g of games) {
    const key = league + '|' + g.home;
    if (!venues[key]) {
      try {
        const d = await page(`https://www.${host}/games/action/show/id/${g.id}.html`);
        const cell = l => d.match(new RegExp(`<th>${l}:</th><td>([^<]+)</td>`))?.[1]?.trim();
        // „Miasto” bywa wpisane z kodem i ulicą („42-200 Częstochowa ul. Żużlowa 4”) — zostawiamy samo miasto
        const city = (cell('Miasto') || '').replace(/^\d{2}-\d{3}\s*/, '').replace(/\s+(ul\.?|al\.?|os\.?)\s.*$/i, '').trim();
        if (cell('Nazwa') && city) venues[key] = { venue: cell('Nazwa'), address: cell('Adres'), city };
      } catch { /* bez hali — pominiemy mecz */ }
      await sleep(500);
    }
    const v = venues[key];
    if (!v?.city) continue;
    out.push(makeEvent({
      id: `sport-${slug(league)}-${g.id}`,
      source: 'sport',
      title: `${g.home} – ${g.away}`,
      start: g.start,
      city: v.city, venue: v.venue, address: [v.address, v.city].filter(Boolean).join(', '),
      category: 'Sport',
      tags: ['Siatkówka', league],
      description: `${league}: ${g.home} podejmuje ${g.away}${v.venue ? ' w hali ' + v.venue : ''}.`,
      url: `https://www.${host}/games/action/show/id/${g.id}.html`
    }));
  }
  return out;
}

/* ---------- koszykówka: PGE PLK ---------- */
async function plk(venues) {
  const fl = flight(await page('https://plk.pl/terminarz'));
  const games = [];
  for (const m of fl.matchAll(/\{"id":"(\d+)","seasonId":"\d+","league":\{[^}]*\},"round":\{[^}]*\},(?:"queue":\{[^}]*\},)?"gameNo":"[^"]*","slug":"([^"]+)","homeTeamName":"([^"]+)","guestTeamName":"([^"]+)","isFinished":(true|false),"date":"[^"]+","dateLocal":"(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})"[\s\S]*?"homeTeam":\{"id":(\d+),[^}]*"slug":"([^"]+)"/g)) {
    if (m[5] === 'true') continue;
    const start = `${m[6]}T${m[7]}`;
    if (soon(start + ':00+01:00')) games.push({ id: m[1], slug: m[2], home: m[3], away: m[4], start, teamId: m[8], teamSlug: m[9] });
  }
  const out = [], seen = new Set();
  for (const g of games) {
    if (seen.has(g.id)) continue; seen.add(g.id);
    const key = 'PLK|' + g.teamId;
    if (!venues[key]) {
      try {
        const t = flight(await page(`https://plk.pl/druzyny/${g.teamId}/${g.teamSlug}`));
        const a = t.match(/"children":"Arena"\}\],\["\$","p",null,\{[^{]*"children":\[\["\$","strong",null,\{"children":\["([^"]+)",","\]\}\],\["\$","br",null,\{\}\],"([^"]*)"," ","([^"]+)",", ","([^"]+)"\]/);
        if (a) venues[key] = { venue: a[1], city: a[3], address: `${a[4]}, ${a[2]} ${a[3]}` };
      } catch { /* bez hali — pominiemy mecz */ }
      await sleep(500);
    }
    const v = venues[key];
    if (!v?.city) continue;
    out.push(makeEvent({
      id: 'sport-plk-' + g.id,
      source: 'sport',
      title: `${g.home} – ${g.away}`,
      start: g.start,
      city: v.city, venue: v.venue, address: v.address,
      category: 'Sport',
      tags: ['Koszykówka', 'PGE PLK'],
      description: `PGE Polska Liga Koszykówki: ${g.home} podejmuje ${g.away}${v.venue ? ' w hali ' + v.venue : ''}.`,
      url: `https://plk.pl/mecz/${g.id}/${g.slug}`
    }));
  }
  return out;
}

export default async function sport() {
  let venues = {};
  try { venues = JSON.parse(await readFile(CACHE, 'utf8')); } catch { /* pierwszy przebieg */ }
  const out = [], errors = [];
  for (const [name, fn] of [['Ekstraklasa', () => ekstraklasa()], ['PlusLiga', () => volley('plusliga.pl', 'PlusLiga', venues)],
    // TAURON Liga (kobiety): tauronliga.pl bez ciasteczek serwuje terminarz PlusLigi — wyłączone, żeby nie dublować meczów
    ['PLK', () => plk(venues)]]) {
    try { const l = await fn(); out.push(...l); console.log(`  sport ${name}: ${l.length}`); }
    catch (e) { errors.push(name + ': ' + e.message); console.warn(`  sport ${name}: ${e.message}`); }
  }
  await writeFile(CACHE, JSON.stringify(venues, null, 1));
  if (!out.length && errors.length) throw new Error(errors.join('; '));
  return out;
}
