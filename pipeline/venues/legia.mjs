// Stadion Legii — sektory, loże i wejścia przerysowane ręcznie z oficjalnej mapy https://legia.com/mapa-stadionu
// (obraz 917 × 480 px; współrzędne odczytane z powiększeń, potem przesunięte o DX, DY). Wynik trafia do public/data/venues.json.
// Uruchom: node pipeline/venues/legia.mjs && node pipeline/venue3d/build.mjs
import { readFile, writeFile } from 'node:fs/promises';

const DX = 195, DY = 20;
const R = (x1, y1, x2, y2) => [x1, y1, x2, y1, x2, y2, x1, y2];
// współrzędne w pikselach oficjalnej mapy
const RAW = {
  // trybuna wschodnia (im. Kazimierza Deyny) — rząd górny
  '210': [262, 48, 316, 48, 316, 92.5, 278, 92.5], '211': R(317, 48, 370, 92.5), '212': R(371, 48, 424.5, 92.5), '213': R(425.5, 48, 478.5, 92.5),
  '214': R(479.5, 48, 532.5, 92.5), '215': R(533.5, 48, 587.5, 92.5), '216': [588.5, 48, 642, 48, 626, 92.5, 588.5, 92.5],
  // trybuna wschodnia — rząd dolny
  '110': [278, 93.5, 297, 93.5, 297, 129.5, 288, 139.5, 251, 139.5, 251, 121.5], '111': R(298, 93.5, 343, 129.5), '112': R(344, 93.5, 398, 129.5),
  '113': R(399, 93.5, 452, 129.5), '114': R(453, 93.5, 507, 129.5), '115': R(508, 93.5, 561, 129.5), '116': R(562, 93.5, 606.5, 129.5),
  '117': [607.5, 92.5, 626, 92.5, 651.5, 120, 651.5, 138.8, 616, 138.8, 607.5, 130],
  // narożniki
  '209': [262, 48, 278, 92.5, 251, 120.5, 207, 102.5], '217': [643, 48, 696.5, 103.5, 652.5, 120, 626.5, 92.5],
  // trybuna północna (Żyleta)
  '208': [207, 103.5, 251, 121.5, 251, 157.5, 207, 157.5], '207': R(207, 158.5, 251, 212), '206': R(207, 213, 251, 267), '205': R(207, 268, 251, 321.5),
  '204': [207, 322.5, 251, 322.5, 251, 358.5, 207, 375], '109': R(252, 140.5, 288, 185), '108': R(252, 186, 288, 239.5), '107': R(252, 240.5, 288, 294),
  '106': [252, 295, 288, 295, 288, 336, 275.5, 350, 252, 350], '105': [252, 351, 275.5, 351, 288, 363, 288, 386.5, 278, 386.5, 252, 359.5],
  '203': [207, 376, 251, 359.5, 277.5, 387.5, 261, 431],
  // trybuna zachodnia — rząd dolny (100 = Strefa Gold, 101–103 i 124–126 = miejsca VIP nad ławkami rezerwowych)
  '104': [296, 350.5, 342.5, 350.5, 342.5, 386.5, 289, 386.5, 289, 358.5], '103': R(343.5, 350.5, 369.5, 386.5), '102': R(370.5, 350.5, 396.5, 386.5),
  '101': [397.5, 350.5, 406, 358.8, 424.5, 358.8, 424.5, 386.5, 397.5, 386.5],
  '100': [425.5, 358.8, 445, 358.8, 445, 366, 459, 366, 459, 358.8, 478.5, 358.8, 478.5, 372.5, 425.5, 372.5], 'Gold': R(425.5, 373.5, 478.5, 386.5),
  '126': [479.5, 358.8, 497.5, 358.8, 506, 350.5, 506, 386.5, 479.5, 386.5], '125': R(507, 350.5, 533.5, 386.5), '124': R(534.5, 350.5, 560, 386.5),
  '123': R(561, 350.5, 615, 386.5),
  // trybuna zachodnia — rząd górny, loże biznesowe (z PRESS) i Skybox
  '202': [278, 387.5, 288, 387.5, 288, 431, 261, 431], '201': R(289, 387.5, 315, 430.5), '200': R(316, 387.5, 356.5, 430.5),
  'Biznes': [357.5, 388.5, 546.5, 388.5, 546.5, 430.5, 480, 430.5, 480, 416, 424, 416, 424, 430.5, 357.5, 430.5],
  '225': R(547.5, 387.5, 587.5, 430.5), '224': R(588.5, 387.5, 615, 430.5), '223': [616, 387.5, 626, 387.5, 642.5, 430.5, 616, 430.5],
  'Skybox': [651, 359.5, 696.5, 375, 642.5, 430.5, 626.5, 387.5],
  // trybuna południowa (im. Lucjana Brychczego); 121, 122 i 221 = sektor gości za strefą buforową
  '118': R(616, 139.8, 651.5, 185), '119': R(616, 186, 651.5, 239.5), '120': R(616, 240.5, 651.5, 266),
  '218': [652.5, 121, 696.5, 104.5, 696.5, 158, 652.5, 158], '219': R(652.5, 159, 696.5, 212), '220': R(652.5, 213, 696.5, 266),
  '121': R(616, 295, 652, 349.5), '122': [616, 350.5, 652.5, 350.5, 652.5, 358.8, 626, 386.3, 616, 386.3],
  '221': [653.5, 295, 696.5, 295, 696.5, 374, 653.5, 358.5]
};
const STAND = {
  w: ['209', '208', '207', '206', '205', '204', '203', '109', '108', '107', '106', '105'],
  e: ['210', '211', '212', '213', '214', '215', '216', '110', '111', '112', '113', '114', '115', '116', '117'],
  s: ['217', '218', '219', '220', '221', '118', '119', '120', '121', '122', 'Skybox'],
};
const STANDS = { e: 'Trybuna Wschodnia im. Kazimierza Deyny', w: 'Trybuna Północna (Żyleta)', s: 'Trybuna Południowa im. Lucjana Brychczego', z: 'Trybuna Zachodnia' };
const standOf = id => STANDS[Object.keys(STAND).find(k => STAND[k].includes(id)) || 'z'];
const AWAY = ['121', '122', '221'], VIP = ['101', '102', '103', '124', '125', '126'];
const levelOf = id => ['100', 'Gold', 'Biznes', 'Skybox', ...VIP].includes(id) ? 'vip1' : id.startsWith('2') ? 'upper' : 'lower';
const nameOf = id => id === 'Gold' ? 'Sala Gold' : id === 'Biznes' ? 'Loże biznesowe' : id === 'Skybox' ? 'Skybox'
  : id === '100' ? 'Sektor 100 (Strefa Gold)' : 'Sektor ' + id + (AWAY.includes(id) ? ' (sektor gości)' : VIP.includes(id) ? ' (VIP)' : '');
