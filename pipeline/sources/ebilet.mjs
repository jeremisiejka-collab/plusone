/* eBilet — strony miast (/miasto/<slug>) mają listy wydarzeń w danych serwera
   (serverApp-state) oraz w schema.org JSON-LD. Bierzemy oba i łączymy po adresie. */
import { request, sleep } from '../lib/http.mjs';
import { localTime, guessCategory, makeEvent } from '../lib/normalize.mjs';

const CITIES = ['warszawa', 'krakow', 'trojmiasto', 'wroclaw', 'poznan', 'lodz', 'slaskie', 'szczecin', 'lublin', 'bialystok', 'bydgoszcz', 'torun', 'rzeszow',
  'olsztyn', 'kielce', 'opole', 'zielona-gora', 'gorzow-wielkopolski', 'radom', 'czestochowa'];
/* ogólnopolskie strony kategorii — tu są duże koncerty i festiwale spoza list miast */
const CATEGORY_PAGES = ['muzyka', 'festiwale', 'muzyka/festiwale', 'muzyka/rock', 'muzyka/pop', 'muzyka/piosenka', 'muzyka/hip-hop-rap',
  'muzyka/hard-heavy', 'muzyka/elektro-techno', 'muzyka/jazz-blues', 'muzyka/disco-polo', 'muzyka/k-pop', 'muzyka/reggae', 'muzyka/pozostale',
  // więcej niż muzyka: spektakle i wydarzenia dla dzieci, teatr, kabaret, stand-up, klasyka, sport (strony nieistniejące tylko ostrzegają)
  'rodzina', 'teatr', 'kabaret', 'stand-up', 'klasyka', 'sport', 'wystawy', 'inne'];
const PAGES = [...CITIES.map(c => 'miasto/' + c), ...CATEGORY_PAGES];

const CAT = {
  muzyka: null, // doprecyzowane po podkategorii
  teatr: 'Theatre', kabaret: 'Comedy', 'stand-up': 'Comedy', sport: 'Sport', rodzina: 'Family',
  festiwale: 'Festivals', festiwal: 'Festivals', klasyka: 'Concerts', inne: 'Culture', wystawy: 'Culture'
};

function category(t) {
  const c = CAT[t.category];
  if (c) return c;
  const g = guessCategory(t.category, t.subcategory, t.subcategoryName, t.title);
  return t.category === 'muzyka' && !['Clubs', 'Festivals'].includes(g) ? 'Concerts' : g;
}

function fromState(html) {
  const m = html.match(/<script id="serverApp-state" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  const state = JSON.parse(m[1]);
  const titles = [];
  for (const v of Object.values(state)) {
    const b = v && v.b;
    const list = Array.isArray(b) ? b : b && Array.isArray(b.titles) ? b.titles : null;
    if (list) titles.push(...list.filter(t => t && t.title && t.slug && t.dateFrom));
  }
  return titles;
}

function fromJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let d;
    try { d = JSON.parse(m[1]); } catch { continue; }
    for (const list of [d].flat()) {
      for (const li of list.itemListElement || []) if (li.item?.['@type'] === 'Event') out.push(li.item);
    }
  }
  return out;
}

