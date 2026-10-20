/* Pipeline +1: pobiera wydarzenia ze wszystkich źródeł, czyści, łączy duplikaty,
   sortuje i zapisuje data/events.json (to czyta aplikacja).
   Uruchomienie: node pipeline/run.mjs [--only=ra,going] */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowLocal, CATEGORIES } from './lib/normalize.mjs';
import { dedup } from './lib/dedup.mjs';
import ra from './sources/ra.mjs';
import going from './sources/going.mjs';
import ebilet from './sources/ebilet.mjs';

const SOURCES = { going, ebilet, ra };
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'events.json');

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
    report[name] = { ok: false, error: e.message };
    console.error(`✗ ${name}: ${e.message}`);
  }
}

const now = nowLocal();
const today = now.slice(0, 10);
const valid = raw.filter(e =>
  e.title && e.start && e.city && e.links[0].url &&
  // odrzuć minione: koniec (albo start) przed dziś
  (e.end || e.start).slice(0, 10) >= today
);

const events = dedup(valid).sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));

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
  categories: byCategory
});
// jedno wydarzenie na linię — małe diffy w gicie przy commitach co 4h
await writeFile(OUT, head.slice(0, -1) + ',"events":[\n' + events.map(e => JSON.stringify(e)).join(',\n') + '\n]}\n');

console.log(`\nSurowe: ${raw.length} → po filtrze: ${valid.length} → po złączeniu duplikatów: ${events.length}`);
console.log('Miasta (top 10):', Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c} ${n}`).join(', '));
console.log('Kategorie:', Object.entries(byCategory).map(([c, n]) => `${c} ${n}`).join(', '));
