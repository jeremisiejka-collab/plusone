/* Resident Advisor — imprezy klubowe/elektroniczne (publiczne GraphQL ra.co) */
import { request, sleep } from '../lib/http.mjs';
import { localTime, parsePrice, makeEvent } from '../lib/normalize.mjs';

/* id obszarów RA (zapytanie: areas(searchTerm:"...")) */
const AREAS = { Warszawa: 454, Kraków: 455, Poznań: 666, Gdańsk: 667, Wrocław: 668, Łódź: 677 };

const QUERY = `query($filters: FilterInputDtoInput, $page: Int, $pageSize: Int) {
  eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
    totalResults
    data { event {
      id title startTime endTime contentUrl cost
      venue { name address }
      images { filename type }
      artists { name }
      genres { name }
    } }
  }
}`;

async function fetchArea(city, areaId, from, to) {
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
        city,
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
  const all = [];
  for (const [city, id] of Object.entries(AREAS)) {
    all.push(...await fetchArea(city, id, from.toISOString(), to.toISOString()));
    await sleep(500);
  }
  return all;
}
