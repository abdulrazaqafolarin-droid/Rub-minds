import { useCallback, useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { Activity, Monitor, Play, Power, RefreshCw, ShieldCheck, SquareTerminal, TextCursorInput, X } from 'lucide-react';
import { supabase } from './supabase';
import { buildScopedDeviceMessage, classifyDeviceResponse, validateDeviceSignal, queueIceCandidate, takeIceCandidates } from '../integrations/backroom/desktop-realtime-protocol.mjs';
import { listBackroomDevices, type BackroomDevice } from './backroomCloudDevices';
import './backroomDesktopControl.css';

type DesktopApp = { app_id: string; app_label: string; executable_sha256: string; discovered_at: string };
type RequestResponse = { requestId: string; ok: boolean; reason?: string; sessionId?: string; pid?: number; cols?: number; rows?: number; shellLabel?: string };
type DragRect = { x: number; y: number; width: number; height: number };
const uuid = () => crypto.randomUUID();
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export default function BackroomDesktopControl({ roomId }: { roomId: string }) {
  const [devices,setDevices] = useState<BackroomDevice[]>([]);
  const [deviceId,setDeviceId] = useState('');
  const [selectedApp,setSelectedApp] = useState('');
  const [loading,setLoading] = useState(false);
  const [channelReady,setChannelReady] = useState(false);
  const [notice,setNotice] = useState('');
  const [noticeError,setNoticeError] = useState(false);
  const [pendingRequest,setPendingRequest] = useState('');
  const [screenSession,setScreenSession] = useState('');
  const [videoReady,setVideoReady] = useState(false);
  const [controlGranted,setControlGranted] = useState(false);
  const [draftGranted,setDraftGranted] = useState(false);
  const [coordinateControl,setCoordinateControl] = useState(false);
  const [selectMode,setSelectMode] = useState(false);
  const [selection,setSelection] = useState<DragRect|null>(null);
  const [draft,setDraft] = useState('');
  const [terminalSession,setTerminalSession] = useState('');
  const [terminalPeerId,setTerminalPeerId] = useState('');
  const [terminalText,setTerminalText] = useState('');
  const [terminalInput,setTerminalInput] = useState('');
  const channelRef=useRef<any>(null);
  const screenSessionRef=useRef('');
  const terminalPeerRef=useRef('');
  const pendingActions=useRef(new Map<string,string>());
  const peerRef=useRef<RTCPeerConnection|null>(null);
  const dataRef=useRef<RTCDataChannel|null>(null);
  const videoRef=useRef<HTMLVideoElement|null>(null);
  const frameRef=useRef<HTMLDivElement|null>(null);
  const dragRef=useRef<{x:number;y:number;pointerId:number}|null>(null);
  const devicesRef=useRef<BackroomDevice[]>([]);
  const pendingCandidatesRef=useRef(new Map<string,RTCIceCandidateInit[]>());
  const selectedDevice=devices.find(d=>d.device_id===deviceId);
  const apps=(selectedDevice?.desktopApps||[]) as DesktopApp[];
  const activeDevices=devices.filter(d=>d.status==='active'&&['windows','macos','linux'].includes(d.platform));

  const flash=useCallback((message:string,isError=false)=>{setNotice(message);setNoticeError(isError);},[]);
  const refresh=useCallback(async()=>{
    if(!roomId)return;
    setLoading(true);
    try{
      const list=await listBackroomDevices(roomId);
      devicesRef.current=list;setDevices(list);
      const active=list.filter(d=>d.status==='active'&&['windows','macos','linux'].includes(d.platform));
      if(!deviceId&&active[0])setDeviceId(active[0].device_id);
      if(deviceId&&!active.some(d=>d.device_id===deviceId))setDeviceId(active[0]?.device_id||'');
    }catch(error){flash(error instanceof Error?error.message:'Could not load connected computers.',true);}
    finally{setLoading(false);}
  },[roomId,deviceId,flash]);
  useEffect(()=>{void refresh();},[refresh]);

  const publish=useCallback(async(event:'command'|'signal',payload:Record<string,unknown>)=>{
    if(!supabase||!deviceId)throw new Error('The authenticated private device channel is not connected.');
    const scoped=buildScopedDeviceMessage(payload,{roomId,deviceId});
    let body:Record<string,unknown>;
    if(event==='command'){
      const {requestId,action,issuedAt,deviceId:_deviceId,roomId:_roomId,...details}=scoped;
      if(typeof requestId!=='string'||typeof action!=='string'||typeof issuedAt!=='number')
        throw new Error('The desktop command is incomplete.');
      body={action:'desktop/command',deviceId,roomId,requestId,issuedAt,command:action,details};
    }else{
      if(typeof scoped.sessionId!=='string'||!scoped.candidate||typeof scoped.candidate!=='object')
        throw new Error('The WebRTC signal is incomplete.');
      body={action:'desktop/signal',deviceId,roomId,sessionId:scoped.sessionId,issuedAt:Date.now(),candidate:scoped.candidate};
    }
    const {data,error}=await supabase.functions.invoke('backroom-device',{body});
    if(error)throw new Error(error.message||'The Rub Minds desktop gateway rejected the request.');
    if(!data||data.ok!==true)throw new Error(typeof data?.reason==='string'?data.reason.replaceAll('_',' '):'The Rub Minds desktop gateway rejected the request.');
    return data;
  },[deviceId,roomId]);

  const sendCommand=useCallback(async(action:string,extra:Record<string,unknown>={})=>{
    const requestId=uuid();setPendingRequest(requestId);pendingActions.current.set(requestId,action);
    await publish('command',{requestId,action,issuedAt:Date.now(),...extra});
    return requestId;
  },[publish]);

  const closePeer=useCallback(async()=>{
    const current=peerRef.current;
    if(current){current.close();peerRef.current=null;}
    dataRef.current=null;
    pendingCandidatesRef.current.clear();
    if(videoRef.current)videoRef.current.srcObject=null;
    setVideoReady(false);setScreenSession('');screenSessionRef.current='';terminalPeerRef.current='';setControlGranted(false);setDraftGranted(false);
    setCoordinateControl(false);setSelectMode(false);setSelection(null);
  },[]);

  useEffect(()=>{
    setChannelReady(false);setPendingRequest('');
    if(!supabase||!deviceId||!roomId){channelRef.current=null;return;}
    let disposed=false;
    const channel=supabase.channel('backroom-device:'+deviceId,{config:{private:true,broadcast:{ack:true,self:false}}});
    channel.on('broadcast',{event:'signal'},async({payload}:any)=>{
      if(disposed)return;
      const signal=validateDeviceSignal(payload,{deviceId,roomId,now:Date.now(),maxAgeMs:120_000});
      if(!signal)return;
      const pc=peerRef.current;
      if(!pc||signal.sessionId!==screenSessionRef.current&&signal.sessionId!==terminalPeerRef.current)return;
      if(signal.answer){
        try{
          await pc.setRemoteDescription(signal.answer);
          for(const candidate of takeIceCandidates(pendingCandidatesRef.current,signal.sessionId)){try{await pc.addIceCandidate(candidate);}catch{/* stale ICE candidate */}}
          setVideoReady(true);
        }catch{flash('The computer returned an invalid screen-share answer.',true);}
      }
      if(typeof signal.canControl==='boolean')setCoordinateControl(signal.canControl);
      if(signal.candidate){
        if(!pc.remoteDescription)queueIceCandidate(pendingCandidatesRef.current,signal.sessionId,signal.candidate);
        else try{await pc.addIceCandidate(signal.candidate);}catch{/* stale ICE candidate */}
      }
      if(signal.stop)void closePeer();
    });
    channel.on('broadcast',{event:'response'},({payload}:any)=>{
      if(disposed||payload?.roomId!==roomId||payload?.deviceId!==deviceId)return;
      if(typeof payload.requestId!=='string')return;
      setPendingRequest(current=>current===payload.requestId?'':current);
      if(!payload.ok){flash(payload.reason==='denied_on_device'?'The request was denied on the computer.':'The computer rejected the request: '+(payload.reason||'unknown reason'),true);return;}
      const responseKind=classifyDeviceResponse(payload);
      if(responseKind==='terminal'){
        setTerminalSession(payload.sessionId);setTerminalText('Terminal ready · '+(payload.shellLabel||'native shell')+'\\n');flash('Native terminal started on the selected computer.');
      }else if(responseKind==='launch'){flash('Application launched on the selected computer.');}
      else if(responseKind==='control'){setControlGranted(true);flash('Local computer-control permission approved.');}
      else if(responseKind==='draft'){setDraftGranted(true);flash('Local draft-typing permission approved.');}
      else if(responseKind==='view'){flash('The computer approved the live screen request.');}
      else if(responseKind==='stop'){void closePeer();setTerminalSession('');flash('The computer stopped the session.');}
    });
    channel.subscribe((status:string)=>{
      if(disposed)return;
      setChannelReady(status==='SUBSCRIBED');
      if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')flash('Private device channel is unavailable. Check group membership and Realtime private-channel settings.',true);
    });
    channelRef.current=channel;
    return ()=>{disposed=true;channelRef.current=null;void supabase.removeChannel(channel);};
  },[deviceId,roomId,closePeer,flash]);

  useEffect(()=>()=>{void closePeer();},[closePeer]);

  const launchApp=async()=>{
    if(!selectedApp)return flash('Select an installed application first.',true);
    try{await sendCommand('launch_app',{appId:selectedApp});flash('Launch request sent. Approve it on the computer to continue.');}
    catch(error){flash(error instanceof Error?error.message:'Could not request launch.',true);}
  };
  const startTerminal=async()=>{
    try{
      const peerId=uuid();const pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']}]});
      const data=pc.createDataChannel('backroom-terminal',{ordered:true});dataRef.current=data;peerRef.current=pc;screenSessionRef.current=peerId;setTerminalPeerId(peerId);terminalPeerRef.current=peerId;setTerminalText('Waiting for local terminal approval…\\n');
      data.onmessage=event=>{let message:any;try{message=JSON.parse(event.data);}catch{return;}if(message.kind==='terminal_output'){const output=new TextDecoder().decode(new Uint8Array(message.data||[]));setTerminalText(old=>(old+output).slice(-30000));}};
      const pendingIce:RTCIceCandidateInit[]=[];let sessionCreated=false;
      pc.onicecandidate=event=>{
        if(!event.candidate)return;
        const candidate=event.candidate.toJSON();
        if(!sessionCreated){pendingIce.push(candidate);return;}
        void publish('signal',{sessionId:peerId,candidate}).catch(error=>flash(String(error),true));
      };
      pc.onconnectionstatechange=()=>{
        if(pc.connectionState==='failed'||pc.connectionState==='disconnected'){
          flash('Terminal data connection interrupted. The local terminal will be stopped.',true);
          void sendCommand('stop_session',{sessionId:peerId}).catch(()=>{});
          void closePeer();
        }
      };
      const offer=await pc.createOffer();await pc.setLocalDescription(offer);
      await sendCommand('terminal_start',{sessionId:peerId,offer:{sdp:pc.localDescription?.sdp}});
      sessionCreated=true;for(const candidate of pendingIce)await publish('signal',{sessionId:peerId,candidate});
      flash('Native terminal request sent. Approve it on the computer.');
    }catch(error){await closePeer();flash(error instanceof Error?error.message:'Could not request terminal.',true);}
  };
  const startScreen=async()=>{
    if(!channelReady)return flash('Connect the device channel first.',true);
    if(peerRef.current)await closePeer();
    const sessionId=uuid();screenSessionRef.current=sessionId;
    const pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']}]});
    const data=pc.createDataChannel('backroom-input',{ordered:true});
    dataRef.current=data;peerRef.current=pc;setScreenSession(sessionId);setTerminalPeerId('');
    pc.ontrack=event=>{if(videoRef.current)videoRef.current.srcObject=event.streams[0];setVideoReady(true);};
    const pendingIce:RTCIceCandidateInit[]=[];let sessionCreated=false;
    pc.onicecandidate=event=>{
      if(!event.candidate)return;
      const candidate=event.candidate.toJSON();
      if(!sessionCreated){pendingIce.push(candidate);return;}
      void publish('signal',{sessionId,candidate}).catch(error=>flash(String(error),true));
    };
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='failed'||pc.connectionState==='disconnected'){
        flash('Screen connection interrupted. The local stream will be stopped.',true);
        void sendCommand('stop_session',{sessionId}).catch(()=>{});
        void closePeer();
      }
    };
    data.onmessage=event=>{
      let message:any;try{message=JSON.parse(event.data);}catch{return;}
      if(message.kind==='terminal_output'){
        const text=new TextDecoder().decode(new Uint8Array(message.data||[]));
        setTerminalText(old=>(old+text).slice(-30000));
      }else if(message.kind==='draft_result'){
        flash(message.ok===true
          ?'Draft inserted into the selected area on the computer. No Send or Enter action was triggered.'
          :'Draft was not inserted: '+(message.result||'denied on the computer.'));
      }
    };
    try{
      const offer=await pc.createOffer();await pc.setLocalDescription(offer);
      await sendCommand('view_offer',{sessionId,offer:{sdp:pc.localDescription?.sdp}});
      sessionCreated=true;for(const candidate of pendingIce)await publish('signal',{sessionId,candidate});
      flash('View request sent. The companion must approve it and you must choose a monitor in the operating-system picker.');
    }catch(error){await closePeer();flash(error instanceof Error?error.message:'Could not create the screen-share request.',true);}
  };

  const requestControl=async()=>{
    if(!screenSession)return flash('Start a live view first.',true);
    if(!coordinateControl)return flash('The computer selected a window or capture dimensions did not match. Choose the entire monitor for coordinate-safe input.',true);
    try{await sendCommand('request_control',{sessionId:screenSession});flash('Control request sent. Approve it locally on the computer.');}
    catch(error){flash(error instanceof Error?error.message:'Could not request control.',true);}
  };
  const requestDraftPermission=async()=>{
    if(!controlGranted||!screenSession)return;
    try{await sendCommand('request_draft_permission',{sessionId:screenSession});flash('Separate typing permission requested. Approve it on the computer.');}
    catch(error){flash(error instanceof Error?error.message:'Could not request typing permission.',true);}
  };
  const stop=async()=>{
    try{
      const peerId=screenSessionRef.current||terminalPeerId;
      if(peerId)await sendCommand('stop_session',{sessionId:peerId,...(terminalSession?{terminalSessionId:terminalSession}:{})});
    }catch{/* the local device can still revoke its own grants */}
    await closePeer();setTerminalSession('');setTerminalPeerId('');terminalPeerRef.current='';setTerminalText('');
  };

  const videoContentRect=()=>{
    const el=videoRef.current;if(!el)return null;
    const box=el.getBoundingClientRect();const vw=el.videoWidth||box.width;const vh=el.videoHeight||box.height;
    const scale=Math.min(box.width/vw,box.height/vh);
    const width=vw*scale,height=vh*scale;
    return {left:box.left+(box.width-width)/2,top:box.top+(box.height-height)/2,width,height};
  };
  const normalized=(clientX:number,clientY:number)=>{
    const rect=videoContentRect();if(!rect)return null;
    const x=(clientX-rect.left)/rect.width,y=(clientY-rect.top)/rect.height;
    if(x<0||x>1||y<0||y>1)return null;
    return {x,y};
  };
  const sendData=(message:Record<string,unknown>)=>{
    const data=dataRef.current;if(!data||data.readyState!=='open')throw new Error('Interactive data channel is not ready.');
    data.send(JSON.stringify(message));
  };
  const pointerDown=(e:PointerEvent<HTMLDivElement>)=>{
    if(selectMode){
      const point=normalized(e.clientX,e.clientY);if(!point)return;
      dragRef.current={...point,pointerId:e.pointerId};e.currentTarget.setPointerCapture(e.pointerId);return;
    }
    if(!controlGranted)return;
    const point=normalized(e.clientX,e.clientY);if(!point)return;
    try{sendData({kind:'input',event:{kind:'move',...point}});}catch(error){flash(String(error),true);}
  };
  const pointerMove=(e:PointerEvent<HTMLDivElement>)=>{
    if(selectMode&&dragRef.current?.pointerId===e.pointerId){
      const p=normalized(e.clientX,e.clientY);if(!p)return;
      const x=Math.min(dragRef.current.x,p.x),y=Math.min(dragRef.current.y,p.y);
      setSelection({x,y,width:Math.abs(p.x-dragRef.current.x),height:Math.abs(p.y-dragRef.current.y)});
      return;
    }
    if(controlGranted&&dataRef.current?.readyState==='open'){
      const point=normalized(e.clientX,e.clientY);if(point)sendData({kind:'input',event:{kind:'move',...point}});
    }
  };
  const pointerUp=(e:PointerEvent<HTMLDivElement>)=>{
    if(selectMode&&dragRef.current?.pointerId===e.pointerId){
      const p=normalized(e.clientX,e.clientY);const start=dragRef.current;dragRef.current=null;
      if(!p)return;
      const target={x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),width:Math.abs(p.x-start.x),height:Math.abs(p.y-start.y)};
      if(target.width<0.01||target.height<0.01)return flash('Drag a rectangle over the exact typing area.',true);
      setSelection(target);
      try{sendData({kind:'select_target',target});flash('Typing area sent to the computer. The device will require local approval before inserting text.');}
      catch(error){flash(String(error),true);}
      return;
    }
    if(controlGranted){
      const point=normalized(e.clientX,e.clientY);if(point)try{sendData({kind:'input',event:{kind:'click',...point,button:'left'}});}catch(error){flash(String(error),true);}
    }
  };
  const keyDown=(e:KeyboardEvent<HTMLDivElement>)=>{
    if(!controlGranted||!dataRef.current||e.ctrlKey||e.metaKey||e.altKey)return;
    e.preventDefault();
    const event=e.key.length===1?{kind:'text',text:e.key}:{kind:'key',key:e.key};
    try{sendData({kind:'input',event});}catch(error){flash(String(error),true);}
  };
  const requestDraft=()=>{
    if(!draft.trim()||!draftGranted)return;
    try{sendData({kind:'draft',text:draft});flash('Draft submitted to the computer for a separate local confirmation. It will not be sent.');}
    catch(error){flash(String(error),true);}
  };
  const terminalSend=()=>{
    if(!terminalSession||!terminalInput)return;
    try{sendData({kind:'terminal_input',sessionId:terminalSession,data:terminalInput+'\r'});setTerminalInput('');}
    catch(error){flash(String(error),true);}
  };
  const selectedIsWindows=selectedDevice?.platform==='windows';

  return <section className="br-panel br-desktop-control">
    <div className="br-desktop-head">
      <div><span className="br-eyebrow"><Monitor size={13}/> ACTUAL COMPUTER</span><h2>Desktop & terminal execution</h2><p>Run installed apps on the registered computer. Requests always require approval on that computer.</p></div>
      <button type="button" className="br-desktop-refresh" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={14}/>{loading?'Checking…':'Refresh'}</button>
    </div>
    {!activeDevices.length?<div className="br-desktop-empty"><Monitor size={27}/><b>No connected desktop companion</b><p>Install and open Rub Minds Backroom Companion on the actual Windows computer. Sign in using the same account and select the group. You do not need a localhost address or pairing code.</p></div>:
      <>
        <label className="br-desktop-label" htmlFor="br-desktop-device">Connected computer</label>
        <select id="br-desktop-device" value={deviceId} onChange={e=>{setDeviceId(e.target.value);void closePeer();setTerminalSession('');setControlGranted(false);setDraftGranted(false);}}>
          {activeDevices.map(device=><option key={device.device_id} value={device.device_id}>{device.device_label} · {device.platform}</option>)}
        </select>
        <div className="br-desktop-device-meta"><span className="br-desktop-dot"/>{channelReady?'Private device channel ready':'Waiting for authenticated device channel'} · {selectedDevice?.last_seen_at?'Seen '+new Date(selectedDevice.last_seen_at).toLocaleString():'Awaiting heartbeat'}</div>
        <div className="br-desktop-actions">
          <div className="br-desktop-app-launch">
            <label className="br-desktop-label" htmlFor="br-desktop-app">Selected installed application</label>
            <select id="br-desktop-app" value={selectedApp} onChange={e=>setSelectedApp(e.target.value)}>
              <option value="">Choose an app registered on the computer</option>
              {apps.map(app=><option key={app.app_id} value={app.app_id}>{app.app_label}</option>)}
            </select>
            <button type="button" onClick={()=>void launchApp()} disabled={!channelReady||!selectedApp}><Play size={14}/> Request app launch</button>
          </div>
          <button type="button" className="br-desktop-terminal" onClick={()=>void startTerminal()} disabled={!channelReady}><SquareTerminal size={15}/> Start native terminal</button>
          <button type="button" className="br-desktop-screen" onClick={()=>void startScreen()} disabled={!channelReady||!!screenSession}><Monitor size={15}/> Request live screen</button>
        </div>
        {(screenSession||terminalSession)&&<div className="br-desktop-live">
          <div className="br-desktop-live-title"><b>Active computer session</b><button type="button" onClick={()=>void stop()}><Power size={14}/> Stop session</button></div>
          {screenSession&&<div className="br-desktop-frame-wrap">
            <div className="br-desktop-video" ref={frameRef} tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onKeyDown={keyDown}>
              <video ref={videoRef} autoPlay muted playsInline/>
              {!videoReady&&<div className="br-desktop-video-empty">Waiting for the computer to approve and share its display…</div>}
              {selection&&<div className="br-desktop-selection" style={{left:(selection.x*100)+'%',top:(selection.y*100)+'%',width:(selection.width*100)+'%',height:(selection.height*100)+'%'}}/>}
            </div>
            <div className="br-desktop-toolbar">
              <span>{videoReady?'Live computer display':'View request pending'}{coordinateControl?' · full-monitor geometry verified':' · view-only unless full monitor selected'}</span>
              <button type="button" onClick={()=>void requestControl()} disabled={!videoReady||!coordinateControl||controlGranted}>Request control</button>
              <button type="button" onClick={()=>setSelectMode(v=>!v)} disabled={!controlGranted||!draftGranted}>{selectMode?'Cancel area selection':'Drag-select typing area'}</button>
              <button type="button" onClick={()=>void requestDraftPermission()} disabled={!controlGranted||draftGranted}><TextCursorInput size={13}/> Request typing permission</button>
            </div>
            {controlGranted&&draftGranted&&<div className="br-desktop-draft">
              <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={2} maxLength={4000} placeholder="Write the text to insert in the selected area. It will never press Enter or Send."/>
              <button type="button" onClick={requestDraft} disabled={!selection||!draft.trim()}>Request draft insertion</button>
            </div>}
            {controlGranted&&<div className="br-desktop-caption">Computer control is locally approved for a limited time. The user at the computer can revoke it immediately. Draft typing has a second independent approval and never sends or submits.</div>}
          </div>}
          {(terminalSession||terminalPeerId)&&<div className="br-terminal-remote">
            <div className="br-terminal-remote-head"><SquareTerminal size={15}/> Native terminal · actual computer</div>
            <pre>{terminalText||'Waiting for terminal output…'}</pre>
            <div className="br-terminal-input"><input value={terminalInput} onChange={e=>setTerminalInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')terminalSend();}} placeholder={controlGranted?'Enter a terminal command…':'Request control on the terminal session first'} disabled={!controlGranted}/><button type="button" onClick={terminalSend} disabled={!controlGranted||!terminalInput}>Run</button></div>
            {!controlGranted&&terminalSession&&<button type="button" onClick={()=>void sendCommand('request_control',{sessionId:terminalSession,peerSessionId:terminalPeerId})}>Request terminal control</button>}
          </div>}
        </div>}
      </>
    }
    {notice&&<div className={'br-desktop-notice'+(noticeError?' error':'')} role="status">{notice}</div>}
    <div className="br-desktop-foot"><ShieldCheck size={14}/> App inventory shares labels and fingerprints only. Executable paths, app data, passwords and files stay on the computer. Screen sharing uses the OS picker; input and typing are separately approved.</div>
  </section>;
}
