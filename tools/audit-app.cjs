// Audyt wizualny aplikacji /app: każdy ekran × rozmiar iPhone'a × motyw. Zrzuty przewijanego widoku + automatyczne wykrywanie
// tekstu poza ekranem, uciętego tekstu, nachodzących elementów i za małych przycisków.
// Uruchomienie: tools/seed-local.sh, serwer lokalny (docs/PLUSONE.md), potem:
//   node tools/audit-app.cjs [ekran,ekran]     zmienne: SIZES=se,13,max THEMES=light,dark OUT=katalog/ BASE=http://localhost:8799
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = (process.env.OUT || require('os').tmpdir() + '/plusone-audit').replace(/\/?$/, '/');
fs.mkdirSync(OUT, { recursive: true });
const B = process.env.BASE || 'http://localhost:8799';
const ONLY = process.argv[2] ? process.argv[2].split(',') : null;
const SIZES = (process.env.SIZES || 'se,13,max').split(',');
const THEMES = (process.env.THEMES || 'light,dark').split(',');
const DEV = { se: devices['iPhone SE'], '13': devices['iPhone 13'], max: devices['iPhone 14 Pro Max'] };
const USER = 'lokalnyuser00000000000', ADMIN = 'lokalnyadmin0000000000'; // sesje z tools/seed-local.sh

/* ekrany: [nazwa, konto, przygotowanie w stronie] */
const SCREENS = [
  ['home', USER, `go('home')`],
  ['list', USER, `go('list')`],
  ['event', USER, `openEvent((EVENTS.find(e=>e.real&&e.city==='Warszawa'&&e.time>='19:00'&&e.image&&e.links.length>1&&e.lineup.length>2)||EVENTS.find(e=>e.real&&e.image)).id)`],
  ['event2', USER, `openEvent((EVENTS.find(e=>e.real&&e.name.length>55&&e.image)||EVENTS[3]).id)`],
  ['place', USER, `act('place:'+venueSlug(EVENTS.find(e=>e.real&&hasVenue(e)&&e.city==='Warszawa')))`],
  ['tickets', USER, `go('tickets')`],
  ['profile', USER, `go('profile')`],
  ['wallet', USER, `go('wallet')`],
  ['plan', USER, `go('plan')`],
  ['people', USER, `go('people')`],
  ['mywrapped', USER, `go('mywrapped')`],
  ['dash', ADMIN, `go('dash')`],
  ['admin', ADMIN, `go('admin')`],
  ['org', ADMIN, `go('org')`],
  ['auth', null, `go('auth')`],
  ['start', null, `go('start')`],
];

const AUDIT = () => {
  const W = innerWidth, view = document.querySelector('#view') || document.body;
  const vis = el => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' && +c.opacity > 0.05; };
  const desc = el => { const t = (el.innerText || el.getAttribute('aria-label') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 50); return el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' „' + t + '”'; };
  const inXScroller = el => { for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) { const c = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(c.overflowX)) { const r = a.getBoundingClientRect(); if (r.right <= W + 1 && r.left >= -1) return true; } } return false; };
  const out = { offscreen: [], clipped: [], overlap: [], small: [] };
  const all = [...view.querySelectorAll('*')].filter(vis);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if ((r.right > W + 1 || r.left < -1) && !inXScroller(el) && getComputedStyle(el).position !== 'fixed') out.offscreen.push(desc(el));
    const c = getComputedStyle(el);
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (ownText && /(hidden|clip)/.test(c.overflowX + c.overflowY) && c.textOverflow !== 'ellipsis' && c.webkitLineClamp === 'none' && !/-webkit-box/.test(c.display)
      && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 3)) out.clipped.push(desc(el));
    if (el.matches('button,a,[data-act]') && !el.closest('.chips,.sc[style*="overflow-x"]') && (r.height < 32 || r.width < 32) && ownText === false && el.children.length) out.small.push(desc(el) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // nachodzenie: elementy z własnym tekstem, przyciski i pola; przypięte paski (fixed/sticky) pomijamy — treść celowo przewija się pod nimi
  const pinned = el => { for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
  const clipRect = el => { const r = el.getBoundingClientRect(); let { left, right, top, bottom } = r;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) { const c = getComputedStyle(a);
      if (/(auto|scroll|hidden|clip)/.test(c.overflowX + c.overflowY) && a !== view) { const q = a.getBoundingClientRect(); left = Math.max(left, q.left); right = Math.min(right, q.right); top = Math.max(top, q.top); bottom = Math.min(bottom, q.bottom); } }
    return { left, right, top, bottom }; };
  const atoms = all.filter(el => !el.closest('svg') && !pinned(el) && (el.matches('button,input,select,textarea') || [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())));
  const rects = atoms.map(el => [el, clipRect(el)]).filter(([, r]) => r.right - r.left > 2 && r.bottom - r.top > 2);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const [a, ra] = rects[i], [b, rb] = rects[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ox > 4 && oy > 4) out.overlap.push(desc(a) + '  ×  ' + desc(b));
  }
  for (const k in out) out[k] = [...new Set(out[k])].slice(0, 12);
  return out;
};

