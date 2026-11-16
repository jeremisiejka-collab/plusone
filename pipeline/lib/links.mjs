/* Linki „Kup bilet” mają zawsze prowadzić na działającą stronę wydarzenia.
   - adresy widżetów do osadzania (…/embedded/…, /widget) odrzucamy od razu — otwarte osobno pokazują błąd,
   - linki sprawdzamy zapytaniem (wynik w pipeline/data/link-check.json: dobre co 7 dni, reszta co dzień):
     404/410 albo przekierowanie z podstrony na stronę główną = martwy link (wydarzenie usunięte u sprzedawcy),
     403/429/5xx i przekroczony czas = nie wiadomo (serwisy blokują automaty) — link zostaje.
   Martwe linki wypadają z wydarzenia; pierwszym linkiem (przycisk „Kup bilet”) zostaje działający.
   Wydarzenie bez żadnego działającego linku znika (sprzedawca je usunął, najczęściej odwołane). */
import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../data/link-check.json', import.meta.url);
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; plusone-events-bot/1.0; +https://plusoneapp.pl)', Accept: 'text/html,*/*' };
const BAD_URL = /\/(embedded|embeddables|widget|iframe)(\/|\b)/i;
const DAY = 864e5;

async function check(url) {
  try {
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    r.body?.cancel().catch(() => {});
    if (r.status === 404 || r.status === 410) return 'dead';
    const from = new URL(url), to = new URL(r.url || url);
    // podstrona wydarzenia przekierowana na stronę główną serwisu = wydarzenia już nie ma
    if (r.ok && from.pathname.length > 1 && (to.pathname === '/' || to.pathname === '') && from.hostname.replace(/^www\./, '') === to.hostname.replace(/^www\./, '')) return 'dead';
    return r.ok ? 'ok' : 'unknown';
  } catch { return 'unknown'; }
}

export async function checkLinks(events, { budget = 700, concurrency = 10, timeBudget = 5 * 60e3 } = {}) {
  let cache = {};
  try { cache = JSON.parse(await readFile(FILE, 'utf8')); } catch { /* pierwszy raz */ }
  const now = Date.now();
  const stale = c => !c || now - c.at > (c.s === 'ok' ? 7 : 1) * DAY;
  const urls = [...new Set(events.flatMap(e => e.links.map(l => l.url)).filter(u => u && !BAD_URL.test(u)))];
  // najpierw linki najbliższych wydarzeń
  const first = new Map(); for (const e of events) for (const l of e.links) if (!first.has(l.url) || e.start < first.get(l.url)) first.set(l.url, e.start);
  const todo = urls.filter(u => stale(cache[u])).sort((a, b) => (first.get(a) || '').localeCompare(first.get(b) || '')).slice(0, budget);
  const t0 = Date.now(); let i = 0, checked = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < todo.length && Date.now() - t0 < timeBudget) { const u = todo[i++]; cache[u] = { s: await check(u), at: now }; checked++; }
  }));
  let removedLinks = 0, removedEvents = 0;
  const out = [];
  for (const e of events) {
    const good = e.links.filter(l => l.url && !BAD_URL.test(l.url) && cache[l.url]?.s !== 'dead');
    removedLinks += e.links.length - good.length;
    if (!good.length) { removedEvents++; continue; }
    // pierwszy link = przycisk „Kup bilet”: najpierw sprawdzony jako działający
    good.sort((a, b) => (cache[b.url]?.s === 'ok') - (cache[a.url]?.s === 'ok'));
    const prices = good.map(l => l.price).filter(p => p != null);
    out.push({ ...e, links: good, sources: [...new Set(good.map(l => l.source))], priceFrom: e.links.length === good.length ? e.priceFrom : (prices.length ? Math.min(...prices) : null) });
  }
  // pamięć tylko dla obecnych linków
  const keep = {}; for (const u of urls) if (cache[u]) keep[u] = cache[u];
  await writeFile(FILE, '{\n' + Object.entries(keep).sort().map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}\n');
  return { events: out, checked, removedLinks, removedEvents, dead: Object.values(keep).filter(c => c.s === 'dead').length };
}
