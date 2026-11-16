/* Strony klubów i miejsc, których imprezy nie trafiają do serwisów biletowych z kompletem danych.
   Każde miejsce ma własny czytnik; na razie SEKTOR 6D (Warszawa, Modlińska 6D — duże imprezy elektroniczne i koncerty). */
import { request, sleep } from '../lib/http.mjs';
import { makeEvent } from '../lib/normalize.mjs';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; plusone-events-bot/1.0; +https://plusoneapp.pl)' };
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
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

export default async function kluby() {
  const out = [];
  for (const [name, fn] of [['Sektor 6D', sektor6d]]) {
    try { const l = await fn(); out.push(...l); console.log(`  kluby ${name}: ${l.length}`); }
    catch (e) { console.warn(`  kluby ${name}: ${e.message}`); }
  }
  if (!out.length) throw new Error('żadna strona klubu nie odpowiada');
  return out;
}
