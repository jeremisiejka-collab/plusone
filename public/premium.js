/* +1 — funkcje premium, tylko w aplikacji (/app, private/app.html).
   Zainteresowania, obserwowanie (wydarzenie / miasto / okolica), powiadomienia, „Idziesz z kimś?” (znajomi),
   plan na wieczór (jedzenie i bar w okolicy + dojazd) i podsumowanie wyjść. API: worker/premium.js.
   Korzysta ze wspólnych nazw aplikacji (S, ACC, EVENTS, MINE, sheet, toast, apiCall, ic, esc, render, go…) w chwili wywołania. */

const PREM = { follows:null, notif:null, unread:0, crew:{}, plan:{}, wrapped:null };

/* ---------- start: po zalogowaniu ---------- */
async function premiumAfterLogin(){
  // obsługa biletów ma w aplikacji tylko swój pulpit — bez funkcji dla widzów
  if(!ACC.user || (typeof appStaffMode==='function' && appStaffMode())) return;
  loadFollows(); loadNotif();
  const q = new URLSearchParams(location.search);
  pushState().then(st=>{ PREM.push = st; });
  if(q.get('join')) joinSheet(q.get('join'));
  else if(q.get('ev')){ history.replaceState(null,'','/app'); const id=q.get('ev'); setTimeout(()=>openEvent(id), 300); }
  else if(q.has('notif')){ history.replaceState(null,'','/app'); setTimeout(premiumNotif, 300); }
  else if(!ACC.user.interests?.length && !sessionStorage.getItem('intAsked')){ sessionStorage.setItem('intAsked','1'); setTimeout(()=>interestsSheet(true), 900); }
  else setTimeout(pushPrompt, 1500);
}

/* ---------- powiadomienia push (Android od razu; iPhone — gdy +1 jest dodane do ekranu początkowego) ---------- */
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || !!navigator.standalone;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function pushState(){
  if(!pushSupported()) return isIOS() && !isStandalone() ? 'install' : 'unsupported';
  if(Notification.permission==='denied') return 'denied';
  try{ const reg = await navigator.serviceWorker.getRegistration('/app'); const sub = reg && await reg.pushManager.getSubscription(); return sub ? 'on' : 'off'; }
  catch(e){ return 'off'; }
}
const b64ToBytes = s => { const p='='.repeat((4-s.length%4)%4), b=atob((s+p).replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(b, c=>c.charCodeAt(0)); };
async function enablePush(){
  if(!pushSupported()){ toast(isIOS() ? 'Najpierw dodaj +1 do ekranu początkowego (Udostępnij → Do ekranu początkowego)' : 'Ta przeglądarka nie obsługuje powiadomień', true, 3500); return; }
  try{
    const perm = await Notification.requestPermission();
    if(perm!=='granted'){ toast('Bez zgody nie wyślemy powiadomień. Zmienisz to w ustawieniach telefonu.', true, 3500); PREM.push = await pushState(); return; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await apiCall('/api/push/key');
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64ToBytes(publicKey)});
    await apiCall('/api/push/subscribe','POST', sub.toJSON());
    PREM.push = 'on'; sfxOk(); haptic(20);
    const r = await apiCall('/api/push/test','POST',{});
    toast(r.sent ? 'Gotowe — wysłaliśmy próbne powiadomienie' : 'Powiadomienia włączone', true, 3000);
  }catch(e){ toast('Nie udało się włączyć powiadomień: '+esc(e.message||''), true, 3500); }
  closeSheet(); S.dir=null; render();
}
async function disablePush(){
  try{ const reg = await navigator.serviceWorker.getRegistration('/app'); const sub = reg && await reg.pushManager.getSubscription();
    if(sub){ await apiCall('/api/push/unsubscribe','POST',{endpoint:sub.endpoint}); await sub.unsubscribe(); } }catch(e){}
  PREM.push = 'off'; toast('Powiadomienia na telefon wyłączone', true); notifSettings();
}
/* jednorazowa propozycja włączenia (tylko gdy da się je włączyć i jeszcze nie pytaliśmy) */
async function pushPrompt(){
  try{ if(localStorage.getItem('pushAsked')) return; }catch(e){}
  const st = PREM.push || await pushState();
  if(st!=='off' || Notification.permission!=='default' || $('#sheetwrap.on')) return;
  try{ localStorage.setItem('pushAsked','1'); }catch(e){}
  sheet(`<div class="col" style="gap:14px;align-items:center;text-align:center">
    <span style="width:68px;height:68px;border-radius:22px;background:var(--pink-dim);color:${PINK};display:grid;place-items:center">${ic('bell',30)}</span>
    <span class="h3">Nie przegap niczego</span>
    <span class="body">Damy znać, gdy pojawi się coś z Twoich zainteresowań, gdy bilety na obserwowane wydarzenie stanieją i dzień przed wyjściem.</span>
    <button class="btn p" data-act="pushOn" style="height:54px">Włącz powiadomienia</button>
    <button class="btn g" data-act="closeSheet" style="height:46px;font:500 14px/1 var(--d)">Nie teraz</button></div>`);
}
const pushRow = () => {
  const st = PREM.push;
  if(st==='install') return `<div class="card" style="padding:14px"><span class="h4">Powiadomienia na telefon</span>
    <p class="body" style="font-size:13px;margin-top:6px">Na iPhonie działają, gdy +1 jest na ekranie początkowym: w Safari stuknij Udostępnij → Do ekranu początkowego i otwórz +1 z ikony.</p></div>`;
  if(st==='denied') return `<div class="card" style="padding:14px"><span class="h4">Powiadomienia zablokowane</span>
    <p class="body" style="font-size:13px;margin-top:6px">Włączysz je w Ustawieniach telefonu → Powiadomienia → +1.</p></div>`;
  if(st==='unsupported') return '';
  return `<button class="perm ${st==='on'?'on':''}" data-act="${st==='on'?'pushOff':'pushOn'}"><span class="perm-box">${st==='on'?ic('check',14,2.4):''}</span>
    <span class="col" style="flex:1;text-align:left"><span class="h4">Powiadomienia na telefon</span><span class="mono" style="margin-top:3px">Nowości, tańsze bilety, przypomnienia, znajomi</span></span></button>`;
};
async function loadFollows(){ try{ PREM.follows = (await apiCall('/api/follows')).follows; }catch(e){ PREM.follows = PREM.follows||[]; } }
async function loadNotif(){
  try{ const r = await apiCall('/api/notifications'); PREM.notif = r.notifications; PREM.unread = r.unread; }catch(e){}
  const dot = document.getElementById('notifdot'); if(dot) dot.style.display = PREM.unread ? '' : 'none';
}
const following = (kind, value) => !!PREM.follows?.some(f=>f.kind===kind && f.value===value);

/* ---------- zainteresowania ---------- */
function interestsSheet(first=false){
  sheet(`<div class="col" style="gap:12px"><span class="h3">${first?'Co lubisz?':'Zainteresowania'}</span>
    <span class="body" style="font-size:13px">Alerty o nowych wydarzeniach dostaniesz tylko z tych tematów — w obserwowanych miastach i okolicach (albo w Twoim mieście).</span>
    <div id="int-pick">${interestChips(ACC.user?.interests||[])}</div>
    <button class="btn p" data-act="saveInterests" style="height:52px">Zapisz</button></div>`);
}
async function saveInterests(){
  try{ ACC.user = (await apiCall('/api/me','PATCH',{interests:readInterests($('#int-pick'))})).user; closeSheet(); sfxOk(); toast('Zapisane — alerty dopasujemy do Ciebie', true); S.dir=null; render(); }
  catch(e){ toast(esc(e.message),true); }
}

