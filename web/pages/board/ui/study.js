/* The meeting desk, from an earlier desk prototype, on live board data.
 * Data comes from ui/live.js; writes go to the board's own routes. */
'use strict';
const $ = (s) => document.querySelector(s);
const esc = LIVE.escText;
const PREFIX = 'bwat.study.v1.';
// The one bucket-name map, in the fixed column order (desk.js and zoomtabs.js reuse it).
const labels = {do:'To-dos',ask:'Questions',risk:'Risks',decided:'Decisions'};
// One card's type, as the opened card tags it.
const labelOne = {do:'To-do',ask:'Question',risk:'Risk',decided:'Decision'};
const icons = {
  arrow:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>'
};
let snapshot, cards = [], sources = {}, loadError = false, volatile = {}, storageOK = true, busy = new Set();
let params = new URLSearchParams(location.search);
let viewer = '', defaultSourceId = 'all', pollTimer = null;
// Who is editing which card now (edit, UX sync 9/29), from GET /editing.
let editingNow = {}, editBeat = null;
history.scrollRestoration = 'manual';

function read(key, fallback) {
  try { const raw=localStorage.getItem(PREFIX+key); return raw ? JSON.parse(raw) : fallback; }
  catch { storageOK=false; return volatile[key] ?? fallback; }
}
function write(key, value) {
  volatile[key]=value;
  try { localStorage.setItem(PREFIX+key,JSON.stringify(value)); return true; }
  catch { storageOK=false; showStorageWarning(); return false; }
}
function showStorageWarning() {
  const el=$('#storage-alert'); if(!el) return;
  el.hidden=false; el.textContent='Browser storage is unavailable. Drafts are only in this tab. Copy your instructions before leaving; routing is disabled until drafts can be saved.';
}
// crypto.randomUUID exists only in a secure context; the local board is plain
// http on a private network, where it is undefined and a send died silently before its
// request. getRandomValues is available everywhere: a v4 UUID from it.
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function key(id, person=viewer) { return `draft.${person}.${id}`; }
function draft(id, person=viewer) { return read(key(id,person),{brief:'',session:'',status:'draft'}); }
function save(id, next, person=viewer) { return write(key(id,person),next); }
function cardOwner(c) { return c.owner || ''; }
const errText = r => (r.body && r.body.error) || ('HTTP ' + r.status);
// A source's `at`: its local start, YYYYMMDDHHMMSS (bwat-api.js).
function parseAt(at) {
  const m=/^(\d{4})(\d{2})(\d{2})/.exec(String(at||''));
  return m?{y:m[1],mo:+m[2],d:+m[3]}:null;
}
// The desk's one extension point. Each ui/*.js file used to re-wrap the
// global render()/matching(), so behaviour hung on <script> order. Now they
// register here, and the order is explicit:
//   beforeRender -> the base render (study.js) -> afterRender
//   sort         -> applied inside matching()'s memo
//   card         -> buildCard's parts, before the card's HTML is written
//   afterPoll    -> every poll, after the data is in, whether or not it renders
// The one place the order lives: a hook runs in its kind's list order, and a
// name not listed here is refused -- no number in some other file to drift.
const HOOK_ORDER={
  beforeRender:['zoomscope','zoomtabs'],
  afterRender:['desk','meeting-bot','lifecycle','weeks','t3-32','zoomtabs','zoomscope','footer','dnd','attentive','plugins','filters'],
  sort:['desk','lifecycle','dnd','return'],
  card:['desk','lifecycle','attentive','plugins'],
  afterPoll:['footer'],
};
const HOOKS={beforeRender:[],afterRender:[],sort:[],card:[],afterPoll:[]};
function addHook(kind,name,fn) {
  const order=(HOOK_ORDER[kind]||[]).indexOf(name);
  if(order<0) throw new Error(`addHook: unknown ${kind} hook "${name}" -- list it in HOOK_ORDER`);
  HOOKS[kind].push({fn,name,order});
  HOOKS[kind].sort((a,b)=>a.order-b.order);
}
// Bumped when a card is edited IN PLACE (dnd.js sets c.slot for its
// optimistic reorder), so matching()'s memo -- whose sort reads the slot --
// is recomputed. A reassigned `cards` array is caught by identity.
let cardsRev=0;
function cardsChanged() { cardsRev++; }
// Card by id, rebuilt when the cards array changes.
let byIdFor=null, byIdN=-1, byIdMap=new Map();
function cardById(id) {
  if(byIdFor!==cards||byIdN!==cards.length){byIdMap=new Map(cards.map(c=>[c.id,c]));byIdFor=cards;byIdN=cards.length;}
  return byIdMap.get(id);
}
function ownerColor(name) { return (name && LIVE.api.colors && LIVE.api.colors[name]) || ''; }
function announce(text) { $('#announcement').textContent=text; }
// A line on what a change is about (DELIGHT.notes, by anchor), in place of a notice at the foot of
// the page: ok (✓ Saved, Kept) or who changed it first, on its card or its column's head
// ('col:'+bucket, dnd.js); an error, red, with Try again when there is a `retry`. It is render
// state: the refresh that follows the change draws it. It holds, then folds away; a screen reader
// hears it once, through announce() (an error, through DELIGHT.alert). An error stays until a
// retry fixes it, a new line takes its place, or the person moves to a view without it (navigate).
// A retry that only opens something (the send dialog) `stays`: the outcome it leads to clears it.
const NOTES=DELIGHT.notes,noteHTML=DELIGHT.line;
const lineEl=id=>byAttr(document,'data-line',id);
function noteCard(id,kind,text,{who='',say=text+'.',ms=DELIGHT.ms[kind==='ok'?'saved':'who'],retry=null,stays=false}={}){
  const n=DELIGHT.note(id,{kind,text,who,color:ownerColor(who),retry,stays});
  if(kind==='err')return;
  announce(say);
  n.t=setTimeout(async()=>{
    try{await DELIGHT.fold('line:'+id,lineEl(id));}
    catch{/* the change itself landed: a failed fold only skips the motion */}
    finally{if(NOTES.get(id)===n){NOTES.delete(id);redraw();}}
  },ms);
}
function clearNote(id){clearTimeout(NOTES.get(id)?.t);NOTES.delete(id);}
const clearError=id=>{if(NOTES.get(id)?.kind==='err')clearNote(id);};
// Drawn now, for a change no refresh follows; the person's focus stays (DELIGHT.refocus).
function redraw(){const k=DELIGHT.focusKey(document.activeElement);renderInPlace({keepReader:true});DELIGHT.refocus(k);}
// A retry that could not run yet (the same request still in flight) answers NOT_RUN: its line stays.
const NOT_RUN=Symbol('not run');
// Try again: fixed unless the retry put up a line of its own (it failed again, or was stale), or the line stays.
document.addEventListener('click',async e=>{const b=e.target.closest&&e.target.closest('[data-note-retry]');if(!b)return;
  e.preventDefault();e.stopPropagation();const id=b.dataset.noteRetry,n=NOTES.get(id);if(!n||!n.retry||n.busy)return;
  n.busy=true;b.setAttribute('aria-disabled','true');let ran;
  try{ran=await n.retry();}finally{n.busy=false;}
  if(ran===NOT_RUN||NOTES.get(id)!==n)return;if(!n.stays)clearNote(id);redraw();});
