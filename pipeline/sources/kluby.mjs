/* Strony klubów i miejsc — pełne programy prosto u źródła (serwisy biletowe mają tylko część wydarzeń).
   - SEKTOR 6D (Warszawa): własny czytnik strony (Webflow),
   - Progresja, Stodoła (Warszawa): wspólny czytnik stron z danymi schema.org/Event (SITES niżej) — nowy klub z takimi
     danymi = jeden wpis w SITES. Strony wydarzeń pamiętamy w pipeline/data/kluby.json i odświeżamy co 3 dni. */
import { readFile, writeFile } from 'node:fs/promises';
import { request, sleep } from '../lib/http.mjs';
import { makeEvent, localTime, guessCategory } from '../lib/normalize.mjs';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; plusone-events-bot/1.0; +https://plusoneapp.pl)' };
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const fold = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase().trim();
/* miasto: znana nazwa w miejscu/adresie, inaczej po kodzie pocztowym (Atlas Arena ma w adresie „Aleksandrówka”, 94-020 = Łódź) */
const CITIES = ['Warszawa', 'Kraków', 'Wrocław', 'Gdańsk', 'Gdynia', 'Sopot', 'Poznań', 'Łódź', 'Katowice', 'Lublin', 'Szczecin', 'Bydgoszcz', 'Toruń', 'Białystok', 'Rzeszów',
  'Kielce', 'Olsztyn', 'Opole', 'Gliwice', 'Zabrze', 'Bielsko-Biała', 'Częstochowa', 'Radom', 'Kazimierz Dolny', 'Zielona Góra', 'Gorzów Wielkopolski', 'Płock', 'Elbląg'];
const POSTAL = [[0, 4, 'Warszawa'], [30, 31, 'Kraków'], [50, 54, 'Wrocław'], [80, 80, 'Gdańsk'], [81, 81, 'Gdynia'], [60, 61, 'Poznań'], [90, 94, 'Łódź'], [40, 40, 'Katowice'], [20, 20, 'Lublin'], [70, 71, 'Szczecin']];
function cityOf(text) {
  const t = fold(text);
  const known = CITIES.find(c => new RegExp(`(^|[^a-z])${fold(c)}([^a-z]|$)`).test(t));
  if (known) return known;
  const pc = String(text).match(/\b(\d{2})-\d{3}\b/);
  return pc ? POSTAL.find(([a, b]) => +pc[1] >= a && +pc[1] <= b)?.[2] || null : null;
}
const p2 = n => String(n).padStart(2, '0');
const text = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/‍/g, '').replace(/\s+/g, ' ').trim();

/* „November 27, 2026” + „9:00 pm” → „2026-11-27T21:00” */
function when(date, time) {
  const d = String(date).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!d || !MONTHS[d[1].toLowerCase()]) return null;
  const t = String(time || '').match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  let h = t ? +t[1] : 0;
  if (t?.[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
  if (t?.[3]?.toLowerCase() === 'am' && h === 12) h = 0;
  return `${d[3]}-${p2(MONTHS[d[1].toLowerCase()])}-${p2(d[2])}T${p2(h)}:${t ? t[2] : '00'}`;
}

async function sektor6d() {
  const base = 'https://www.sektor6d.pl';
  const list = await request(base + '/events', { type: 'text', headers: UA, retries: 2 });
  const links = [...new Set(list.match(/href="\/events\/[a-z0-9-]+"/g) || [])].map(h => h.slice(6, -1));
  const out = [];
  for (const path of links) {
    try {
      const h = await request(base + path, { type: 'text', headers: UA, retries: 1 });
      const title = text(h.match(/<title>([^<|]+)/)?.[1]);
      const body = text(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ''));
      const date = body.match(/[A-Z][a-z]+ \d{1,2}, \d{4}/)?.[0];
      const times = body.match(/\d{1,2}:\d{2}\s*(?:am|pm)/gi) || [];
      // line-up: teksty między „Line up” a „Info” (każdy wykonawca w osobnym elemencie)
      const block = h.split(/>\s*Line up\s*</i)[1]?.split(/>\s*Info\s*</i)[0] || '';
      const artists = [...block.matchAll(/>([^<>]{2,60})</g)].map(m => text(m[1])).filter(a => a && a.length > 1).slice(0, 15);
      const desc = body.match(/Description (.*?) (?:BUY YOUR TICKETS|Tickets Home|Tickets \| )/)?.[1] || '';
      const img = [...h.matchAll(/src="(https:\/\/cdn\.prod\.website-files\.com\/[^"]+\.(?:avif|webp|jpe?g|png))"/g)].map(m => m[1]).find(u => !/icons8|Group%20|Frame%20|logo|openg/i.test(u));
      const start = when(date, times[0]), endT = times[1] ? when(date, times[1]) : null;
      if (!title || !start) continue;
      out.push(makeEvent({
        id: 'sektor6d-' + path.split('/').pop(),
        source: 'kluby',
        title,
        start,
        // koniec nad ranem następnego dnia
        end: endT && endT <= start ? new Date(Date.parse(endT + ':00Z') + 864e5).toISOString().slice(0, 16) : endT,
        city: 'Warszawa',
        venue: 'Sektor 6D',
        address: 'ul. Modlińska 6D, 03-216 Warszawa',
        category: 'Clubs',
        tags: ['Techno', 'Elektronika'],
        artists,
        image: img || null,
        description: desc,
        url: base + path
      }));
    } catch { /* jedno wydarzenie nie blokuje reszty */ }
    await sleep(500);
  }
  return out;
}