/* ---------- obserwowanie ---------- */
async function follow(kind, value, on, radius){
  if(!ACC.user){ toast('Zaloguj się, żeby obserwować', true); return; }
  try{ PREM.follows = (await apiCall('/api/follows','POST',{kind, value, on, radius})).follows; haptic(on?16:6); on?sfxOk():sfxTap();
    toast(on ? (kind==='event'?'Obserwujesz — damy znać o tańszych biletach i przypomnimy dzień wcześniej':kind==='city'?'Obserwujesz '+esc(value):'Obserwujesz okolicę: '+esc(value)+' + '+radius+' km') : 'Nie obserwujesz', true, 2600);
    S.dir=null; render(); }
  catch(e){ toast(esc(e.message),true); }
}
function followsSheet(){
  const f = PREM.follows||[], label = x => x.kind==='event' ? (EVENTS.find(e=>e.id===x.value)?.name || 'Wydarzenie (minęło)') : x.kind==='city' ? x.value : x.value+' + '+x.radius+' km';
  const groups = [['event','Wydarzenia'],['city','Miasta'],['area','Okolice']];
  sheet(`<div class="col" style="gap:8px"><span class="h3">Obserwowane</span>
    ${groups.map(([k,l])=>{ const g=f.filter(x=>x.kind===k); return g.length?`<span class="eyebrow" style="padding-top:10px">${l}</span>${g.map(x=>`<div class="row" style="gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1;font:500 15px/1.3 var(--d)" ${k==='event'?`data-act="ev:${esc(x.value)}"`:''}>${esc(label(x))}</span>
      <button class="chip" data-act="unfollow:${k}:${esc(x.value)}" style="padding:6px 10px;font-size:12px">Usuń</button></div>`).join('')}`:''; }).join('')}
    ${f.length?'':'<span class="body">Nic jeszcze nie obserwujesz. Stuknij „Obserwuj” przy wydarzeniu albo przy mieście na mapie Miasta.</span>'}
    <button class="btn g" data-act="followCities" style="height:48px;margin-top:8px;font:500 14px/1 var(--d)">Obserwuj miasto lub okolicę →</button></div>`);
}
/* wybór miast do obserwowania: samo miasto albo okolica + 30 km */
function followCitySheet(){
  const top = typeof CITY_TOP!=='undefined' ? CITY_TOP : [];
  const cities = [...new Set([S.city, ...top, ...Object.keys(LIVE.cities||{}).sort((a,b)=>a.localeCompare(b,'pl'))])];
  sheet(`<div class="col" style="gap:6px"><span class="h3">Obserwuj miasto</span>
    <span class="body" style="font-size:13px">„Miasto” — alerty z tego miasta. „+30 km” — także z okolicznych miejscowości.</span>
    <div>${cities.map(c=>`<div class="row" style="gap:8px;padding:10px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1;font:500 15px/1.2 var(--d)">${esc(c)}</span>
      <button class="chip ${following('city',c)?'on':''}" data-act="fcCity:${esc(c)}" style="padding:6px 10px;font-size:12px">Miasto</button>
      <button class="chip ${following('area',c)?'on':''}" data-act="fcArea:${esc(c)}" style="padding:6px 10px;font-size:12px">+30 km</button></div>`).join('')}</div></div>`);
}

/* ---------- powiadomienia ---------- */
async function premiumNotif(){
  await loadNotif();
  const n = PREM.notif||[], icon = {new:'star', price:'wallet', reminder:'clock', crew:'users', info:'bell'};
  sheet(`<div class="col" style="gap:10px"><div class="row" style="justify-content:space-between"><span class="h3">Powiadomienia</span>
    <button class="mono" data-act="notifSettings" style="color:${PINK}">USTAWIENIA</button></div>
    ${n.map(x=>`<div class="card" ${x.event_id?`data-act="ev:${esc(x.event_id)}"`:''} style="padding:13px 14px;display:flex;gap:12px;align-items:center;${x.read_at?'opacity:.7':'border-color:var(--pink-line)'}">
      <span style="width:36px;height:36px;border-radius:11px;background:var(--surface-3);display:grid;place-items:center;color:${PINK};flex:none">${ic(icon[x.kind]||'bell',17)}</span>
      <div class="col" style="flex:1;min-width:0"><span style="font:600 14px/1.3 var(--d)">${esc(x.title)}</span>
        <span class="mono" style="margin-top:3px">${esc(x.body)}${x.body?' · ':''}${new Date(x.created_at).toLocaleDateString('pl-PL',{day:'numeric',month:'short'})}</span></div></div>`).join('')
      || `<span class="body">Tu pojawią się alerty: nowe wydarzenia z Twoich zainteresowań, tańsze bilety na obserwowane wydarzenia i przypomnienia dzień przed.</span>`}
    <button class="btn g" data-act="closeSheet" style="height:46px;font:500 14px/1 var(--d)">Zamknij</button></div>`);
  if(PREM.unread){ apiCall('/api/notifications/read','POST',{}).then(()=>{ PREM.unread=0; const d=document.getElementById('notifdot'); if(d) d.style.display='none'; }).catch(()=>{}); }
}
function notifSettings(){
  const u = ACC.user||{};
  const tg = (act, on, title, sub) => `<button class="perm ${on?'on':''}" data-act="${act}"><span class="perm-box">${on?ic('check',14,2.4):''}</span>
    <span class="col" style="flex:1;text-align:left"><span class="h4">${title}</span><span class="mono" style="margin-top:3px">${sub}</span></span></button>`;
  sheet(`<div class="col" style="gap:10px"><span class="h3">Powiadomienia</span>
    ${pushRow()}
    ${tg('prefToggle:notifyEmail', u.notifyEmail, 'Alerty także mailem', 'Najwyżej jeden mail dziennie, tylko gdy jest coś nowego')}
    ${tg('prefToggle:newsletter', u.newsletter, 'Newsletter „Na topie”', 'W czwartki: najfajniejsze wydarzenia w Twoim mieście')}
    <button class="btn g" data-act="interests" style="height:48px;font:500 14px/1 var(--d)">Zainteresowania →</button>
    <button class="btn g" data-act="followsSheet" style="height:48px;font:500 14px/1 var(--d)">Obserwowane →</button></div>`);
}