// Moving on lets an error go: one whose line, or closed card's row, the new view does not draw.
function letErrorsGo(){
  const drawn=new Set([...document.querySelectorAll('[data-line]')].map(x=>x.dataset.line));
  for(const [id,n] of NOTES)if(n.kind==='err'&&!drawn.has(id))NOTES.delete(id);
  const gone=[...ROWS.all].filter(([id,x])=>x.held.has('err')&&!drawn.has('slim:'+id)).map(([id])=>id);
  for(const id of gone){ROWS.remove(id);HELD.place.delete(id);HELD.gone[id]=Date.now();}
  if(gone.length)cards=applyHeld(cards);
}
// Someone else's change landed first (a stale reply): named on the card, or column, it reloads.
// The reply's who/by when it says; the reload washes the changed card (markArrivals).
function changedBy(id,body){const who=(body&&(body.who||body.by))||'';noteCard(id,'who',DELIGHT.changed(who,viewer),{who});}
// Today / This week (9/28 artifact review): `?when=` names a window, and it
// is turned into that window's meetings here, on every render, so a meeting
// that starts later joins. It applies only while no link chose meetings or a
// week. `at` is the meeting's local start, read in the viewer's calendar; a
// week is keyed by its Monday, as the feed's weeks are. No meeting in the
// window yet: 'none', which matches no card.
const localDay=window.bwatHelpers.localDate;
// Today's meetings, for the sidebar's Today list.
function todayIds() { return new Set(whenSource('today').split(',').filter(id=>id!=='none')); }
function whenSource(when,now=new Date()) {
  const monday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-(now.getDay()+6)%7);
  const today=localDay(now), week=localDay(monday), nextWeek=localDay(new Date(monday.getFullYear(),monday.getMonth(),monday.getDate()+7));
  const inWindow=(m)=>{const p=parseAt(m&&m.at);if(!p)return false;
    const day=p.y+'-'+String(p.mo).padStart(2,'0')+'-'+String(p.d).padStart(2,'0');
    return when==='today'?day===today:day>=week&&day<nextWeek;};
  const ids=Object.entries(sources).filter(([,m])=>inWindow(m)).sort(LIVE.byAtDesc).map(([id])=>id);
  return ids.length?ids.join(','):'none';
}
function state() {
  params=new URLSearchParams(location.search);
  const asked=params.get('when'), when=(asked==='today'||asked==='week')&&!params.get('source')&&!params.get('week')?asked:'';
  return {when,source:params.get('source')||(when?whenSource(when):'')||defaultSourceId,
    // An old ?view=lane link opens Mine (design sync 9/30: "My to-dos" is Mine on the desk).
    scope:params.get('scope')||(params.get('view')==='lane'?'mine':'team'),type:params.get('type')||'all',
    q:params.get('q')||'',card:params.get('card')||'',person:params.get('person')||'',
    // A plugin's narrowing (ui/plugins.js): only the cards it names (live.js api.narrow).
    narrow:params.get('narrow')||'',
    // A plugin's own page in place of the cards (ui/plugins.js).
    page:params.get('page')||'',
    // The sidebar's Today (9/30): its list is today's meetings only, and
    // stays so while one of them is open. weeks.js and zoomscope.js set it.
    days:params.get('days')==='today'?'today':''};
}
function url(changes) {
  const q=new URLSearchParams(location.search);
  // Choosing what the board shows leaves a plugin's page (ui/plugins.js), unless it names one.
  if(!('page' in changes)&&['source','week','when','days','narrow'].some(k=>k in changes)) q.delete('page');
  for(const [k,v] of Object.entries(changes)) v==null||v===''?q.delete(k):q.set(k,v);
  return location.pathname+'?'+q.toString();
}
function remember() {
  const focus=document.activeElement?.id || history.state?.focus || '';
  history.replaceState({...history.state,study:true,scroll:scrollY,focus},'',location.href);
}
function navigate(changes,{replace=false,focus='',scroll=0,keepReader=false}={}) {
  remember();
  const dest=url(changes);
  if(dest===location.pathname+location.search) return;
  const old=history.state;
  history[replace?'replaceState':'pushState']({study:true,scroll,focus,fromCard:changes.card?old?.focus:null},'',dest);
  render({keepReader}); letErrorsGo(); restore({scroll,focus});
}
function restore(s=history.state) {
  requestAnimationFrame(()=>{
    if(s?.focus) document.getElementById(s.focus)?.focus({preventScroll:true});
    scrollTo(0,s?.scroll||0);
  });
}
// The reader either REPLACES the list (Zoom, or any viewport up to
// 1100px, where desk.css already stacks it over the list) or sits BESIDE it
// (wide web). Replacing, the list's controls act on nothing visible, so they
// hide and one "Back to cards" bar is the way back; beside, they still act on
// the list, so they stay and the button is a plain Close.
const READER_STACKS=matchMedia('(max-width:1100px)');
function readerMode() { return LIVE.api.zoom||READER_STACKS.matches?'replace':'beside'; }
// Inside Zoom the reader's top is just ← Back and the card's ⋯: the panel is the meeting already.
function readerCloseHTML(c) {
  return LIVE.api.zoom?'<button id="close-reader">← Back</button>'
    :readerMode()==='replace'
    ?`<button id="close-reader">← Back to cards</button>${c?`<span class="reader-meeting">${esc(meetingName(c.from))}</span>`:''}`
    :'<button id="close-reader" aria-label="Close card">Close ✕</button>';
}
function closeReader() {
  const id=state().card;
  if(history.state?.fromCard) history.back();
  else navigate({card:null},{focus:'open-'+id});
}
function openCard(id) {
  navigate({card:id},{focus:'detail-title',scroll:matchMedia('(max-width:700px)').matches?0:scrollY});
}
function safeEvidence(html) {
  const doc=new DOMParser().parseFromString(html||'','text/html');
  function convert(n) {
    if(n.nodeType===3) return esc(n.textContent);
    if(n.nodeType!==1) return '';
    if(['SCRIPT','STYLE','IFRAME','OBJECT'].includes(n.tagName)) return '';
    const content=[...n.childNodes].map(convert).join('');
    const name=n.tagName.toLowerCase();
    return ['p','b','strong','em','i','br','ul','ol','li','blockquote','code'].includes(name)?`<${name}>${content}${name==='br'?'':`</${name}>`}`:content;
  }
  return [...doc.body.childNodes].map(convert).join('');
}
function meetingName(id) { return sources[id]?.label?.replace(/\s*\(zoom\)$/i,'')||'Meeting unavailable'; }
function meetingDate(id) { return sources[id]?.date||'Date unavailable'; }
// A meeting's start in `format` (by default its time and zone), or '' when it has none.
function displayTime(source,format={hour:'numeric',minute:'2-digit',timeZoneName:'short'}) {
  const d=new Date(source?.start||'');
  return Number.isFinite(d.getTime())?d.toLocaleString('en-US',format):'';
}
// Asked several times per render with the same inputs (columns, counts, chips,
// tabs): memoised on the cards array and every input the filter reads.
let matchRev=-1, matchFor=null, matchN=-1, matchMemo=new Map();
function matching(s,ignoreType=false) {
  if(matchRev!==cardsRev||matchFor!==cards||matchN!==cards.length){matchMemo=new Map();matchRev=cardsRev;matchFor=cards;matchN=cards.length;}
  const k=JSON.stringify([s.source,s.scope,s.type,s.person,s.q,s.narrow,narrowing(s),viewer,!!ignoreType]);
  if(!matchMemo.has(k)) {
    let list=filterCards(s,ignoreType);
    for(const h of HOOKS.sort) list=h.fn(list,s,ignoreType);
    matchMemo.set(k,list);
  }
  return matchMemo.get(k).slice();
}
// a superseded or merged card stays in the feed, so a link to it
// still opens, but no list, column, count or search shows it unless this
// viewer turned "Show superseded and merged cards" on in Settings
// (2026-09-29/30).
function showSuperseded() { return !!(window.BOARD_PREFS&&BOARD_PREFS.get('superseded')==='show'); }
// (D98, D99): an answered question is kept the same way -- in the
// feed, so a link still opens it -- and hidden unless "Show answered
// questions" is on. Answered by a later card (LIFE.answered) or through
// Answer (a clarify note). Inside Zoom it is always hidden: the full board has it.
function showAnswered() { return !LIVE.api.zoom&&!!(window.BOARD_PREFS&&BOARD_PREFS.get('answered')==='show'); }
function answeredQuestion(c) { return !!(c&&c.bucket==='ask'&&(clarifiedCard(c)||LIFE.answered(c))); }
function clarifiedCard(c) { return !!c.clarified; }
// A to-do paired with a meeting card hides with merged cards: the card stands for both.
function hiddenCard(c,show=showSuperseded(),showAns=showAnswered()) { return !!(c&&!c.row&&((c.superseded_by&&!show)||(!showAns&&answeredQuestion(c)))); }
// Every list and count reads this, so the rule lives in one place.
function visibleCards() { const show=showSuperseded(),showAns=showAnswered(); return cards.filter(c=>!hiddenCard(c,show,showAns)); }
// A merged survivor belongs to every meeting it came from: its own and each
// merged-in duplicate's, so a meeting's view still shows the card it said.
function cardMeetings(c) { const out=[c.from]; for(const id of c.merges||[]){ const m=cards.find(x=>x.id===id); if(m&&m.from&&!out.includes(m.from)) out.push(m.from); } return out; }
function inMeetings(c,ids) { return cardMeetings(c).some(f=>ids.includes(f)); }
// Open to-dos (?source=open): every meeting's open to-dos, as the card service lists them
// (live.js). Mine is the list it gave for owner=me, never a match on the viewer's name;
// Unassigned is the to-dos with no owner member and no name the room said.
function openView(s) { return s.source===LIVE.OPEN; }
// A ?narrow= link narrows only while its plugin is on this board: one the person hid shows every card.
function narrowing(s) { return !!s.narrow&&window.bwatBoard.features().some(f=>f.name===s.narrow.split(':')[0]); }
function inOpenScope(c,s) {
  return !!c.open&&(narrowing(s)||c.bucket==='do')&&(s.scope==='mine'?c.open==='mine':s.scope==='unassigned'?!c.ownerId&&!cardOwner(c):true);
}
function filterCards(s,ignoreType) {
  const picked=s.source.split(','),open=openView(s);
  return visibleCards().filter(c=>(open?inOpenScope(c,s):s.source==='all'||inMeetings(c,picked)) &&
    (open||s.scope==='team'||(s.scope==='mine'&&!!viewer&&c.bucket==='do'&&cardOwner(c)===viewer)||(s.scope==='unassigned'&&c.bucket==='do'&&!cardOwner(c))) &&
    (ignoreType||s.scope==='mine'||s.type==='all'||c.bucket===s.type) &&
    (!s.person||cardOwner(c)===s.person||(c.bucket!=='do'&&c.raisedBy===s.person)) &&
    (!narrowing(s)||!!LIVE.api.narrow&&LIVE.api.narrow.ids.has(c.id)) &&
    (!s.q||`${c.label||c.id} ${c.title} ${cardOwner(c)}`.toLowerCase().includes(s.q.toLowerCase())));
}
function render(options={}) {
  for(const h of HOOKS.beforeRender) h.fn(options);
  renderBase(options);
  for(const h of HOOKS.afterRender) h.fn(options);
}
// Tab, column and scope clicks never move the controls (UX sync 9/29:
// "if you click a button or a tab it should not change the vertical height").
// The click keeps the scroll position, and the list keeps at least the height
// it had, so a shorter list cannot pull the page up under the pointer. The
// hold ends when the view moves to other meetings or weeks.
let heldView=null;
function heldKey(){const q=new URLSearchParams(location.search);return [state().source,q.get('week')||'',q.get('when')||''].join('|');}
function holdListHeight(){const l=$('#card-list');if(!l)return;l.style.minHeight=l.offsetHeight+'px';heldView=heldKey();}
function releaseListHeight(){if(heldView===null||heldView===heldKey())return;heldView=null;const l=$('#card-list');if(l)l.style.minHeight='';}
function renderBase({keepReader=false}={}) {
  if(!snapshot||loadError) return;
  releaseListHeight();
  const s=state();
  const shown=visibleCards();
  const todayOnly=s.days==='today', listed=Object.entries(sources).filter(([id])=>!todayOnly||todayIds().has(id));
  const listedCards=todayOnly?shown.filter(c=>cardMeetings(c).some(f=>todayIds().has(f))).length:shown.length;
  $('.nav-meetings > .small').textContent=`${listed.length} ${listed.length===1?'meeting':'meetings'} · ${listedCards} ${listedCards===1?'card':'cards'}`;
  document.title=`BWAT · ${s.card?((cards.find(x=>x.id===s.card)||{}).label||s.card)+' · ':''}Meetings`;
  document.body.classList.toggle('detail-open',!!s.card);
  document.body.classList.toggle('reader-replaces',!!s.card&&readerMode()==='replace');
  $('#find-disclosure').open=innerWidth>700||!!s.q;
  // The heading names the view; the desk's meeting heading repaints it.
  $('#page-title').textContent='Meetings';
  const perMeeting={};for(const c of shown)for(const f of cardMeetings(c))perMeeting[f]=(perMeeting[f]||0)+1;
  // each day's date once, as a heading, with that day's meetings under
  // it. Grouped by the date itself, newest first: `at` and the calendar `date`
  // can disagree (UTC capture names), so sorting by `at` alone could split a
  // day. Each link names its day for screen readers (aria-describedby).
  const meetingLink=(id,name,small,n,day,current=s.source===id)=>`<a href="${esc(url({source:id,card:null,q:null}))}" data-meeting="${esc(id)}" aria-current="${current}"${day?` aria-describedby="${day}"`:''}><span>${esc(name)}${small?`<small>${esc(small)}</small>`:''}</span><b>${n}</b></a>`;
  const days=new Map();
  for(const [id,m] of listed.sort(LIVE.byAtDesc)){const k=m.date||'Date unavailable';if(!days.has(k))days.set(k,[]);days.get(k).push(id);}
  // Today: the top link is all of today's meetings (the ?when=today window).
  const allLink=todayOnly?meetingLink('all','All meetings','Today',listedCards,'',!params.get('source')&&params.get('when')==='today'):meetingLink('all','All meetings','Last 2 weeks',shown.length);
  $('#meeting-links').innerHTML=allLink
    +(todayOnly&&!listed.length?'<p class="muted small">No meetings yet today.</p>':'')
    +[...days].map(([date,ids],i)=>`<p class="meeting-day" id="meeting-day-${i}">${esc(date)}</p>`+ids.map(id=>meetingLink(id,meetingName(id),'',perMeeting[id]||0,'meeting-day-'+i)).join('')).join('');
  paintMeetingInfo(s);
  for(const scope of ['mine','team','unassigned']) $('#scope-'+scope).setAttribute('aria-pressed',s.scope===scope);
  if(document.activeElement!==$('#search')) $('#search').value=s.q;
  if(!keepReader) renderReader();
  $('#meeting-links').querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();navigate(todayOnly&&a.dataset.meeting==='all'?{source:null,when:'today',card:null,q:null}:{source:a.dataset.meeting,card:null,q:null},{focus:'page-title'});});
}
// A card is its parts. `card` hooks (desk 10, lifecycle 20) edit
// them; buildCard is the one place that turns parts into markup -- no more
// regex or string surgery on another file's HTML.
// (A141): Send to Claude is the card's own button
// in the list, opening its dialog without opening the card. One rule
// with the reader (actionState): show:false = no button; a reason = the
// button, aria-disabled, with the reason as its title.
function cardActions(c) { const a=actionState(c,cardOwner(c)); return {send:a.send}; }
function cardParts(c,s) {
  const d=draft(c.id), owner=cardOwner(c), oc=ownerColor(owner);
  // A send in flight or failed here says so; otherwise the card's last hand-off, as every
  // viewer sees it: Read once its session marked it read, else Queued.
  // Sent from this browser, it names the session, as the reader's receipt does (renderRoute); a plugin's
  // targets name none. A send of ours the record does not hold yet (or with no hand-off id) is Queued,
  // whatever an earlier send's entry says; a draft from before ids were kept takes the newest entry.
  const routed=c.routed||[],last=routed.slice(-1)[0],sent=last||d.status==='accepted',ours=d.status==='accepted';
  const newer=ours&&d.handoff!==undefined&&!routed.some(x=>x.handoff_id===d.handoff),read=!!(last&&last.read_at)&&!newer;
  const to=ours&&!pluginTargets()&&(newer||d.handoff===undefined||last.handoff_id===d.handoff)?d.target||sessionLabel(d.session):'';
  const unsure=d.status==='unknown'||d.status==='sending',failed=d.status==='failed',receipt=sent&&!unsure&&!failed;
  const badge=unsure?'Not confirmed':failed?'Not sent'
    :read?(to?['Read by '+to,readWhen(last.read_at)].filter(Boolean).join(' · '):'Read'):sent?(to?`Queued for ${to}`:'Queued'):d.brief?'Draft kept':'';
  const p={
    classes:[s.card===c.id&&'selected',oc&&'owned'].filter(Boolean),
    style:oc?`--owner:${oc}`:'',
    chips:badge?[`<span class="badge ${receipt?'queued':c.bucket}">${esc(badge)}</span>`]:[],
    source:`${esc(meetingDate(c.from))} · ${esc(meetingName(c.from))}`,
    badges:'',
    // The card's own line (noteCard), apart from pointers, which lifecycle.js's hook writes whole.
    note:noteHTML(c.id),
    pointers:'',
    // Your own card needs no name in its footer: the board is yours. Nobody's says it with Take it alone.
    foot:owner&&owner!==viewer?`<span class="avatar${oc?' colored':''}" aria-hidden="true">${esc(owner[0].toUpperCase())}</span>${esc(owner)}`:'',
    // An unowned to-do offers only Take it (assign.js); the opened card's Change owner assigns anyone.
    // Once Claude has read a to-do, the reader's Done is on the card too: for any signed-in viewer, as
    // the reader's is, and recorded as theirs.
    actions:!owner&&c.bucket==='do'&&!c.closed?{take:takeControlHTML(c)}:{...cardActions(c),done:read&&receipt&&!!viewer&&!c.closed&&c.bucket==='do'},
    answer:null,
  };
  for(const h of HOOKS.card) h.fn(p,c,s);
  // Make room: the footer opens on hover, focus or the open card, and stays open on a card
  // that needs the viewer -- their own unsent to-do, or what a hook marked (p.needs: desk.js's
  // unanswered question or unowned to-do). Not an auto-apply suggestion: nearly every to-do
  // carries one. Read after the hooks, which may take an action away.
  const send=p.actions&&p.actions.send;
  if(!c.closed&&(p.needs||(p.actions&&p.actions.done)||(send&&send.show&&!send.why&&d.status!=='accepted'&&d.status!=='sending')))p.classes.push('needs');
  return p;
}
// The desk's Answer (desk.js p.answer): a card button like the others, but it
// opens the card, where the answer is written, rather than a dialog.
function routeHTML(r,c) {
  return r?actionButton('route-'+c.id,r.label,{show:true},'card-action',false,` data-open="${esc(c.id)}"`):'';
}
// The reader's action row and the card's buttons: one builder. aria-disabled,
// not disabled, so the reason stays reachable by hover and focus. `label` is text
// (a plugin's sendLabel among them), escaped here.
function actionButton(id,label,st,cls='',pop=true,attrs='') {
  return st&&st.show?`<button type="button" id="${esc(id)}" class="action-button${cls?' '+cls:''}"${attrs}${pop?' aria-haspopup="dialog"':''}${st.why?` aria-disabled="true" title="${esc(st.why)}" aria-description="${esc(st.why)}"`:''}>${esc(label)}</button>`:'';
}
function cardActionsHTML(a,c,answer='') {
  if(!a) return answer?`<span class="card-actions">${answer}</span>`:'';
  if(a.take) return `<span class="card-actions">${a.take}</span>`;
  const html=answer+pluginActionsHTML(c)+actionButton('send-'+c.id,sendLabel(),a.send,'card-action',true,` data-send="${esc(c.id)}"`);
  return html?`<span class="card-actions">${html}</span>`:'';
}
// The card's Done, at the foot's left: a button like Send to Claude, on its right.
function cardDoneHTML(a,c){return a&&a.done?actionButton('done-'+c.id,'Done',{show:true},'card-action',false,` data-done="${esc(c.id)}" aria-label="Done: ${esc(c.title)}"`):'';}
function buildCard(p,c) {
  return `<article class="card${p.classes.length?' '+p.classes.join(' '):''}" data-card="${esc(c.id)}"${p.style?` style="${p.style}"`:''}><button class="card-open" id="open-${esc(c.id)}" data-open="${esc(c.id)}" aria-label="Open ${esc(c.label||c.id)}: ${esc(c.title)}"><div class="card-head">${p.chips.join('')}</div>${p.titleIcon?`<div class="card-title">${p.titleIcon}<h3>${esc(c.title)}</h3></div>`:`<h3>${esc(c.title)}</h3>`}<p class="card-source${p.source.replace(/<[^>]*>/g,'').trim()?'':' only-code'}">${p.source}${p.source.replace(/<[^>]*>/g,'').trim()?'<span class="card-sep"> · </span>':''}<span class="card-code">${esc(c.label||c.id)}</span></p>${p.badges}</button>${p.ownerMark||''}${p.more||''}${p.note||p.pointers?`<div class="card-rel">${p.note}${p.pointers}</div>`:''}<div class="card-foot">${cardDoneHTML(p.actions,c)}<span class="owner">${p.foot}</span>${cardActionsHTML(p.actions,c,routeHTML(p.answer,c))}</div></article>`;
}
function cardHTML(c,s) { return c.row?slimHTML(c):buildCard(cardParts(c,s),c); }
function renderReader() {
  const s=state(), c=cards.find(c=>c.id===s.card), el=$('#reader');
  // No card open, no placeholder (9/30: "get rid of that"); the pane stays empty.
  if(!s.card) {el.innerHTML='';return;}
  if(!c){el.innerHTML='<div class="empty"><h2 id="detail-title" tabindex="-1">Card not in this snapshot.</h2><p>The link may refer to another week. Your drafts have not been deleted.</p>'+readerCloseHTML(null)+'</div>';$('#close-reader').onclick=closeReader;return;}
  const d=draft(c.id), owner=cardOwner(c);
  const evidence=`<div class="evidence"><p class="eyebrow">FROM THE MEETING</p>${safeEvidence(c.detail)}<div class="receipt-ref">${esc(meetingName(c.from))} · ${esc(meetingDate(c.from))}<br>Receipt: ${esc(c.src||'No frame reference available')}</div></div>`;
  // A to-do's auto-apply shows here only, never on the desk's card face.
  const {autoApply:auto}=bwatMarks(c);
  // What is so of the card, and only that: a to-do's owner, how it closed, bwat's suggestion.
  const meta=[owner?`Owner: ${owner}`:c.bucket==='do'?'No owner named':'',c.noResponse?'No response':c.withdrawn?'Closed by bwat':c.done?'Completed in source':'',auto].filter(Boolean);
  el.innerHTML=`<div class="reader-top">${readerCloseHTML(c)}<span class="reader-top-end">${LIVE.api.zoom?'':`<span class="badge ${c.bucket}">${labelOne[c.bucket]}</span>`}${moreHTML(c)}</span></div><div class="reader-body"><h2 id="detail-title" tabindex="-1">${esc(c.title)}</h2><p class="small editing-note" id="editing-note"${editingText(c.id)?'':' hidden'}>${editingText(c.id)?'✎ '+esc(editingText(c.id))+' this card now.':''}</p><p class="detail-source">${esc(c.label||c.id)} · ${esc(meetingDate(c.from))} · ${esc(meetingName(c.from))}</p>${meta.length?`<div class="detail-meta">${meta.map(m=>`<span>${esc(m)}</span>`).join('<span>•</span>')}</div>`:''}${evidence}${relationships(c)}${actionsHTML(c,owner)}<div id="edit-area"></div><div id="route-area"></div></div>`;
  $('#close-reader').onclick=closeReader;
  wireActions(c,owner);
  renderRoute(c,d);
  if(pendingEdit===c.id){pendingEdit=null;openEditForm(c);}
}
// The reader's related records: lifecycle.js replaces this with the feed's real relations.
function relationships() { return ''; }
function plainText(html){ return new DOMParser().parseFromString(html||'','text/html').body.textContent||''; }
function sessionLabel(id){ const h=(LIVE.api.hub||[]).find(x=>x.session_id===id); return h?(h.label||id.slice(0,8)):(id?id.slice(0,8):'Choose a session'); }
// The page's plugin may supply its own send targets (bwat-api.js sendTargets): then the send
// action is its label, its rows fill the list, and the sessions' default and note are not offered.
function pluginTargets(){ return !!LIVE.api.sendLabel; }
function sendLabel(){ return LIVE.api.sendLabel||'Send to Claude'; }
// Every sentence the send action says, in the plugin's words (which name no session, router or
// Claude) or the sessions'. `empty` is HTML: the sessions' carries its install link.
const SEND_WORDS={
  plugin:{group:'Where to send it',empty:'Nothing here to send it to.',none:'None of these can take it right now.',dead:'Unavailable',
    gone:'What you picked is no longer available. Choose another.',choose:'Choose where this goes.',assign:'Assign it to yourself to send it'},
  sessions:{group:'Your sessions',empty:'No session yet · <a href="/admin/#/members?claude" target="_blank" rel="noopener" data-install>How to install</a>',none:'None of your sessions has a router running, so nothing would collect it.',dead:'Unavailable — no router running',
    gone:'The session you picked is no longer available. Choose another.',choose:'Choose one of your sessions.',assign:'Assign it to yourself to send it to Claude'},
};
function sendWords(plugin=pluginTargets()){ return plugin?SEND_WORDS.plugin:SEND_WORDS.sessions; }
// No session yet: How to install opens the admin panel's Connect Claude Code commands; Zoom's own
// browser may not follow a new-tab link, so the click opens it as other links out do.
document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[data-install]');if(!a)return;e.preventDefault();bwatHelpers.openInBrowser(a.href);});
// The session list for "Send to Claude" (2026-09-23: a button that
// opens an overlay of sessions, not a dropdown + button on the card). Pure:
// rows in, HTML out, so it is testable. The rules: a
// session without a router is listed but cannot be picked; the hub's reason
// shows even beside rows, since rows then mean a stale list.
// Heard from in the last two minutes is a green dot and no words; older, a grey dot and its age.
// When a hand-off was read, for its receipt: a clock time today, else the day, so it never goes stale
// on a board that does not redraw; '' when the record's time is unreadable.
function readWhen(at){const t=new Date(at);if(isNaN(t))return '';
  return t.toDateString()===new Date().toDateString()?t.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):t.toLocaleDateString([],{month:'short',day:'numeric'});}