export default async function ebilet() {
  const byUrl = new Map();
  // eBilet wpuszcza kilkadziesiąt zapytań na raz, potem odpowiada 429. Przebieg jest co godzinę:
  // strony miast i kategorii co 6 godzin (na początku, póki limit jest świeży), w pozostałych tylko pełne trasy z API.
  const pagesNow = process.env.EBILET_PAGES === '1' || new Date().getUTCHours() % 6 === 5;
  for (const slug of pagesNow ? PAGES : []) {
    if (BLOCKED) break;
    let html;
    try {
      html = await request(`https://www.ebilet.pl/${slug}`, { type: 'text', retries: 0 });
    } catch (e) {
      console.warn(`  ebilet ${slug}: ${e.message}`);
      if (/HTTP 429/.test(e.message)) BLOCKED = true;
      continue;
    }
    const ld = new Map(fromJsonLd(html).map(e => [e.url, e]));

    for (const t of fromState(html)) {
      rememberTitle(t);
      const p = t.nextEventPlace || {};
      const url = t.linkTo || `https://www.ebilet.pl/${t.category}/${t.subcategory}/${t.slug}`;
      if (!t.category || !t.subcategory || byUrl.has(url)) continue;
      const one = localTime(t.dateFrom) === localTime(t.dateTo);
      byUrl.set(url, makeEvent({
        id: 'ebilet-' + t.id,
        source: 'ebilet',
        title: t.title,
        start: localTime(t.dateFrom),
        end: one ? null : localTime(t.dateTo),
        city: p.city || t.place,
        venue: p.customName,
        address: [p.street, p.postalCode, p.city].filter(Boolean).join(', '),
        category: category(t),
        tags: [t.subcategoryName].filter(Boolean),
        artists: t.artists,
        priceFrom: null,
        // plakat (pion) zamiast poziomego baneru — w aplikacji karty są pionowe
        image: t.imagePortrait || t.imageLandscape,
        description: t.metaDescription,
        url
      }));
    }

    for (const [url, e] of ld) {
      if (byUrl.has(url)) continue;
      const a = e.location?.address || {};
      byUrl.set(url, makeEvent({
        id: 'ebilet-' + url.split('/').pop().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '-'),
        source: 'ebilet',
        title: e.name,
        start: localTime(e.startDate),
        end: localTime(e.endDate) !== localTime(e.startDate) ? localTime(e.endDate) : null,
        city: a.addressLocality,
        venue: e.location?.name !== a.addressLocality ? e.location?.name : null,
        address: [a.streetAddress, a.postalCode, a.addressLocality].filter(Boolean).join(', '),
        category: guessCategory(url.split('/').slice(3, 5), e.name),
        image: [e.image].flat()[0],
        description: e.description,
        url
      }));
    }
    await sleep(1200);
  }
  const full = await fullCatalog();
  // strony odmówiły (limit zapytań) albo nie było ich w tym przebiegu: zostają wpisy ze stron z poprzedniego przebiegu, dopóki są w przyszłości
  const today = new Date().toISOString().slice(0, 10), have = new Set([...byUrl.values()].map(e => e.id));
  for (const e of full.previous) if (!e.id.startsWith('ebilet-e') && !have.has(e.id) && (e.end || e.start).slice(0, 10) >= today) byUrl.set((e.links?.[0]?.url || e.id) + '#prev', e);
  // pełne trasy i sale: każdy termin każdego tytułu (także w mniejszych miastach) zamiast tylko najbliższego
  if (full.events.length) {
    // tytuły pobrane w całości zastępują swój jeden „najbliższy termin” ze stron miast
    for (const [url, e] of byUrl) if (full.titleIds.has(e.id.slice(7))) byUrl.delete(url);
    for (const e of full.events) byUrl.set(e.links[0].url + '#' + e.id, e);
  }
  console.log(`  ebilet: ${TITLES.size} tytułów, ${full.places} sal, ${full.events.length} terminów z pełnych tras (API: ${STAT.ok} odpowiedzi, ${STAT.limited} odmów 429)`);
  return [...byUrl.values()];
}

/* kiedy ostatnio pobrano dany tytuł w całości (pipeline/data/ebilet-titles.json) i poprzednie terminy z public/data/events.json */
import { readFile, writeFile } from 'node:fs/promises';
const HERE = new URL('.', import.meta.url);
const TIMES = new URL('../data/ebilet-titles.json', HERE), EVENTS_JSON = new URL('../../public/data/events.json', HERE);
async function prevTitles() {
  let at = new Map(), events = [];
  try { at = new Map(Object.entries(JSON.parse(await readFile(TIMES, 'utf8')))); } catch {}
  let all = [];
  try { all = JSON.parse(await readFile(EVENTS_JSON, 'utf8')).events.filter(e => e.id.startsWith('ebilet-')); events = all.filter(e => e.id.startsWith('ebilet-e')); } catch {}
  return { at, events, all };
}
async function saveTitleTimes(at, refreshed) {
  const now = Date.now();
  for (const id of refreshed) at.set(id, now);
  // zapominamy tytuły niewidziane od 30 dni
  for (const [id, t] of at) if (now - t > 30 * 864e5) at.delete(id);
  await writeFile(TIMES, JSON.stringify(Object.fromEntries(at)));
}