/* ---------- „Idziesz z kimś?” ---------- */
async function loadCrew(id){
  try{ PREM.crew[id] = await apiCall('/api/crew?event='+encodeURIComponent(id)); }catch(e){ PREM.crew[id] = {friends:[], going:0}; }
  const box = document.getElementById('crewbox'); if(box && S.eventId===id) box.outerHTML = crewBox(EVENTS.find(e=>e.id===id));
  if(S.screen==='event') bind(document);
}
const crewBox = e => {
  const c = PREM.crew[e.id], fr = c?.friends||[];
  return `<div id="crewbox" class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
    <div class="row" style="justify-content:space-between;gap:10px"><span class="h4">Idziesz z kimś?</span>
      ${c?.going?`<span class="mono">${pl(c.going)} ${c.going===1?'osoba idzie':'osób idzie'}</span>`:''}</div>
    ${fr.length ? `<div class="row" style="gap:10px;align-items:center"><div class="row">${fr.slice(0,5).map((f,i)=>`<span class="crewav" style="margin-left:${i?-10:0}px;background:hsl(${(f.id*67)%360} 60% 45%)">${esc(f.name[0].toUpperCase())}</span>`).join('')}</div>
      <span class="body" style="font-size:13px">${esc(fr.slice(0,2).map(f=>f.name).join(', '))}${fr.length>2?' i '+(fr.length-2)+' więcej':''} ${fr.length===1?'idzie':'idą'}</span></div>`
      : `<span class="body" style="font-size:13px">Wyślij znajomemu link — jednym stuknięciem dołączy, a zobaczycie się nawzajem w aplikacji.</span>`}
    <button class="btn p" data-act="crewInvite:${esc(e.id)}" style="height:50px;font:600 15px/1 var(--d);display:flex;align-items:center;justify-content:center;gap:8px">${ic('users',18)} Zaproś znajomego (+1)</button></div>`;
};
async function crewInvite(id){
  if(!ACC.user){ toast('Zaloguj się, żeby zaprosić znajomych', true); return; }
  const e = EVENTS.find(x=>x.id===id);
  try{
    const { link } = await apiCall('/api/crew/invite','POST',{eventId:id});
    const text = `Idziesz ze mną? ${e?e.name+' · '+e.when+' · '+e.venue:''}`;
    if(navigator.share) await navigator.share({title:'+1', text, url:link}).catch(()=>{});
    else { try{ await navigator.clipboard.writeText(text+' '+link); }catch(x){} toast('Link skopiowany — wyślij go znajomemu', true); }
  }catch(err){ toast(esc(err.message),true); }
}
async function joinSheet(token){
  let info; try{ info = await apiCall('/api/crew/join?token='+encodeURIComponent(token)); }catch(e){ toast(esc(e.message),true); return; }
  const e = EVENTS.find(x=>x.id===info.eventId);
  sheet(`<div class="col" style="gap:14px;text-align:center;align-items:center"><span style="width:64px;height:64px;border-radius:20px;background:var(--pink-dim);color:${PINK};display:grid;place-items:center">${ic('users',28)}</span>
    <span class="h3">${esc(info.from)} zaprasza Cię</span><span class="body">${e?esc(e.name)+'<br>'+esc(e.when+' · '+e.venue):'na wydarzenie'}</span>
    <button class="btn p" data-act="crewJoin:${esc(token)}" style="height:54px">Idę! (+1)</button>
    <button class="btn g" data-act="closeSheet" style="height:46px;font:500 14px/1 var(--d)">Może później</button></div>`);
}
async function crewJoin(token){
  try{
    const r = await apiCall('/api/crew/join','POST',{token});
    MINE.going = new Set(r.going||[]); MINE.saved = new Set(r.saved||[]);
    closeSheet(); sfxOk(); haptic(30); history.replaceState(null,'','/app');
    toast('Idziecie razem! Bilet z kodem QR masz w wydarzeniu', true, 2600);
    if(typeof confetti==='function') confetti(50);
    openEvent(r.eventId);
  }catch(e){ toast(esc(e.message),true); }
}
async function friendsSheet(){
  let fr = []; try{ fr = (await apiCall('/api/friends')).friends; }catch(e){}
  sheet(`<div class="col" style="gap:10px"><span class="h3">Znajomi</span>
    ${fr.map(f=>`<div class="row" style="gap:12px;padding:10px 0;border-bottom:1px solid var(--line)"><span class="crewav" style="background:hsl(${(f.id*67)%360} 60% 45%)">${esc(f.name[0].toUpperCase())}</span>
      <span style="flex:1;font:500 15px/1.2 var(--d)">${esc(f.name)}</span><span class="mono">od ${new Date(f.since).toLocaleDateString('pl-PL')}</span></div>`).join('')
      || '<span class="body">Znajomi pojawią się tu, gdy ktoś dołączy do Ciebie przez link „Zaproś znajomego” przy wydarzeniu.</span>'}</div>`);
}

/* ---------- dodatki na stronie wydarzenia ---------- */
function premiumEvent(e){
  if(!e?.real) return '';
  if(ACC.user && !PREM.crew[e.id]) setTimeout(()=>loadCrew(e.id), 0);
  const on = following('event', e.id);
  return `<div class="row" style="gap:8px">
      <button class="btn ${on?'w':'g'}" data-act="followEv:${esc(e.id)}" style="flex:1;height:48px;font:600 14px/1 var(--d);display:flex;align-items:center;justify-content:center;gap:8px">${ic('bell',17)} ${on?'Obserwujesz':'Obserwuj'}</button>
      <button class="btn g" data-act="plan:${esc(e.id)}" style="flex:1;height:48px;font:600 14px/1 var(--d);display:flex;align-items:center;justify-content:center;gap:8px">${ic('pin',17)} Plan na wieczór</button></div>
    ${e.priceDrop?`<div class="card" style="padding:12px 14px;border-color:var(--pink-line)"><span class="h4" style="color:${PINK}">Taniej!</span> <span class="mono">było od ${pl(e.priceDrop.was)} zł, teraz od ${pl(e.from)} zł</span></div>`:''}
    ${ACC.user ? crewBox(e) : ''}`;
}
/* dodatki w okienku miasta (mapa Miasta) */
const premiumCity = c => !ACC.user ? '' : `<div class="row" style="gap:8px">
  <button class="btn ${following('city',c)?'w':'g'}" data-act="followCity:${esc(c)}" style="flex:1;height:46px;font:600 13px/1 var(--d)">${following('city',c)?'Obserwujesz miasto':'Obserwuj miasto'}</button>
  <button class="btn ${following('area',c)?'w':'g'}" data-act="followArea:${esc(c)}" style="flex:1;height:46px;font:600 13px/1 var(--d)">${following('area',c)?'Obserwujesz okolicę':'Okolica + 30 km'}</button></div>`;

/* ---------- plan na wieczór: jedzenie przed, bar po, dojazd ---------- */
const PLAN_AMEN = {restaurant:'Restauracja', fast_food:'Szybkie jedzenie', cafe:'Kawiarnia', bar:'Bar', pub:'Pub', biergarten:'Ogródek piwny', nightclub:'Klub'};
async function planLoad(id){
  const e = EVENTS.find(x=>x.id===id); if(!e) return;
  const P = PREM.plan[id] = PREM.plan[id] || {state:'loading'};
  try{
    const q = encodeURIComponent([e.venue, e.address || '', e.city].filter(Boolean).join(', '));
    let g = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=pl&q=${q}`)).json();
    if(!g.length) g = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=pl&q=${encodeURIComponent(e.venue+', '+e.city)}`)).json();
    if(!g.length){ const c = (LIVE.geo||{})[e.city]; if(c && c[3]!=null) g = [{lat:c[3], lon:c[4], approx:true}]; }
    if(!g.length) throw new Error('Nie znaleźliśmy miejsca na mapie.');
    P.lat = +g[0].lat; P.lon = +g[0].lon; P.approx = !!g[0].approx;
    const ql = `[out:json][timeout:20];node(around:900,${P.lat},${P.lon})[amenity~"^(restaurant|fast_food|cafe|bar|pub|biergarten|nightclub)$"][name];out 80;`;
    const r = await (await fetch('https://overpass-api.de/api/interpreter', {method:'POST', body:'data='+encodeURIComponent(ql), headers:{'Content-Type':'application/x-www-form-urlencoded'}})).json();
    const dist = (a,b,c,d) => { const R=Math.PI/180, x=(d-b)*R*Math.cos((a+c)/2*R), y=(c-a)*R; return Math.round(Math.sqrt(x*x+y*y)*6371000); };
    P.places = (r.elements||[]).map(n=>({name:n.tags.name, type:n.tags.amenity, lat:n.lat, lon:n.lon, m:dist(P.lat,P.lon,n.lat,n.lon), cuisine:n.tags.cuisine}))
      .sort((a,b)=>a.m-b.m);
    P.state = 'ok';
  }catch(err){ P.state = 'error'; P.error = /fetch|network|load/i.test(err.message||'') ? 'Nie udało się pobrać miejsc w okolicy. Sprawdź połączenie i spróbuj ponownie.' : (err.message||'Brak połączenia.'); }
  if(S.screen==='plan' && S.planId===id){ S.dir=null; render(); }
}
const gmaps = (lat, lon, mode='walking') => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=${mode}`;
const scPlan = () => {
  const e = EVENTS.find(x=>x.id===S.planId); if(!e) return `<div class="pg pad" style="padding-top:120px"><span class="h3">Brak wydarzenia</span></div>`;
  const P = PREM.plan[e.id];
  if(!P) setTimeout(()=>planLoad(e.id), 0);
  const t = e.time || '20:00', [hh,mm] = t.split(':').map(Number), at = d => { const m=(hh*60+mm+d+1440)%1440; return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'); };
  const eat = (P?.places||[]).filter(p=>['restaurant','fast_food','cafe'].includes(p.type)).slice(0,5);
  const drink = (P?.places||[]).filter(p=>['bar','pub','biergarten','nightclub'].includes(p.type)).slice(0,5);
  const place = p => `<a class="planrow" href="${gmaps(p.lat,p.lon)}" target="_blank" rel="noopener">
    <span class="plandot">${ic(['bar','pub','biergarten','nightclub'].includes(p.type)?'beer':'coffee',16)}</span>
    <span class="col" style="flex:1;min-width:0"><b>${esc(p.name)}</b><span class="mono">${esc(PLAN_AMEN[p.type]||'')}${p.cuisine?' · '+esc(p.cuisine.split(';')[0]):''}</span></span>
    <span class="mono" style="text-align:right">${p.m<1000?p.m+' m':(p.m/1000).toFixed(1)+' km'}<br>${Math.max(1,Math.round(p.m/80))} min</span></a>`;
  const loading = !P || P.state==='loading';
  return `
