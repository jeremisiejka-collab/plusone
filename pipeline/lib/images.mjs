/* Proporcje grafik: aplikacja dopasowuje kształt karty do plakatu (bez przycinania i bez rozmytych pasów),
   więc dla każdej grafiki zapisujemy imageRatio = szerokość / wysokość.
   Wymiary czytamy z nagłówka pliku (pierwsze ~64 KB), wyniki z poprzedniego przebiegu są ponownie używane. */

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
    if (!res.ok) return { ok: false };
    // czytamy tylko początek pliku
    const reader = res.body.getReader(), parts = []; let n = 0;
    while (n < 65536) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
    reader.cancel().catch(() => {});
    const d = dimensions(Buffer.concat(parts));
    return { ok: true, ratio: d && d[0] > 0 && d[1] > 0 ? +(d[0] / d[1]).toFixed(3) : null };
  } catch { return { ok: false }; }
}

/* uzupełnia e.imageRatio; zwraca liczbę zmierzonych grafik */
export async function measureImages(events, prevEvents, { concurrency = 16, budgetMs = 6 * 60e3 } = {}) {
  const known = new Map(prevEvents.filter(e => e.image && e.imageRatio).map(e => [e.image, e.imageRatio]));

  // czy Cloudinary pozwala na grafikę bez przycinania? sprawdzamy na jednej; jeśli nie — zostaje 800×600
  const sample = events.find(e => e.image?.includes(CLOUD_FULL));
  if (sample && !known.has(sample.image) && !(await probe(sample.image)).ok) {
    console.warn('Cloudinary nie zwraca grafik bez przycinania — zostaję przy 800×600');
    for (const e of events) if (e.image?.includes(CLOUD_FULL)) e.image = e.image.replace(CLOUD_FULL, CLOUD_CROP);
  }

  const todo = [...new Set(events.filter(e => e.image && !known.has(e.image)).map(e => e.image))];
  const t0 = Date.now(); let measured = 0, i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < todo.length && Date.now() - t0 < budgetMs) {
      const url = todo[i++];
      const crop = url.match(/c_fill,w_(\d+),h_(\d+)/);
      const r = crop ? { ratio: +(crop[1] / crop[2]).toFixed(3) } : await probe(url);
      if (r.ratio) { known.set(url, r.ratio); measured++; }
    }
  }));
  for (const e of events) if (e.image && known.has(e.image)) e.imageRatio = known.get(e.image);
  return { measured, missing: events.filter(e => e.image && !e.imageRatio).length };
}
