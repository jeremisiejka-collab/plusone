/* „Plan na noc”: lokale w pobliżu miejsca wydarzenia (restauracje, bary, puby, kawiarnie) z OpenStreetMap.
   GET /api/nearby?a=<adres>&c=<miasto>&v=<nazwa miejsca> → { food: [{ name, kind, street, lat, lon, city, min }] (do 24, od najbliższych), at: { lat, lon } miejsca wydarzenia }
   Adres zamieniamy na współrzędne i szukamy lokali w pobliżu w Nominatim (Overpass nie odpowiada serwerom Cloudflare); wynik trzymamy w pamięci podręcznej Cloudflare
   przez 7 dni (zasady obu darmowych serwisów: mało zapytań, z identyfikacją aplikacji). */
const UA = { 'User-Agent': 'plusoneapp.pl/1.0 (+https://plusoneapp.pl)', 'Accept-Language': 'pl' };
// rodzaje lokali (Nominatim, specjalne frazy [restaurant] itd.)
const KINDS = ['restaurant', 'bar', 'pub', 'cafe', 'fast_food', 'nightclub'];
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

export async function nearby(req, env, json) {
  const url = new URL(req.url), p = k => (url.searchParams.get(k) || '').trim().slice(0, 160);
  const addr = p('a'), city = p('c'), venue = p('v');
  if (!city || (!addr && !venue)) return json({ error: 'Brak adresu.' }, 400);
  // Nominatim nie rozpoznaje „ul. Batorego 10” ani kodów pocztowych — oczyszczony adres, potem nazwa miejsca z miastem
  const clean = addr.replace(/\b\d{2}-\d{3}\b/g, '').replace(/\b(ul|al|pl|os|ulica|aleja|plac|osiedle)\.?\s+/gi, '').split(',').map(x => x.trim())
    .filter(x => x && fold(x) !== fold(city) && !/^(polska|poland)$/i.test(x))[0];
  const queries = [...new Set([clean && clean + ', ' + city, venue && venue + ', ' + city].filter(Boolean))];
  const key = new Request('https://plusoneapp.pl/api/nearby?v=3&k=' + encodeURIComponent(fold(queries.join('|'))));
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  let food = [], at = null;
  try {
    let g = [];
    for (const q of queries) {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pl&q=' + encodeURIComponent(q), { headers: UA });
      if (!r.ok) throw new Error('nominatim ' + r.status);
      g = await r.json();
      if (g[0]) break;
    }
    if (g[0]) {
      const lat = +g[0].lat, lon = +g[0].lon;
      at = { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
      // lokale w prostokącie ok. 1 km wokół miejsca: Nominatim (Overpass nie odpowiada serwerom Cloudflare); odstęp 1,1 s — zasady Nominatim
      const vb = [lon - 0.007, lat + 0.0045, lon + 0.007, lat - 0.0045].map(x => x.toFixed(5)).join(',');
      const els = [];
      for (const kind of KINDS) {
        await new Promise(r => setTimeout(r, 1100));
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=20&bounded=1&viewbox=${vb}&q=%5B${kind}%5D`, { headers: UA });
        if (!r.ok) { if (els.length) break; throw new Error('nominatim ' + r.status); }
        for (const x of await r.json()) els.push({ type: x.osm_type, id: x.osm_id, lat: +x.lat, lon: +x.lon,
          tags: { name: x.name, amenity: x.type }, street: [x.address?.road, x.address?.house_number].filter(Boolean).join(' ') });
      }
      const o = { elements: els };
      const R = 6371e3, rad = x => x * Math.PI / 180;
      const dist = (a, b) => { const dp = rad(a - lat), dl = rad(b - lon); return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(a)) * Math.sin(dl / 2) ** 2)); };
      const own = fold(venue).split(/\s+/).filter(w => w.length > 3)[0];
      const seen = new Set();
      food = (o.elements || []).map(x => ({ name: x.tags?.name, kind: x.tags?.amenity, street: x.street, lat: +x.lat.toFixed(6), lon: +x.lon.toFixed(6), d: dist(x.lat, x.lon) }))
        .filter(x => x.name && KINDS.includes(x.kind) && isFinite(x.d) && x.d > 25 && !(own && fold(x.name).includes(own)))
        .sort((a, b) => a.d - b.d).filter(x => { const k = fold(x.name) + '|' + fold(x.street); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 24).map(({ d, ...x }) => ({ ...x, city, min: Math.max(1, Math.round(d / 75)) }));
    }
  } catch (e) {
    return json({ food: [], error: 'Mapa chwilowo nie odpowiada.', detail: String(e?.message || e).slice(0, 80) }, 502, { 'Cache-Control': 'no-store' });
  }
  // pusty wynik pamiętamy krócej (dobę), pełny — tydzień
  const res = json({ food, at }, 200, { 'Cache-Control': `public, max-age=${food.length ? 604800 : 86400}` });
  try { await cache.put(key, res.clone()); } catch { /* bez pamięci podręcznej (np. lokalnie) */ }
  return res;
}