<div class="pg" style="padding:64px 0 112px">
  <div class="pad row" style="gap:12px;padding-bottom:14px">
    <button class="back" data-act="back" aria-label="Wróć">${ic('chevL',18)}</button>
    <div class="col" style="gap:3px;flex:1;min-width:0"><div class="h2">Plan na wieczór</div><span class="mono" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.name)}</span></div>
  </div>
  <div class="pad col" style="gap:14px">
    <div class="plantl">
      <div><span class="mono">${at(-120)}</span><b>Jedzenie w okolicy</b></div>
      <div class="on"><span class="mono">${esc(t)}</span><b>${esc(e.name)}</b><span class="mono">${esc(e.venue)}</span></div>
      <div><span class="mono">później</span><b>Bar na koniec</b></div>
    </div>
    ${P?.lat?`<div class="row" style="gap:8px">
      <a class="btn w" href="${gmaps(P.lat,P.lon,'transit')}" target="_blank" rel="noopener" style="flex:1;height:48px;font:600 14px/1 var(--d);display:flex;align-items:center;justify-content:center;text-decoration:none">Komunikacją</a>
      <a class="btn g" href="${gmaps(P.lat,P.lon,'walking')}" target="_blank" rel="noopener" style="flex:1;height:48px;font:600 14px/1 var(--d);display:flex;align-items:center;justify-content:center;text-decoration:none">Pieszo</a>
      <a class="btn g" href="https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${P.lat}&dropoff[longitude]=${P.lon}&dropoff[nickname]=${encodeURIComponent(e.venue)}" target="_blank" rel="noopener" style="flex:1;height:48px;font:600 14px/1 var(--d);display:flex;align-items:center;justify-content:center;text-decoration:none">Taxi</a></div>`:''}
    ${loading ? loadingBox() : P.state==='error' ? `<div class="err">${esc(P.error)}</div>` : `
      ${P.approx?'<span class="mono">Nie znaleźliśmy dokładnego adresu — pokazujemy okolice centrum miasta.</span>':''}
      <span class="eyebrow">Przed: zjedz coś</span><div>${eat.map(place).join('')||'<span class="mono">Nic w pobliżu.</span>'}</div>
      <span class="eyebrow" style="padding-top:6px">Po: bar w okolicy</span><div>${drink.map(place).join('')||'<span class="mono">Nic w pobliżu.</span>'}</div>
      <span class="mono" style="line-height:1.5">Miejsca z OpenStreetMap. Godziny otwarcia sprawdź przed wyjściem.</span>`}
  </div>
</div>`;
};

/* ---------- podsumowanie wyjść ---------- */
async function wrappedLoad(){ try{ PREM.wrapped = await apiCall('/api/wrapped'); }catch(e){ PREM.wrapped = {error:e.message}; } if(S.screen==='mywrapped'){ S.dir=null; render(); } }
const CAT_NAME = {Clubs:'Kluby', Concerts:'Koncerty', Festivals:'Festiwale', Theatre:'Teatr', Comedy:'Stand-up', Culture:'Kultura', Sport:'Sport', Family:'Dla dzieci'};
const scMyWrapped = () => {
  const W = PREM.wrapped;
  if(!W) setTimeout(wrappedLoad, 0);
  const g = (W?.going||[]).filter(x=>x.t), top = (arr) => { const n={}; arr.filter(Boolean).forEach(x=>n[x]=(n[x]||0)+1); return Object.entries(n).sort((a,b)=>b[1]-a[1]); };
  const cats = top(g.map(x=>x.c)), venues = top(g.map(x=>x.v)), cities = top(g.map(x=>x.city)), artists = top(g.flatMap(x=>x.a||[]));
  const past = g.filter(x=>x.d && x.d.slice(0,10) < localDay()).length;
  const card = (k, big, sub, hue) => `<div class="wcard" style="--h:${hue}"><span class="mono">${k}</span><b>${big}</b>${sub?`<span>${sub}</span>`:''}</div>`;
  return `
<div class="pg" style="padding:64px 0 112px">
  <div class="pad row" style="gap:12px;padding-bottom:14px">
    <button class="back" data-act="back" aria-label="Wróć">${ic('chevL',18)}</button>
    <div class="col" style="gap:3px"><div class="h2">Twoje wyjścia</div><span class="mono">${new Date().getFullYear()} w +1</span></div>
  </div>
  <div class="pad">
  ${!W ? loadingBox() : W.error ? `<div class="err">${esc(W.error)}</div>` : !g.length ? `<div class="col mine-empty" style="align-items:center;text-align:center;gap:12px;padding:40px 10px">
      <span style="width:72px;height:72px;border-radius:24px;background:var(--pink-dim);display:grid;place-items:center;color:${PINK}">${ic('star',30)}</span>
      <span class="h3">Tu będzie Twoje podsumowanie</span><span class="body">Stukaj „Mam bilet” przy wydarzeniach — zbierzemy, gdzie byłeś, z kim i czego słuchasz.</span></div>` : `
    <div class="wgrid">
      ${card('Wydarzenia', pl(g.length), past?`${past} już za Tobą`:'', 330)}
      ${card('Najczęściej', esc(CAT_NAME[cats[0]?.[0]]||cats[0]?.[0]||'—'), cats.slice(1,3).map(c=>CAT_NAME[c[0]]||c[0]).join(' · '), 280)}
      ${card('Twoje miejsce', esc(venues[0]?.[0]||'—'), venues[0]?venues[0][1]+'× w tym roku':'', 200)}
      ${card('Miasta', pl(cities.length), cities.slice(0,3).map(c=>c[0]).join(' · '), 150)}
      ${artists.length?card('Ulubiony artysta', esc(artists[0][0]), artists.slice(1,3).map(a=>a[0]).join(' · '), 20):''}
      ${card('Ze znajomymi', pl(W.friends||0), W.friends?'znajomych w +1':'zaproś kogoś do wydarzenia', 45)}
      ${W.scanned?card('Wejścia z QR', pl(W.scanned), 'zeskanowane bilety +1', 100):''}
    </div>
    <button class="btn p" data-act="shareWrapped" style="height:52px;margin-top:16px">Udostępnij</button>`}
  </div>
