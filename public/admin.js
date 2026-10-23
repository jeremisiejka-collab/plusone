/* +1 — wspólny moduł strony i aplikacji: konto (hasło), panel admina (role, zaproszenia, poczta, moderacja),
   „Zobacz jako” dla głównych administratorów, bilety z kodem QR i skaner biletów aparatem.
   Ładowany przed głównym skryptem w public/index.html i private/app.html; korzysta z ich wspólnych nazw
   (S, ACC, LIVE, EVENTS, sheet, toast, apiCall, ic, esc, render, go…) dopiero w chwili wywołania. */

/* ---- „Zobacz jako”: główny administrator ogląda aplikację oczami innej roli (tylko widok) ---- */
function viewAs(){
  if(!ACC.user?.owner) return null;
  try{ const role = sessionStorage.getItem('viewAs'); return ['user','staff','admin'].includes(role) ? role : null; }catch(e){ return null; }
}
function effectiveRole(){ return viewAs() || (ACC.user?.owner || ACC.user?.role==='admin' ? 'admin' : ACC.user?.org ? 'organizer' : ACC.user?.scan ? 'staff' : 'user'); }
function setViewAs(v){
  if(!realOwner() || (v && !['user','staff','organizer','admin'].includes(v))) return;
  try{ v ? sessionStorage.setItem('viewAs', v) : sessionStorage.removeItem('viewAs'); }catch(e){}
  closeSheet(); toast(v ? 'Widok: '+roleName(v) : 'Wróciłeś do swojego konta', true, 1800);
  S.dir=null; S.prev='home'; S.screen='home'; render();
}
const realOwner = () => !!ACC.user?.owner;
function viewAsSheet(){
  const cur = viewAs();
  sheet(`<div class="col" style="gap:10px"><span class="h3">Zobacz jako</span>
    <span class="body" style="font-size:13px">Zobacz aplikację tak, jak widzi ją dana rola. To tylko podgląd — Twoje konto i uprawnienia się nie zmieniają.</span>
    ${ROLES.map(([k,l,d])=>`<button class="perm ${(cur||'')===k?'on':''}" data-act="viewAs:${k}">
      <span class="perm-box" style="border-radius:50%">${(cur||'')===k?ic('check',14,2.4):''}</span>
      <span class="col" style="flex:1;text-align:left"><span class="h4">${l}</span><span class="mono" style="margin-top:3px">${d}</span></span></button>`).join('')}
    ${cur?`<button class="btn g" data-act="viewAs:" style="height:48px;font:600 14px/1 var(--d)">Wróć do swojego konta</button>`:''}</div>`);
}
/* pasek na górze, gdy trwa podgląd innej roli */
function viewAsBar(){
  let bar = document.getElementById('viewasbar');
  const v = realOwner() && viewAs();
  if(!v){ bar && bar.remove(); return; }
  if(!bar){ bar = document.createElement('button'); bar.id='viewasbar'; bar.onclick = ()=>viewAsSheet(); document.body.appendChild(bar); }
  bar.innerHTML = `Widok: <b>${roleName(v)}</b> · zmień`;
}

/* ---- zainteresowania (rejestracja na stronie, edycja i alerty w aplikacji; klucze = INTEREST_KEYS w workerze) ---- */
const INTERESTS = [['clubbing','Clubbing'],['koncerty','Koncerty'],['festiwale','Festiwale'],['teatr','Teatr'],['standup','Stand-up i kabaret'],
  ['kino','Kino'],['sztuka','Sztuka i wystawy'],['klasyka','Opera i klasyka'],['sport','Sport'],['dzieci','Dla dzieci'],
  ['rap','Rap / hip-hop'],['rock','Rock i metal'],['jazz','Jazz i soul'],['techno','Techno / house'],['pop','Pop']];
const interestChips = (sel=[]) => `<div class="intchips">${INTERESTS.map(([k,l])=>`<button type="button" class="chip ${sel.includes(k)?'on':''}" data-int="${k}" onclick="this.classList.toggle('on')">${l}</button>`).join('')}</div>`;
const readInterests = root => $$('[data-int].on', root||document).map(b=>b.dataset.int);

/* ---- ładowanie bibliotek z naszego serwera (public/vendor) ---- */
const LIBS = {};
function loadLib(src){ return LIBS[src] = LIBS[src] || new Promise((ok,no)=>{ const t=document.createElement('script'); t.src=src; t.onload=ok; t.onerror=()=>{ delete LIBS[src]; no(new Error('lib')); }; document.head.appendChild(t); }); }

/* ---- bilet +1 z kodem QR ---- */
const TICKETS = { list:null, at:0 };
async function loadTickets(force){
  if(!ACC.user) return [];
  if(!force && TICKETS.list && Date.now()-TICKETS.at < 30e3) return TICKETS.list;
  try{ TICKETS.list = (await apiCall('/api/tickets')).tickets; TICKETS.at = Date.now(); }catch(e){ TICKETS.list = TICKETS.list || []; }
  return TICKETS.list;
}
async function ticketSheet(eventId){
  if(!ACC.user){ toast('Zaloguj się, żeby mieć bilet z kodem QR', true); return; }
  const e = EVENTS.find(x=>x.id===eventId);
  sheet(`<div class="col" style="gap:14px;align-items:center;text-align:center"><span class="mono" style="color:${PINK};letter-spacing:.12em">BILET +1</span>
    <span class="h3">${esc(e?e.name:'Wydarzenie')}</span><span class="mono">${e?esc(e.when+' · '+e.venue):''}</span>
    <div id="qrbox" style="width:240px;height:240px;border-radius:20px;background:#fff;display:grid;place-items:center;padding:14px"><span class="mono" style="color:#000">Ładuję…</span></div>
    <span id="qrcode" class="mono" style="letter-spacing:.08em"></span>
    <span class="body" style="font-size:13px;max-width:300px">Pokaż kod przy wejściu. Obsługa zeskanuje go aparatem — kod działa raz.</span></div>`);
  const [list] = await Promise.all([loadTickets(true), loadLib('/vendor/qr/qrcode.js')]);
  const t = list.find(x=>x.eventId===eventId), box = $('#qrbox');
  if(!box) return;
  if(!t){ box.innerHTML = '<span class="mono" style="color:#000;padding:10px">Najpierw stuknij „Mam bilet”.</span>'; return; }
  const q = qrcode(0, 'M'); q.addData(t.code); q.make();
  box.innerHTML = q.createSvgTag({cellSize:6, margin:0, scalable:true});
  const svg = box.querySelector('svg'); if(svg){ svg.style.width='100%'; svg.style.height='100%'; }
  $('#qrcode').textContent = t.usedAt ? 'Użyty '+new Date(t.usedAt).toLocaleString('pl-PL') : t.code;
}