function sessionAgo(s){return s==null||s<120?'':s<5400?`${Math.round(s/60)}m ago`:`${Math.round(s/3600)}h ago`;}
const PIN_SVG='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5h4l-.6 4.2 2.6 2.3H4l2.6-2.3z M8 8v6.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const NOTE_SVG='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
// One surface of rows, each the session's name alone (its machine only matters with two or
// more: then each machine heads its own rows, and the default, above them, names its machine;
// while filtering there are no headings, so every row names its machine).
// The live default comes first under "Default" (so it has focus and one Enter sends there).
// Beside each row, never inside its button: a note button that opens a note and Send under
// that row ({note}: the open one), and a pin that makes or clears the default, which never sends.
// A default that is not running is a line that cannot be picked. `q` filters by name and machine.
// A plugin's targets ({targets:true}): the same rows, without headings, pins or notes, and in
// words that name no session or router. The account menu ({notes:false}) only picks a default: pins, no notes.
function sessionListHTML(hub,reason,defaultOff,{targets=false,q='',note=null,notes=true}={}){
  hub=hub||[];const w=sendWords(targets),nameOf=h=>h.name||h.label||h.session_id.slice(0,8);
  const match=h=>!q||`${nameOf(h)} ${h.machine||''}`.toLowerCase().includes(q.toLowerCase());
  const live=hub.filter(h=>h.router),multi=!targets&&new Set(live.map(h=>h.machine).filter(Boolean)).size>1;
  const ready=live.filter(match).sort((a,b)=>(b.default?1:0)-(a.default?1:0)),dead=hub.filter(h=>!h.router&&match(h));
  const btn=(h,off,old=h.stale||!Number.isFinite(h.age_s)||h.age_s>=120?' old':'')=>`<button type="button" class="send-session" ${off?'disabled aria-disabled="true"':`data-session="${esc(h.session_id)}"`} title="${esc(nameOf(h))}"><span class="send-dot${old}" aria-hidden="true"></span><span class="send-session-name"><span class="send-name-text">${esc(nameOf(h))}</span></span>${multi&&h.machine&&(h.default||q)?`<span class="send-machine">${esc(h.machine)}</span>`:''}<span class="send-session-meta${old}">${esc([h.stale?'stale':'',sessionAgo(h.age_s)].filter(Boolean).join(' · '))}</span></button>`;
  const pin=h=>`<button type="button" class="send-pin${h.default?' on':''}" data-pin="${esc(h.session_id)}" ${h.default?`data-clear-default="${esc(h.session_id)}" aria-pressed="true" title="Your default · click to clear"`:`data-make-default="${esc(h.session_id)}" aria-pressed="false" title="Make default"`} aria-label="Default session: ${esc(nameOf(h))}">${PIN_SVG}</button>`;
  const open=h=>!!note&&note.session===h.session_id;
  const bubble=h=>`<button type="button" class="send-note-btn" data-note-for="${esc(h.session_id)}" aria-expanded="${open(h)}" aria-label="Add a note and send to ${esc(nameOf(h))}" title="Send with a note">${NOTE_SVG}</button>`;
  const noteBox=h=>`<div class="send-row-note"><textarea id="send-note" maxlength="${NOTE_MAX}" rows="3" aria-label="Note for ${esc(nameOf(h))}" placeholder="Note for ${esc(nameOf(h))}">${esc(note.text||'')}</textarea><button type="button" class="send-note-go" data-send-note="${esc(h.session_id)}">Send</button></div>`;
  const row=h=>`<div class="send-session-row${open(h)?' noting':''}">${btn(h,false)}${targets?'':(notes?bubble(h):'')+pin(h)}</div>${open(h)?noteBox(h):''}`;
  const dflt=!targets&&!q&&ready[0]&&ready[0].default?ready[0]:null,rest=dflt?ready.slice(1):ready;
  const groups=targets||q?[[ready,'']]:[...(dflt?[[[dflt],'Default']]:[]),...(multi?[...new Set(rest.map(h=>h.machine))].map(m=>[rest.filter(h=>h.machine===m),m]):[[rest,dflt?'Other sessions':'']])].filter(([rows])=>rows.length);
  const group=([rows,title],i)=>`${title?`<p class="send-group-title send-heading" id="send-h-${i}">${esc(title)}</p>`:''}<div class="send-group send-list" role="group" ${title?`aria-labelledby="send-h-${i}"`:`aria-label="${w.group}"`}>${rows.map(row).join('')}</div>`;
  const off=defaultOff&&!targets?`<p class="send-default-off muted small">Default · ${esc(nameOf(defaultOff))} · not running <button type="button" class="text-button send-default-ctl" data-clear-default="${esc(defaultOff.session_id)}">Clear default</button></p>`:'';
  if(!hub.length)return `${off}<p class="send-empty">${reason?esc(reason):w.empty}</p>`;
  return `${reason?`<p class="session-help warn" role="status">${esc(reason)}</p>`:''}${off}${ready.length?groups.map(group).join(''):q?`<p class="send-empty">No session matches “${esc(q)}”.</p>`:`<p class="send-empty">${w.none}</p>`}${dead.length?`<div class="send-group" role="group" aria-labelledby="send-dead-h"><p class="send-group-title" id="send-dead-h">${w.dead}</p>${dead.map(h=>btn(h,true)).join('')}</div>`:''}`;
}
// (standup A114, then A115): Done and Won't do are the card's own
// buttons -- no confirm; Undo on the row it leaves is the safety net. What became of
// it is kept so the backlog can be reconciled: a to-do's Won't do is the
// hub's `wont_do` verb; a meeting card's answer goes on its archive event.
// One builder for the close and its Undo ('reopen'), so the pair can't drift.
function archiveRequest(c,act,version,who){return act==='reopen'?['/unarchive',{id:c.id,version,by:who||'board',who:who||null}]
  :['/archive',{id:c.id,version,outcome:act,by:who||'board',who:who||null}];}
