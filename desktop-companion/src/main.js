import { createClient } from '@supabase/supabase-js';
import './style.css';

const app = document.querySelector('#app');
const invoke = (command, args = {}) => window.__TAURI__?.core?.invoke(command, args)
  ?? Promise.reject(new Error('Open the installed desktop companion; the native bridge is unavailable.'));
const listen = (event, callback) => window.__TAURI__?.event?.listen(event, callback)
  ?? Promise.reject(new Error('Native events are unavailable.'));
const cfg = { url: import.meta.env.VITE_SUPABASE_URL || '', key: import.meta.env.VITE_SUPABASE_ANON_KEY || '' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const state = {
  client: null, user: null, session: null, deviceId: null, roomId: null, deviceTokenSaved: false,
  channel: null, apps: [], pending: [], peers: new Map(), streams: new Map(), terminals: new Map(),
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
      <button class="primary" id="register-device">Connect this computer</button>
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
    await loadApps();if(state.apps.length)await syncApps();await connectDeviceChannel();
    notify('This computer is registered to the selected group. Device credential saved in the OS secure store.','success');
  }catch(error){notify(error?.message||'Could not register this computer.','error');}
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
  const result=await invoke('sync_desktop_app_inventory',{supabaseUrl:cfg.url,publishableKey:cfg.key,apps:state.apps});
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
function createApproval(kind,description,onApprove,extra={}){
  const requestId=extra.requestId||crypto.randomUUID();
  const item={kind,description,onApprove,requestId,extra};
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
      try{await item.onApprove();}catch(error){notify(error?.message||'The approved action failed.','error');}
      finally{state.pending=state.pending.filter(x=>x!==item);renderPending();}
    });
    no.addEventListener('click',async()=>{
      if(item.extra?.sessionId) await publish('response',{requestId:item.requestId,ok:false,reason:'denied_on_device'});
      state.pending=state.pending.filter(x=>x!==item);renderPending();
    });
    actions.append(yes,no);card.append(main,actions);list.append(card);
  }
}
async function publish(event,payload){
  if(!state.channel)throw new Error('The private device channel is disconnected.');
  const result=await state.channel.send({type:'broadcast',event,payload:{...payload,deviceId:state.deviceId}});
  if(result!=='ok')throw new Error('Could not send a private device message.');
}
async function connectDeviceChannel(){
  if(state.channel){await state.client.removeChannel(state.channel);state.channel=null;}
  await currentSession();
  const response=await invoke('desktop_device_status',{supabaseUrl:cfg.url,publishableKey:cfg.key});
  if(response.status!=='active'||response.deviceId!==state.deviceId)throw new Error('Device registration is not active.');
  state.roomId=response.roomId;
  const topic='backroom-device:'+state.deviceId;
  const channel=state.client.channel(topic,{config:{private:true,broadcast:{ack:true,self:false}}});
  channel.on('broadcast',{event:'command'},message=>void handleCommand(message.payload||{}));
  channel.on('broadcast',{event:'signal'},message=>void handleSignal(message.payload||{}));
  const result=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Private device channel timed out. Check Realtime private channel authorization.')),15000);
    channel.subscribe(status=>{
      if(status==='SUBSCRIBED'){clearTimeout(timeout);resolve(status);}
      if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){clearTimeout(timeout);reject(new Error('Private device channel '+status+'.'));}
    });
  });
  state.channel=channel;
  setConnected(true,'Account connected · private channel active');
  return result;
}
async function handleCommand(payload){
  if(payload.deviceId!==state.deviceId||payload.roomId!==state.roomId||typeof payload.action!=='string')return;
  const requestId=String(payload.requestId||'');
  if(!/^[a-z0-9-]{20,80}$/i.test(requestId))return;
  if(payload.action==='launch_app'){
    const appItem=state.apps.find(item=>item.id===payload.appId);
    if(!appItem){await publish('response',{requestId,ok:false,reason:'app_not_selected'});return;}
    createApproval('launch_app','Open '+appItem.label+' on this actual computer?',async()=>{
      const pid=await invoke('launch_registered_app',{appId:appItem.id});
      await publish('response',{requestId,ok:true,pid});
    },{requestId});
    return;
  }
  if(payload.action==='terminal_start'){
    createApproval('terminal_start','Start a real '+(navigator.platform.includes('Win')?'Windows PowerShell':'native')+' terminal session on this computer?',async()=>{
      const term=await invoke('start_terminal');
      state.terminals.set(term.sessionId,term);
      const peer=state.peers.get(payload.sessionId);if(peer)peer.terminalId=term.sessionId;
      await publish('response',{requestId,ok:true,sessionId:term.sessionId,cols:term.cols,rows:term.rows,shellLabel:term.shellLabel});
    },{requestId});
    return;
  }
  if(payload.action==='request_control'){
    const sessionId=payload.sessionId;
    if(typeof sessionId!=='string')return;
    createApproval('control','Allow this Backroom group to control the selected app/terminal for up to 120 seconds? Mouse, keyboard and terminal input will be enabled.',async()=>{
      await invoke('grant_control',{sessionId,seconds:120});
      await publish('response',{requestId,ok:true,sessionId,expiresSeconds:120});
    },{requestId,sessionId});return;
  }
  if(payload.action==='request_draft_permission'){
    const sessionId=payload.sessionId;if(typeof sessionId!=='string')return;
    createApproval('draft_typing','Allow separately approved draft typing into the exact area you select for up to 60 seconds? This never presses Enter or Send.',async()=>{
      await invoke('grant_draft_typing',{sessionId,seconds:60});
      await publish('response',{requestId,ok:true,sessionId,expiresSeconds:60});
    },{requestId,sessionId});return;
  }
  if(payload.action==='view_offer'){
    if(typeof payload.sessionId!=='string'||!payload.offer?.sdp)return;
    createApproval('view_offer','Share your entire monitor with this Backroom session. Windows will show its screen-sharing picker. Choosing a single window keeps the frame view-only.',async()=>{
      await startViewSession(payload);
    },{requestId,sessionId:payload.sessionId});return;
  }
  if(payload.action==='stop_session'){
    const sessionId=payload.sessionId;
    if(typeof sessionId==='string'){await stopPeer(sessionId);await invoke('revoke_control',{sessionId});}
    await publish('response',{requestId,ok:true});return;
  }
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
  state.peers.set(sessionId,{pc,stream,channel:null,canControl,terminalId:null});
  for(const candidate of (state.pendingCandidates.get(sessionId)||[])){try{await pc.addIceCandidate(candidate);}catch{}}
  state.pendingCandidates.delete(sessionId);
  for(const mediaTrack of stream.getTracks())pc.addTrack(mediaTrack,stream);
  pc.ondatachannel=event=>{
    const channel=event.channel;state.peers.get(sessionId).channel=channel;
    channel.onmessage=event=>void handlePeerData(sessionId,event.data);
  };
  pc.onicecandidate=event=>{if(event.candidate)void publishSignal(sessionId,{candidate:event.candidate.toJSON()});};
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))void stopPeer(sessionId);};
  track.addEventListener('ended',()=>void stopPeer(sessionId));
  await pc.setRemoteDescription({type:'offer',sdp:payload.offer.sdp});
  const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
  await publishSignal(sessionId,{answer:pc.localDescription.toJSON(),canControl});
  state.streams.set(sessionId,stream);
  notify('Screen share active. '+(canControl?'Monitor coordinates matched; control can be approved separately.':'View-only: choose the full monitor for coordinate-safe control.'),'success');
}
async function publishSignal(sessionId,signal){await state.channel.send({type:'broadcast',event:'signal',payload:{deviceId:state.deviceId,roomId:state.roomId,sessionId,...signal}});}
async function handleSignal(payload){
  if(payload.deviceId!==state.deviceId||payload.roomId!==state.roomId||typeof payload.sessionId!=='string')return;
  const peer=state.peers.get(payload.sessionId);if(!peer)return;
  if(payload.candidate){try{await peer.pc.addIceCandidate(payload.candidate);}catch{}}
  if(payload.stop){await stopPeer(payload.sessionId);}
}
async function handlePeerData(sessionId,raw){
  const peer=state.peers.get(sessionId);if(!peer)return;
  let message;try{message=JSON.parse(raw);}catch{return;}
  if(!message||typeof message.kind!=='string')return;
  if(message.kind==='input'&&message.event){
    try{await invoke('dispatch_input',{sessionId,event:message.event});}catch(error){notify(error.message,'error');}
  } else if(message.kind==='select_target'){
    try{await invoke('select_draft_target',{sessionId,target:message.target});}catch(error){notify(error.message,'error');}
  } else if(message.kind==='draft'){
    try{const id=await invoke('stage_draft_request',{sessionId,text:message.text});await refreshPending();notify('Draft request '+id+' is waiting for approval on this computer.');}catch(error){notify(error.message,'error');}
  } else if(message.kind==='terminal_input'){
    const terminalId=message.sessionId||peer.terminalId;
    if(!terminalId)return;
    try{await invoke('write_terminal',{sessionId:terminalId,data:message.data});}catch(error){notify(error.message,'error');}
  } else if(message.kind==='terminal_resize'){
    try{await invoke('resize_terminal',{sessionId,cols:message.cols,rows:message.rows});}catch(error){notify(error.message,'error');}
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
    if(state.pending.some(item=>item.requestId===draft.requestId))continue;
    state.pending.push({kind:'draft_text',description:'Insert this exact unsent draft into the region you selected?\n\n'+draft.text,
      requestId:draft.requestId,extra:{sessionId:draft.sessionId},onApprove:async()=>{const result=await invoke('approve_draft_request',{requestId:draft.requestId});notify(result,'success');}});
  }
  renderPending();
}
async function stopPeer(sessionId){
  const peer=state.peers.get(sessionId);if(peer){peer.pc.close();peer.stream?.getTracks().forEach(track=>track.stop());}
  state.peers.delete(sessionId);state.streams.delete(sessionId);state.pendingCandidates.delete(sessionId);
  try{await invoke('revoke_control',{sessionId});}catch{}
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
    for(const id of [...state.peers.keys()])await stopPeer(id);
    await invoke('emergency_stop');
    state.terminals.clear();state.pending=[];renderPending();
    for(const stream of state.streams.values())stream.getTracks().forEach(t=>t.stop());
    state.streams.clear();
    notify('Emergency stop complete. Active permissions and Backroom-launched sessions were revoked.','success');
  }catch(error){notify('Emergency stop needs attention: '+error.message,'error');}
}
async function disconnect(){
  if(state.channel){await state.client.removeChannel(state.channel);state.channel=null;}
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
      if(peer.terminalId===terminalId&&peer.channel?.readyState==='open')peer.channel.send(JSON.stringify({kind:'terminal_output',sessionId:terminalId,data:Array.from(data)}));
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
        state.deviceTokenSaved=status.status!=='revoked';
        document.querySelector('#device-state').textContent=status.status+' · '+status.deviceId.slice(0,8);
        await connectDeviceChannel();
        await loadApps();
      }catch{/* New device: user can register after selecting a group. */}
    }
    await setupTerminalEvents();
  }catch(error){notify(error?.message||'Could not initialize companion.','error');}
}
boot();