/* ---- SKANER BILETÓW (obsługa biletów i administratorzy) ---- */
const SCAN = { stream:null, raf:0, last:'', lastAt:0, busy:false, result:null, count:0, detector:null, history:[], cameraRequest:0 };
const canScanNow = () => !!ACC.user && effectiveRole()!=='user';
const staffHeader = title => `<div class="pad col" style="gap:8px;margin-bottom:24px"><span class="eyebrow pink">Obsługa biletów</span><h1 class="h2">${title}</h1></div>`;
const staffStats = () => `<div class="staff-stats">
  <div class="card"><span class="mono">Wpuszczeni</span><strong>${SCAN.count}</strong></div>
  <div class="card"><span class="mono">Odrzucone</span><strong>${SCAN.history.filter(r=>['used','invalid'].includes(r.status)).length}</strong></div>
</div>`;
const scStaff = () => `<div class="pg staff-page" style="padding:64px 0 112px">
  ${staffHeader('Gotowi na wejście?')}
  <div class="pad col" style="gap:20px">
    <button class="staff-scan" data-act="go:scan"><span>${ic('scan',54)}</span><strong>Skanuj bilety</strong><span>Skieruj aparat na kod QR</span></button>
    ${staffStats()}
    <p class="mono">Statystyki z bieżącej sesji skanowania.</p>
  </div>
</div>`;
const scStaffStats = () => `<div class="pg staff-page" style="padding:64px 0 112px">
  ${staffHeader('Statystyki wejścia')}
  <div class="pad col" style="gap:18px">${staffStats()}
    <p class="body">Bieżąca sesja na tym urządzeniu. Cofnięte wejścia nie są wliczane do wpuszczonych.</p>
    <button class="btn g" data-act="go:staffActivity">Zobacz historię skanów</button>
  </div>
</div>`;
const scStaffActivity = () => `<div class="pg staff-page" style="padding:64px 0 112px">
  ${staffHeader('Historia skanów')}
  <div class="pad col" style="gap:12px">
    ${SCAN.history.length ? [...SCAN.history].reverse().map(r=>`<div class="staff-entry card">
      <span class="staff-entry-icon ${r.status==='ok'?'ok':''}">${ic(r.status==='ok'?'check':r.status==='undone'?'undo':'cross',20)}</span>
      <div class="col" style="gap:5px;flex:1"><strong>${esc({ok:'Wpuszczono',used:'Bilet już użyty',invalid:'Nieważny bilet',undone:'Cofnięto wejście',error:'Nie udało się sprawdzić'}[r.status]||'Sprawdzenie biletu')}</strong>
        <span class="mono">${esc(r.name||r.email||'Kod biletu')}</span></div>
      <time class="mono">${new Date(r.at).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'})}</time>
    </div>`).join('') : `<div class="card staff-empty">${ic('clock',32)}<h2 class="h3">Pierwszy skan przed Tobą</h2><p class="body">Tutaj pojawią się wyniki sprawdzeń z bieżącej sesji.</p></div>`}
  </div>
</div>`;
const scScan = () => {
  if(!canScanNow()) return `<div class="pg pad col" style="padding-top:120px;gap:14px"><span class="h3">Skaner jest dla obsługi biletów</span>
    <span class="body">Poproś administratora o rolę „Obsługa biletów”.</span><button class="btn g" data-act="back" style="height:48px">Wróć</button></div>`;
  const r = SCAN.result;
  return `
<div class="pg" style="padding:64px 0 112px">
  <div class="pad row" style="gap:12px;padding-bottom:14px">
    <button class="back" data-act="back" aria-label="Wróć">${ic('chevL',18)}</button>
    <div class="col" style="gap:3px;flex:1"><div class="h2">Skaner biletów</div><span class="mono" id="scancount">${SCAN.count?SCAN.count+' wpuszczonych w tej sesji':'Skieruj aparat na kod QR'}</span></div>
  </div>
  <div class="pad"><div class="scanbox ds">
    <video id="scanvid" playsinline muted autoplay></video>
    <div class="scanframe"><i></i><i></i><i></i><i></i><span class="scanline"></span></div>
    <div id="scanres" class="scanres ${r?'on '+r.status:''}">${r?scanResultHtml(r):''}</div>
    <div id="scanmsg" class="scanmsg"></div>
  </div></div>
  <div class="pad row" style="gap:8px;padding-top:14px">
    <input id="scancode" class="scaninput" placeholder="lub wpisz kod: P1-…" autocapitalize="characters" autocomplete="off" data-enter="scanManual">
    <button class="chip on" data-act="scanManual">Sprawdź</button>
  </div>
  <div class="pad mono" style="padding-top:10px;line-height:1.5">Zielony = wpuść. Czerwony = bilet już użyty albo nieważny. Kod działa tylko raz.</div>
</div>`;
};
function scanResultHtml(r){
  const e = r.eventId && EVENTS.find(x=>x.id===r.eventId);
  const big = {ok:'WPUŚĆ', used:'JUŻ UŻYTY', invalid:'NIEWAŻNY', undone:'COFNIĘTO', error:'BŁĄD'}[r.status] || '';
  const sub = r.status==='used' ? `${new Date(r.usedAt).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'})}${r.usedBy?' · '+esc(r.usedBy):''}` : r.message ? esc(r.message) : '';
  return `<span class="scanicon">${ic(r.status==='ok'||r.status==='undone'?'check':'cross',46,2.6)}</span>
    <b>${big}</b>${r.name||r.email?`<span>${esc(r.name||r.email)}</span>`:''}${e?`<span class="mono">${esc(e.name)}</span>`:''}${sub?`<span class="mono">${sub}</span>`:''}
    ${r.status==='ok'?`<button class="chip" data-act="scanUndo:${esc(r.code)}" style="margin-top:6px;background:rgba(0,0,0,.25);color:#fff;border-color:rgba(255,255,255,.4)">Cofnij</button>`:''}`;
}
async function scanCheck(code, undo=false){
  if(SCAN.busy || !canScanNow()) return; SCAN.busy = true;
  let r;
  try{ r = await apiCall('/api/scan','POST',{code, undo}); }catch(e){ r = {status:'error', message:e.message}; }
  r.code = code; SCAN.result = r; SCAN.busy = false;
  SCAN.history.push({status:r.status, name:r.name, email:r.email, at:Date.now()});
  if(r.status==='ok'){ SCAN.count++; sfxOk(); haptic(30); } else if(r.status==='undone'){ SCAN.count=Math.max(0,SCAN.count-1); sfxTap(); } else { sfxErr(); haptic([60,60,60]); }
  const box = $('#scanres'); if(box){ box.className = 'scanres on '+r.status; box.innerHTML = scanResultHtml(r); bind(box); }
  const c = $('#scancount'); if(c) c.textContent = SCAN.count+' wpuszczonych w tej sesji';
  clearTimeout(SCAN.hide); SCAN.hide = setTimeout(()=>{ const b=$('#scanres'); if(b){ b.className='scanres'; } SCAN.result=null; }, r.status==='ok'?2600:4000);
}
async function startScan(){
  const v = $('#scanvid'), msg = $('#scanmsg'); if(!v || !canScanNow()) return;
  if(SCAN.stream && v.srcObject===SCAN.stream) return;
  stopScan();
  const cameraRequest = SCAN.cameraRequest;
  try{
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Ta przeglądarka nie daje dostępu do aparatu.');
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}, width:{ideal:1280}}, audio:false});
    if(cameraRequest!==SCAN.cameraRequest || !v.isConnected || S.screen!=='scan' || !canScanNow()) { stream.getTracks().forEach(t=>t.stop()); return; }
    SCAN.stream = stream;
    v.srcObject = SCAN.stream; await v.play().catch(()=>{});
    if('BarcodeDetector' in window){ try{ SCAN.detector = new BarcodeDetector({formats:['qr_code']}); }catch(e){ SCAN.detector=null; } }
    if(!SCAN.detector) await loadLib('/vendor/qr/jsQR.js');
    if(cameraRequest!==SCAN.cameraRequest || !v.isConnected) return;
  }catch(e){
    if(cameraRequest!==SCAN.cameraRequest) return;
    stopScan();
    const reason = {NotAllowedError:'Zezwól na aparat w ustawieniach przeglądarki lub wpisz kod poniżej.',
      NotFoundError:'Nie znaleziono aparatu. Możesz wpisać kod poniżej.',
      NotReadableError:'Aparat jest zajęty. Zamknij inną aplikację korzystającą z kamery lub wpisz kod poniżej.'}[e.name]
      || 'Nie udało się uruchomić aparatu. Możesz wpisać kod poniżej.';
    if(msg) msg.innerHTML = `<b>Brak dostępu do aparatu</b><span>${esc(reason)}</span>`;
    return;
  }
  const c = document.createElement('canvas'), ctx = c.getContext('2d', {willReadFrequently:true});
  const tick = async () => {
    if(cameraRequest!==SCAN.cameraRequest) return;
    if(!SCAN.stream || !v.isConnected){ stopScan(); return; }
    if(v.readyState >= 2 && !SCAN.busy && !SCAN.result){
      let code = null;
      try{
        if(SCAN.detector){ const r = await SCAN.detector.detect(v); code = r[0]?.rawValue || null; }
        else {
          const w = 480, h = Math.round(480 * v.videoHeight / v.videoWidth) || 360;
          c.width = w; c.height = h; ctx.drawImage(v, 0, 0, w, h);
          const r = window.jsQR && jsQR(ctx.getImageData(0,0,w,h).data, w, h, {inversionAttempts:'dontInvert'});
          code = r?.data || null;
        }
      }catch(e){}
      if(cameraRequest!==SCAN.cameraRequest || S.screen!=='scan') return;
      if(code && !(code===SCAN.last && Date.now()-SCAN.lastAt < 4000)){ SCAN.last = code; SCAN.lastAt = Date.now(); scanCheck(code.trim()); }
    }
    SCAN.raf = setTimeout(tick, 160);
  };
  tick();
}
function stopScan(){
  SCAN.cameraRequest++;
  clearTimeout(SCAN.raf); SCAN.raf = 0;
  if(SCAN.stream){ try{ SCAN.stream.getTracks().forEach(t=>t.stop()); }catch(e){} SCAN.stream = null; }
}

