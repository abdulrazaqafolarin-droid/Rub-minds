import { useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, ShieldAlert, Smartphone, SquareTerminal, Monitor, Eye, Type, Play, Square } from 'lucide-react';

type LocalHostApi = <T>(path:string, options?:{method?:string;body?:unknown})=>Promise<T>;
type AiSession = {participantId:string;displayName:string;sessionDigest:string;expiresAt?:string};
type RuntimeStatus = {stopped:boolean;capabilities:{desktop:boolean;android:boolean;terminal:boolean};desktop?:{available:boolean;tools?:string[]};android?:{available:boolean;trackedTasks?:number};terminal?:{available:boolean;ready?:boolean;closed?:boolean;sandboxName?:string;hostShellAvailable?:boolean;projectConfigured?:boolean;projectSynced?:boolean;projectFileCount?:number;projectSourceBytes?:number;projectSyncedAt?:string|null}};
type DesktopWindow = {pid:number;windowId:number;appName:string;title:string;zIndex:number|null};
type DesktopElement = {elementToken:string;role:string;label:string;valueEmpty:boolean;typeable:boolean};
type DesktopObservation = {pid:number;windowId:number;groupId:string;sessionId:string;appName:string;title:string;elementCount:number;degraded:boolean;snapshotId:string|null;elements:DesktopElement[];state:string};
type AndroidTask = {traceId:string;deviceSerial:string;appPackage:string;groupId:string;sessionId:string;status:string;message?:string|null};
type AndroidStatus = {traceId:string;deviceSerial:string;status:string;elapsedSeconds:number|null;result:unknown;error:string|null;testSummary:unknown};
type AndroidHierarchy = {deviceSerial:string;appPackage:string;groupId:string;sessionId:string;hierarchy:string};
type TerminalResult = {state:string;exitCode:number;stdout:string;stderr:string;sandboxName:string};

const emptyRuntime:RuntimeStatus={stopped:false,capabilities:{desktop:false,android:false,terminal:false},desktop:{available:false},android:{available:false,trackedTasks:0},terminal:{available:false,hostShellAvailable:false}};
const runArgvDefault='["npm","ci"]';

