/* +1: tryb nocny modułów 3D. Motyw jak na stronie: localStorage 'theme' (light/dark), inaczej ustawienie systemu.
   Zmiana motywu na stronie (zdarzenie storage) przełącza mapę od razu. Działa na globalnych nazwach z app.js
   (scene3, renderer, root3, geo, buildGeometry, badgeTexture, updateBoothStates…), bez zmian w samym app.js. */
(() => {
  'use strict';
  const isNight = () => { let t = null; try { t = localStorage.getItem('theme'); } catch (e) {}
    if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; return t === 'dark'; };
  let night = null;
  const dayBadge = badgeTexture;
  function nightBadge(text){ const cn = document.createElement('canvas'); cn.width = text.length*24+24; cn.height = 64; const c = cn.getContext('2d');
    c.fillStyle = '#1c2633'; c.beginPath(); c.roundRect(0,0,cn.width,64,12); c.fill(); c.strokeStyle = '#33404f'; c.lineWidth = 3; c.stroke();
    c.fillStyle = '#e6edf5'; c.font = '600 40px Space,Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, cn.width/2, 34, cn.width-12);
    const t = new THREE.CanvasTexture(cn); t.colorSpace = THREE.SRGBColorSpace; return t; }
  const lights = () => scene3.children.filter(o => o.isLight);
  const DAY = { bg:'#f1f3f6', exposure:renderer.toneMappingExposure, lights:lights().map(l => ({ i:l.intensity, c:l.color.getHex(), g:l.groundColor ? l.groundColor.getHex() : null })) };
  const hsl = {};
  // jasne powierzchnie (posadzka, ściany, meble) przyciemniamy; kolory sektorów i stoisk ustawia app.js
  function darken(){
    const accents = new Set(geo.map(g => g.accent));
    root3.traverse(o => { for (const m of [o.material].flat()) {
      if (!m || !m.color || accents.has(m) || m.userData.nightDone) continue;
      m.color.getHSL(hsl); m.userData.nightDone = true;
      if (hsl.l > .8) m.color.setHSL(hsl.h, Math.min(hsl.s, .12), .06 + (1 - hsl.l) * .5);
      else if (hsl.l > .55) m.color.setHSL(hsl.h, hsl.s * .8, hsl.l * .5);
      else m.color.setHSL(hsl.h, hsl.s, hsl.l * .8);
    } });
  }
  function lightsFor(n){
    scene3.background.set(n ? '#0d1218' : DAY.bg);
    renderer.toneMappingExposure = n ? 1.05 : DAY.exposure;
    lights().forEach((l, i) => { const d = DAY.lights[i]; if (!d) return;
      if (!n) { l.intensity = d.i; l.color.setHex(d.c); if (l.groundColor && d.g != null) l.groundColor.setHex(d.g); return; }
      if (l.isHemisphereLight) { l.intensity = .95; l.color.set('#a9b8d0'); l.groundColor.set('#0b0f15'); }
      else if (l.castShadow) { l.intensity = 2.3; l.color.set('#e8ecff'); }
      else { l.intensity = .6; l.color.set('#8aa2e8'); } });
  }
  const build0 = buildGeometry;
  buildGeometry = function(){ build0(); if (night) { darken(); updateBoothStates(); } requestDraw(); };
  const states0 = updateBoothStates;
  updateBoothStates = function(){ states0(); if (night) for (const g of geo) { g.accent.color.multiplyScalar(selected?.id === g.b.id ? 1 : .78); } requestDraw(); };
  function apply(){
    const n = isNight(); if (n === night) return; night = n;
    document.documentElement.classList.toggle('night', n);
    badgeTexture = n ? nightBadge : dayBadge;
    lightsFor(n);
    const at = assemblyAt; buildGeometry(); assemblyAt = at;   // bez ponownej animacji składania
    updateBoothStates();
  }
  // osadzenie w panelu (iframe): mapa wypełnia ramkę do dołu, bez przewijania i ucinania; cały obiekt w kadrze
  function fitFrame(){
    if (window.top === window) return;
    document.documentElement.classList.add('embed');
    const ws = document.querySelector('.workspace'), mc = document.querySelector('.map-card');
    if (!ws || !mc) return;
    if (innerWidth > 850) { ws.style.minHeight = '0'; ws.style.height = Math.max(300, innerHeight - ws.getBoundingClientRect().top - scrollY - 12) + 'px'; mc.style.height = ''; }
    else { ws.style.height = ''; ws.style.minHeight = '0'; mc.style.height = Math.max(300, innerHeight - mc.getBoundingClientRect().top - scrollY - 10) + 'px'; }
    requestAnimationFrame(() => { resize(); fitCamera(); });
  }
  fitFrame();
  addEventListener('resize', () => requestAnimationFrame(fitFrame));
  apply();
  addEventListener('storage', e => { if (e.key === 'theme') apply(); });
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', apply);
})();
