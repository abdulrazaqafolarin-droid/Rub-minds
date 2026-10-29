/**
 * Local-only workspace adapters for CUA Driver, ARTEMIS, and CUA sandbox.
 * External provider binaries are configured only by the trusted host process.
 */
const MAX_TEXT=4000, ID=/^[a-zA-Z0-9_.:-]{1,160}$/, PACKAGE=/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const TERMINAL_BINS=new Set(['node','npm','pnpm','yarn','git','python','python3','uv','pytest','ruff','rg','grep','sed','awk','find','ls','cat','head','tail','wc','mkdir','cp','mv','rm','touch','tar','unzip','zip','make','go','cargo','rustc','tsc','vite']);
const SHELLS=new Set(['sh','bash','zsh','fish','cmd','cmd.exe','powershell','pwsh','wscript','cscript']);
function needApproval(fn,what){if(typeof fn!=='function')throw new TypeError(what+' needs a trusted local approval callback');}
function structured(value){if(typeof value==='string'){try{return JSON.parse(value);}catch{throw new Error('Runtime returned non-structured output');}}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Runtime returned no structured output');return value;}
function elements(state){if(Array.isArray(state?.elements))return state.elements;if(Array.isArray(state?.structuredContent?.elements))return state.structuredContent.elements;throw new Error('CUA snapshot lacks accessibility elements');}
function positiveInt(value,label){if(!Number.isSafeInteger(value)||value<1)throw new TypeError(label+' must be a positive integer');}
function nonnegativeInt(value,label){if(!Number.isSafeInteger(value)||value<0)throw new TypeError(label+' must be a nonnegative integer');}
function androidScope(deviceSerial,appPackage,devices,packages){if(typeof deviceSerial!=='string'||!devices.has(deviceSerial))throw new Error('Android device is not explicitly allowlisted');if(typeof appPackage!=='string'||!PACKAGE.test(appPackage)||!packages.has(appPackage))throw new Error('Android package is not explicitly allowlisted');return {deviceSerial,appPackage};}
function scopeIds(groupId,sessionId){if(typeof groupId!=='string'||!ID.test(groupId)||typeof sessionId!=='string'||!ID.test(sessionId))throw new TypeError('Backroom group and session scope required');}

export class CuaDesktopWorkspace {
  constructor({client,session='rub-minds-backroom',authorizeLocalAction}={}) {
    if(!client||typeof client.callTool!=='function'||typeof client.listTools!=='function')throw new TypeError('Initialized CUA Driver MCP client required');
    needApproval(authorizeLocalAction,'Desktop actions');this.client=client;this.session=session;this.approve=authorizeLocalAction;
  }
  async #require(names){const found=new Set((await this.client.listTools()).map(t=>t.name));const missing=names.filter(n=>!found.has(n));if(missing.length)throw new Error('CUA tool contract unavailable: '+missing.join(','));}
  async listWindows({groupId,sessionId}={}) {
    scopeIds(groupId,sessionId);if(await this.approve(Object.freeze({kind:'desktop_list_windows',groupId,sessionId}))!==true)throw new Error('Local desktop observation denied');
    return this.#listWindows();
  }
  async #listWindows(){
    await this.#require(['list_windows']);
    const r=structured(await this.client.callTool('list_windows',{on_screen_only:true}));
    const list=r.windows??r.structuredContent?.windows;if(!Array.isArray(list))throw new Error('CUA list_windows did not return windows');
    return Object.freeze(list.filter(w=>w&&Number.isSafeInteger(Number(w.pid))&&Number(w.pid)>0&&Number.isSafeInteger(Number(w.window_id??w.windowId)))
      .map(w=>Object.freeze({pid:Number(w.pid),windowId:Number(w.window_id??w.windowId),appName:String(w.app_name??w.appName??''),title:String(w.title??''),zIndex:Number.isFinite(w.z_index)?w.z_index:null})));
  }
  async #snapshot({pid,windowId}){
    positiveInt(pid,'pid');nonnegativeInt(windowId,'windowId');await this.#require(['get_window_state','list_windows']);
    const state=structured(await this.client.callTool('get_window_state',{pid,window_id:windowId,tree_format:'elements',full_output:true,session:this.session}));
    if(Number(state.pid)!==pid||Number(state.window_id??state.windowId)!==windowId)throw new Error('CUA snapshot PID/window mismatch');
    const window=(await this.#listWindows()).find(w=>w.pid===pid&&w.windowId===windowId);
    if(!window)throw new Error('Selected desktop window disappeared');
    return {state,window,elements:elements(state)};
  }
  async observeWindow({pid,windowId,groupId,sessionId}={}){
    scopeIds(groupId,sessionId);if(await this.approve(Object.freeze({kind:'desktop_observe',pid,windowId,groupId,sessionId}))!==true)throw new Error('Local desktop observation denied');const {state,window,elements}=await this.#snapshot({pid,windowId});
    const elementOptions = elements.slice(0, 250).flatMap(element => {
      const elementToken = typeof element?.element_token === 'string' ? element.element_token : null;
      if (!elementToken) return [];
      const role = String(element.role ?? element.type ?? '').slice(0, 80);
      const label = Array.from(String(element.label ?? '')).map(character => {
        const code = character.codePointAt(0);
        return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : character;
      }).join('').slice(0, 120);
      return [Object.freeze({
        elementToken, role, label,
        valueEmpty: typeof element.value === 'string' && element.value === '',
        typeable: /(text|edit|input|document|textarea|combobox)/i.test(role) && typeof element.value === 'string' && element.value === '',
      })];
    });
    return Object.freeze({pid,windowId,groupId,sessionId,appName:window.appName,title:window.title,elementCount:elements.length,degraded:state.degraded===true,snapshotId:typeof state.snapshot_id==='string'?state.snapshot_id:null,elements:Object.freeze(elementOptions),state:'observed'});
  }
  async draftText({pid,windowId,elementToken,text,expectedAppName,expectedTitle,groupId,sessionId}={}){
    positiveInt(pid,'pid');nonnegativeInt(windowId,'windowId');scopeIds(groupId,sessionId);
    if(typeof elementToken!=='string'||!ID.test(elementToken))throw new TypeError('Snapshot-derived CUA element token required');
    if(typeof text!=='string'||!text.trim()||text.length>MAX_TEXT||CONTROL.test(text))throw new TypeError('Draft must be safe single-line text of at most 4000 characters');
    if(typeof expectedAppName!=='string'||!expectedAppName.trim()||typeof expectedTitle!=='string'||!expectedTitle.trim())throw new TypeError('Expected app/window identity required');
    if(await this.approve(Object.freeze({kind:'desktop_draft_inspect',pid,windowId,expectedAppName,expectedTitle,groupId,sessionId}))!==true)throw new Error('Local desktop observation denied');
    const before=await this.#snapshot({pid,windowId});
    if(before.window.appName!==expectedAppName||before.window.title!==expectedTitle)throw new Error('Desktop app/window identity changed');
    const field=before.elements.find(e=>e?.element_token===elementToken);
    if(!field)throw new Error('Element token is absent from fresh CUA snapshot');
    if(!/(text ?field|text ?input|text ?entry|text ?area|text ?editor|textarea|editable ?text|document)/i.test(String(field.role??field.type??'')))throw new Error('Selected element is not a clearly editable text control');
    if(typeof field.value!=='string'||field.value!=='')throw new Error('Selected text-entry control is not explicitly verified empty');
    const approval=await this.approve(Object.freeze({kind:'desktop_draft',pid,windowId,appName:expectedAppName,title:expectedTitle,text,elementToken,groupId,sessionId}));
    if(approval!==true)throw new Error('Local desktop action denied');
    const fresh=await this.#snapshot({pid,windowId}),current=fresh.elements.find(e=>e?.element_token===elementToken);
    if(fresh.window.appName!==expectedAppName||fresh.window.title!==expectedTitle||!current||current.value!=='')throw new Error('Desktop input changed after approval');
    await this.#require(['click','type_text']);
    // CUA type_text accepts an exact window target, not an element_token. Focus the
    // freshly verified text control first, then type only into that exact window.
    const focused=structured(await this.client.callTool('click',{target:{kind:'window',pid,window_id:windowId},element_token:elementToken,delivery_mode:'foreground',session:this.session}));
    if(focused.effect==='unverifiable'||focused.effect==='suspected_noop'||focused.error)return Object.freeze({state:'needs_review',submitted:false,reason:'CUA could not verify text-field focus'});
    const postFocus=await this.#snapshot({pid,windowId}),focusWindow=postFocus.window,focusField=postFocus.elements.find(e=>e?.element_token===elementToken);
    if(focusWindow.appName!==expectedAppName||focusWindow.title!==expectedTitle||!focusField||focusField.value!==''||!/(text ?field|text ?input|text ?entry|text ?area|text ?editor|textarea|editable ?text|document)/i.test(String(focusField.role??focusField.type??'')))return Object.freeze({state:'needs_review',submitted:false,reason:'Selected control changed after focus'});
    const result=structured(await this.client.callTool('type_text',{text,target:{kind:'window',pid,window_id:windowId},session:this.session}));
    if(result.effect==='unverifiable'||result.effect==='suspected_noop'||result.error)return Object.freeze({state:'needs_review',submitted:false,reason:'CUA did not confirm text input'});
    const after=await this.#snapshot({pid,windowId}),written=after.elements.find(e=>e?.element_token===elementToken);
    if(!written||written.value!==text||after.window.appName!==expectedAppName||after.window.title!==expectedTitle)return Object.freeze({state:'needs_review',submitted:false,reason:'Desktop readback mismatch'});
    return Object.freeze({state:'completed',submitted:false,verified:true,result:{drafted:true,submitted:false,pid,windowId,elementToken}});
  }
}