export default function ExternalWorkspacePanel({hostToken,roomId,hostApi,sessions,selectedSessionDigest,onSelectSession,onFindSessions}:{hostToken:string;roomId:string;hostApi:LocalHostApi;sessions:AiSession[];selectedSessionDigest:string;onSelectSession:(digest:string)=>void;onFindSessions:()=>void}) {
  const [runtime,setRuntime]=useState<RuntimeStatus>(emptyRuntime);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [desktopWindows,setDesktopWindows]=useState<DesktopWindow[]>([]);
  const [selectedWindowKey,setSelectedWindowKey]=useState('');
  const [observation,setObservation]=useState<DesktopObservation|null>(null);
  const [selectedElementToken,setSelectedElementToken]=useState('');
  const [desktopDraft,setDesktopDraft]=useState('Draft a reply for this Rub Minds group. Do not send it.');
  const [deviceSerial,setDeviceSerial]=useState('');
  const [appPackage,setAppPackage]=useState('');
  const [androidTask,setAndroidTask]=useState('Inspect the current screen and report what is visible. Do not submit a message or change account settings.');
  const [androidJob,setAndroidJob]=useState<AndroidTask|null>(null);
  const [androidResult,setAndroidResult]=useState<AndroidStatus|null>(null);
  const [androidHierarchy,setAndroidHierarchy]=useState('');
  const [terminalArgv,setTerminalArgv]=useState(runArgvDefault);
  const [terminalCwd,setTerminalCwd]=useState('/workspace/project');
  const [terminalPurpose,setTerminalPurpose]=useState('Run the selected Backroom verification command in the local sandbox');
  const [terminalResult,setTerminalResult]=useState<TerminalResult|null>(null);
  const selectedSession=useMemo(()=>sessions.find(s=>s.sessionDigest===selectedSessionDigest)??null,[sessions,selectedSessionDigest]);
  const scope=useMemo(()=>selectedSession&&roomId?{groupId:roomId,sessionId:selectedSession.participantId}:null,[roomId,selectedSession]);
  const selectedWindow=useMemo(()=>desktopWindows.find(w=>(String(w.pid)+':'+String(w.windowId))===selectedWindowKey)??null,[desktopWindows,selectedWindowKey]);
  const selectedElement=useMemo(()=>observation?.elements.find(e=>e.elementToken===selectedElementToken)??null,[observation,selectedElementToken]);
  const jobMatchesScope=!!(androidJob&&scope&&androidJob.groupId===scope.groupId&&androidJob.sessionId===scope.sessionId);

  async function refreshRuntime(silent=false) {
    if(!hostToken){setRuntime(emptyRuntime);return;}
    try{
      const next=await hostApi<RuntimeStatus>('/v1/workspaces/status');
      if(!next||typeof next!=='object'||!next.capabilities||typeof next.capabilities.desktop!=='boolean'||typeof next.capabilities.android!=='boolean'||typeof next.capabilities.terminal!=='boolean')throw new Error('Local workspace status was incomplete.');
      setRuntime(next);
      if(!silent)setNotice(next.stopped?'External workspaces are stopped. Restart and pair the local host to use them.':'Workspace capabilities refreshed from the paired local host.');
    }catch(error){setRuntime(emptyRuntime);if(!silent)setNotice(error instanceof Error?error.message:'Could not read local runtime status.');}
  }
  useEffect(()=>{setRuntime(emptyRuntime);setDesktopWindows([]);setSelectedWindowKey('');setObservation(null);setSelectedElementToken('');setAndroidHierarchy('');setTerminalResult(null);void refreshRuntime(true);},[hostToken,roomId]);

  async function action<T>(fn:()=>Promise<T>,success?:string):Promise<T|null>{
    setBusy(true);setNotice('');
    try{const result=await fn();if(success)setNotice(success);return result;}
    catch(error){setNotice(error instanceof Error?error.message:'Workspace operation failed.');return null;}
    finally{setBusy(false);}
  }
  async function loadWindows(){
    if(!scope){setNotice('First find and select a joined AI session for this group.');return;}
    const result=await action(()=>hostApi<{windows:DesktopWindow[]}>('/v1/workspaces/desktop/windows',{method:'POST',body:scope}),'Live desktop-window inventory refreshed. Review the list and choose the exact window before inspecting its controls.');
    if(result){setDesktopWindows(Array.isArray(result.windows)?result.windows:[]);setSelectedWindowKey('');setObservation(null);setSelectedElementToken('');}
  }
  async function inspectWindow(){
    if(!scope||!selectedWindow){setNotice('Choose a live desktop window first.');return;}
    const result=await action(()=>hostApi<DesktopObservation>('/v1/workspaces/desktop/observe',{method:'POST',body:{...scope,pid:selectedWindow.pid,windowId:selectedWindow.windowId}}),'Window inspected. Only role/label and empty-input metadata are displayed; control text is not copied into the group.');
    if(result){setObservation(result);setSelectedElementToken('');}
  }
  async function writeDesktopDraft(){
    if(!scope||!selectedWindow||!observation||!selectedElement||!selectedElement.typeable||!selectedElement.valueEmpty||!desktopDraft.trim()){setNotice('Inspect the selected window and choose an explicitly empty text field first.');return;}
    if(!window.confirm('Ask the local Backroom host to type this exact draft into the selected window? This will not click Send or press Enter.'))return;
    const result=await action(()=>hostApi<{state:string;submitted?:boolean;verified?:boolean;reason?:string}>('/v1/workspaces/desktop/draft',{method:'POST',body:{...scope,pid:selectedWindow.pid,windowId:selectedWindow.windowId,elementToken:selectedElement.elementToken,text:desktopDraft,expectedAppName:observation.appName,expectedTitle:observation.title}}));
    if(result)setNotice(result.state==='completed'&&result.submitted===false
      ?'Draft inserted and read back successfully. Nothing was submitted.'
      :result.state==='needs_review'
        ?'Draft outcome is uncertain. Inspect the actual application before any retry; no automatic retry was performed.'
        :'Draft result: '+result.state+'. Check the live app before retrying.');
  }
  async function inspectAndroid(){
    if(!scope||!deviceSerial.trim()||!appPackage.trim()){setNotice('Choose a joined AI session, device serial and app package; both Android identifiers must be allowlisted on the host.');return;}
    const result=await action(()=>hostApi<AndroidHierarchy>('/v1/workspaces/android/observe',{method:'POST',body:{...scope,deviceSerial:deviceSerial.trim(),appPackage:appPackage.trim()}}),'Android hierarchy received locally. It has not been written to group memory.');
    if(result)setAndroidHierarchy(result.hierarchy);
  }
  async function runAndroid(){
    if(!scope||!deviceSerial.trim()||!appPackage.trim()||!androidTask.trim()){setNotice('Select a joined AI session and fill the host-allowlisted device, app package and task.');return;}
    if(!window.confirm('Request the local host to run this bounded task on the exact allowlisted device/app? ARTEMIS is asynchronous; status is tracked by its trace ID.'))return;
    const result=await action(()=>hostApi<AndroidTask>('/v1/workspaces/android/tasks',{method:'POST',body:{...scope,deviceSerial:deviceSerial.trim(),appPackage:appPackage.trim(),task:androidTask}}));
    if(result){setAndroidJob(result);setAndroidResult(null);setAndroidHierarchy('');setNotice('ARTEMIS accepted task '+result.traceId+'. This means queued/running, not that the task succeeded.');}
  }
  async function androidStatus(){
    if(!androidJob||!jobMatchesScope){setNotice('This task belongs to a different group or AI session. Re-select its original scope to manage it.');return;}
    const result=await action(()=>hostApi<AndroidStatus>('/v1/workspaces/android/task-status',{method:'POST',body:{traceId:androidJob.traceId,deviceSerial:androidJob.deviceSerial,groupId:androidJob.groupId,sessionId:androidJob.sessionId}}));
    if(result){setAndroidResult(result);setNotice('ARTEMIS task status: '+result.status+'. Check verification details and the actual device before reporting success.');}
  }
  async function stopAndroid(){
    if(!androidJob||!jobMatchesScope){setNotice('This task belongs to a different group or AI session.');return;}
    if(!window.confirm('Ask ARTEMIS to stop this task on the original device? The local host will request a separate approval.'))return;
    const result=await action(()=>hostApi<{traceId:string;stopped:boolean}>('/v1/workspaces/android/task-stop',{method:'POST',body:{traceId:androidJob.traceId,deviceSerial:androidJob.deviceSerial,groupId:androidJob.groupId,sessionId:androidJob.sessionId}}));
    if(result)setNotice(result.stopped?'ARTEMIS reported the task stopped.':'Stop was requested but cancellation was not independently confirmed.');
  }
  async function syncTerminalProject(){
    if(!scope){setNotice('First find and select a joined AI session for this group.');return;}
    if(!runtime.capabilities.terminal){setNotice('The local terminal sandbox is not ready.');return;}
    if(!window.confirm('Copy a filtered source snapshot from the local host into the isolated sandbox? Git history, node_modules, build output and common secret files are excluded. A previous sandbox project snapshot will be replaced; the source repository on your host is not modified.'))return;
    const result=await action(()=>hostApi<{state:string;projectSynced:boolean;fileCount:number;sourceBytes:number;archiveBytes:number;sha256:string;omittedSensitive:number;omittedLarge:number;destination:string}>('/v1/workspaces/terminal/sync',{method:'POST',body:scope}));
    if(result){await refreshRuntime(true);setNotice(result.projectSynced?'Local project snapshot synced: '+result.fileCount+' files ('+Math.ceil(result.sourceBytes/1024)+' KiB). Credentials, Git internals and dependencies were not copied. Install dependencies only through an explicitly approved sandbox command.':'Project snapshot was not confirmed. Inspect runtime status before retrying.');}
  }
  async function runTerminal(){
    if(!scope){setNotice('First find and select a joined AI session for this group.');return;}
    let command:unknown;
    try{command=JSON.parse(terminalArgv);}catch{setNotice('Command must be valid JSON argv, for example ["npm","test:backroom"].');return;}
    if(!Array.isArray(command)||command.length===0||command.some(x=>typeof x!=='string'||!x.trim())){setNotice('Command must be a JSON array of non-empty strings. A shell command line is not accepted.');return;}
    if(!terminalPurpose.trim()){setNotice('Describe why this terminal command is needed.');return;}
    if(!window.confirm('Run this exact argv in the dedicated local gVisor sandbox? The local host will display another approval prompt; no command will run on the host shell.'))return;
    const payload:{command:string[];purpose:string;groupId:string;sessionId:string;cwd?:string}={command:command as string[],purpose:terminalPurpose.trim(),...scope};
    if(terminalCwd.trim())payload.cwd=terminalCwd.trim();
    const result=await action(()=>hostApi<TerminalResult>('/v1/workspaces/terminal/exec',{method:'POST',body:payload}));
    if(result){setTerminalResult(result);setNotice(result.state==='completed'?'Sandbox command completed. Review its output; it has not been posted to the group.':'Sandbox command ended in state '+result.state+'. Review output and environment before retrying.');}
  }

  return <section className="br-panel br-external-workspaces" aria-labelledby="br-external-workspaces-title">
    <div className="br-panel-head"><div><span className="br-eyebrow">LOCAL RUNTIME · REAL DEVICE/APPS</span><h2 id="br-external-workspaces-title">Connected workspaces</h2><p>This panel uses the paired host and actual configured adapters—not the simulated space preview.</p></div><button type="button" className="br-secondary" onClick={()=>void refreshRuntime()} disabled={!hostToken||busy}><RefreshCw size={14}/> Refresh runtime</button></div>
    {!hostToken?<div className="br-warning"><ShieldAlert size={19}/><div><b>Local host not paired</b><p>Pair a Backroom host in Host settings before using desktop, Android or terminal connections.</p></div></div>:null}
    {notice&&<div className="br-notice" role="status"><Activity size={15}/>{notice}</div>}
    <div className="br-workspace-runtime-status">
      <div><b>Desktop / native</b><span>{runtime.capabilities.desktop?'Available':'Not configured or unavailable'}</span></div>
      <div><b>Android · ARTEMIS</b><span>{runtime.capabilities.android?'Available':'Not configured or unavailable'}</span></div>
      <div><b>Terminal sandbox</b><span>{runtime.capabilities.terminal?(runtime.terminal?.projectSynced?'Sandbox + source synced':runtime.terminal?.ready?'Sandbox ready · project not synced':'Configured, not ready'):'Not configured or unavailable'}</span></div>
    </div>
    <div className="br-external-scope">
      <label htmlFor="br-external-ai-session">Authorized joined AI session (this group)</label>
      <div className="br-browser-open-row"><select id="br-external-ai-session" value={selectedSessionDigest} onChange={e=>onSelectSession(e.target.value)} disabled={busy}><option value="">Select a joined AI session</option>{sessions.map(s=><option key={s.participantId+':'+s.sessionDigest} value={s.sessionDigest}>{s.displayName} · {s.participantId.slice(0,8)}</option>)}</select><button type="button" className="br-secondary" onClick={onFindSessions} disabled={!hostToken||busy}>Find sessions</button></div>
      <p>All actions are bound to the current group and selected AI participant. Private observations stay on this page unless you explicitly copy/share them.</p>
    </div>
    <div className="br-external-surface-grid">
      <section className="br-external-surface" aria-labelledby="br-desktop-title">
        <h3 id="br-desktop-title"><Monitor size={17}/> Desktop app</h3>
        <p>Inspect a real window, select one fresh empty text field, and insert an unsent draft. The local host asks you to approve observation and exact text separately.</p>
        {!runtime.capabilities.desktop?<div className="br-subtle-status">Configure BACKROOM_ENABLE_CUA_DRIVER=1 and install/configure CUA Driver MCP on the host.</div>:<>
          <button type="button" className="br-secondary" disabled={busy||!scope} onClick={()=>void loadWindows()}><RefreshCw size={14}/> List windows</button>
          <label htmlFor="br-desktop-window">Exact process / window</label>
          <select id="br-desktop-window" value={selectedWindowKey} onChange={e=>{setSelectedWindowKey(e.target.value);setObservation(null);setSelectedElementToken('');}} disabled={busy}><option value="">Select a window</option>{desktopWindows.map(w=><option key={String(w.pid)+':'+String(w.windowId)} value={String(w.pid)+':'+String(w.windowId)}>{w.appName||'Unknown app'} · {w.title||'Untitled'} · PID {w.pid} / window {w.windowId}</option>)}</select>
          <button type="button" className="br-secondary" disabled={busy||!selectedWindow||!scope} onClick={()=>void inspectWindow()}><Eye size={14}/> Inspect selected window</button>
          {observation&&<><p><b>{observation.appName}</b> · {observation.title} · {observation.elementCount} controls {observation.degraded?'(degraded tree)':''}</p>
            <label htmlFor="br-desktop-element">Verified empty text control</label>
            <select id="br-desktop-element" value={selectedElementToken} onChange={e=>setSelectedElementToken(e.target.value)} disabled={busy}><option value="">Select a text field</option>{observation.elements.map(e=><option disabled={!e.typeable||!e.valueEmpty} key={e.elementToken} value={e.elementToken}>{e.typeable&&e.valueEmpty?'Ready':'Not eligible'} · {e.role} · {e.label||e.elementToken}</option>)}</select>
            <label htmlFor="br-desktop-draft">Exact draft text (not submitted)</label><textarea id="br-desktop-draft" rows={3} maxLength={4000} value={desktopDraft} onChange={e=>setDesktopDraft(e.target.value)} disabled={busy}/>
            <button type="button" className="br-primary" disabled={busy||!selectedElement?.typeable||!selectedElement.valueEmpty||!scope} onClick={()=>void writeDesktopDraft()}><Type size={14}/> Insert draft · never send</button>
          </>}
        </>}
      </section>
      <section className="br-external-surface" aria-labelledby="br-android-title">
        <h3 id="br-android-title"><Smartphone size={17}/> Android · ARTEMIS</h3>
        <p>Runs an asynchronous task on an explicitly allowlisted device and package. The trace ID, not the first response, is the authority for subsequent status checks.</p>
        {!runtime.capabilities.android?<div className="br-subtle-status">Configure ARTEMIS, its MCP environment, and the host-local device/package allowlists.</div>:<>
          <label htmlFor="br-android-device">Device serial (allowlisted)</label><input id="br-android-device" value={deviceSerial} onChange={e=>setDeviceSerial(e.target.value)} placeholder="Exact adb serial" autoCapitalize="none" disabled={busy}/>
          <label htmlFor="br-android-package">App package (allowlisted)</label><input id="br-android-package" value={appPackage} onChange={e=>setAppPackage(e.target.value)} placeholder="com.example.app" autoCapitalize="none" disabled={busy}/>
          <label htmlFor="br-android-task">Task instruction</label><textarea id="br-android-task" rows={3} maxLength={3500} value={androidTask} onChange={e=>setAndroidTask(e.target.value)} disabled={busy}/>
          <div className="br-external-actions"><button type="button" className="br-secondary" disabled={busy||!scope||!deviceSerial.trim()||!appPackage.trim()} onClick={()=>void inspectAndroid()}><Eye size={14}/> Inspect hierarchy</button><button type="button" className="br-primary" disabled={busy||!scope} onClick={()=>void runAndroid()}><Play size={14}/> Start ARTEMIS task</button></div>
          {androidJob&&<div className="br-task-result"><b>Trace: {androidJob.traceId}</b><span>{jobMatchesScope?'Bound to current group/session':'Belongs to the group/session selected at launch'}</span><div className="br-external-actions"><button className="br-secondary" disabled={busy||!jobMatchesScope} onClick={()=>void androidStatus()}>Check status</button><button className="br-danger-action" disabled={busy||!jobMatchesScope} onClick={()=>void stopAndroid()}><Square size={13}/> Request stop</button></div></div>}
          {androidResult&&<pre className="br-runtime-output">{JSON.stringify(androidResult,null,2)}</pre>}
          {androidHierarchy&&<><label>Local-only UI hierarchy</label><pre className="br-runtime-output">{androidHierarchy}</pre></>}
        </>}
      </section>
      <section className="br-external-surface" aria-labelledby="br-terminal-title">
        <h3 id="br-terminal-title"><SquareTerminal size={17}/> Isolated terminal</h3>
        <p>Commands run as argv inside a dedicated local gVisor container. The adapter denies shell interpreters, and the host asks for exact local approval. There is no host-shell fallback.</p>
        {!runtime.capabilities.terminal?<div className="br-subtle-status">Configure BACKROOM_ENABLE_CUA_TERMINAL=1 and install the CUA CLI/local gVisor runtime.</div>:<>
          <div className="br-subtle-status">{runtime.terminal?.projectSynced?'Source snapshot ready · '+(runtime.terminal.projectFileCount??0)+' files':'Sandbox is separate from your repository. Sync a locally approved, filtered source snapshot before running project commands.'}</div>
          <button type="button" className="br-secondary" disabled={busy||!scope||runtime.terminal?.projectConfigured===false} onClick={()=>void syncTerminalProject()}><RefreshCw size={14}/> Sync local project snapshot</button>
          <label htmlFor="br-terminal-argv">Command argv as JSON (not a shell string)</label><textarea id="br-terminal-argv" rows={2} value={terminalArgv} onChange={e=>setTerminalArgv(e.target.value)} disabled={busy||!runtime.terminal?.projectSynced}/>
          <label htmlFor="br-terminal-purpose">Purpose</label><input id="br-terminal-purpose" value={terminalPurpose} onChange={e=>setTerminalPurpose(e.target.value)} disabled={busy||!runtime.terminal?.projectSynced}/>
          <label htmlFor="br-terminal-cwd">Sandbox working directory (optional)</label><input id="br-terminal-cwd" value={terminalCwd} onChange={e=>setTerminalCwd(e.target.value)} placeholder="/workspace/project" disabled={busy||!runtime.terminal?.projectSynced}/>
          <button type="button" className="br-primary" disabled={busy||!scope||!runtime.terminal?.projectSynced} onClick={()=>void runTerminal()}><Play size={14}/> Run in local sandbox</button>
          {terminalResult&&<><div className="br-detail"><span>Exit code</span><b>{terminalResult.exitCode} · {terminalResult.state}</b></div><pre className="br-runtime-output">{terminalResult.stdout||terminalResult.stderr||'(no output)'}</pre></>}
        </>}
      </section>
    </div>
    <div className="br-warning"><ShieldAlert size={19}/><div><b>Capabilities reflect the paired local host, not a browser mock.</b><p>All actions require an authorized AI session, scope checks and local approval. A task being accepted is not success; inspect its verification output. Never auto-send a desktop draft. Workspace output is not automatically shared to the group.</p></div></div>
  </section>;
}
