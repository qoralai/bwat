/* Meeting desk columns, from an earlier desk prototype. Clarifications stay browser-local. */
'use strict';
const deskNames=labels,deskTypes=Object.keys(labels);
const deskAvailableTypes=()=>deskTypes.filter(k=>state().scope!=='unassigned'||k!=='ask');
// Cards per column for the last desk render (study.js reads it for the tab news).
let deskGroups={};
const priorReader=renderReader,priorRoute=renderRoute,priorRemember=remember,priorRestore=restore;
// Closing the reader restores scroll and the board's horizontal position from
// history state (remember/restore below) -- one mechanism, not a second copy in storage.
const deskSelectedCols=()=>{const raw=new URLSearchParams(location.search).get('cols');const list=raw!==null?raw.split(','):read('desk.columns',['do','ask']);const on=new Set(Array.isArray(list)?list:['do','ask']);return [...deskTypes,'none'].filter(x=>on.has(x));};
// Apply the scope without changing the saved columns: leaving Unassigned restores Questions.
// An explicit 'none' keeps the fallback off when the last visible column was toggled off.
const deskCols=()=>{const selected=deskSelectedCols(),cols=selected.filter(k=>deskAvailableTypes().includes(k));return !cols.length&&state().scope==='unassigned'&&selected.includes('ask')&&!selected.includes('none')?['do']:cols;};
// An answer is an edit to the question's own record on the server
// (POST /clarify appends an "Answered by …" note and closes it); a question is answered
// when its detail carries that note -- for everyone, not just this browser.
// One request id per exact answer (Send's note follows the same rule): a retry
// of the text sent is the same request, never recorded twice (the server answers
// it "Already saved", even at the revision its own save moved on); edited text is
// a new one -- else an edit after a lost reply would come back "Already saved"
// and the edit would be dropped.
function clarifyRid(prev,next){return prev.rid&&prev.sentAnswer===next.answer&&prev.sentTodo===next.todo&&prev.sentTodoOwner===next.todoOwner?prev.rid:uuid();}
function clarifyRequest(c,fields,rid,who,version){const answer=String(fields.answer||'').trim(),todo=String(fields.todo||'').trim();return {question_id:c.id,answer,...(todo?{todo}:{}),...(todo&&fields.todoOwner?{todo_owner:fields.todoOwner}:{}),version,request_id:rid,who};}
remember=function(){priorRemember();history.replaceState({...history.state,boardX:$('#card-list').scrollLeft,readerY:$('#reader').scrollTop},'',location.href)};
restore=function(s=history.state){priorRestore(s);requestAnimationFrame(()=>{$('#card-list').scrollLeft=s?.boardX||0;$('#reader').scrollTop=s?.readerY||0})};
function setCols(next,focus){
 const hidden=deskSelectedCols().filter(k=>deskTypes.includes(k)&&!deskAvailableTypes().includes(k));
 const selected=[...next,...hidden,...(next.length?[]:['none'])];
 write('desk.columns',selected);holdListHeight();navigate({cols:selected.join(','),type:null},{focus,scroll:scrollY,keepReader:true});document.getElementById(focus)?.focus({preventScroll:true})
}
addHook('afterRender','desk',function(options={}){const s=state();const chips=$('#type-chips');chips.hidden=!!LIVE.api.zoom;
 if(!new URLSearchParams(location.search).has('cols'))history.replaceState(history.state,'',url({cols:deskSelectedCols().join(',')||'none'}));
 if(!LIVE.api.zoom)paintMeetingHeading(s);
 const cols=deskCols(),all=matching({...s,type:'all'},true);
 // One pass: each column's cards; a bucket outside deskTypes is grouped too,
 // just never shown. No counts on the chips, headings or Zoom tabs (design
 // sync 9/30, a quieter board; 10/6); a chip's tip alone counts its column (B6).
 deskGroups=Object.fromEntries(deskTypes.map(k=>[k,[]]));for(const c of all)(deskGroups[c.bucket]||(deskGroups[c.bucket]=[])).push(c);
 // The column filters are one chip per type in the toolbar, the same control as Zoom's
 // tabs (D74): a chip turns its column on and off. Zoom has its tabs instead.
 chips.innerHTML=LIVE.api.zoom?'':deskAvailableTypes().map(k=>colToggle(k,cols.includes(k))).join('');
 // No summary line (design sync 9/30): Unassigned and the column toggles
 // already say it. The heading stays for screen readers.
 $('#results-title').textContent='Meeting cards';$('#result-count').textContent='';
 if(!LIVE.api.zoom)paintShowing(s);
 // B2: a search or a person filter that leaves every column empty says so once, naming why.
 const emptied=!LIVE.api.zoom&&cols.length&&(s.q||s.scope!=='team'||s.person)&&cols.every(k=>!deskGroups[k].length);
 cardListEl().className='desk-columns';cardListEl().innerHTML=emptied?filteredEmptyHTML(s):cols.length?cols.map(k=>{const rows=deskGroups[k];return `<section class="desk-column" aria-labelledby="heading-${k}"><header${LIVE.api.zoom?' class="sr-only"':''}><h2 id="heading-${k}">${deskNames[k]}</h2></header>${noteHTML('col:'+k)}${rows.map(c=>cardHTML(c,s)).join('')||emptyColumnHTML(k,s)}</section>`}).join(''):'<div class="empty"><h2>No columns selected.</h2><p>Choose a type above to bring its cards back. No records were removed.</p></div>';
 cardListEl().querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openCard(b.dataset.open));

 $('#list-end').textContent='';
});
// One show/hide chip per column, its type's mark and name, pressed while the column shows;
// a click reads the columns as they are now (one listener, below). Not in Zoom, where the tabs choose.
// B5: the last column on stays on; a click on its chip only says so, in a tip under it.
// B6: the tip counts the column's cards in this view: "Hide To-dos (3)".
const LAST_COLUMN='The last column stays on';
function colToggle(k,on){const last=on&&deskCols().length===1;
  return `<button type="button" id="column-${k}" class="type-chip${tabNews(k)?' has-news':''}" data-col-toggle="${k}" aria-pressed="${on}" aria-label="${deskNames[k]}" title="${last?LAST_COLUMN:(on?'Hide':'Show')+' '+deskNames[k]+' ('+deskGroups[k].length+')'}">${typeMark(k)}<span>${deskNames[k]}</span></button>`;}
addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-col-toggle]');if(!b)return;
  const k=b.dataset.colToggle,cols=deskCols();
  if(cols.length===1&&cols[0]===k){b.dataset.tip=LAST_COLUMN;announce(LAST_COLUMN+'.');setTimeout(()=>delete b.dataset.tip,2000);return;}
  setCols(cols.includes(k)?cols.filter(x=>x!==k):[...cols,k],'column-'+k);});
// In the Zoom panel, an empty column of one meeting under Everything, with no search or person filter: while the
// meeting is live a faint lens draws itself once over "Nothing yet."; after it, nothing came up. Questions all answered
// are hidden there (study.js showAnswered), and the column says where they are. The web board says the scope.
const EMPTY_LENS='<svg class="empty-lens" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false"><circle class="r" cx="12" cy="12" r="9"/><path class="h" d="m18.5 18.5 6 6"/></svg>';
function emptyColumnHTML(k,s){const id=oneMeetingSource(s),ids=[id],m=LIVE.api.zoom&&id&&s.scope==='team'&&!s.q&&!s.person?sources[id]:null;
  if(m&&k==='ask'&&cards.some(c=>answeredQuestion(c)&&inMeetings(c,ids)))return '<div class="column-empty">All answered — they’re on the full board.</div>';
  if(m&&m.live)return '<div class="column-empty listening">'+(DELIGHT.once('empty:'+ids[0]+':'+k)?EMPTY_LENS.replace('empty-lens','empty-lens once-draw'):EMPTY_LENS)+'Nothing yet.</div>';
  if(m)return '<div class="column-empty">Nothing came up.</div>';
  return '<div class="column-empty">'+(s.scope==='mine'&&!viewer?'Sign in to see your to-dos.':'No '+deskNames[k].toLowerCase()+' in this scope.')+'</div>';}
// B2: what narrows the full board, by name: the meetings or window on screen, Mine or
// Unassigned, a person and the search. The left filter rail is not built (not approved).
function viewName(s){const ids=meetingIds(s);
  return s.when?(s.when==='today'?'Today':'This week'):openView(s)?'Open to-dos':ids.length>1?ids.length+' meetings':'';}
// Each filter's name, and what clears it alone. One meeting is the title's alone: no chip repeats it.
function deskFilters(s){return [[viewName(s),{source:'all',when:null,days:null,narrow:null}],[s.scope==='mine'?'Mine':s.scope==='unassigned'?'Unassigned':'',{scope:'team'}],
  [s.person,{person:null}],[s.q?'“'+s.q+'”':'',{q:null}]].filter(([name])=>name);}