const shift = p => p.map((v, i) => Math.round((v - (i % 2 ? DY : DX)) * 10) / 10);

const sectors = Object.entries(RAW).map(([id, p]) => ({ id, name: nameOf(id), level: levelOf(id), stand: standOf(id), p: shift(p) }));
const gate = (n, x, y) => ({ n, x: x - DX, y: y - DY });
const hall = {
  id: 'stadion', name: 'Stadion', type: 'stadium', w: 515, h: 446,
  pitch: shift([315, 158, 589, 323]), bowl: [6, 22, 502, 395], gateWord: 'wejście',
  gates: [gate('B1', 236, 37), gate('B2', 278, 37), gate('C2', 625, 37), gate('C1', 668, 37), gate('MEDIA', 225, 442), gate('A1', 277, 442), gate('VIP', 314, 442), gate('D1', 625, 442)],
  marks: [{ t: 'STREFA BUFOROWA', p: shift(R(616, 267, 696.5, 294)) }, { t: 'PRESS', p: shift(R(425, 417, 479, 430.5)) }],
  levels: [
    { id: 'floor', name: 'Płyta', floor: 'poziom 0', has: ['Płyta przed sceną (koncerty)', 'Wejście na płytę wskazane na bilecie'], no: ['Miejsc siedzących'] },
    { id: 'lower', name: 'Trybuna dolna', floor: 'rząd dolny, sektory 1xx', has: ['Sektory dolne dookoła boiska', 'Żyleta: sektory 105–109 i 203–209 na trybunie północnej', 'Najbliżej boiska i sceny'], no: ['Lóż biznesowych (są w trybunie zachodniej)'] },
    { id: 'vip1', name: 'VIP i biznes', floor: 'trybuna zachodnia', has: ['Strefa Gold: 152 miejsca w sektorze 100 nad wyjściem zawodników i sala Gold', 'Miejsca VIP w sektorach 101–103 i 124–126 nad ławkami rezerwowych', 'Loże biznesowe i Skybox', 'Wejście VIP od strony zachodniej'], no: ['Wejścia na zwykły bilet — potrzebny bilet lub zaproszenie VIP'] },
    { id: 'upper', name: 'Trybuna górna', floor: 'rząd górny, sektory 2xx', has: ['Sektory 200–225 dookoła stadionu', 'Widok na całe boisko i scenę'], no: ['Lóż biznesowych'] }
  ],
  sides: [{ t: 'TRYBUNA WSCHODNIA (im. K. Deyny)', x: 257, y: 12 }, { t: 'TRYBUNA ZACHODNIA', x: 257, y: 441 }],
  note: 'Sektory, wejścia i loże według oficjalnej mapy stadionu Legii. Trybuna północna to Żyleta, południowa (im. L. Brychczego) ma sektor gości 121, 122 i 221 za strefą buforową. Strefa Gold i miejsca VIP według oferty VIP klubu. Gastronomia i toalety są w korytarzach każdej trybuny. Wejście sprawdzaj zawsze na bilecie.',
  sectors
};
const FILE = new URL('../../public/data/venues.json', import.meta.url);
const v = JSON.parse(await readFile(FILE, 'utf8'));
v.venues = v.venues.filter(x => x.id !== 'stadion-legii');
v.venues.push({ id: 'stadion-legii', name: 'Stadion Legii', city: 'Warszawa', address: 'ul. Łazienkowska 3',
  match: ['stadion legii', 'stadion wojska polskiego', 'stadion miejski legii'], exclude: [], source: 'https://legia.com/mapa-stadionu', halls: [hall] });
await writeFile(FILE, JSON.stringify(v));
console.log('Stadion Legii:', sectors.length, 'sektorów');