// One overlay helper for the reader's list actions (2026-09-23):
// Send to Claude and Change owner each open a <dialog> built here.
// Focus goes back to whatever opened it.
function pickDialog(id,title){let dlg=document.getElementById(id);if(!dlg){dlg=document.createElement('dialog');dlg.id=id;dlg.className='send-dialog pick-dialog';dlg.setAttribute('aria-labelledby',id+'-title');dlg.innerHTML=`<div class="send-dialog-head"><h2 id="${id}-title"></h2><button type="button" class="settings-close" id="${id}-close" aria-label="Close" title="Close">×</button></div><p class="send-dialog-who muted small" id="${id}-who"></p><div id="${id}-list"></div>`;document.body.append(dlg);dlg.querySelector('#'+id+'-close').onclick=()=>dlg.close();dlg.addEventListener('close',()=>{const t=dlg._return;dlg._return=null;if(t&&document.body.contains(t))t.focus();});dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close();});}dlg.querySelector('#'+id+'-title').textContent=title;return dlg;}
function showPickDialog(dlg){dlg._return=document.activeElement;if(typeof dlg.showModal==='function'){if(!dlg.open)dlg.showModal();}else dlg.setAttribute('open','');}
function sendDialog(){const dlg=pickDialog('send-dialog',sendLabel());$('#send-dialog-who').hidden=true;return dlg;}
// The control in the dialog whose attribute `n` is `v`: a repaint or a move puts focus back on it.
const byAttr=(dlg,n,v)=>[...dlg.querySelectorAll('['+n+']')].find(x=>x.getAttribute(n)===v);
// More than 8 sessions: a find field above the list (outside it, so a repaint keeps what is typed).
function sendFindBox(dlg,on){let f=dlg.querySelector('#send-find');if(on&&!f){f=document.createElement('input');f.type='search';f.id='send-find';f.className='send-find';f.placeholder='Find a session';f.autocomplete='off';f.setAttribute('aria-label','Find a session');f.oninput=paintSendDialog;f.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();dlg.querySelector('#send-dialog-list [data-session]')?.click();}};$('#send-dialog-list').before(f);}else if(!on&&f){f.remove();f=null;}return f;}
// A name wider than its row fades at the edge, and slides to its end on hover (live.css): measured after each paint.
function fitSendNames(root){[...root.querySelectorAll('.send-session-name')].map(n=>[n,n.firstElementChild.offsetWidth-n.clientWidth]).forEach(([n,d])=>{n.classList.toggle('over',d>2);if(d>2){n.style.setProperty('--dx',(-d-4)+'px');n.style.setProperty('--dur',(d/40).toFixed(2)+'s');}});}
// Makes a session the default (on) or clears it, then rereads the sessions; '' or what went wrong.
// Shared by the Send to Claude picker and the account menu (account.js), which each repaint after.
function setDefaultSession(id,on){return LIVE.postJSON('/session-default',{id,on}).then(r=>r.ok?'':(r.body&&r.body.error)||'the server refused it',()=>'the connection failed').then(err=>LIVE.fetchSessions().then(()=>err));}
function defaultErrorHTML(err){return `<p class="session-help warn" role="status">Could not change your default session: ${esc(err)}.</p>`;}
// The dialog's own state: the find field's text and which row's note is open (dlg._noteFor);
// the note's text is on the card's draft. A repaint puts focus back where it was.
function paintSendDialog(){const dlg=document.getElementById('send-dialog');if(!dlg||!dlg.open||dlg.classList.contains('sending'))return;
  const a=document.activeElement,k=a&&a.hasAttribute&&['data-session','data-note-for','data-send-note','data-pin'].find(n=>a.hasAttribute(n)),v=k&&a.getAttribute(k),sel=a&&a.id==='send-note'?[a.selectionStart,a.selectionEnd]:null;
  const plugin=pluginTargets(),find=sendFindBox(dlg,!plugin&&(LIVE.api.hub||[]).filter(h=>h.router).length>8);
  const note=dlg._noteFor&&!plugin?{session:dlg._noteFor,text:draft(dlg.dataset.card).note||''}:null;
  $('#send-dialog-list').innerHTML=sessionListHTML(LIVE.api.hub,LIVE.api.hubReason,LIVE.api.defaultOff,{targets:plugin,q:find?find.value.trim():'',note});
  if(dlg._queued)$('#send-dialog-list').insertAdjacentHTML('afterbegin',`<p class="session-help">${esc(queuedWords(dlg._queued))}</p>`);
  if(sel){const t=$('#send-note');if(t){t.focus();t.setSelectionRange(...sel);}}
  else if(k)byAttr(dlg,k,v)?.focus();
  fitSendNames($('#send-dialog-list'));}
function queuedWords(to){return `Already queued for ${to}. To send it again, use Send again on the card.`;}
// An optional note travels with the send, kept on the card's draft so an
// "Outcome unknown → Send again" retry carries the same note with the same id.
const NOTE_MAX=1000;
// A pick shows where it went: the row tints and its dot turns to a check, then the dialog
// fades out. The send has already started; under Reduce Motion the dialog closes at once.
function sentAndGone(dlg,id){dlg.classList.add('sending');if(DELIGHT.reduced()){dlg.close();return;}
  byAttr(dlg,'data-session',id)?.closest('.send-session-row')?.classList.add('sent');
  dlg._closing=setTimeout(()=>{dlg.classList.add('closing');dlg._closing=setTimeout(()=>dlg.close(),160);},400);}
// A note is per session: its row's note button opens it under that row, with its own Send.
// A name sends at once, without one. A plugin's targets take no note, and nothing typed earlier is sent.
// A note kept on the card opens again under the session it was typed for, else the one it was last sent to,
// if live; else under the default, else the first.
function openSendDialog(c){const dlg=sendDialog();clearTimeout(dlg._closing);dlg.classList.remove('sending','closing');dlg.dataset.card=c.id;dlg.onclick=null;dlg._queued=null;
  const live=(LIVE.api.hub||[]).filter(h=>h.router),d=draft(c.id),f=dlg.querySelector('#send-find');if(f)f.value='';
  dlg._noteFor=pluginTargets()||!d.note?null:((live.find(h=>h.session_id===d.noteFor)||live.find(h=>h.session_id===d.session)||live.find(h=>h.default)||live[0]||{}).session_id||null);
  const list=$('#send-dialog-list');
  list.oninput=e=>{if(e.target.id!=='send-note')return;const curr=draft(c.id);curr.note=e.target.value.slice(0,NOTE_MAX);curr.noteFor=dlg._noteFor;save(c.id,curr);};
  list.onkeydown=e=>{if(e.key!=='Escape'||!e.target.closest('.send-row-note'))return;e.preventDefault();e.stopPropagation();const id=dlg._noteFor;dlg._noteFor=null;paintSendDialog();byAttr(dlg,'data-note-for',id)?.focus();};
  list.onclick=e=>{if(dlg.classList.contains('sending'))return;
    const d=e.target.closest&&e.target.closest('[data-make-default],[data-clear-default]');if(d){const on=d.hasAttribute('data-make-default'),id=on?d.dataset.makeDefault:d.dataset.clearDefault,was=d.closest('.send-session-row')?.getBoundingClientRect().top;setDefaultSession(id,on).then(err=>{paintSendDialog();if(err)list.insertAdjacentHTML('afterbegin',defaultErrorHTML(err));
      // Focus stays on the pin (the repaint put it back). The new default's pin drops in and its row rises to the top.
      const row=byAttr(dlg,'data-pin',id)?.closest('.send-session-row');if(on&&!err&&row){row.style.setProperty('--from',((was||0)-row.getBoundingClientRect().top)+'px');DELIGHT.play(row,'rise');DELIGHT.play(row.querySelector('.send-pin'),'drop');}});return;}
    const n=e.target.closest&&e.target.closest('[data-note-for]');if(n){const id=n.dataset.noteFor;dlg._noteFor=dlg._noteFor===id?null:id;paintSendDialog();(dlg._noteFor?$('#send-note'):byAttr(dlg,'data-note-for',id))?.focus();return;}
    const b=e.target.closest&&e.target.closest('[data-session],[data-send-note]');if(!b||b.disabled)return;const id=b.dataset.sendNote||b.dataset.session;
    // A card Queued for this session is not sent there again by a pick, with a note or without; Send again on its receipt is a new hand-off.
    const curr=draft(c.id);if(curr.status==='accepted'&&curr.session===id){dlg._queued=curr.target||sessionLabel(id);paintSendDialog();announce(queuedWords(dlg._queued));return;}
    curr.session=id;curr.note=b.dataset.sendNote?($('#send-note')?.value||'').slice(0,NOTE_MAX):'';delete curr.noteFor;curr.status='draft';delete curr.error;delete curr.errorField;save(c.id,curr);
    // Focus goes where the send's outcome is once the dialog has gone; while it is in flight, back to what opened it.
    dlg.addEventListener('close',()=>{if(!busy.has(key(c.id)))sentFocus(c);},{once:true});sendRoute(c);sentAndGone(dlg,id);};
  showPickDialog(dlg);paintSendDialog();(dlg.querySelector('#send-find')||dlg.querySelector('[data-session]')||dlg.querySelector('#send-dialog-close')).focus();LIVE.fetchSessions().then(paintSendDialog);}