const CLEAR_FILTERS={source:'all',when:null,scope:'team',type:'all',person:null,q:null,card:null};
// One line under the title while Mine, Unassigned, a person or a search narrows it: a chip per
// filter, a view of several meetings among them, then Clear filters. The meeting or view alone is
// the title's, so it gets no line. A chip's × clears that filter alone.
function paintShowing(s){const line=$('#showing'),f=deskFilters(s),on=s.scope!=='team'||!!s.person||!!s.q;line.hidden=!on;
  line.innerHTML=on?'Showing: '+f.map(([x],i)=>`<span class="showing-chip"><span class="showing-text">${esc(x)}</span><button type="button" class="showing-x" data-chip="${i}" aria-label="Remove filter: ${esc(x)}"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg></button></span>`).join('')+'<button type="button" class="text-button showing-clear">Clear filters</button>':'';
  line.querySelector('.showing-clear')?.addEventListener('click',()=>navigate(CLEAR_FILTERS,{focus:'page-title'}));
  line.querySelectorAll('.showing-x').forEach(b=>b.addEventListener('click',()=>navigate(f[+b.dataset.chip][1],{focus:'page-title'})));}
// Every column empty under a filter: a heading naming the cause, and the buttons that undo it
// ("in <meeting>" while one meeting is on screen).
function filteredEmptyHTML(s){const ids=meetingIds(s),one=ids.length===1,within=one?' in '+meetingName(ids[0]):'';
  const [h,buttons]=s.q?[`No cards match “${s.q}”${within}.`,[...(one?[['all','Search all meetings']]:[]),['search','Clear search']]]
    :s.scope==='mine'&&!viewer?['Sign in to see your to-dos.',[['team','See everyone’s cards']]]
    :s.scope==='mine'?[`No to-dos of yours${within}.`,[['team','See everyone’s cards']]]
    :s.scope==='unassigned'?[`No unassigned to-dos${within}.`,[['team','See everyone’s cards']]]
    :[`No cards for ${s.person}${within}.`,[['clear','Clear filters']]];
  return `<div class="empty"><h2>${esc(h)}</h2>${buttons.map(([k,label])=>`<button type="button" data-empty="${k}">${label}</button>`).join(' ')}</div>`;}
addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('#card-list [data-empty]');if(!b)return;
  navigate({all:{source:'all',when:null},search:{q:null},team:{scope:'team',type:'all'},clear:CLEAR_FILTERS}[b.dataset.empty],{focus:'page-title'});});