/* ---------- pełny katalog: sale w miastach + wszystkie terminy tytułów ----------
   /api/Home/Cities → /api/LandingPageLocation/<miasto> (grupy: tytuły, wydarzenia, miejsca)
   /api/Places/<slug> → id → /api/Places/<id>/events?size=300 (wszystkie wydarzenia sali)
   /api/titlePage/<id>/events (wszystkie terminy tytułu we wszystkich miastach) */
const API = 'https://www.ebilet.pl/api';
const TITLES = new Map();          // id -> { category, subcategory, slug, title, image, artists, subcategoryName, description }
function rememberTitle(t) {
  const id = String(t.id || t.titleId || '');
  if (!id || TITLES.has(id) && TITLES.get(id).slug) return;
  const category = t.category || t.categorySlug, subcategory = t.subcategory || t.subcategorySlug, slug = t.slug || t.titleSlug;
  TITLES.set(id, { category, subcategory, slug, title: t.titleTitle || t.title, image: t.imagePortrait || t.imageLandscape,
    artists: t.artists || [], subcategoryName: t.subcategoryName, description: t.metaDescription });
}
/* zapytania z umiarem; przy pierwszej odmowie 429 (za dużo zapytań) kończymy pobieranie w tym przebiegu.
   Pełny katalog nie musi zmieścić się w jednym przebiegu — kolejne (co godzinę) dociągają tytuły odświeżane najdawniej. */
