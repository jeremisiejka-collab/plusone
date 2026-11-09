/* allevents.in — publiczne wydarzenia z miast (w dużej części te same, które kluby, bary i organizatorzy ogłaszają na Facebooku):
   imprezy klubowe, koncerty w barach, stand-upy, jedzenie i drinki, festiwale, sztuka, teatr.
   Lista: allevents.in/<miasto>/<kategoria>?page=N (karta: tytuł, data, adres, plakat, liczba zainteresowanych);
   nazwa miejsca z kalendarza wydarzenia (/api/addtocal.php?type=ical). Facebooka i Instagrama nie pobieramy bezpośrednio
   (wymagają logowania i zabraniają automatów).
   Stron jest dużo, więc każdy przebieg odświeża kolejną część (miasto × kategoria × strona), a wydarzenia z poprzednich
   przebiegów pamiętamy w pipeline/data/allevents.json (znikają po minięciu albo gdy nie widzieliśmy ich od 4 dni). */
import { readFile, writeFile } from 'node:fs/promises';
import { request, sleep } from '../lib/http.mjs';
import { makeEvent, guessCategory } from '../lib/normalize.mjs';

const STORE = new URL('../data/allevents.json', import.meta.url);
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; plusone-events-bot/1.0; +https://plusoneapp.pl)' };
const CITIES = { warsaw: 'Warszawa', krakow: 'Kraków', wroclaw: 'Wrocław', gdansk: 'Gdańsk', poznan: 'Poznań', lodz: 'Łódź', katowice: 'Katowice',
  lublin: 'Lublin', szczecin: 'Szczecin', bydgoszcz: 'Bydgoszcz', torun: 'Toruń', gdynia: 'Gdynia', sopot: 'Sopot', bialystok: 'Białystok', rzeszow: 'Rzeszów' };
const BIG = new Set(['warsaw', 'krakow', 'wroclaw', 'gdansk', 'poznan']);
// kategoria allevents → nasza kategoria i liczba stron (duże miasta / pozostałe)
const CATS = { parties: ['Clubs', 10, 4], music: [null, 6, 3], concerts: ['Concerts', 4, 2], comedy: ['Comedy', 3, 2], 'food-drinks': ['Other', 3, 2],
  festivals: ['Festivals', 2, 1], art: ['Culture', 2, 1], theatre: ['Theatre', 2, 1] };
// nie „wyjścia”: szkolenia, kursy, biznes, rekrutacje, religijne i senioralne — tych nie pokazujemy
const JUNK = /szkoleni|\bkurs|webinar|konferencj|networking|rekrutac|\bpraca\b|career|training|workshop for business|seminar|seminari|biznes|business|\bwarsztat(y)? (dla firm|biznes)|discount group|bal seniora|seniorów|msza|trener|rekolekc|modlitw|egzamin|dzień otwarty|targi pracy|\bonline\b|zoom|masterclass|coaching|inwest|kryptowalut|mlm|nieruchomo/i;
const PER_RUN = 70;          // stron listy na jeden przebieg (co godzinę) — pełny obieg w kilka godzin
const KEEP_DAYS = 4;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/* „Sun, 22 Nov, 2026 - 06:00 PM” → „2026-11-22T18:00” */
function parseDate(s) {
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})(?:\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM))?/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  let h = +(m[4] || 0);
  if (m[6] === 'PM' && h < 12) h += 12;
  if (m[6] === 'AM' && h === 12) h = 0;
  const p = n => String(n).padStart(2, '0');
  return `${m[3]}-${p(MONTHS[m[2].toLowerCase()])}-${p(m[1])}T${p(h)}:${m[5] || '00'}`;
}
const decode = s => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
/* plakat: miniatura z imgproxy ma w ścieżce oryginalny adres zakodowany w base64 (1200 px) */
function poster(style) {
  const m = String(style).match(/url\((https:\/\/cdn-ip\.allevents\.in\/[^)]+)\)/);
  if (!m) return null;
  const b64 = m[1].split('/').pop().replace(/\.[a-z]+$/, '');
  try {
    const u = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (/^https:\/\/cdn-az\.allevents\.in\/\S+$/.test(u) && !/default|placeholder/i.test(u)) return u;
  } catch { /* zostaje miniatura */ }
  return null;
}

function parseList(html) {
  const out = [];
  for (const card of html.split('<li class="event-card').slice(1)) {
    const eid = card.match(/data-eid="(\d+)"/)?.[1];
    const link = card.match(/data-link="([^"]+)"/)?.[1];
    const title = card.match(/<h3>\s*([\s\S]*?)\s*<\/h3>/)?.[1];
    const date = card.match(/<div class="date"[^>]*>\s*([\s\S]*?)\s*<\/div>/)?.[1];
    const loc = card.match(/<div class="location[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/div>/)?.[1];
    const interested = +(card.match(/([\d,]+)\+?\s*Interested/)?.[1] || '0').replace(/,/g, '');
    if (!eid || !link || !title || /MULTIPLE DATES/i.test(date || '')) continue;
    out.push({ eid, link: decode(link), title: decode(title.replace(/<[^>]+>/g, '')), start: parseDate(decode(date || '')), address: decode((loc || '').replace(/<[^>]+>/g, '')),
      image: poster(card.match(/class="banner-cont[^"]*"\s+style="([^"]+)"/)?.[1]), interested });
  }
  return out;
}

/* nazwa miejsca: LOCATION z kalendarza („Smolna 38, Warszawa, ulica Smolna 38, …”) */
async function venueOf(eid) {
  try {
    const ics = await request(`https://allevents.in/api/addtocal.php?event_id=${eid}&type=ical`, { type: 'text', headers: UA, retries: 1, timeout: 15000 });
    const loc = ics.match(/^LOCATION:(.*)$/m)?.[1]?.replace(/\\,/g, ',').trim();
    const end = ics.match(/^DTEND:(\d{8}T\d{4})/m)?.[1];
    return { venue: loc ? loc.split(',')[0].trim() : null, location: loc || null, end: end ? `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T${end.slice(9, 11)}:${end.slice(11, 13)}` : null };
  } catch { return null; }
}

/* plakat ze strony wydarzenia, gdy karta listy go nie ma */
async function pageImage(link) {
  try {
    const html = await request(link, { type: 'text', headers: UA, retries: 1, timeout: 20000 });
    const u = html.match(/<meta property="og:image"\s+content="([^"]+)"/)?.[1];
    return u && /cdn-az\.allevents\.in\/events\d*\/banners\//.test(u) ? decode(u) : null;
  } catch { return null; }
}

