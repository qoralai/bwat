/* bwat in this meeting: the Live pill's words, the line once bwat has left (moment 9), and the
 * one way the board's Settings asks bwat to leave (settings redesign B3, B4; settings.js draws it).
 * Inside Zoom, zoom-invite.js supplies the meeting's status and its leave (use()). On the full
 * board an owner or an admin recalls bwat's claim for the meeting on screen: GET /allocations and
 * POST /recall (bwat-api.js), an admin's routes (a host is proved only by Zoom's own context).
 *
 * current() is null, or {joinedAt} while bwat is in and this viewer may ask it to leave. */
'use strict';
window.MEETING_BOT=(()=>{
  const pill=document.getElementById('live-pill');
  const pillText=t=>{pill.querySelector('.live-pill-text').textContent=t;};
  // The pill says what bwat is doing, and the desk leaves it be; Left and Lost fade its dot.
  function pillState(state,text){if(state==='leaving')unrefused();pill.dataset.state=state;pill.hidden=false;pillText(text);if(state==='left'||state==='lost')pill.classList.add('fading');}
  // A refused leave, said beside the pill in red (the desk's error line, 'pill'), with Try again
  // when asking again could work. It stays until bwat leaves, the meeting on screen changes, or
  // bwat is back in after a Left. A focus on it stays: on the new Try again, refused again, or
  // gone, at home on Settings, where the leave was asked.
  let refusedFor=null;   // the full board's meeting a refused leave was for (settle)
  function refused(text,retry){paintRefused(()=>DELIGHT.note('pill',{kind:'err',text,retry,home:'settings-open'}));}
  function unrefused(){refusedFor=null;if(DELIGHT.notes.has('pill')||document.querySelector('[data-line="pill"]'))paintRefused(()=>DELIGHT.notes.delete('pill'));}
  function paintRefused(change){const k=DELIGHT.focusKey(document.activeElement);change();
    document.querySelector('[data-line="pill"]')?.remove();pill.insertAdjacentHTML('afterend',DELIGHT.line('pill'));DELIGHT.refocus(k);}
  // Back to what bwat is doing in the meeting on screen (paint).
  function pillLive(){delete pill.dataset.state;pill.classList.remove('fading');paint();}
  // The Live pill means bwat is in the meeting: Live while a bot is in the live meeting on screen, a
  // muted "bwat not in meeting" while the meeting is live without one, no pill once it has ended.
  // desk.js says which meeting is on screen and what the board read of it ({id, live, bot}); inside
  // Zoom the panel's own check, fresher, says whether bwat is in (impl.present). While the pill says
  // Leaving…, Left or Lost (data-state) it is pillState's alone. When the meeting on screen ends with
  // the page open, its dot fades, then the pill goes; only for this ending, so opening another ended
  // meeting later does not replay it. Until the desk says, the meeting is the live one the panel is in.
  let shown={id:null,live:true,bot:false};
  function paint(meeting=shown){shown=meeting;if(pill.dataset.state)return;
    if(meeting.id&&DELIGHT.turned('ended:'+meeting.id,!meeting.live)){DELIGHT.play(pill,'quiet');setTimeout(()=>{pill.classList.remove('quiet');if(!pill.dataset.state)pill.hidden=true;},700);}
    if(pill.classList.contains('quiet'))return;
    const checked=impl.present(),here=meeting.live&&(checked===null?meeting.bot:checked);
    pill.hidden=!meeting.live;pill.classList.toggle('absent',meeting.live&&!here);pillText(here?'Live':'bwat not in meeting');}
  // Moment 9: the pill reads Left, its dot fades to grey (delight.css), and one quiet line just
  // before `before` says what was kept (`kept`: the meeting's cards, null when not known).
  let note=null;
  function left(kept,before){
    pillState('left','Left');
    note?.remove();
    note=document.createElement('p');
    note.className='live-left-note';
    note.setAttribute('role','status');
    note.textContent='bwat left at '+new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+'. '
      +(kept===null?'The cards and transcript so far are kept.':kept+(kept===1?' card':' cards')+' and the transcript are kept.');
    before.before(note);
  }
  function unleft(){note?.remove();note=null;unrefused();}

  // The full board: the claim of bwat in the one live meeting on screen, read when Settings opens.
  // from: the meeting this page recalled bwat from, while its pill says Leaving… or Left. The
  // recall ends the claim at once, so the feed stops calling the meeting live then; bwat itself
  // goes on its next heartbeat.
  let claim=null,from=null,hooked=false;
  const hook=()=>{if(!hooked){hooked=true;addHook('afterRender','meeting-bot',settle);}};
  const onScreen=()=>{const id=state().source;return sources[id]&&sources[id].live?id:null;};
  const web={
    async load(){
      claim=null;const id=onScreen();
      if(!id||!LIVE.api.admin||id===from)return;
      const r=await LIVE.getJSON('/allocations').catch(()=>null);
      const uuid=sources[id].uuid;
      claim=uuid?((r&&r.allocations)||[]).find(a=>a.claim_state==='attending'&&a.occurrence_id&&LIVE.canonUuid(a.occurrence_id)===LIVE.canonUuid(uuid))||null:null;
      if(claim)claim.source=id;
    },
    current:()=>claim&&claim.source===onScreen()?{joinedAt:claim.joined_at}:null,
    // Whether bwat is in the meeting: null, as the board's read of the meetings says (desk.js).
    present:()=>null,
    // Settings reopened during the recall reloads (and so clears) claim: Try again asks for the
    // claim that was refused, not whatever claim holds by then.
    async leave(c=claim){
      const r=await LIVE.postJSON('/recall',{id:c.id}).catch(()=>null);
      hook();
      if(!r||!r.ok){refused('Could not ask bwat to leave.',()=>web.leave(c));refusedFor=c.source;return;}
      from=c.source;claim=null;
      pillState('leaving','Leaving…');
    },
  };
  // After each render: a refused leave goes with its meeting; the recalled meeting no longer live
  // is Left, with the line above its cards; another meeting on screen, or bwat invited back into
  // this one, hands the pill back to the desk (and Settings offers leave again).
  function settle(){
    if(refusedFor&&state().source!==refusedFor)unrefused();
    if(!from)return;
    const id=state().source;
    if(id!==from){from=null;unleft();pillLive();return;}
    if(pill.dataset.state==='left'&&sources[id].live){from=null;unleft();pillLive();return;}
    if(pill.dataset.state==='leaving'&&!sources[id].live)left(visibleCards().filter(c=>cardMeetings(c).includes(id)).length,document.querySelector('.cards-pane'));
  }

  let impl=web;
  return {
    load:()=>impl.load(),
    current:()=>impl.current(),
    present:()=>impl.present(),
    leave:()=>impl.leave(),
    // Inside Zoom: zoom-invite.js's status and leave.
    use(next){impl=next;},
    pillState,pillLive,paint,left,unleft,refused,
  };
})();