</div>`;
};
async function shareWrapped(){
  const g = (PREM.wrapped?.going||[]).filter(x=>x.t);
  const text = `Mój rok w +1: ${g.length} wydarzeń. Gdzie dziś idziemy? plusoneapp.pl`;
  if(navigator.share) navigator.share({title:'+1', text}).catch(()=>{}); else { try{ navigator.clipboard.writeText(text); }catch(e){} toast('Skopiowane', true); }
}

/* ---------- wiersze w Koncie ---------- */
function premiumRows(u, row){
  if(!u) return '';
  return row('users','Znajdź swoje +1','go:people','')
    + row('bell','Powiadomienia','sheetNotif', PREM.unread?`<span class="mono" style="color:${PINK}">${PREM.unread} NOWE</span>`:'')
    + row('heart','Zainteresowania','interests', `<span class="mono">${(u.interests||[]).length||'wybierz'}</span>`)
    + row('pin','Obserwowane','followsSheet', `<span class="mono">${(PREM.follows||[]).length||''}</span>`)
    + row('users','Znajomi','friendsSheet','')
    + row('star','Twoje wyjścia','go:mywrapped','');
}

/* ---------- akcje ---------- */
function premiumAct(cmd, p1, p2, a){
  if(cmd.startsWith('social')) return socialAct(cmd, p1, p2);
  switch(cmd){
    case 'interests': interestsSheet(); return true;
    case 'saveInterests': saveInterests(); return true;
    case 'followEv': follow('event', a.slice(9), !following('event', a.slice(9))); return true;
    case 'followCity': follow('city', a.slice(11), !following('city', a.slice(11))); closeSheet(); return true;
    case 'followArea': follow('area', a.slice(11), !following('area', a.slice(11)), 30); closeSheet(); return true;
    case 'unfollow': follow(p1, a.slice(10+p1.length), false).then(()=>followsSheet()); return true;
    case 'followsSheet': followsSheet(); return true;
    case 'followCities': followCitySheet(); return true;
    case 'fcCity': follow('city', a.slice(7), !following('city', a.slice(7))).then(followCitySheet); return true;
    case 'fcArea': follow('area', a.slice(7), !following('area', a.slice(7)), 30).then(followCitySheet); return true;
    case 'notifSettings': pushState().then(st=>{ PREM.push=st; notifSettings(); }); return true;
    case 'pushOn': enablePush(); return true;
    case 'pushOff': disablePush(); return true;
    case 'prefToggle': apiCall('/api/me','PATCH',{[p1]:!ACC.user[p1]}).then(r=>{ ACC.user=r.user; notifSettings(); }).catch(e=>toast(esc(e.message),true)); return true;
    case 'crewInvite': crewInvite(a.slice(11)); return true;
    case 'crewJoin': crewJoin(a.slice(9)); return true;
    case 'friendsSheet': friendsSheet(); return true;
    case 'plan': S.planId = a.slice(5); go('plan'); return true;
    case 'shareWrapped': shareWrapped(); return true;
  }
  return false;
}

/* kliknięcie powiadomienia, gdy aplikacja jest już otwarta (public/app-sw.js → postMessage) */
if('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e=>{
  if(e.data?.type!=='open') return;
  const u = new URL(e.data.url, location.origin), ev = u.searchParams.get('ev');
  if(ev) openEvent(ev); else premiumNotif();
});

/* ---------- Znajdź swoje +1 — autorskie spotkania, wzajemna zgoda ---------- */
const SOCIAL = { owner:null, data:null, loading:false, error:'', eventId:null, people:null, tab:'events', busy:false, chat:null };
const socialDate = t => new Date(t).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});
const socialError = '<p id="social-error" class="err" role="alert" hidden></p>';
function socialReset(){ Object.assign(SOCIAL,{owner:ACC.user?.id||null,data:null,loading:false,error:'',eventId:null,people:null,tab:'events',busy:false,chat:null}); }
function socialRender(){
  if(S.screen!=='people') return;
  const top=$('#view').scrollTop,focus=document.activeElement?.closest('.social-page [data-act]')?.getAttribute('data-act');
  S.dir=null;render();$('#view').scrollTop=top;
  if(focus) document.querySelector('.social-page [data-act="'+CSS.escape(focus)+'"]')?.focus({preventScroll:true});
}
async function socialLoad(){
  if(SOCIAL.owner!==(ACC.user?.id||null)) socialReset();
  if(!ACC.user || SOCIAL.loading) return;
  const owner=SOCIAL.owner;let changed=!!SOCIAL.error;SOCIAL.loading=true; SOCIAL.error='';
  try{
    const [me,ev,mt]=await Promise.all([apiCall('/api/social/me'),apiCall('/api/social/events'),apiCall('/api/social/matches')]);
    if(owner!==ACC.user?.id) return;
    const data={...me,...ev,...mt};changed=changed||JSON.stringify(data)!==JSON.stringify(SOCIAL.data);SOCIAL.data=data;
  }catch(e){ if(owner===ACC.user?.id){SOCIAL.error=e.message;changed=true;} }
  finally{ if(owner===ACC.user?.id){ SOCIAL.loading=false;if(changed) socialRender(); } }
}
async function socialRun(fn){
  if(SOCIAL.busy) return;
  SOCIAL.busy=true;
  const buttons=[...document.querySelectorAll('button[data-act^="social"]')]; buttons.forEach(b=>b.disabled=true);
  const err=$('#social-error'); if(err) err.hidden=true;
  try{ await fn(); }
  catch(e){ const box=$('#social-error'); if(box){box.textContent=e.message;box.hidden=false;} else toast(esc(e.message),true,3500); }
  finally{ SOCIAL.busy=false;buttons.forEach(b=>b.disabled=false); }
}
function socialHome(){
  return `<section class="social-invite card" aria-label="Znajdź swoje plus jeden">
    <div class="social-symbol" aria-hidden="true"><span>+</span><span>1</span></div>
    <span class="eyebrow pink">Dobre wyjście zaczyna się od ludzi</span>
    <h2 class="h2">Znajdź swoje <span class="pink">+1</span></h2>
    <p class="body">Na koncert. Do tańca. Do rozmowy.<br>Poznaj kogoś na spotkaniach Plus Jeden.</p>
    <button class="btn g" data-act="go:people">Zobacz, jak się poznać ${ic('chevR',18)}</button>
  </section>`;
}
const socialSteps = () => `<div class="social-steps">
  <div><span>01</span><strong>Ten sam plan</strong><p>Wybierz autorskie spotkanie Plus Jeden.</p></div>
  <div><span>02</span><strong>Mały plusik</strong><p>Na miejscu daj znać, kogo chcesz poznać.</p></div>
  <div><span>03</span><strong>Pierwsze cześć</strong><p>Wzajemne +1 otwierają rozmowę. Reszta na żywo.</p></div>