// Each card type's mark, just left of the card's number (10/6): a glyph on a
// small rounded tint of its colour, a check for a to-do, ? and !, and a seal for a
// decision. Colours come from soft.css's --sf-type-* tokens, so one mark serves both
// themes; the column already names the type, so it is hidden from screen readers.
const TYPE_MARKS={
 do:'<path class="ti-g" d="M4.75 8.25 7.1 10.6 11.25 5.75"/>',
 ask:'<path class="ti-g" d="M5.9 6.1a2.15 2.15 0 1 1 3.05 1.95C8.4 8.33 8 8.7 8 9.4"/><circle class="ti-f" cx="8" cy="12.1" r="1.15"/>',
 risk:'<path class="ti-g" d="M8 4v5.25"/><circle class="ti-f" cx="8" cy="12.1" r="1.15"/>',
 decided:'<path class="ti-f" d="m8 2.6 1.35 1.05 1.7-.12.45 1.65 1.45.9-.6 1.6.6 1.6-1.45.9-.45 1.65-1.7-.12L8 12.76l-1.35-1.05-1.7.12-.45-1.65-1.45-.9.6-1.6-.6-1.6 1.45-.9.45-1.65 1.7.12z"/><path class="ti-cut" d="m6.1 7.8 1.35 1.35 2.55-2.7"/>',
};
const typeMark=k=>TYPE_MARKS[k]?`<svg class="type-icon" data-type="${k}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect class="ti-bg" width="16" height="16" rx="4"/>${TYPE_MARKS[k]}</svg>`:'';
// Every card's "⋯" menu and "X is editing" chip (edit, UX sync 9/29), in both views.
addHook('card','desk',(p,c,s)=>{
 // The type mark leads the title line (make room); the meta line under it keeps the ID.
 p.titleIcon=typeMark(c.bucket);if(DELIGHT.leaving.has(c.id)){p.classes.push('inking');p.actions=null;}if(DELIGHT.folding.has(c.id))p.classes.push('folding');p.more=moreHTML(c);const lg=lingerNote(c.id);if(lg){p.classes.push('lingering');p.style=(p.style?p.style+';':'')+'--linger-left:'+Math.max(0,lingering.get(c.id).until-Date.now())+'ms';p.chips.unshift(`<span class="badge lingering" title="${esc(lingering.get(c.id).note)}">${esc(lg)}</span>`);if(lingering.get(c.id).gone){p.actions=null;p.more='';}}if(oneMeeting(s))p.source='';const ed=editingText(c.id);if(ed)p.chips.push(`<span class="badge editing">✎ ${esc(ed)}</span>`);if(c.bucket==='ask'&&!answeredQuestion(c))p.answer={open:false,label:'Answer'};if(c.bucket!=='do'&&p.actions)p.actions.send=null;
 // Make room: a question nobody answered (typed, or by another card) or an unowned to-do needs whoever reads it (study.js
 // keeps such a card's footer open), and the owner rides on the title line. An unowned to-do asks once, with Take it
 // alone, which the Zoom panel puts on its title row (take-row).
 const owner=cardOwner(c),oc=ownerColor(owner);if(!c.closed&&((c.bucket==='ask'&&!answeredQuestion(c))||(c.bucket==='do'&&!owner)))p.needs=true;
 if(p.actions&&p.actions.take)p.classes.push('take-row');
 if(owner)p.ownerMark=`<span class="card-owner avatar${oc?' colored':''}" aria-hidden="true">${esc(owner[0].toUpperCase())}</span>`;});
