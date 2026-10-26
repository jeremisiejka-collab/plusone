/* +1 — posty i story na Instagram z wydarzeń o największym potencjale.
   Uruchomienie: node social/generate.mjs [--days=21] [--count=6] [--city=Warszawa]
   Wynik: social/out/<data>/  (post-*.png 1080×1350, story-*.png 1080×1920, weekend-*.png, opisy.md)
   Wymaga pakietu "playwright" (Chromium). Zmienne: PW_EXECUTABLE (własna przeglądarka), PW_PROXY (serwer proxy). */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const DAYS = +arg('days', 21), COUNT = +arg('count', 6), HOME_CITY = arg('city', 'Warszawa');

const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MIES = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const DNI = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const DNI_SKR = ['ND', 'PN', 'WT', 'ŚR', 'CZ', 'PT', 'SB'];
const CAT_PL = { Clubs: 'Klub', Concerts: 'Koncert', Festivals: 'Festiwal', Theatre: 'Teatr', Comedy: 'Stand-up', Culture: 'Kultura', Sport: 'Sport', Family: 'Dzieci', Other: 'Wydarzenie' };
const SRC_PL = { going: 'bilety online', ebilet: 'eBilet', ra: 'Resident Advisor', go2warsaw: 'go2warsaw.pl' };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fold = s => String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');

/* ---------- wybór: wydarzenia o największym potencjale ---------- */
const ARENA = /narodowy|stadion|tauron arena|atlas arena|ergo arena|polsat plus|spodek|torwar|prezero|g2a arena|orlen arena|hala stulecia|expo xxi|enea arena|tarczyński|\barena\b|lotnisko|tor wyścigów|błonia/i;
export function score(e) {
  let s = 0;
  if (e.big) s += 5;
  if (ARENA.test(e.venue || '')) s += 3;
  s += 2 * (e.sources.length - 1);                       // to samo wydarzenie w kilku serwisach = większy popyt
  if (e.category === 'Concerts' || e.category === 'Festivals') s += 2;
  if (e.category === 'Clubs') s += 1;
  s += Math.min(e.artists?.length || 0, 4) * 0.5;
  if (e.image) s += 1;
  if (e.priceFrom >= 150) s += 1;
  if (e.end && e.end.slice(0, 10) !== e.start.slice(0, 10)) s -= 3; // wystawy i cykle
  if (/karnet|voucher|bilet do|zwiedzanie|warsztat|kurs|parking/i.test(e.title)) s -= 3;
  if (e.city === HOME_CITY) s += 1.5;
  return s;
}