/* wywoływane po każdym przerysowaniu ekranu */
function adminAfterRender(){
  if(S.screen==='scan') startScan(); else stopScan();
  viewAsBar();
}

/* akcje z data-act obsługiwane w tym module; zwraca true, jeśli rozpoznano */
function adminAct(cmd, p1, p2, a){
  switch(cmd){
    case 'perms': permsSheet(p1); return true;
    case 'savePerms': savePerms(p1); return true;
    case 'passwordSheet': passwordSheet(); return true;
    case 'savePassword': savePassword(); return true;
    case 'sendInvite': sendInvite(); return true;
    case 'revokeInvite': revokeInvite(p1); return true;
    case 'copyInvite': try{ navigator.clipboard.writeText(S.lastInvite.link); toast('Link skopiowany'); }catch(e){ toast('Skopiuj link ręcznie',true); } return true;
    case 'shareInvite': navigator.share ? navigator.share({title:S.lastInvite.mail.subject, text:S.lastInvite.mail.text}).catch(()=>{}) : adminAct('copyInvite'); return true;
    case 'clearInvite': S.lastInvite=null; S.dir=null; render(); return true;
    case 'saveMail': saveMail(); return true;
    case 'testMail': testMail(); return true;
    case 'dropMail': dropMail(); return true;
    case 'viewAsSheet': viewAsSheet(); return true;
    case 'detectMail': detectMail(); return true;
    case 'toggleNews': apiCall('/api/me','PATCH',{newsletter:!ACC.user.newsletter}).then(r=>{ ACC.user=r.user; toast(r.user.newsletter?'Newsletter włączony — w czwartki na maila':'Newsletter wyłączony', true); S.dir=null; render(); }).catch(e=>toast(esc(e.message),true)); return true;
    case 'newsTest': apiCall('/api/admin/newsletter','POST',{test:true}).then(r=>toast(r.sent?'Newsletter wysłany do Ciebie':'Nie wysłano — sprawdź główny e-mail',!r.sent)).catch(e=>toast(esc(e.message),true)); return true;
    case 'newsSend': if(confirm('Wysłać newsletter do wszystkich zapisanych?')) apiCall('/api/admin/newsletter','POST',{}).then(r=>toast('Wysłano: '+r.sent+' z '+r.of)).catch(e=>toast(esc(e.message),true)); return true;
    case 'alertsRun': apiCall('/api/admin/alerts/run','POST',{}).then(()=>toast('Alerty przeliczone')).catch(e=>toast(esc(e.message),true)); return true;
    case 'orgSort': S.orgSort=p1; S.dir=null; render(); return true;
    case 'orgSearch': S.orgQ=$('#org-q')?.value||''; S.dir=null; render(); return true;
    case 'orgOpen': ORG.user=+p1; ORG.data=null; go('org'); return true;
    case 'orgMine': ORG.user=null; ORG.data=null; go('org'); return true;
    case 'orgEvSort': S.orgEvSort=p1; S.dir=null; render(); return true;
    case 'guests': guestsSheet(a.slice(7)); return true;
    case 'addGuest': addGuest(a.slice(9)); return true;
    case 'delGuest': apiCall('/api/org/guests','DELETE',{code:p1}).then(()=>{ toast('Usunięto'); ORG.at=0; guestsSheet(a.slice(10+p1.length)); }).catch(e=>toast(esc(e.message),true)); return true;
    case 'viewAs': setViewAs(p1||null); return true;
    case 'ticketQR': ticketSheet(a.slice(9)); return true;
    case 'scanManual': { const v = ($('#scancode')?.value||'').trim(); if(v) scanCheck(v); return true; }
    case 'scanUndo': scanCheck(a.slice(9), true); return true;
  }
  return false;
}

