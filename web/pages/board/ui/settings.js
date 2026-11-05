/* Board settings: this viewer's own board preferences, kept in the
 * browser through study.js read()/write(). The company's settings belong to the
 * admin panel, so the drawer only links there and never writes them. */
'use strict';
window.BOARD_PREFS=(()=>{
  // Each preference: its stored key, its default and the values it accepts; a switch's
  // values are its On value, then its Off.
  const PREFS={
    open:{key:'settings.open',fallback:'live',values:['live','all']},
    // superseded and merged cards are hidden unless this viewer shows them.
    superseded:{key:'settings.superseded',fallback:'hide',values:['show','hide']},
    // Answered questions stay on the board, as they did on the prototype's,
    // unless this viewer hides them.
    answered:{key:'settings.answered',fallback:'show',values:['show','hide']},
    // The Zoom panel's Risks and Decisions tabs are off unless this viewer turns them on.
    risk:{key:'settings.zoom.risk',fallback:'off',values:['on','off']},
    decided:{key:'settings.zoom.decided',fallback:'off',values:['on','off']}
  };
  // bwat's admin panel, on this same server (D169). Only an owner or an admin sees its
  // Company settings link (settings redesign A3).
  const ADMIN_URL='/admin/';
  // A stored value this build no longer offers reads as the default.
  function get(name){const p=PREFS[name];const v=read(p.key,p.fallback);return p.values.includes(v)?v:p.fallback;}
  function set(name,value){const p=PREFS[name];if(!p.values.includes(value))return false;write(p.key,value);return true;}

  // Design pass (10/1): every choice is a button in a segmented
  // control, labelled in a word or two; the tip (hover, or keyboard focus) says
  // what it means, and screen readers read it as the button's description.
  const THEMES=[['system','Device','Follow your device’s light or dark setting'],['light','Light',''],['dark','Dark','']];
  const seg=(name,rows,current)=>`<div class="settings-seg">${rows.map(([v,label,tip])=>
    `<label class="settings-opt"${tip?` data-tip="${esc(tip)}"`:''}><input type="radio" name="${name}" id="setting-${name}-${v}" value="${v}"${v===current?' checked':''}${tip?` aria-describedby="setting-${name}-${v}-tip"`:''}><span class="settings-btn">${label}</span>${tip?`<span class="sr-only" id="setting-${name}-${v}-tip">${esc(tip)}</span>`:''}</label>`).join('')}</div>`;
  // A two-way (or Appearance's three-way) choice, its name on the left.
  const row=(name,title,control)=>`<div class="settings-row" role="group" aria-labelledby="setting-${name}-title"><span class="settings-label" id="setting-${name}-title">${title}</span>${control}</div>`;
  // Settings redesign A1: every on/off preference is a switch, on at its first value.
  const toggle=(name,title,help)=>`<div class="settings-row"><span class="settings-label">${title}${help?`<small class="settings-help">${help}</small>`:''}</span>`
    +`<span class="settings-switch"><input type="checkbox" role="switch" id="setting-${name}" name="${name}" aria-label="${title}"${get(name)===PREFS[name].values[0]?' checked':''}><i aria-hidden="true"></i></span></div>`;
  const group=title=>`<h3 class="settings-group">${title}</h3>`;
  // Settings redesign B3/B4 (owner, 10/21): "This meeting", last in the drawer for a host or an
  // admin while bwat is in the meeting: one row whose Remove bwat asks it to leave, with a
  // confirm step below. MEETING_BOT (meeting-bot.js) knows whether, and sends it, inside Zoom
  // and on the full board alike.
  const meetingHTML=bot=>`${group('This meeting')}<div class="settings-row settings-meeting">
      <span class="settings-label settings-meeting-line"><span class="live-pill-dot" aria-hidden="true"></span>bwat is listening${bot.joinedAt?`<small class="settings-help">Since ${esc(new Date(bot.joinedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))}</small>`:''}</span>
      <span data-leave-first><button type="button" class="settings-leave" data-ask-leave>Remove bwat</button></span>
    </div>
    <div class="settings-row settings-meeting-confirm" data-leave-confirmation hidden><span class="settings-help">Transcription stops. Cards stay.</span><button type="button" class="settings-leave" data-confirm-leave>Remove bwat</button><button type="button" class="settings-cancel" data-cancel-leave>Cancel</button></div>`;
  // Account mock-up M1: Send bwat to a meeting, on the full board only (inside Zoom the invite
  // box does it). Any signed-in person may send (POST /allocations, bwat-api.js). The words are
  // the admin's, copied from web/admin/src/Meetings.tsx (INVALID_LINK, sendError, SendForm and
  // its list's "Couldn't join"), so the two say one thing.
  const INVALID_LINK="That doesn't look like a Zoom meeting link. Paste the full join URL (https://zoom.us/j/…).";
  const SEND_ERRORS={not_a_zoom_meeting_link:INVALID_LINK,invalid_body:INVALID_LINK,not_onboarded:'bwat is not set up yet: the owner finishes onboarding first.'};
  const SENT_LINES={pending:n=>`Sending bwat to meeting ${n}`,claimed:n=>`bwat is joining meeting ${n}…`,attending:n=>`bwat is in meeting ${n} and listening.`,
    refused:n=>`Couldn't join meeting ${n}`,released:n=>`Meeting ${n} ended`};
  // The claim is read again while Settings is open, bwat in the meeting included, until it is
  // refused or has ended, so the line stays true after bwat leaves.
  const FOLLOWING=new Set(['sent','pending','claimed','attending']),FOLLOW_MS=2500;
  // The last send ({id, number, state, line}), kept while the drawer is closed and reopened.
  let sent=null,sending=false,followTimer=0,followRun=0;
  const sendHTML=()=>`${group('Send bwat to a meeting')}<div class="settings-send" data-send>
      <label class="settings-send-label" for="settings-send-link">Zoom meeting link</label>
      <div class="settings-send-row"><input id="settings-send-link" type="text" autocomplete="off" placeholder="https://zoom.us/j/1234567890?pwd=…"><button type="button" class="settings-send-go" data-send-bwat disabled>Send bwat</button></div>
      <p class="settings-send-error" role="alert" hidden></p>
      <p class="settings-send-status" role="status"></p>
    </div>`;
  // joined: bwat has just come in, so its dot pulses once (not again on reopening Settings).
  function showSent(dlg,joined){
    const el=dlg.querySelector('.settings-send-status');if(!el)return;
    el.classList.toggle('joined',!!joined);
    if(!sent){el.textContent='';delete el.dataset.state;return;}
    el.dataset.state=sent.state;
    el.innerHTML=`<span class="settings-send-dot" aria-hidden="true"></span>${esc(sent.line)}`;
  }
  // ms: when to read next; 0 on opening Settings, so its line is right at once.
  function follow(dlg,ms=FOLLOW_MS){
    clearTimeout(followTimer);const run=++followRun;
    if(!sent||!FOLLOWING.has(sent.state))return;
    followTimer=setTimeout(async()=>{
      const r=await LIVE.getJSON('/allocations').catch(()=>null);
      if(run!==followRun)return;
      const a=((r&&r.allocations)||[]).find(x=>x.id===sent.id);
      if(a&&a.claim_state!==sent.state&&SENT_LINES[a.claim_state]){
        sent.state=a.claim_state;sent.line=SENT_LINES[a.claim_state](sent.number);showSent(dlg,sent.state==='attending');
      }
      follow(dlg);
    },ms);
  }
  async function sendBwat(dlg){
    const link=dlg.querySelector('#settings-send-link').value.trim();if(!link||sending)return;
    sending=true;dlg.querySelector('[data-send-bwat]').disabled=true;dlg.querySelector('.settings-send-error').hidden=true;sent=null;showSent(dlg,false);follow(dlg);
    const r=await LIVE.postJSON('/allocations',{zoom_url:link}).catch(()=>null);
    sending=false;
    // Settings may have closed, or closed and reopened (a new drawer), while the send was answered.
    const now=dlg.querySelector('#settings-send-link');
    if(r&&r.ok){
      // As the admin's: the field clears once bwat is sent, or already on its way.
      now.value='';
      const b=r.body,already=b.status==='already_claimed';
      sent={id:b.id,number:b.meeting_number,state:already?b.claim_state:'sent',
        line:already?`bwat is already on its way to or in meeting ${b.meeting_number}`:`Sending bwat to meeting ${b.meeting_number}`};
      // Followed only while Settings is open; reopening it follows the claim again.
      showSent(dlg,false);if(dlg.open)follow(dlg);
    }else{
      // The admin's other failures say "Check the list below", and the drawer has no list.
      const e=dlg.querySelector('.settings-send-error');
      e.textContent=SEND_ERRORS[r&&r.body&&r.body.error]||'Something went wrong. Try sending again.';e.hidden=false;
    }
    dlg.querySelector('[data-send-bwat]').disabled=!now.value.trim();
  }
  // Each feature plugin the company has on, shown or hidden on this person's own board; none on,
  // no group. Hiding draws nothing of it here and changes nothing for anyone else. Not inside
  // Zoom: the switches live on the full board only.
  function pluginsHTML(){
    const all=window.bwatBoard.installed();if(!all.length)return '';
    const hid=new Set(all.map(p=>p.name).filter(n=>!window.bwatBoard.features().some(f=>f.name===n)));
    return `<h3 class="settings-group" id="settings-plugins">Plugins</h3>${all.map(p=>`<div class="settings-row"><span class="settings-label">${esc(p.label)}</span>`
      +`<span class="settings-switch"><input type="checkbox" role="switch" id="setting-plugin-${esc(p.name)}" data-plugin-switch="${esc(p.name)}" aria-label="Show ${esc(p.label)}"${hid.has(p.name)?'':' checked'}><i aria-hidden="true"></i></span></div>`).join('')}
      <p class="settings-help">Only on your board. It stays on for everyone else.</p>`;
  }
  function drawerHTML(){
    return `<form method="dialog" class="settings-form">
      <div class="settings-head"><h2 id="settings-title">Settings</h2><button class="settings-close" value="close" aria-label="Close settings" title="Close">×</button></div>
      ${LIVE.api.zoom?'':sendHTML()}
      ${group('Your board')}
      ${row('theme','Appearance',seg('theme',THEMES,window.BWAT_THEME?BWAT_THEME.choice():'system'))}
      ${LIVE.api.zoom?'':row('open','Opens on',seg('open',[['live','Current or last meeting','The meeting bwat is capturing now, or else the most recent one'],['all','All','Every meeting from the last two weeks']],get('open')))}
      ${group('Show')}
      ${LIVE.api.zoom?toggle('risk','Risks tab')+toggle('decided','Decisions tab'):''}
      ${LIVE.api.zoom?'':toggle('answered','Answered questions','With their answer')}
      ${toggle('superseded','Replaced cards','Marked with what replaced them')}
      ${LIVE.api.zoom?'':pluginsHTML()}
      <div id="settings-meeting"></div>
      ${LIVE.api.admin?`<a class="settings-company" href="${ADMIN_URL}" target="_blank" rel="noopener"><span class="settings-label">Company settings<small class="settings-help">Meeting bot, cards, data and connections</small></span><span aria-hidden="true">↗</span></a>`:''}
      <p class="settings-foot"><span>Saved in this browser</span><span class="settings-version">bwat ${esc(typeof footerVersion==='string'&&footerVersion||'dev')}</span></p>
    </form>`;
  }
  // open('plugins') opens the drawer at its plugin switches, for the filters column's Configure.
  function open(at){
    let dlg=document.getElementById('settings-dialog');
    if(!dlg){dlg=document.createElement('dialog');dlg.id='settings-dialog';dlg.className='send-dialog settings-dialog';dlg.setAttribute('aria-labelledby','settings-title');document.body.append(dlg);}
    dlg.innerHTML=drawerHTML();
    MEETING_BOT.load().then(()=>{const bot=MEETING_BOT.current(),host=dlg.querySelector('#settings-meeting');if(bot&&host)host.innerHTML=meetingHTML(bot);});
    if(!LIVE.api.zoom){showSent(dlg,false);follow(dlg,0);}
    // Enter sends: the drawer is a method="dialog" form, whose own submit would close it.
    dlg.onkeydown=(e)=>{if(e.key==='Enter'&&e.target.id==='settings-send-link'){e.preventDefault();void sendBwat(dlg);}};
    dlg.oninput=(e)=>{if(e.target.id==='settings-send-link')dlg.querySelector('[data-send-bwat]').disabled=sending||!e.target.value.trim();};
    // Zoom's own browser does not follow a new-tab link, so there Company settings opens through
    // Zoom (bwat-api.js), at the link's absolute address; on the web it stays a plain link.
    dlg.onclick=(e)=>{const company=LIVE.api.zoom&&e.target.closest&&e.target.closest('a.settings-company');
      if(company){e.preventDefault();bwatHelpers.openInBrowser(company.href);return;}
      const b=e.target.closest&&e.target.closest('button');if(!b)return;
      if(b.hasAttribute('data-send-bwat')){void sendBwat(dlg);return;}
      const first=dlg.querySelector('[data-leave-first]'),confirmation=dlg.querySelector('[data-leave-confirmation]');
      if(b.hasAttribute('data-ask-leave')){first.hidden=true;confirmation.hidden=false;dlg.querySelector('[data-confirm-leave]').focus();}
      else if(b.hasAttribute('data-cancel-leave')){confirmation.hidden=true;first.hidden=false;dlg.querySelector('[data-ask-leave]').focus();}
      // Asked: the drawer closes and the Live pill says Leaving…, then Left once bwat has gone.
      else if(b.hasAttribute('data-confirm-leave')){dlg.close();void MEETING_BOT.leave();}};
    dlg.onchange=(e)=>{const t=e.target;
      // The link field is no setting.
      if(t.closest('[data-send]'))return;
      if(t.dataset.pluginSwitch){window.bwatBoard.setHidden(t.dataset.pluginSwitch,!t.checked);PLUGIN_BOARD.redraw();}
      else if(t.name==='theme'){if(window.BWAT_THEME)BWAT_THEME.set(t.value);}
      else if(t.name==='open'){set('open',t.value);defaultSourceId=LIVE.defaultSource(sources,t.value);render();}
      // A switch stores its On or Off value under the preference's own key.
      else{set(t.name,PREFS[t.name].values[t.checked?0:1]);
        if(t.name==='superseded'||t.name==='answered')cardsChanged();
        render();}
      announce('Setting saved.');};
    dlg.addEventListener('close',()=>{dlg.classList.remove('in');clearTimeout(followTimer);followRun++;document.getElementById('settings-open')?.focus();},{once:true});
    dlg.showModal();
    // Settings redesign B7: in from the right on the next frame, so the slide starts off-screen.
    requestAnimationFrame(()=>dlg.classList.add('in'));
    if(at==='plugins'&&dlg.querySelector('#settings-plugins')){dlg.querySelector('#settings-plugins').scrollIntoView({block:'start'});dlg.querySelector('[data-plugin-switch]').focus();}
  }
  if(typeof document!=='undefined')document.getElementById('settings-open')?.addEventListener('click',()=>open());
  return {get,set,PREFS,open};
})();