function pick(events, from, to, n) {
  const pool = events.filter(e => e.image && e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to)
    .map(e => ({ e, s: score(e) })).sort((a, b) => b.s - a.s);
  const out = [], seen = new Set(), perCity = {};
  for (const { e } of pool) {
    const key = fold(e.artists?.[0] || e.title).slice(0, 18);   // ta sama trasa w kilku miastach = jeden post
    if (seen.has(key) || (perCity[e.city] || 0) >= 2 && e.city !== HOME_CITY) continue;
    seen.add(key); perCity[e.city] = (perCity[e.city] || 0) + 1;
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

/* ---------- treści ---------- */
const when = e => {
  const d = new Date(e.start.slice(0, 10) + 'T12:00'), t = e.start.slice(11, 16);
  return { d, day: `${d.getDate()} ${MIES[d.getMonth()]}`, short: `${DNI_SKR[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`, dow: DNI[d.getDay()], time: t !== '00:00' ? t : '' };
};
const bigImage = url => String(url || '').replace(/\/upload\/c_fill,w_\d+,h_\d+[^/]*\//, '/upload/c_fill,w_1080,h_1350,g_auto,q_auto:good,f_jpg/');
const price = e => e.priceFrom == null ? null : e.priceFrom === 0 ? 'Wstęp wolny' : `Bilety od ${Math.round(e.priceFrom)} zł`;
const tag = s => '#' + fold(s).replace(/[^a-z0-9]+/g, '');
function caption(e) {
  const w = when(e), lead = (e.description || '').split(/(?<=[.!?])\s/)[0].replace(/🎤|tego nie możesz przegapić!?/gi, '').trim();
  const line = e.artists?.length > 1 ? `Na scenie: ${e.artists.slice(0, 6).join(', ')}.` : lead && lead.length < 220 ? lead : '';
  const tags = [tag(e.city), tag('wydarzenia' + e.city), tag(CAT_PL[e.category] || 'wydarzenia'),
    ...(e.artists || []).slice(0, 3).map(tag), ...(e.tags || []).flatMap(t => t.split(/\s+i\s+|\s*[\/&,]\s*/)).slice(0, 2).map(tag), '#gdziedzisidziemy', '#plusoneapp']
    .filter((t, i, a) => t.length > 2 && t.length < 30 && a.indexOf(t) === i);
  return [`${e.title}`, `${w.dow}, ${w.day}${w.time ? ', ' + w.time : ''} · ${e.venue}, ${e.city}`, '', line,
    price(e) ? `${price(e)} (${e.links.map(l => SRC_PL[l.source] || l.source).join(', ')}).` : `Bilety: ${e.links.map(l => SRC_PL[l.source] || l.source).join(', ')}.`,
    `Wszystko, co dzieje się w Twoim mieście → link w bio, plusoneapp.pl`, '', tags.join(' ')].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

/* ---------- szablony ---------- */
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">`;
const GLYPH = (c = '#FF0059') => `<svg viewBox="0 0 100 100" width="100%" height="100%"><g fill="${c}"><rect x="13.7" y="34.8" width="40.1" height="14"/><rect x="27.4" y="22.9" width="13.2" height="37.6"/><rect x="59.4" y="22.9" width="14" height="37.6"/></g></svg>`;
const BASE = `*{margin:0;padding:0;box-sizing:border-box}body{background:#060607;color:#fff;font-family:'Space Grotesk',sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:'JetBrains Mono',monospace;letter-spacing:.12em;text-transform:uppercase}
.brand{display:flex;align-items:center;gap:14px}.brand i{display:block;width:62px;height:62px;border-radius:16px;background:#000;padding:4px}
.pill{display:inline-block;padding:12px 20px;border-radius:14px;font:700 26px/1 'JetBrains Mono',monospace;letter-spacing:.1em}
.clamp{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}`;
const titleSize = (t, big, small) => t.length > 60 ? small : t.length > 34 ? Math.round((big + small) / 2) : big;

function postHtml(e) {
  const w = when(e), p = price(e);
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE}
  .wrap{width:1080px;height:1350px;position:relative;overflow:hidden;background:#060607}
  .img{position:absolute;left:0;top:0;width:1080px;height:880px;object-fit:cover}
  .fade{position:absolute;left:0;right:0;top:520px;height:380px;background:linear-gradient(180deg,rgba(6,6,7,0),#060607)}
  .top{position:absolute;left:56px;right:56px;top:52px;display:flex;justify-content:space-between;align-items:center}
  .top .mono{font-size:22px;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.6)}
  .body{position:absolute;left:64px;right:64px;bottom:64px}
  .date{display:flex;align-items:baseline;gap:22px}
  .date b{font:700 92px/1 'Space Grotesk';color:#FF0059;letter-spacing:-.03em}
  .date span{font-size:30px;color:rgba(255,255,255,.75)}
  h1{font-weight:700;letter-spacing:-.03em;line-height:1.02;margin-top:22px;-webkit-line-clamp:3}
  .where{font-size:32px;color:rgba(255,255,255,.72);margin-top:22px}
  .foot{display:flex;justify-content:space-between;align-items:center;margin-top:38px;padding-top:30px;border-top:2px solid rgba(255,255,255,.12)}
  .foot .p{font:600 34px/1 'Space Grotesk'}.foot .mono{font-size:20px;color:rgba(255,255,255,.55)}
  </style></head><body><div class="wrap">
  <img class="img" src="${esc(bigImage(e.image))}"><div class="fade"></div>
  <div class="top"><div class="brand"><i>${GLYPH()}</i><span class="mono">plusoneapp.pl</span></div>
    <span class="pill" style="background:#FF0059;color:#000">${esc((CAT_PL[e.category] || 'Wydarzenie').toUpperCase())}</span></div>
  <div class="body">
    <div class="date"><b>${w.short}</b><span>${w.dow}${w.time ? ' · ' + w.time : ''}</span></div>
    <h1 class="clamp" style="font-size:${titleSize(e.title, 88, 62)}px">${esc(e.title)}</h1>
    <div class="where">${esc(e.venue)} · ${esc(e.city)}</div>
    <div class="foot"><span class="p">${p ? esc(p) : 'Bilety: link w bio'}</span><span class="mono">Gdzie dziś idziemy?</span></div>
  </div></div></body></html>`;
}

function storyHtml(e) {
  const w = when(e), p = price(e), img = esc(bigImage(e.image));
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE}
  .wrap{width:1080px;height:1920px;position:relative;overflow:hidden;background:#060607}
  .bg{position:absolute;inset:-80px;background:url("${img}") center/cover;filter:blur(60px) brightness(.45) saturate(1.3)}
  .top{position:absolute;left:70px;right:70px;top:150px;display:flex;justify-content:space-between;align-items:center}
  .top .mono{font-size:24px}
  .card{position:absolute;left:110px;right:110px;top:270px;height:820px;border-radius:44px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,.6);border:2px solid rgba(255,255,255,.12)}
  .card img{width:100%;height:100%;object-fit:cover}
  .info{position:absolute;left:90px;right:90px;top:1150px}
  h1{font-weight:700;letter-spacing:-.03em;line-height:1.02;margin-top:26px;-webkit-line-clamp:3}
  .where{font-size:34px;color:rgba(255,255,255,.75);margin-top:20px}
  .cta{position:absolute;left:90px;right:90px;bottom:250px;display:flex;justify-content:space-between;align-items:center;
    padding:30px 36px;border-radius:28px;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.16);backdrop-filter:blur(10px)}
  .cta b{font:600 34px/1 'Space Grotesk'}.cta span{font:700 30px/1 'Space Grotesk';color:#FF0059}
  </style></head><body><div class="wrap"><div class="bg"></div>
  <div class="top"><div class="brand"><i>${GLYPH()}</i><span class="mono">plusoneapp.pl</span></div><span class="mono" style="opacity:.75">${esc(e.city)}</span></div>
  <div class="card"><img src="${img}"></div>
  <div class="info">
    <span class="pill" style="background:#FF0059;color:#000">${w.day.toUpperCase()}${w.time ? ' · ' + w.time : ''}</span>
    <h1 class="clamp" style="font-size:${titleSize(e.title, 84, 60)}px">${esc(e.title)}</h1>
    <div class="where">${esc(e.venue)}${p ? ' · ' + esc(p) : ''}</div>
  </div>
  <div class="cta"><b>Bilety i więcej wydarzeń</b><span>link w bio →</span></div>
  </div></body></html>`;
}

function weekendHtml(list, city, label) {
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE}
  .wrap{width:1080px;height:1350px;position:relative;overflow:hidden;background:radial-gradient(120% 80% at 80% 0%,#2a0013 0%,#060607 60%);padding:70px 64px}
  h1{font:700 96px/.95 'Space Grotesk';letter-spacing:-.04em;margin-top:36px}h1 em{font-style:normal;color:#FF0059}
  .sub{font-size:30px;color:rgba(255,255,255,.65);margin-top:18px}
  .list{margin-top:38px;display:flex;flex-direction:column;gap:16px}
  .row{display:flex;gap:26px;align-items:center}
  .row img{width:124px;height:124px;border-radius:22px;object-fit:cover;flex:none;border:2px solid rgba(255,255,255,.1)}
  .row .d{font:700 22px/1 'JetBrains Mono';color:#FF0059;letter-spacing:.08em}
  .row .t{font:600 32px/1.12 'Space Grotesk';margin-top:8px;-webkit-line-clamp:2}
  .row .v{font-size:24px;color:rgba(255,255,255,.6);margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:780px}
  .foot{position:absolute;left:64px;right:64px;bottom:56px;display:flex;justify-content:space-between;font-size:24px;color:rgba(255,255,255,.55)}
  </style></head><body><div class="wrap">
  <div class="brand"><i>${GLYPH()}</i><span class="mono" style="font-size:22px">plusoneapp.pl</span></div>
  <h1>${esc(label)}<br><em>${esc(city)}</em></h1>
  <div class="sub">Nasz wybór na najbliższe dni</div>
  <div class="list">${list.map(e => { const w = when(e); return `<div class="row"><img src="${esc(bigImage(e.image))}">
    <div style="min-width:0"><div class="d">${w.short}${w.time ? ' · ' + w.time : ''}</div><div class="t clamp">${esc(e.title)}</div><div class="v">${esc(e.venue)}</div></div></div>`; }).join('')}</div>
  <div class="foot"><span class="mono">Gdzie dziś idziemy?</span><span>Więcej → link w bio</span></div>
  </div></body></html>`;
}

/* ---------- render ---------- */
async function shoot(browser, html, w, h, file) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(html, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: file });
  await page.close();
}

const data = JSON.parse(await readFile(join(HERE, '..', 'public', 'data', 'events.json'), 'utf8'));
const now = new Date(), from = isoDay(now), to = isoDay(new Date(now.getTime() + DAYS * 864e5));
const picks = pick(data.events, from, to, COUNT);

// najbliższy weekend (pt–nd) w mieście domowym
const fri = new Date(now); fri.setDate(now.getDate() + ((5 - now.getDay() + 7) % 7));
if (now.getDay() === 6 || now.getDay() === 0) fri.setDate(now.getDate() - (now.getDay() === 6 ? 1 : 2));
const sun = new Date(fri); sun.setDate(fri.getDate() + 2);
const weekend = pick(data.events.filter(e => e.city === HOME_CITY), isoDay(fri > now ? fri : now), isoDay(sun), 5);

const out = join(HERE, 'out', from);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PW_EXECUTABLE || undefined,
  proxy: process.env.PW_PROXY ? { server: process.env.PW_PROXY } : undefined
});
const md = [`# Posty +1 — ${from}`, '', `Wybór: ${COUNT} wydarzeń o największym potencjale na najbliższe ${DAYS} dni (duże sale, festiwale, znane nazwiska, kilku sprzedawców), plus weekend w mieście ${HOME_CITY}.`, ''];
for (const [i, e] of picks.entries()) {
  const n = String(i + 1).padStart(2, '0');
  await shoot(browser, postHtml(e), 1080, 1350, join(out, `post-${n}.png`));
  await shoot(browser, storyHtml(e), 1080, 1920, join(out, `story-${n}.png`));
  md.push(`## ${n}. ${e.title}`, '', `Pliki: post-${n}.png, story-${n}.png · wynik ${score(e).toFixed(1)} · link do biletów: ${e.links[0].url}`, '', '```', caption(e), '```', '');
  console.log(`✓ ${n} ${e.title} (${e.city})`);
}
if (weekend.length >= 3) {
  const label = `Weekend ${fri.getDate()}–${sun.getDate()}.${pad(sun.getMonth() + 1)}`;
  await shoot(browser, weekendHtml(weekend, HOME_CITY, label), 1080, 1350, join(out, 'weekend.png'));
  md.push(`## Weekend: ${HOME_CITY}`, '', 'Plik: weekend.png', '', '```',
    `${label} w mieście ${HOME_CITY} — nasz wybór:`, '', ...weekend.map(e => { const w = when(e); return `• ${w.short}${w.time ? ' ' + w.time : ''} — ${e.title} (${e.venue})`; }),
    '', 'Wszystkie wydarzenia → link w bio, plusoneapp.pl', '', `${tag(HOME_CITY)} ${tag('weekend' + HOME_CITY)} ${tag('wydarzenia' + HOME_CITY)} #gdziedzisidziemy #plusoneapp`, '```', '');
  console.log(`✓ weekend (${weekend.length})`);
}
await browser.close();
await writeFile(join(out, 'opisy.md'), md.join('\n'));
console.log('Gotowe:', out);