// The reader's first quote (bwat-api.js `quote`): its speaker, then the words on a neutral highlight.
renderReader=function(){priorReader();if(!state().card)return;const evidence=$('#reader .evidence'),q=(cardById(state().card)||{}).quote;if(evidence){const who=q?q.speaker:'',plain=q?'“'+q.text+'”':'Original meeting evidence',wrap=document.createElement('div');wrap.className='quote-preview';wrap.innerHTML='<span class="eyebrow">MEETING CONTEXT</span><p>'+(who?'<b class="quote-speaker">'+esc(who)+'</b> ':'')+'<span class="quote-hl'+(DELIGHT.once('quote:'+state().card)?' sweep':'')+'">'+esc(plain.slice(0,180))+(plain.length>180?'…':'')+'</span></p><details><summary>Read full evidence</summary>'+evidence.outerHTML+'</details>';evidence.replaceWith(wrap)}};
// An answered question (in words, or by a card linked as its answer) has its answer: no form to write another.
const deskRoute=function(c,d){const area=$('#route-area');if(answeredQuestion(c)){area.innerHTML='';return}if(c.bucket!=='ask'){area.innerHTML='<div class="context-note"><h3>Context for the next action</h3><p>Keep this record available while the group checks decisions and risks. This record is not automatically treated as an actionable task.</p></div>';return}
 const dkey='desk.clarify.'+c.id,pending=read(dkey,null)||{answer:'',todo:'',todoOwner:'',rid:''};
 area.innerHTML=`<form id="clarify-form" class="route-form"><span class="eyebrow">ANSWER</span><h3>What did the group agree?</h3><label class="field-label" for="clarify-answer">Answer</label><textarea id="clarify-answer" required maxlength="2000">${esc(pending.answer)}</textarea><label class="field-label" for="clarify-title">Create to-do (optional)</label><input id="clarify-title" maxlength="500" value="${esc(pending.todo||'')}"><p class="small" id="clarify-owner-row"${pending.todo?'':' hidden'}>To-do owner: <b id="clarify-owner">${esc(pending.todoOwner||'Unassigned')}</b> <button type="button" class="text-button" id="clarify-owner-pick">Change owner</button></p><p id="clarify-status" class="draft-status" role="status">${viewer?'Everyone on the board will see it.':'Sign in first.'}</p><button class="primary" id="clarify-save" ${viewer?'':'disabled'}>Save and close answer</button></form>`;
 let todoOwner=pending.todoOwner||'';
 const fields=()=>({answer:$('#clarify-answer').value,todo:$('#clarify-title').value,todoOwner}),keep=()=>write(dkey,{...read(dkey,{rid:''}),...fields()});
 // The to-do's owner, picked from Change owner's list; unassigned unless someone is picked.
 $('#clarify-title').addEventListener('input',()=>{$('#clarify-owner-row').hidden=!$('#clarify-title').value.trim();});
 $('#clarify-owner-pick').onclick=()=>{const dlg=pickDialog('owner-dialog','To-do owner');$('#owner-dialog-who').textContent='Owner of the new to-do.';
  $('#owner-dialog-list').innerHTML=peopleListHTML({},todoOwner);
  $('#owner-dialog-list').onclick=e=>{const b=e.target.closest&&e.target.closest('[data-person]');if(!b||b.disabled)return;
   todoOwner=b.dataset.person;$('#clarify-owner').textContent=b.dataset.name;keep();dlg.close();};
  showPickDialog(dlg);};
 // The typed text and its request id are kept until the save succeeds, so a
 // retry after a dropped connection is the same request (never a second answer).
 $('#clarify-form').oninput=keep;
 $('#clarify-form').onsubmit=async e=>{e.preventDefault();const next=fields(),status=m=>{$('#clarify-status').textContent=m;},btn=$('#clarify-save');
  if(!viewer){status('Sign in first.');return}if(!next.answer.trim()){status('Add the answer before saving.');return}
  const rid=clarifyRid(read(dkey,{rid:''}),next);write(dkey,{...next,rid,sentAnswer:next.answer,sentTodo:next.todo,sentTodoOwner:next.todoOwner});btn.disabled=true;status('Saving…');
  // Saved and closed (the save closes the question): the reader closes and the card leaves its row,
  // as after Done, with no Undo (an answer is not taken back).
  let r;try{r=await LIVE.postJSON('/clarify',clarifyRequest(c,next,rid,viewer,(cardById(c.id)||c).version));}catch{btn.disabled=false;status('The connection dropped. Save again — it won’t be recorded twice.');return}
  if(r.ok){write(dkey,null);await closeToRow(c,'Answered',null,r.body&&r.body.repeated?'Already saved.':'Answer saved and question closed.');refresh(true);return}
  if(r.body&&r.body.stale){status('Someone else changed this card — reloading.');refresh(true);return}
  btn.disabled=false;status(errText(r));};
};
// a question or risk sent to Claude shows its receipt (sending,
// sent, outcome unknown, failed) above the note or the answer form, which
// stay usable -- the send is not the card's only action.
const SENT_STATES=['sending','unknown','accepted','failed'];
renderRoute=function(c,d){if(c.bucket==='do'){priorRoute(c,d);return}deskRoute(c,d);
 if(d&&SENT_STATES.includes(d.status)){const box=document.createElement('div');box.id='route-send';$('#route-area').prepend(box);priorRoute(c,d,box);}};
addEventListener('keydown',e=>{if(e.key==='Escape'&&state().card){e.preventDefault();closeReader()}});
addEventListener('beforeunload',e=>{if(!storageOK&&$('#clarify-answer')?.value){e.preventDefault();e.returnValue=''}});
if(snapshot)render();
// The heading names the meeting you are looking at and when it started, on one line, with its ⋯
// beside it; the strip under it says what is on screen when that is not one meeting.
// Text only through textContent; links only https.
function meetingIds(s){return s.source==='all'||s.source==='none'||openView(s)?[]:s.source.split(',').filter(Boolean);}
function paintMeetingHeading(s){const title=$('#page-title'),ids=meetingIds(s),m=sources[oneMeetingSource(s)];
  title.textContent='';$('#meeting-more').hidden=!m;
  // A time window is named by its window, however many meetings it holds.
  if(s.when){title.textContent=s.when==='today'?'Today':'This week';return;}
  if(openView(s)){title.textContent='Open to-dos';return;}
  if(!ids.length){title.textContent='All meetings';return;}
  if(ids.length>1){title.textContent=ids.length+' meetings';return;}
  const date=m?displayTime(m,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})||m.date||'':'';title.textContent=meetingName(ids[0])+(date?' · '+date:'');
}
// Zoom's header names the meeting on screen. Until bwat knows which meeting the
// panel is in, it says Loading…, never the meeting the board fell back to; one picked in the link is known.
// A meeting Zoom named that the board does not have leaves it blank: the invite box says why.
function paintZoomTitle(s=state()){const named=$('#brand-meeting');if(!named)return;
  const ids=meetingIds(s),m=ids.length===1?sources[ids[0]]:null,picked=!!(new URLSearchParams(location.search).get('source')||s.when);
  const unknown=LIVE.api.zoomAnswered&&!!LIVE.api.meeting&&!LIVE.sourceForMeeting(LIVE.api.meeting);
  named.textContent=!LIVE.api.zoom||unknown&&!picked?'':!picked&&!LIVE.meetingSettled(sources,s.source)?'Loading…':m?meetingName(ids[0]):'';}
