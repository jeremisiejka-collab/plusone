/* eBilet — strony miast (/miasto/<slug>) mają listy wydarzeń w danych serwera
   (serverApp-state) oraz w schema.org JSON-LD. Bierzemy oba i łączymy po adresie. */
import { request, sleep } from '../lib/http.mjs';
import { localTime, guessCategory, makeEvent } from '../lib/normalize.mjs';

const CITIES = ['warszawa', 'krakow', 'trojmiasto', 'wroclaw', 'poznan', 'lodz', 'slaskie', 'szczecin', 'lublin', 'bialystok', 'bydgoszcz', 'torun', 'rzeszow'];
/* ogólnopolskie strony kategorii — tu są duże koncerty i festiwale spoza list miast */
const CATEGORY_PAGES = ['muzyka', 'festiwale', 'muzyka/festiwale', 'muzyka/rock', 'muzyka/pop', 'muzyka/piosenka', 'muzyka/hip-hop-rap',
  'muzyka/hard-heavy', 'muzyka/elektro-techno', 'muzyka/jazz-blues', 'muzyka/disco-polo', 'muzyka/k-pop', 'muzyka/reggae', 'muzyka/pozostale'];
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
  for (const slug of PAGES) {
    let html;
    try {
      html = await request(`https://www.ebilet.pl/${slug}`, { type: 'text' });
    } catch (e) {
      console.warn(`  ebilet ${slug}: ${e.message}`);
      continue;
    }
    const ld = new Map(fromJsonLd(html).map(e => [e.url, e]));

    for (const t of fromState(html)) {
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
    await sleep(800);
  }
  return [...byUrl.values()];
}
