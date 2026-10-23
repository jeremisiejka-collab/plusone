/* Wspólny format wydarzenia (to trafia do data/events.json):
   {
     id, title, start, end,          // start/end: czas lokalny Warszawy "YYYY-MM-DDTHH:mm"
     city, venue, address,
     category,                       // jedna z CATEGORIES
     tags[], artists[],
     priceFrom,                      // PLN albo null
     image, description,
     links: [{ source, url, price }],
     sources[]
   }
*/

export const CATEGORIES = ['Clubs', 'Concerts', 'Festivals', 'Theatre', 'Comedy', 'Culture', 'Sport', 'Family', 'Other'];

/* ISO UTC -> lokalny czas Warszawy "YYYY-MM-DDTHH:mm" */
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
});
export function utcToLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d) ? null : fmt.format(d).replace(' ', 'T');
}

/* data już lokalna (bez strefy) -> obcięta do minut */
export function localTime(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  return m ? `${m[1]}T${m[2] || '00:00'}` : null;
}

export function nowLocal() {
  return utcToLocal(new Date().toISOString());
}

/* nazwy miast do jednej postaci: "Warsaw" / "warszawa" -> "Warszawa" */
const CITY_ALIASES = {
  warsaw: 'Warszawa', warszawa: 'Warszawa', krakow: 'Kraków', cracow: 'Kraków', kraków: 'Kraków',
  gdansk: 'Gdańsk', gdańsk: 'Gdańsk', wroclaw: 'Wrocław', wrocław: 'Wrocław', poznan: 'Poznań', poznań: 'Poznań',
  lodz: 'Łódź', łódź: 'Łódź', katowice: 'Katowice', gdynia: 'Gdynia', sopot: 'Sopot', szczecin: 'Szczecin',
  lublin: 'Lublin', bialystok: 'Białystok', białystok: 'Białystok', bydgoszcz: 'Bydgoszcz', torun: 'Toruń', toruń: 'Toruń',
  rzeszow: 'Rzeszów', rzeszów: 'Rzeszów'
};
export function normCity(c) {
  if (!c) return null;
  const s = String(c).trim();
  return CITY_ALIASES[s.toLowerCase()] || s;
}

/* "50 PLN", "0,00€", "od 129 zł" -> liczba w PLN (EUR przeliczane orientacyjnie) */
export function parsePrice(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 0 ? v : 0;
  const s = String(v).replace(/\s/g, '');
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return /free|darmo|bezpłat/i.test(s) ? 0 : null;
  let n = parseFloat(m[1].replace(',', '.'));
  if (/€|eur/i.test(s)) n = Math.round(n * 4.3);
  return n;
}

export function clean(s, max) {
  if (!s) return '';
  let t = String(s).replace(/<[^>]+>/g, ' ').replace(/%26(#?\w+;)/g, '&$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max).replace(/\s\S*$/, '') + '…';
  return t;
}

/* kategoria na podstawie słów kluczowych z kategorii/tagów/tytułu źródła */
export function guessCategory(...hints) {
  const h = hints.flat().filter(Boolean).join(' ').toLowerCase();
  if (/festiwal|festival|\bfest\b|open'er|opener/.test(h)) return 'Festivals';
  if (/stand-?up|kabaret|comedy|\bimpro/.test(h)) return 'Comedy';
  if (/techno|house|club|klub|rave|\bdj\b|electronic|elektron|drum ?& ?bass|dnb|disco|party|impreza/.test(h)) return 'Clubs';
  if (/teatr|theatre|spektakl|musical|opera|balet|ballet/.test(h)) return 'Theatre';
  if (/koncert|concert|muzyka|music|\brock\b|metal|\bpop\b|\brap\b|hip-?hop|jazz|klasyk|filharmon/.test(h)) return 'Concerts';
  if (/sport|mecz|siatk|piłk|koszyk|gala|mma|ksw|żużel/.test(h)) return 'Sport';
  if (/dzieci|rodzin|family|kids/.test(h)) return 'Family';
  if (/wystaw|muzeum|kino|film|kultura|galeria|exhibition|spotkanie|warsztat/.test(h)) return 'Culture';
  return 'Other';
}

/* "duże wydarzenie": festiwal, koncert na stadionie/arenie albo drogi bilet na koncert */
const BIG_VENUE = /narodow(y|ym)\b.*stadion|pge narodowy|stadion|tauron arena|atlas arena|ergo arena|polsat plus arena|spodek|torwar|prezero arena|g2a arena|orlen arena|netto arena|hala stulecia|expo xxi|enea arena|arena gliwice|tarczyński arena|tor wyścigów|lotnisko|muzeum lotnictwa|park śląski|plac defilad|międzynarodowe centrum kongresowe|\bmck\b|kghm ślęza arena|arena lublin|hala mt[pP]|międzynarodowe targi/i;
export function isBig(e) {
  const text = `${e.title} ${e.venue || ''}`;
  if (/film|kino|teatr|filharmon|klasyk|symfoni|świec/i.test(text)) return false;
  if (e.category === 'Festivals') return true;
  if (!['Concerts', 'Clubs', 'Comedy'].includes(e.category)) return false;
  return BIG_VENUE.test(e.venue || '') || (e.priceFrom != null && e.priceFrom >= 350);
}

export function makeEvent(e) {
  return {
    id: e.id,
    title: clean(e.title, 160),
    start: e.start,
    end: e.end || null,
    city: normCity(e.city),
    venue: clean(e.venue, 120) || null,
    address: clean(e.address, 160) || null,
    category: CATEGORIES.includes(e.category) ? e.category : 'Other',
    tags: [...new Set((e.tags || []).map(t => clean(t)).filter(Boolean))].slice(0, 8),
    artists: [...new Set((e.artists || []).map(a => clean(a)).filter(Boolean))].slice(0, 20),
    priceFrom: e.priceFrom ?? null,
    image: e.image || null,
    description: clean(e.description, 600),
    links: [{ source: e.source, url: e.url, price: e.priceFrom ?? null }],
    sources: [e.source]
  };
}
