/* Łączenie duplikatów: to samo wydarzenie z kilku źródeł -> jeden wpis z wieloma linkami.
   Kandydaci: to samo miasto + ten sam dzień. Dopasowanie: podobny tytuł albo
   wspólni artyści, plus zgodne miejsce (jeśli oba źródła je podają). */

const STOP = new Set(['the', 'and', 'w', 'i', 'na', 'z', 'x', 'vs', 'live', 'tour', 'koncert', 'concert', 'warszawa', 'krakow', 'gdansk', 'wroclaw', 'poznan', 'lodz', '2025', '2026', '2027']);

export function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, ' ').trim();
}
const tokens = s => new Set(norm(s).split(' ').filter(t => t.length > 1 && !STOP.has(t)));

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / (a.size + b.size - n);
}

function venueMatch(a, b) {
  if (!a.venue || !b.venue) return true;
  const x = tokens(a.venue), y = tokens(b.venue);
  return jaccard(x, y) > 0 || [...x].some(t => norm(b.venue).includes(t)) || [...y].some(t => norm(a.venue).includes(t));
}

const minutes = s => +s.slice(11, 13) * 60 + +s.slice(14, 16);

function same(a, b) {
  // to samo źródło nie dubluje się samo ze sobą — dwa wpisy = dwa terminy (np. 2 seanse jednego dnia)
  if (a.sources.some(s => b.sources.includes(s))) return false;
  // godziny muszą być bliskie (różne źródła podają start drzwi vs. start koncertu); 00:00 = brak godziny
  const ma = minutes(a.start), mb = minutes(b.start);
  if (ma && mb && Math.abs(ma - mb) > 120) return false;
  if (!venueMatch(a, b)) return false;
  const ta = tokens(a.title), tb = tokens(b.title);
  if (jaccard(ta, tb) >= 0.5) return true;
  const aa = new Set(a.artists.map(norm)), ab = b.artists.map(norm);
  if (ab.some(x => x && aa.has(x))) return true;
  // tytuł jednego zawiera całość drugiego ("Cult of Luna" vs "Cult of Luna – Warszawa 2027")
  const [s, l] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return s.size >= 2 && [...s].every(t => l.has(t));
}

/* pierwszeństwo danych przy łączeniu (lepsze opisy/zdjęcia/ceny) */
const RANK = { going: 4, ebilet: 3, go2warsaw: 2, ra: 1 };

function merge(a, b) {
  const [p, q] = (RANK[b.sources[0]] || 0) > (RANK[a.sources[0]] || 0) ? [b, a] : [a, b];
  const prices = [p.priceFrom, q.priceFrom].filter(v => v != null);
  return {
    ...p,
    end: p.end || q.end,
    venue: p.venue || q.venue,
    address: p.address || q.address,
    category: p.category === 'Other' ? q.category : p.category,
    tags: [...new Set([...p.tags, ...q.tags])].slice(0, 8),
    artists: [...new Set([...p.artists, ...q.artists])].slice(0, 20),
    priceFrom: prices.length ? Math.min(...prices) : null,
    image: p.image || q.image,
    description: p.description.length >= q.description.length ? p.description : q.description,
    links: [...p.links, ...q.links.filter(l => !p.links.some(x => x.url === l.url))],
    sources: [...new Set([...p.sources, ...q.sources])]
  };
}

export function dedup(events) {
  const buckets = new Map();
  for (const e of events) {
    const k = norm(e.city) + '|' + e.start.slice(0, 10);
    if (!buckets.has(k)) buckets.set(k, []);
    const list = buckets.get(k);
    const i = list.findIndex(x => same(x, e));
    if (i >= 0) list[i] = merge(list[i], e);
    else list.push(e);
  }
  return [...buckets.values()].flat();
}