/* miasto z adresu, jeśli to inne miasto niż strona listy (allevents dokłada okolice) */
function cityFrom(address, fallback) {
  const a = address.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase();
  // tylko inne znane miasto zmienia miasto strony (dzielnice — Mokotów, Wawer — zostają w mieście strony)
  for (const [k, v] of Object.entries(CITIES)) if (new RegExp(`\\b${k}\\b|\\b${v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase()}\\b`).test(a)) return v;
  return fallback;
}

export default async function allevents() {
  let store = { cursor: 0, events: {} };
  try { store = JSON.parse(await readFile(STORE, 'utf8')); } catch { /* pierwszy przebieg */ }
  const jobs = [];
  for (const [slug, city] of Object.entries(CITIES)) for (const [cat, [, big, small]] of Object.entries(CATS))
    for (let p = 1; p <= (BIG.has(slug) ? big : small); p++) jobs.push([slug, city, cat, p]);
  const today = new Date().toISOString().slice(0, 10), now = Date.now();
  let pages = 0, fresh = 0, fails = 0;
  for (let k = 0; k < Math.min(PER_RUN, jobs.length) && fails < 6; k++) {
    const [slug, city, cat, p] = jobs[(store.cursor + k) % jobs.length];
    let html;
    try { html = await request(`https://allevents.in/${slug}/${cat}${p > 1 ? '?page=' + p : ''}`, { type: 'text', headers: UA, retries: 1, timeout: 20000 }); }
    catch { fails++; await sleep(5000); continue; }
    pages++;
    for (const c of parseList(html)) {
      if (!c.start || c.start.slice(0, 10) < today || JUNK.test(c.title)) continue;
      const prev = store.events[c.eid];
      store.events[c.eid] = { ...prev, ...c, city: cityFrom(c.address, city), cat: prev?.cat && prev.cat !== 'music' ? prev.cat : cat, seen: now };
      if (!prev) fresh++;
    }
    await sleep(700);
  }
  store.cursor = (store.cursor + PER_RUN) % jobs.length;
  if (!pages) throw new Error('allevents.in nie odpowiada');

  // nazwa miejsca dla nowych wydarzeń (kalendarz), z umiarem
  let asked = 0;
  for (const e of Object.values(store.events)) {
    if (e.venue !== undefined || asked >= 400) continue;
    const v = await venueOf(e.eid); asked++;
    e.venue = v?.venue || null; e.location = v?.location || null; e.end = v?.end || null;
    if (!e.image) e.image = await pageImage(e.link);
    await sleep(300);
  }
  // sprzątanie: minione i dawno niewidziane
  for (const [id, e] of Object.entries(store.events)) if (e.start.slice(0, 10) < today || now - e.seen > KEEP_DAYS * 864e5) delete store.events[id];
  await writeFile(STORE, '{"cursor":' + store.cursor + ',"events":{\n' + Object.entries(store.events).sort().map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}}\n');
  console.log(`  allevents: ${pages} stron, nowych ${fresh}, w pamięci ${Object.keys(store.events).length}`);

  return Object.values(store.events).filter(e => e.venue !== undefined && !JUNK.test(e.title)).map(e => {
    const cat = CATS[e.cat]?.[0] || guessCategory(e.title, e.cat);
    // nazwa miejsca bywa samym adresem („ul. Batorego 10”) — wtedy bez nazwy, z adresem
    const venue = e.venue && !/^(ul\.|ulica|al\.|aleja|plac|pl\.)\s|^\d/i.test(e.venue) && e.venue !== e.city ? e.venue : null;
    return makeEvent({
      id: 'allevents-' + e.eid,
      source: 'allevents',
      title: e.title,
      start: e.start,
      end: e.end && e.end.slice(0, 10) !== e.start.slice(0, 10) && Date.parse(e.end) - Date.parse(e.start) < 4 * 864e5 ? e.end : null,
      city: e.city,
      venue,
      address: e.address.replace(/,?\s*Poland$/i, ''),
      category: cat === 'Other' ? guessCategory(e.title) === 'Other' ? 'Other' : guessCategory(e.title) : cat,
      tags: [],
      image: e.image,
      description: e.interested > 20 ? `${e.interested}+ osób zainteresowanych.` : '',
      url: e.link
    });
  });
}
