import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

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
const TEXT_CONTROL_ROLE=/(text[_ -]?(field|input|entry|area|editor|box)|textbox|textarea|editable[_ -]?text)/i;
function elementDescriptor(element){
 const frame=element?.frame&&['x','y','w','h'].every(k=>Number.isFinite(element.frame[k]))
  ?Object.freeze({x:element.frame.x,y:element.frame.y,w:element.frame.w,h:element.frame.h}):null;
 return Object.freeze({
  role:String(element?.role??element?.type??'').trim(),
  label:typeof element?.label==='string'?element.label:'',
  depth:Number.isSafeInteger(element?.depth)?element.depth:null,
  parentIndex:Number.isSafeInteger(element?.parent_index)?element.parent_index:null,
  frame
 });
}
function sameElementDescriptor(a,b){
 if(!a||!b||a.role!==b.role||a.label!==b.label||a.depth!==b.depth||a.parentIndex!==b.parentIndex)return false;
 if(a.frame===null||b.frame===null)return a.frame===null&&b.frame===null;
 return Math.abs(a.frame.x-b.frame.x)<=0.5&&Math.abs(a.frame.y-b.frame.y)<=0.5&&Math.abs(a.frame.w-b.frame.w)<=0.5&&Math.abs(a.frame.h-b.frame.h)<=0.5;
}
function actionEffect(result){return result?.effect??result?.action?.effect??result?.structuredContent?.effect??null;}
function actionError(result){return result?.error??result?.action?.error??null;}

