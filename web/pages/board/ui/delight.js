// Small moments on the desk (mock-ups and spec: the planning record, specs/board-delight).
// Each one decorates a change that has already happened: none delays a click or a
// save, each plays once, and under Reduce Motion delight.css shows its end state.
// Nothing here is stored: what has played is remembered for this page load only.
'use strict';
window.DELIGHT=(()=>{
  const reduced=()=>!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  // True the first time a key is asked for, false after: a moment never replays on a re-render.
  const played=new Set();
  const once=key=>!played.has(key)&&!!played.add(key);
  // True when a state turns on. The first sight is noted silently, so nothing plays
  // for what was already so when the page opened.
  const seen=new Map();
  function turned(key,now){const had=seen.has(key),was=seen.get(key);seen.set(key,!!now);return had&&!was&&!!now;}
  // Restarts a CSS animation class.
  function play(el,cls){if(!el)return;el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls);}
  const wait=ms=>new Promise(r=>setTimeout(r,reduced()?0:ms));
  // How long a line on a card, a closed card's row, or the header's whisper holds before it goes
  // (a test shortens them). Held with plain timers, not wait(): Reduce Motion takes the motion
  // away, never the time to read. The whisper holds `whisper`, and `word` more a word, up to
  // `whisperMax`; `fade` is its way out. `hold`, how long a change of yours is held against a feed
  // that has not caught up; `mark`, an arrival's wash.
  const ms={saved:1500,kept:2500,who:4000,slim:8000,whisper:3000,word:300,whisperMax:10000,fade:400,hold:120000,mark:2800};
  const esc=s=>String(s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
  const cardEl=id=>document.querySelector('#card-list [data-card="'+String(id).replace(/["\\]/g,'\\$&')+'"]');
  // A card arrives (is-new) or washes (is-changed) once, in place of the other; the mark goes after it has played.
  function mark(el,cls){if(!el)return;el.classList.remove('is-new','is-changed');play(el,cls);setTimeout(()=>el.classList.remove(cls),ms.mark);}
  // A card leaving the list folds to nothing (0.4 s) so the cards below close the gap; so does
  // a line on a card, or a closed card's row (`el`, under its own `key`). The fold is kept
  // here, not only on the node, so a redraw meanwhile keeps it folded, until the fold has run;
  // then the caller removes it.
  const folding=new Set();
  async function fold(key,el=cardEl(key)){folding.add(key);
    if(el){el.style.maxHeight=el.offsetHeight+'px';void el.offsetWidth;el.style.maxHeight='0px';el.classList.add('folding');}
    await wait(400);folding.delete(key);}
  // Cards you closed that are still inking out (desk.js keeps them drawn, and not lingering).
  const leaving=new Set();
  // A queued hand-off: a copy of the title slides out of the card, and the Queued chip opens.
  function sent(id){const el=cardEl(id),h=el&&el.querySelector('h3');if(!h)return;
    el.querySelector('.badge.queued')?.classList.add('arrive');
    if(reduced())return;
    const g=document.createElement('span');g.className='send-ghost';g.setAttribute('aria-hidden','true');g.textContent=h.textContent;
    h.append(g);setTimeout(()=>g.remove(),700);}

  // Who did something, as a line says it: bwat for the card writer, You for `me`.
  const who=(n,me)=>!n?'Someone':n==='agent'?'bwat':n===me?'You':n;
  const changed=(n,me)=>who(n,me)+' changed this just now';
  // An error is read out at once, once, from the page's one assertive region (#alert): the line
  // that shows it carries no role, so a redraw never reads it again. The same words twice are set
  // apart by a no-break space, so a second failure is read too.
  function alert(text){const el=document.getElementById('alert');if(el)el.textContent=el.textContent===text?text+'\u00a0':text;}

  // A message in the page's header line (#whisper): its header takes `on` for the time to read it,
  // its clock stopped while the pointer or the focus is on it; then it fades and empties. Its
  // whole text is its title too. With no text it stops one under way. It hangs under the header
  // (delight.css 14); with the header scrolled out of view it is `pinned` near the top of the window.
  // It can stand in for a line of the page's own instead (`slot`, when in view; the desk's narrow
  // only, delight.css 14): the line keeps its words, under the message, which takes `whisper-on`
  // with the header's `on`, and room (--whisper-room) up to whatever follows it on its row; the
  // header is `slotted`.
  let whisperT=0,whisperLeft=0,whisperEnd=0,whisperSlot=null;const whisperHeld=new Set();
  function whisperOn(el,on){el.parentNode.classList.toggle('on',on);whisperSlot?.classList.toggle('whisper-on',on);}
  function whisperOut(el){whisperOn(el,false);el.parentNode.classList.remove('slotted');
    if(whisperSlot){delete whisperSlot.dataset.whisper;whisperSlot.removeAttribute('title');whisperSlot.style.removeProperty('--whisper-room');whisperSlot=null;}}
  function whisperRoom(slot){const r=slot.getBoundingClientRect(),gap=parseFloat(getComputedStyle(slot.parentNode).columnGap)||0;
    let n=slot.nextElementSibling;while(n&&!n.getClientRects().length)n=n.nextElementSibling;
    const b=n&&n.getBoundingClientRect();return Math.max(r.width,b&&b.top<r.bottom&&b.left>r.right?b.left-gap-r.left:0);}
  function whisperClock(el){if(whisperHeld.size||!el.parentNode.classList.contains('on'))return;whisperEnd=Date.now()+whisperLeft;
    whisperT=setTimeout(()=>{whisperOn(el,false);whisperT=setTimeout(()=>{el.textContent='';el.removeAttribute('title');whisperOut(el);},ms.fade);},whisperLeft);}
  function whisperHold(el,why,on){if(on===whisperHeld.has(why))return;
    if(!on){whisperHeld.delete(why);whisperClock(el);return;}
    whisperHeld.add(why);if(el.parentNode.classList.contains('on')){clearTimeout(whisperT);whisperLeft=Math.max(0,whisperEnd-Date.now());}}
  const whisperPin=el=>el.classList.toggle('pinned',el.parentNode.getBoundingClientRect().bottom<0);
  function whisper(el,text,slot){clearTimeout(whisperT);
    if(!el.dataset.held){el.dataset.held='1';
      for(const [type,why,on] of [['pointerenter','pointer',true],['pointerleave','pointer',false],['focusin','focus',true],['focusout','focus',false]])
        el.addEventListener(type,()=>whisperHold(el,why,on));
      addEventListener('scroll',()=>whisperPin(el),{passive:true});}
    if(!text){whisperOn(el,false);el.removeAttribute('title');whisperSlot?.removeAttribute('title');return;}
    whisperOut(el);
    const at=slot&&slot.getBoundingClientRect();
    if(at&&at.height&&at.bottom>0&&at.top<innerHeight){whisperSlot=slot;el.parentNode.classList.add('slotted');slot.dataset.whisper=slot.title=text;
      slot.style.setProperty('--whisper-room',whisperRoom(slot)+'px');
      if(!slot.dataset.held){slot.dataset.held='1';for(const on of [true,false])slot.addEventListener(on?'pointerenter':'pointerleave',()=>whisperHold(el,'pointer',on));}}
    whisperOn(el,true);whisperPin(el);
    el.textContent=el.title=text;
    whisperLeft=Math.min(ms.whisperMax,ms.whisper+ms.word*text.trim().split(/\s+/).length);whisperClock(el);}

  // A card you closed, or reopened, goes back between the cards it was drawn between (`place`:
  // id -> {before, after}), however the feed lists it again.
  function placeBack(list,place){
    for(const [id,p] of place){const at=new Map(list.map((c,i)=>[c.id,i])),i=at.get(id);if(i===undefined)continue;
      const k=x=>{const j=at.get(x);return j===undefined?-1:j>i?j-1:j;},b=k(p.before),a=k(p.after);
      list.splice(b>=0?b+1:a>=0?a:i,0,...list.splice(i,1));}
    return list;
  }

  // A closed card's row (study.js), by card id: it holds for ms.slim, its
  // clock stopped while anything holds it (the pointer, the focus, its Undo in flight, an error
  // that stays until fixed); then it folds (`el` finds it) and `drop` lets it go. Held as it
  // folds, it stops folding and opens again, its whole time to come once let go. `remove` lets
  // one go at once, undrawn. `root` takes one set of listeners for the pointer and the focus.
  function rows(root,el,drop){
    const all=new Map();   // id -> {left, end, t, ending, held: Set of why, ...the page's own}
    function clock(id){const x=all.get(id);if(!x||x.t||x.held.size)return;x.end=Date.now()+x.left;x.t=setTimeout(()=>end(id),x.left);}
    function unfold(id,x){x.ending=false;x.left=ms.slim;folding.delete('slim:'+id);const r=el(id);if(r){r.classList.remove('folding');r.style.maxHeight='';}}
    function hold(id,why,on){const x=all.get(id);if(!x)return;
      if(!on){x.held.delete(why);clock(id);return;}
      x.held.add(why);if(x.ending)unfold(id,x);
      if(x.t){clearTimeout(x.t);x.t=null;x.left=Math.max(0,x.end-Date.now());}}
    async function end(id){const x=all.get(id);if(!x)return;x.t=null;x.ending=true;
      await fold('slim:'+id,el(id));
      if(all.get(id)!==x||!x.ending||x.held.size)return;
      remove(id);drop(id);}
    function remove(id){clearTimeout(all.get(id)?.t);all.delete(id);}
    function add(id,fields){all.set(id,{...fields,left:ms.slim,held:new Set()});clock(id);}
    for(const [on,off,why] of [['pointerover','pointerout','pointer'],['focusin','focusout','focus']])for(const [type,held] of [[on,true],[off,false]])
      root.addEventListener(type,e=>{if(!all.size)return;const r=e.target.closest&&e.target.closest('.slim-row');
        if(r&&!r.contains(e.relatedTarget))hold(r.dataset.card,why,held);});
    return {all,add,hold,remove};
  }

  // Lines on what a change is about, by anchor: a card's id, 'col:do' (a column's head),
  // 'reader:<id>', 'slim:<id>' (a closed card's row), 'pill' (beside the Live pill). A line is
  // render state, {kind, text, who, color, retry, stays, busy, home, painted, t}: the desk draws it
  // (study.js noteCard, meeting-bot.js). once-in plays on its first paint only.
  const notes=new Map();
  function note(id,n){clearTimeout(notes.get(id)?.t);notes.set(id,n);if(n.kind==='err')alert(n.text);return n;}
  // The tick on a line that says a change was saved.
  const tick='<path class="ti-g" d="M4.75 8.25 7.1 10.6 11.25 5.75"/>';
  function line(id){const n=notes.get(id);if(!n)return '';const first=!n.painted;n.painted=true;
    const av=n.kind==='who'&&n.who&&n.who!=='agent'?`<span class="card-line-av" aria-hidden="true"${n.color?` style="--owner:${n.color}"`:''}>${esc(n.who[0].toUpperCase())}</span>`:'';
    const again=n.retry?`<button type="button" class="text-button" id="retry-${esc(id)}" data-note-retry="${esc(id)}"${n.busy?' aria-disabled="true"':''}>Try again</button>`:'';
    return `<div class="card-line ${n.kind}${first?' once-in':''}${folding.has('line:'+id)?' folding':''}" data-line="${esc(id)}"${n.home?` data-focus-home="${esc(n.home)}"`:''}>${n.kind==='ok'?`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${tick}</svg>`:''}${av}${esc(n.text)}${again}</div>`;}

  // A redraw keeps the person's focus: what had it is found again by its id (or a person's or a
  // checkbox's value); gone, the card it was on takes it (its first button: the card's open-<id>,
  // or its row's Undo), else its line's home.
  function focusKey(el){
    if(!el||el===document.body)return null;
    return {id:el.id||'',person:el.dataset&&el.dataset.person||'',value:el.type==='checkbox'?el.value:'',
      card:el.closest?.('[data-card]')?.dataset.card||'',home:el.closest?.('[data-focus-home]')?.dataset.focusHome||''};
  }
  function refocus(k){
    const a=document.activeElement;
    if(!k||(a&&a!==document.body))return;
    const q=v=>String(v).replace(/["\\]/g,'\\$&');
    const el=(k.id&&document.getElementById(k.id))||(k.person&&document.querySelector('[data-person="'+q(k.person)+'"]'))||(k.value&&document.querySelector('input[type=checkbox][value="'+q(k.value)+'"]'))
      ||(k.card&&document.querySelector('[data-card="'+q(k.card)+'"] button'))||(k.home&&document.getElementById(k.home));
    if(el)el.focus({preventScroll:true});
  }
  return {once,turned,play,wait,ms,cardEl,mark,fold,folding,leaving,sent,reduced,who,changed,alert,whisper,placeBack,rows,notes,note,line,focusKey,refocus};
})();
