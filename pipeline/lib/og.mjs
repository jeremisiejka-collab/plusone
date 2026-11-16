/* Dane do podglądu linków (Messenger, WhatsApp, Facebook): tytuł, data, miejsce i plakat każdego wydarzenia i miejsca.
   Serwer (worker/share.js) wstawia je do strony pod /e/<id> i /miejsce/<nazwa>, bo roboty serwisów nie uruchamiają JavaScriptu.
   Zapis w 256 małych plikach public/data/og/<xx>.json (xx = skrót klucza), żeby serwer nie czytał całego events.json. */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';

export const ogShard = k => { let h = 2166136261; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) & 255).toString(16).padStart(2, '0'); };
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const slugify = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
/* to samo co venueSlug() w public/index.html */
export const venueSlug = (venue, city) => slugify(venue) + (fold(venue).includes(fold(city)) ? '' : '-' + slugify(city));
const DNI = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MIES = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const when = s => { const d = new Date(s.slice(0, 10) + 'T12:00:00Z'), t = s.slice(11, 16); return `${DNI[d.getUTCDay()]}, ${d.getUTCDate()} ${MIES[d.getUTCMonth()]}${t && t !== '00:00' ? ', ' + t : ''}`; };

export async function writeOg(events, dir) {
  const shards = {};
  const put = (k, v) => { (shards[ogShard(k)] ||= {})[k] = v; };
  const venues = new Map();
  // Facebook i Messenger nie pokazują obrazów AVIF — wtedy podgląd bez plakatu (logo +1)
  const ok = u => u && !/\.avif(\?|$)/i.test(u) ? u : '';
  for (const e of events) {
    put(e.id, [e.title, when(e.start), e.venue || '', e.city, ok(e.image), e.priceFrom ?? null]);
    const v = e.venue || e.city;
    if (!e.venue || v === e.city || /^(tba|tbc|online)\b/i.test(v)) continue;
    const k = 'v:' + venueSlug(v, e.city), o = venues.get(k) || { name: v, city: e.city, n: 0, img: '', photo: '', next: e.start };
    o.n++; if (!o.img && ok(e.image)) o.img = e.image; if (!o.photo && e.image?.includes('/img/obiekty/')) o.photo = e.image; if (e.start < o.next) o.next = e.start;
    venues.set(k, o);
  }
  for (const [k, o] of venues) put(k, [o.name, o.city, o.n, o.photo || o.img, when(o.next)]);
  await mkdir(dir, { recursive: true });
  const keep = new Set(Object.keys(shards).map(s => s + '.json'));
  for (const f of await readdir(dir)) if (!keep.has(f)) await rm(new URL(f, dir));
  for (const [s, obj] of Object.entries(shards)) await writeFile(new URL(s + '.json', dir), JSON.stringify(obj));
  return { events: events.length, venues: venues.size, files: keep.size };
}
