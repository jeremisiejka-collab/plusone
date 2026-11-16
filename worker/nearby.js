/* „Plan na noc”: lokale w pobliżu miejsca wydarzenia (restauracje, bary, puby, kawiarnie) z OpenStreetMap.
   GET /api/nearby?a=<adres>&c=<miasto>&v=<nazwa miejsca> → { food: [{ name, kind, min, type, id }] }
   Adres zamieniamy na współrzędne w Nominatim, lokale bierzemy z Overpass; wynik trzymamy w pamięci podręcznej Cloudflare
   przez 7 dni (zasady obu darmowych serwisów: mało zapytań, z identyfikacją aplikacji). */
const UA = { 'User-Agent': 'plusoneapp.pl/1.0 (+https://plusoneapp.pl)', 'Accept-Language': 'pl' };
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

export async function nearby(req, env, json) {
  const url = new URL(req.url), p = k => (url.searchParams.get(k) || '').trim().slice(0, 160);
  const addr = p('a'), city = p('c'), venue = p('v');
  if (!city || (!addr && !venue)) return json({ error: 'Brak adresu.' }, 400);
  // Nominatim nie rozpoznaje „ul. Batorego 10” ani kodów pocztowych — oczyszczony adres, potem nazwa miejsca z miastem
  const clean = addr.replace(/\b\d{2}-\d{3}\b/g, '').replace(/\b(ul|al|pl|os|ulica|aleja|plac|osiedle)\.?\s+/gi, '').split(',').map(x => x.trim())
    .filter(x => x && fold(x) !== fold(city) && !/^(polska|poland)$/i.test(x))[0];
  const queries = [...new Set([clean && clean + ', ' + city, venue && venue + ', ' + city].filter(Boolean))];
  const key = new Request('https://plusoneapp.pl/api/nearby?k=' + encodeURIComponent(fold(queries.join('|'))));
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  let food = [];
  try {
    let g = [];
    for (const q of queries) {
      g = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pl&q=' + encodeURIComponent(q), { headers: UA })).json();
      if (g[0]) break;
    }
    if (g[0]) {
      const lat = +g[0].lat, lon = +g[0].lon;
      const oq = `[out:json][timeout:15];(nwr(around:700,${lat},${lon})[amenity~"^(restaurant|bar|pub|cafe|biergarten)$"][name];);out center 60;`;
      const o = await (await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(oq) })).json();
      const R = 6371e3, rad = x => x * Math.PI / 180;
      const dist = (a, b) => { const dp = rad(a - lat), dl = rad(b - lon); return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(a)) * Math.sin(dl / 2) ** 2)); };
      const own = fold(venue).split(/\s+/).filter(w => w.length > 3)[0];
      const seen = new Set();
      food = (o.elements || []).map(x => ({ type: x.type, id: x.id, name: x.tags?.name, kind: x.tags?.amenity, d: dist(x.lat ?? x.center?.lat, x.lon ?? x.center?.lon) }))
        .filter(x => x.name && isFinite(x.d) && x.d > 25 && !(own && fold(x.name).includes(own)))
        .sort((a, b) => a.d - b.d).filter(x => { const k = fold(x.name); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 3).map(({ d, ...x }) => ({ ...x, min: Math.max(1, Math.round(d / 75)) }));
    }
  } catch (e) {
    return json({ food: [], error: 'Mapa chwilowo nie odpowiada.' }, 502, { 'Cache-Control': 'no-store' });
  }
  // pusty wynik pamiętamy krócej (dobę), pełny — tydzień
  const res = json({ food }, 200, { 'Cache-Control': `public, max-age=${food.length ? 604800 : 86400}` });
  try { await cache.put(key, res.clone()); } catch { /* bez pamięci podręcznej (np. lokalnie) */ }
  return res;
}
