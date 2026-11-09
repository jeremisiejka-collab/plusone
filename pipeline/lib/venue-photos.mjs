/* Zdjęcia obiektów (stadiony, hale, kluby, teatry) dla wydarzeń bez własnej grafiki — mecze ligowe, koncerty bez plakatu.
   Nie ukrywamy wydarzeń i nie rysujemy zastępczych grafik: wydarzenie bez zdjęcia dostaje prawdziwe zdjęcie miejsca.
   Kolejność szukania: zapisane (pipeline/data/venue-photos.json, sprawdzone ręcznie) → artykuł Wikipedii o obiekcie →
   plik w Wikimedia Commons o tej nazwie → zdjęcie miasta. Pliki zapisujemy u siebie (public/img/obiekty/), autor i licencja
   (wymaga ich CC BY / CC BY-SA) trafiają do opisu wydarzenia. Wpisy znalezione automatycznie mają pole "auto". */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const FILE = new URL('../data/venue-photos.json', import.meta.url);
const DIR = new URL('../../public/img/obiekty/', import.meta.url);
const SITE = 'https://plusoneapp.pl/img/obiekty/';
const H = { 'User-Agent': 'plusone-events-bot/1.0 (https://plusoneapp.pl)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const slug = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
// słowa, które nie wyróżniają obiektu (każda hala jest „halą”)
const GENERIC = new Set(['hala', 'stadion', 'arena', 'miejski', 'miejska', 'im', 'imienia', 'sportowa', 'sportowo', 'widowiskowa', 'widowiskowo', 'sportowe',
  'centrum', 'mosir', 'hws', 'hsw', 'hs', 'osir', 'klub', 'sala', 'scena', 'teatr', 'w', 'we', 'na', 'i', 'the', 'club', 'pilkarski', 'park', 'dom', 'kultury', 'ul', 'al']);
const BAD_FILE = /\.(svg|gif|webm|ogv|tiff?|pdf)$|logo|herb|crest|emblem|coat[_ ]of|flag|map|mapa|plan|location|signature|podpis|icon|ikona/i;
const words = s => fold(s).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !GENERIC.has(w));

let BUDGET = 0, STOP = false;
async function api(host, params) {
  if (STOP || BUDGET-- <= 0) return null;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(`https://${host}/w/api.php?` + new URLSearchParams({ format: 'json', ...params }), { headers: H, signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { await sleep(15000 * (t + 1)); continue; }
      return await r.json();
    } catch { await sleep(3000); }
  }
  STOP = true;   // Wikimedia nas spowalnia — dokończymy w następnym przebiegu
  return null;
}

/* artykuł Wikipedii o obiekcie: tytuł musi mieć wyróżniające słowo z nazwy obiektu (nie sam „Stadion” / nazwa miasta) */
async function fromWikipedia(venue, city) {
  const need = words(venue);
  if (!need.length) return null;
  const d = await api('pl.wikipedia.org', { action: 'query', generator: 'search', gsrsearch: `${venue} ${city}`, gsrlimit: '6', prop: 'pageimages', piprop: 'name' });
  const pages = Object.values(d?.query?.pages || {}).sort((a, b) => a.index - b.index);
  for (const p of pages) {
    const t = words(p.title).filter(w => !words(city).includes(w));
    if (p.pageimage && !BAD_FILE.test(p.pageimage) && need.some(w => t.includes(w))) return p.pageimage;
  }
  return null;
}
/* plik w Commons, którego nazwa zawiera wyróżniające słowo z nazwy obiektu */
async function fromCommons(venue, city) {
  const need = words(venue);
  if (!need.length) return null;
  const d = await api('commons.wikimedia.org', { action: 'query', list: 'search', srsearch: `${venue} ${city} filetype:bitmap`, srnamespace: '6', srlimit: '8' });
  for (const x of d?.query?.search || []) {
    const name = x.title.replace(/^File:/, '');
    if (!BAD_FILE.test(name) && need.some(w => words(name).includes(w))) return name;
  }
  return null;
}
async function fromCity(city) {
  const d = await api('pl.wikipedia.org', { action: 'query', titles: city.split('/')[0], redirects: '1', prop: 'pageimages', piprop: 'name' });
  const p = Object.values(d?.query?.pages || {})[0];
  return p?.pageimage && !BAD_FILE.test(p.pageimage) ? p.pageimage : null;
}

/* pobiera plik (miniatura 1280 px) i dane autora */
async function download(file, name) {
  const d = await api('commons.wikimedia.org', { action: 'query', titles: 'File:' + file, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '1280' });
  const ii = Object.values(d?.query?.pages || {})[0]?.imageinfo?.[0];
  if (!ii?.thumburl || !ii.thumbwidth) return null;
  for (let t = 0; t < 3; t++) {
    const r = await fetch(ii.thumburl, { headers: H, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (r?.ok && (r.headers.get('content-type') || '').startsWith('image/')) {
      const ext = (r.headers.get('content-type').split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      await mkdir(DIR, { recursive: true });
      await writeFile(new URL(name + '.' + ext, DIR), Buffer.from(await r.arrayBuffer()));
      const m = ii.extmetadata || {};
      return { image: SITE + name + '.' + ext, ratio: +(ii.thumbwidth / ii.thumbheight).toFixed(3), author: strip(m.Artist?.value).slice(0, 80) || 'autor nieznany',
        license: strip(m.LicenseShortName?.value) || 'licencja wolna', source: ii.descriptionurl };
    }
    await sleep(15000 * (t + 1));
  }
  return null;
}

/* uzupełnia zdjęcie miejsca w wydarzeniach bez grafiki; maxLookups — ile nowych obiektów szukamy w jednym przebiegu */
export async function addVenuePhotos(events, { maxLookups = 60 } = {}) {
  let photos = {};
  try { photos = JSON.parse(await readFile(FILE, 'utf8')); } catch { /* pierwszy raz */ }
  const key = e => `${e.venue || e.city}|${e.city}`;
  const todo = [...new Set(events.filter(e => !e.image && !photos[key(e)]).map(key))];
  BUDGET = maxLookups * 4; STOP = false;
  let found = 0;
  for (const k of todo.slice(0, maxLookups)) {
    if (STOP) break;
    const [venue, city] = k.split('|');
    const real = venue && fold(venue) !== fold(city) && !/^tba\b|^tbc\b|^online$/i.test(venue);
    let file = real && (await fromWikipedia(venue, city) || await fromCommons(venue, city)), kind = 'venue';
    if (!file) { file = await fromCity(city); kind = 'city'; }
    const p = file && await download(file, slug(k));
    if (p) { photos[k] = { ...p, auto: kind }; found++; }
    await sleep(1200);
  }
  let used = 0;
  for (const e of events) {
    const p = !e.image && photos[key(e)];
    if (!p) continue;
    e.image = p.image; e.imageRatio = p.ratio; used++;
    const credit = `Zdjęcie ${p.auto === 'city' ? 'miasta' : 'obiektu'}: ${p.author}, ${p.license}, Wikimedia Commons.`;
    if (!e.description?.includes('Wikimedia Commons')) e.description = [e.description, credit].filter(Boolean).join(' ');
  }
  await writeFile(FILE, JSON.stringify(Object.fromEntries(Object.entries(photos).sort()), null, 1) + '\n');
  return { found, used, missing: events.filter(e => !e.image).length, pending: todo.length - found };
}
