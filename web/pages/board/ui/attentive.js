/* Meeting-scoped worker activity; card signals only follow saved feed changes. */
'use strict';
window.ATTENTIVE=(()=>{
  const strip=document.createElement('div');
  strip.className='extraction-activity';strip.setAttribute('role','status');strip.setAttribute('aria-live','polite');
  // Standup 2026-09-28: The card writer's activity is churn for someone reading cards, so it
  // sits with the capture diagnostics in the footer rather than above the cards.
  // The footer's afterRender hook runs first and creates #desk-footer.
  // In Zoom, while the meeting is live, it sits beside the Live pill at the top
  // instead (9/29; it was easy to miss in the footer): desk.js makes #meta-status.
  function place(){const top=LIVE.api.zoom&&document.getElementById('meta-status');const home=top||document.getElementById('desk-footer');if(home&&strip.parentElement!==home)top?home.append(strip):home.prepend(strip);}
  // One word beside the Live pill (9/30: "just have one word, listening");
  // the sentence behind it is the tooltip, for whoever wants the detail.
  // Paused is the writer stopped on a model its endpoint no longer has.
  const word={paused:'Paused: model unavailable',backoff:'Paused',checking:'Listening',noticed:'Thinking',collecting:'Listening',extracting:'Thinking',reviewing:'Checking',complete:'Saved',failed:'Retrying',stale:'Idle',unavailable:'Offline'};
  const copy={paused:"The card writer's model is no longer available, so no new cards are written. An admin picks another in Settings.",backoff:'Classifier unavailable. Waiting for the next timed extraction check; meeting evidence is kept.',checking:'Checking the latest speech for intent...',noticed:'Intent noticed. Gathering nearby context...',collecting:'Listening for actionable intent. The timed fallback remains available.',extracting:'Extracting candidates from meeting evidence...',reviewing:'Checking completion evidence. Tasks remain open pending review.',complete:'Extraction pass finished. Saved changes appear when the board refreshes.',failed:'Extraction did not finish. Cards are kept; the worker will retry or report a stalled window.',stale:'Activity signal expired. Current extraction status is unknown.',unavailable:'Live extraction activity is unavailable. Saved cards continue to refresh.'};
  let request=0,activeSource='',pending=null,follow=null,failures=0;
  // One dropped read is not offline; only a run of them is.
  const OFFLINE_AFTER=3;
  // after a pass finishes, refresh at the activity cadence until the
  // loaded feed acknowledges it -- its extraction_seen names exactly this
  // pass -- instead of racing the feed once and then waiting 15s. Only an
  // exact match counts: ids are unordered, so a different id may be an OLDER
  // pass the generator read before this one committed; a pass that
  // a later one supersedes simply runs to the cap. Causal: no clock is compared, so skew
  // between the agent and web containers cannot end it early or late. The
  // 30s cap bounds a feed that never catches up (an older server, a folder
  // the generator cannot see); the 15s poll carries on after it.
  function startFollow(source,id,now){return {source,id,until:now+30000};}
  function acked(f,seen){return !!seen&&seen[f.source]===f.id;}
  function following(f,seen,now){return !!f&&now<f.until&&!acked(f,seen);}
  const completions=new Map();
  // Meetings polled at least once: their first answer is noted silently (a pass already
  // there when the page opened); every completion after that turns the lens's ring.
  const polled=new Set();
  function outcome(a){
    if(!a.result)return copy.complete;
    const r=a.result,parts=[];
    if(r.created)parts.push(r.created===1?'1 card created':`${r.created} cards created`);
    if(r.updated)parts.push(r.updated===1?'1 card updated':`${r.updated} cards updated`);
    let message=parts.length?parts.join('; ')+'. Saved.':'No changes found.';
    if(r.refused)message+=' Some proposed changes could not be verified and were not saved.';
    return message;
  }
  // 10/1: when a pass saves cards, say what: "Created to-do",
  // "Captured 2 decisions", "Updated to-do". From the per-type counts the
  // agent publishes; an older agent without them still says "Saved".
  const KIND={do:['Created','to-do','to-dos'],ask:['Captured','question','questions'],risk:['Captured','risk','risks'],decided:['Captured','decision','decisions']};
  function made(r){
    if(!r)return '';
    const bits=[];
    for(const [b,[verb,one,many]] of Object.entries(KIND)){const n=(r.created_by||{})[b];if(n)bits.push(verb+' '+(n===1?one:n+' '+many));}
    for(const [b,[,one,many]] of Object.entries(KIND)){const n=(r.updated_by||{})[b];if(n)bits.push('Updated '+(n===1?one:n+' '+many));}
    return bits.slice(0,2).join(' · ')+(bits.length>2?' · …':'');
  }
  function source(){const s=state().source;return s==='all'?LIVE.api.capture?.source:s==='none'||s===LIVE.OPEN||s.includes(',')?null:s;}
  function show(phase,detail,text){const w=text||word[phase]||word.unavailable;if(strip.textContent!==w)strip.textContent=w;strip.title=detail||copy[phase]||'';strip.dataset.phase=phase;}
  async function poll(){
    if(document.hidden)return;
    const selected=source();
    if(selected&&pending===selected)return;
    pending=selected;const token=++request;
    if(selected!==activeSource){follow=null;failures=0;show('checking');}
    activeSource=selected;
    if(!selected){strip.textContent='';strip.title='';strip.dataset.phase='none';return;}
    try{
      const a=await LIVE.getJSON('/extraction-activity?source='+encodeURIComponent(selected));
      if(token!==request||source()!==selected)return;
      failures=0;
      const phase=a.expires_at&&a.expires_at*1000<=Date.now()?'stale':a.phase;
      show(phase,(sources[selected]?.label||'Meeting')+': '+(phase==='complete'?outcome(a):(copy[phase]||copy.unavailable))+(a.reason==='gate_error'?' Classifier unavailable; using full extraction.':''),phase==='complete'?made(a.result):'');
      // The file keeps only its latest phase, so the next gate step can
      // overwrite 'complete' between two polls; last_complete survives it.
      const done=a.last_complete||(phase==='complete'?a.event_id:null);
      const seenBefore=polled.has(selected);polled.add(selected);
      if(done&&completions.get(selected)!==done){
        // A pass that saved or updated cards turns the lens's ring once.
        if(seenBefore&&made(a.result))DELIGHT.play(document.querySelector('.brand-lens'),'ring');
        completions.set(selected,done);
        follow=startFollow(selected,done,Date.now());
      }
      // Normal in-place refresh preserves readers, drafts and focus.
      if(following(follow,LIVE.api.extractionSeen,Date.now()))refresh(false);else follow=null;
    }catch{if(token===request&&source()===selected&&++failures>=OFFLINE_AFTER)show('unavailable','Extraction activity disconnected. Saved cards remain available.');}
    finally{if(token===request)pending=null;}
  }
  addHook('afterRender','attentive',()=>{place();return poll();});
  setInterval(poll,2000);
  return {};
})();
