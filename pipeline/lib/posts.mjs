/* Posty do mediów społecznościowych: codziennie wybieramy najfajniejsze nadchodzące wydarzenia z ładną grafiką
   i zapisujemy public/data/posts.json (post 4:5 i story 9:16 rysuje panel administratora → Posty, z gotowym opisem).
   - rano (pierwszy przebieg dnia): 5 wydarzeń „Na topie” z najbliższych 30 dni, różne kategorie i trasy
   - w ciągu dnia: dochodzą świeżo dodane duże wydarzenia („Nowe w +1”), maks. 8 postów dziennie
   Wydarzenie nie wraca do postów przez 30 dni (pipeline/data/posts-history.json). */
import { readFile, writeFile } from 'node:fs/promises';
import { norm } from './dedup.mjs';
import { imageScore } from './images.mjs';

const OUT = new URL('../../public/data/posts.json', import.meta.url);
const HISTORY = new URL('../data/posts-history.json', import.meta.url);
const DAILY = 5, MAX = 8, DAY = 864e5;

const DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const CAT_TAG = { Concerts: 'koncert', Festivals: 'festiwal', Clubs: 'techno', Theatre: 'teatr', Comedy: 'standup', Culture: 'kultura', Sport: 'sport', Family: 'dladzieci', Other: 'wydarzenia' };
const tag = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

export function when(start) {
  const d = new Date(start.slice(0, 10) + 'T12:00:00Z');
  const t = start.slice(11, 16);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${t && t !== '00:00' ? ', godz. ' + t : ''}`;
}

function caption(e, reason) {
  const city = e.city.split('/')[0];
  const lines = [
    reason === 'new' ? `Nowe w +1: ${e.title}` : e.title,
    '',
    when(e.start).replace(/^./, c => c.toUpperCase()),
    [e.venue, e.city].filter(Boolean).join(', '),
    e.priceFrom > 0 ? `Bilety od ${Math.round(e.priceFrom)} zł` : e.priceFrom === 0 ? 'Wstęp wolny' : '',
    '',
    'Szczegóły i bilety: plusoneapp.pl',
    '',
    ['plusone', 'wydarzenia', tag(city), CAT_TAG[e.category], ...(e.artists || []).slice(0, 2).map(tag).filter(x => x.length > 3)].filter((x, i, a) => x && x.length > 2 && a.indexOf(x) === i).map(x => '#' + x).join(' ')
  ];
  return lines.filter((l, i, a) => l || (a[i - 1] && i < a.length - 1)).join('\n').replace(/\n{3,}/g, '\n\n');
}

/* trasa (ten sam koncert w kilku miastach) = jeden post */
const tourKey = e => norm(e.title).replace(/\b(20\d\d|tour|trasa|warszawa|krakow|gdansk|wroclaw|poznan|lodz|katowice|sopot|gdynia|lublin)\b/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');

export async function buildPosts(events, sizes, { now = new Date() } = {}) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(now);
  let prev = null, history = {};
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* pierwszy raz */ }
  try { history = JSON.parse(await readFile(HISTORY, 'utf8')); } catch { /* pierwszy raz */ }
  for (const [id, d] of Object.entries(history)) if (now - Date.parse(d) > 30 * DAY) delete history[id];

  const byId = new Map(events.map(e => [e.id, e]));
  const sharp = e => {
    const s = sizes.get(e.image);
    return s?.[0] && Math.min(s[0], s[1]) >= 480 && imageScore(s) >= 0.8;
  };
  const from = new Date(now.getTime() + DAY).toISOString().slice(0, 10), to = new Date(now.getTime() + 30 * DAY).toISOString().slice(0, 10);
  const pool = events.filter(e => e.image && sharp(e) && e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to
    && !(e.end && Date.parse(e.end) - Date.parse(e.start) > 4 * DAY) && e.category !== 'Sport' && (!history[e.id] || history[e.id] === today));

  // posty z dzisiaj zostają (te same grafiki do końca dnia), o ile wydarzenie wciąż jest w bazie
  const items = (prev?.date === today ? prev.items : []).filter(p => byId.get(p.id)?.image);   // grafika odrzucona w przeglądzie = post wypada
  const tours = new Set(items.map(p => tourKey(byId.get(p.id))));
  const cats = {};
  for (const p of items) cats[byId.get(p.id).category] = (cats[byId.get(p.id).category] || 0) + 1;
  const take = (e, reason) => {
    const k = tourKey(e);
    if (items.length >= MAX || items.some(p => p.id === e.id) || tours.has(k)) return false;
    tours.add(k); cats[e.category] = (cats[e.category] || 0) + 1; history[e.id] = today;
    items.push({ id: e.id, reason, added: now.toISOString() });
    return true;
  };

  const byHot = [...pool].sort((a, b) => b.hot - a.hot || a.start.localeCompare(b.start));
  if (!items.some(p => p.reason === 'top')) {
    for (const e of byHot) {
      if (items.filter(p => p.reason === 'top').length >= DAILY) break;
      if (e.hot < 6 || (cats[e.category] || 0) >= 2) continue;
      take(e, 'top');
    }
  }
  // świeżo dodane duże wydarzenia — od razu, gdy pojawią się w bazie
  for (const e of byHot) if (e.hot >= 9 && now - Date.parse(e.firstSeen) < DAY && Date.parse(e.firstSeen) > Date.parse('2000-01-02')) take(e, 'new');

  const out = {
    date: today,
    updatedAt: now.toISOString(),
    items: items.map(p => {
      const e = byId.get(p.id);
      return {
        ...p, title: e.title, start: e.start, when: when(e.start), city: e.city, venue: e.venue, category: e.category,
        priceFrom: e.priceFrom, image: e.image, imageRatio: e.imageRatio || null, hot: e.hot,
        link: `https://plusoneapp.pl/?e=${encodeURIComponent(e.id)}&utm_source=instagram`,
        caption: caption(e, p.reason)
      };
    })
  };
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
  await writeFile(HISTORY, JSON.stringify(history, null, 1) + '\n');
  return out;
}
