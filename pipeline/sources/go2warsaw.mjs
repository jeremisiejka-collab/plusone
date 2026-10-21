/* go2warsaw.pl — oficjalny serwis turystyczny Warszawy (wystawy, koncerty, spotkania, dużo darmowych).
   Lista z WordPress REST API (mec-events), szczegóły z schema.org JSON-LD na stronie wydarzenia. */
import { request, sleep } from '../lib/http.mjs';
import { localTime, guessCategory, makeEvent } from '../lib/normalize.mjs';

const BASE = 'https://go2warsaw.pl';
const PAGES = 4;        // 4 × 100 ostatnio zmienianych wpisów
const PARALLEL = 4;

async function listLinks() {
  const out = [];
  for (let page = 1; page <= PAGES; page++) {
    const list = await request(`${BASE}/wp-json/wp/v2/mec-events?per_page=100&page=${page}&orderby=modified&order=desc&_fields=id,link`);
    out.push(...list.filter(x => !x.link.includes('/en/')));   // wersje angielskie dublują polskie
    if (list.length < 100) break;
    await sleep(300);
  }
  return out;
}

const decode = s => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function parse(html, link, id) {
  let ev = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      for (const x of [JSON.parse(m[1])].flat()) for (const y of x['@graph'] || [x]) if (y['@type'] === 'Event') ev = y;
    } catch { /* uszkodzony JSON-LD — pomijamy */ }
  }
  if (!ev || !ev.startDate) return null;
  const img = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || (typeof ev.image === 'string' && ev.image) || null;
  const title = decode(ev.name || (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '').replace(/\s*[-–|]\s*Go To Warsaw.*$/i, '');
  const start = localTime(ev.startDate), end = localTime(ev.endDate);
  const venue = decode(ev.location?.name);
  return makeEvent({
    id: 'g2w-' + id,
    source: 'go2warsaw',
    title,
    start,
    end: end && end.slice(0, 10) !== start.slice(0, 10) ? end : null,
    city: 'Warszawa',
    venue: venue && venue !== 'Warszawa' ? venue : null,
    address: typeof ev.location?.address === 'string' ? decode(ev.location.address) : null,
    category: (c => c === 'Other' ? 'Culture' : c)(guessCategory(title, ev.description)),
    priceFrom: null, // MEC wpisuje "0" także, gdy cena nie jest podana
    image: img,
    description: decode(ev.description),
    url: link
  });
}

export default async function go2warsaw() {
  const links = await listLinks();
  const out = [];
  for (let i = 0; i < links.length; i += PARALLEL) {
    const batch = links.slice(i, i + PARALLEL);
    const res = await Promise.all(batch.map(({ id, link }) =>
      request(link, { type: 'text', retries: 1 }).then(h => parse(h, link, id)).catch(() => null)));
    out.push(...res.filter(Boolean));
    await sleep(250);
  }
  return out;
}