function renderRoute(c,d,target) {
  const area=target||$('#route-area'); if(!area)return;
  if(d.status==='accepted') {
    // Read or Queued from the card's own hand-off record, as the list badge says (cardParts):
    // this browser's draft only knows the send went. This send's entry, by its hand-off id; a send
    // that got none (a provider's) stays Queued, and a draft kept from before ids were kept reads the newest.
    const routed=(cards.find(x=>x.id===c.id)||c).routed||[],to=esc(d.target||sessionLabel(d.session));
    const mine=d.handoff===undefined?routed.slice(-1)[0]:d.handoff?routed.find(x=>x.handoff_id===d.handoff):null;
    area.innerHTML=`<div class="status-box" id="route-receipt" tabindex="-1">${mine&&mine.read_at?`<span class="eyebrow">READ</span><h3>Read in ${to}</h3>`:`<span class="eyebrow">QUEUED</span><h3>Queued for ${to}</h3>`}<code>${esc(d.request_id)}<br>${esc(d.accepted_at||'')}</code>${d.receipt===false?'<p class="small">Sent, but not recorded on the card.</p>':''}<button id="route-again" class="text-button">Send again</button></div>`;
    // Nothing to close or leave by here: the card's own row sits
    // just above, and leaving is picking another card.
    $('#route-again').onclick=()=>{save(c.id,{session:d.session,status:'draft'});renderRoute(c,draft(c.id));openSendDialog(c);};return;
  }
  if(d.status==='sending'||d.status==='unknown') {
    const inFlight=busy.has(key(c.id));
    area.innerHTML=`<div class="status-box" id="route-pending" role="status"><h3>${inFlight?'Sending…':'Outcome unknown.'}</h3><p>${inFlight?'You can leave this card.':'The connection dropped before bwat answered. Sending again won’t send it twice.'}</p><code>${esc(d.request_id)}</code>${!inFlight?'<button id="check-status" class="primary">Send again</button>':''}</div>`;
    $('#check-status')?.addEventListener('click',()=>checkStatus(c));return;
  }
  // Only your own open to-do goes to your Claude (2026-09-23); the server refuses the rest too.
  const sendState=actionState(c,cardOwner(c)).send;
  // Questions and risks have no owner to check: the open card's
  // own gate (name picked, not done) is the whole rule.
  // A closed one says why there is nothing to send; an unowned one says it in its greyed Send's tip.
  if(viewer&&!UNOWNED_SEND.includes(c.bucket)&&(!sendState.show||sendState.why)){area.innerHTML=c.closed?`<div class="context-note"><p>${esc(sendState.why)}.</p></div>`:'';return;}
  const hub=LIVE.api.hub||[];
  // The rules: a session without a router can
  // never collect a hand-off, so it is listed but cannot be picked; a pick that
  // vanished is blanked and said so, never swapped for another session; the
  // hub's reason shows even beside rows, since rows then mean a stale list.
  const ready=hub.filter(h=>h.router);
  // A pick that vanished is said, never swapped for another session.
  const gone=!!d.session&&!ready.some(h=>h.session_id===d.session);
  const why=!viewer?'Sign in first — it goes to your own sessions.':'';
  const note=gone&&d.status==='failed'?sendWords().gone:'';
  area.innerHTML=`<div class="route-form" id="route-form">${d.error?`<div class="error-box" id="route-error" role="alert" tabindex="-1"><h3>${d.errorField?'Choose where this goes.':'Not sent.'}</h3><p>${esc(d.error)}</p></div>`:''}${note?`<p class="session-help warn" role="status">${esc(note)}</p>`:''}${why?`<p class="session-help">${esc(why)}</p>`:''}</div>`;
}
// A failure before the request (or any throw) shows on the card instead of
// vanishing as an unhandled rejection -- the overlay has already closed.
async function sendRoute(c) {
  try { return await sendRouteNow(c); }
  catch (e) {
    busy.delete(key(c.id));
    save(c.id,{...draft(c.id),status:'failed',error:'Could not send: '+((e&&e.message)||e)});
    if(state().card!==c.id) sendOutcome(c);
    render();
    if(state().card===c.id) $('#route-error')?.focus();
  }
}
// A send started from a card in the list has no reader to show its outcome: the card's Queued
// chip says it went (the full receipt, with "Marked read", is in the card's reader); a send that
// failed, or may not have gone, says so on the card, with Try again.
function sendOutcome(c) {
  const d=draft(c.id);
  if(d.status==='accepted'){clearError(c.id);return;}
  noteCard(c.id,'err',d.status==='failed'?'Not sent: '+(d.error||'try again.'):'Outcome unknown. Send it again — it won’t be sent twice.',
    d.status==='failed'?{retry:()=>openSendDialog(c),stays:true}:{retry:()=>checkStatus(c)});
}
// The reader is painted only while it shows this card.
function routeHere(c) { if(state().card===c.id) renderRoute(c,draft(c.id)); }
async function sendRouteNow(c) {
  if(busy.has(key(c.id))||!viewer) return;
  const d=draft(c.id), person=viewer;
  if(!d.session) {save(c.id,{...d,error:sendWords().choose,errorField:true});routeHere(c);$('#route-error')?.focus();return;}
  // One request ID per destination: a retry after a timeout reuses it (the backend
  // de-duplicates on it); a different session is a different hand-off.
  const note=pluginTargets()?'':(d.note||'').trim();
  if(!d.request_id||d.request_session!==d.session||(d.request_note||'')!==note){d.request_id=uuid();d.request_session=d.session;d.request_note=note;}
  d.status='sending';delete d.error;delete d.errorField;
  if(!save(c.id,d))return;
  busy.add(key(c.id,person));routeHere(c);announce('Sending.');
  const body={...(note?{note}:{}),id:c.id,title:c.title,bucket:c.bucket,owner:c.owner||null,who:person,brief:plainText(c.detail).slice(0,900),src:c.src,session:d.session,message_id:d.request_id};
  try {
    const r=await LIVE.postJSON('/route',body);
    // The hand-off wrote a new revision: the next action on this card goes at it.
    if(r.ok&&r.body.card){const cur=cards.find(x=>x.id===c.id);if(cur)cur.version=r.body.card.version;}
    if(r.ok) save(c.id,{...d,note:'',noted:!!note,status:'accepted',target:r.body.target||'',handoff:r.body.handoff_id||'',receipt:r.body.receipt,accepted_at:new Date().toLocaleString()},person);
    else save(c.id,{...d,status:'failed',error:errText(r)},person);
  } catch {save(c.id,{...d,status:'unknown'},person);}
  finally {
    busy.delete(key(c.id,person));
    if(viewer===person) {
      // Not sent from the list: the card's red line is the reading (sendOutcome).
      const ok=draft(c.id).status==='accepted';
      if(state().card!==c.id)sendOutcome(c);
      render();
      if(ok)DELIGHT.sent(c.id);
      sentFocus(c);
      if(ok||state().card===c.id)announce(ok?'Queued.':'Not sent — needs attention.');
    }
  }
}
// After a send: the open card's outcome, else the card's own Send (or the card) in the list.
function sentFocus(c){if(state().card===c.id){const target=$('#route-receipt')||$('#route-error')||$('#route-pending');target?.setAttribute('tabindex','-1');target?.focus();}else (document.getElementById('send-'+c.id)||document.getElementById('open-'+c.id))?.focus();}
function checkStatus(c) { const d=draft(c.id); save(c.id,{...d,status:'draft'}); return sendRoute(c); }
// Why an action can't run for this viewer ('' when it can); show:false hides
// an action that never applies to the card.
function actionState(c,owner) {
  const noName='Sign in first';
  const send={show:c.bucket==='do',why:''},own={show:c.bucket==='do',why:''},arch={show:true,why:''};
  if(!viewer)send.why=own.why=noName;
  else {
    if(c.closed)send.why='This card is closed, so there is nothing to send';
    // Someone else's card has no Send at all (the mock-up), not a greyed one.
    else if(owner&&owner!==viewer)send.show=false;
    else if(owner!==viewer)send.why=sendWords().assign;
    if(c.closed)own.why='A closed card keeps its owner';
  }
  return {send,owner:own,archive:arch};
}
// Send to Claude is on the card in the list.
// Questions and risks have no owner, so anyone with a name may send one to
// their own Claude -- from the open card only, not the list.
// The server's list is serve.py UNOWNED_ROUTABLE; a test keeps the two equal.
// An open to-do nobody owns: Take it first, then a greyed Send that says why in its tip.
const UNOWNED_SEND=['ask','risk'];
function actionsHTML(c,owner) {
  const a=actionState(c,owner);
  const st={show:true,why:!viewer?'Sign in first':c.closed?'This card is closed, so there is nothing to send':''};
  const send=UNOWNED_SEND.includes(c.bucket)?actionButton('send-open',sendLabel(),st,'',true,` data-send="${esc(c.id)}"`)
    :c.bucket==='do'&&!owner&&!c.closed?takeControlHTML(c,'reader-take','primary')+actionButton('send-open',sendLabel(),a.send,'',true,` data-send="${esc(c.id)}"`):'';
  return `<div class="action-row" role="group" aria-label="Card actions">${send}${actionButton('change-owner','Change owner',a.owner)}${actionButton('do-done','Done',a.archive,'',false)}${actionButton('do-wont','Won’t do',a.archive,'',false)}</div><p class="small" id="action-status" role="status"></p>`;
}
// The people Change owner offers. Meeting cards: Unassigned plus the roster
// (the names the server accepts); to-dos: active people, by org user id.
// The current owner is listed but cannot be picked.
function peopleListHTML(c,owner) {
  const rows=[{key:'',name:'Unassigned',current:!owner,none:true},...(LIVE.api.people||[]).map(n=>({key:n,name:n,current:owner===n}))];
  if(!rows.length)return '<p class="send-empty">No people to choose from.</p>';
  return `<div class="send-group" role="group" aria-label="People">${rows.map(r=>{const col=r.none?'':ownerColor(r.name);return `<button type="button" class="send-session person-option" ${r.current?'disabled aria-disabled="true" aria-current="true"':`data-person="${esc(r.key)}"`} data-name="${esc(r.name)}"><span class="send-session-name"><span class="person-dot" aria-hidden="true"${col?` style="--chip:${col}"`:''}></span>${esc(r.name)}</span><span class="send-session-meta">${r.current?'current owner':''}</span></button>`;}).join('')}</div>`;
}
// Held changes: the feed is
// regenerated on its own schedule, so a refresh right after an action can
// still carry the card as it was. Hold an archived card hidden, and a new
// owner in place, until the feed agrees -- or DELIGHT.ms.hold passes, so a write the
// server later lost cannot hide a card for good. `place`: where a card you closed was drawn,
// the cards just before and after it in its column (DELIGHT.placeBack). Its row keeps that place,
// and so does the card Undo brings back, for the hold after (`at`), however the feed lists it
// again; the card itself too (`card`), until a refresh lists it again, as one just after the Undo
// may not. A merge undone has no place recorded: the sort alone places it.
const HELD={gone:{},owner:{},place:new Map()};
// A card you close leaves a slim row in its place, "Done · <title> · Undo" (DELIGHT.rows), then the
// row folds away. The row is drawn from the card as it was, so it stays put while the card service
// stops listing the card: applyHeld gives it `row`, which every list, count and drag reads.
const ROWS=DELIGHT.rows($('#card-list'),DELIGHT.cardEl,id=>{HELD.place.delete(id);holdGone(id);redraw();});   // id -> {card, label, undo}
// `served`: the list is a read from the server, the only thing that may say a reopened card is
// listed again; the board's own list (a change made here) already holds it.
function applyHeld(list,served) {
  const now=Date.now(),hold=DELIGHT.ms.hold,byId=new Map(list.map(c=>[c.id,c]));
  for(const id of Object.keys(HELD.gone)) if(!byId.has(id)||now-HELD.gone[id]>hold) delete HELD.gone[id];
  for(const [id,h] of Object.entries(HELD.owner)){const c=byId.get(id); if(!c||cardOwner(c)===h.owner||now-h.at>hold) delete HELD.owner[id];}
  for(const [id,p] of HELD.place) if(p.at&&now-p.at>hold) HELD.place.delete(id); else if(served&&byId.has(id)) delete p.card;
  const back=[...HELD.place].filter(([id,p])=>p.card&&!byId.has(id)).map(([,p])=>p.card);
  // A card you just closed is still inking out (delight.js): keep it until it has folded,
  // even when the card service has already stopped listing it; then its row, the same way.
  const inking=[...DELIGHT.leaving].filter(id=>!byId.has(id)).map(id=>cards.find(c=>c.id===id)).filter(Boolean);
  const row=id=>({...ROWS.all.get(id).card,row:true});
  const rows=[...ROWS.all.keys()].filter(id=>!byId.has(id)).map(row);
  // A row whose Undo worked is the card again until the refresh brings it.
  const card=({row:_,...c})=>c;
  return list.filter(c=>!(c.id in HELD.gone)).map(c=>ROWS.all.has(c.id)?row(c.id):c.id in HELD.owner?{...card(c),owner:HELD.owner[c.id].owner}:c.row?card(c):c).concat(inking,rows,back);
}
function holdGone(id){HELD.gone[id]=Date.now();cards=applyHeld(cards);}
function holdOwner(id,owner){HELD.owner[id]={owner,at:Date.now()};cards=applyHeld(cards);}
// Last of the sorts: a card you closed, or reopened, goes back between the cards it was drawn between.
addHook('sort','return',list=>DELIGHT.placeBack(list,HELD.place));
// Done, Won't do and an answer (desk.js, no undo) strike the card through in ink, fold it, and
// leave its row. `say` is what a screen reader hears.
async function closeToRow(c,label,undo,say){
  const el=DELIGHT.cardEl(c.id),near=k=>{for(let x=el&&el[k];x;x=x[k])if(x.dataset.card)return x.dataset.card;return null;};
  HELD.place.set(c.id,{before:near('previousElementSibling'),after:near('nextElementSibling'),at:0});
  // Its open reader closes; focus on the card itself (its own Done) goes to the list's title, as from the reader.
  DELIGHT.leaving.add(c.id);if(state().card===c.id)navigate({card:null},{focus:'results-title'});else if(el&&el.contains(document.activeElement))$('#results-title').focus();announce(say);
  await DELIGHT.wait(560);await DELIGHT.fold(c.id);DELIGHT.leaving.delete(c.id);
  ROWS.add(c.id,{card:cardById(c.id)||c,label,undo});
  // Drawn now, not at the caller's refresh a round trip later: the fold has left a gap.
  cards=applyHeld(cards);redraw();
}
// The row's markup holds no clock, so a redraw keeps its node and its drain runs on (delight.css).
// Refused, its Undo's error line ('slim:'+id) takes the Undo's place, with Try again. It comes in
// (once-in) on its first paint only, not again when a refusal redraws it.
function slimHTML(c){const x=ROWS.all.get(c.id),id=esc(c.id),err=noteHTML('slim:'+c.id),first=!x.painted;x.painted=true;
  const act=err||(x.undo?`<button type="button" class="text-button" id="undo-${id}" data-slim-undo="${id}" aria-label="Undo ${esc(x.label)}: ${esc(c.title)}">Undo</button>`:'');
  return `<article class="card slim-row${first?' once-in':''}${DELIGHT.folding.has('slim:'+c.id)?' folding':''}" data-card="${id}" style="--slim-ms:${DELIGHT.ms.slim}ms"><span class="slim-label">${esc(x.label)}</span><s>${esc(c.title)}</s>${act}${err?'':'<span class="slim-drain" aria-hidden="true"></span>'}</article>`;}