// The one meeting on screen, or null. Its cards needn't repeat its date and name.
function oneMeetingSource(s){const ids=meetingIds(s);return ids.length===1?ids[0]:null;}
function oneMeeting(s){return !!oneMeetingSource(s);}
function paintMeetingInfo(s){const host=$('#meeting-meta');if(!host)return;host.textContent='';
  // Zoom: one short line (you are in the meeting -- no room link, no host,
  // no attendee count; the picker above already names the meetings).
  const inZoom=!!LIVE.api.zoom;
  const ids=meetingIds(s),m=sources[oneMeetingSource(s)],bits=[];
  // An empty window ('none') holds no cards; otherwise no picked meeting means every card.
  const n=s.source==='none'?0:openView(s)?visibleCards().filter(c=>inOpenScope(c,{...s,scope:'team'})).length
    :ids.length?visibleCards().filter(c=>ids.includes(c.from)).length:visibleCards().length;
  // Settings redesign A2: a Live pill on both surfaces, status only (meeting-bot.js paints it).
  MEETING_BOT.paint({id:m?ids[0]:null,live:!!(m&&m.live),bot:!!(m&&m.bot)});
  paintZoomTitle(s);
  // Your initial over the name picker, which Zoom shows as a small avatar (soft.css).
  const initial=$('#viewer-initial');if(initial)initial.textContent=viewer?String(viewer)[0].toUpperCase():'';
  // Zoom, live: the card writer's one word on its own line under the lens (attentive.js
  // moves it into #meta-status), not the time and card count.
  if(inZoom&&m&&m.live){const status=document.createElement('span');status.id='meta-status';host.append(status);return;}
  // One meeting on the full board: its title says when, and its ⋯ holds the rest (openMeetingMenu).
  if(m){if(!inZoom)return;const t=displayTime(m);if(t)bits.push(t);
    if(m.duration_min)bits.push(m.duration_min+' min');
  }
  else if(!inZoom&&ids.length>1)bits.push(ids.map(meetingName).join(', '));
  // 9/30: no people, host, card count or "capturing now" -- the lens's Live dot
  // and the column counts already say so.
  if(!m)bits.push(n+(n===1?' card':' cards'));
  bits.forEach((b,i)=>{if(i)host.append(' · ');host.append(String(b));});}
// The meeting's ⋯ beside its title: its transcript as a .txt download (UX sync 9/29: "an easy
// button that I click at the end of the meeting"; same-origin, so a plain link), then a switched-on
// plugin's links for the meeting (ui/plugin-links.js).
function openMeetingMenu(btn){const id=oneMeetingSource(state());if(!id)return;
  const item=(href,label,attrs='')=>`<a role="menuitem" href="${esc(href)}"${attrs}>${esc(label)}</a>`;
  openMenu(btn,item('transcript?source='+encodeURIComponent(id),'Download transcript',' id="download-transcript" download')
    +(window.bwatPluginLinks||[]).filter(l=>l.slot==='meeting').map(l=>item(l.href.replace('{meeting_id}',encodeURIComponent(id)),l.label,' data-plugin-link="meeting"')).join(''))
    .addEventListener('click',e=>{if(e.target.closest('a'))closeMoreMenu();});}

// Newest first (9/29): a new card shows at the top of its column, not
// the bottom. Cards carry no creation time, so newest is the latest meeting
// (`at`), then the latest transcript frame in it (the first seq of `src`);
// to-dos, which have neither, keep their order after the meeting cards.
// The feed's order breaks ties. Lifecycle then sinks done cards, and a
// dragged order (dnd.js) still wins -- unseen cards go above it.
function newestKey(c){const m=sources[c.from],at=String((m&&m.at)||''),seq=c.seq!=null?c.seq:+((/seq (\d+)/.exec(c.src||'')||[])[1]||0);return [at,seq];}
function newestFirst(list){return list.map((c,i)=>[c,newestKey(c),i]).sort((a,b)=>b[1][0].localeCompare(a[1][0])||b[1][1]-a[1][1]||a[2]-b[2]).map(p=>p[0]);}
// In the Zoom panel nobody's to-do comes first, for whoever in the room takes it (it has no Unassigned).
const unowned=c=>c.bucket==='do'&&!cardOwner(c);
addHook('sort','desk',(list,s)=>{const l=newestFirst(withLingering(list,s));return LIVE.api.zoom?[...l.filter(unowned),...l.filter(c=>!unowned(c))]:l;});