/* ---- hasło ---- */
function passwordSheet(force=false){
  sheet(`<div class="col" style="gap:14px"><span class="h3">${force?'Ustaw własne hasło':'Zmień hasło'}</span>
    ${force?'<span class="body">Konto ma hasło startowe. Zmień je, zanim zaczniesz korzystać z panelu.</span>':''}
    <div class="field"><label>OBECNE HASŁO</label><input id="pw-cur" type="password" autocomplete="current-password"></div>
    <div class="field"><label>NOWE HASŁO (MIN. 8 ZNAKÓW)</label><input id="pw-new" type="password" autocomplete="new-password" data-enter="savePassword"></div>
    <button class="btn p" data-act="savePassword">Zapisz hasło</button>
    ${force?'':'<button class="btn g" data-act="closeSheet" style="height:48px;font:500 14px/1 var(--d)">Anuluj</button>'}</div>`);
  $$('[data-enter]',$('#sheet')).forEach(i=>{ i.onkeydown = e=>{ if(e.key==='Enter'){ e.preventDefault(); act(i.dataset.enter); } }; });
}
async function savePassword(){
  try{ ACC.user = (await apiCall('/api/me/password','POST',{current:$('#pw-cur')?.value||'', password:$('#pw-new')?.value||''})).user; }
  catch(e){ toast(esc(e.message),true); return; }
  closeSheet(); sfxOk(); toast('Hasło zmienione'); if(ACC.admin) ACC.admin.at=0; S.dir=null; render();
}

/* ---- role ----
   Rola: Użytkownik / Obsługa biletów (skanuje bilety) / Administrator. Dodatkowo: dostęp do aplikacji /app
   i — tylko dla głównych administratorów — rola głównego administratora. */
const ROLES = [['user','Użytkownik','Przegląda wydarzenia, zapisuje, ma bilety'],
  ['staff','Obsługa biletów','Skanuje bilety aparatem przy wejściu'],
  ['organizer','Organizator','Swoje wydarzenia, statystyki, lista gości, skaner'],
  ['admin','Administrator','Panel admina, użytkownicy, organizatorzy, zaproszenia']];
const userPerms = x => ({preview:!!x.preview_access, curate:!!x.perm_curate, admin:x.role==='admin'||!!x.owner, owner:!!x.owner, scan:!!x.perm_scan, org:!!x.perm_org,
  venues: (()=>{ try{ return JSON.parse(x.venues||'[]').filter(Boolean); }catch(e){ return []; } })()});
const levelOf = p => p.admin ? 'admin' : p.org ? 'organizer' : p.scan ? 'staff' : 'user';
/* miejsca z wydarzeń (podpowiedzi przy przypisywaniu organizatora) */
const venueOptions = () => [...new Set(EVENTS.filter(e=>e.real).map(e=>e.venue))].sort().slice(0,3000);
const roleName = k => (ROLES.find(r=>r[0]===k)||ROLES[0])[1];
const roleBtn = (k, on, lock) => `<button class="perm ${on?'on':''}" data-role="${k}" ${lock?'disabled':''} aria-pressed="${on}">
  <span class="perm-box" style="border-radius:50%">${on?ic('check',14,2.4):''}</span>
  <span class="col" style="flex:1;min-width:0;text-align:left"><span class="h4">${ROLES.find(r=>r[0]===k)[1]}</span><span class="mono" style="margin-top:3px">${ROLES.find(r=>r[0]===k)[2]}${lock?' · nadaje główny administrator':''}</span></span></button>`;
const checkBtn = (k, label, sub, on, lock) => `<button class="perm ${on?'on':''}" data-perm="${k}" ${lock?'disabled':''} aria-pressed="${on}">
  <span class="perm-box">${on?ic('check',14,2.4):''}</span>
  <span class="col" style="flex:1;min-width:0;text-align:left"><span class="h4">${label}</span><span class="mono" style="margin-top:3px">${sub}</span></span></button>`;
function wirePerms(root){
  $$('[data-role]', root).forEach(b=>b.onclick=()=>{ if(b.disabled) return;
    $$('[data-role]', root).forEach(o=>{ const on = o===b; o.classList.toggle('on',on); o.setAttribute('aria-pressed',on); o.querySelector('.perm-box').innerHTML=on?ic('check',14,2.4):''; }); haptic(5); });
  $$('[data-perm]', root).forEach(b=>b.onclick=()=>{ if(b.disabled) return; const on=!b.classList.contains('on'); b.classList.toggle('on',on); b.setAttribute('aria-pressed',on); b.querySelector('.perm-box').innerHTML=on?ic('check',14,2.4):''; haptic(5); });
}
const readRole = root => ($$('[data-role].on', root)[0]||{}).dataset?.role || 'user';
const readPerm = (root, k) => !!$(`[data-perm="${k}"]`, root)?.classList.contains('on');
function permsSheet(id){
  const x = ACC.admin?.users?.find(u=>u.id===+id); if(!x) return;
  const p = userPerms(x), lvl = levelOf(p), self = x.id===ACC.user.id, lockOwner = x.owner && !isOwner();
  sheet(`<div class="col" style="gap:10px"><span class="h3">Rola</span>
    <span class="mono" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.email)}</span>
    <div class="col" style="gap:8px">${ROLES.map(([k])=>roleBtn(k, lvl===k, lockOwner || self || ((k==='admin'||lvl==='admin') && !isOwner()))).join('')}</div>
    <div id="org-venues" class="field" style="${lvl==='organizer'?'':'display:none'}"><label>MIEJSCA I NAZWY WYDARZEŃ ORGANIZATORA (PO PRZECINKU)</label>
      <input id="pv-venues" list="venue-list" value="${esc(p.venues.join(', '))}" placeholder="np. Progresja, Klub Stodoła, Hype Festival" autocapitalize="off">
      <datalist id="venue-list">${venueOptions().map(v=>`<option value="${esc(v)}">`).join('')}</datalist>
      <span class="mono" style="line-height:1.5">Organizator widzi wydarzenia, których miejsce albo nazwa zawiera któreś z tych słów.</span></div>
    <div class="col" style="gap:8px;margin-top:6px">
      ${checkBtn('preview','Dostęp do aplikacji','Logowanie w aplikacji na telefon (/app)', p.preview || p.admin || p.scan, lockOwner)}
      ${isOwner()?checkBtn('owner','Główny administrator','Nadaje i odbiera administratora', p.owner, self):''}
    </div>
    <button class="btn p" data-act="savePerms:${x.id}">Zapisz</button></div>`);
  wirePerms($('#sheet'));
  $$('#sheet [data-role]').forEach(b=>b.addEventListener('click', ()=>{ const v=$('#org-venues'); if(v) v.style.display = readRole($('#sheet'))==='organizer' ? '' : 'none'; }));
}
async function savePerms(id){
  const x = ACC.admin?.users?.find(u=>u.id===+id), p = userPerms(x), root = $('#sheet');
  const lvl = readRole(root), diff = {};
  if(lvl !== levelOf(p)){
    if((lvl==='admin') !== p.admin) diff.admin = lvl==='admin';
    if((lvl==='staff') !== p.scan) diff.scan = lvl==='staff';
    if((lvl==='organizer') !== p.org) diff.org = lvl==='organizer';
  }
  if(lvl==='organizer'){
    const v = ($('#pv-venues')?.value||'').split(',').map(x=>x.trim()).filter(Boolean);
    if(v.join('|') !== p.venues.join('|')) diff.venues = v;
  }
  const prev = readPerm(root,'preview'); if(prev !== p.preview) diff.preview = prev;
  if($('[data-perm="owner"]', root) && !$('[data-perm="owner"]', root).disabled){ const o = readPerm(root,'owner'); if(o !== p.owner) diff.owner = o; }
  if(!Object.keys(diff).length){ closeSheet(); return; }
  try{ await apiCall(`/api/admin/users/${id}/perms`,'POST',diff); }catch(e){ toast(esc(e.message),true); return; }
  closeSheet(); sfxOk(); toast('Zapisano: '+roleName(lvl)); adminLoad();
}

