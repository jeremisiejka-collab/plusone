/* Resident Advisor — imprezy klubowe/elektroniczne (publiczne GraphQL ra.co) */
import { request, sleep } from '../lib/http.mjs';
import { localTime, parsePrice, makeEvent } from '../lib/normalize.mjs';

/* obszar RA "All" dla Polski (id 69) — obejmuje też miasta bez własnego obszaru (Katowice, Lublin…) */
const POLAND = 69;
const AREA_CITY = { Warsaw: 'Warszawa', Krakow: 'Kraków', Poznan: 'Poznań', Gdansk: 'Gdańsk', Wroclaw: 'Wrocław', Lodz: 'Łódź' };

/* miasto z adresu ("Smolna 38, 00-375 Warszawa"), w razie czego z obszaru RA */
function cityOf(venue) {
  const m = (venue?.address || '').match(/\d{2}-\d{3}\s+([^,\d]+)/);
  if (m) return m[1].replace(/\s+(Poland|Polska)$/i, '').trim();
  return AREA_CITY[venue?.area?.name] || null;
}

const QUERY = `query($filters: FilterInputDtoInput, $page: Int, $pageSize: Int) {
  eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
    totalResults
    data { event {
      id title startTime endTime contentUrl cost
      venue { name address area { name } }
      images { filename type }
      artists { name }
      genres { name }
    } }
  }
}`;

async function fetchArea(areaId, from, to) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const res = await request('https://ra.co/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://ra.co/events' },
      body: JSON.stringify({
        query: QUERY,
        variables: { page, pageSize: 100, filters: { areas: { eq: areaId }, listingDate: { gte: from, lte: to } } }
      })
    });
    if (res.errors) throw new Error('RA: ' + res.errors[0].message);
    const { data, totalResults } = res.data.eventListings;
    for (const { event: ev } of data) {
      const img = (ev.images || []).find(i => i.type === 'FLYERFRONT') || ev.images?.[0];
      out.push(makeEvent({
        id: 'ra-' + ev.id,
        source: 'ra',
        title: ev.title,
        start: localTime(ev.startTime),
        end: localTime(ev.endTime),
        city: cityOf(ev.venue),
        venue: ev.venue?.name,
        address: ev.venue?.address,
        category: 'Clubs',
        tags: (ev.genres || []).map(g => g.name),
        artists: (ev.artists || []).map(a => a.name),
        priceFrom: parsePrice(ev.cost),
        image: img?.filename || null,
        url: 'https://ra.co' + ev.contentUrl
      }));
    }
    if (page * 100 >= totalResults || !data.length) break;
    await sleep(500);
  }
  return out;
}

export default async function ra({ days = 180 } = {}) {
  const from = new Date();
  const to = new Date(Date.now() + days * 864e5);
  return (await fetchArea(POLAND, from.toISOString(), to.toISOString())).filter(e => e.city);
}
