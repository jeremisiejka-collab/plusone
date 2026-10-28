// Buduje dane modułu „Obiekty 3D” (public/admin/moduly/venue-3d/) w formacie EXPO_DATA z modułu Mapa targów 3D.
// PGE Narodowy: sektory, loże i bramy z public/data/venues.json (oficjalna mapa obiektu).
// COS Torwar: układ 30 sektorów A–Z w 4 trybunach i płyta 63 × 33 m według specyfikacji technicznej COS
// (torwar.cos.pl/pl/2831/specyfikacja-techniczna-obiektu-cos-torwar). Kształt trybun jest poglądowy.
// Uruchom: node pipeline/venue3d/build.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../../public/admin/moduly/venue-3d/', import.meta.url);
const r1 = n => Math.round(n * 10) / 10;
const bbox = poly => {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x: r1(x), y: r1(y), w: r1(Math.max(...xs) - x), h: r1(Math.max(...ys) - y) };
};
const centre = poly => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);

/* ---------- PGE Narodowy ---------- */
async function pge() {
  const v = JSON.parse(await readFile(new URL('../../public/data/venues.json', import.meta.url), 'utf8'));
  const venue = (Array.isArray(v) ? v : v.venues).find(x => x.id === 'pge-narodowy');
  const hall = venue.halls[0];
  const LV = Object.fromEntries(hall.levels.map(l => [l.id, l]));
  const H3 = { lower: 1.3, vip1: 2.3, vip2: 2.7, upper: 3.9 };
  const gateName = g => 'Brama ' + g.n;
  const near = c => hall.gates.map(g => [Math.hypot(g.x - c[0], g.y - c[1]), g]).sort((a, b) => a[0] - b[0])[0][1];
  const booths = hall.sectors.map(s => {
    const poly = [];
    for (let i = 0; i < s.p.length; i += 2) poly.push([s.p[i], s.p[i + 1]]);
    const lv = LV[s.level] || { name: s.level, floor: '' }, g = near(centre(poly));
    return {
      id: s.id.startsWith('loza-') ? s.name : s.id,
      ...bbox(poly), polygon: poly, name: s.name, area: null, hall: lv.name, floor: lv.floor ? lv.floor[0].toUpperCase() + lv.floor.slice(1) : lv.name,
      gate: gateName(g), info: lv.name + ' · ' + (lv.floor || '') + ' · najbliżej: ' + gateName(g) + '.',
      h3: H3[s.level] || 1.5, confidence: 'source', nameConfidence: 'source',
      sourceNote: 'Obrys sektora przerysowany z oficjalnej mapy PGE Narodowego. Najbliższa brama liczona po odległości na planie — numer bramy zawsze sprawdzaj na bilecie.'
    };
  });
  const [px1, py1, px2, py2] = hall.pitch;
  const zones = [
    { name: 'Płyta', x: px1, y: py1, w: px2 - px1, h: py2 - py1, type: 'pitch' },
    ...hall.gates.map(g => {
      const side = g.x < 110 || g.x > 560;
      return { name: gateName(g), sign: 'BRAMA ' + g.n, x: g.x - (side ? 6 : 15), y: g.y - (side ? 15 : 6), w: side ? 12 : 30, h: side ? 30 : 12, type: 'entrance' };
    }),
    // gastronomia i toalety są w korytarzach każdej trybuny; tu jako punkty orientacyjne przy narożnikach
    { name: 'Bar płn.-zach.', x: 40, y: 30, w: 46, h: 20, type: 'food' },
    { name: 'Toalety płn.-zach.', x: 40, y: 56, w: 30, h: 16, type: 'wc' },
    { name: 'Bar płn.-wsch.', x: 574, y: 30, w: 46, h: 20, type: 'food' },
    { name: 'Toalety płn.-wsch.', x: 590, y: 56, w: 30, h: 16, type: 'wc' },
    { name: 'Bar płd.-wsch.', x: 574, y: 512, w: 46, h: 20, type: 'food' },
    { name: 'Toalety płd.-wsch.', x: 590, y: 490, w: 30, h: 16, type: 'wc' },
    { name: 'Bar płd.-zach.', x: 40, y: 512, w: 46, h: 20, type: 'food' },
    { name: 'Toalety płd.-zach.', x: 40, y: 490, w: 30, h: 16, type: 'wc' }
  ];
  return {
    id: 'pge', title: 'Cały stadion', event: 'PGE Narodowy', eventId: 'pge',
    source: 'Oficjalna mapa PGE Narodowego (pgenarodowy.pl) — własny rysunek', sourceImage: 'assets/pge-plan.svg',
    width: hall.w, height: hall.h, sourceWidth: hall.w, sourceHeight: hall.h, bounds: { x: 0, y: 0, w: hall.w, h: hall.h },
    badge: 'AL. KS. J. PONIATOWSKIEGO 1 / PLAN POGLĄDOWY', booths, zones, levels: hall.levels,
    notes: [
      'Sektory, loże (101–141, Książęca, Platynowa, Biała, 201–230) i bramy 1–6, 10, 11 według oficjalnej mapy obiektu.',
      'Wysokość bryły pokazuje poziom: trybuna dolna, loże +1, loże +2, trybuna górna.',
      ...hall.levels.map(l => l.name + ' (' + l.floor + '): ' + l.has.join('; ') + '.'),
      'Gastronomia i toalety są w korytarzach każdej trybuny — na mapie zaznaczone orientacyjnie przy narożnikach.',
      hall.note
    ]
  };
}