/* ---- zaproszenia ---- */
async function sendInvite(){
  const root = $('#inv-form'), email = $('#inv-email')?.value.trim(), lvl = readRole(root);
  if(!email){ toast('Wpisz adres e-mail',true); return; }
  try{
    const r = await apiCall('/api/admin/invites','POST',{email, preview:true, admin:lvl==='admin', scan:lvl==='staff', org:lvl==='organizer'});
    S.lastInvite = {...r, email}; sfxOk();
    toast(r.emailed ? 'Zaproszenie wysłane na '+esc(email) : r.existing ? 'Uprawnienia nadane' : 'Zaproszenie gotowe — wyślij link', !r.emailed);
    adminLoad();
  }catch(e){ toast(esc(e.message),true); }
}
async function revokeInvite(id){
  try{ await apiCall('/api/admin/invites/'+id,'DELETE',{}); toast('Zaproszenie cofnięte'); adminLoad(); }catch(e){ toast(esc(e.message),true); }
}

/* ---- admin ---- */
async function adminLoad(){
  try{
    const [stats, users, st, inv, mail, orgs] = await Promise.all([apiCall('/api/admin/stats'), apiCall('/api/admin/users?q='+encodeURIComponent(S.adminQ||'')), apiCall('/api/state'), apiCall('/api/admin/invites'),
      isOwner() ? apiCall('/api/admin/mail') : null, apiCall('/api/admin/organizers').catch(()=>({organizers:[]}))]);
    ACC.hidden=new Set(st.hidden); ACC.featured=st.featured;
    ACC.admin={stats, users:users.users, invites:inv.invites, mailer:inv.mailer, mail, orgs:orgs.organizers, at:Date.now()};
  }catch(e){ ACC.admin={error:e.message, at:Date.now()}; }
  S.dir=null; render();
}
async function curate(id, action){
  try{ await apiCall('/api/admin/curation','POST',{eventId:id, action}); }
  catch(e){ toast(esc(e.message),true); return; }
  ACC.hidden.delete(id); ACC.featured = ACC.featured.filter(x=>x!==id);
  if(action==='hide') ACC.hidden.add(id);
  if(action==='feature') ACC.featured.unshift(id);
  toast(action==='hide'?'Ukryte dla wszystkich':action==='feature'?'Dodane do polecanych':'Przywrócone');
  if(ACC.admin) ACC.admin.at=0;
  S.dir=null; render();
}

/* ---- PANEL ADMINA: poczta (SMTP skrzynki, z której wychodzą zaproszenia) ---- */
const adminMailTab = A => {
  const c = A.mail?.smtp || {};
  const f = (id, label, val, attrs='') => `<div class="field"><label>${label}</label><input id="${id}" value="${esc(val??'')}" ${attrs}></div>`;
  return `<div id="mail-form" class="card" style="padding:18px;display:flex;flex-direction:column;gap:12px">
    <div class="row" style="justify-content:space-between;gap:10px"><span class="h3">Główny e-mail aplikacji</span>
      <span class="badge ${A.mail?.smtp?'':'off'}">${A.mail?.smtp?'podłączona':A.mail?.resend?'Resend':'niepodłączona'}</span></div>
    <span class="body" style="font-size:13px">Jedna skrzynka, z której +1 wysyła wszystko: zaproszenia, alerty, newsletter, bilety gości i reset hasła.
      Wpisz adres i hasło — serwer dobierzemy sami.</span>
    <div class="row" style="gap:8px;align-items:flex-end">
      <div style="flex:1">${f('ml-user','ADRES E-MAIL (LOGIN)',c.user,'type="email" autocapitalize="off" autocomplete="off" placeholder="kontakt@tooday.pl"')}</div>
      <button class="chip on" data-act="detectMail" style="height:50px">Dobierz serwer</button></div>
    <div id="ml-hint" class="mono" style="line-height:1.5;${S.mailHint?'':'display:none'}">${S.mailHint||''}</div>
    ${f('ml-host','SERWER SMTP',c.host,'placeholder="smtp.twojadomena.pl" autocapitalize="off"')}
    <div class="row" style="gap:10px">
      <div class="field" style="flex:1"><label>PORT</label><select id="ml-port" class="sel">${[[465,'465 · SSL/TLS'],[587,'587 · STARTTLS']].map(([v,l])=>`<option value="${v}" ${+c.port===v?'selected':''}>${l}</option>`).join('')}</select></div>
    </div>
    ${f('ml-pass','HASŁO DO SKRZYNKI','', `type="password" autocomplete="new-password" placeholder="${c.hasPass?'zapisane — wpisz, żeby zmienić':''}"`)}
    ${f('ml-from','ADRES NADAWCY',c.from||c.user,'type="email" autocapitalize="off"')}
    ${f('ml-name','NAZWA NADAWCY',c.fromName||'+1')}
    <button class="btn p" data-act="saveMail">Zapisz</button>
    ${A.mail?.smtp?`<div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="chip on" data-act="testMail">Wyślij test na ${esc(ACC.user.email)}</button>
      <button class="chip" data-act="dropMail">Odłącz</button></div>`:''}
    <span class="mono" style="line-height:1.5">Hasło jest zapisane na serwerze +1 i nie wraca do przeglądarki. Ustawia je tylko główny administrator.</span>
  </div>
  <div class="card" style="margin-top:12px;padding:18px;display:flex;flex-direction:column;gap:10px">
    <span class="h3">Newsletter i alerty</span>
    <span class="body" style="font-size:13px">„Na topie w Twoim mieście” wychodzi w czwartki ok. 10:00 do osób z włączonym newsletterem. Alerty (nowości z zainteresowań, taniej, przypomnienia) — co 6 godzin.</span>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="chip on" data-act="newsTest">Newsletter: test do mnie</button>
      <button class="chip" data-act="newsSend">Wyślij newsletter teraz</button>
      <button class="chip" data-act="alertsRun">Uruchom alerty teraz</button></div>
  </div>`;
};
async function detectMail(){
  const email = $('#ml-user')?.value.trim(); if(!email){ toast('Wpisz adres e-mail',true); return; }
  try{
    const r = await apiCall('/api/admin/mail/detect?email='+encodeURIComponent(email));
    if(r.host) $('#ml-host').value = r.host;
    if(r.port) $('#ml-port').value = String(r.port);
    if(!$('#ml-from').value) $('#ml-from').value = email;
    S.mailHint = (r.provider?'Dostawca: <b>'+esc(r.provider)+'</b>. ':'') + esc(r.note||'Wpisz hasło i zapisz, potem wyślij test.');
    const h = $('#ml-hint'); if(h){ h.style.display=''; h.innerHTML = S.mailHint; }
  }catch(e){ toast(esc(e.message),true); }
}
async function saveMail(){
  const v = id => $('#'+id)?.value.trim();
  try{
    ACC.admin.mail = await apiCall('/api/admin/mail','POST',{host:v('ml-host'), port:+v('ml-port'), user:v('ml-user'), pass:$('#ml-pass')?.value||'', from:v('ml-from')||v('ml-user'), fromName:v('ml-name')});
    toast('Zapisano — wyślij test, żeby sprawdzić'); sfxOk(); ACC.admin.mailer = true; S.dir=null; render();
  }catch(e){ toast(esc(e.message),true); }
}
async function testMail(){
  toast('Wysyłam…',true,1500);
  try{ const r = await apiCall('/api/admin/mail/test','POST',{}); toast('Wysłano na '+esc(r.to)+' — sprawdź skrzynkę'); sfxOk(); }
  catch(e){ toast(esc(e.message),true,6000); }
}
async function dropMail(){
  try{ ACC.admin.mail = await apiCall('/api/admin/mail','DELETE',{}); ACC.admin.at=0; toast('Poczta odłączona'); adminLoad(); }catch(e){ toast(esc(e.message),true); }
}

