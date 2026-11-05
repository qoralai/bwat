/* The board's feature plugins (bwat-api.js window.bwatBoard.features): what each may add to the
 * desk, all optional. Core names no plugin; a plugin's script says what it adds by registering:
 *
 *   tags(cardIds)              -> Promise<[{card_id, key, text, mark?}]>: a small tag on each card it
 *                                 names (live.js reads them with every snapshot, onto card.tags)
 *   readerRow(card, el, board) fills its row in an opened card's detail panel
 *   meetingSection(meetingId, el, board)
 *                              fills its section at the bottom of one meeting's board (?source=
 *                                 a meeting); asked again only when another meeting is shown
 *   narrow(key)                -> Promise<{label, ids}>: ?narrow=<name>:<key> narrows the board
 *                                 to those card ids, under a bar with the label and × to clear it
 *   pageLabel, page(el, board) its own page (?page=<name>), linked from the sidebar, shown in
 *                                 place of the cards; `page` fills it each time it is opened,
 *                                 and its first h1 (tabindex -1) takes the focus
 *   facets()                   -> Promise<[{key, label, mark?}]>: its items as a group in the filters
 *                                 column (ui/sidebar.js); one picked is ?narrow=<name>:<key>, so
 *                                 a plugin with facets gives narrow too; asked when the column opens
 *   cardData(cardIds)          -> Promise<[{card_id, ...}]>: its own data on each card it names,
 *                                 read with every snapshot onto card.pluginData[<name>], for its
 *                                 other hooks (live.js); drawn nowhere by itself
 *   cardAction(card)           -> {label, busy?, run(card, board)} | {text, href} | null: a button
 *                                 in the card's action row, before Send, that runs once a press
 *                                 (aria-disabled meanwhile, its label `busy`), then is drawn as
 *                                 the plugin gives it; or a link (https only)
 *
 * `board.refresh()` reads the board again, after the plugin changed something a tag shows;
 * `board.toast(text)` says something in the header line, for the time to read it. `start({api, refresh})` gets
 * refresh too, for what a plugin learns after it starts (its own setup, say): bwat-api.js sends
 * bwat:plugin-refresh.
 */
'use strict';
window.addEventListener('bwat:plugin-refresh',()=>refresh(true));
const PLUGIN_BOARD={refresh:()=>refresh(true),toast:(text)=>whisper(String(text)),
  // After a plugin is shown or hidden in Settings: its sections and page are drawn afresh, and
  // the board read again for its tags and narrowing.
  redraw(){for(const [id,k] of [['plugin-sections','meeting'],['plugin-page','page']]){const el=$('#'+id);if(el)delete el.dataset[k];}refresh(true);}};
