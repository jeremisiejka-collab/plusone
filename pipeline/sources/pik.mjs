/* PIK Warszawa (pik.warszawa.pl, Punkt Informacji Kulturalnej) — kalendarz wydarzeń w Warszawie: koncerty, kluby, teatr,
   sztuka, festiwale, kino, dla dzieci. Listy kategorii (strony 1–N) → strona wydarzenia z danymi schema.org/Event
   (data, godzina, miejsce, adres, cena, plakat). Przetworzone strony pamiętamy w pipeline/data/pik.json, więc każdy przebieg
   pobiera tylko nowe wydarzenia. */
import { readFile, writeFile } from 'node:fs/promises';
import { request, sleep } from '../lib/http.mjs';
import { makeEvent, guessCategory, localTime } from '../lib/normalize.mjs';

const STORE = new URL('../data/pik.json', import.meta.url);
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; plusone-events-bot/1.0; +https://plusoneapp.pl)' };
const CATS = { muzyka: [null, 6], teatr: ['Theatre', 4], art: ['Culture', 3], festiwal: ['Festivals', 2], dzieci: ['Family', 2], kino: ['Culture', 2], inne: [null, 3] };
const NEW_PER_RUN = 220;
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#8211;/g, '–').replace(/&#8217;/g, '’').replace(/&#0?39;/g, "'");

/* link do biletów tylko bezpośrednio u sprzedawcy (bez kodów partnerskich); przekierowania sieci reklamowych → strona w PIK */
function ticketUrl(t) {
  try {
    const u = new URL(t);
    // widżety do osadzania (biletomat.pl/embedded/…) działają tylko na stronie PIK — otwarte osobno pokazują błąd
    if (/\/(embedded|embeddables|widget|iframe)\b/i.test(u.pathname)) return null;
    if (!/(^|\.)(ebilet\.pl|biletyna\.pl|eventim\.pl|goingapp\.pl|ticketmaster\.pl|kupbilecik\.pl|bilety24\.pl|biletomat\.pl|abilet\.pl)$/.test(u.hostname)) return null;
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|partner|affid|aff|ref|subid)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch { return null; }
}

function eventFrom(html) {
  for (const b of html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g) || []) {
    let d; try { d = JSON.parse(b.replace(/^<script[^>]*>|<\/script>$/g, '')); } catch { continue; }
    const list = Array.isArray(d) ? d : d['@graph'] || [d];
    const e = list.find(x => x && x['@type'] === 'Event');
    if (e) return e;
  }
  return null;
}

export default async function pik() {
  let store = {};
  try { store = JSON.parse(await readFile(STORE, 'utf8')); } catch { /* pierwszy przebieg */ }
  const urls = new Map();
  let pages = 0;
  for (const [cat, [, n]] of Object.entries(CATS)) {
    for (let p = 1; p <= n; p++) {
      let html;
      try { html = await request(`https://pik.warszawa.pl/${cat}/${p > 1 ? `page/${p}/` : ''}`, { type: 'text', headers: UA, retries: 1, timeout: 20000 }); }
      catch { break; }
      pages++;
      const found = [...new Set(html.match(new RegExp(`https://pik\\.warszawa\\.pl/${cat}/[a-z0-9-]{3,}/`, 'g')) || [])].filter(u => !/\/page\//.test(u));
      for (const u of found) if (!urls.has(u)) urls.set(u, cat);
      await sleep(400);
    }
  }
  if (!pages) throw new Error('pik.warszawa.pl nie odpowiada');
  let fetched = 0;
  for (const [u, cat] of urls) {
    if (store[u] !== undefined || fetched >= NEW_PER_RUN) continue;
    try {
      const e = eventFrom(await request(u, { type: 'text', headers: UA, retries: 1, timeout: 20000 }));
      fetched++;
      store[u] = e ? {
        cat, title: decode(e.name), start: e.startDate, end: e.endDate, image: [e.image].flat()[0]?.url || [e.image].flat()[0] || null,
        venue: decode(e.location?.name), street: e.location?.address?.streetAddress, postal: e.location?.address?.postalCode,
        price: [e.offers].flat().map(o => +o?.price).filter(x => x > 0).sort((a, b) => a - b)[0] ?? null,
        ticket: [e.offers].flat()[0]?.url || null, description: decode(e.description)
      } : null;
    } catch { /* spróbujemy w następnym przebiegu */ }
    await sleep(300);
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const [u, e] of Object.entries(store)) if (e && (e.end || e.start || '').slice(0, 10) < today) delete store[u];
  await writeFile(STORE, '{\n' + Object.entries(store).sort().map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}\n');
  console.log(`  pik: ${pages} stron list, nowych wydarzeń ${fetched}, w pamięci ${Object.keys(store).length}`);

  return Object.entries(store).filter(([, e]) => e?.start && e.title).map(([u, e]) => {
    const start = localTime(e.start.replace(/([+-]\d{2}:\d{2}|Z)$/, ''));
    const end = e.end ? localTime(e.end.replace(/([+-]\d{2}:\d{2}|Z)$/, '')) : null;
    // wielodniowe wystawy i spektakle grane miesiącami: zostaje termin z datą końca
    return makeEvent({
      id: 'pik-' + u.split('/').filter(Boolean).pop(),
      source: 'pik',
      // „Swae Lee | koncert w Warszawie - Bilety” → „Swae Lee”
      title: e.title.replace(/\s*\|[^|]*(w Warszawie|bilety)[^|]*$/i, '').replace(/\s*-\s*bilety\s*$/i, '').replace(/\s+\|\s+/g, ' – ').trim(),
      start,
      end: end && end.slice(0, 10) !== start.slice(0, 10) ? end : null,
      city: 'Warszawa',
      venue: e.venue,
      address: [e.street, e.postal ? e.postal + ' Warszawa' : 'Warszawa'].filter(Boolean).join(', '),
      category: CATS[e.cat]?.[0] || guessCategory(e.title, e.cat === 'muzyka' ? 'koncert' : ''),
      priceFrom: e.price,
      image: e.image && !/PIK_LOGO|cropped-/i.test(e.image) ? e.image : null,
      description: e.description,
      url: ticketUrl(e.ticket) || u
    });
  });
}