let T0 = Date.now(), BLOCKED = false;
const STAT = { ok: 0, limited: 0 };
const BUDGET = 10 * 60e3;
async function pool(items, n, fn, until = T0 + BUDGET, pause = 1500) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length && !BLOCKED && Date.now() < Math.min(until, T0 + BUDGET)) {
      const k = i++;
      try { out[k] = await fn(items[k]); STAT.ok++; }
      catch (e) { out[k] = null; if (/HTTP 429/.test(e.message)) { STAT.limited++; BLOCKED = true; } }
      await sleep(pause);
    }
  }));
  return out;
}
function fromApiEvent(e, t) {
  const cat = t.category, sub = t.subcategory, slug = t.slug;
  if (!cat || !sub || !slug || e.isCancelled) return null;
  const one = !e.endDate || localTime(e.endDate) === localTime(e.date) || Date.parse(e.endDate) - Date.parse(e.date) < 18 * 3600e3;
  return makeEvent({
    id: `ebilet-e${e.titleId}-${e.id}`,
    source: 'ebilet',
    title: e.titleTitle || t.title || e.title,
    start: localTime(e.date),
    end: one ? null : localTime(e.endDate),
    city: e.city,
    venue: e.placeName,
    address: [e.street, e.postalCode, e.city].filter(Boolean).join(', '),
    category: category({ category: cat, subcategory: sub, title: t.title }),
    tags: [t.subcategoryName].filter(Boolean),
    artists: e.artists || t.artists,
    priceFrom: e.freeSeats?.minPrice ?? null,
    image: e.imagePortrait || t.image || e.imageLandscape,
    description: t.description,
    url: `https://www.ebilet.pl/${cat}/${sub}/${slug}`
  });
}
/* tytuł grany w jednym miejscu więcej niż SERIES razy (wystawa, muzeum, cykl koncertów co godzinę) → jeden wpis od pierwszego do ostatniego terminu */
const SERIES = 12;
function collapseSeries(events) {
  const groups = new Map();
  for (const e of events) {
    const k = (e.id.match(/^ebilet-e(\d+)-/)?.[1] || e.id) + '|' + (e.venue || '') + '|' + (e.city || '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length <= SERIES) { out.push(...list); continue; }
    list.sort((a, b) => a.start.localeCompare(b.start));
    const first = list[0], end = list.map(e => e.end || e.start).sort().pop(), prices = list.map(e => e.priceFrom).filter(p => p != null);
    const priceFrom = prices.length ? Math.min(...prices) : null;
    out.push({ ...first, id: first.id.replace(/^(ebilet-e\d+-)c?/, '$1c'), end, priceFrom, links: first.links.map(l => ({ ...l, price: priceFrom })) });
  }
  return out;
}
/* tytuły znane z poprzedniego przebiegu (adres eBilet = kategoria/podkategoria/slug) */
function seedFromEvents(events) {
  for (const e of events) {
    const m = e.id.match(/^ebilet-(?:e(\d+)-|(\d+)$)/), id = m && (m[1] || m[2]), u = (e.links?.[0]?.url || '').match(/ebilet\.pl\/([^/]+)\/([^/]+)\/([^/?#]+)/);
    if (id && u && !TITLES.has(id)) TITLES.set(id, { category: u[1], subcategory: u[2], slug: u[3], title: e.title, image: e.image, artists: e.artists || [], description: e.description });
  }
}
async function fullCatalog() {
  const get = u => request(API + u, { retries: 0, timeout: 20000 });
  T0 = Date.now();
  const last = await prevTitles();
  seedFromEvents(last.all);
  const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
  // 1) najpierw terminy tytułów, których nie odświeżaliśmy najdłużej (kolejne przebiegi dociągają resztę)
  const titleIds = [...TITLES.keys()].filter(id => TITLES.get(id).slug).sort((a, b) => (last.at.get(a) || 0) - (last.at.get(b) || 0));
  const res = await pool(titleIds, 1, id => get(`/titlePage/${id}/events`), T0 + 6 * 60e3);
  // 2) odkrywanie nowych sal i tytułów w miastach (losowa kolejność, kolejne przebiegi pokrywają resztę)
  const cities = shuffle(((await pool(['/Home/Cities'], 1, get))[0] || []).map(c => c.slug).filter(Boolean));
  const placeSlugs = new Set();
  await pool(cities, 1, async c => {
    const lp = await get('/LandingPageLocation/' + encodeURIComponent(c));
    for (const s of lp.sections || []) for (const g of s.productSectionInfo?.groups || []) {
      if (g.type === 4) for (const p of await get(`/LandingPage/group/${g.id}/place`).catch(() => [])) placeSlugs.add(p.slug);
      if (g.type === 1) for (const t of await get(`/LandingPage/group/${g.id}/title`).then(r => r.titles || r).catch(() => [])) if (t && t.id) rememberTitle(t);
    }
  }, T0 + 7.5 * 60e3);
  // największe sale w kraju (areny, hale) — z pierwszej znanej sali
  const any = [...placeSlugs][0];
  if (any) { const p = await get('/Places/' + any).catch(() => null); if (p) for (const x of await get(`/Places/${p.id}/popular-places`).catch(() => [])) placeSlugs.add(x.slug); }
  // 3) sale → ich wszystkie wydarzenia
  const placeEvents = (await pool(shuffle([...placeSlugs]), 1, async slug => {
    const p = await get('/Places/' + encodeURIComponent(slug));
    return get(`/Places/${p.id}/events?size=300`);
  }, T0 + 9 * 60e3)).flat().filter(Boolean);
  for (const e of placeEvents) rememberTitle({ ...e, id: e.titleId });
  const done = new Set(), events = [];
  res.forEach((r, k) => {
    if (!r) return;
    done.add(titleIds[k]);
    for (const g of r.groups || []) for (const e of g.events || []) { const ev = fromApiEvent(e, TITLES.get(titleIds[k])); if (ev) events.push(ev); }
  });
  // wydarzenia sal, których tytułu nie udało się pobrać w całości
  for (const e of placeEvents) if (!done.has(String(e.titleId))) { const ev = fromApiEvent(e, TITLES.get(String(e.titleId)) || {}); if (ev) events.push(ev); }
  // tytuły nieodświeżone w tym przebiegu: zostają ich terminy z poprzedniego (dopóki są w przyszłości)
  const today = new Date().toISOString().slice(0, 10);
  const fresh = new Set(done);
  for (const e of last.events) { const tid = e.id.match(/^ebilet-e(\d+)-/)?.[1]; if (tid && !fresh.has(tid) && (e.end || e.start).slice(0, 10) >= today) { events.push(e); done.add(tid); } }
  // jeden termin = jeden wpis; wystawy i pokazy z biletami na godziny (dziesiątki terminów w jednym miejscu) = jeden wpis „od–do”
  const uniq = collapseSeries([...new Map(events.map(e => [e.id, e])).values()]);
  await saveTitleTimes(last.at, [...done].filter(id => res[titleIds.indexOf(id)]));
  return { events: uniq, titleIds: done, places: placeSlugs.size, previous: last.all };
}