(async () => {
  const b = await chromium.launch();
  const report = {};
  for (const size of SIZES) for (const theme of THEMES) {
    for (const [name, tok, setup] of SCREENS) {
      if (ONLY && !ONLY.includes(name)) continue;
      const ctx = await b.newContext({ ...DEV[size], colorScheme: theme });
      if (tok) await ctx.addCookies([{ name: 'sid', value: tok, url: B }]);
      await ctx.addInitScript(t => { try { localStorage.setItem('theme', t); localStorage.setItem('intAsked', '1'); localStorage.setItem('installHintOff', '1'); } catch (e) {} }, theme);
      // lokalny serwer nie ma internetu: lokale w okolicy (Plan na wieczór) podstawiamy
      await ctx.route('**/api/nearby?*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ at: { lat: 52.21, lon: 21.01 }, food: Array.from({ length: 9 }, (_, i) => ({ name: ['Zielona Gęś', 'Bolek', 'Taka Tajka', 'Wieczorny', 'Green Caffè Nero', 'Bong Bong', 'Jajko', 'Hashi Oki', 'Domino’s'][i], kind: ['pub', 'pub', 'restaurant', 'bar', 'cafe', 'fast_food', 'fast_food', 'fast_food', 'restaurant'][i], street: 'Aleja Niepodległości ' + (160 + i), lat: 52.21, lon: 21.01, city: 'Warszawa', min: i + 2 })) }) }));
      const p = await ctx.newPage(); const errs = [];
      p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); });
      await p.goto(B + '/app'); await p.waitForTimeout(3500);
      if (tok === ADMIN && !['dash', 'admin', 'org'].includes(name)) await p.evaluate(() => { try { setBrowse(true); } catch (e) {} });
      const hasApp = await p.evaluate(() => typeof S !== 'undefined');
      if (hasApp) { try { await p.evaluate(s => { try { closeSheet() } catch (e) {} S.city = 'Warszawa'; eval(s); }, setup); } catch (e) { errs.push('setup: ' + e.message); } }
      await p.waitForTimeout(2200);
      const key = `${name}-${size}-${theme}`;
      const scr = await p.evaluate(() => typeof S !== 'undefined' ? S.screen : 'strona logowania');
      const res = await p.evaluate(AUDIT);
      const H = await p.evaluate(() => { const v = document.querySelector('#view'); return v ? v.scrollHeight : document.body.scrollHeight; });
      const vh = DEV[size].viewport.height;
      const shots = Math.min(6, Math.ceil(H / (vh * 0.85)));
      for (let k = 0; k < shots; k++) {
        await p.evaluate(y => { const v = document.querySelector('#view'); if (v) v.scrollTop = y; else scrollTo(0, y); }, Math.round(k * vh * 0.85));
        await p.waitForTimeout(350);
        await p.screenshot({ path: `${OUT}${key}-${k}.png` });
      }
      report[key] = { screen: scr, ...res, errs: errs.slice(0, 4) };
      await ctx.close();
    }
  }
  await b.close();
  fs.writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 1));
  let bad = 0;
  for (const [k, v] of Object.entries(report)) {
    const n = v.offscreen.length + v.clipped.length + v.overlap.length + v.small.length + v.errs.length; bad += n;
    console.log(k.padEnd(24), 'ekran=' + v.screen, n ? `poza:${v.offscreen.length} ucięte:${v.clipped.length} nachodzą:${v.overlap.length} małe:${v.small.length} błędy:${v.errs.length}` : 'OK');
  }
  console.log(`\nZrzuty i report.json: ${OUT}`);
  process.exitCode = bad ? 1 : 0;
})();