/* ---- PANEL ADMINA: organizatorzy (sortowanie, wejście w konkretnego) ---- */
const ORG_SORT = [['going','Najwięcej chętnych'],['upcoming','Najwięcej wydarzeń'],['name','Nazwa']];
const adminOrgsTab = A => {
  const sort = S.orgSort || 'going', q = fold(S.orgQ||'');
  const list = (A.orgs||[]).filter(o=>!q || fold(o.name+' '+o.email+' '+o.venues.join(' ')).includes(q))
    .sort((a,b)=> sort==='name' ? (a.name||a.email).localeCompare(b.name||b.email) : (b[sort]-a[sort]));
  return `<div class="field" style="padding-bottom:10px"><input id="org-q" placeholder="Szukaj organizatora lub miejsca" value="${esc(S.orgQ||'')}" data-enter="orgSearch" autocapitalize="off"></div>
  <div class="row" style="gap:8px;flex-wrap:wrap;padding-bottom:6px">${ORG_SORT.map(([k,l])=>`<button class="chip ${sort===k?'on':''}" data-act="orgSort:${k}" style="padding:7px 12px;font-size:12px">${l}</button>`).join('')}</div>
  ${list.map(o=>`<button class="row" data-act="orgOpen:${o.id}" style="width:100%;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);text-align:left;color:var(--t1)">
    <span style="width:42px;height:42px;border-radius:13px;background:var(--pink-dim);color:var(--pink);display:grid;place-items:center;font:700 16px/1 var(--d);flex:none">${esc((o.name||o.email)[0].toUpperCase())}</span>
    <div class="col" style="flex:1;min-width:0"><span class="h4">${esc(o.name||o.email)}</span>
      <span class="mono" style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(o.venues.join(', ')||'brak przypisanych miejsc')}</span></div>
    <div class="col" style="align-items:flex-end;gap:3px"><b style="font:700 18px/1 var(--d)">${pl(o.going)}</b><span class="mono">chętnych · ${o.upcoming} wyd.</span></div>
  </button>`).join('') || `<span class="mono" style="display:block;padding:12px 0">Brak organizatorów. Nadaj rolę „Organizator” w zakładce Użytkownicy albo zaproś organizatora.</span>`}`;
};