// The plugin a link asks for (?narrow=<name>:… or ?page=<name>) when this person hid it.
function pluginHidden(name){return name&&!window.bwatBoard.features().some(f=>f.name===name)?window.bwatBoard.installed().find(f=>f.name===name):null;}
function pluginFeatures(slot){return window.bwatBoard.features().filter(f=>typeof f[slot]==='function');}
// A plugin that throws loses only its own part: the board draws on (it always shows).
function pluginCall(f,slot,...args){try{const r=f[slot](...args);if(r&&typeof r.catch==='function')r.catch(()=>{});}catch{/* its part stays empty */}}
// Core's element `id` (and its class), made once and put in place.
function pluginSlot(id,tag,place){let el=$('#'+id);if(!el){el=document.createElement(tag);el.id=id;el.className=id;place(el);}return el;}
// The plugins' card actions, drawn by cardActionsHTML (study.js) before Send. A plugin that
// throws, or gives a link that is not https, adds nothing.
function pluginAction(f,c){try{return f.cardAction(c)||null;}catch{return null;}}
// The actions running now, by "<plugin>:<card id>": a tile drawn again meanwhile shows its
// button busy too, and a press on either starts nothing more. aria-disabled, not disabled, so
// the pressed button keeps the focus.
const pluginRunning=new Set();
function pluginActionsHTML(c){
  return pluginFeatures('cardAction').map(f=>{
    const a=pluginAction(f,c);
    if(!a)return '';
    if(a.href){const url=LIVE.safeHttps(a.href);return url?`<a class="action-button card-action" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(a.text)}</a>`:'';}
    if(typeof a.run!=='function')return '';
    const busy=pluginRunning.has(f.name+':'+c.id);
    return actionButton(`action-${f.name}-${c.id}`,String(busy&&a.busy?a.busy:a.label),{show:true},'card-action',false,` data-plugin-action="${esc(f.name)}" data-plugin-card="${esc(c.id)}"${busy?' aria-disabled="true"':''}`);
  }).join('');
}
// Delegated once, like the Send buttons: a press runs the action the plugin gives the card now.
// A run that never settles leaves its button busy: the plugin bounds its own calls.
document.addEventListener('click',async e=>{
  const b=e.target.closest&&e.target.closest('[data-plugin-action]');
  if(!b)return;
  e.stopPropagation();
  const f=pluginFeatures('cardAction').find(x=>x.name===b.dataset.pluginAction),c=cardById(b.dataset.pluginCard);
  const key=b.dataset.pluginAction+':'+b.dataset.pluginCard;
  const a=f&&c&&!pluginRunning.has(key)?pluginAction(f,c):null;
  if(!a||typeof a.run!=='function')return;
  pluginRunning.add(key);
  b.setAttribute('aria-disabled','true');if(a.busy)b.textContent=String(a.busy);
  try{await a.run(c,PLUGIN_BOARD);}catch{/* the plugin says what went wrong */}
  pluginRunning.delete(key);
  // Its button as drawn now, which a redraw may have replaced, as the plugin gives it now; one
  // that is now a link, or nothing, is drawn again.
  const now=cardById(c.id),cur=now?pluginAction(f,now):null;
  if(!cur||typeof cur.run!=='function'){render({keepReader:true});return;}
  for(const x of document.querySelectorAll('[data-plugin-action]'))
    if(x.dataset.pluginAction===f.name&&x.dataset.pluginCard===c.id){x.removeAttribute('aria-disabled');x.textContent=String(cur.label);}
});
addHook('card','plugins',function(p,c){
  const tags=(c.tags||[]).map(t=>`<span class="plugin-tag" data-plugin="${esc(t.plugin)}">${esc(t.text)}</span>`).join('');
  if(tags)p.badges+=`<span class="plugin-tags">${tags}</span>`;
});
{
  const prior=renderReader;
  renderReader=function(){
    prior();
    const c=cards.find(x=>x.id===state().card),meta=$('#reader .detail-meta');
    if(!c||!meta)return;
    for(const f of pluginFeatures('readerRow').reverse()){
      const row=document.createElement('div');
      row.className='plugin-row';row.dataset.plugin=f.name;
      meta.after(row);
      pluginCall(f,'readerRow',c,row,PLUGIN_BOARD);
    }
  };
}
// The plugins' own pages: a link each above the meetings (so Configure's Meetings tick leaves them;
// one with facets is linked from its group's heading in the filters column instead), and the one asked for (?page=) in
// place of the cards.
addHook('afterRender','plugins',function(){
  const pages=pluginFeatures('page'),listed=pages.filter(f=>typeof f.facets!=='function'),asked=new URLSearchParams(location.search).get('page');
  const links=pluginSlot('plugin-pages','nav',e=>{e.setAttribute('aria-label','Pages');$('.nav-meetings').before(e);});
  links.innerHTML=listed.map(f=>`<a href="${esc(url({page:f.name,card:null}))}" data-plugin-page="${esc(f.name)}" aria-current="${asked===f.name?'page':'false'}">${esc(f.pageLabel)}</a>`).join('');
  // Opened from its link: drawn afresh, and its heading takes the focus.
  links.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();navigate({page:a.dataset.pluginPage,card:null});$('#plugin-page h1')?.focus();});
  const shown=pages.find(f=>f.name===asked);
  const el=pluginSlot('plugin-page','section',e=>$('#workspace').after(e));
  $('#workspace').hidden=!!shown;el.hidden=!shown;
  if(!shown){el.dataset.page='';return;}
  if(el.dataset.page!==shown.name){el.dataset.page=shown.name;pluginCall(shown,'page',el,PLUGIN_BOARD);}
});
// The plugins' sections at the bottom of one meeting's board, after its cards.
addHook('afterRender','plugins',function(){
  const s=state(),meeting=sources[s.source]&&s.source!=='todo-unknown'?s.source:'';
  const box=pluginSlot('plugin-sections','div',e=>$('#list-end').after(e));
  box.hidden=!meeting;
  if(box.dataset.meeting===meeting)return;
  box.dataset.meeting=meeting;box.replaceChildren();
  if(!meeting)return;
  for(const f of pluginFeatures('meetingSection')){
    const el=document.createElement('section');
    el.className='plugin-section';el.dataset.plugin=f.name;
    box.append(el);
    pluginCall(f,'meetingSection',meeting,el,PLUGIN_BOARD);
  }
});
// The board narrowed by a plugin: its label, and × to see every card again. A link to a plugin
// this person hid shows every card, and says so, with a way to show the plugin again.
addHook('afterRender','plugins',function(){
  const n=state().narrow&&LIVE.api.narrow;
  const bar=pluginSlot('plugin-narrow','div',e=>$('#card-list').before(e));
  const off=pluginHidden(state().narrow.split(':')[0]),offPage=!off&&pluginHidden(new URLSearchParams(location.search).get('page'));
  bar.hidden=!n&&!off&&!offPage;
  if(off||offPage){
    const p=off||offPage;
    bar.innerHTML=`<span class="plugin-narrow-label">${esc(p.label)} is hidden on your board, so ${off?`this link’s ${esc(p.label.toLowerCase())} filter is off`:'its page is not shown'}.</span><button type="button" class="text-button">Show ${esc(p.label)}</button>`;
    bar.querySelector('button').onclick=()=>{window.bwatBoard.setHidden(p.name,false);PLUGIN_BOARD.redraw();};
    return;
  }
  if(!n)return;
  bar.innerHTML=`<span class="plugin-narrow-label">${esc(n.label)}</span><button type="button" class="text-button" aria-label="Clear: ${esc(n.label)}">×</button>`;
  bar.querySelector('button').onclick=()=>navigate({narrow:null},{focus:'results-title'});
});