document.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-slim-undo]');if(!b)return;
  e.stopPropagation();const x=ROWS.all.get(b.dataset.slimUndo);if(x&&x.undo&&!x.held.has('busy'))x.undo();});
// One request path for an owner change, shared by the reader and the card-face
// "Assign" control: the card as the latest refresh has it, so the version
// is current.
function postOwner(c,next){const cur=cards.find(x=>x.id===c.id)||c;return LIVE.post('/assign',{id:c.id,owner:next,version:cur.version,by:viewer||'board',who:viewer||null});}
// Set an owner and say so. Returns null when done (or a stale edit, which
// reloads), else the error sentence for the caller to show.
// Refused as stale: the card reloads, and if it is still open with the owner this person saw (the
// card writer revised the text, say: an owner change writes only the owner), the change goes once
// more at the new revision. An owner someone else set first, or a card closed meanwhile, is kept,
// and named on the card.
async function applyOwnerChange(c,key,again=true){
  const was=cardOwner(cards.find(x=>x.id===c.id)||c);
  const r=await postOwner(c,key);
  if(again&&r.body&&r.body.stale){await refresh(true);const now=cards.find(x=>x.id===c.id);
    if(now&&!now.closed&&cardOwner(now)===was)return applyOwnerChange(now,key,false);
    changedBy(c.id,r.body);redraw();return null;}
  // The held owner is already in `cards`, so the refresh may not see a change to wash: washed here,
  // and the new owner stamps into the card's owner circle (once-* is not a change to a redraw).
  if(r.ok){clearError(c.id);holdOwner(c.id,key);announce(`Owner: ${key||'unassigned'}.`);await refresh(true);
    const el=DELIGHT.cardEl(c.id);DELIGHT.mark(el,'is-changed');DELIGHT.play(el?.querySelector('.card-owner'),'once-stamp');return null;}
  if(r.body&&r.body.stale){changedBy(c.id,r.body);await refresh(true);return null;}
  return errText(r);
}
// Undo a Done or Won't do from its row: the store puts the card back (at the version the archive
// left it), and it drops into the place it left (HELD.place). Refused, the row says why, with Try
// again, and holds until that is fixed.
async function undoDone(c,version){const x=ROWS.all.get(c.id);if(!x)return;
  ROWS.hold(c.id,'busy',true);
  await reopenCard(c,version,r=>{ROWS.hold(c.id,'err',true);ROWS.hold(c.id,'busy',false);noteCard('slim:'+c.id,'err',errText(r),{retry:x.undo});redraw();},r=>{
    ROWS.remove(c.id);clearNote('slim:'+c.id);delete HELD.gone[c.id];const p=HELD.place.get(c.id);if(p)Object.assign(p,{at:Date.now(),card:{...x.card,version:r.body?.version??x.card.version}});
    cards=applyHeld(cards);});   // no row left in the list for a render before the refresh lands
}
// Reopens a closed card (the row's Undo, or Reopen in its ⋯ menu): refused, `failed(r)` says so;
// reopened, `landed(r)` runs before the refresh, then the card comes back marked new.
async function reopenCard(c,version,failed,landed=()=>{}){
  const r=await LIVE.post(...archiveRequest(c,'reopen',version,viewer));
  if(!r.ok)return failed(r);
  landed(r);await refresh(true);DELIGHT.mark(DELIGHT.cardEl(c.id),'is-new');announce('Reopened: '+c.title+'.');}
// Reopen in a closed card's ⋯ menu: refused, said with Try again on the card, or in the reader
// when its menu was the reader's ('reader:'+id); stale, who changed it first.
// One at a time per card: asked again while one is on its way, it does not run (NOT_RUN).
const REOPENING=new Set();
async function reopenFromMenu(c,inReader=false){if(REOPENING.has(c.id))return NOT_RUN;REOPENING.add(c.id);
  const key=inReader?'reader:'+c.id:c.id;
  try{const now=cards.find(x=>x.id===c.id)||c;clearError(key);
    return await reopenCard(now,now.version,async r=>{if(r.body&&r.body.stale){changedBy(c.id,r.body);await refresh(true);return;}
      noteCard(key,'err',errText(r),{retry:()=>reopenFromMenu(c,inReader)});
      if(inReader){lineEl(key)?.remove();$('#edit-area')?.insertAdjacentHTML('beforebegin',noteHTML(key));}else redraw();});}
  finally{REOPENING.delete(c.id);}}
// Done or Won't do, from the reader or the card's own Done: one at a time per card (NOT_RUN while
// one is on its way). Closed, the card folds into its row with Undo; stale, who changed it first is
// said on it and it reloads; refused, the reason is returned. `answered` hears the reply first.
const CLOSING=new Map();
function closeCard(c,outcome,answered=()=>{}){if(CLOSING.has(c.id))return Promise.resolve(NOT_RUN);
  const run=(async()=>{const r=await LIVE.post(...archiveRequest(c,outcome,c.version,viewer));answered(r);
    if(r.ok){const done=outcome==='done';clearError(c.id);clearError('reader:'+c.id);
      await closeToRow(c,done?'Done':'Won’t do',()=>undoDone(c,r.body.version),(done?'Done for everyone: ':'Won’t do, for everyone: ')+c.title+'.');await refresh(true);return null;}
    if(r.body&&r.body.stale){changedBy(c.id,r.body);await refresh(true);return null;}
    return errText(r);})().finally(()=>CLOSING.delete(c.id));
  CLOSING.set(c.id,run);return run;}
// The card's Done: refused, said on the card with Try again.
async function doneFromCard(id){const c=cardById(id);if(!c)return;
  const err=await closeCard(c,'done');
  if(err===NOT_RUN)return NOT_RUN;
  if(err){noteCard(id,'err',err,{retry:()=>doneFromCard(id)});redraw();}}
