/* Podgląd linku do wydarzenia i miejsca (Messenger, WhatsApp, Facebook, X): /e/<id> i /miejsce/<nazwa>.
   Roboty tych serwisów nie uruchamiają JavaScriptu, więc wstawiamy tytuł, datę, miejsce i plakat prosto do HTML strony
   (dane z public/data/og/<xx>.json, zapisywane przez pipeline/lib/og.mjs). Przeglądarka dostaje tę samą stronę,
   a skrypt strony sam otwiera wydarzenie albo miejsce z adresu. */
const ogShard = k => { let h = 2166136261; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) & 255).toString(16).padStart(2, '0'); };
const SITE = 'https://plusoneapp.pl';

export async function sharePage(req, env, url) {
  const m = url.pathname.match(/^\/(e|miejsce)\/([^/]+)\/?$/);
  const page = await env.ASSETS.fetch(new Request(new URL('/', url)));
  if (!m) return page;
  let key;
  try { key = m[1] === 'e' ? decodeURIComponent(m[2]) : 'v:' + decodeURIComponent(m[2]); } catch { return page; }
  let rec = null;
  try {
    const r = await env.ASSETS.fetch(new Request(new URL(`/data/og/${ogShard(key)}.json`, url)));
    if (r.ok) rec = (await r.json())[key] || null;
  } catch { /* bez danych — zwykła strona */ }
  if (!rec) return page;
  let title, desc, image;
  if (m[1] === 'e') {
    const [t, when, venue, city, img, price] = rec;
    title = `${t} · ${venue || city}`;
    desc = `${when.charAt(0).toUpperCase() + when.slice(1)} · ${[venue, city].filter(Boolean).join(', ')}${price > 0 ? ` · bilety od ${Math.round(price)} zł` : price === 0 ? ' · wstęp wolny' : ''}`;
    image = img;
  } else {
    const [name, city, n, img, next] = rec;
    title = `${name} · ${city}`;
    desc = `${n} ${n === 1 ? 'nadchodzące wydarzenie' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'nadchodzące wydarzenia' : 'nadchodzących wydarzeń'} · najbliższe: ${next}`;
    image = img;
  }
  const canonical = SITE + url.pathname;
  const set = v => ({ element(el) { el.setAttribute('content', v); } });
  const out = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title + ' | +1'); } })
    .on('meta[name="description"]', set(desc))
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', canonical); } })
    .on('meta[property="og:type"]', set(m[1] === 'e' ? 'article' : 'place'))
    .on('meta[property="og:url"]', set(canonical))
    .on('meta[property="og:title"]', set(title))
    .on('meta[property="og:description"]', set(desc))
    .on('meta[property="og:image"]', set(image || SITE + '/og.png'))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[name="twitter:description"]', set(desc))
    .on('meta[name="twitter:image"]', set(image || SITE + '/og.png'))
    .transform(page);
  const res = new Response(out.body, out);
  res.headers.set('Cache-Control', 'public, max-age=300');
  return res;
}