const PROJECT_SKIP_DIRS=new Set(['.git','node_modules','.next','.nuxt','.vercel','.expo','.gradle','.idea','.obsidian','.cache','.turbo','.venv','venv','env','target','dist','build','coverage','test-results','playwright-report','artifacts','logs','tmp','temp','vendor','secrets','credentials','private','keys','certificates','__pycache__']);
const PROJECT_SKIP_FILES=new Set(['.npmrc','.pypirc','.netrc','.git-credentials','credentials.json','service-account.json','id_rsa','id_ed25519','authorized_keys','known_hosts','.ds_store','*.pem','*.key','*.p12','*.pfx','*.jks','*.keystore','*.sqlite','*.db','*.dump','*.bak','*.log','*.zip','*.tar','*.gz','*.7z','*.rar']);
const HIGH_CONFIDENCE_SECRET=/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sb_secret_[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:service_role|serviceRole|SUPABASE_SERVICE_ROLE_KEY)\s*[:=]\s*[\"']?eyJ[A-Za-z0-9_.-]{30,})/;
function omitProjectPath(relPath,isDirectory){
  const normalized=relPath.split(sep).join('/'),parts=normalized.split('/'),leaf=parts.at(-1).toLowerCase();
  if(parts.some(p=>PROJECT_SKIP_DIRS.has(p.toLowerCase())))return true;
  if(normalized.startsWith('supabase/.temp/')||normalized==='supabase/.temp')return true;
  if(leaf==='.env'||leaf.startsWith('.env.')||leaf==='.envrc'||leaf==='.npmrc'||leaf==='.pypirc'||leaf==='.netrc')return true;
  if(PROJECT_SKIP_FILES.has(leaf))return true;
  if(/(?:private[_-]?key|service[_-]?account|credentials?|secrets?)[._-]/i.test(leaf))return true;
  if(/\.(?:pem|key|p12|pfx|jks|keystore|sqlite|db|dump|bak|log|zip|tar|gz|7z|rar)$/i.test(leaf))return true;
  return false;
}
function tarString(buffer,text,offset,length){
  const bytes=Buffer.from(text,'utf8');
  if(bytes.length>length)throw new RangeError('Project path cannot be represented safely in source archive');
  bytes.copy(buffer,offset);
}
function tarOctal(buffer,value,offset,length){
  const valueText=Math.trunc(value).toString(8);
  if(valueText.length>length-1)throw new RangeError('Project archive numeric field overflow');
  Buffer.from(valueText.padStart(length-1,'0')+'\0','ascii').copy(buffer,offset);
}
function tarFileHeader(relPath,size,mode=0o644){
  let leaf=relPath,prefix='';
  if(Buffer.byteLength(leaf,'utf8')>100){
    let found=false;
    for(let i=relPath.lastIndexOf('/');i>0;i=relPath.lastIndexOf('/',i-1)){
      const maybePrefix=relPath.slice(0,i),maybeLeaf=relPath.slice(i+1);
      if(Buffer.byteLength(maybePrefix,'utf8')<=155&&Buffer.byteLength(maybeLeaf,'utf8')<=100){prefix=maybePrefix;leaf=maybeLeaf;found=true;break;}
    }
    if(!found)throw new RangeError('Project path is too long for safe POSIX tar format');
  }
  const h=Buffer.alloc(512);
  tarString(h,leaf,0,100);tarOctal(h,mode,100,8);tarOctal(h,0,108,8);tarOctal(h,0,116,8);
  tarOctal(h,size,124,12);tarOctal(h,0,136,12);h.fill(0x20,148,156);h[156]=0x30;
  tarString(h,'ustar\0',257,6);tarString(h,'00',263,2);tarString(h,'rub-minds',265,32);tarString(h,'backroom',297,32);tarString(h,prefix,345,155);
  let checksum=0;for(const byte of h)checksum+=byte;
  Buffer.from(checksum.toString(8).padStart(6,'0')+'\0 ','ascii').copy(h,148,0,8);
  return h;
}

/**
 * Packs a private repository snapshot for transfer into the isolated local
 * sandbox. Symlinks, VCS internals, dependencies, common credentials and large
 * generated artifacts are excluded; suspicious credential-bearing files are skipped.
 */
export async function createSafeWorkspaceArchive(projectSourcePath,{maxFiles=5000,maxEntries=20000,maxBytes=32*1024*1024,maxSingleFileBytes=3*1024*1024}={}){
  if(typeof projectSourcePath!=='string'||!projectSourcePath.trim())throw new TypeError('Trusted local project source path required');
  for(const [value,label,min,max] of [[maxFiles,'maxFiles',1,20000],[maxEntries,'maxEntries',1,100000],[maxBytes,'maxBytes',1024,256*1024*1024],[maxSingleFileBytes,'maxSingleFileBytes',1,32*1024*1024]])if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError('Invalid '+label);
  const requested=resolve(projectSourcePath),rootStat=await lstat(requested);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('Project source must be a real directory, not a symlink');
  const root=await realpath(requested);
  const fsRoot=resolve(root, '..')===root;
  if(fsRoot||root===resolve(homedir()))throw new Error('Filesystem root or home directory cannot be synchronized as a project');
  const rootEntries=await readdir(root);
  if(!rootEntries.includes('package.json')&&!rootEntries.includes('pyproject.toml')&&!rootEntries.includes('Cargo.toml')&&!rootEntries.includes('README.md')&&!rootEntries.includes('README')&&!rootEntries.includes('AndroidManifest.xml'))throw new Error('Choose a repository/project folder with a recognizable project marker');
  const files=[];let totalBytes=0,omittedSensitive=0,omittedLarge=0,visitedEntries=0;
  async function walk(folder){
    const entries=await readdir(folder,{withFileTypes:true});
    entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
    for(const entry of entries){
      visitedEntries++;
      if(visitedEntries>maxEntries)throw new Error('Project has too many filesystem entries to inspect safely; narrow the source folder');
      const full=join(folder,entry.name),rel=relative(root,full),normalized=rel.split(sep).join('/');
      if(/[\u0000-\u001f\u007f-\u009f]/u.test(entry.name)||entry.name==='.'||entry.name==='..')continue;
      if(!rel||rel.startsWith('..'+sep)||rel==='..')throw new Error('Project archive path escaped its root');
      if(omitProjectPath(rel,entry.isDirectory())){if(!entry.isDirectory())omittedSensitive++;continue;}
      const stat=await lstat(full);
      if(stat.isSymbolicLink())continue;
      if(stat.isDirectory()){await walk(full);continue;}
      if(!stat.isFile())continue;
      if(stat.size>maxSingleFileBytes){omittedLarge++;continue;}
      let handle;
      try{handle=await open(full,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0));}
      catch(error){if(error?.code==='ELOOP'||error?.code==='ENOENT'||error?.code==='EACCES'){omittedSensitive++;continue;}throw error;}
      let data;
      try{
        const opened=await handle.stat();
        if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino){omittedSensitive++;continue;}
        if(opened.size>maxSingleFileBytes){omittedLarge++;continue;}
        data=await handle.readFile();
      }finally{await handle.close();}
      if(data.length>maxSingleFileBytes){omittedLarge++;continue;}
      if(!data.includes(0)&&HIGH_CONFIDENCE_SECRET.test(data.toString('utf8'))){omittedSensitive++;continue;}
      if(totalBytes+data.length>maxBytes)throw new Error('Project snapshot exceeds configured byte limit; narrow it before syncing');
      if(files.length>=maxFiles)throw new Error('Project has too many included files; lower scope before syncing');
      files.push({rel:normalized,data,mode:stat.mode&0o111?0o755:0o644});totalBytes+=data.length;
    }
  }
  await walk(root);
  if(!files.length)throw new Error('No safe project files were available to sync');
  const chunks=[];
  for(const file of files){
    const header=tarFileHeader(file.rel,file.data.length,file.mode);
    chunks.push(header,file.data);
    const padding=(512-(file.data.length%512))%512;
    if(padding)chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive=Buffer.concat(chunks),sha256=createHash('sha256').update(archive).digest('hex');
  const directory=await mkdtemp(join(tmpdir(),'rm-backroom-source-'));
  const archivePath=join(directory,'workspace.tar');
  try{
    await writeFile(archivePath,archive,{flag:'wx',mode:0o600});
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  return Object.freeze({archivePath,tempDirectory:directory,sourceRoot:root,fileCount:files.length,visitedEntries,sourceBytes:totalBytes,archiveBytes:archive.length,sha256,omittedSensitive,omittedLarge});
}


export class CuaDesktopWorkspace {
  #observations=new Map();
  #observationTtlMs=5*60*1000;
  #maxObservations=1024;
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
    return Object.freeze(list.filter(w=>w&&Number.isSafeInteger(Number(w.pid))&&Number(w.pid)>0&&Number.isSafeInteger(Number(w.window_id??w.windowId))&&Number(w.window_id??w.windowId)>0)
      .map(w=>Object.freeze({pid:Number(w.pid),windowId:Number(w.window_id??w.windowId),appName:String(w.app_name??w.appName??''),title:String(w.title??''),zIndex:Number.isFinite(w.z_index)?w.z_index:null})));
  }
  async #snapshot({pid,windowId}){
    positiveInt(pid,'pid');positiveInt(windowId,'windowId');await this.#require(['get_window_state','list_windows']);
    const state=structured(await this.client.callTool('get_window_state',{pid,window_id:windowId,tree_format:'elements',full_output:true,session:this.session}));
    if(Number(state.pid)!==pid||Number(state.window_id??state.windowId)!==windowId)throw new Error('CUA snapshot PID/window mismatch');
    const window=(await this.#listWindows()).find(w=>w.pid===pid&&w.windowId===windowId);
    if(!window)throw new Error('Selected desktop window disappeared');
    return {state,window,elements:elements(state)};
  }
  #observationKey(groupId,sessionId,pid,windowId,elementToken){return JSON.stringify([groupId,sessionId,pid,windowId,elementToken]);}
  #pruneObservations(){
    const now=Date.now();
    for(const [key,value] of this.#observations)if(now-value.observedAt>this.#observationTtlMs)this.#observations.delete(key);
    while(this.#observations.size>this.#maxObservations)this.#observations.delete(this.#observations.keys().next().value);
  }
  #findUniqueElement(currentElements,descriptor){
    const matches=currentElements.filter(element=>sameElementDescriptor(descriptor,elementDescriptor(element)));
    if(matches.length!==1)throw new Error('Selected text field changed or is ambiguous; inspect the window again');
    return matches[0];
  }
  async observeWindow({pid,windowId,groupId,sessionId}={}){
    positiveInt(pid,'pid');positiveInt(windowId,'windowId');scopeIds(groupId,sessionId);
    if(await this.approve(Object.freeze({kind:'desktop_observe',pid,windowId,groupId,sessionId}))!==true)throw new Error('Local desktop observation denied');
    const {state,window,elements}=await this.#snapshot({pid,windowId});
    const now=Date.now();this.#pruneObservations();
    const elementOptions=elements.slice(0,250).flatMap(element=>{
      const elementToken=typeof element?.element_token==='string'?element.element_token:null;
      if(!elementToken)return [];
      const descriptor=elementDescriptor(element);
      this.#observations.set(this.#observationKey(groupId,sessionId,pid,windowId,elementToken),{
        descriptor,observedAt:now,appName:window.appName,title:window.title,snapshotId:typeof state.snapshot_id==='string'?state.snapshot_id:null
      });
      const label=Array.from(descriptor.label).map(character=>{
        const code=character.codePointAt(0);
        return code<=31||(code>=127&&code<=159)||code===0x2028||code===0x2029?' ':character;
      }).join('').slice(0,120);
      return [Object.freeze({
        elementToken,role:descriptor.role,label,
        valueEmpty:typeof element.value==='string'&&element.value==='',
        typeable:TEXT_CONTROL_ROLE.test(descriptor.role)&&typeof element.value==='string'&&element.value===''&&element.enabled!==false
      })];
    });
    this.#pruneObservations();
    return Object.freeze({pid,windowId,groupId,sessionId,appName:window.appName,title:window.title,elementCount:elements.length,degraded:state.degraded===true,snapshotId:typeof state.snapshot_id==='string'?state.snapshot_id:null,elements:Object.freeze(elementOptions),state:'observed'});
  }
  async draftText({pid,windowId,elementToken,text,expectedAppName,expectedTitle,groupId,sessionId}={}){
    positiveInt(pid,'pid');positiveInt(windowId,'windowId');scopeIds(groupId,sessionId);
    if(typeof elementToken!=='string'||!ID.test(elementToken))throw new TypeError('Snapshot-derived CUA element token required');
    if(typeof text!=='string'||!text.trim()||text.length>MAX_TEXT||CONTROL.test(text))throw new TypeError('Draft must be safe single-line text of at most 4000 characters');
    if(typeof expectedAppName!=='string'||!expectedAppName.trim()||typeof expectedTitle!=='string'||!expectedTitle.trim())throw new TypeError('Expected app/window identity required');
    this.#pruneObservations();
    const original=this.#observations.get(this.#observationKey(groupId,sessionId,pid,windowId,elementToken));
    if(!original)throw new Error('Fresh local CUA observation required for this group, session and window');
    if(original.appName!==expectedAppName||original.title!==expectedTitle)throw new Error('Desktop identity does not match the original observed control');
    if(!TEXT_CONTROL_ROLE.test(original.descriptor.role))throw new Error('Selected element is not a clearly editable text control');
    if(await this.approve(Object.freeze({kind:'desktop_draft_inspect',pid,windowId,expectedAppName,expectedTitle,elementToken,elementRole:original.descriptor.role,elementLabel:original.descriptor.label,groupId,sessionId}))!==true)throw new Error('Local desktop observation denied');
    const before=await this.#snapshot({pid,windowId});
    if(before.window.appName!==expectedAppName||before.window.title!==expectedTitle)throw new Error('Desktop app/window identity changed');
    const field=this.#findUniqueElement(before.elements,original.descriptor);
    if(typeof field.value!=='string'||field.value!==''||field.enabled===false)throw new Error('Selected text-entry control is not explicitly verified empty and enabled');
    const approval=await this.approve(Object.freeze({kind:'desktop_draft',pid,windowId,appName:expectedAppName,title:expectedTitle,text,elementToken,elementRole:original.descriptor.role,elementLabel:original.descriptor.label,snapshotId:original.snapshotId,groupId,sessionId}));
    if(approval!==true)throw new Error('Local desktop action denied');
    const fresh=await this.#snapshot({pid,windowId});
    if(fresh.window.appName!==expectedAppName||fresh.window.title!==expectedTitle)throw new Error('Desktop app/window identity changed after approval');
    const current=this.#findUniqueElement(fresh.elements,original.descriptor);
    if(typeof current.value!=='string'||current.value!==''||current.enabled===false||typeof current.element_token!=='string')throw new Error('Selected text-entry control changed after approval');
    await this.#require(['click','type_text']);
    // CUA tokens belong to one snapshot. Focus with the current token, then type
    // immediately into the exact window without requesting another snapshot in between.
    let focused;
    try{focused=structured(await this.client.callTool('click',{target:{kind:'window',pid,window_id:windowId},element_token:current.element_token,delivery_mode:'foreground',session:this.session}));}
    catch{return Object.freeze({state:'needs_review',submitted:false,reason:'CUA focus result was unavailable; inspect before retrying'});}
    if(actionEffect(focused)!=='confirmed'||actionError(focused))return Object.freeze({state:'needs_review',submitted:false,reason:'CUA could not confirm text-field focus'});
    let typed;
    try{typed=structured(await this.client.callTool('type_text',{text,target:{kind:'window',pid,window_id:windowId},session:this.session}));}
    catch{return Object.freeze({state:'needs_review',submitted:false,reason:'CUA type result was unavailable; inspect before retrying'});}
    if(actionEffect(typed)!=='confirmed'||actionError(typed))return Object.freeze({state:'needs_review',submitted:false,reason:'CUA did not confirm text input'});
    try{
      const after=await this.#snapshot({pid,windowId});
      if(after.window.appName!==expectedAppName||after.window.title!==expectedTitle)return Object.freeze({state:'needs_review',submitted:false,reason:'Desktop app/window changed after typing'});
      const written=this.#findUniqueElement(after.elements,original.descriptor);
      if(written.value!==text)return Object.freeze({state:'needs_review',submitted:false,reason:'Desktop text readback mismatch'});
      return Object.freeze({state:'completed',submitted:false,verified:true,result:{drafted:true,submitted:false,pid,windowId,elementToken:current.element_token}});
    }catch{return Object.freeze({state:'needs_review',submitted:false,reason:'Desktop typing outcome could not be independently read back'});}
  }
}

