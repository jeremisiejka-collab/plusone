/* Pipeline +1: pobiera wydarzenia ze wszystkich źródeł, czyści, łączy duplikaty,
   sortuje i zapisuje public/data/events.json (to czyta aplikacja).
   Uruchomienie: node pipeline/run.mjs [--only=ra,going] */
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowLocal, CATEGORIES, isBig } from './lib/normalize.mjs';
import { dedup } from './lib/dedup.mjs';
import { cityGeo } from './lib/geo.mjs';
import { measureImages } from './lib/images.mjs';
import { hotScore } from './lib/hot.mjs';
import ra from './sources/ra.mjs';
import going from './sources/going.mjs';
import ebilet from './sources/ebilet.mjs';
import go2warsaw from './sources/go2warsaw.mjs';

const SOURCES = { going, ebilet, ra, go2warsaw };
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'data', 'events.json');

/* poprzedni plik: daty pierwszego pojawienia się ("Nowe w +1") i zapas, gdy źródło padnie */
let prev = null;
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* pierwszy przebieg */ }
const prevEvents = prev?.events || [];
// wydarzenia z pliku sprzed wprowadzenia firstSeen traktujemy jako "stare"
const firstSeen = new Map(prevEvents.map(e => [e.id, e.firstSeen || '2000-01-01T00:00:00.000Z']));

const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');

const raw = [];
const report = {};
for (const [name, fn] of Object.entries(SOURCES)) {
  if (only && !only.includes(name)) continue;
  const t = Date.now();
  try {
    const list = await fn();
    raw.push(...list);
    report[name] = { ok: true, count: list.length };
    console.log(`✓ ${name}: ${list.length} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    // źródło nie odpowiada: bierzemy jego wydarzenia z poprzedniego przebiegu, żeby nie zniknęły z apki
    const kept = prevEvents.filter(x => x.sources?.includes(name)).map(x => ({ ...x, links: x.links.filter(l => l.source === name), sources: [name] }));
    raw.push(...kept);
    report[name] = { ok: false, error: e.message, kept: kept.length };
    console.error(`✗ ${name}: ${e.message} (zostawiam ${kept.length} z poprzedniego przebiegu)`);
  }
}

const now = nowLocal();
const today = now.slice(0, 10);
const valid = raw.filter(e =>
  e.title && e.start && e.city && e.links[0].url &&
  // odrzuć minione: koniec (albo start) przed dziś
  (e.end || e.start).slice(0, 10) >= today
);

const stamp = new Date().toISOString();
const events = dedup(valid)
  .map(e => ({ ...e, big: isBig(e), firstSeen: firstSeen.get(e.id) || stamp }))
  .map(e => ({ ...e, hot: hotScore(e) }))
  .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));

const img = await measureImages(events, prevEvents);
console.log(`Grafiki: zmierzono ${img.measured} nowych, bez proporcji ${img.missing}`);

const cities = {};
for (const e of events) cities[e.city] = (cities[e.city] || 0) + 1;

const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, events.filter(e => e.category === c).length]));

if (!events.length) {
  console.error('Brak wydarzeń — nie nadpisuję pliku.');
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
const head = JSON.stringify({
  updatedAt: new Date().toISOString(),
  count: events.length,
  sources: report,
  cities: Object.fromEntries(Object.entries(cities).sort((a, b) => b[1] - a[1])),
  categories: byCategory,
  // położenie miast na mapie (public/data/poland.json): [x, y, indeks województwa]
  geo: await cityGeo(Object.keys(cities), join(HERE, 'data', 'places.json'), join(HERE, '..', 'public', 'data', 'poland.json'))
});
// jedno wydarzenie na linię — małe diffy w gicie przy commitach co 4h
await writeFile(OUT, head.slice(0, -1) + ',"events":[\n' + events.map(e => JSON.stringify(e)).join(',\n') + '\n]}\n');

console.log(`\nSurowe: ${raw.length} → po filtrze: ${valid.length} → po złączeniu duplikatów: ${events.length}`);
console.log('Miasta (top 10):', Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c} ${n}`).join(', '));
console.log('Kategorie:', Object.entries(byCategory).map(([c, n]) => `${c} ${n}`).join(', '));