function wireActions(c,owner) {
  const status=t=>{const el=$('#action-status'); if(el) el.textContent=t;};
  // The card as the latest refresh has it: an open reader is not re-rendered
  // by a poll, so the closure's `c.version` goes stale and every later edit
  // would be refused.
  const current=()=>cards.find(x=>x.id===c.id)||c;
  const off=b=>!b||b.getAttribute('aria-disabled')==='true';
  // Refused: said in red under the buttons (read once, 'reader:'+id), with Try again doing it again.
  const failed=(err,retry)=>{noteCard('reader:'+c.id,'err',err,{retry});
    lineEl('reader:'+c.id)?.remove();$('#action-status')?.insertAdjacentHTML('afterend',noteHTML('reader:'+c.id));};
  const ownB=$('#change-owner');
  const setOwner=async key=>{ownB.setAttribute('aria-disabled','true');status('Saving…');
    const err=await applyOwnerChange(c,key);
    if(err){status('');ownB.removeAttribute('aria-disabled');failed(err,()=>setOwner(key));}};
  if(ownB) ownB.onclick=()=>{if(off(ownB))return;
    const dlg=pickDialog('owner-dialog','Change owner');
    $('#owner-dialog-who').textContent=`Recorded as a change by ${viewer}.`;
    $('#owner-dialog-list').innerHTML=peopleListHTML(c,owner);
    $('#owner-dialog-list').onclick=async e=>{const b=e.target.closest&&e.target.closest('[data-person]');if(!b||b.disabled)return;
      dlg.close();setOwner(b.dataset.person);};
    showPickDialog(dlg);(dlg.querySelector('[data-person]')||dlg.querySelector('#owner-dialog-close')).focus();};
  // Done / Won't do (A115): one click, then Undo on the row the card leaves.
  const doneB=$('#do-done'),wontB=$('#do-wont');
  const reopen=()=>{doneB.removeAttribute('aria-disabled');wontB.removeAttribute('aria-disabled');};
  // Closed: the card is struck through in ink, then folds into its row; it is yours, so it
  // never lingers as someone else's change.
  const closeAs=async(b,outcome)=>{if(off(b))return;doneB.setAttribute('aria-disabled','true');wontB.setAttribute('aria-disabled','true');status('Closing…');
    const err=await closeCard(current(),outcome,r=>{status('');if(!r.ok)reopen();});
    // A close already on its way (the card's Done): Closing… until it settles, and its refusal said here too.
    if(err===NOT_RUN){const other=await CLOSING.get(c.id);status('');reopen();if(other&&other!==NOT_RUN)failed(other,()=>closeAs(b,outcome));return NOT_RUN;}
    if(err)failed(err,()=>closeAs(b,outcome));};
  if(doneB) doneB.onclick=()=>closeAs(doneB,'done');
  if(wontB) wontB.onclick=()=>closeAs(wontB,'wont_do');
}
// The card's Send buttons: delegated once, like assign.js, since an
// in-place refresh moves freshly rendered rows into the live list. They sit
// outside the card's open button, and stop here, so the card never opens.
function cardActionClick(e) {
  const more=e.target.closest&&e.target.closest('[data-more]');
  if(more){e.stopPropagation();const c=cardById(more.dataset.more);if(!c&&more.id!=='meeting-more')return;if(document.getElementById('more-menu')?._button===more)closeMoreMenu(true);else if(c)openMoreMenu(more,c);else openMeetingMenu(more);return;}
  const done=e.target.closest&&e.target.closest('[data-done]');
  if(done){e.stopPropagation();doneFromCard(done.dataset.done);return;}
  const b=e.target.closest&&e.target.closest('[data-send]');
  if(!b) return;
  e.stopPropagation();
  if(b.getAttribute('aria-disabled')==='true') return;
  const c=cardById(b.dataset.send);
  if(!c) return;
  openSendDialog(c);
}
document.addEventListener('click',cardActionClick);
// ── Edit a card (UX sync 9/29: "let's say I just wanna add more context
// before I send it on. How do I edit it?") ──
// Meeting cards only: a new title and/or a note. The note is added after the
// meeting quote, which is never rewritten. While the form is open a heartbeat
// (POST /editing) tells everyone else "Jonah is editing"; GET /editing is
// polled every 5s and shown on the card and in its reader.
function othersEditing(id){return (editingNow[id]||[]).filter(n=>n!==viewer);}
function editingText(id){const o=othersEditing(id);return o.length?`${o.join(' and ')} ${o.length===1?'is':'are'} editing`:'';}
async function pollEditing(){
  if(document.hidden||!snapshot)return;
  let r;try{r=await LIVE.getJSON('/editing');}catch{return;}
  const next=(r&&r.editing)||{};
  if(JSON.stringify(next)===JSON.stringify(editingNow))return;
  editingNow=next;render({keepReader:true});
  const note=$('#editing-note'),t=editingText(state().card);
  if(note){note.textContent=t?'✎ '+t+' this card now.':'';note.hidden=!t;}
}
setInterval(pollEditing,5000);
function beatEditing(id,on){LIVE.postJSON('/editing',{id,on,who:viewer||null}).catch(()=>{});}
function stopEditBeat(){if(!editBeat)return;clearInterval(editBeat.t);beatEditing(editBeat.id,false);editBeat=null;}
addEventListener('pagehide',stopEditBeat);
// The "⋯" menu (9/29: Edit sits under the ellipsis, as in most apps),
// on the card face and in the reader. Edit opens the card if it is not open,
// then its edit form.
let pendingEdit=null;
function moreHTML(c){return `<button type="button" class="more-button" data-more="${esc(c.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${esc(c.id)}" title="More">⋯</button>`;}
function closeMoreMenu(back){const m=document.getElementById('more-menu');if(!m)return;const b=m._button;m.remove();if(b){b.setAttribute('aria-expanded','false');if(back&&document.body.contains(b))b.focus();}}
// One menu under a ⋯ (`html`: its items), for a card's and for the meeting's beside the title (desk.js).
function openMenu(btn,html){
  closeMoreMenu();
  const m=document.createElement('div');m.id='more-menu';m.className='more-menu';m.setAttribute('role','menu');m._button=btn;
  m.innerHTML=html;
  document.body.append(m);
  const r=btn.getBoundingClientRect();m.style.top=(scrollY+r.bottom+4)+'px';m.style.left=Math.max(8,scrollX+r.right-m.offsetWidth)+'px';
  btn.setAttribute('aria-expanded','true');
  m.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeMoreMenu(true);}});
  m.querySelector('[role=menuitem]')?.focus();
  return m;
}
function openMoreMenu(btn,c){
  // A closed card is reopened, not edited; signed out, neither.
  if(viewer&&c.closed){openMenu(btn,`<button type="button" role="menuitem" id="more-reopen">Reopen</button>`);
    $('#more-reopen').onclick=()=>{closeMoreMenu();reopenFromMenu(c,!!btn.closest('#reader'));};return;}
  const why=!viewer?'Sign in first':'';
  openMenu(btn,`<button type="button" role="menuitem" id="more-edit"${why?` aria-disabled="true" title="${esc(why)}"`:''}>Edit</button>${why?`<p class="small muted">${esc(why)}</p>`:''}`);
  $('#more-edit').onclick=()=>{if(why)return;closeMoreMenu();
    if(state().card===c.id&&$('#edit-area'))openEditForm(c);else{pendingEdit=c.id;openCard(c.id);}};
}
document.addEventListener('click',e=>{const m=document.getElementById('more-menu');if(m&&!m.contains(e.target)&&!(e.target.closest&&e.target.closest('[data-more]')))closeMoreMenu();});
function openEditForm(c){
  const area=$('#edit-area');if(!area)return;
  area.innerHTML=`<form id="edit-form" class="route-form"><span class="eyebrow">EDIT</span><label class="field-label" for="edit-title">Title</label><input id="edit-title" maxlength="300" autocomplete="off"><label class="field-label" for="edit-note">Add a note <span class="muted">(optional &middot; the meeting quote stays as it was)</span></label><textarea id="edit-note" maxlength="2000" rows="3"></textarea><p class="small" id="edit-status" role="status"></p><div class="action-row"><button type="submit" class="primary" id="edit-save">Save</button><button type="button" id="edit-cancel">Cancel</button></div></form>`;
  $('#edit-title').value=c.title;
  // The version and title the form opened on: a refresh while typing must not
  // carry the save past someone else's change (only a stale reply moves it).
  let base={version:c.version,title:c.title};
  // After openCard's own focus move (restore(), next frame), so the title box keeps it.
  requestAnimationFrame(()=>requestAnimationFrame(()=>$('#edit-title')?.focus()));
  stopEditBeat();beatEditing(c.id,true);
  // Beats stop when the form is gone (reader closed, card changed, saved).
  editBeat={id:c.id,t:setInterval(()=>{if(!document.getElementById('edit-form'))stopEditBeat();else beatEditing(c.id,true);},8000)};
  const status=t=>{$('#edit-status').textContent=t;};
  const close=()=>{stopEditBeat();area.innerHTML='';$('#reader [data-more]')?.focus();};
  $('#edit-cancel').onclick=close;
  $('#edit-form').onsubmit=async e=>{e.preventDefault();
    const title=$('#edit-title').value.trim(), note=$('#edit-note').value.trim();
    if(!title){status('The title can’t be empty.');return;}
    const body={id:c.id,version:base.version,who:viewer||null};
    if(title!==base.title)body.title=title;
    if(note)body.note=note;
    if(!body.title&&!body.note){close();return;}
    const btn=$('#edit-save');btn.disabled=true;status('Saving…');
    const r=await LIVE.post('/edit',body);
    btn.disabled=false;
    if(r.ok){stopEditBeat();noteCard(c.id,'ok','Saved',{say:'Saved: '+title+'.'});await refresh(true);return;}
    // Someone saved first: keep what was typed, pick up their version, and
    // let them save again over it knowingly.
    if(r.body?.stale){status('Someone else changed this card first. Your text is still here; check the card, then save again.');await refresh();const now=cards.find(x=>x.id===c.id);if(now)base={version:now.version,title:now.title};return;}
    status('Not saved: '+errText(r));};
}
// S15: the meeting's shell as soon as the board knows its meetings, apart from its cards: its title (in
// Zoom its name on the lens row) and the Zoom panel's filter row, the loading rows moved where the cards go.
// The first render waits at most this long for Zoom to name the meeting; a later answer still
// moves the board there (weeks.js askZoom).
const ZOOM_WAIT_MS=3000;
async function paintShell(feedSources){await LIVE.zoomMeeting(ZOOM_WAIT_MS);if(snapshot||loadError)return;
  sources=feedSources;defaultSourceId=LIVE.defaultSource(sources,BOARD_PREFS.get('open'));
  document.body.classList.toggle('surface-zoom',!!LIVE.api.zoom);
  const rows=$('#loading .card-skeleton');if(rows)$('.cards-pane').prepend(rows);
  $('#loading').hidden=true;$('#workspace').hidden=false;
  const s=state();if(!LIVE.api.zoom)paintMeetingHeading(s);paintMeetingInfo(s);paintZoomTabs();}
