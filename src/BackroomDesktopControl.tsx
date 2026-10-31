import { useCallback, useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { Activity, Monitor, Play, Power, RefreshCw, ShieldCheck, SquareTerminal, TextCursorInput, X } from 'lucide-react';
import { supabase } from './supabase';
import { buildScopedDeviceMessage, classifyDeviceResponse, validateDeviceSignal, queueIceCandidate, takeIceCandidates } from '../integrations/backroom/desktop-realtime-protocol.mjs';
import { waitForIceGatheringComplete } from '../integrations/backroom/ice-gathering.mjs';
import { getContainedVideoRect, mapVideoSelectionToFrame, normalizeClientPointToVideo, createNormalizedDragSelection } from '../integrations/backroom/video-selection-overlay.mjs';
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
  const [targetStatus,setTargetStatus] = useState('');
  const [draft,setDraft] = useState('');
  const [terminalSession,setTerminalSession] = useState('');
  const [terminalPeerId,setTerminalPeerId] = useState('');
  const [terminalText,setTerminalText] = useState('');
  const [terminalInput,setTerminalInput] = useState('');
  const [terminalDraftReady,setTerminalDraftReady] = useState(false);
  const [terminalDraftSending,setTerminalDraftSending] = useState(false);
  const channelRef=useRef<any>(null);
  const screenSessionRef=useRef('');
  const terminalPeerRef=useRef('');
  const pendingActions=useRef(new Map<string,string>());
  const sessionStartTimers=useRef(new Map<string,{timer:number;sessionId:string}>());
  const abandonedSessions=useRef(new Set<string>());
  const peerRef=useRef<RTCPeerConnection|null>(null);
  const dataRef=useRef<RTCDataChannel|null>(null);
  const videoRef=useRef<HTMLVideoElement|null>(null);
  const incomingStreamRef=useRef<MediaStream|null>(null);
  const frameRef=useRef<HTMLDivElement|null>(null);
  const dragRef=useRef<{x:number;y:number;pointerId:number}|null>(null);
  const targetAttemptRef=useRef('');
  const draftAttemptRef=useRef('');
  const terminalActionRef=useRef<{requestId:string;action:'draft'|'submit';text?:string}|null>(null);
  const draftGrantTimerRef=useRef<number|null>(null);
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
      const requestId=scoped.requestId,action=scoped.action,issuedAt=scoped.issuedAt;
      if(typeof requestId!=='string'||typeof action!=='string'||typeof issuedAt!=='number')
        throw new Error('The desktop command is incomplete.');
      const details=Object.fromEntries(Object.entries(scoped).filter(([key])=>
        !['requestId','action','issuedAt','deviceId','roomId'].includes(key)));
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

  const clearSessionStartTimers=useCallback((requestId?:string,sessionId?:string)=>{
    for(const [id,entry] of sessionStartTimers.current){
      if((requestId&&id===requestId)||(sessionId&&entry.sessionId===sessionId)){
        window.clearTimeout(entry.timer);
        sessionStartTimers.current.delete(id);
      }
    }
  },[]);
  const abandonSession=useCallback(async(sessionId:string)=>{
    if(!isUuid(sessionId)||!supabase||!deviceId||!roomId)return false;
    abandonedSessions.current.add(sessionId);
    clearSessionStartTimers(undefined,sessionId);
    window.setTimeout(()=>abandonedSessions.current.delete(sessionId),5*60*1000);
    const {data,error}=await supabase.functions.invoke('backroom-device',{body:{
      action:'desktop/session-abandon',deviceId,roomId,sessionId,requestId:uuid(),issuedAt:Date.now()
    }});
    if(error||!data||data.ok!==true)throw new Error(error?.message||data?.reason||'Could not abandon the unanswered desktop session.');
    return true;
  },[deviceId,roomId,clearSessionStartTimers]);
  const sendCommand=useCallback(async(action:string,extra:Record<string,unknown>={})=>{
    const requestId=uuid();setPendingRequest(requestId);pendingActions.current.set(requestId,action);
    try{
      await publish('command',{requestId,action,issuedAt:Date.now(),...extra});
      if((action==='terminal_start'||action==='view_offer')&&typeof extra.sessionId==='string'&&isUuid(extra.sessionId)){
        const sessionId=extra.sessionId;
        const timer=window.setTimeout(()=>{
          sessionStartTimers.current.delete(requestId);
          pendingActions.current.delete(requestId);
          setPendingRequest(current=>current===requestId?'':current);
          void abandonSession(sessionId).then(()=>{
            flash('The computer did not respond within 45 seconds. The pending screen/terminal session was stopped; you can retry.',true);
          }).catch(error=>{
            flash(error instanceof Error?error.message:'The unanswered session could not be closed. It will expire automatically.',true);
          });
        },45_000);
        sessionStartTimers.current.set(requestId,{timer,sessionId});
      }
      return requestId;
    }catch(error){
      pendingActions.current.delete(requestId);
      clearSessionStartTimers(requestId);
      setPendingRequest(current=>current===requestId?'':current);
      throw error;
    }
  },[publish,abandonSession,clearSessionStartTimers,flash]);

  const closePeer=useCallback(async()=>{
    if(draftGrantTimerRef.current!==null){
      window.clearTimeout(draftGrantTimerRef.current);
      draftGrantTimerRef.current=null;
    }
    const current=peerRef.current;
    if(current){current.close();peerRef.current=null;}
    dataRef.current=null;
    pendingCandidatesRef.current.clear();
    incomingStreamRef.current=null;
    if(videoRef.current)videoRef.current.srcObject=null;
    setVideoReady(false);setScreenSession('');screenSessionRef.current='';terminalPeerRef.current='';setControlGranted(false);setDraftGranted(false);
    setCoordinateControl(false);setSelectMode(false);setSelection(null);setTargetStatus('');dragRef.current=null;targetAttemptRef.current='';draftAttemptRef.current='';
  },[]);

  // Keep a stream received before React mounts the video element; attach it once
  // the active screen session has rendered its live-frame element.
  useEffect(()=>{
    const video=videoRef.current;
    const stream=incomingStreamRef.current;
    if(!screenSession||!video||!stream)return;
    if(video.srcObject!==stream)video.srcObject=stream;
  },[screenSession]);

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
      clearSessionStartTimers(payload.requestId);
      if(payload.capability==='stop'&&typeof payload.sessionId==='string')clearSessionStartTimers(undefined,payload.sessionId);
      setPendingRequest(current=>current===payload.requestId?'':current);pendingActions.current.delete(payload.requestId);
      if(typeof payload.sessionId==='string'&&abandonedSessions.current.has(payload.sessionId)){
        void publish('command',{requestId:uuid(),action:'stop_session',issuedAt:Date.now(),sessionId:payload.sessionId}).catch(()=>{});
        return;
      }
      if(!payload.ok){flash(payload.reason==='denied_on_device'?'The request was denied on the computer.':'The computer rejected the request: '+(payload.reason||'unknown reason'),true);return;}
      const responseKind=classifyDeviceResponse(payload);
      if(responseKind==='terminal'){
        setTerminalSession(payload.sessionId);setTerminalText('Terminal ready · '+(payload.shellLabel||'native shell')+'\\n');flash('Native terminal started on the selected computer.');
      }else if(responseKind==='launch'){flash('Application launched on the selected computer.');}
      else if(responseKind==='control'){setControlGranted(true);flash('Local computer-control permission approved.');}
      else if(responseKind==='draft'){
        if(draftGrantTimerRef.current!==null)window.clearTimeout(draftGrantTimerRef.current);
        setDraftGranted(true);
        setTerminalDraftReady(false);
        const lifetimeSeconds=typeof payload.expiresSeconds==='number'&&Number.isFinite(payload.expiresSeconds)
          ?Math.min(120,Math.max(1,payload.expiresSeconds)):60;
        // Expire the UI slightly before the native grant so delayed UI state
        // can never leave an enabled control after native authorization ends.
        draftGrantTimerRef.current=window.setTimeout(()=>{
          draftGrantTimerRef.current=null;
          setDraftGranted(false);
          setTerminalDraftReady(false);
        },Math.max(0,lifetimeSeconds*1000-1500));
        flash('Local draft-typing permission approved. It will expire automatically.');
      }
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
  },[deviceId,roomId,closePeer,flash,clearSessionStartTimers]);

  useEffect(()=>{
    const timer=window.setInterval(()=>{
      const sessionId=screenSessionRef.current||terminalPeerRef.current;
      const channel=dataRef.current;
      if(!sessionId||!channel||channel.readyState!=='open')return;
      try{channel.send(JSON.stringify({kind:'heartbeat',sessionId,sentAt:Date.now()}));}catch{}
    },15_000);
    return ()=>window.clearInterval(timer);
  },[]);

  useEffect(()=>()=>{
    const activeSessionId=screenSessionRef.current||terminalPeerRef.current;
    if(activeSessionId)void abandonSession(activeSessionId).catch(()=>{});
    for(const entry of sessionStartTimers.current.values())window.clearTimeout(entry.timer);
    sessionStartTimers.current.clear();
    void closePeer();
  },[closePeer,abandonSession]);


  const stopActivePeer=useCallback(async()=>{
    const peerId=screenSessionRef.current||terminalPeerRef.current;
    if(peerId){
      clearSessionStartTimers(undefined,peerId);
      try{await sendCommand('stop_session',{sessionId:peerId});}
      catch{try{await abandonSession(peerId);}catch{}}
    }
    await closePeer();setTerminalSession('');setTerminalPeerId('');terminalPeerRef.current='';setTerminalText('');
    terminalActionRef.current=null;setTerminalDraftReady(false);setTerminalDraftSending(false);setTerminalInput('');
  },[sendCommand,abandonSession,clearSessionStartTimers,closePeer]);

  const launchApp=async()=>{
    if(!selectedApp)return flash('Select an installed application first.',true);
    try{await sendCommand('launch_app',{appId:selectedApp});flash('Launch request sent. Approve it on the computer to continue.');}
    catch(error){flash(error instanceof Error?error.message:'Could not request launch.',true);}
  };
  const startTerminal=async()=>{
    if(peerRef.current)await stopActivePeer();
    setDraftGranted(false);setTerminalDraftReady(false);setTerminalDraftSending(false);
    if(draftGrantTimerRef.current!==null){window.clearTimeout(draftGrantTimerRef.current);draftGrantTimerRef.current=null;}
    terminalActionRef.current=null;
    try{
      const peerId=uuid();const pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']}]});
      const data=pc.createDataChannel('backroom-terminal',{ordered:true});dataRef.current=data;peerRef.current=pc;screenSessionRef.current=peerId;setTerminalPeerId(peerId);terminalPeerRef.current=peerId;setTerminalText('Waiting for local terminal approval…\\n');
      data.onmessage=event=>{
        let message:any;try{message=JSON.parse(event.data);}catch{return;}
        if(message.kind==='terminal_output'){
          const output=new TextDecoder().decode(new Uint8Array(message.data||[]));
          setTerminalText(old=>(old+output).slice(-30000));
          return;
        }
        if(message.kind==='terminal_action_result'){
          const pending=terminalActionRef.current;
          if(!pending||pending.requestId!==message.requestId||pending.action!==message.action)return;
          terminalActionRef.current=null;
          setTerminalDraftSending(false);
          if(message.ok===true&&message.action==='draft'){
            setTerminalInput(current=>current===pending.text?'':current);
            setTerminalDraftReady(true);
            flash('Draft text was written to the active PTY. Check the Claude Code/OpenCode prompt; Enter has not been sent.');
          }else if(message.ok===true&&message.action==='submit'){
            setTerminalDraftReady(false);
            flash('Enter was sent to the active terminal session.');
          }else{
            if(message.action==='submit')setTerminalDraftReady(true);
            flash(typeof message.reason==='string'?message.reason:'The terminal action was rejected.',true);
          }
        }
      };
      pc.onconnectionstatechange=()=>{
        if(pc.connectionState==='failed'||pc.connectionState==='disconnected'){
          flash('Terminal data connection interrupted. The local terminal will be stopped.',true);
          void stopActivePeer();
        }
      };
      const offer=await pc.createOffer();await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      await sendCommand('terminal_start',{sessionId:peerId,offer:{sdp:pc.localDescription?.sdp}});
      flash('Native terminal request sent. Approve it on the computer.');
    }catch(error){await closePeer();flash(error instanceof Error?error.message:'Could not request terminal.',true);}
  };
  const startScreen=async()=>{
    if(!channelReady)return flash('Connect the device channel first.',true);
    if(peerRef.current)await stopActivePeer();
    const sessionId=uuid();screenSessionRef.current=sessionId;
    const pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']}]});
    const data=pc.createDataChannel('backroom-input',{ordered:true});
    dataRef.current=data;peerRef.current=pc;setScreenSession(sessionId);setTerminalPeerId('');
    pc.ontrack=event=>{
      if(peerRef.current!==pc||screenSessionRef.current!==sessionId)return;
      const stream=event.streams[0]??new MediaStream([event.track]);
      incomingStreamRef.current=stream;
      for(const track of stream.getVideoTracks()){
        track.addEventListener('ended',()=>{
          if(incomingStreamRef.current===stream)setVideoReady(false);
        });
      }
      const video=videoRef.current;
      if(video&&video.srcObject!==stream)video.srcObject=stream;
    };
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='failed'||pc.connectionState==='disconnected'){
        flash('Screen connection interrupted. The local stream will be stopped.',true);
        void stopActivePeer();
      }
    };
    data.onmessage=event=>{
      let message:any;try{message=JSON.parse(event.data);}catch{return;}
      if(message.kind==='terminal_output'){
        const text=new TextDecoder().decode(new Uint8Array(message.data||[]));
        setTerminalText(old=>(old+text).slice(-30000));
      }else if(message.kind==='target_result'){
        if(typeof message.requestId!=='string'||message.requestId!==targetAttemptRef.current)return;
        const ok=message.ok===true;
        const reason=typeof message.reason==='string'?message.reason:'The selected area could not be verified.';
        setTargetStatus(ok?'Verified editable field · '+reason:'Target rejected · '+reason);
        if(!ok){setSelection(null);targetAttemptRef.current='';}
        flash(ok?'The selected area is a verified empty editable field.':reason,!ok);
      }else if(message.kind==='draft_result'){
        if(typeof message.requestId!=='string'||message.requestId!==draftAttemptRef.current)return;
        draftAttemptRef.current='';
        targetAttemptRef.current='';
        setSelection(null);
        setTargetStatus('');
        try{sendData({kind:'clear_target'});}
        catch(error){flash('Draft finished, but the target could not be cleared. Stopping this remote session for safety.',true);void stopActivePeer();return;}
        flash(message.ok===true
          ?'Text inserted into the verified editable field and read back. Select a fresh empty field before another draft. No Send or Enter action was triggered.'
          :'Draft was not verified: '+(message.result||'the computer did not confirm the exact insertion. Inspect the field before retrying; no automatic retry was attempted.'),message.ok!==true);
      }
    };
    try{
      const offer=await pc.createOffer();await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      await sendCommand('view_offer',{sessionId,...(selectedApp?{appId:selectedApp}:{}),offer:{sdp:pc.localDescription?.sdp}});
      flash(selectedApp
        ?'View request sent. Approve it on the computer, then choose a monitor for interactive control (or a single app window for viewing only).'
        :'View request sent. Approve it on the computer, then choose a monitor for desktop-wide control. A window without a Backroom-launched app identity remains view-only.');
    }catch(error){await closePeer();flash(error instanceof Error?error.message:'Could not create the screen-share request.',true);}
  };

  const requestControl=async()=>{
    if(!screenSession)return flash('Start a live view first.',true);
    if(!coordinateControl)return flash('The selected capture could not be securely bound to the expected app window or monitor. Choose the entire monitor for interactive control. Single-window capture is view-only.',true);
    try{await sendCommand('request_control',{sessionId:screenSession});flash('Control request sent. Approve it locally on the computer.');}
    catch(error){flash(error instanceof Error?error.message:'Could not request control.',true);}
  };
  const requestDraftPermission=async()=>{
    if(!selectedIsWindows)return flash('Verified desktop drag-select typing is currently available on Windows only.',true);
    if(!controlGranted||!screenSession)return;
    try{await sendCommand('request_draft_permission',{sessionId:screenSession});flash('Separate typing permission requested. Approve it on the computer.');}
    catch(error){flash(error instanceof Error?error.message:'Could not request typing permission.',true);}
  };
  const requestTerminalDraftPermission=async()=>{
    if(!controlGranted||!terminalSession)return;
    try{
      await sendCommand('request_draft_permission',{sessionId:terminalSession});
      flash('Separate terminal draft-typing permission requested. Approve it on the computer.');
    }catch(error){
      flash(error instanceof Error?error.message:'Could not request terminal draft permission.',true);
    }
  };
  const stop=async()=>{await stopActivePeer();};

  const videoContentRect=()=>{
    const el=videoRef.current;if(!el||el.videoWidth<=0||el.videoHeight<=0)return null;
    const box=el.getBoundingClientRect();
    return getContainedVideoRect(box,el.videoWidth,el.videoHeight);
  };
  const normalized=(clientX:number,clientY:number)=>{
    return normalizeClientPointToVideo(videoContentRect(),clientX,clientY);
  };
  // Selection coordinates are normalized to the actual video content, not
  // the 16:9 letterbox wrapper. Map them back into the wrapper for the overlay.
  const selectionOverlayStyle=()=>{
    if(!selection)return undefined;
    const frame=frameRef.current?.getBoundingClientRect();
    const mapped=mapVideoSelectionToFrame(videoContentRect(),frame||null,selection);
    if(!mapped)return undefined;
    return {
      left:mapped.left+'%',
      top:mapped.top+'%',
      width:mapped.width+'%',
      height:mapped.height+'%',
    };
  };
  const sendData=(message:Record<string,unknown>)=>{
    const data=dataRef.current;if(!data||data.readyState!=='open')throw new Error('Interactive data channel is not ready.');
    data.send(JSON.stringify(message));
  };
  const hasActiveDraftTarget=()=>Boolean(
    selection||targetAttemptRef.current||draftAttemptRef.current||
    targetStatus.startsWith('Verified editable field ·')||
    targetStatus.startsWith('Draft awaiting local approval')
  );
  const pointerDown=(e:PointerEvent<HTMLDivElement>)=>{
    if(selectMode){
      if(e.button!==0)return;
      e.preventDefault();
      const point=normalized(e.clientX,e.clientY);
      if(!point)return flash('Wait for the live display to finish loading, then drag inside the visible screen.',true);
      setTargetStatus('');setSelection(null);targetAttemptRef.current='';draftAttemptRef.current='';
      try{sendData({kind:'clear_target'});}
      catch(error){flash('Could not clear the previous typing target. Stopping this remote session for safety.',true);void stopActivePeer();return;}
      dragRef.current={...point,pointerId:e.pointerId};e.currentTarget.setPointerCapture(e.pointerId);return;
    }
    if(!controlGranted)return;
    const point=normalized(e.clientX,e.clientY);if(!point)return;
    if(hasActiveDraftTarget()){
      targetAttemptRef.current='';draftAttemptRef.current='';
      setSelection(null);
      setTargetStatus('Manual computer interaction changed the typing target. Drag-select it again before requesting a draft.');
      try{sendData({kind:'clear_target'});}
      catch(error){flash('Could not clear the previous typing target. Stopping this remote session for safety.',true);void stopActivePeer();return;}
    }
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
      if(!p){setSelection(null);setTargetStatus('Drag ended outside the live display. No typing target is selected.');return;}
      const target=createNormalizedDragSelection(start,p);
      if(!target){setSelection(null);setTargetStatus('');return flash('Drag a larger rectangle over the exact typing area.',true);}
      const requestId=uuid();targetAttemptRef.current=requestId;
      setSelection(target);setTargetStatus('Checking the selected area against Windows accessibility…');
      try{sendData({kind:'select_target',requestId,target});flash('Checking that the selected area resolves to one empty editable field or multi-line editor.');}
      catch(error){
        targetAttemptRef.current='';setSelection(null);
        setTargetStatus('Target check could not be sent. Reconnect the computer and drag-select again.');
        flash(String(error),true);
      }
      return;
    }
    if(controlGranted){
      const point=normalized(e.clientX,e.clientY);if(point)try{sendData({kind:'input',event:{kind:'click',...point,button:'left'}});}catch(error){flash(String(error),true);}
    }
  };
  const pointerCancel=(e:PointerEvent<HTMLDivElement>)=>{
    if(dragRef.current?.pointerId!==e.pointerId)return;
    dragRef.current=null;
    targetAttemptRef.current='';
    setSelection(null);
    setTargetStatus('Drag cancelled. No typing target is selected.');
  };
  const keyDown=(e:KeyboardEvent<HTMLDivElement>)=>{
    if(!controlGranted||!dataRef.current||e.ctrlKey||e.metaKey||e.altKey)return;
    e.preventDefault();
    if(selection||targetStatus||draftAttemptRef.current){
      targetAttemptRef.current='';draftAttemptRef.current='';setSelection(null);
      setTargetStatus('Manual computer interaction changed the typing target. Drag-select it again before requesting a draft.');
      try{sendData({kind:'clear_target'});}
      catch(error){flash('Could not clear the previous typing target. Stopping this remote session for safety.',true);void stopActivePeer();return;}
    }
    const event=e.key.length===1?{kind:'text',text:e.key}:{kind:'key',key:e.key};
    try{sendData({kind:'input',event});}catch(error){flash(String(error),true);}
  };
  const requestDraft=()=>{
    if(!draft.trim()||!draftGranted||!targetStatus.startsWith('Verified editable field ·')||draftAttemptRef.current)return;
    const requestId=uuid();
    draftAttemptRef.current=requestId;
    setTargetStatus('Draft awaiting local approval on the computer…');
    try{
      sendData({kind:'draft',requestId,text:draft});
      flash('Draft submitted to the computer for a separate local confirmation. It will not be sent.');
    }catch(error){
      draftAttemptRef.current='';
      setTargetStatus('Verified editable field · waiting for a draft request');
      flash(String(error),true);
    }
  };
  // A terminal TUI is not a Windows UIA text control. Backroom writes to the
  // exact active PTY session; the human must verify Claude Code/OpenCode focus.
  // Text and Enter are separate acknowledged, one-shot actions.
  const terminalTypeDraft=()=>{
    if(!terminalSession||!controlGranted||!draftGranted||!terminalInput.trim()||terminalDraftSending)return;
    if(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(terminalInput))
      return flash('Terminal drafts cannot contain Enter or terminal control characters.',true);
    const requestId=uuid();
    terminalActionRef.current={requestId,action:'draft',text:terminalInput};
    setTerminalDraftSending(true);
    try{
      sendData({kind:'terminal_draft',requestId,sessionId:terminalSession,data:terminalInput});
    }catch(error){
      terminalActionRef.current=null;setTerminalDraftSending(false);
      flash(error instanceof Error?error.message:'Could not send the terminal draft.',true);
    }
  };
  const terminalSubmit=()=>{
    if(!terminalSession||!controlGranted||!terminalDraftReady||terminalDraftSending)return;
    const requestId=uuid();
    terminalActionRef.current={requestId,action:'submit'};
    setTerminalDraftSending(true);
    try{
      sendData({kind:'terminal_submit',requestId,sessionId:terminalSession});
    }catch(error){
      terminalActionRef.current=null;setTerminalDraftSending(false);
      flash(error instanceof Error?error.message:'Could not send Enter to the terminal.',true);
    }
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
            <div className="br-desktop-video" ref={frameRef} tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onKeyDown={keyDown}>
              <video ref={videoRef} autoPlay muted playsInline onLoadedData={()=>setVideoReady(Boolean(videoRef.current?.videoWidth&&videoRef.current?.videoHeight&&videoRef.current.readyState>=2))} onPlaying={()=>setVideoReady(Boolean(videoRef.current?.videoWidth&&videoRef.current?.videoHeight&&videoRef.current.readyState>=2))} onWaiting={()=>setVideoReady(false)} onStalled={()=>setVideoReady(false)} onEnded={()=>setVideoReady(false)} onEmptied={()=>setVideoReady(false)} onError={()=>setVideoReady(false)}/>
              {!videoReady&&<div className="br-desktop-video-empty">Waiting for the computer to approve and share its display…</div>}
              {selection&&<div className="br-desktop-selection" style={selectionOverlayStyle()}/>}
            </div>
            <div className="br-desktop-toolbar">
              <span>{videoReady?'Live computer display':'View request pending'}{coordinateControl?' · monitor geometry verified':' · view-only until capture geometry is verified'}</span>
              <button type="button" onClick={()=>void requestControl()} disabled={!videoReady||!coordinateControl||controlGranted}>Request control</button>
              <button type="button" onClick={()=>{setTargetStatus('');setSelection(null);dragRef.current=null;targetAttemptRef.current='';draftAttemptRef.current='';try{sendData({kind:'clear_target'});}catch(error){flash('Could not clear the previous typing target. Stopping this remote session for safety.',true);void stopActivePeer();}setSelectMode(v=>!v);}} disabled={!controlGranted||!draftGranted||!selectedIsWindows||!videoReady}>{selectMode?'Cancel area selection':selectedIsWindows?'Drag-select typing area':'Typing-area targeting unavailable on this OS'}</button>
              <button type="button" onClick={()=>void requestDraftPermission()} disabled={!controlGranted||draftGranted||!selectedIsWindows}><TextCursorInput size={13}/> Request typing permission</button>
            </div>
            {!selectedIsWindows&&<div className="br-desktop-caption" role="status">This computer can still use supported desktop and terminal features, but verified drag-select text targeting is not implemented for this operating system yet. Windows UI Automation targeting is currently supported.</div>}
            {targetStatus&&<div className="br-desktop-caption" role="status">{targetStatus}</div>}
            {controlGranted&&draftGranted&&<div className="br-desktop-draft">
              <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={2} maxLength={4000} placeholder="Write the text to insert in the selected area. It will never press Enter or Send."/>
              <button type="button" onClick={requestDraft} disabled={!selectedIsWindows||!selection||!targetStatus.startsWith('Verified editable field ·')||!draft.trim()}>Request draft insertion</button>
            </div>}
            {controlGranted&&<div className="br-desktop-caption">Computer control is locally approved for a limited time. The user at the computer can revoke it immediately. Draft typing has a second independent approval and never sends or submits.</div>}
          </div>}
          {(terminalSession||terminalPeerId)&&<div className="br-terminal-remote">
            <div className="br-terminal-remote-head"><SquareTerminal size={15}/> Native terminal · actual computer</div>
            <pre>{terminalText||'Waiting for terminal output…'}</pre>
            <div className="br-terminal-input">
              <input value={terminalInput} onChange={e=>{setTerminalInput(e.target.value);setTerminalDraftReady(false);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();terminalTypeDraft();}}} placeholder={!controlGranted?'Request terminal control first':!draftGranted?'Approve terminal draft typing first':'Text for the focused Claude Code/OpenCode prompt…'} disabled={!controlGranted||!draftGranted||terminalDraftSending}/>
              {controlGranted&&!draftGranted&&<button type="button" onClick={()=>void requestTerminalDraftPermission()}>Request draft permission</button>}
              <button type="button" onClick={terminalTypeDraft} disabled={!controlGranted||!draftGranted||!terminalInput.trim()||terminalDraftSending}>Type only</button>
              <button type="button" onClick={terminalSubmit} disabled={!controlGranted||!terminalDraftReady||terminalDraftSending}>Press Enter</button>
            </div>
            <p className="br-desktop-caption">
              Terminal draft typing requires separate approval on the computer. Type only writes plain text to the active PTY and never submits it. Backroom cannot inspect which TUI widget is focused, so verify the Claude Code/OpenCode prompt yourself. Press Enter is a separate, one-use action available only after a successful draft write.
            </p>
            {!controlGranted&&terminalSession&&<button type="button" onClick={()=>void sendCommand('request_control',{sessionId:terminalSession,peerSessionId:terminalPeerId})}>Request terminal control</button>}
          </div>}
        </div>}
      </>
    }
    {notice&&<div className={'br-desktop-notice'+(noticeError?' error':'')} role="status">{notice}</div>}
    <div className="br-desktop-foot"><ShieldCheck size={14}/> App inventory shares labels and fingerprints only. Executable paths, app data, passwords and files stay on the computer. Screen sharing uses the OS picker; input and typing are separately approved.</div>
  </section>;
}