/** ARTEMIS is an asynchronous mobile task engine, so results are managed by trace ID. */
export class ArtemisAndroidWorkspace {
  constructor({client,allowedDevices=[],allowedPackages=[],authorizeLocalAction}={}){
    if(!client||typeof client.callTool!=='function'||typeof client.listTools!=='function')throw new TypeError('Initialized ARTEMIS MCP client required');
    needApproval(authorizeLocalAction,'Android actions');this.client=client;this.devices=new Set(allowedDevices);this.packages=new Set(allowedPackages);this.approve=authorizeLocalAction;this.tasks=new Map();
  }
  async #require(names){const found=new Set((await this.client.listTools()).map(t=>t.name));const missing=names.filter(n=>!found.has(n));if(missing.length)throw new Error('ARTEMIS tool contract unavailable: '+missing.join(','));}
  async diagnose(){await this.#require(['mobile_diagnose','mobile_run_task','mobile_manage_task','mobile_get_device_state']);return Object.freeze({available:true,diagnostics:await this.client.callTool('mobile_diagnose',{})});}
  async runTask({deviceSerial,appPackage,task,groupId,sessionId}={}){
    const scope=androidScope(deviceSerial,appPackage,this.devices,this.packages);scopeIds(groupId,sessionId);
    if(typeof task!=='string'||!task.trim()||task.length>3500||CONTROL.test(task))throw new TypeError('Android task must be bounded safe text');
    await this.#require(['mobile_run_task','mobile_manage_task']);
    if(await this.approve(Object.freeze({kind:'android_task',...scope,task,groupId,sessionId}))!==true)throw new Error('Local Android action denied');
    const task_desc=[
      'Rub Minds Backroom authorized task. Target package: '+scope.appPackage+'. Device: '+scope.deviceSerial+'.',
      'Stay inside the locked target application. Do not open unrelated apps or system settings. Do not access out-of-scope credentials. Do not confirm payments, delete data, publish externally or change security settings without separate approval. If target identity is wrong or the task is outside scope, stop and report blocked.',
      'User-approved task:',task.trim(),
      'Backroom scope group='+groupId+'; session='+sessionId+'. Do not report completion solely because an action was attempted.'
    ].join('\n');
    const r=await this.client.callTool('mobile_run_task',{task_desc,model:'Pro',locked_app_package:scope.appPackage,device_serial:scope.deviceSerial,
      expected_output_desc:'Report verification checkpoints, final observed app state and any blocked/unverified outcome.',verification_level:'strict',explorer_mode:'pro'});
    const traceId=r?.trace_id??r?.traceId;if(typeof traceId!=='string'||!ID.test(traceId))throw new Error('ARTEMIS did not return a valid trace ID');
    const record=Object.freeze({traceId,...scope,groupId,sessionId,startedAt:Date.now()});this.tasks.set(traceId,record);
    return Object.freeze({...record,status:String(r.status??'running'),message:typeof r.message==='string'?r.message.slice(0,500):null});
  }
  #task({traceId,deviceSerial,groupId,sessionId}={}){scopeIds(groupId,sessionId);if(typeof traceId!=='string'||!ID.test(traceId))throw new TypeError('Valid trace ID required');const t=this.tasks.get(traceId);if(!t||t.deviceSerial!==deviceSerial||t.groupId!==groupId||t.sessionId!==sessionId)throw new Error('ARTEMIS task scope mismatch');return t;}
  async status(input={}){const t=this.#task(input);await this.#require(['mobile_manage_task']);const r=await this.client.callTool('mobile_manage_task',{action:'status',trace_id:t.traceId});if((r?.trace_id??r?.traceId)!==t.traceId)throw new Error('ARTEMIS trace mismatch');if(r.device_serial&&r.device_serial!==t.deviceSerial)throw new Error('ARTEMIS device mismatch');return Object.freeze({traceId:t.traceId,deviceSerial:t.deviceSerial,status:String(r.status??'unknown'),elapsedSeconds:Number.isFinite(r.elapsed_seconds)?r.elapsed_seconds:null,result:r.result??null,error:r.status==='failed'?String(r.error??'task_failed').slice(0,500):null,testSummary:r.test_summary??null});}
  async stop(input={}){const t=this.#task(input);if(await this.approve(Object.freeze({kind:'android_task_stop',traceId:t.traceId,deviceSerial:t.deviceSerial,appPackage:t.appPackage,groupId:t.groupId,sessionId:t.sessionId}))!==true)throw new Error('Local Android stop denied');await this.#require(['mobile_manage_task']);const r=await this.client.callTool('mobile_manage_task',{action:'stop',trace_id:t.traceId});return Object.freeze({traceId:t.traceId,stopped:r?.status==='cancelled'||r?.stopped===true||r?.success===true});}
  async observe({deviceSerial,appPackage,groupId,sessionId}={}){androidScope(deviceSerial,appPackage,this.devices,this.packages);scopeIds(groupId,sessionId);if(await this.approve(Object.freeze({kind:'android_observe',deviceSerial,appPackage,groupId,sessionId}))!==true)throw new Error('Local Android observation denied');await this.#require(['mobile_get_device_state']);const r=await this.client.callTool('mobile_get_device_state',{view_type:'hierarchy',device_serial:deviceSerial});const text=typeof r==='string'?r:JSON.stringify(r);if(/^Error:/i.test(text))throw new Error('ARTEMIS device inspection failed');return Object.freeze({deviceSerial,appPackage,groupId,sessionId,hierarchy:text.slice(0,16000)});}
  get statusSummary(){return Object.freeze({available:true,trackedTasks:this.tasks.size,tools:['mobile_diagnose','mobile_run_task','mobile_manage_task','mobile_get_device_state']});}
}

/** Creates and destroys a dedicated local gVisor sandbox; never executes on host shell. */
export class CuaSandboxTerminalWorkspace {
  constructor({command='cua',sandboxName,authorizeLocalAction,spawnImpl,timeoutMs=120000,outputLimitBytes=1048576}={}){
    if(typeof command!=='string'||!command.trim())throw new TypeError('CUA CLI executable required');
    if(typeof sandboxName!=='string'||!/^rm-backroom-[a-z0-9-]{4,48}$/.test(sandboxName))throw new TypeError('Dedicated rm-backroom-* sandbox required');
    needApproval(authorizeLocalAction,'Terminal execution');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new RangeError('Invalid terminal timeout');
    if(!Number.isSafeInteger(outputLimitBytes)||outputLimitBytes<1024||outputLimitBytes>4194304)throw new RangeError('Invalid terminal output bound');
    Object.assign(this,{command,sandboxName,approve:authorizeLocalAction,spawnImpl,timeoutMs,outputLimitBytes,ready:false,closed:false});
  }
  async #run(args,timeoutMs=this.timeoutMs){
    const spawn=this.spawnImpl??(await import('node:child_process')).spawn;
    return new Promise((resolve,reject)=>{
      let child;try{child=spawn(this.command,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{reject(new Error('Could not launch CUA CLI'));return;}
      let stdout='',stderr='',bytes=0,settled=false;
      const append=(which,chunk)=>{bytes+=chunk.length;if(bytes>this.outputLimitBytes){try{child.kill('SIGTERM');}catch{}return;}if(which==='out')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');};
      child.stdout?.on('data',chunk=>append('out',chunk));child.stderr?.on('data',chunk=>append('err',chunk));
      const timer=setTimeout(()=>{if(settled)return;settled=true;try{child.kill('SIGTERM');}catch{}reject(new Error('Sandbox command timed out'));},timeoutMs);timer.unref?.();
      child.once('error',()=>{if(settled)return;settled=true;clearTimeout(timer);reject(new Error('CUA sandbox process failed'));});
      child.once('close',(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);if(bytes>this.outputLimitBytes){reject(new Error('Sandbox output exceeded configured limit'));return;}resolve(Object.freeze({code:Number.isInteger(code)?code:1,signal:signal??null,stdout,stderr:stderr.slice(0,4000)}));});
    });
  }
  async start(){if(this.closed)throw new Error('Sandbox lifecycle closed');if(this.ready)return this.status;
    const r=await this.#run(['--json','sb','create','linux','--on','local','--kind','container','--runtime','gvisor','--headless','--name',this.sandboxName]);
    if(r.code!==0)throw new Error('Local gVisor sandbox creation failed; existing sandboxes are never adopted');this.ready=true;return this.status;
  }
  async exec({command,cwd,purpose='Backroom terminal task',groupId,sessionId}={}){
    if(!this.ready||this.closed)throw new Error('Dedicated terminal sandbox is not ready');
    if(!Array.isArray(command)||command.length<1||command.length>128||command.some(v=>typeof v!=='string'||!v||v.includes('\0')||v.length>2000))throw new TypeError('Terminal command must be a bounded argv array');
    const exe=command[0].split(/[\\/]/).at(-1).toLowerCase();if(SHELLS.has(exe)||!TERMINAL_BINS.has(exe))throw new Error('Shell interpreters and non-allowlisted executables are denied');
    if(cwd!==undefined&&(typeof cwd!=='string'||!cwd.startsWith('/')||cwd.split('/').includes('..')))throw new TypeError('Sandbox cwd must be an absolute POSIX path without traversal');
    scopeIds(groupId,sessionId);if(typeof purpose!=='string'||!purpose.trim()||purpose.length>300)throw new TypeError('Terminal purpose required');
    if(await this.approve(Object.freeze({kind:'terminal_exec',sandboxName:this.sandboxName,command:Object.freeze([...command]),cwd:cwd??null,purpose,groupId,sessionId}))!==true)throw new Error('Local terminal command denied');
    const args=['--json','sb','exec','-i','--local','--timeout',String(Math.max(1,Math.ceil(this.timeoutMs/1000)))];if(cwd)args.push('--cwd',cwd);args.push(this.sandboxName,'--',...command);
    const r=await this.#run(args);return Object.freeze({state:r.code===0?'completed':'failed',exitCode:r.code,stdout:r.stdout.slice(0,this.outputLimitBytes),stderr:r.stderr.slice(0,4000),sandboxName:this.sandboxName});
  }
  async close(){if(this.closed)return;this.closed=true;if(this.ready){const r=await this.#run(['--json','sb','rm','--local',this.sandboxName],30000).catch(()=>null);this.ready=false;if(!r||r.code!==0)throw new Error('Dedicated sandbox removal could not be verified');}}
  get status(){return Object.freeze({configured:true,ready:this.ready,closed:this.closed,sandboxName:this.sandboxName,hostShellAvailable:false});}
}

export function createExternalWorkspaceService({desktop=null,android=null,terminal=null}={}){
  let stopped=false;
  return Object.freeze({
    status(){const desktopReady=!!desktop&&desktop.client?.status?.connected!==false;const androidReady=!!android&&android.client?.status?.connected!==false;const terminalState=terminal?terminal.status:{available:false,hostShellAvailable:false};const terminalReady=!!terminal&&terminalState.ready===true&&terminalState.closed!==true;return Object.freeze({stopped,capabilities:Object.freeze({desktop:!stopped&&desktopReady,android:!stopped&&androidReady,terminal:!stopped&&terminalReady}),desktop:{available:!stopped&&desktopReady,tools:desktop?.client?.status?.tools??[]},android:android?{...android.statusSummary,available:!stopped&&androidReady}:{available:false,trackedTasks:0},terminal:terminal?{...terminalState,available:!stopped&&terminalReady}:{available:false,hostShellAvailable:false}});},
    async listDesktopWindows(input){if(stopped||!desktop)throw new Error('desktop_workspace_unavailable');return desktop.listWindows(input);},
    async observeDesktop(input){if(stopped||!desktop)throw new Error('desktop_workspace_unavailable');return desktop.observeWindow(input);},
    async draftDesktop(input){if(stopped||!desktop)throw new Error('desktop_workspace_unavailable');return desktop.draftText(input);},
    async runAndroidTask(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.runTask(input);},
    async androidTaskStatus(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.status(input);},
    async stopAndroidTask(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.stop(input);},
    async observeAndroid(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.observe(input);},
    async execTerminal(input){if(stopped||!terminal)throw new Error('terminal_workspace_unavailable');return terminal.exec(input);},
    async stop(){if(stopped)return Object.freeze({stopped:true,closeFailures:0});stopped=true;const jobs=[desktop?.client?.close?.(),android?.client?.close?.(),terminal?.close?.()].filter(Boolean);const settled=await Promise.allSettled(jobs);return Object.freeze({stopped:true,closeFailures:settled.filter(x=>x.status==='rejected').length});}
  });
}