async function load() {
  loadError=false;$('#loading').hidden=false;$('#workspace').hidden=true;
  try {
    // Inside Zoom the meeting the panel was opened from (the Apps SDK) too, so the first render is that meeting's.
    const [,snap]=await Promise.all([LIVE.whoami(),LIVE.fetchSnapshot(paintShell),LIVE.zoomMeeting(ZOOM_WAIT_MS)]); viewer=LIVE.api.me||'';
    document.body.classList.toggle('surface-zoom',!!LIVE.api.zoom);
    snapshot=snap;cards=applyHeld(snapshot.items,true);sources=snapshot.sources;
    defaultSourceId=LIVE.defaultSource(sources,BOARD_PREFS.get('open'));
    paintFeedAlert();
    $('.cards-pane > .card-skeleton')?.remove();
    $('#loading').hidden=true;$('#workspace').hidden=false;render();restore();
    LIVE.fetchSessions().then(()=>{const c=cards.find(c=>c.id===state().card);if(c)renderRoute(c,draft(c.id));});
    schedulePoll();
  } catch {showLoadError();}
  LIVE.loaded();
}
// Live refresh: new cards arrive without
// moving the reader. A refresh whose data is unchanged does no DOM work; one
// that changed patches card rows in place and reorders only when the order
// changed; a focused control is never replaced and focus is kept; what arrived
// or changed since the viewer last saw the list is marked. Skipped only while
// the tab is hidden or a request is in flight -- typing in search no longer
// stops updates, since the search box itself is never replaced.
let lastCardsSig='',seenCards=null;
// A card folding into its row (applyHeld's `row`) is not a change to it: no wash.
const cardSig=({row,...c})=>JSON.stringify(c);
// Arrival marks and the small moments' one-time classes (once-*, delight.css) are not
// changes: a redraw that differs only by them keeps the live node, so an animation is not
// cut off. Only inside class attributes, so a card's own words are left alone.
const MARKS=/(^| )(is-new|is-changed|once-[\w-]+)(?= |$)/g;
const stripMarks=h=>!h.includes('is-')&&!h.includes('once-')?h:h.replace(/class="([^"]*)"/g,(m,c)=>'class="'+c.replace(MARKS,'').trim()+'"');
// Move `next`'s rendering into the live list. Same cards in the same order and
// the same surroundings: replace only the card rows whose markup changed.
// Anything else: swap the list, reusing every unchanged row's node. A row
// holding the focused control is never replaced; a full swap waits instead.
function morphCardList(live,next){
  const oldCards=[...live.querySelectorAll('[data-card]')],newCards=[...next.querySelectorAll('[data-card]')];
  const skel=el=>{const c=el.cloneNode(true);c.querySelectorAll('[data-card]').forEach(x=>x.replaceWith('\u0001'));return stripMarks(c.innerHTML);};
  const active=document.activeElement,activeCard=active&&live.contains(active)&&active.closest?active.closest('[data-card]'):null;
  const focusedControl=!!activeCard&&/^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
  const sameOrder=oldCards.length===newCards.length&&oldCards.every((x,i)=>x.dataset.card===newCards[i].dataset.card);
  if(sameOrder&&skel(live)===skel(next)){
    let n=0;
    oldCards.forEach((x,i)=>{const y=newCards[i];if(stripMarks(x.outerHTML)===y.outerHTML||(focusedControl&&x===activeCard))return;x.replaceWith(y);n++;});
    return n?'patched':'same';
  }
  if(focusedControl)return 'deferred';
  const byId=new Map(oldCards.map(x=>[x.dataset.card,x]));
  newCards.forEach(y=>{const x=byId.get(y.dataset.card);if(x&&stripMarks(x.outerHTML)===y.outerHTML)y.replaceWith(x);});
  live.replaceChildren(...next.childNodes);
  return 'swapped';
}
// The list a render writes into. Normally the live #card-list;
// during an in-place refresh, a detached twin handed to render() here -- so no
// renaming of the live list's id, and no renderer has to guess which of two
// #card-list elements it is decorating (dnd.js used to).
let listTarget=null;
function cardListEl(){ return listTarget||document.getElementById('card-list'); }
// Render into a detached twin of #card-list, then morph it into the live one,
// so unchanged rows keep their nodes, their focus and their scroll position.
function renderInPlace(options){
  const live=$('#card-list');if(!live){render(options);return 'rendered';}
  const twin=live.cloneNode(false);twin.removeAttribute('id');
  listTarget=twin;
  try{render(options);}finally{listTarget=null;}
  return morphCardList(live,twin);
}
// A card created or updated in a column you are not looking at lights its
// tab (Zoom) or column toggle (web) for a moment (UX sync 9/29): "when
// something changes, we need to draw more attention to it". tabNews() lets
// zoomtabs.js and desk.js keep the light across a re-render.
const tabNewsUntil={};
function tabNews(k){return (tabNewsUntil[k]||0)>Date.now();}
function markTabNews(changed){
  if(!changed.size)return;
  const shown=LIVE.api.zoom?[zoomTab()]:deskCols();
  for(const k of deskTypes){
    if(shown.includes(k)||!(deskGroups[k]||[]).some(c=>changed.has(c.id)))continue;
    tabNewsUntil[k]=Date.now()+2800;
    for(const id of ['tab-'+k,'column-'+k]){const b=document.getElementById(id);if(b){DELIGHT.play(b,'has-news');}}
    setTimeout(()=>{for(const id of ['tab-'+k,'column-'+k])document.getElementById(id)?.classList.remove('has-news');},2800);
  }
}
function markArrivals(prev){
  const now=new Map(cards.map(c=>[c.id,cardSig(c)]));
  if(prev) markTabNews(new Set([...now].filter(([id,sig])=>prev.get(id)!==sig).map(([id])=>id)));
  if(prev) $('#card-list')?.querySelectorAll('[data-card]').forEach(a=>{
    const id=a.dataset.card,was=prev.get(id);
    const cls=was===undefined?'is-new':was!==now.get(id)?'is-changed':'';
    if(!cls)return;
    // A new decision lands like a stamp.
    if(cls==='is-new')DELIGHT.play(a.querySelector('.type-icon[data-type=decided]'),'once-seal');
    DELIGHT.mark(a,cls);
  });
  return now;
}
// An open card someone else changed (UX sync 9/29): it stays open and says
// what happened. It is re-drawn with the new state unless a form in it is in
// use, so nothing typed is lost; a card that left the board keeps showing.
function noteOpenCardChange(was){
  const s=state();if(!was||s.card!==was.id)return;
  const now=cardById(was.id);
  if(now&&cardSig(now)===cardSig(was))return;
  if(ownChange(was,now))return;
  const busyForm=$('#reader form')&&($('#reader form').contains(document.activeElement)||[...$('#reader').querySelectorAll('textarea,input')].some(x=>x.value&&x.value!==x.defaultValue));
  if(now&&!busyForm)renderReader();
  const title=$('#detail-title');if(!title)return;
  let n=$('#change-note');
  if(!n){n=document.createElement('p');n.id='change-note';n.className='small change-note';n.setAttribute('role','status');title.after(n);}
  n.textContent=changeNote(was,now)+(now&&busyForm?' Save or cancel to see the latest.':'');
}
let refreshing=false, refreshAgain=false;
// The poll: every 15s, or once a minute in "All weeks", which reads every meeting there is.
// A hidden tab skips it (refresh) and reads once on coming back.
function schedulePoll(){clearTimeout(pollTimer);pollTimer=setTimeout(()=>refresh(false).finally(schedulePoll),LIVE.api.loadedWeek==='all'?60000:15000);}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(false);});
async function refresh(force) {
  if(!snapshot||(!force&&(document.hidden||busy.size))) return;
  if(refreshing){if(force)refreshAgain=true;return;}
  refreshing=true;
  try {
    // Only the read says whether the board is reachable: no answer, or a gateway's 502-504. Anything
    // else (an answer of the server's own, one that is not JSON, a throw after the read) is the feed's alert.
    let next;
    try{next=await LIVE.fetchSnapshot();}catch(e){if(!e||!(e.unreached||[502,503,504].includes(e.status)))throw e;connection(false);return;}
    connection(true);
    const before=seenCards||new Map(cards.map(c=>[c.id,cardSig(c)]));
    // What this viewer was looking at before the poll (desk.js keeps a card
    // someone else moved out of it for a moment, with a note).
    const prevCards=cards,prevState=state(),prevShown=matching(prevState).map(c=>c.id),openWas=prevState.card?cardById(prevState.card):null;
    // The default meeting is recomputed on every refresh, not just a week
    // switch (weeks.js reload): Zoom's panel opens before capture has created
    // the meeting it is in, so the first pick is the previous meeting and must
    // move once the current one appears. A meeting picked in the
    // URL is untouched -- state() only falls back to this default.
    // Elsewhere a meeting that starts does not move the viewer (10/28):
    // the meeting they were reading goes into the URL, and Current meeting
    // (zoomscope.js) clears it.
    snapshot=next;cards=applyHeld([...next.items],true);sources=next.sources;
    const wasDefault=defaultSourceId;
    defaultSourceId=LIVE.defaultSource(sources,BOARD_PREFS.get('open'));
    if(!LIVE.api.zoom&&wasDefault!=='all'&&wasDefault!==defaultSourceId&&sources[defaultSourceId]?.live&&!params.get('source')&&!prevState.when)
      history.replaceState(history.state,'',url({source:wasDefault}));
    paintFeedAlert();
    for(const h of HOOKS.afterPoll) h.fn();
    // The default meeting too: Zoom's late answer moves it with nothing new in the feed.
    const sig=JSON.stringify(cards)+JSON.stringify(sources)+JSON.stringify(next.orders||{})+defaultSourceId;
    if(!force&&sig===lastCardsSig)return;
    const focus=DELIGHT.focusKey(document.activeElement),y=scrollY;
    if(!force&&prevShown.length)trackDepartures(prevCards,prevShown,prevState);
    const how=renderInPlace({keepReader:!force});
    if(!force)noteOpenCardChange(openWas);
    scrollTo(0,y);DELIGHT.refocus(focus);
    if(how==='deferred')return;   // retried on the next tick: the sig is not recorded
    lastCardsSig=sig;seenCards=markArrivals(before);
  } catch { const el=$('#feed-alert');el.textContent='Board unreachable · retrying';el.hidden=false; }
  finally {
    refreshing=false;
    if(refreshAgain){refreshAgain=false;refresh(true);}
  }
}
// A part of the feed that failed to load is said out loud, never shown as an
// empty board: LIVE keeps the last good copy of that part.
function paintFeedAlert() {
  const w=LIVE.api.warnings||[],el=$('#feed-alert');
  el.textContent=w.join(' · ');el.hidden=!w.length;
}
// The header line (#whisper, a status a screen reader hears): a plugin's message (board.toast,
// bwat-api's notify), for the time to read it. While the board is down a message waits for it to be back.
let whisperNext='',offline=false,pillWas=null;
function whisper(text){if(offline)whisperNext=text;else DELIGHT.whisper($('#whisper'),text,$('#brand-meeting:not(:empty)')||$('#meeting-meta:not(:empty)')||$('#page-title'));}
// A dropped connection is a state, not a moment: the lens greys, the cards dim (clicks still
// work) and the Live pill, shown or not, says Reconnecting… with its dot grey (a status: a screen
// reader hears it there, once), until a read works; then the pill is as it was, the lens turns
// once, a waiting message shows, and the board draws again though nothing changed (buttons held
// through the drop come back).
function connection(up){
  if(up===!offline)return;
  offline=!up;lastCardsSig='';const lens=$('.brand .brand-lens'),pill=$('#live-pill'),word=pill?.querySelector('.live-pill-text');
  for(const el of [document.body,$('.app-header'),lens])el?.classList.toggle('offline',offline);
  if(offline){
    if(word){pillWas={hidden:pill.hidden,text:word.textContent,fading:pill.classList.contains('fading'),state:pill.dataset.state};
      pill.dataset.state='offline';pill.hidden=false;pill.classList.add('fading');word.textContent='Reconnecting…';}
    return;}
  if(pillWas){pill.hidden=pillWas.hidden;word.textContent=pillWas.text;pill.classList.toggle('fading',pillWas.fading);
    if(pillWas.state)pill.dataset.state=pillWas.state;else delete pill.dataset.state;pillWas=null;}
  DELIGHT.play(lens,'ring');
  if(whisperNext){const t=whisperNext;whisperNext='';whisper(t);}
}
function showLoadError() {
  loadError=true;$('#workspace').hidden=true;$('#loading').hidden=false;
  // The skeleton rows give way to the error, in the empty state's box.
  $('#loading').className='empty';$('#loading').removeAttribute('aria-busy');
  $('#loading').innerHTML='<h1>Couldn’t load the meeting record.</h1><p>Your local drafts are kept. Reconnect and retry; nothing has been sent.</p><button id="retry-load" class="primary">Retry loading cards</button>';
  $('#retry-load').onclick=()=>{loadError=false;load();};announce('Meeting record unavailable. Retry loading cards.');
}
for(const scope of ['mine','team','unassigned']) $('#scope-'+scope).onclick=()=>holdListHeight()||navigate({scope,card:null,person:null,type:scope==='team'?'all':'do'},{focus:'scope-'+scope,scroll:scrollY});
let searchTimer,searchEntry=false;
$('#search').onfocus=()=>{searchEntry=false;};
$('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{navigate({q:$('#search').value,card:null},{replace:searchEntry,focus:'search',scroll:scrollY});searchEntry=true;announce(`${matching(state()).length} matching cards.`);},180);};
addEventListener('popstate',()=>{render();restore();});
matchMedia('(max-width:700px)').addEventListener('change',()=>{$('#find-disclosure').open=innerWidth>700||!!state().q;});
let scrollTimer;
addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(remember,100);},{passive:true});
addEventListener('beforeunload',()=>remember());
addEventListener('storage',e=>{
  // Another tab changed this card's draft: show its current state.
  if(e.key===PREFIX+key(state().card)) renderReader();
});
document.querySelectorAll('#page-title,#results-title').forEach(el=>el.tabIndex=-1);
if(!history.state?.study)history.replaceState({study:true,scroll:0,focus:''},'',location.href);
if(!storageOK)showStorageWarning();
READER_STACKS.addEventListener('change',()=>{if(snapshot)render();});
load();