/* ---- PANEL ORGANIZATORA: wydarzenia, statystyki, lista gości ---- */
const ORG = { data:null, user:null, at:0 };
const isOrgNow = () => ['organizer','admin'].includes(effectiveRole());
async function orgLoad(){
  try{ ORG.data = await apiCall('/api/org/me'+(ORG.user?'?user='+ORG.user:'')); }catch(e){ ORG.data = {error:e.message}; }
  ORG.at = Date.now(); S.dir=null; render();
}
const scOrg = () => {
  if(!isOrgNow()) return `<div class="pg pad col" style="padding-top:120px;gap:14px"><span class="h3">Panel organizatora</span>
    <span class="body">To miejsce dla organizatorów wydarzeń. Napisz do nas, żeby dostać dostęp.</span><button class="btn g" data-act="back" style="height:48px">Wróć</button></div>`;
  const D = ORG.data;
  if(!D || Date.now()-ORG.at>60e3) setTimeout(orgLoad,0);
  const sort = S.orgEvSort || 'date', t = localDay();
  const evs = (D?.events||[]).slice().sort((a,b)=> sort==='going' ? b.going-a.going : sort==='hot' ? b.hot-a.hot : a.start.localeCompare(b.start));
  const up = evs.filter(e=>e.start.slice(0,10)>=t), sum = k => up.reduce((s,e)=>s+(e[k]||0),0);
  return `
<div class="pg" style="padding:64px 0 112px">
  <div class="pad row" style="gap:12px;padding-bottom:14px">
    <button class="back" data-act="back" aria-label="Wróć">${ic('chevL',18)}</button>
    <div class="col" style="gap:3px;flex:1;min-width:0"><div class="h2" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(D?.organizer?.name||D?.organizer?.email||'Panel organizatora')}</div>
      <span class="mono" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((D?.venues||[]).join(', ')||'')}</span></div>
  </div>
  <div class="pad">
  ${D?.error ? `<div class="err">${esc(D.error)}</div>` : !D ? loadingBox() : !D.venues.length ? `<div class="card" style="padding:16px"><span class="h4">Brak przypisanych miejsc</span>
    <p class="body" style="margin-top:6px">Administrator przypisuje organizatorowi miejsca i nazwy wydarzeń (Panel admina → Użytkownicy → Rola → Organizator).</p></div>` : `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${[['Nadchodzące wydarzenia',up.length],['Idą („Mam bilet”)',sum('going')],['Zapisali',sum('saves')],['Obserwują',sum('followers')],['Goście na liście',sum('guests')],['Wpuszczeni',sum('used')+sum('guestsUsed')]]
        .map(([l,v])=>`<div class="statc"><span class="mono">${l}</span><b>${pl(v)}</b></div>`).join('')}
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap;padding:18px 0 6px">${[['date','Najbliższe'],['going','Najwięcej chętnych'],['hot','Na topie']].map(([k,l])=>`<button class="chip ${sort===k?'on':''}" data-act="orgEvSort:${k}" style="padding:7px 12px;font-size:12px">${l}</button>`).join('')}
      <button class="chip" data-act="go:scan" style="padding:7px 12px;font-size:12px">${'Skaner'}</button></div>
    ${evs.map(e=>`<div class="row" style="gap:12px;padding:14px 0;border-bottom:1px solid var(--line);${e.start.slice(0,10)<t?'opacity:.55':''}">
      <div class="col" style="flex:1;min-width:0;cursor:pointer" data-act="ev:${esc(e.id)}"><span class="h4 clamp2">${esc(e.title)}</span>
        <span class="mono" style="margin-top:4px">${esc(e.start.slice(8,10)+'.'+e.start.slice(5,7)+' '+e.start.slice(11,16)+' · '+e.venue)}</span>
        <span class="row" style="gap:5px;margin-top:6px;flex-wrap:wrap">${[[e.going,'idzie'],[e.saves,'zapisało'],[e.followers,'obserwuje'],[e.guests,'gości'],[e.used+e.guestsUsed,'wpuszczonych']]
          .filter(x=>x[0]).map(([n,l])=>`<span class="badge">${pl(n)} ${l}</span>`).join('') || '<span class="mono">jeszcze bez zapisów</span>'}</span></div>
      <button class="chip" data-act="guests:${esc(e.id)}" style="padding:7px 12px;font-size:12px;flex:none">Goście</button></div>`).join('') || '<span class="mono">Brak wydarzeń pasujących do miejsc organizatora.</span>'}`}
  </div>
</div>`;
};
async function guestsSheet(id){
  const e = EVENTS.find(x=>x.id===id);
  let list = [];
  try{ list = (await apiCall('/api/org/guests?event='+encodeURIComponent(id))).guests; }catch(err){ toast(esc(err.message),true); return; }
  sheet(`<div class="col" style="gap:12px"><span class="h3">Lista gości</span><span class="mono">${esc(e?e.name:id)}</span>
    <div class="field"><label>IMIĘ I NAZWISKO</label><input id="gs-name" autocomplete="off"></div>
    <div class="field"><label>E-MAIL (BILET Z QR PRZYJDZIE MAILEM)</label><input id="gs-email" type="email" autocapitalize="off" data-enter="addGuest:${esc(id)}"></div>
    <button class="btn p" data-act="addGuest:${esc(id)}" style="height:50px">Dodaj gościa</button>
    <div>${list.map(g=>`<div class="row" style="gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
      <div class="col" style="flex:1;min-width:0"><span class="h4">${esc(g.name)}</span><span class="mono" style="margin-top:3px">${esc(g.email||'bez maila')} · ${g.used_at?'wpuszczony':'czeka'}</span></div>
      <a class="chip" href="/t/${esc(g.code)}" target="_blank" rel="noopener" style="padding:6px 10px;font-size:12px">QR</a>
      <button class="chip" data-act="delGuest:${esc(g.code)}:${esc(id)}" style="padding:6px 10px;font-size:12px">Usuń</button></div>`).join('') || '<span class="mono">Na liście nikogo jeszcze nie ma.</span>'}</div></div>`);
  $$('[data-enter]',$('#sheet')).forEach(i=>{ i.onkeydown = ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); act(i.dataset.enter); } }; });
}
async function addGuest(id){
  const name = $('#gs-name')?.value.trim(), email = $('#gs-email')?.value.trim();
  try{ const r = await apiCall('/api/org/guests','POST',{eventId:id, name, email});
    toast(r.emailed ? 'Dodano — bilet poszedł mailem' : 'Dodano — link do biletu: /t/'+esc(r.code), true, 3200); sfxOk(); ORG.at=0; guestsSheet(id); }
  catch(e){ toast(esc(e.message),true); }
}

/* ---- PANEL ADMINA: zaproszenia ---- */
const adminInvitesTab = A => {
  const L = S.lastInvite, now = Date.now();
  return `
  <div id="inv-form" class="card" style="padding:18px;display:flex;flex-direction:column;gap:12px">
    <span class="h3">Zaproś do +1</span>
    <span class="body" style="font-size:13px">${A.mailer?'Zaproszenie przyjdzie mailem z linkiem. Osoba ustawia hasło i od razu ma wybrane uprawnienia.':'Wysyłka maili nie jest jeszcze podłączona'+(isOwner()?' (zakładka Poczta)':'')+' — po utworzeniu zaproszenia skopiuj link albo wyślij go ze swojej poczty.'}</span>
    <div class="field"><label>E-MAIL</label><input id="inv-email" type="email" inputmode="email" autocapitalize="off" placeholder="ktos@przyklad.pl" data-enter="sendInvite"></div>
    <div class="col" style="gap:8px">${ROLES.map(([k])=>roleBtn(k, k==='user', k==='admin' && !isOwner())).join('')}</div>
    <button class="btn p" data-act="sendInvite">${A.mailer?'Wyślij zaproszenie':'Utwórz zaproszenie'}</button>
  </div>
  ${L ? `<div class="card" style="margin-top:12px;padding:16px;display:flex;flex-direction:column;gap:10px;border-color:var(--pink-line)">
    <span class="h4">${L.emailed?'Wysłano na '+esc(L.email):L.existing?'Uprawnienia nadane: '+esc(L.email):'Link dla '+esc(L.email)}</span>
    ${L.emailed?'':`<input readonly value="${esc(L.link)}" onclick="this.select()" style="height:44px;border-radius:12px;padding:0 12px;background:var(--surface-2);border:1px solid var(--line-2);font:400 12px/1 var(--m);color:var(--t1)">
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="chip on" data-act="copyInvite">Kopiuj link</button>
      <a class="chip" href="mailto:${encodeURIComponent(L.email)}?subject=${encodeURIComponent(L.mail.subject)}&body=${encodeURIComponent(L.mail.text)}">Wyślij z poczty</a>
      <button class="chip" data-act="shareInvite">Udostępnij</button>
    </div>`}
    <button class="mono" data-act="clearInvite" style="align-self:flex-start;color:var(--t3)">Zamknij</button></div>` : ''}
  <div class="h4" style="padding:22px 0 4px">Wysłane zaproszenia</div>
  ${(A.invites||[]).map(i=>{ const st = i.used_at ? 'przyjęte' : i.expires_at<now ? 'wygasło' : 'czeka';
    return `<div class="row" style="gap:12px;padding:12px 0;border-bottom:1px solid var(--line)">
      <div class="col" style="flex:1;min-width:0"><span class="h4" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(i.email)}</span>
        <span class="mono" style="margin-top:4px">${i.admin?'administrator':i.scan?'obsługa biletów':'użytkownik'} · ${new Date(i.created_at).toLocaleDateString('pl-PL')}${i.by_email?' · od '+esc(i.by_email):''}</span></div>
      <span class="badge ${st==='czeka'?'':'off'}">${st}</span>
      ${st==='czeka'?`<button class="chip" data-act="revokeInvite:${i.id}" style="padding:7px 12px;font-size:12px">Cofnij</button>`:''}</div>`; }).join('') || '<span class="mono" style="display:block;padding:12px 0">Jeszcze nikogo nie zaproszono.</span>'}`;
};

