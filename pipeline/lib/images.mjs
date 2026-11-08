/* Proporcje grafik: aplikacja dopasowuje kształt karty do plakatu (bez przycinania i bez rozmytych pasów),
   więc dla każdej grafiki zapisujemy imageRatio = szerokość / wysokość.
   Wymiary czytamy z nagłówka pliku (pierwsze ~64 KB), wyniki z poprzedniego przebiegu są ponownie używane. */

import { readFile, writeFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (compatible; plusone-events-bot/1.0; +https://github.com/jeremisiejka-collab/plusone)';

/* Going (Cloudinary): oryginalne proporcje zamiast wymuszonego przycięcia 800×600 */
export const CLOUD_FULL = 'c_limit,w_1000,q_auto,f_auto';
export const CLOUD_CROP = 'c_fill,w_800,h_600,q_auto,f_auto';

/* szerokość i wysokość z nagłówka PNG / GIF / JPEG / WebP */
export function dimensions(b) {
  const u16 = i => b[i] << 8 | b[i + 1], le16 = i => b[i] | b[i + 1] << 8, le24 = i => b[i] | b[i + 1] << 8 | b[i + 2] << 16;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return [le16(6), le16(8)];
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return [le24(24) + 1, le24(27) + 1];
    if (kind === 'VP8 ') return [le16(26) & 0x3fff, le16(28) & 0x3fff];
    if (kind === 'VP8L') { const n = b.readUInt32LE(21); return [(n & 0x3fff) + 1, (n >> 14 & 0x3fff) + 1]; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [u16(i + 7), u16(i + 5)];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

async function probe(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-65535', Accept: 'image/avif,image/webp,image/*' }, signal: AbortSignal.timeout(10000) });
    // 404/410 = grafika usunięta u źródła (pusta ramka w aplikacji); inne błędy traktujemy jako chwilowe
    if (!res.ok) return { ok: false, dead: res.status === 404 || res.status === 410 };
    // czytamy tylko początek pliku
    const reader = res.body.getReader(), parts = []; let n = 0;
    while (n < 65536) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
    reader.cancel().catch(() => {});
    const d = dimensions(Buffer.concat(parts));
    return { ok: true, size: d && d[0] > 0 && d[1] > 0 ? d : null };
  } catch { return { ok: false }; }
}

/* Ocena grafiki do kart 3:4 / 4:3 i do postów: rozdzielczość + proporcje.
   null = nie nadaje się (usunięta, miniatura, wąski pasek). */
export const MIN_SIDE = 280;
export function imageScore(size) {
  if (!size) return 0.4;                                  // nie udało się zmierzyć — zostawiamy, ale bez pierwszeństwa
  const [w, h] = size, r = w / h, short = Math.min(w, h);
  if (!w || !h) return null;                              // usunięta u źródła
  if (short < MIN_SIDE || r > 3.2 || r < 0.33) return null;
  let s = Math.min(short, 1100) / 1100;                   // ostrość na telefonie i w poście 1080 px
  if ((r >= 0.62 && r <= 0.85) || (r >= 1.2 && r <= 1.6)) s += 0.5;   // plakat pionowy albo poziomy kadr
  else if (r > 0.85 && r < 1.2) s += 0.3;                 // kwadrat — przycięcie do 3:4 / 4:3 zabiera mało
  else if (r > 2.1 || r < 0.55) s -= 0.4;                 // baner — z karty zostaje wąski wycinek
  return s;
}

const SIZES = new URL('../data/image-sizes.json', import.meta.url);
const REVIEW = new URL('../data/image-review.json', import.meta.url);
const today = () => new Date().toISOString().slice(0, 10);

/* Wybiera najładniejszą grafikę wydarzenia (plakat, baner, grafiki z innych źródeł), odrzuca usunięte i miniatury,
   stosuje oceny z przeglądu (pipeline/data/image-review.json — agent zdjęć) i uzupełnia e.imageRatio.
   Wymiary pamiętamy w pipeline/data/image-sizes.json ([szer, wys] albo [0, 0, dzień] dla usuniętych). */
export async function measureImages(events, prevEvents, { concurrency = 16, budgetMs = 6 * 60e3 } = {}) {
  let cache = {};
  try { cache = JSON.parse(await readFile(SIZES, 'utf8')); } catch { /* pierwszy przebieg */ }
  let review = {};
  try { review = JSON.parse(await readFile(REVIEW, 'utf8')); } catch { /* brak przeglądu */ }
  const bad = review.bad || {}, forced = review.events || {};
  const known = new Map(Object.entries(cache).filter(([, v]) => !(v[0] === 0 && v[2] && Date.now() - Date.parse(v[2]) > 3 * 864e5)));
  // stare pliki bez wymiarów: proporcje z poprzedniego events.json (zastąpione pomiarem, gdy się uda)
  const prevRatio = new Map(prevEvents.filter(e => e.image && e.imageRatio).map(e => [e.image, e.imageRatio]));

  // czy Cloudinary pozwala na grafikę bez przycinania? sprawdzamy na jednej; jeśli nie — zostaje 800×600
  const sample = events.find(e => e.image?.includes(CLOUD_FULL));
  if (sample && !known.has(sample.image) && !(await probe(sample.image)).ok) {
    console.warn('Cloudinary nie zwraca grafik bez przycinania — zostaję przy 800×600');
    const fix = u => u?.replace(CLOUD_FULL, CLOUD_CROP);
    for (const e of events) { e.image = fix(e.image); e.alts = (e.alts || []).map(fix); }
  }

  const candidates = e => [...new Set([forced[e.id], e.image, ...(e.alts || [])].filter(Boolean))];
  // najpierw grafiki główne (od nich zależy wygląd kart), potem zapasowe
  const todo = [...new Set([...events.map(e => e.image), ...events.flatMap(e => e.alts || [])].filter(u => u && !known.has(u)))];
  const t0 = Date.now(); let measured = 0, i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < todo.length && Date.now() - t0 < budgetMs) {
      const url = todo[i++];
      const r = await probe(url);
      if (r.size) { known.set(url, r.size); measured++; }
      else if (r.dead) known.set(url, [0, 0, today()]);
    }
  }));

  const inUse = new Set(events.flatMap(candidates));
  let swapped = 0, dropped = 0;
  for (const e of events) {
    const list = candidates(e);
    const scored = list.map((u, k) => {
      if (bad[u]) return { u, s: null };
      if (forced[e.id] === u) return { u, s: 9 };
      const size = known.get(u);
      return { u, s: imageScore(size) == null ? null : imageScore(size) + (k === 0 ? 0.08 : 0) };   // przy remisie zostaje grafika ze źródła
    }).filter(x => x.s != null).sort((a, b) => b.s - a.s);
    const best = forced[e.id] === null ? null : scored[0]?.u || null;
    if (e.image && best !== e.image) best ? swapped++ : dropped++;
    e.image = best;
    delete e.alts;
    const size = best && known.get(best);
    if (size?.[0]) e.imageRatio = +(size[0] / size[1]).toFixed(3);
    else if (best) {
      const crop = best.match(/c_fill,w_(\d+),h_(\d+)/);
      e.imageRatio = crop ? +(crop[1] / crop[2]).toFixed(3) : prevRatio.get(best);
    }
    if (!e.image || !e.imageRatio) delete e.imageRatio;
  }

  // pamięć wymiarów tylko dla grafik, które jeszcze występują w wydarzeniach (plik nie rośnie bez końca)
  const keep = {};
  for (const u of [...inUse].sort()) if (known.has(u)) keep[u] = known.get(u);
  // jedna grafika na linię — małe zmiany w gicie przy cogodzinnych commitach
  await writeFile(SIZES, '{\n' + Object.entries(keep).map(([u, v]) => JSON.stringify(u) + ':' + JSON.stringify(v)).join(',\n') + '\n}\n');
  return { measured, swapped, dropped, missing: events.filter(e => e.image && !e.imageRatio).length, sizes: known };
}
