/* Położenie miast na mapie: współrzędne z GeoNames (pipeline/data/places.json),
   rzut taki sam jak w public/data/poland.json, województwo z punktu w wielokącie. */
import { readFile } from 'node:fs/promises';

const fold = s => String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* { miasto: [x, y, indeks województwa, lat, lon] } dla miast, które da się znaleźć w Polsce */
export async function cityGeo(cities, placesPath, mapPath) {
  const places = JSON.parse(await readFile(placesPath, 'utf8'));
  const map = JSON.parse(await readFile(mapPath, 'utf8'));
  const { lon0, lat0, k, minx, miny, s, pad } = map.proj;
  const out = {};
  for (const city of cities) {
    const p = places[fold(city)];
    if (!p) continue;
    const x = +(((p[1] - lon0) * k - minx) * s + pad).toFixed(1);
    const y = +((-(p[0] - lat0) - miny) * s + pad).toFixed(1);
    // wyspy i zatoki: liczy się dowolny pierścień zewnętrzny regionu
    const region = map.regions.findIndex(r => r.rings.some(ring => inRing(x, y, ring)));
    // [x, y] — punkt na mapie SVG, region — województwo, [lat, lon] — prawdziwe współrzędne (mapa z przybliżaniem w aplikacji)
    if (region >= 0) out[city] = [x, y, region, p[0], p[1]];
  }
  return out;
}