/** ARTEMIS is an asynchronous mobile task engine, so results are managed by trace ID. */
export class ArtemisAndroidWorkspace {
  constructor({client,allowedDevices=[],allowedPackages=[],authorizeLocalAction}={}){
    if(!client||typeof client.callTool!=='function'||typeof client.listTools!=='function')throw new TypeError('Initialized ARTEMIS MCP client required');
    needApproval(authorizeLocalAction,'Android actions');this.client=client;this.devices=new Set(allowedDevices);this.packages=new Set(allowedPackages);this.approve=authorizeLocalAction;this.tasks=new Map();
  }
  async #require(names){const found=new Set((await this.client.listTools()).map(t=>t.name));const missing=names.filter(n=>!found.has(n));if(missing.length)throw new Error('ARTEMIS tool contract unavailable: '+missing.join(','));}
  async diagnose({groupId,sessionId}={}){scopeIds(groupId,sessionId);if(await this.approve(Object.freeze({kind:'android_diagnose',groupId,sessionId,verifyCredentials:false,probeDevice:false}))!==true)throw new Error('Local Android diagnostics denied');await this.#require(['mobile_diagnose']);return this.client.callTool('mobile_diagnose',{});}
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
  get statusSummary(){const tools=this.client?.status?.tools??[];const required=['mobile_run_task','mobile_manage_task','mobile_get_device_state'];return Object.freeze({available:required.every(name=>tools.includes(name)),trackedTasks:this.tasks.size,tools:Object.freeze([...tools])});}
}

/** Creates and destroys a dedicated local gVisor sandbox; never executes on host shell. */
export class CuaSandboxTerminalWorkspace {
  #pendingPatches;
  #prunePendingPatches(){const now=Date.now();for(const [key,p] of this.#pendingPatches)if(now-p.createdAt>10*60*1000)this.#pendingPatches.delete(key);while(this.#pendingPatches.size>16)this.#pendingPatches.delete(this.#pendingPatches.keys().next().value);}
  #safePatchPaths(patch){const lines=patch.split('\n').filter(line=>line.startsWith('diff --git '));if(patch&&!lines.length)throw new Error('Patch format is not reviewable');const paths=[];for(const line of lines){const m=/^diff --git a\/(.+) b\/(.+)$/.exec(line);if(!m)throw new Error('Patch contains a quoted or unsupported file path; review it manually');const a=m[1],b=m[2];if(a!==b||!a||a.startsWith('/')||a.includes('\\')||/[\u0000-\u001f\u007f-\u009f]/u.test(a)||a.split('/').some(p=>p==='.'||p==='..')||a.split('/').includes('.git'))throw new Error('Patch contains an unsafe file path');paths.push(a);}return [...new Set(paths)].sort();}
  async #runLocalGit(args,input='',cwd){
    if(typeof cwd!=='string'||!cwd)throw new TypeError('Local project root required');
    if(Buffer.byteLength(input,'utf8')>512*1024)throw new RangeError('Local Git input exceeds the patch limit');
    const spawn=this.localGitSpawnImpl??(await import('node:child_process')).spawn;
    const env={GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'};
    for(const key of ['PATH','PATHEXT','COMSPEC','PROGRAMFILES','PROGRAMFILES(X86)','HOMEDRIVE','HOMEPATH','HOME','USERPROFILE','TMPDIR','TEMP','TMP','SYSTEMROOT','WINDIR','APPDATA','LOCALAPPDATA','LANG','LC_ALL'])if(typeof process.env[key]==='string')env[key]=process.env[key];
    return new Promise((resolve,reject)=>{
      let child;try{child=spawn(this.gitCommand,args,{cwd,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{reject(new Error('Could not launch local Git'));return;}
      if(!child?.stdin||!child?.stdout||!child?.stderr||typeof child.once!=='function'){reject(new Error('Local Git process must expose stdio pipes'));return;}
      let stdout='',stderr='',bytes=0,settled=false,overflow=false,timedOut=false,killTimer=null;
      const kill=()=>{try{child.kill('SIGTERM');}catch{}if(!killTimer){killTimer=setTimeout(()=>{try{if(child.exitCode===null)child.kill('SIGKILL');}catch{}},1000);killTimer.unref?.();}};
      const append=(target,chunk)=>{bytes+=chunk.length;if(bytes>128*1024){overflow=true;kill();return;}if(target==='out')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');};
      child.stdout.on('data',chunk=>append('out',chunk));child.stderr.on('data',chunk=>append('err',chunk));
      const timer=setTimeout(()=>{if(settled)return;timedOut=true;kill();},30000);timer.unref?.();
      child.once('error',()=>{if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);reject(new Error('Local Git process failed'));});
      child.once('close',(code,signal)=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);if(settled)return;settled=true;if(timedOut){reject(new Error('Local Git operation timed out'));return;}if(overflow){reject(new Error('Local Git output exceeded its limit'));return;}resolve(Object.freeze({code:Number.isInteger(code)?code:1,signal:signal??null,stdout,stderr:stderr.slice(0,4000)}));});
      try{child.stdin.end(input,'utf8');}catch{kill();reject(new Error('Local Git input failed'));}
    });
  }
  constructor({command='cua',sandboxName,authorizeLocalAction,spawnImpl,localGitSpawnImpl,gitCommand='git',timeoutMs=120000,outputLimitBytes=1048576,projectSourcePath=process.env.BACKROOM_TERMINAL_PROJECT_PATH??process.cwd()}={}){
    if(typeof command!=='string'||!command.trim())throw new TypeError('CUA CLI executable required');
    if(typeof sandboxName!=='string'||!/^rm-backroom-[a-z0-9-]{4,48}$/.test(sandboxName))throw new TypeError('Dedicated rm-backroom-* sandbox required');
    needApproval(authorizeLocalAction,'Terminal execution');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new RangeError('Invalid terminal timeout');
    if(!Number.isSafeInteger(outputLimitBytes)||outputLimitBytes<1024||outputLimitBytes>4194304)throw new RangeError('Invalid terminal output bound');
    Object.assign(this,{command,sandboxName,approve:authorizeLocalAction,spawnImpl,localGitSpawnImpl,gitCommand,timeoutMs,outputLimitBytes,projectSourcePath,ready:false,closed:false,projectSync:null});
    this.#pendingPatches=new Map();
  }
  async #run(args,timeoutMs=this.timeoutMs){
    const spawn=this.spawnImpl??(await import('node:child_process')).spawn;
    return new Promise((resolve,reject)=>{
      let child;try{child=spawn(this.command,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{reject(new Error('Could not launch CUA CLI'));return;}
      let stdout='',stderr='',bytes=0,settled=false,overflow=false,killTimer=null;
      const forceTerminate=()=>{
        try{child.kill('SIGTERM');}catch{}
        if(!killTimer){killTimer=setTimeout(()=>{try{if(child.exitCode===null)child.kill('SIGKILL');}catch{}},1000);killTimer.unref?.();}
      };
      const append=(which,chunk)=>{
        bytes+=chunk.length;
        if(bytes>this.outputLimitBytes){overflow=true;forceTerminate();return;}
        if(which==='out')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');
      };
      child.stdout?.on('data',chunk=>append('out',chunk));child.stderr?.on('data',chunk=>append('err',chunk));
      const timer=setTimeout(()=>{if(settled)return;settled=true;forceTerminate();reject(new Error('Sandbox command timed out'));},timeoutMs);timer.unref?.();
      child.once('error',()=>{if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);reject(new Error('CUA sandbox process failed'));});
      child.once('close',(code,signal)=>{
        clearTimeout(timer);if(killTimer)clearTimeout(killTimer);
        if(settled)return;settled=true;
        if(overflow){reject(new Error('Sandbox output exceeded configured limit'));return;}
        resolve(Object.freeze({code:Number.isInteger(code)?code:1,signal:signal??null,stdout,stderr:stderr.slice(0,4000)}));
      });
    });
  }
  async #runGuest(command,timeoutMs=this.timeoutMs){
    const args=['--json','sb','exec','-i','--local','--timeout',String(Math.max(1,Math.ceil(timeoutMs/1000)))];
    args.push(this.sandboxName,'--',...command);
    const result=await this.#run(args,timeoutMs);
    if(result.code!==0)throw new Error('Sandbox workspace operation failed: '+command[0]);
    return result;
  }
  async syncProject({groupId,sessionId}={}){
    if(!this.ready||this.closed)throw new Error('Dedicated terminal sandbox is not ready');
    scopeIds(groupId,sessionId);
    this.#pendingPatches.clear();
    const archive=await createSafeWorkspaceArchive(this.projectSourcePath);
    try{
      const approval=await this.approve(Object.freeze({
        kind:'terminal_project_sync',sandboxName:this.sandboxName,projectRoot:archive.sourceRoot,
        fileCount:archive.fileCount,sourceBytes:archive.sourceBytes,archiveBytes:archive.archiveBytes,
        archiveSha256:archive.sha256,omittedSensitive:archive.omittedSensitive,omittedLarge:archive.omittedLarge,
        destination:'/workspace/project',overwriteExistingProject:true,
        warning:'The existing sandbox project folder will be replaced. Git internals, dependencies, common secrets and build output are not copied.'
      }));
      if(approval!==true)throw new Error('Local approval denied project source transfer');
      // Exact local copy operation: no shell, no token, and an explicit local sandbox ref.
      await this.#runGuest(['rm','-rf','/workspace/project','/tmp/rub-backroom-source.tar']);
      const copied=await this.#run(['--json','sb','cp',archive.archivePath,'local:'+this.sandboxName+':/tmp/rub-backroom-source.tar'],180000);
      if(copied.code!==0)throw new Error('Could not transfer approved project snapshot to the local sandbox');
      await this.#runGuest(['mkdir','-p','/workspace/project']);
      await this.#runGuest(['tar','-xf','/tmp/rub-backroom-source.tar','-C','/workspace/project'],180000);
      await this.#runGuest(['rm','-f','/tmp/rub-backroom-source.tar']);
      // Establish a local baseline so any future diff/export feature can compare to this snapshot.
      await this.#runGuest(['git','init','-q','/workspace/project']);
      await this.#runGuest(['git','-C','/workspace/project','add','-A']);
      await this.#runGuest(['git','-c','user.name=Backroom Local','-c','user.email=backroom-local@localhost','-C','/workspace/project','commit','--quiet','--allow-empty','-m','Backroom source snapshot baseline']);
      this.projectSync=Object.freeze({sourceRoot:archive.sourceRoot,fileCount:archive.fileCount,sourceBytes:archive.sourceBytes,archiveBytes:archive.archiveBytes,sha256:archive.sha256,syncedAt:new Date().toISOString(),omittedSensitive:archive.omittedSensitive,omittedLarge:archive.omittedLarge});
      return Object.freeze({state:'completed',projectSynced:true,fileCount:archive.fileCount,sourceBytes:archive.sourceBytes,archiveBytes:archive.archiveBytes,sha256:archive.sha256,omittedSensitive:archive.omittedSensitive,omittedLarge:archive.omittedLarge,destination:'/workspace/project'});
    }catch(error){
      this.projectSync=null;
      // A partially unpacked snapshot is not a ready workspace; remove it if possible.
      await this.#runGuest(['rm','-rf','/workspace/project','/tmp/rub-backroom-source.tar'],30000).catch(()=>null);
      throw error;
    }finally{await rm(archive.tempDirectory,{recursive:true,force:true}).catch(()=>{});}
  }
  async start(){if(this.closed)throw new Error('Sandbox lifecycle closed');if(this.ready)return this.status;
    const r=await this.#run(['--json','sb','create','linux','--on','local','--kind','container','--runtime','gvisor','--headless','--install','node','--name',this.sandboxName]);
    if(r.code!==0)throw new Error('Local gVisor sandbox creation failed; existing sandboxes are never adopted');this.ready=true;return this.status;
  }
  async exec({command,cwd,purpose='Backroom terminal task',groupId,sessionId}={}){
    if(!this.ready||this.closed)throw new Error('Dedicated terminal sandbox is not ready');
    if(!this.projectSync)throw new Error('Sync an approved local project snapshot before running terminal commands');
    this.#pendingPatches.clear();
    if(!Array.isArray(command)||command.length<1||command.length>128||command.some(v=>typeof v!=='string'||!v||v.includes('\0')||v.length>2000))throw new TypeError('Terminal command must be a bounded argv array');
    const exe=command[0].split(/[\\/]/).at(-1).toLowerCase();if(SHELLS.has(exe)||!TERMINAL_BINS.has(exe))throw new Error('Shell interpreters and non-allowlisted executables are denied');
    if(cwd!==undefined&&(typeof cwd!=='string'||!cwd.startsWith('/')||cwd.split('/').includes('..')))throw new TypeError('Sandbox cwd must be an absolute POSIX path without traversal');
    scopeIds(groupId,sessionId);if(typeof purpose!=='string'||!purpose.trim()||purpose.length>300)throw new TypeError('Terminal purpose required');
    if(await this.approve(Object.freeze({kind:'terminal_exec',sandboxName:this.sandboxName,command:Object.freeze([...command]),cwd:cwd??null,purpose,groupId,sessionId}))!==true)throw new Error('Local terminal command denied');
    const args=['--json','sb','exec','-i','--local','--timeout',String(Math.max(1,Math.ceil(this.timeoutMs/1000)))];if(cwd)args.push('--cwd',cwd);args.push(this.sandboxName,'--',...command);
    const r=await this.#run(args);return Object.freeze({state:r.code===0?'completed':'failed',exitCode:r.code,stdout:r.stdout.slice(0,this.outputLimitBytes),stderr:r.stderr.slice(0,4000),sandboxName:this.sandboxName});
  }
  async diffProject({groupId,sessionId}={}){
    if(!this.ready||this.closed)throw new Error('Dedicated terminal sandbox is not ready');
    if(!this.projectSync)throw new Error('Sync an approved local project snapshot before reviewing terminal changes');
    scopeIds(groupId,sessionId);
    const approval=await this.approve(Object.freeze({
      kind:'terminal_diff_export',sandboxName:this.sandboxName,groupId,sessionId,
      destination:'Rub Minds Backroom browser · review only',
      warning:'Return a bounded Git patch for inspection. This does not edit or apply changes to the host repository.'
    }));
    if(approval!==true)throw new Error('Local approval denied terminal diff export');
    await this.#runGuest(['git','-C','/workspace/project','add','-N','--','.']);
    const result=await this.#runGuest(['git','-C','/workspace/project','diff','--no-ext-diff','--no-textconv','--no-color','--no-renames','HEAD','--','.']);
    const patch=result.stdout;
    const bytes=Buffer.byteLength(patch,'utf8');
    if(bytes>512*1024)throw new Error('Workspace diff exceeds the 512 KiB review limit; split it into smaller reviewed changes');
    const sha256=createHash('sha256').update(patch).digest('hex');
    if(/^(?:Binary files .+ differ|GIT binary patch)$/m.test(patch))throw new Error('Binary changes cannot be exported; exclude them before reviewing this patch');
    if(HIGH_CONFIDENCE_SECRET.test(patch))return Object.freeze({state:'needs_review',patch:'',bytes,sha256,reason:'Potential credential or private-key material detected. Patch was not returned to the browser.'});
    const paths=this.#safePatchPaths(patch);
    let exportKey=null;
    if(patch.length>0){this.#prunePendingPatches();exportKey=randomBytes(32).toString('hex');this.#pendingPatches.set(exportKey,{patch,sha256,paths,groupId,sessionId,sourceRoot:this.projectSync.sourceRoot,createdAt:Date.now()});this.#prunePendingPatches();}
    return Object.freeze({state:'completed',patch,bytes,sha256,empty:patch.length===0,paths,exportKey,applyAvailable:!!exportKey,appliedToHost:false,destination:'Rub Minds Backroom browser review only'});
  }
  async #verifyPatchTargets(root,paths){
    const base=await realpath(root);
    for(const rel of paths){
      const parts=rel.split('/');
      let current=base;
      for(let index=0;index<parts.length;index++){
        current=join(current,parts[index]);
        let stat;
        try{stat=await lstat(current);}catch(error){if(error?.code==='ENOENT')break;throw error;}
        if(stat.isSymbolicLink())throw new Error('Patch target passes through a symbolic link; apply it manually after review');
        if(index<parts.length-1&&!stat.isDirectory())throw new Error('Patch target parent is not a directory');
        const actual=await realpath(current).catch(()=>null);
        if(!actual||(actual!==base&&!actual.startsWith(base+sep)))throw new Error('Patch target resolves outside the approved repository root');
      }
    }
  }
  async applyProjectDiff({exportKey,sha256,groupId,sessionId}={}){
    if(!this.ready||this.closed)throw new Error('Dedicated terminal sandbox is not ready');
    if(!this.projectSync)throw new Error('Sync an approved local project snapshot before applying a patch');
    scopeIds(groupId,sessionId);
    if(typeof exportKey!=='string'||!/^[a-f0-9]{64}$/.test(exportKey)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw new TypeError('Valid one-use patch reference and digest required');
    this.#prunePendingPatches();
    const pending=this.#pendingPatches.get(exportKey);
    if(!pending||pending.groupId!==groupId||pending.sessionId!==sessionId||pending.sha256!==sha256)throw new Error('Patch is expired or outside the original group/session scope');
    if(createHash('sha256').update(pending.patch).digest('hex')!==sha256)throw new Error('Patch digest validation failed');
    this.#pendingPatches.delete(exportKey);
    if(!pending.paths.length)throw new Error('Empty patches cannot be applied');
    const root=await realpath(pending.sourceRoot);
    if(root!==pending.sourceRoot||root!==this.projectSync.sourceRoot)throw new Error('Local project root changed since source sync');
    const rootStat=await lstat(root);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('Local project root is no longer a real directory');
    await this.#verifyPatchTargets(root,pending.paths);
    const top=await this.#runLocalGit(['rev-parse','--show-toplevel'],'',root);
    if(top.code!==0)throw new Error('The selected local project is not a Git working tree');
    const gitRoot=await realpath(top.stdout.trim()).catch(()=>null);
    if(!gitRoot||gitRoot!==root)throw new Error('Git working-tree root does not match the approved project root');
    const check=await this.#runLocalGit(['apply','--check','-'],pending.patch,root);
    if(check.code!==0)throw new Error('Local project has changed or the reviewed patch does not apply cleanly; no files were modified');
    const approval=await this.approve(Object.freeze({kind:'terminal_patch_apply',sandboxName:this.sandboxName,repositoryRoot:root,groupId,sessionId,patchSha256:sha256,patchBytes:Buffer.byteLength(pending.patch,'utf8'),files:pending.paths,commit:false,push:false,warning:'Apply this exact one-use patch to the local working tree only. It will not stage, commit or push changes.'}));
    if(approval!==true)throw new Error('Local approval denied patch application');
    // The approval prompt may remain open while the user edits the checkout. Recheck paths and patch after approval.
    await this.#verifyPatchTargets(root,pending.paths);
    const finalCheck=await this.#runLocalGit(['apply','--check','-'],pending.patch,root);
    if(finalCheck.code!==0)throw new Error('Local project changed after approval or the patch no longer applies cleanly; no files were modified');
    const applied=await this.#runLocalGit(['apply','-'],pending.patch,root);
    if(applied.code!==0)throw new Error('Git refused to apply the previously checked patch; inspect the local working tree before retrying');
    return Object.freeze({state:'completed',appliedToHost:true,committed:false,pushed:false,sha256,paths:pending.paths,repositoryRoot:root});
  }
  async close(){if(this.closed&&!this.ready)return;this.closed=true;if(this.ready){const r=await this.#run(['--json','sb','rm','--local',this.sandboxName],30000).catch(()=>null);if(!r||r.code!==0)throw new Error('Dedicated sandbox removal could not be verified');this.ready=false;this.projectSync=null;this.#pendingPatches.clear();}}
  get status(){return Object.freeze({configured:true,ready:this.ready,closed:this.closed,sandboxName:this.sandboxName,hostShellAvailable:false,cleanupPending:this.closed&&this.ready,projectConfigured:typeof this.projectSourcePath==='string'&&!!this.projectSourcePath.trim(),projectSynced:!!this.projectSync,projectFileCount:this.projectSync?.fileCount??0,projectSourceBytes:this.projectSync?.sourceBytes??0,projectSyncedAt:this.projectSync?.syncedAt??null});}
}

export function createExternalWorkspaceService({desktop=null,android=null,terminal=null,startupErrors={}}={}){
  let stopped=false;
  const safeStartupErrors=Object.freeze(Object.fromEntries(Object.entries(startupErrors).filter(([key,value])=>
    ['desktop','android','terminal'].includes(key)&&typeof value==='string'&&value.trim()
  ).map(([key,value])=>[key,value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,180)])));
  return Object.freeze({
    status(){
      const desktopTools=desktop?.client?.status?.tools??[];
      const androidTools=android?.client?.status?.tools??[];
      const desktopRequired=['list_windows','get_window_state','click','type_text'];
      const androidRequired=['mobile_run_task','mobile_manage_task','mobile_get_device_state'];
      const androidDiagnoseReady=!!android&&android.client?.status?.connected===true&&androidTools.includes('mobile_diagnose');
      const desktopReady=!!desktop&&desktop.client?.status?.connected===true&&desktopRequired.every(name=>desktopTools.includes(name));
      const androidReady=!!android&&android.client?.status?.connected===true&&androidRequired.every(name=>androidTools.includes(name));
      const terminalState=terminal?terminal.status:{available:false,hostShellAvailable:false};
      const terminalReady=!!terminal&&terminalState.ready===true&&terminalState.closed!==true;
      return Object.freeze({
        stopped,
        capabilities:Object.freeze({desktop:!stopped&&desktopReady,android:!stopped&&androidReady,terminal:!stopped&&terminalReady}),
        startupErrors:safeStartupErrors,
        desktop:{available:!stopped&&desktopReady,tools:desktopTools,missingTools:desktopRequired.filter(name=>!desktopTools.includes(name))},
        android:android?{...android.statusSummary,available:!stopped&&androidReady,diagnoseAvailable:!stopped&&androidDiagnoseReady,missingTools:androidRequired.filter(name=>!androidTools.includes(name))}:{available:false,diagnoseAvailable:false,trackedTasks:0,missingTools:androidRequired},
        terminal:terminal?{...terminalState,available:!stopped&&terminalReady}:{available:false,hostShellAvailable:false}
      });
    },
    async listDesktopWindows(input){if(stopped||!desktop)throw new Error('desktop_workspace_unavailable');return desktop.listWindows(input);},
    async observeDesktop(input){if(stopped||!desktop)throw new Error('desktop_workspace_unavailable');return desktop.observeWindow(input);},
    async draftDesktop(input){if(stopped||!desktop)throw new Error('desktop_workspace_unavailable');return desktop.draftText(input);},
    async diagnoseAndroid(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.diagnose(input);},
    async runAndroidTask(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.runTask(input);},
    async androidTaskStatus(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.status(input);},
    async stopAndroidTask(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.stop(input);},
    async observeAndroid(input){if(stopped||!android)throw new Error('android_workspace_unavailable');return android.observe(input);},
    async execTerminal(input){if(stopped||!terminal)throw new Error('terminal_workspace_unavailable');return terminal.exec(input);},
    async syncTerminalProject(input){if(stopped||!terminal)throw new Error('terminal_workspace_unavailable');return terminal.syncProject(input);},
    async diffTerminalProject(input){if(stopped||!terminal)throw new Error('terminal_workspace_unavailable');return terminal.diffProject(input);},
    async applyTerminalProjectDiff(input){if(stopped||!terminal)throw new Error('terminal_workspace_unavailable');return terminal.applyProjectDiff(input);},
    async stop(){
      stopped=true;
      const jobs=[desktop?.client?.close?.(),android?.client?.close?.(),terminal?.close?.()].filter(Boolean);
      const settled=await Promise.allSettled(jobs);
      return Object.freeze({stopped:true,closeFailures:settled.filter(x=>x.status==='rejected').length});
    }
  });
}
