/* +1 — wspólny moduł strony i aplikacji: konto (hasło), panel admina (role, zaproszenia, poczta, moderacja),
   „Zobacz jako” dla głównych administratorów, bilety z kodem QR i skaner biletów aparatem.
   Ładowany przed głównym skryptem w public/index.html i private/app.html; korzysta z ich wspólnych nazw
   (S, ACC, LIVE, EVENTS, sheet, toast, apiCall, ic, esc, render, go…) dopiero w chwili wywołania. */

/* ---- „Zobacz jako”: główny administrator ogląda aplikację oczami innej roli (tylko widok) ---- */
function viewAs(){
  if(!ACC.user?.owner) return null;
  try{ const role = sessionStorage.getItem('viewAs'); return ['user','staff','admin'].includes(role) ? role : null; }catch(e){ return null; }
}
function effectiveRole(){ return viewAs() || (ACC.user?.owner || ACC.user?.role==='admin' ? 'admin' : ACC.user?.scan ? 'staff' : 'user'); }
function setViewAs(v){
  if(!realOwner() || (v && !['user','staff','admin'].includes(v))) return;
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
  ['admin','Administrator','Panel admina, użytkownicy, zaproszenia, moderacja']];
const userPerms = x => ({preview:!!x.preview_access, curate:!!x.perm_curate, admin:x.role==='admin'||!!x.owner, owner:!!x.owner, scan:!!x.perm_scan});
const levelOf = p => p.admin ? 'admin' : p.scan ? 'staff' : 'user';
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
    <div class="col" style="gap:8px;margin-top:6px">
      ${checkBtn('preview','Dostęp do aplikacji','Logowanie w aplikacji na telefon (/app)', p.preview || p.admin || p.scan, lockOwner)}
      ${isOwner()?checkBtn('owner','Główny administrator','Nadaje i odbiera administratora', p.owner, self):''}
    </div>
    <button class="btn p" data-act="savePerms:${x.id}">Zapisz</button></div>`);
  wirePerms($('#sheet'));
}
async function savePerms(id){
  const x = ACC.admin?.users?.find(u=>u.id===+id), p = userPerms(x), root = $('#sheet');
  const lvl = readRole(root), diff = {};
  if(lvl !== levelOf(p)){
    if((lvl==='admin') !== p.admin) diff.admin = lvl==='admin';
    if((lvl==='staff') !== p.scan) diff.scan = lvl==='staff';
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
    const r = await apiCall('/api/admin/invites','POST',{email, preview:true, admin:lvl==='admin', scan:lvl==='staff'});
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
    const [stats, users, st, inv, mail] = await Promise.all([apiCall('/api/admin/stats'), apiCall('/api/admin/users?q='+encodeURIComponent(S.adminQ||'')), apiCall('/api/state'), apiCall('/api/admin/invites'),
      isOwner() ? apiCall('/api/admin/mail') : null]);
    ACC.hidden=new Set(st.hidden); ACC.featured=st.featured;
    ACC.admin={stats, users:users.users, invites:inv.invites, mailer:inv.mailer, mail, at:Date.now()};
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
    <div class="row" style="justify-content:space-between;gap:10px"><span class="h3">Poczta</span>
      <span class="badge ${A.mail?.smtp?'':'off'}">${A.mail?.smtp?'podłączona':A.mail?.resend?'Resend':'niepodłączona'}</span></div>
    <span class="body" style="font-size:13px">Zaloguj skrzynkę, z której mają wychodzić zaproszenia (np. kontakt@tooday.pl). Dane serwera SMTP znajdziesz w ustawieniach poczty u dostawcy —
      np. home.pl: <b>serwerXXXXXX.home.pl</b>, OVH: <b>ssl0.ovh.net</b>, Google Workspace: <b>smtp.gmail.com</b> z hasłem aplikacji, Microsoft 365: <b>smtp.office365.com</b> (587).</span>
    ${f('ml-host','SERWER SMTP',c.host,'placeholder="smtp.twojadomena.pl" autocapitalize="off"')}
    <div class="row" style="gap:10px">
      <div class="field" style="flex:1"><label>PORT</label><select id="ml-port" class="sel">${[[465,'465 · SSL/TLS'],[587,'587 · STARTTLS']].map(([v,l])=>`<option value="${v}" ${+c.port===v?'selected':''}>${l}</option>`).join('')}</select></div>
    </div>
    ${f('ml-user','LOGIN (ZWYKLE ADRES E-MAIL)',c.user,'autocapitalize="off" autocomplete="off"')}
    ${f('ml-pass','HASŁO DO SKRZYNKI','', `type="password" autocomplete="new-password" placeholder="${c.hasPass?'zapisane — wpisz, żeby zmienić':''}"`)}
    ${f('ml-from','ADRES NADAWCY',c.from||c.user,'type="email" autocapitalize="off"')}
    ${f('ml-name','NAZWA NADAWCY',c.fromName||'+1')}
    <button class="btn p" data-act="saveMail">Zapisz</button>
    ${A.mail?.smtp?`<div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="chip on" data-act="testMail">Wyślij test na ${esc(ACC.user.email)}</button>
      <button class="chip" data-act="dropMail">Odłącz</button></div>`:''}
    <span class="mono" style="line-height:1.5">Hasło jest zapisane na serwerze +1 i nie wraca do przeglądarki. Ustawia je tylko główny administrator.</span>
  </div>`;
};
async function saveMail(){
  const v = id => $('#'+id)?.value.trim();
  try{
    ACC.admin.mail = await apiCall('/api/admin/mail','POST',{host:v('ml-host'), port:+v('ml-port'), user:v('ml-user'), pass:$('#ml-pass')?.value||'', from:v('ml-from'), fromName:v('ml-name')});
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
    ${[['stats','Statystyki'],['users','Użytkownicy'],['invites','Zaproszenia'],...(isOwner()?[['mail','Poczta']]:[]),['curation','Moderacja'],['data','Dane']].map(([k,l])=>
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
    </div>`; }).join('') || '<span class="mono">Brak wyników.</span>'}` : tab==='invites' ? adminInvitesTab(A) : tab==='mail' ? adminMailTab(A) : tab==='curation' ? `
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