/* kluby ze schema.org/Event na stronie wydarzenia */
const SITES = [
  { name: 'Progresja', list: ['https://progresja.com/wydarzenia/'], link: /https:\/\/progresja\.com\/wydarzenie\/[a-z0-9-]+\//g,
    venue: 'Progresja', city: 'Warszawa', address: 'Fort Wola 22, 01-258 Warszawa', category: 'Concerts' },
  { name: 'Stodoła', list: ['https://www.stodola.pl/koncerty'], link: /\/koncerty\/[a-z0-9-]+-\d+\.html/g, base: 'https://www.stodola.pl',
    venue: 'Klub Stodoła', city: 'Warszawa', address: 'ul. Batorego 10, 02-591 Warszawa', category: 'Concerts' }
];
const CACHE = new URL('../data/kluby.json', import.meta.url);
const REFRESH = 3 * 864e5, PER_SITE = 150;

function ldEvent(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let d; try { d = JSON.parse(m[1]); } catch { continue; }
    const e = (Array.isArray(d) ? d : d['@graph'] || [d]).find(x => x && /Event$/.test(x['@type']));
    if (e) return e;
  }
  return null;
}
async function ldSite(site, cache) {
  const links = new Set();
  for (const u of site.list) {
    const html = await request(u, { type: 'text', headers: UA, retries: 1, timeout: 25000 });
    for (const l of html.match(site.link) || []) links.add((site.base || '') + l);
  }
  let fresh = 0;
  for (const u of links) {
    if (cache[u] && Date.now() - cache[u].at < REFRESH) continue;
    if (fresh >= PER_SITE) break;
    try {
      const h = await request(u, { type: 'text', headers: UA, retries: 1, timeout: 20000 });
      const e = ldEvent(h);
      // sama data bez godziny (Stodoła) — godzina otwarcia drzwi z treści strony
      const doors = text(h).match(/Otwarcie drzwi:?\s*(\d{1,2}:\d{2})/i)?.[1];
      cache[u] = { at: Date.now(), e: e ? { name: e.name, start: e.startDate, end: e.endDate, image: [e.image].flat()[0]?.url || [e.image].flat()[0] || null,
        place: e.location?.name, addr: typeof e.location?.address === 'string' ? e.location.address : [e.location?.address?.streetAddress, e.location?.address?.postalCode, e.location?.address?.addressLocality].filter(Boolean).join(', '),
        locality: typeof e.location?.address === 'object' ? e.location.address.addressLocality : null, price: [e.offers].flat().map(o => +o?.price).filter(x => x > 0).sort((a, b) => a - b)[0] ?? null,
        performer: [e.performer].flat().map(x => x?.name).filter(Boolean), description: e.description, doors } : null };
      fresh++;
    } catch { /* następnym razem */ }
    await sleep(400);
  }
  const out = [];
  for (const u of links) {
    const e = cache[u]?.e;
    if (!e?.start || !e.name) continue;
    let start = localTime(String(e.start).replace(/([+-]\d{2}:?\d{2}|Z)$/, ''));
    if (start?.endsWith('T00:00') && e.doors) start = start.slice(0, 11) + e.doors.padStart(5, '0');
    // klub (np. Stodoła) pokazuje też trasy organizatora w innych miastach: miasto i miejsce z danych wydarzenia
    const city = cityOf([e.place, e.addr, e.locality].join(', ')) || site.city;
    const home = !e.place || fold(e.place).includes(fold(site.venue).replace(/^klub /, '')) || fold(site.venue).includes(fold(e.place));
    out.push(makeEvent({
      id: 'klub-' + site.name.toLowerCase().replace(/[^a-z]/g, '') + '-' + u.replace(/\/$/, '').split('/').pop().replace(/\.html$/, ''),
      source: 'kluby', title: e.name.replace(/\s*\((WARSZAWA|KRAKÓW|WROCŁAW|GDAŃSK|POZNAŃ|ŁÓDŹ|KATOWICE|LUBLIN|SZCZECIN|GDYNIA|SOPOT|BYDGOSZCZ|TORUŃ|BIAŁYSTOK|RZESZÓW|OPOLE|KIELCE|OLSZTYN|ZABRZE|GLIWICE|[A-ZĄĆĘŁŃÓŚŹŻ -]{3,20})\)\s*$/, ''), start,
      city, venue: home ? (e.place && !/^(Warszawa|Klub)$/i.test(e.place) ? e.place.replace(/\s+-\s+/, ' – ') : site.venue) : e.place,
      address: home ? site.address : (e.addr || city),
      category: guessCategory(e.name) === 'Other' ? site.category : guessCategory(e.name),
      artists: e.performer, priceFrom: e.price, image: e.image, description: e.description, url: u
    }));
  }
  return out;
}

export default async function kluby() {
  let cache = {};
  try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch { /* pierwszy przebieg */ }
  const out = [];
  for (const [name, fn] of [['Sektor 6D', sektor6d], ...SITES.map(site => [site.name, () => ldSite(site, cache)])]) {
    try { const l = await fn(); out.push(...l); console.log(`  kluby ${name}: ${l.length}`); }
    catch (e) { console.warn(`  kluby ${name}: ${e.message}`); }
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const [u, c] of Object.entries(cache)) if (!c.e || String(c.e.end || c.e.start).slice(0, 10) < today) if (Date.now() - c.at > REFRESH) delete cache[u];
  await writeFile(CACHE, '{\n' + Object.entries(cache).sort().map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}\n');
  if (!out.length) throw new Error('żadna strona klubu nie odpowiada');
  return out;
}
