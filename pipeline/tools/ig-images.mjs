/* Grafiki dla Instagrama: pochodna JPEG dokładnie tego plakatu, który widzi użytkownik (e.image).
   Meta przyjmuje tylko JPEG o proporcjach od 4:5 do 1,91:1, a większość plakatów to WebP 3:4.
   Nie obcinamy treści plakatu: zmniejszamy do szerokości 1080 px, a gdy proporcje wychodzą poza zakres,
   dokładamy jednolite tło w kolorze plakatu (bez rozmycia i gradientu) tylko tyle, ile wymaga Meta.

   Uruchomienie (events.yml, po pobraniu wydarzeń):  node pipeline/tools/ig-images.mjs
     pyta https://plusoneapp.pl/api/ig/wanted, zapisuje public/ig/<klucz>.jpg i usuwa pliki już niepotrzebne.
   Podgląd jednego wydarzenia:  node pipeline/tools/ig-images.mjs --event=<id> [--out=katalog]
   Wymaga pakietu sharp (w Actions: npm install --no-save sharp). */
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'public', 'ig');
const SITE = process.env.SITE || 'https://plusoneapp.pl';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const UA = 'Mozilla/5.0 (compatible; plusoneapp.pl; +https://plusoneapp.pl)';

export const imageKey = src => createHash('sha256').update(String(src)).digest('hex').slice(0, 24);
const MIN_R = 4 / 5, MAX_R = 1.91, W = 1080, MAX_BYTES = 8 * 1024 * 1024;

/* rozmiar płótna: proporcje plakatu, chyba że wychodzą poza zakres Meta */
export function canvasFor(w, h) {
  const r = w / h;
  // zaokrąglenie wysokości nie może wypchnąć proporcji poza zakres (1080×565 = 1,9115 > 1,91)
  const hMin = Math.ceil(W / MAX_R), hMax = Math.floor(W / MIN_R);
  if (r < MIN_R) return { width: W, height: hMax, pad: true };
  if (r > MAX_R) return { width: W, height: hMin, pad: true };
  return { width: W, height: Math.min(hMax, Math.max(hMin, Math.round(W / r))), pad: false };
}

export async function render(sharp, buf) {
  const img = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const w = meta.autoOrient?.width || meta.width, h = meta.autoOrient?.height || meta.height;
  if (!w || !h) throw new Error('nieczytelny obraz');
  const c = canvasFor(w, h);
  // kolor tła = dominujący kolor plakatu (jednolity, bez rozmycia)
  const { dominant } = await sharp(buf, { failOn: 'none' }).stats();
  const bg = { r: dominant.r, g: dominant.g, b: dominant.b, alpha: 1 };
  let q = 90, out;
  do {
    out = await sharp(buf, { failOn: 'none' }).rotate()
      .resize(c.width, c.height, { fit: 'contain', background: bg, withoutEnlargement: false })
      .flatten({ background: bg }).toColourspace('srgb')
      .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
    q -= 8;
  } while (out.length > MAX_BYTES && q > 50);
  return { buf: out, width: c.width, height: c.height, padded: c.pad, source: { width: w, height: h, format: meta.format } };
}

async function download(src) {
  const r = await fetch(src, { headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const { default: sharp } = await import('sharp');
  const one = arg('event');
  if (one) {
    const data = JSON.parse(await readFile(join(ROOT, 'public', 'data', 'events.json'), 'utf8'));
    const e = data.events.find(x => x.id === one);
    if (!e?.image) throw new Error('Brak wydarzenia albo plakatu: ' + one);
    const dir = arg('out') || OUT;
    await mkdir(dir, { recursive: true });
    const r = await render(sharp, await download(e.image));
    const file = join(dir, imageKey(e.image) + '.jpg');
    await writeFile(file, r.buf);
    console.log(JSON.stringify({ id: e.id, image: e.image, file, width: r.width, height: r.height, padded: r.padded, bytes: r.buf.length, source: r.source }));
    return;
  }
  const res = await fetch(SITE + '/api/ig/wanted', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) { console.log('ig-images: /api/ig/wanted → HTTP ' + res.status + ' (pomijam)'); return; }
  const { render: todo = [], keep = [] } = await res.json();
  await mkdir(OUT, { recursive: true });
  let made = 0;
  for (const t of todo) {
    if (!/^[0-9a-f]{24}$/.test(t.key) || imageKey(t.src) !== t.key) { console.log('ig-images: zły klucz', t.key); continue; }
    try {
      const r = await render(sharp, await download(t.src));
      await writeFile(join(OUT, t.key + '.jpg'), r.buf);
      made++;
      console.log(`ig-images: ${t.key}.jpg ${r.width}×${r.height}${r.padded ? ' (tło do proporcji Meta)' : ''}, ${Math.round(r.buf.length / 1024)} KB`);
    } catch (e) { console.log('ig-images: nie udało się', t.src, e.message); }
  }
  // sprzątanie: zostają tylko grafiki zadań w toku i świeżo opublikowanych
  const want = new Set([...keep, ...todo.map(t => t.key)]);
  let removed = 0;
  for (const f of await readdir(OUT).catch(() => [])) {
    const k = f.replace(/\.jpg$/, '');
    if (f.endsWith('.jpg') && !want.has(k)) { await unlink(join(OUT, f)); removed++; }
  }
  console.log(`ig-images: nowe ${made}, usunięte ${removed}, w kolejce ${want.size}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error('ig-images:', e.message); process.exitCode = 1; });