/* ---------- COS Torwar ---------- */
// zaokrąglony prostokąt: punkt i normalna dla długości łuku s (start: środek lewego boku, w górę = zgodnie z zegarem)
function ring(cx, cy, hw, hh, r) {
  const L = hh - r, T = 2 * (hw - r), A = Math.PI * r / 2, V = 2 * (hh - r);
  const segs = [
    { len: L, at: t => [[cx - hw, cy - t], [-1, 0]] },
    { len: A, at: t => { const a = Math.PI + t / r; return [[cx - hw + r + r * Math.cos(a), cy - hh + r + r * Math.sin(a)], [Math.cos(a), Math.sin(a)]]; } },
    { len: T, at: t => [[cx - hw + r + t, cy - hh], [0, -1]] },
    { len: A, at: t => { const a = 1.5 * Math.PI + t / r; return [[cx + hw - r + r * Math.cos(a), cy - hh + r + r * Math.sin(a)], [Math.cos(a), Math.sin(a)]]; } },
    { len: V, at: t => [[cx + hw, cy - hh + r + t], [1, 0]] },
    { len: A, at: t => { const a = t / r; return [[cx + hw - r + r * Math.cos(a), cy + hh - r + r * Math.sin(a)], [Math.cos(a), Math.sin(a)]]; } },
    { len: T, at: t => [[cx + hw - r - t, cy + hh], [0, 1]] },
    { len: A, at: t => { const a = .5 * Math.PI + t / r; return [[cx - hw + r + r * Math.cos(a), cy + hh - r + r * Math.sin(a)], [Math.cos(a), Math.sin(a)]]; } },
    { len: L, at: t => [[cx - hw, cy + hh - r - t], [-1, 0]] }
  ];
  const total = segs.reduce((a, s) => a + s.len, 0);
  const at = s => {
    s = ((s % total) + total) % total;
    for (const g of segs) { if (s <= g.len) return g.at(s); s -= g.len; }
    return segs[0].at(0);
  };
  // granice łuków (połowy narożników) — tu kończą się trybuny
  const marks = []; let acc = 0;
  for (const g of segs) { marks.push(acc); acc += g.len; }
  return { at, total, mid: i => marks[i] + segs[i].len / 2 };
}
function band(R, s0, s1, d0, d1) {
  const n = Math.max(2, Math.ceil((s1 - s0) / 8)), inner = [], outer = [];
  for (let i = 0; i <= n; i++) {
    const [p, nv] = R.at(s0 + (s1 - s0) * i / n);
    inner.push([r1(p[0] + nv[0] * d0), r1(p[1] + nv[1] * d0)]);
    outer.push([r1(p[0] + nv[0] * d1), r1(p[1] + nv[1] * d1)]);
  }
  return [...inner, ...outer.reverse()];
}
function torwar() {
  const PX = 5; // 5 px = 1 m
  const cx = 330, cy = 250, floorW = 63 * PX, floorH = 33 * PX;
  const R = ring(cx, cy, floorW / 2 + 1.5 * PX, floorH / 2 + 1.5 * PX, 4 * PX);
  const DEPTH = 12 * PX, FRONT = 4.5 * PX;
  // trybuny według specyfikacji nagłośnienia COS: 1 = A, B, C, Y, Z; 2 = D–K (+G1, H1); 3 = L–O; 4 = P–W (+S1, T1)
  const stands = [
    { n: 'Trybuna 1', side: 'zachodnia', from: R.mid(7), to: R.mid(1) + R.total, ids: ['Y', 'Z', 'A', 'B', 'C'] },
    { n: 'Trybuna 2', side: 'północna', from: R.mid(1), to: R.mid(3), ids: ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'], front: ['G', 'H'] },
    { n: 'Trybuna 3', side: 'wschodnia', from: R.mid(3), to: R.mid(5), ids: ['L', 'M', 'N', 'O'] },
    { n: 'Trybuna 4', side: 'południowa', from: R.mid(5), to: R.mid(7), ids: ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'], front: ['S', 'T'] }
  ];
  const booths = [];
  const add = (id, poly, st, h3, extra = '') => booths.push({
    id, ...bbox(poly), polygon: poly, name: 'Sektor ' + id, area: null, hall: st.n, floor: 'Trybuna ' + st.side,
    gate: 'Wejście z kuluarów', info: st.n + ' (strona ' + st.side + ') · wejście z kuluarów przez Zespół Wejścia Głównego.' + extra,
    h3, confidence: 'approximate', nameConfidence: 'source',
    sourceNote: 'Oznaczenie i trybuna według specyfikacji technicznej COS Torwar; kształt i położenie sektora są poglądowe.'
  });
  for (const st of stands) {
    const step = (st.to - st.from) / st.ids.length;
    st.ids.forEach((id, i) => {
      const s0 = st.from + step * i + 1, s1 = st.from + step * (i + 1) - 1;
      if (st.front?.includes(id)) {
        add(id + '1', band(R, s0, s1, 0, FRONT), st, 1.1, ' Dolne rzędy z osobną strefą nagłośnienia.');
        add(id, band(R, s0, s1, FRONT + 2, DEPTH), st, 2.3);
      } else add(id, band(R, s0, s1, 0, DEPTH), st, 2.0);
    });
  }
  const fx = cx - floorW / 2, fy = cy - floorH / 2, out = DEPTH + 1.5 * PX + 4;
  const zones = [
    { name: 'Płyta główna 63 × 33 m', x: fx, y: fy, w: floorW, h: floorH, type: 'pitch' },
    { name: 'Wejście główne', sign: 'WEJŚCIE', x: cx - 60, y: cy + floorH / 2 + out + 18, w: 120, h: 18, type: 'entrance' },
    { name: 'Szatnia (poziom 0)', x: cx - 150, y: cy + floorH / 2 + out + 14, w: 70, h: 24, type: 'reception', sign: 'SZATNIA' },
    { name: 'Szatnia (poziom −1)', x: cx + 80, y: cy + floorH / 2 + out + 14, w: 70, h: 24, type: 'reception', sign: 'SZATNIA' },
    { name: 'Bufet (poziom 0)', x: fx - out - 30, y: cy + floorH / 2 + out - 14, w: 40, h: 20, type: 'food' },
    { name: 'Bufet (poziom 0)', x: fx + floorW + out - 10, y: cy + floorH / 2 + out - 14, w: 40, h: 20, type: 'food' },
    { name: 'Toalety (poziom 0)', x: fx - out - 30, y: cy + floorH / 2 + out + 12, w: 30, h: 16, type: 'wc' },
    { name: 'Toalety (poziom 0)', x: fx + floorW + out, y: cy + floorH / 2 + out + 12, w: 30, h: 16, type: 'wc' },
    { name: 'Bufet (poziom 1)', x: fx - out - 30, y: cy - floorH / 2 - out - 6, w: 40, h: 20, type: 'food' },
    { name: 'Bufet (poziom 1)', x: fx + floorW + out - 10, y: cy - floorH / 2 - out - 6, w: 40, h: 20, type: 'food' },
    { name: 'Toalety (poziom 1)', x: fx - out - 30, y: cy - floorH / 2 - out - 30, w: 30, h: 16, type: 'wc' },
    { name: 'Toalety (poziom 1)', x: fx + floorW + out, y: cy - floorH / 2 - out - 30, w: 30, h: 16, type: 'wc' }
  ].map(z => ({ ...z, x: r1(z.x), y: r1(z.y) }));
  const all = [...booths.flatMap(b => b.polygon), ...zones.flatMap(z => [[z.x, z.y], [z.x + z.w, z.y + z.h]])];
  const b = bbox(all);
  return {
    id: 'torwar', title: 'Hala główna', event: 'COS Torwar', eventId: 'torwar',
    source: 'Specyfikacja techniczna COS Torwar (torwar.cos.pl) — własny rysunek', sourceImage: 'assets/torwar-plan.svg',
    width: 660, height: 520, sourceWidth: 660, sourceHeight: 520, bounds: { x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12 },
    badge: 'UL. ŁAZIENKOWSKA 6A / PLAN POGLĄDOWY', booths, zones,
    notes: [
      'Według specyfikacji COS: 30 sektorów oznaczonych od A do Z, 4 806 krzeseł na trybunach, płyta główna 63 × 33 m (2 079 m²).',
      'Trybuna 1: sektory A, B, C, Y, Z. Trybuna 2: D–K z osobnymi sektorami G1 i H1. Trybuna 3: L–O. Trybuna 4: P–W z osobnymi S1 i T1.',
      'Publiczność wchodzi przez Zespół Wejścia Głównego; na halę prowadzą 3 wejścia, na trybuny wchodzi się z kuluarów.',
      'Poziom 0: 2 bufety, toalety, szatnia (1 404 wieszaki). Poziom 1: 4 bufety, toalety. Poziom −1: szatnia (4 288 wieszaków).',
      'Kształt trybun, kolejność sektorów wokół płyty i położenie bufetów, toalet i szatni są poglądowe — obiekt nie publikuje planu sektorów. Numer sektora i wejścia sprawdzaj na bilecie.'
    ]
  };
}

/* ---------- własny rysunek planu (podkład i „Plan źródłowy”) ---------- */
function planSvg(m) {
  const col = { 'Trybuna dolna': '#9aafc9', 'Loże +1': '#d6b16e', 'Loże +2': '#b48ac9', 'Trybuna górna': '#76bda7' };
  const pts = p => p.map(q => q.join(',')).join(' ');
  const zone = z => {
    const c = z.type === 'pitch' ? '#7fb98a' : z.type === 'wc' ? '#c9c2de' : z.type === 'food' ? '#e2cfa8' : z.type === 'entrance' ? '#9fd0bd' : '#d9d6e2';
    return `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="3" fill="${c}"/>` +
      (z.type === 'pitch' || z.type === 'entrance' ? `<text x="${z.x + z.w / 2}" y="${z.y + z.h / 2 + 3}" font-size="${z.type === 'pitch' ? 14 : 7}" text-anchor="middle" fill="#24402f">${z.sign || z.name}</text>` : '');
  };
  const body = m.zones.map(zone).join('') + m.booths.map(b => {
    const c = centre(b.polygon), fs = Math.max(4, Math.min(10, Math.min(b.w, b.h) / 3));
    return `<polygon points="${pts(b.polygon)}" fill="${col[b.hall] || '#9aafc9'}" stroke="#fff" stroke-width="1"/><text x="${r1(c[0])}" y="${r1(c[1] + fs / 3)}" font-size="${r1(fs)}" text-anchor="middle" fill="#1d2b36">${b.id.replace(/^Loża /, '')}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${m.width * 2}" height="${m.height * 2}" viewBox="0 0 ${m.width} ${m.height}" font-family="Arial,sans-serif"><rect width="100%" height="100%" fill="#f6f7f9"/>${body}</svg>`;
}

// COS Torwar na razie wyłączony ze strony (funkcja torwar() zostaje do ponownego włączenia)
const maps = [pge()];
const resolved = await Promise.all(maps);
const data = {
  events: [
    { id: 'pge', title: 'PGE Narodowy', subtitle: 'Warszawa · stadion · 4 poziomy', icon: '◎', color: '#94b5d1', soft: '#edf2fa' }
  ],
  maps: resolved,
  version: 'venue-3d-1'
};
await mkdir(new URL('assets/', OUT), { recursive: true });
await writeFile(new URL('data.js', OUT), 'const EXPO_DATA = ' + JSON.stringify(data) + ';\n');
for (const m of resolved) await writeFile(new URL(m.sourceImage, OUT), planSvg(m));
console.log(resolved.map(m => `${m.id}: ${m.booths.length} sektorów, ${m.zones.length} stref`).join('\n'));