</div>`;
function scSocial(){
  if(SOCIAL.owner!==(ACC.user?.id||null)) socialReset();
  if(!SOCIAL.data && !SOCIAL.loading && !SOCIAL.error && ACC.user) setTimeout(socialLoad,0);
  const d=SOCIAL.data,p=d?.profile,ev=d?.events||[],matches=d?.matches||[];
  const selected=ev.find(e=>e.id===SOCIAL.eventId);
  return `<div class="pg social-page" style="padding:64px 0 112px">
    <div class="pad col social-heading"><span class="eyebrow pink">Na żywo jest bliżej</span>
      <h1 class="h1">Znajdź swoje <span class="pink">+1</span></h1>
      <p class="body">Kogoś do wspólnego wyjścia, tańca albo rozmowy. Jeden mały plus może być początkiem znajomości.</p>
    </div>
    <div class="pad col social-content">
      ${!ACC.user?`${socialSteps()}<button class="btn p" data-act="authgo:login">Zaloguj się i poznaj swoje +1</button>`:
      SOCIAL.error?`<p class="err" role="alert">${esc(SOCIAL.error)}</p><button class="btn g" data-act="socialRefresh">Spróbuj ponownie</button>`:
      !d?loadingBox():`
        <div class="social-profile card"><span class="social-avatar">${p?esc(p.name[0].toUpperCase()):ic('user',24)}</span>
          <div><strong>${p?esc(p.name)+', '+p.age:'Daj się poznać'}</strong><span class="mono">${p?.suspended?'Profil zawieszony':p?.verified?'Wiek potwierdzony przez obsługę':p?'Wiek do potwierdzenia na miejscu':'Krótki profil, łatwiejsze pierwsze cześć'}</span></div>
          <button class="chip" data-act="socialProfile">${p?'Edytuj':'Uzupełnij'}</button></div>
        <div class="social-tabs" role="group" aria-label="Poznawanie ludzi">
          <button class="chip ${SOCIAL.tab==='events'?'on':''}" aria-pressed="${SOCIAL.tab==='events'}" data-act="socialTab:events">Spotkania</button>
          <button class="chip ${SOCIAL.tab==='matches'?'on':''}" aria-pressed="${SOCIAL.tab==='matches'}" data-act="socialTab:matches">Twoje +1${matches.length?' · '+matches.length:''}</button>
          <button class="social-refresh" data-act="socialRefresh" aria-label="Odśwież spotkania i plusiki">${ic('undo',18)}</button>
        </div>
        ${SOCIAL.tab==='matches'?`
          <p class="body">Rozmowa zaczyna się wtedy, gdy oboje dacie sobie plusik.</p>
          ${matches.map(m=>`<article class="social-match card"><span class="social-avatar">${esc(m.name[0].toUpperCase())}</span><div><h2 class="h4">${esc(m.name)}, ${m.age}</h2><span class="mono">${esc(m.eventTitle)}</span></div>
            <button class="chip on" data-act="socialChat:${m.id}:${esc(m.eventId)}">Porozmawiaj</button></article>`).join('')||`<div class="social-empty card">${ic('users',28)}<h2 class="h3">Pierwsze +1 przed Tobą</h2><p class="body">Wybierz spotkanie i daj się poznać. Tutaj pojawią się Wasze wzajemne plusiki.</p></div>`}`:
        selected?socialEventView(selected,p):`
          <div class="col" style="gap:6px"><h2 class="h3">Spotkajmy się na Plus Jeden</h2><p class="body">Nasze autorskie wydarzenia z przestrzenią na nowe znajomości. Możesz przyjść solo.</p></div>
          ${ev.map(e=>`<article class="social-event card"><div class="row" style="justify-content:space-between;gap:8px"><span class="eyebrow pink">PLUS JEDEN · 18+</span><span class="mono">${e.live?'TRWA TERAZ':e.joined?'TWÓJ PLAN':''}</span></div>
            <h3 class="h3">${esc(e.title)}</h3><p class="body">${esc(e.venue)} · ${esc(e.city)}</p><time class="mono">${socialDate(e.startsAt)}</time>
            <button class="btn ${e.joined?'p':'g'}" data-act="socialPeople:${esc(e.id)}">${e.joined?'Moje +1 na tym spotkaniu':'Poznajmy się tutaj'} ${ic('chevR',18)}</button></article>`).join('')||`
            <div class="social-empty card"><span class="social-empty-plus" aria-hidden="true">+1</span><h3 class="h3">Pierwsze spotkania przed nami</h3><p class="body">Tutaj pojawią się autorskie wydarzenia Plus Jeden. Już teraz możesz przygotować swój profil.</p><button class="chip" data-act="socialProfile">${p?'Zobacz swój profil':'Przygotuj profil +1'}</button></div>`}
          ${socialSteps()}`}
        <p class="social-footnote">Ty decydujesz, kiedy jesteś widoczny. Poznawanie uczestników działa na miejscu, po potwierdzeniu wieku 18+ przez obsługę. Pełnej daty urodzenia nie pokazujemy innym uczestnikom.</p>
        ${isAdmin()?'<button class="btn g" data-act="socialManage">Zarządzaj spotkaniami Plus Jeden</button>':''}
      `}
    </div>
  </div>`;
}
function socialEventView(e,p){
  const list=SOCIAL.people;
  return `<button class="social-back" data-act="socialBack">${ic('chevL',16)} Wszystkie spotkania</button>
    <div class="social-event card"><span class="eyebrow pink">PLUS JEDEN · 18+</span><h2 class="h3">${esc(e.title)}</h2>
      <p class="body">${esc(e.venue)} · ${esc(e.city)}</p><span class="mono">${socialDate(e.startsAt)}</span>
      <div class="social-meeting">${ic('pin',18)}<div><strong>Tu mówimy pierwsze cześć</strong><p>${esc(e.meetingPoint)}</p></div></div>
      ${!e.joined?`<p class="body">Chcesz poznać kogoś na tym spotkaniu? Włącz swój profil dla jego uczestników. To nie jest bilet wstępu.</p><button class="btn p" data-act="socialJoin">${p?'Chcę kogoś poznać':'Najpierw uzupełnij profil'}</button>`:
        `<div class="social-visibility">${ic('check',18)}<span>${e.checkedIn&&e.live&&p?.verified&&!p?.suspended?'Jesteś widoczny na tym spotkaniu':'Chcesz poznać ludzi na tym spotkaniu'}</span></div>
        ${!e.checkedIn||!p?.verified?`<p class="body">Przy wejściu pokaż kod profilu i dokument ze zdjęciem. Obsługa sprawdzi imię, wiek i obecność. Nie zapisujemy zdjęcia ani numeru dokumentu.</p><button class="btn p" data-act="socialCode">Pokaż kod obsłudze</button>`:''}
        ${!e.live?'<p class="mono">Osoby pojawią się po rozpoczęciu spotkania.</p>':''}
        <button class="social-back" data-act="socialLeaveAsk">Wyłącz poznawanie na tym spotkaniu</button>`}
    </div>
    ${e.joined&&e.checkedIn&&p?.verified&&e.live&&!p?.suspended?`
      <div class="row" style="justify-content:space-between;gap:8px"><h2 class="h3">Kogo dziś poznasz?</h2><button class="chip" data-act="socialPeople:${esc(e.id)}">Odśwież</button></div>
      <p class="body">Plusik znaczy „chętnie Cię poznam”. Bez presji — rozmowa otworzy się dopiero, gdy druga osoba też da Ci +1.</p>
      ${list===null?loadingBox():list.error?`<p class="err" role="alert">${esc(list.error)}</p>`:list.map(person=>socialPerson(person,e)).join('')||'<div class="social-empty card"><h3 class="h3">Dajmy sobie chwilę</h3><p class="body">Pozostali uczestnicy jeszcze nie włączyli poznawania. Wróć tu za chwilę albo podejdź do punktu spotkań +1.</p></div>'}`:''}`;
}
function socialPerson(p,e){
  return `<article class="social-person card"><div class="row" style="gap:12px"><span class="social-avatar">${esc(p.name[0].toUpperCase())}</span><div><h3 class="h3">${esc(p.name)}, ${p.age}</h3><span class="social-verified">${ic('shield',13)} Wiek potwierdzony</span></div></div>
    ${p.bio?`<p class="body">${esc(p.bio)}</p>`:''}<div class="social-opener"><span class="eyebrow">Zacznijmy od…</span><p>${esc(p.opener)}</p></div>
    ${p.received&&!p.sent?'<span class="social-received">Masz od tej osoby +1</span>':''}
    <button class="btn ${p.sent&&!p.matched?'g':'p'}" data-act="${p.matched?'socialChat:'+p.id+':'+e.id:'socialPlus:'+p.id}">${p.matched?'Macie swoje +1 · porozmawiajcie':p.sent?'Plusik wysłany · cofnij':p.received?'Odwzajemnij +1':'Daj +1'}</button>
    <button class="social-back" data-act="socialSafety:${p.id}:${esc(e.id)}">Zablokuj lub zgłoś</button></article>`;
}
async function socialPeople(id){
  const entering=SOCIAL.eventId!==id;
  SOCIAL.eventId=id; SOCIAL.tab='events';if(entering){SOCIAL.people=null;socialRender();}
  const e=SOCIAL.data?.events.find(e=>e.id===id), owner=ACC.user?.id;
  if(!e?.joined||!e.checkedIn||!e.live||!SOCIAL.data?.profile?.verified) return;
  let changed=false;
  try{ const r=await apiCall('/api/social/people?event='+encodeURIComponent(id)); if(SOCIAL.eventId===id&&ACC.user?.id===owner){changed=JSON.stringify(SOCIAL.people)!==JSON.stringify(r.people);SOCIAL.people=r.people;} }
  catch(err){ if(SOCIAL.eventId===id&&ACC.user?.id===owner){ SOCIAL.people={error:err.message};changed=true;} }
  if(ACC.user?.id===owner&&changed) socialRender();
}
function socialField(id,label,value='',attrs=''){
  return `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(value)}" ${attrs}></div>`;
}
function socialProfile(){
  const p=SOCIAL.data?.profile;
  sheet(`<div class="col social-form"><span class="eyebrow pink">Twoje pierwsze cześć</span><h2 class="h3">Daj się poznać</h2>
    <p class="body">Wystarczy imię i coś, od czego łatwo zacząć rozmowę.</p>
    ${socialField('so-name','IMIĘ Z DOKUMENTU',p?.name||'',`autocomplete="given-name" maxlength="40" ${p?.verified?'readonly':''}`)}
    ${socialField('so-birth','DATA URODZENIA',p?.birthDate||'',`type="date" autocomplete="bday" ${p?.verified?'readonly':''}`)}
    <p class="social-footnote">${p?.verified?'Imię i wiek zostały potwierdzone.':'Wiek potwierdzi obsługa na miejscu, na podstawie dokumentu ze zdjęciem.'} Inni zobaczą tylko wiek, bez daty urodzenia. Spotkania są dla osób 18+.</p>
    ${socialField('so-bio','KILKA SŁÓW O TOBIE',p?.bio||'','maxlength="160" placeholder="Zawsze pod sceną. Chętnie poznam ekipę na koncerty."')}
    ${socialField('so-opener','ZACZNIJMY OD…',p?.opener||'','maxlength="100" placeholder="Jaki koncert najchętniej przeżyjesz jeszcze raz?"')}
    ${socialError}<button class="btn p" data-act="socialSave">Zapisz profil</button>
    ${p?'<button class="social-back" data-act="socialDeleteAsk">Usuń profil poznawania</button>':''}
    <button class="social-back" data-act="closeSheet">Zamknij</button></div>`);
}
async function socialChat(id,eventId){
  const match=SOCIAL.data?.matches.find(m=>m.id===id&&m.eventId===eventId);
  if(!match) throw new Error('Odśwież swoje +1, aby otworzyć rozmowę.');
  const r=await apiCall('/api/social/messages?event='+encodeURIComponent(eventId)+'&user='+id);
  SOCIAL.chat={id,eventId};
  sheet(`<div class="col social-form"><span class="eyebrow pink">Macie swoje +1</span><h2 class="h3">Cześć, ${esc(match.name)}</h2>
    <div class="social-meeting">${ic('pin',18)}<div><strong>Może pierwsze cześć tutaj?</strong><p>${esc(match.meetingPoint)}</p></div></div>
    <p class="body">${esc(match.opener)}</p><div id="social-messages" class="social-messages" aria-live="polite">${socialMessages(r.messages)}</div>
    ${socialField('so-message','WIADOMOŚĆ','','maxlength="500" placeholder="Cześć! Spotkamy się przy punkcie +1?" autocomplete="off"')}
    ${socialError}<div class="row" style="gap:8px"><button class="btn p" data-act="socialSend">Wyślij</button><button class="btn g" data-act="socialChatRefresh">Odśwież</button></div>
    <button class="social-back" data-act="socialSafety:${id}:${esc(eventId)}">Zablokuj lub zgłoś</button><button class="social-back" data-act="closeSheet">Zamknij</button></div>`);
  const box=$('#social-messages'); box.scrollTop=box.scrollHeight;
}
const socialMessages = messages => messages.map(m=>`<div class="social-message ${m.mine?'mine':''}"><p>${esc(m.text)}</p><time>${new Date(m.at).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'})}</time></div>`).join('')||'<p class="social-footnote">Pierwsza wiadomość przed Wami. Możecie też od razu przywitać się na żywo.</p>';
async function socialChatRefresh(send=false){
  const c=SOCIAL.chat; if(!c) return;
  const text=$('#so-message')?.value||'';
  const r=send?await apiCall('/api/social/messages','POST',{eventId:c.eventId,userId:c.id,text}):await apiCall('/api/social/messages?event='+encodeURIComponent(c.eventId)+'&user='+c.id);
  if(SOCIAL.chat!==c||!$('#social-messages')) return;
  const box=$('#social-messages'),html=socialMessages(r.messages),atEnd=box.scrollHeight-box.scrollTop-box.clientHeight<30;
  if(box.innerHTML!==html){const top=box.scrollTop;box.innerHTML=html;box.scrollTop=send||atEnd?box.scrollHeight:top;}
  if(send) $('#so-message').value='';
}
function socialSafety(id,eventId){
  SOCIAL.safety={id,eventId};
  sheet(`<div class="col social-form"><h2 class="h3">Ty decydujesz o kontakcie</h2><p class="body">Po blokadzie nie zobaczycie swoich profili i nie będziecie mogli do siebie pisać. Ta osoba nie dostanie powiadomienia o blokadzie.</p>
    <button class="btn g" data-act="socialBlock">Zablokuj osobę</button>
    ${socialField('so-reason','POWÓD ZGŁOSZENIA','','maxlength="500" placeholder="Opisz, co się wydarzyło"')}
    <p class="social-footnote">Zgłoszenie trafi do administratorów Plus Jeden i również zablokuje kontakt. Jeśli potrzebujesz pomocy na miejscu, podejdź do obsługi.</p>
    ${socialError}<button class="btn p" data-act="socialReport">Zgłoś i zablokuj</button><button class="social-back" data-act="closeSheet">Anuluj</button></div>`);
}
async function socialVerifySheet(){
  const {events}=await apiCall('/api/social/events'),live=events.filter(e=>e.live);
  SOCIAL.verify=null;
  sheet(`<div class="col social-form"><h2 class="h3">Potwierdź profil +1</h2><p class="body">Sprawdź osobę na miejscu i jej dokument ze zdjęciem. Potwierdzenie profilu nie zastępuje sprawdzenia biletu.</p>
    ${live.length?`<div class="field"><label for="so-verify-event">TRWAJĄCE SPOTKANIE</label><select id="so-verify-event">${live.map(e=>`<option value="${esc(e.id)}">${esc(e.title+' · '+e.city)}</option>`).join('')}</select></div>
    ${socialField('so-code','KOD Z TELEFONU UCZESTNIKA','','maxlength="12" autocomplete="off" autocapitalize="characters"')}
    ${socialError}<button class="btn p" data-act="socialLookup">Sprawdź kod</button>`:'<p class="body">Nie ma teraz trwającego spotkania Plus Jeden. Administrator dodaje spotkania w aplikacji.</p>'}
    <button class="social-back" data-act="closeSheet">Zamknij</button></div>`);
}
async function socialManage(){
  const [{events},{reports}]=await Promise.all([apiCall('/api/social/events'),apiCall('/api/social/admin/reports')]);
  sheet(`<div class="col social-form"><span class="eyebrow pink">Panel Plus Jeden</span><h2 class="h3">Spotkania i zgłoszenia</h2>
    <button class="btn p" data-act="socialCreateSheet">Dodaj autorskie spotkanie</button>
    ${events.map(e=>`<div class="social-admin-row"><strong>${esc(e.title)}</strong><span class="mono">${socialDate(e.startsAt)} · ${esc(e.city)}</span><button class="chip" data-act="socialCancelAsk:${esc(e.id)}">Wyłącz spotkanie</button></div>`).join('')}
    <h3 class="h4">Zgłoszenia (${reports.length})</h3>${reports.map(r=>`<div class="social-admin-row"><strong>${esc(r.name||'Usunięty profil')} · ${esc(r.title)}</strong><p class="body">${esc(r.reason)}</p>
      <button class="chip" data-act="socialResolve:${r.id}">Zamknij zgłoszenie</button><button class="chip" data-act="socialSuspend:${r.id}">Zawieś profil</button></div>`).join('')||'<p class="body">Brak otwartych zgłoszeń.</p>'}
    ${socialError}<button class="social-back" data-act="closeSheet">Zamknij</button></div>`);
}
function socialAct(cmd,p1,p2){
  if(cmd==='socialProfile'){socialProfile();return true;}
  if(cmd==='socialTab'){SOCIAL.tab=p1;SOCIAL.eventId=null;socialRender();return true;}
  if(cmd==='socialBack'){SOCIAL.eventId=null;socialRender();return true;}
  if(cmd==='socialSafety'){socialSafety(+p1,p2);return true;}
  if(cmd==='socialDeleteAsk'||cmd==='socialLeaveAsk'||cmd==='socialCancelAsk'){
    const del=cmd==='socialDeleteAsk',cancel=cmd==='socialCancelAsk';
    sheet(`<div class="col social-form"><h2 class="h3">${del?'Usunąć profil poznawania?':cancel?'Wyłączyć to spotkanie?':'Wyłączyć poznawanie?'}</h2><p class="body">${del?'Znikną profil, potwierdzenie wieku, plusiki i rozmowy. Twoje konto i bilety zostają.':cancel?'Uczestnicy stracą dostęp do poznawania osób i rozmów na tym spotkaniu.':'Znikniesz z listy uczestników, a plusiki i połączenia z tego spotkania zostaną usunięte.'}</p>${socialError}
      <button class="btn p" data-act="${del?'socialDelete':cancel?'socialCancel:'+p1:'socialLeave'}">${del?'Usuń profil':cancel?'Wyłącz spotkanie':'Wyłącz poznawanie'}</button><button class="btn g" data-act="closeSheet">Anuluj</button></div>`);return true;
  }
  if(cmd==='socialCreateSheet'){
    sheet(`<div class="col social-form"><h2 class="h3">Autorskie spotkanie Plus Jeden</h2><p class="body">Publikuj wyłącznie wydarzenia organizowane przez Plus Jeden. Wskaż widoczny punkt, w którym uczestnicy mogą się przywitać.</p>
      ${socialField('so-title','NAZWA SPOTKANIA','','maxlength="100"')}${socialField('so-city','MIASTO',S.city,'maxlength="60"')}${socialField('so-venue','MIEJSCE','','maxlength="100"')}
      ${socialField('so-point','PUNKT SPOTKAŃ +1','','maxlength="160" placeholder="Np. stolik z oznaczeniem +1 obok wejścia"')}
      ${socialField('so-start','POCZĄTEK','','type="datetime-local"')}${socialField('so-end','KONIEC','','type="datetime-local"')}
      <p class="social-footnote">Godziny w strefie tego urządzenia: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Spotkanie może trwać do 48 godzin.</p>${socialError}
      <button class="btn p" data-act="socialCreate">Opublikuj spotkanie</button><button class="social-back" data-act="socialManage">Wróć</button></div>`);return true;
  }
  socialRun(async()=>{
    switch(cmd){
      case 'socialRefresh': await socialLoad();if(SOCIAL.eventId) await socialPeople(SOCIAL.eventId);break;
      case 'socialPeople': await socialPeople(p1);break;
      case 'socialSave': {
        await apiCall('/api/social/me','PUT',{name:$('#so-name').value,birthDate:$('#so-birth').value,bio:$('#so-bio').value,opener:$('#so-opener').value});
        closeSheet();await socialLoad();toast('Profil gotowy. Wybierz spotkanie i poznaj swoje +1.',true);break;
      }
      case 'socialDelete': await apiCall('/api/social/me','DELETE',{});closeSheet();socialReset();await socialLoad();break;
      case 'socialJoin': if(!SOCIAL.data?.profile){socialProfile();break;} await apiCall('/api/social/join','POST',{eventId:SOCIAL.eventId,on:true});await socialLoad();break;
      case 'socialLeave': await apiCall('/api/social/join','POST',{eventId:SOCIAL.eventId,on:false});closeSheet();SOCIAL.people=null;await socialLoad();break;
      case 'socialCode': {
        const r=await apiCall('/api/social/code','POST',{});
        sheet(`<div class="col social-form"><span class="eyebrow pink">Tylko dla obsługi na miejscu</span><h2 class="h3">To Twoje +1</h2><p class="body">Pokaż ten kod i dokument ze zdjęciem osobie z obsługi. Nie wysyłaj kodu innym uczestnikom.</p><div class="social-code">${esc(r.code.slice(0,5)+' '+r.code.slice(5))}</div><p class="mono">Ważny do ${new Date(r.expiresAt).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'})}. To nie jest bilet wstępu.</p><button class="btn p" data-act="socialCodeDone">Gotowe · odśwież profil</button><button class="social-back" data-act="closeSheet">Zamknij</button></div>`);break;
      }
      case 'socialCodeDone':closeSheet();await socialLoad();if(SOCIAL.eventId)await socialPeople(SOCIAL.eventId);break;
      case 'socialPlus': {
        const person=Array.isArray(SOCIAL.people)&&SOCIAL.people.find(p=>p.id===+p1);if(!person)break;
        const r=await apiCall('/api/social/plus','POST',{eventId:SOCIAL.eventId,userId:+p1,on:!person.sent});
        await socialLoad();await socialPeople(SOCIAL.eventId);haptic(20);toast(r.matched?'Macie swoje +1. Możecie się przywitać!':person.sent?'Plusik cofnięty':'Plusik wysłany. Teraz ruch drugiej osoby.',true,3000);break;
      }
      case 'socialChat':await socialChat(+p1,p2);break;
      case 'socialSend':await socialChatRefresh(true);break;
      case 'socialChatRefresh':await socialChatRefresh();break;
      case 'socialBlock':case 'socialReport': {
        const reason=cmd==='socialReport'?$('#so-reason').value.trim():'';if(cmd==='socialReport'&&!reason)throw new Error('Opisz powód zgłoszenia.');
        await apiCall('/api/social/block','POST',{userId:SOCIAL.safety.id,eventId:SOCIAL.safety.eventId,reason});closeSheet();await socialLoad();if(SOCIAL.eventId)await socialPeople(SOCIAL.eventId);toast(reason?'Zgłoszenie przyjęte. Kontakt zablokowany.':'Kontakt zablokowany.',true);break;
      }
      case 'socialVerify':await socialVerifySheet();break;
      case 'socialLookup': {
        const code=$('#so-code').value,eventId=$('#so-verify-event').value,r=await apiCall('/api/social/verify','POST',{code,eventId});SOCIAL.verify={code,eventId,...r};
        sheet(`<div class="col social-form"><h2 class="h3">Sprawdź dokument i osobę</h2><p class="h3">${esc(r.name)} · ${r.age} lat</p><p class="body">Data urodzenia: ${esc(r.birthDate)}</p><p class="body">Porównaj imię i datę z dokumentem ze zdjęciem oraz upewnij się, że dokument należy do osoby przed Tobą. Nie fotografuj dokumentu.</p>${socialError}<button class="btn p" data-act="socialConfirm">Dane i osoba zgodne · potwierdź</button><button class="btn g" data-act="socialVerify">Dane niezgodne · wróć</button></div>`);break;
      }
      case 'socialConfirm':await apiCall('/api/social/verify','PUT',{...SOCIAL.verify,confirmed:true});SOCIAL.verify=null;closeSheet();toast('Wiek i obecność potwierdzone.',true);break;
      case 'socialManage':await socialManage();break;
      case 'socialCreate':await apiCall('/api/social/admin/events','POST',{title:$('#so-title').value,city:$('#so-city').value,venue:$('#so-venue').value,meetingPoint:$('#so-point').value,startsAt:+new Date($('#so-start').value),endsAt:+new Date($('#so-end').value)});await socialLoad();await socialManage();break;
      case 'socialCancel':await apiCall('/api/social/admin/events','DELETE',{eventId:p1});await socialLoad();await socialManage();break;
      case 'socialResolve':case 'socialSuspend':await apiCall('/api/social/admin/reports','POST',{id:+p1,suspend:cmd==='socialSuspend'});await socialManage();break;
    }
  });
  return true;
}

// Krótka rozmowa odświeża się bez kasowania wpisywanej wiadomości.
setInterval(()=>{
  if(document.hidden || SOCIAL.busy || SOCIAL.loading || !ACC.user || SOCIAL.owner!==ACC.user.id) return;
  if($('#sheetwrap.on')){
    if($('#social-messages') && SOCIAL.chat) socialChatRefresh().catch(e=>{
      const box=$('#social-error');if(box){box.textContent=e.message;box.hidden=false;}
    });
    return;
  }
  if(S.screen==='people') socialLoad().then(()=>{if(SOCIAL.eventId) return socialPeople(SOCIAL.eventId);});
},15000);
