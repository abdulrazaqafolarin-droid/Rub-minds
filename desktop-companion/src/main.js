import { createClient } from '@supabase/supabase-js';
import { validateDeviceCommand, validateDeviceSignal, queueIceCandidate, takeIceCandidates } from '../../integrations/backroom/desktop-realtime-protocol.mjs';
import { waitForIceGatheringComplete } from '../../integrations/backroom/ice-gathering.mjs';
import { validatePeerHeartbeat } from '../../integrations/backroom/peer-heartbeat.mjs';
import { beginTargetSelection, confirmTargetSelection, invalidateTargetSelection, rejectTargetSelection, canStageDraftForCurrentSelection, isPendingDraftForCurrentSelection } from '../../integrations/backroom/desktop-target-selection.mjs';
import './style.css';

const app = document.querySelector('#app');
const invoke = (command, args = {}) => window.__TAURI__?.core?.invoke(command, args)
  ?? Promise.reject(new Error('Open the installed desktop companion; the native bridge is unavailable.'));
const listen = (event, callback) => window.__TAURI__?.event?.listen(event, callback)
  ?? Promise.reject(new Error('Native events are unavailable.'));
const cfg = { url: import.meta.env.VITE_SUPABASE_URL || '', key: import.meta.env.VITE_SUPABASE_ANON_KEY || '' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const state = {
  client: null, user: null, session: null, deviceId: null, roomId: null, deviceTokenSaved: false,
  channel: null, apps: [], pending: [], peers: new Map(), streams: new Map(), terminals: new Map(), pendingCandidates: new Map(),
  seenCommands: new Map(), heartbeat: null, heartbeatMisses: 0, peerWatchdog: null,
  status: 'Not connected', terminalOutput: '', unlisten: [],
};
function notify(message, kind='') {
  const node = document.querySelector('#notice');
  if (!node) return;
  node.textContent = message; node.className = 'alert' + (kind ? ' ' + kind : '');
  node.classList.remove('hidden');
}
function hideNotice(){const node=document.querySelector('#notice');if(node)node.classList.add('hidden');}
function shell() {
  app.innerHTML = `
    <header class="top"><div class="logo">R</div><div><h1>Rub Minds Backroom Companion</h1><div class="sub">Your actual computer · account-connected · device-approved</div></div><div style="margin-left:auto"><span class="status" id="connection-status">Not connected</span></div></header>
    <div id="notice" class="alert hidden" role="status"></div>
    <section class="card" id="auth-card">
      <h2>Sign in to Rub Minds</h2><p class="muted">Use the same Rub Minds account that owns the group you want to connect. No host URL or one-time pairing code is needed.</p>
      <form id="login-form" class="stack">
        <label for="email">Email address</label><input id="email" type="email" autocomplete="username" required />
        <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required />
        <button class="primary" type="submit">Sign in securely</button>
      </form>
    </section>
    <section class="card hidden" id="device-card">
      <div class="row"><div><h2>Connect this computer</h2><p class="muted">This computer is registered directly to your signed-in account. Device credentials stay in the operating system's secure credential store.</p></div><span class="pill" id="device-state">Not registered</span></div>
      <label for="room">Rub Minds group</label><select id="room"><option value="">Loading your groups…</option></select>
      <label for="device-label">Computer name</label><input id="device-label" maxlength="80" value="My Windows computer" />
      <div class="row"><button class="primary" id="register-device">Connect this computer</button><button class="danger hidden" id="revoke-device">Revoke this computer</button></div>
      <div class="muted" style="margin-top:9px">Registration requires group ownership. Other group members can send requests, but the computer still asks you locally before opening or controlling anything.</div>
    </section>
    <section class="card hidden" id="apps-card">
      <div class="row"><div><h2>Installed desktop applications</h2><p class="muted">Pick the exact Windows .exe installed on this computer. The path stays local; only the selected app label and binary fingerprint are shared with your group.</p></div><button class="primary fixed" id="add-app">＋ Add .exe</button></div>
      <div id="app-list" class="inline-list"></div>
    </section>
    <section class="card hidden" id="terminal-card">
      <div class="row"><div><h2>Native terminal</h2><p class="muted">Starts PowerShell on Windows or the native shell on supported desktop platforms. Terminal launch and typing are separately approved.</p></div><button class="primary fixed" id="start-terminal">Start terminal</button></div>
      <pre class="terminal" id="terminal-output">No terminal session is running.</pre>
      <div class="row"><input id="terminal-local-input" placeholder="Optional local terminal input (requires control grant)" /><button class="fixed" id="send-terminal-local">Send</button></div>
    </section>
    <section class="card">
      <div class="row"><div><h2>Requests from Backroom</h2><p class="muted">Every action is a request. Approve it here on this computer; network messages cannot approve themselves.</p></div><button class="ghost fixed" id="refresh-pending">Refresh</button></div>
      <div id="approval-list" class="inline-list"><div class="muted">Sign in and connect a device to receive requests.</div></div>
    </section>
    <section class="card">
      <div class="row"><div><h2>Device safety</h2><p class="muted">Revocation clears local grants, stops terminal sessions and terminates Backroom-launched apps. Your other desktop apps are not touched.</p></div><button class="danger fixed" id="emergency-stop">Emergency stop</button></div>
      <div class="row"><button class="ghost" id="sign-out">Sign out</button><button class="ghost" id="disconnect">Disconnect device channel</button></div>
    </section>
    <div class="footer">Local native execution · no cloud computer replaces this PC · protected windows may reject capture or input.</div>`;
  document.querySelector('#login-form').addEventListener('submit', signIn);
  document.querySelector('#register-device').addEventListener('click', registerDevice);
  document.querySelector('#revoke-device').addEventListener('click', revokeDevice);
  document.querySelector('#add-app').addEventListener('click', addApp);
  document.querySelector('#start-terminal').addEventListener('click', startTerminalLocal);
  document.querySelector('#refresh-pending').addEventListener('click', refreshPending);
  document.querySelector('#emergency-stop').addEventListener('click', emergencyStop);
  document.querySelector('#sign-out').addEventListener('click', signOut);
  document.querySelector('#disconnect').addEventListener('click', disconnect);
  document.querySelector('#send-terminal-local').addEventListener('click', sendLocalTerminal);
}
function setConnected(connected, label) {
  state.status = label || (connected ? 'Connected' : 'Disconnected');
  const pill=document.querySelector('#connection-status');
  if(pill){pill.textContent=state.status;pill.className='status '+(connected?'good':'bad');}
}
function showSignedIn(user) {
  state.user=user;
  document.querySelector('#auth-card').classList.add('hidden');
  document.querySelector('#device-card').classList.remove('hidden');
  document.querySelector('#apps-card').classList.remove('hidden');
  document.querySelector('#terminal-card').classList.remove('hidden');
}
function createAuthClient(){
  if(!cfg.url||!cfg.key)throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the project environment before building the companion.');
  const storage={
    getItem:()=>invoke('secure_auth_get'),
    setItem:(_key,value)=>invoke('secure_auth_set',{value}),
    removeItem:()=>invoke('secure_auth_delete'),
  };
  return createClient(cfg.url,cfg.key,{
    auth:{storage,storageKey:'rub-minds-desktop-session',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},
    realtime:{params:{eventsPerSecond:20}},
  });
}
async function signIn(event){
  event.preventDefault();hideNotice();
  const email=document.querySelector('#email').value.trim();
  const password=document.querySelector('#password').value;
  try{
    const {data,error}=await state.client.auth.signInWithPassword({email,password});
    if(error)throw error;
    state.session=data.session;showSignedIn(data.user);await loadRooms();
    notify('Signed in. Choose the group this computer should be attached to.','success');
  }catch(error){notify(error?.message||'Sign-in failed.','error');}
}
async function loadRooms(){
  const {data,error}=await state.client.from('rooms').select('id,title,owner_id').eq('owner_id',state.user.id).order('created_at',{ascending:false});
  if(error)throw error;
  const select=document.querySelector('#room');
  select.innerHTML='<option value="">Choose a group you own…</option>';
  for(const room of data||[]){const option=document.createElement('option');option.value=room.id;option.textContent=room.title;select.append(option);}
  if(!data?.length)notify('This account does not own a group yet. Create one in Rub Minds first.','error');
}
async function currentSession(){
  const {data,error}=await state.client.auth.getSession();
  if(error)throw error;
  state.session=data.session;
  if(!state.session)throw new Error('Sign in to your Rub Minds account first.');
  const {data:user,error:userError}=await state.client.auth.getUser();
  if(userError||!user.user)throw new Error('The account session is no longer valid. Sign in again.');
  state.user=user.user;
  return state.session;
}
async function registerDevice(){
  hideNotice();
  try{
    const session=await currentSession();
    const roomId=document.querySelector('#room').value;
    const label=document.querySelector('#device-label').value.trim();
    if(!roomId)throw new Error('Select a Rub Minds group you own.');
    const identity=await invoke('device_identity');state.deviceId=identity.deviceId;
    const {data:room,error:roomError}=await state.client.from('rooms').select('id').eq('id',roomId).eq('owner_id',state.user.id).maybeSingle();
    if(roomError||!room)throw new Error('This account does not own the selected group.');
    const result=await invoke('register_desktop_device',{args:{
      supabaseUrl:cfg.url,publishableKey:cfg.key,accessToken:session.access_token,
      roomId,deviceLabel:label,osVersion:navigator.userAgent.slice(0,40),appVersion:'0.1.0'
    }});
    state.deviceId=result.deviceId;state.roomId=result.roomId;state.deviceTokenSaved=result.credentialSavedToOsStore;
    document.querySelector('#device-state').textContent='Connected · '+state.deviceId.slice(0,8);
    document.querySelector('#revoke-device').classList.remove('hidden');
    await loadApps();if(state.apps.length)await syncApps();await connectDeviceChannel();
    notify('This computer is registered to the selected group. Device credential saved in the OS secure store.','success');
  }catch(error){notify(error?.message||'Could not register this computer.','error');}
}
async function revokeDevice(){
  hideNotice();
  if(!state.deviceTokenSaved)return notify('This computer has no active device credential.','error');
  if(!confirm('Revoke this computer from the selected Rub Minds group? This closes Backroom terminal sessions and revokes local desktop-control permissions.'))return;
  stopHeartbeat();
  try{
    await stopAllPeerSessions();
    await invoke('emergency_stop');
    const session=await currentSession();
    await invoke('revoke_desktop_device',{supabaseUrl:cfg.url,publishableKey:cfg.key,accessToken:session.access_token,roomId:state.roomId});
    state.deviceTokenSaved=false;state.deviceId=null;state.roomId=null;state.apps=[];state.pending=[];state.terminals.clear();
    if(state.channel){await state.client.removeChannel(state.channel);state.channel=null;}
    document.querySelector('#device-state').textContent='Revoked';
    document.querySelector('#revoke-device').classList.add('hidden');
    renderApps();renderPending();setConnected(false,'Computer revoked');
    notify('Computer revoked in Rub Minds. The local device credential was removed and active Backroom sessions were stopped.','success');
  }catch(error){notify(error?.message||'Could not revoke this computer.','error');}
}
async function loadApps(){
  state.apps=await invoke('list_registered_apps');
  renderApps();
}
function renderApps(){
  const list=document.querySelector('#app-list');if(!list)return;
  list.replaceChildren();
  if(!state.apps.length){list.innerHTML='<div class="muted">No Windows applications have been selected yet.</div>';return;}
  for(const appItem of state.apps){
    const node=document.createElement('div');node.className='item';
    const main=document.createElement('div');main.className='item-main';
    const title=document.createElement('b');title.textContent=appItem.label;
    const detail=document.createElement('small');detail.textContent='SHA-256 '+appItem.sha256.slice(0,18)+'…';
    main.append(title,detail);
    const launch=document.createElement('button');launch.textContent='Launch locally';
    launch.addEventListener('click',()=>localLaunch(appItem));
    node.append(main,launch);list.append(node);
  }
}
async function addApp(){
  hideNotice();
  try{
    const result=await invoke('pick_and_register_app');
    await loadApps();
    if(state.deviceTokenSaved) await syncApps();
    notify(result.label+' was added to this computer. Its file path remains local.','success');
  }catch(error){if(!String(error?.message).includes('cancelled'))notify(error?.message||'Application selection failed.','error');}
}
async function syncApps(){
  // The native command obtains the bearer token directly from the OS keyring.
  const result=await invoke('sync_desktop_app_inventory',{supabaseUrl:cfg.url,publishableKey:cfg.key});
  notify('Synced '+result+' selected desktop apps. Executable paths and app data remain on this computer.','success');
}
async function localLaunch(appItem){
  const card=await createApproval('launch',appItem.label+' will open on this computer. Approve only if you recognize this application.',async()=>{
    const pid=await invoke('launch_registered_app',{appId:appItem.id});
    await publish('response',{requestId:card.requestId,ok:true,pid});
    notify('Launched '+appItem.label+' on this computer.','success');
  });
  return card;
}
async function closeServerSession(sessionId){
  if(typeof sessionId!=='string'||!UUID_PATTERN.test(sessionId))return false;
  try{
    await invoke('close_desktop_session',{supabaseUrl:cfg.url,publishableKey:cfg.key,sessionId});
    return true;
  }catch(error){
    notify('The computer could not confirm server-side session cleanup. The session will expire automatically. '+(error?.message||''),'error');
    return false;
  }
}

function createApproval(kind,description,onApprove,extra={}){
  const requestId=extra.requestId||crypto.randomUUID();
  const actor=extra.remote&&typeof extra.actorDisplayName==='string'?extra.actorDisplayName.trim().slice(0,80):'';
  const actorNote=actor?'Requested by '+actor+' through the verified Rub Minds group.\\n\\n':'';
  const item={kind,description:actorNote+description,onApprove,onDeny:extra.onDeny,requestId,extra};
  state.pending.push(item);renderPending();
  return {requestId};
}
function renderPending(){
  const list=document.querySelector('#approval-list');if(!list)return;
  list.replaceChildren();
  if(!state.pending.length){const node=document.createElement('div');node.className='muted';node.textContent='No requests are waiting for local approval.';list.append(node);return;}
  for(const item of state.pending){
    const card=document.createElement('div');card.className='item approval';card.style.alignItems='stretch';
    const main=document.createElement('div');main.className='item-main';
    const title=document.createElement('h3');title.textContent=item.kind.replaceAll('_',' ').toUpperCase();
    const description=document.createElement('div');description.className='description';description.textContent=item.description;
    main.append(title,description);
    const actions=document.createElement('div');actions.className='actions';
    const yes=document.createElement('button');yes.className='primary';yes.textContent='Approve on this PC';
    const no=document.createElement('button');no.className='ghost';no.textContent='Deny';
    yes.addEventListener('click',async()=>{
      yes.disabled=true;no.disabled=true;
      try{await item.onApprove();}catch(error){
        try{await item.onDeny?.();}catch{}
        notify(error?.message||'The approved action failed.','error');
        if(item.extra?.remote){try{await publish('response',{requestId:item.requestId,ok:false,reason:'device_action_failed',capability:item.extra.capability});}catch{}}
      }
      finally{state.pending=state.pending.filter(x=>x!==item);renderPending();}
    });
    no.addEventListener('click',async()=>{
      try{await item.onDeny?.();}catch(error){notify(error?.message||'Could not record the denial.','error');}
      try{
        if(item.extra?.remote)await publish('response',{requestId:item.requestId,ok:false,reason:'denied_on_device',capability:item.extra.capability});
      }catch{
        // The local denial and server-side session close have already been attempted.
        // A lost response is not grounds to retain or re-open a denied approval.
      }finally{
        state.pending=state.pending.filter(x=>x!==item);renderPending();
      }
    });
    actions.append(yes,no);card.append(main,actions);list.append(card);
  }
}
async function publish(event,payload){
  if(!state.channel)throw new Error('The private device channel is disconnected.');
  const result=await state.channel.send({type:'broadcast',event,payload:{...payload,roomId:state.roomId,deviceId:state.deviceId}});
  if(result!=='ok')throw new Error('Could not send a private device message.');
}

async function handleDeviceRevoked(payload){
  if(payload?.deviceId!==state.deviceId||payload?.roomId!==state.roomId||payload?.status!=='revoked')return;
  stopHeartbeat();
  await stopAllPeerSessions({serverAlreadyClosed:true});
  // Native status verification clears the OS keyring credential and all grants.
  try{await invoke('desktop_device_status',{supabaseUrl:cfg.url,publishableKey:cfg.key});}
  catch{try{await invoke('emergency_stop');}catch{}}
  if(state.channel){const channel=state.channel;state.channel=null;try{await state.client.removeChannel(channel);}catch{}}
  state.deviceTokenSaved=false;state.deviceId=null;state.roomId=null;state.pending=[];state.terminals.clear();state.apps=[];renderApps();
  setConnected(false,'Computer authorization revoked');
  const stateNode=document.querySelector('#device-state');if(stateNode)stateNode.textContent='Revoked';
  document.querySelector('#revoke-device')?.classList.add('hidden');
  renderPending();
  notify('This computer was revoked by the Rub Minds group owner. Backroom streams, terminal sessions and native permissions have been stopped.','error');
}
async function failClosedDeviceChannel(reason,failedChannel){
  if(failedChannel&&state.channel!==failedChannel)return;
  stopHeartbeat();
  const channel=failedChannel||state.channel;
  state.channel=null;
  await stopAllPeerSessions();
  try{await invoke('emergency_stop');}catch{}
  if(channel&&state.client){try{await state.client.removeChannel(channel);}catch{}}
  setConnected(false,'Device channel unavailable');
  notify(reason||'The private device channel was lost. Active Backroom sessions were stopped locally. Reconnect to resume.', 'error');
}

async function connectDeviceChannel(){
  if(state.channel){const previous=state.channel;state.channel=null;await state.client.removeChannel(previous);}
  await currentSession();
  const response=await invoke('desktop_device_status',{supabaseUrl:cfg.url,publishableKey:cfg.key});
  if(response.status!=='active'||response.deviceId!==state.deviceId)throw new Error('Device registration is not active.');
  state.roomId=response.roomId;
  const topic='backroom-device:'+state.deviceId;
  const channel=state.client.channel(topic,{config:{private:true,broadcast:{ack:true,self:false}}});
  channel.on('broadcast',{event:'command'},message=>void handleCommand(message.payload||{}));
  channel.on('broadcast',{event:'signal'},message=>void handleSignal(message.payload||{}));
  channel.on('broadcast',{event:'device_revoked'},message=>void handleDeviceRevoked(message.payload||{}));
  state.channel=channel;
  try{
    const result=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{void failClosedDeviceChannel('Private device channel timed out. Check Realtime private channel authorization.',channel);reject(new Error('Private device channel timed out.'));},15000);
      channel.subscribe(status=>{
        if(status==='SUBSCRIBED'){clearTimeout(timeout);resolve(status);}
        if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){clearTimeout(timeout);void failClosedDeviceChannel('Private device channel '+status+'. Active local sessions were stopped.',channel);reject(new Error('Private device channel '+status+'.'));}
      });
    });
    setConnected(true,'Account connected · private channel active');
    startHeartbeat();
    return result;
  }catch(error){
    if(state.channel===channel)state.channel=null;
    try{await state.client.removeChannel(channel);}catch{}
    setConnected(false,'Device channel unavailable');
    throw error;
  }
}
async function handleCommand(payload){
  if(!validateDeviceCommand(payload,{deviceId:state.deviceId,roomId:state.roomId,maxAgeMs:30_000}))return;
  const requestId=payload.requestId;
  const now=Date.now();
  for(const [id,issuedAt] of state.seenCommands)if(now-issuedAt>120_000)state.seenCommands.delete(id);
  if(state.seenCommands.has(requestId))return;
  if(state.pending.length>=32){if(['terminal_start','view_offer'].includes(payload.action))await closeServerSession(payload.sessionId);await publish('response',{requestId,ok:false,reason:'local_approval_queue_full'});return;}
  state.seenCommands.set(requestId,payload.issuedAt);
  if(state.seenCommands.size>2048)state.seenCommands.delete(state.seenCommands.keys().next().value);
  if(payload.action==='launch_app'){
    const appItem=state.apps.find(item=>item.id===payload.appId);
    if(!appItem){await publish('response',{requestId,ok:false,reason:'app_not_selected'});return;}
    createApproval('launch_app','Open '+appItem.label+' on this actual computer?',async()=>{
      const pid=await invoke('launch_registered_app',{appId:appItem.id});
      await publish('response',{requestId,ok:true,pid});
    },{requestId,remote:true,actorDisplayName:payload.actorDisplayName,capability:'launch'});
    return;
  }
  if(payload.action==='terminal_start'){
    if(typeof payload.sessionId!=='string'||!payload.offer?.sdp)return;
    createApproval('terminal_start','Start a native PowerShell terminal on this computer and connect it to the requesting Backroom workspace?',async()=>{
      const term=await invoke('start_terminal',{sessionId:payload.sessionId});
      if(term.sessionId!==payload.sessionId){
        try{await invoke('stop_terminal',{sessionId:term.sessionId});}catch{}
        throw new Error('The native terminal session did not match the authorized Backroom session.');
      }
      state.terminals.set(term.sessionId,term);
      try{
        await startTerminalPeer(payload,term);
        await publish('response',{requestId,ok:true,sessionId:term.sessionId,capability:'terminal',cols:term.cols,rows:term.rows,shellLabel:term.shellLabel});
      }catch(error){
        state.terminals.delete(term.sessionId);
        try{await invoke('stop_terminal',{sessionId:term.sessionId});}catch{}
        await stopPeer(payload.sessionId);
        throw error;
      }
    },{requestId,sessionId:payload.sessionId,remote:true,actorDisplayName:payload.actorDisplayName,capability:'terminal',onDeny:()=>stopPeer(payload.sessionId)});
    return;
  }
  if(payload.action==='request_control'){
    const sessionId=payload.sessionId;
    if(typeof sessionId!=='string')return;
    createApproval('control','Allow this Backroom group to control the selected app/terminal for up to 120 seconds? Mouse, keyboard and terminal input will be enabled.',async()=>{
      await invoke('grant_control',{sessionId,seconds:120});
      await publish('response',{requestId,ok:true,sessionId,capability:'control',expiresSeconds:120});
    },{requestId,sessionId,remote:true,actorDisplayName:payload.actorDisplayName,capability:'control'});return;
  }
  if(payload.action==='request_draft_permission'){
    const sessionId=payload.sessionId;if(typeof sessionId!=='string')return;
    createApproval('draft_typing','Allow separately approved draft typing into the exact area you select for up to 60 seconds? This never presses Enter or Send.',async()=>{
      await invoke('grant_draft_typing',{sessionId,seconds:60});
      await publish('response',{requestId,ok:true,sessionId,capability:'draft',expiresSeconds:60});
    },{requestId,sessionId,remote:true,actorDisplayName:payload.actorDisplayName,capability:'draft'});return;
  }
  if(payload.action==='view_offer'){
    if(typeof payload.sessionId!=='string'||!payload.offer?.sdp)return;
    createApproval('view_offer','Share your entire monitor with this Backroom session. Windows will show its screen-sharing picker. Choosing a single window keeps the frame view-only.',async()=>{
      try{await startViewSession(payload);}
      catch(error){await stopPeer(payload.sessionId);throw error;}
    },{requestId,sessionId:payload.sessionId,remote:true,actorDisplayName:payload.actorDisplayName,capability:'view',onDeny:()=>stopPeer(payload.sessionId)});return;
  }
  if(payload.action==='stop_session'){
    const peerSessionId=payload.sessionId;
    if(typeof peerSessionId!=='string')return;
    // The native companion, not the caller, owns the peer -> PTY mapping.
    // Never accept an arbitrary terminal process ID from a remote command.
    await stopPeer(peerSessionId);
    await publish('response',{requestId,ok:true,capability:'stop',sessionId:peerSessionId});return;
  }
}
async function startTerminalPeer(payload,term){
  const peerSessionId=payload.sessionId;
  if(!peerSessionId||!payload.offer?.sdp)throw new Error('Invalid terminal WebRTC offer');
  const pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']}]});
  state.peers.set(peerSessionId,{pc,stream:null,channel:null,canControl:false,terminalId:term.sessionId,createdAt:Date.now(),lastHeartbeat:Date.now()});
  startPeerWatchdog();
  pc.ondatachannel=event=>{
    const data=event.channel;state.peers.get(peerSessionId).channel=data;
    data.onmessage=event=>void handlePeerData(peerSessionId,event.data);
  };
  // Send one fully gathered SDP answer instead of one REST/Realtime signal per candidate.
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))void stopPeer(peerSessionId);};
  await pc.setRemoteDescription({type:'offer',sdp:payload.offer.sdp});
  for(const candidate of takeIceCandidates(state.pendingCandidates,peerSessionId)){try{await pc.addIceCandidate(candidate);}catch{}}
  const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
  await waitForIceGatheringComplete(pc);
  await publishSignal(peerSessionId,{answer:pc.localDescription.toJSON(),canControl:false});
}
async function startViewSession(payload){
  const sessionId=payload.sessionId;
  const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15,max:30}},audio:false});
  const track=stream.getVideoTracks()[0];
  if(!track){stream.getTracks().forEach(t=>t.stop());throw new Error('The selected monitor did not provide a video stream.');}
  const settings=track.getSettings();
  let canControl=false;
  try{
    await invoke('set_capture_geometry',{
      sessionId,frameWidth:settings.width,frameHeight:settings.height,
      screenWidthCss:screen.width,screenHeightCss:screen.height,
      deviceScaleFactor:devicePixelRatio,originXCss:screen.availLeft||0,originYCss:screen.availTop||0,
      displaySurface:settings.displaySurface||'window'
    });
    canControl=true;
  }catch(error){notify('The screen is visible, but desktop input is disabled: '+error.message,'error');}
  const pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']}]});
  state.peers.set(sessionId,{pc,stream,channel:null,canControl,terminalId:null,createdAt:Date.now(),lastHeartbeat:Date.now()});
  startPeerWatchdog();
  for(const mediaTrack of stream.getTracks())pc.addTrack(mediaTrack,stream);
  pc.ondatachannel=event=>{
    const channel=event.channel;state.peers.get(sessionId).channel=channel;
    channel.onmessage=event=>void handlePeerData(sessionId,event.data);
  };
  // The answer carries the completed ICE candidate set in its SDP.
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))void stopPeer(sessionId);};
  track.addEventListener('ended',()=>void stopPeer(sessionId));
  await pc.setRemoteDescription({type:'offer',sdp:payload.offer.sdp});
  for(const candidate of takeIceCandidates(state.pendingCandidates,sessionId)){try{await pc.addIceCandidate(candidate);}catch{}}
  const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
  await waitForIceGatheringComplete(pc);
  await publishSignal(sessionId,{answer:pc.localDescription.toJSON(),canControl});
  await publish('response',{requestId:payload.requestId,ok:true,sessionId,capability:'view'});
  state.streams.set(sessionId,stream);
  notify('Screen share active. '+(canControl?'Monitor coordinates matched; control can be approved separately.':'View-only: choose the full monitor for coordinate-safe control.'),'success');
}
async function publishSignal(sessionId,signal){await state.channel.send({type:'broadcast',event:'signal',payload:{deviceId:state.deviceId,roomId:state.roomId,sessionId,issuedAt:Date.now(),...signal}});}
async function handleSignal(payload){
  const signal=validateDeviceSignal(payload,{deviceId:state.deviceId,roomId:state.roomId,now:Date.now(),maxAgeMs:120_000});
  if(!signal)return;
  const peer=state.peers.get(signal.sessionId);
  if(!peer){
    if(signal.candidate)queueIceCandidate(state.pendingCandidates,signal.sessionId,signal.candidate);
    return;
  }
  if(signal.answer){
    try{
      await peer.pc.setRemoteDescription(signal.answer);
      for(const candidate of takeIceCandidates(state.pendingCandidates,signal.sessionId)){try{await peer.pc.addIceCandidate(candidate);}catch{}}
    }catch(error){notify('WebRTC answer rejected: '+error.message,'error');}
  }
  if(signal.candidate){
    if(!peer.pc.remoteDescription)queueIceCandidate(state.pendingCandidates,signal.sessionId,signal.candidate);
    else try{await peer.pc.addIceCandidate(signal.candidate);}catch{}
  }
  if(signal.canControl===true)notify('Full-monitor geometry was verified. Control still requires separate approval.','success');
  if(signal.stop){await stopPeer(signal.sessionId);}
}
async function invalidatePendingDraftApprovals(sessionId,reason){
  const stale=state.pending.filter(item=>item.kind==='draft_text'&&item.extra?.sessionId===sessionId);
  if(!stale.length)return;
  state.pending=state.pending.filter(item=>!stale.includes(item));
  for(const item of stale){
    try{
      if(item.onInvalidate)await item.onInvalidate(reason);
      else await item.onDeny?.();
    }catch{}
  }
  renderPending();
}
async function handlePeerData(sessionId,raw){
  const peer=state.peers.get(sessionId);if(!peer)return;
  let message;try{message=JSON.parse(raw);}catch{return;}
  if(!message||typeof message.kind!=='string')return;
  if(message.kind==='heartbeat'){
    const heartbeat=validatePeerHeartbeat(message,{sessionId,now:Date.now(),maxAgeMs:45_000,maxFutureSkewMs:5_000});
    if(heartbeat)peer.lastHeartbeat=Date.now();
    return;
  }
  peer.lastHeartbeat=Date.now();
  if(message.kind==='clear_target'){
    invalidateTargetSelection(peer);
    const invalidation=invalidatePendingDraftApprovals(sessionId,'The typing-area selection was cleared; this draft was cancelled.');
    if(!peer.targetClearPromise){
      // Enqueue synchronously before yielding so a following drag cannot get
      // ahead of this clear on the ordered data channel.
      const clearTask=(peer.targetQueue||Promise.resolve()).then(async()=>{
        await invalidation;
        try{await invoke('clear_draft_target',{sessionId});}
        catch(error){notify(error?.message||'Could not clear the selected typing target. Draft insertion remains disabled.','error');}
        // Catch approval cards that were created while the first invalidation
        // was awaiting a native command.
        await invalidatePendingDraftApprovals(sessionId,'The typing-area selection was cleared; this draft was cancelled.');
        peer.targetSelectionId=null;
        peer.targetVerified=false;
      });
      const tracked=clearTask.finally(()=>{if(peer.targetClearPromise===tracked)peer.targetClearPromise=null;});
      peer.targetClearPromise=tracked;
      peer.targetQueue=tracked;
    }
    await peer.targetClearPromise;
    return;
  }
  if(message.kind==='input'&&message.event){
    // Mouse/keyboard activity outside drag-select supersedes the saved typing
    // destination. Pointer-move telemetry alone does not change the target.
    if(message.event.kind!=='move'&&(
      peer.targetVerified===true||peer.latestTargetRequestId||
      peer.targetClearPromise||peer.targetQueueDepth>0
    )){
      invalidateTargetSelection(peer);
      const invalidation=invalidatePendingDraftApprovals(
        sessionId,'Manual computer interaction changed the target; this draft was cancelled.'
      );
      if(!peer.targetClearPromise){
        const clearTask=(peer.targetQueue||Promise.resolve()).then(async()=>{
          await invalidation;
          await invoke('clear_draft_target',{sessionId});
          invalidateTargetSelection(peer);
        });
        const tracked=clearTask.finally(()=>{if(peer.targetClearPromise===tracked)peer.targetClearPromise=null;});
        peer.targetClearPromise=tracked;
        peer.targetQueue=tracked;
      }
      try{await peer.targetClearPromise;}
      catch(error){
        notify(error?.message||'Could not clear the previous typing target. Manual input was stopped for safety.','error');
        return;
      }
    }
    try{await invoke('dispatch_input',{sessionId,event:message.event});}catch(error){notify(error.message,'error');}
  } else if(message.kind==='select_target'){
    const requestId=typeof message.requestId==='string'&&message.requestId.length>0&&message.requestId.length<=80?message.requestId:null;
    const report=(ok,reason)=>{
      if(peer.channel?.readyState==='open'){
        try{peer.channel.send(JSON.stringify({kind:'target_result',requestId,ok,reason}));}catch{}
      }
    };
    if(!requestId){report(false,'A unique selection-attempt identifier is required.');return;}

    // Newer browser drags revoke draft eligibility immediately, even while the
    // native accessibility lookup for an older drag is still running.
    if(!beginTargetSelection(peer,requestId)){
      report(false,'The selection-attempt identifier is invalid.');
      return;
    }
    peer.targetQueueDepth=(peer.targetQueueDepth||0)+1;
    const invalidation=invalidatePendingDraftApprovals(sessionId,'The selected typing area changed; this draft was cancelled.');

    if(peer.targetQueueDepth>4){
      peer.targetQueueDepth-=1;
      // Queue one clear behind all active checks. Coalescing avoids an
      // unbounded clear queue if a remote peer floods the data channel.
      if(!peer.targetClearPromise){
        const clearTask=(peer.targetQueue||Promise.resolve()).then(async()=>{
          await invalidation;
          try{await invoke('clear_draft_target',{sessionId});}
          catch(error){notify(error?.message||'Could not clear the previous typing target. Draft insertion remains disabled.','error');}
          await invalidatePendingDraftApprovals(sessionId,'The typing-area selection was cleared; this draft was cancelled.');
          peer.targetSelectionId=null;
          peer.targetVerified=false;
        });
        const tracked=clearTask.finally(()=>{if(peer.targetClearPromise===tracked)peer.targetClearPromise=null;});
        peer.targetClearPromise=tracked;
        peer.targetQueue=tracked;
      }
      report(false,'Too many target checks are pending. The previous target was cleared; wait and drag-select again.');
      await peer.targetClearPromise;
      return;
    }

    // Queue in message-arrival order before awaiting local approval-card
    // invalidation. This preserves the ordered data channel's clear/drag order.
    peer.targetQueue=(peer.targetQueue||Promise.resolve()).then(async()=>{
      try{
        await invalidation;
        if(requestId!==peer.latestTargetRequestId){
          report(false,'This selection was superseded by a newer drag.');
          return;
        }
        const modeMessage=await invoke('select_draft_target',{sessionId,target:message.target});
        // A draft could have finished staging while the UIA lookup was running.
        // Invalidate it before exposing this newly selected target as ready.
        await invalidatePendingDraftApprovals(sessionId,'The selected typing area changed; this draft was cancelled.');
        if(requestId!==peer.latestTargetRequestId){
          report(false,'This selection was superseded by a newer drag.');
          return;
        }
        if(!confirmTargetSelection(peer,requestId,modeMessage)){
          throw new Error('The computer did not return a current, valid native selection identity.');
        }
        const status=modeMessage.message.length<=240
          ?modeMessage.message
          :'Windows verified an empty editable text field. Its identity will be rechecked before insertion.';
        report(true,status);
        notify(status,'success');
      }catch(error){
        const reason=error?.message||'The selected area is not a verifiable editable field.';
        rejectTargetSelection(peer,requestId);
        report(false,reason);
        notify(reason,'error');
      }finally{
        peer.targetQueueDepth=Math.max(0,(peer.targetQueueDepth||1)-1);
      }
    });
  } else if(message.kind==='draft'){
    if(!canStageDraftForCurrentSelection(peer)||peer.targetClearPromise){
      const reason='Drag-select and verify the current text field again before requesting draft insertion.';
      try{peer.channel?.send(JSON.stringify({kind:'draft_result',ok:false,result:reason}));}catch{}
      notify(reason,'error');
      return;
    }
    const stageTask=(peer.targetQueue||Promise.resolve()).then(async()=>{
      if(!canStageDraftForCurrentSelection(peer)||peer.targetClearPromise)
        throw new Error('The verified typing target changed. Drag-select it again before staging a draft.');
      const id=await invoke('stage_draft_request',{sessionId,text:message.text});
      await refreshPending();
      notify('Draft request '+id+' is waiting for approval on this computer.');
    });
    const tracked=stageTask.catch(error=>{
      const reason=error?.message||'Could not stage the draft for this target.';
      try{peer.channel?.send(JSON.stringify({kind:'draft_result',ok:false,result:reason}));}catch{}
      notify(reason,'error');
    });
    peer.targetQueue=tracked;
    await tracked;
  } else if(message.kind==='terminal_input'){
    const terminalId=message.sessionId||peer.terminalId;
    if(!terminalId)return;
    try{await invoke('write_terminal',{sessionId:terminalId,data:message.data});}catch(error){notify(error.message,'error');}
  } else if(message.kind==='terminal_resize'){
    const terminalId=message.sessionId||peer.terminalId;if(!terminalId)return;
    try{await invoke('resize_terminal',{sessionId:terminalId,cols:message.cols,rows:message.rows});}catch(error){notify(error.message,'error');}
  } else if(message.kind==='terminal_start'){
    if(!state.terminals.has(sessionId)){
      createApproval('terminal_start','Start the native terminal for this Backroom session?',async()=>{
        const term=await invoke('start_terminal');state.terminals.set(sessionId,{...term,sessionId});
      },{sessionId});
    }
  }
}
async function refreshPending(){
  const drafts=await invoke('list_pending_drafts');
  for(const draft of drafts){
    const peer=state.peers.get(draft.sessionId);
    // A delayed list response must not resurrect an approval for a previous drag.
    if(!isPendingDraftForCurrentSelection(peer,draft))continue;
    if(state.pending.some(item=>item.requestId===draft.requestId))continue;
    const sendDraftResult=(ok,result)=>{
      const peer=state.peers.get(draft.sessionId);
      if(peer?.channel?.readyState==='open'){
        try{peer.channel.send(JSON.stringify({kind:'draft_result',requestId:draft.requestId,ok,result}));}catch{}
      }
    };
    state.pending.push({kind:'draft_text',description:'Insert this exact unsent draft?\n\nDestination: '+(draft.targetLabel||'Verified desktop field')+'\n\n'+draft.text,
      requestId:draft.requestId,extra:{sessionId:draft.sessionId},
      onApprove:async()=>{
        try{
          const result=await invoke('approve_draft_request',{requestId:draft.requestId});
          sendDraftResult(true,result);notify(result,'success');
        }catch(error){
          sendDraftResult(false,error?.message||'Draft insertion was denied or failed on this computer.');
          throw error;
        }
      },
      onDeny:async()=>{await invoke('deny_draft_request',{requestId:draft.requestId});sendDraftResult(false,'Draft insertion was denied on this computer.');},
      onInvalidate:async(reason)=>{await invoke('deny_draft_request',{requestId:draft.requestId});sendDraftResult(false,reason);}});
  }
  renderPending();
}
function startPeerWatchdog(){
  if(state.peerWatchdog!==null)return;
  state.peerWatchdog=window.setInterval(()=>{
    const now=Date.now();
    for(const [sessionId,peer] of [...state.peers.entries()]){
      if(now-(peer.lastHeartbeat||peer.createdAt||now)>45_000){
        notify('The Backroom browser heartbeat was lost. Stopping the corresponding local stream/terminal.','error');
        void stopPeer(sessionId);
      }
    }
  },5_000);
}
async function stopPeer(sessionId,{closeServer=true}={}){
  const peer=state.peers.get(sessionId);
  // Cancel target-bound drafts while the peer channel still exists so the
  // browser receives an explicit result before the native session is revoked.
  await invalidatePendingDraftApprovals(sessionId,'The desktop session ended; this draft was cancelled.');
  // Remove ownership before close() emits state changes, making teardown idempotent.
  state.peers.delete(sessionId);state.streams.delete(sessionId);state.pendingCandidates.delete(sessionId);
  if(state.peers.size===0&&state.peerWatchdog!==null){clearInterval(state.peerWatchdog);state.peerWatchdog=null;}
  if(peer){
    peer.pc.close();peer.stream?.getTracks().forEach(track=>track.stop());
    if(peer.terminalId){
      try{await invoke('stop_terminal',{sessionId:peer.terminalId});}catch{}
      state.terminals.delete(peer.terminalId);
      try{await invoke('revoke_control',{sessionId:peer.terminalId});}catch{}
    }
  }
  try{await invoke('revoke_control',{sessionId});}catch{}
  if(closeServer)await closeServerSession(sessionId);
  const pending=state.pending.filter(item=>item.extra?.remote&&item.extra?.sessionId===sessionId&&
    ['terminal','view'].includes(item.extra?.capability));
  for(const item of pending){
    try{await item.onDeny?.();}catch{}
    state.pending=state.pending.filter(candidate=>candidate!==item);
  }
  if(pending.length)renderPending();
}
async function stopAllPeerSessions({serverAlreadyClosed=false}={}){
  const serverSessionIds=new Set(state.peers.keys());
  for(const item of state.pending){
    if(item.extra?.remote&&['terminal','view'].includes(item.extra?.capability)&&typeof item.extra?.sessionId==='string')
      serverSessionIds.add(item.extra.sessionId);
  }
  for(const [peerSessionId] of [...state.peers.entries()]){
    await stopPeer(peerSessionId,{closeServer:false});
  }
  for(const stream of state.streams.values())for(const track of stream.getTracks())track.stop();
  state.streams.clear();
  for(const term of state.terminals.values())try{await invoke('stop_terminal',{sessionId:term.sessionId});}catch{}
  state.terminals.clear();
  state.pendingCandidates.clear();
  if(state.peerWatchdog!==null){clearInterval(state.peerWatchdog);state.peerWatchdog=null;}
  if(!serverAlreadyClosed){
    for(const sessionId of serverSessionIds)await closeServerSession(sessionId);
  }
  state.pending=state.pending.filter(item=>!(item.extra?.remote&&
    ['terminal','view'].includes(item.extra?.capability)&&serverSessionIds.has(item.extra?.sessionId)));
  renderPending();
}
function stopHeartbeat(){if(state.heartbeat){clearInterval(state.heartbeat);state.heartbeat=null;}}
function startHeartbeat(){
  stopHeartbeat();state.heartbeatMisses=0;
  state.heartbeat=setInterval(async()=>{
    try{
      const status=await invoke('desktop_device_status',{supabaseUrl:cfg.url,publishableKey:cfg.key});
      state.heartbeatMisses=0;
      if(status.status!=='active'||status.deviceId!==state.deviceId){
        stopHeartbeat();await stopAllPeerSessions();try{await invoke('emergency_stop');}catch{}
        if(state.channel){const channel=state.channel;state.channel=null;await state.client.removeChannel(channel);}
        state.deviceTokenSaved=false;setConnected(false,'Computer authorization revoked');
        notify('Rub Minds revoked this computer. Backroom streams, terminal sessions and local control grants were stopped.','error');
      }
    }catch(error){
      state.heartbeatMisses++;
      if(state.heartbeatMisses>=3){
        stopHeartbeat();await stopAllPeerSessions();try{await invoke('emergency_stop');}catch{}
        if(state.channel){const channel=state.channel;state.channel=null;await state.client.removeChannel(channel);}
        setConnected(false,'Device disconnected');
        notify('The authenticated device connection was lost. Active Backroom sessions were stopped locally. Reconnect after checking the internet connection.','error');
      }
    }
  },60*60*1000);
}
async function startTerminalLocal(){
  try{
    const term=await invoke('start_terminal');state.terminals.set(term.sessionId,term);
    notify('Started '+term.shellLabel+'. Request control separately from Backroom before typing.','success');
    const pre=document.querySelector('#terminal-output');if(pre)pre.textContent='Terminal session '+term.sessionId+' started.\n';
  }catch(error){notify(error.message,'error');}
}
async function sendLocalTerminal(){
  const session=[...state.terminals.values()][0];if(!session)return notify('Start a terminal first.','error');
  const text=document.querySelector('#terminal-local-input').value;
  try{await invoke('write_terminal',{sessionId:session.sessionId,data:text+'\r'});document.querySelector('#terminal-local-input').value='';}
  catch(error){notify(error.message,'error');}
}
async function emergencyStop(){
  try{
    stopHeartbeat();
    await stopAllPeerSessions();
    await invoke('emergency_stop');
    if(state.channel){await state.client.removeChannel(state.channel);state.channel=null;}
    state.pending=[];renderPending();setConnected(false,'Emergency stop · disconnected');
    notify('Emergency stop complete. Local permissions and Backroom-launched sessions were stopped. Reopen the companion to reconnect.','success');
  }catch(error){notify('Emergency stop needs attention: '+error.message,'error');}
}
async function disconnect(){
  stopHeartbeat();
  await stopAllPeerSessions();
  try{await invoke('emergency_stop');}catch{}
  if(state.channel){const channel=state.channel;state.channel=null;try{await state.client.removeChannel(channel);}catch{}}
  setConnected(false,'Disconnected from device channel');
}
async function signOut(){
  try{await emergencyStop();await disconnect();await state.client.auth.signOut();state.user=null;state.session=null;location.reload();}
  catch(error){notify(error.message,'error');}
}
async function setupTerminalEvents(){
  const off=await listen('backroom-terminal-output',event=>{
    const data=event.payload?.data||[];
    const terminalId=event.payload?.sessionId;
    const text=new TextDecoder().decode(new Uint8Array(data));
    const pre=document.querySelector('#terminal-output');if(pre){pre.textContent=(pre.textContent+text).slice(-30000);pre.scrollTop=pre.scrollHeight;}
    for(const [peerSessionId,peer] of state.peers){
      if(peer.terminalId!==terminalId||peer.channel?.readyState!=='open')continue;
      // Do not let a slow browser/network peer grow an unbounded RTC send buffer.
      // Terminal output is a live view, not a durable log; the next chunk resumes
      // naturally once bufferedAmount has drained below the threshold.
      if(peer.channel.bufferedAmount>512*1024){
        if(!peer.outputBackpressureNotice){
          peer.outputBackpressureNotice=true;
          notify('Terminal output is being throttled because the remote connection is slow. The shell remains active locally.','error');
        }
        continue;
      }
      peer.outputBackpressureNotice=false;
      peer.channel.send(JSON.stringify({kind:'terminal_output',sessionId:terminalId,data:Array.from(data)}));
    }
  });
  state.unlisten.push(off);
}
async function boot(){
  shell();
  try{
    state.client=createAuthClient();
    const {data,error}=await state.client.auth.getSession();if(error)throw error;
    if(data.session){
      state.session=data.session;
      const {data:user,error:userError}=await state.client.auth.getUser();
      if(userError||!user.user)throw new Error('Saved Rub Minds session expired. Sign in again.');
      showSignedIn(user.user);await loadRooms();
      const identity=await invoke('device_identity');state.deviceId=identity.deviceId;
      try{
        const status=await invoke('desktop_device_status',{supabaseUrl:cfg.url,publishableKey:cfg.key});
        state.deviceTokenSaved=status.status!=='revoked';state.roomId=status.roomId;
        document.querySelector('#device-state').textContent=status.status+' · '+status.deviceId.slice(0,8);
        document.querySelector('#revoke-device').classList.toggle('hidden',status.status!=='active');
        await connectDeviceChannel();
        await loadApps();
      }catch{/* New device: user can register after selecting a group. */}
    }
    await setupTerminalEvents();
  }catch(error){notify(error?.message||'Could not initialize companion.','error');}
}
boot();