/* ---- PANEL ADMINA ---- */
const scAdmin = () => {
  if(!isAdmin()) return `<div class="pg pad col" style="padding-top:120px;gap:14px"><span class="h3">${viewAs()?'Ten widok nie ma panelu admina':'Tylko dla admina'}</span>
    <button class="btn p" data-act="authgo:admin" style="height:48px">Zaloguj się jako admin</button></div>`;
  const A = ACC.admin;
  if(!A || Date.now()-A.at>60e3) setTimeout(adminLoad,0);
  const tab = S.adminTab||'stats';
  const byId = id => EVENTS.find(e=>e.id===id);
  const curList = (ids, lbl) => ids.length ? ids.map(id=>{ const e=byId(id); return `
    <div class="row" style="gap:12px;padding:12px 0;border-bottom:1px solid var(--line)">
      <div class="col" style="flex:1;min-width:0"><span class="h4 clamp2">${esc(e?e.name:id)}</span>
        <span class="mono" style="margin-top:4px">${e?esc(e.when+' · '+e.city):'wydarzenie już minęło'}</span></div>
      <button class="chip" data-act="curate:${id}:clear" style="padding:7px 12px;font-size:12px">${lbl}</button></div>`}).join('') : `<span class="mono" style="display:block;padding:12px 0">Pusto.</span>`;
  const src = LIVE.sources||{};
  return `
<div class="pg" style="padding:0 0 60px">
  <div class="hdr"><button class="back" data-act="back">${ic('chevL',18)}</button><span class="h4" style="flex:1">Panel admina</span>
    <button class="mono" data-act="adminReload" style="color:${PINK}">ODŚWIEŻ</button></div>
  <div class="sc" style="display:flex;gap:8px;overflow-x:auto;padding:16px 20px">
    ${[['stats','Statystyki'],['users','Użytkownicy'],['orgs','Organizatorzy'],['invites','Zaproszenia'],...(isOwner()?[['mail','Główny e-mail']]:[]),['curation','Moderacja'],['data','Dane']].map(([k,l])=>
      `<button class="chip ${tab===k?'on':''}" data-act="adminTab:${k}">${l}</button>`).join('')}
  </div>
  <div class="pad">
  ${A?.error ? `<div class="err">${esc(A.error)}</div>` : !A ? loadingBox() : tab==='stats' ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${[['Użytkownicy',A.stats.users],['Nowi (7 dni)',A.stats.new7],['Aktywni (7 dni)',A.stats.active7],['Admini',A.stats.admins],['Obsługa biletów',A.users.filter(u=>u.perm_scan).length],
         ['Zaproszenia (czekają)',(A.invites||[]).filter(i=>!i.used_at&&i.expires_at>Date.now()).length],['Wydarzeń w bazie',LIVE.count||EVENTS.filter(e=>e.real).length],['W mieście '+S.city,inCity().length],['Polecane',A.stats.featured],['Ukryte',A.stats.hidden]]
        .map(([l,v])=>`<div class="statc"><span class="mono">${esc(l)}</span><b>${pl(v||0)}</b></div>`).join('')}
    </div>` : tab==='users' ? `
    <div class="field" style="padding-bottom:10px"><input id="adm-q" placeholder="Szukaj po e-mailu lub imieniu" value="${esc(S.adminQ||'')}" data-enter="adminSearch" autocapitalize="off"></div>
    ${A.users.map(x=>{ const p=userPerms(x); return `
    <div class="row" style="gap:12px;padding:12px 0;border-bottom:1px solid var(--line)">
      <div class="col" style="flex:1;min-width:0">
        <span class="h4" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.name||'—')}</span>
        <span class="mono" style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.email)}</span>
        <span class="row" style="gap:5px;margin-top:6px;flex-wrap:wrap">${[p.owner?'Główny admin':roleName(levelOf(p)), (p.preview||p.admin||p.scan)&&'aplikacja', x.must_change&&'hasło startowe']
          .filter(Boolean).map((t,i)=>`<span class="badge ${i?'off':''}">${t}</span>`).join('')}<span class="mono">· od ${new Date(x.created_at).toLocaleDateString('pl-PL')}</span></span>
      </div>
      <button class="chip" data-act="perms:${x.id}" style="padding:7px 12px;font-size:12px">Rola</button>
    </div>`; }).join('') || '<span class="mono">Brak wyników.</span>'}` : tab==='invites' ? adminInvitesTab(A) : tab==='orgs' ? adminOrgsTab(A) : tab==='mail' ? adminMailTab(A) : tab==='curation' ? `
    <span class="body" style="display:block;padding-bottom:10px">Polecaj albo ukrywaj wydarzenia przyciskami na ekranie wydarzenia. Tu możesz to cofnąć.</span>
    <div class="h4" style="padding:10px 0 4px">Polecane</div>${curList(ACC.featured,'Usuń z polecanych')}
    <div class="h4" style="padding:20px 0 4px">Ukryte</div>${curList([...ACC.hidden],'Przywróć')}` : `
    <div class="col" style="gap:10px">
      <div class="statc"><span class="mono">Ostatnia aktualizacja</span><b style="font-size:18px">${LIVE.updatedAt?new Date(LIVE.updatedAt).toLocaleString('pl-PL'):'—'}</b></div>
      ${Object.entries(src).map(([k,v])=>`<div class="statc row" style="justify-content:space-between">
        <span class="h4">${esc(SRC_PL[k]||k)}</span><span class="mono" style="color:${v.ok?'var(--ok)':PINK}">${v.ok?pl(v.count)+' wydarzeń':'błąd'}</span></div>`).join('')}
      <a class="btn g" href="https://github.com/jeremisiejka-collab/plusone/actions/workflows/events.yml" target="_blank" rel="noopener"
        style="height:48px;font:600 14px/1 var(--d);display:flex;align-items:center;justify-content:center;text-decoration:none">Uruchom aktualizację (GitHub)</a>
      <span class="mono" style="line-height:1.6">Automatyczna aktualizacja: 2× dziennie (ok. 6:00 i 16:00).</span>
    </div>`}
  </div>
</div>`;
};

