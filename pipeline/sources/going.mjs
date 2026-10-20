/* Going. (goingapp.pl) — koncerty, teatr, stand-up, sport w całej Polsce.
   Korzysta z publicznego indeksu wyszukiwarki Algolia, którego używa sama strona. */
import { request, sleep } from '../lib/http.mjs';
import { utcToLocal, guessCategory, makeEvent } from '../lib/normalize.mjs';

const APP = 'FAFFKUSLK0';
const KEY = '2116b4baed0596249c1f98b9a20dfc6c'; // publiczny klucz "search-only" ze strony goingapp.pl
const URL = `https://${APP.toLowerCase()}-dsn.algolia.net/1/indexes/search-main/query`;
const CLOUD = 'https://res.cloudinary.com/dr89d8ldb/image/upload/c_fill,w_800,h_600,q_auto,f_auto/';
const MAX = 1000; // Algolia nie zwraca więcej niż 1000 wyników na zapytanie

async function query(filters, page = 0, hitsPerPage = MAX) {
  const params = new URLSearchParams({ query: '', filters, hitsPerPage, page, attributesToHighlight: '', attributesToSnippet: '' });
  return request(URL, {
    method: 'POST',
    headers: { 'X-Algolia-Application-Id': APP, 'X-Algolia-API-Key': KEY, Referer: 'https://goingapp.pl/', 'Content-Type': 'application/json' },
    body: JSON.stringify({ params: params.toString() })
  });
}

/* dzieli zakres dat na pół, dopóki zapytanie zwraca > 1000 wyników */
async function fetchRange(lo, hi, depth = 0) {
  const filters = `type:rundate AND start_date_timestamp:${lo} TO ${hi}`;
  const head = await query(filters, 0, 0);
  if (head.nbHits > MAX && depth < 12) {
    const mid = Math.floor((lo + hi) / 2);
    return [...await fetchRange(lo, mid, depth + 1), ...await fetchRange(mid + 1, hi, depth + 1)];
  }
  await sleep(200);
  return (await query(filters)).hits;
}

function category(h) {
  const tags = h.tags_names || [];
  const slugs = (h.tags_slugs || []).join(' ');
  if (/festiwal/.test(slugs)) return 'Festivals';
  switch (h.category_slug) {
    case 'koncert': return guessCategory(tags, h.place_name) === 'Clubs' ? 'Clubs' : 'Concerts';
    case 'teatr': return guessCategory(tags) === 'Comedy' ? 'Comedy' : 'Theatre';
    case 'sport': return 'Sport';
    case 'kultura': return guessCategory(tags, h.slug) === 'Family' ? 'Family' : 'Culture';
  }
  const g = guessCategory(tags, h.category_name, h.slug);
  return g === 'Other' ? 'Culture' : g;
}

/* name_pl to zwykle tytuł, ale czasem samo miasto ("Warszawa") — wtedy bierzemy slug wydarzenia */
function title(h, city) {
  const n = (h.name_pl || '').trim();
  if (n && n.toLowerCase() !== city.toLowerCase()) return n;
  const s = (h.slug || '').replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default async function going() {
  const now = Date.now() - 6 * 3600e3;
  const hits = await fetchRange(now, now + 2 * 365 * 864e5);
  return hits
    .filter(h => h.sale_enabled !== false && h.rundate)
    .map(h => {
      const city = (h.caption || '').split(',').pop().trim();
      return makeEvent({
        id: 'going-' + h.id,
        source: 'going',
        title: title(h, city),
        start: utcToLocal(h.rundate),
        city,
        venue: h.place_name,
        category: category(h),
        tags: h.tags_names,
        artists: h.artists_names,
        priceFrom: h.price ?? null,
        image: h.thumbnail ? CLOUD + encodeURI(h.thumbnail) : null,
        description: h.description_pl,
        url: `https://goingapp.pl/wydarzenie/${h.slug}/${h.rundate_slug}`
      });
    });
}