// ── A card someone else moved out of your view stays for a moment ──
// UX sync 9/29: someone was reading a card under Unassigned when another person assigned
// it, and it vanished. Now a card another person's change takes out of the
// list you are looking at stays where it was for LINGER_MS, with a note of
// what happened ("Jonah assigned this to Priya"), as a shared doc does,
// then leaves. Your own changes move at once, as before (they are yours).
const LINGER_MS=20000, lingering=new Map();   // id -> {card, note, view, until, gone}
function lingerView(s){return JSON.stringify([s.source,s.scope,s.person,s.q]);}
function lingerNote(id){const l=lingering.get(id);return l&&l.until>Date.now()?l.chip:'';}
const whoDid=n=>DELIGHT.who(n,viewer);
function changeNote(was,now){
  if(!now)return 'This card was closed.';
  if(!was.superseded_by&&now.superseded_by)return now.merged_into?`Merged into ${bwatLabel(now.merged_into)} as a duplicate.`:`Replaced by ${bwatLabel(now.superseded_by)}.`;
  if((was.owner||'')!==(now.owner||'')){const by=whoDid(now.ownerBy);
    if(!now.owner)return `${by} unassigned this.`;
    if(now.ownerBy===now.owner)return `${by} took this.`;
    return `${by} assigned this to ${now.owner===viewer?'you':now.owner}.`;}
  if(!was.done&&now.done)return 'This was marked done.';
  if(!was.noResponse&&now.noResponse)return 'This closed with no response.';
  if(!was.withdrawn&&now.withdrawn)return 'bwat closed this draft.';
  if(was.title!==now.title)return 'The title changed.';
  return 'This card changed.';
}
// The card's chip says the same in a word or a name (9/30: "Jonah with a
// check mark"); changeNote's sentence is its tooltip and the open card's note.
function changeChip(was,now){
  if(!now)return 'Closed';
  if(!was.superseded_by&&now.superseded_by)return now.merged_into?'Merged':'Replaced';
  if((was.owner||'')!==(now.owner||''))return now.owner?(now.owner===viewer?'You':now.owner)+' ✓':'Unassigned';
  if(!was.done&&now.done)return 'Done';
  if(!was.noResponse&&now.noResponse)return 'No response';
  if(!was.withdrawn&&now.withdrawn)return 'Closed by bwat';
  if(was.title!==now.title)return 'Edited';
  return 'Changed';
}
// Your own change, which moves at once: an owner you set, or a card you closed.
function ownChange(was,now){return DELIGHT.leaving.has(was.id)||(now?(now.ownerBy&&now.ownerBy===viewer&&(was.owner||'')!==(now.owner||'')):!!HELD.gone[was.id]);}
// Called by refresh() with the cards and the list as they were before the poll.
function trackDepartures(prevCards,prevShown,s){
  const was=new Map(prevCards.map(c=>[c.id,c])),now=new Map(cards.map(c=>[c.id,c]));
  const shown=new Set(matching(s).map(c=>c.id)),view=lingerView(s);
  for(const id of prevShown){
    if(shown.has(id)||lingering.has(id))continue;
    const a=was.get(id),b=now.get(id);
    if(!a||ownChange(a,b))continue;
    lingering.set(id,{card:b||a,note:changeNote(a,b),chip:changeChip(a,b),view,until:Date.now()+LINGER_MS,gone:!b});
    setTimeout(async()=>{await DELIGHT.fold(id);lingering.delete(id);cardsChanged();render({keepReader:true});},LINGER_MS);
  }
  cardsChanged();
}
function withLingering(list,s){
  if(!lingering.size)return list;
  const view=lingerView(s),have=new Set(list.map(c=>c.id)),add=[];
  for(const [id,l] of lingering)if(l.view===view&&l.until>Date.now()&&!have.has(id))add.push(l.gone?l.card:(cardById(id)||l.card));
  return add.length?list.concat(add):list;
}
