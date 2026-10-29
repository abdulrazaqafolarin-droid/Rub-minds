import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { McpStdioClient } from './mcp-stdio-client.mjs';
import { ArtemisAndroidWorkspace, CuaDesktopWorkspace, CuaSandboxTerminalWorkspace, createExternalWorkspaceService, createSafeWorkspaceArchive } from './external-workspaces.mjs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const names = values => values.map(name => ({ name }));
class FakeMcp {
  constructor(values, handler) { this.tools=names(values); this.handler=handler; this.calls=[]; this.closed=false; }
  get status(){return Object.freeze({state:this.closed?'closed':'ready',connected:!this.closed,tools:this.tools.map(t=>t.name)});}
  async listTools(){return this.tools;}
  async callTool(name,args){this.calls.push({name,args});return this.handler(name,args);}
  async close(){this.closed=true;}
}
const snap=({value='',title='ChatGPT',appName='Chrome'}={})=>({pid:44,window_id:99,title,app_name:appName,elements:[{element_token:'s00000001:1',role:'textbox',value}]});
class FakeChild extends EventEmitter {
  constructor({oversizedTools=false}={}){super();this.oversizedTools=oversizedTools;this.stdout=new PassThrough();this.stderr=new PassThrough();this.killed=false;this.exitCode=null;
    this.stdin=new Writable({write:(chunk,enc,cb)=>{try{const q=JSON.parse(chunk.toString().trim());if(q.id!==undefined){const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}:q.method==='tools/list'?{tools:[{name:'fixture_tool'}]}:{content:[{type:'text',text:JSON.stringify({echo:q.params.arguments})}]};queueMicrotask(()=>{if(this.oversizedTools&&q.method==='tools/list')this.stdout.write('x'.repeat(2*1024*1024+1));else this.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');});}cb();}catch(e){cb(e);}}});
  }
  kill(){this.killed=true;this.exitCode=0;queueMicrotask(()=>this.emit('exit',0,null));return true;}
}

async function projectFixture(){
 const root=await mkdtemp(join(tmpdir(),'rm-workspace-fixture-'));
 await mkdir(join(root,'src'),{recursive:true});
 await writeFile(join(root,'package.json'),'{"name":"backroom-fixture","version":"1.0.0"}\n');
 await writeFile(join(root,'README.md'),'Fixture project.\n');
 await writeFile(join(root,'src','index.js'),'export const safe=true;\n');
 await writeFile(join(root,'.env'),'OPENAI_API_KEY=sk-proj-abcdef0123456789abcdef0123456789abcdef0123456789\n');
 await mkdir(join(root,'.git'),{recursive:true});await writeFile(join(root,'.git','config'),'private git metadata');
 await mkdir(join(root,'node_modules','fixture'),{recursive:true});await writeFile(join(root,'node_modules','fixture','index.js'),'dependency file');
 await writeFile(join(root,'service-account.json'),'{"private_key":"never copied"}');
 await writeFile(join(root,'src','demo-config.js'),"export const key = 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\\n");
 try{await symlink(join(root,'.env'),join(root,'src','env-link'));}catch{}
 return root;
}
function tarNames(archive){
 const names=[];let offset=0;
 while(offset+512<=archive.length){
  const h=archive.subarray(offset,offset+512);if(h.every(byte=>byte===0))break;
  const readField=(start,end)=>h.subarray(start,end).toString('utf8').replace(/\0.*$/s,'');
  const name=readField(0,100),prefix=readField(345,500),sizeText=readField(124,136).trim();
  const full=prefix?prefix+'/'+name:name;names.push(full);
  const size=sizeText?parseInt(sizeText,8):0;offset+=512+Math.ceil(size/512)*512;
 }
 return names;
}

function fakeSpawn(results,seen){return (executable,args,options)=>{seen.push({executable,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.killed=false;child.kill=()=>{child.killed=true;return true;};queueMicrotask(()=>{const r=results.shift()??{code:0,stdout:'ok',stderr:''};if(r.stdout)child.stdout.write(r.stdout);if(r.stderr)child.stderr.write(r.stderr);child.exitCode=r.code;child.emit('close',r.code,null);});return child;};}

test('MCP stdio client initializes and calls only advertised tools without shell or ambient credentials',async()=>{
 let seen;const client=new McpStdioClient({command:'/local/mcp',args:['mcp'],env:{LANG:'C'},sourceEnv:{PATH:'/bin',PATHEXT:'.EXE;.CMD',HOME:'/home/test',RUB_MINDS_TOKEN:'never-copy'},spawnImpl:(command,args,options)=>{seen={command,args,options};return new FakeChild();},timeoutMs:1000});
 const s=await client.start();assert.equal(s.connected,true);assert.deepEqual(s.tools,['fixture_tool']);assert.equal(seen.options.shell,false);assert.equal(seen.options.env.RUB_MINDS_TOKEN,undefined);assert.equal(seen.options.env.LANG,'C');assert.equal(seen.options.env.PATHEXT,'.EXE;.CMD');
 assert.deepEqual(await client.callTool('fixture_tool',{x:2}),{echo:{x:2}});await assert.rejects(client.callTool('not-advertised',{}),/not advertised/);await client.close();assert.equal(client.status.state,'closed');
});
test('MCP child rejects credential-looking ad-hoc environment values',()=>assert.throws(()=>new McpStdioClient({command:'artemis',env:{GOOGLE_API_KEY:'secret'}}),/Credential-like/));

test('MCP stdout enforces its line cap before newline framing can buffer an oversized message',async()=>{
 let child;
 const client=new McpStdioClient({command:'/local/mcp',spawnImpl:()=>{child=new FakeChild({oversizedTools:true});return child;},timeoutMs:2000});
 await assert.rejects(client.start(),/did not complete initialization/);
 assert.equal(child.killed,true);
});


test('CUA desktop demands owner approval, fresh identity, empty text field and readback',async()=>{
 let current=snap(),approved=false;const client=new FakeMcp(['list_windows','get_window_state','click','type_text'],async(name,args)=>{
  if(name==='list_windows')return {windows:[{pid:44,window_id:99,app_name:current.app_name,title:current.title}]};
  if(name==='get_window_state')return current;
  if(name==='click')return {effect:'confirmed'};
  if(name==='type_text'){current=snap({value:args.text});return {effect:'confirmed',verified:true};}
  throw Error('unknown tool');
 });
 const d=new CuaDesktopWorkspace({client,authorizeLocalAction:async a=>approved&&(a.kind==='desktop_draft_inspect'||a.kind==='desktop_draft'||a.kind==='desktop_observe'||a.kind==='desktop_list_windows')});
 await assert.rejects(d.observeWindow({pid:44,windowId:99,groupId:'group-1',sessionId:'session-1'}),/observation denied/);
 approved=true;assert.equal((await d.observeWindow({pid:44,windowId:99,groupId:'group-1',sessionId:'session-1'})).elementCount,1);
 approved=false;await assert.rejects(d.draftText({pid:44,windowId:99,elementToken:'s00000001:1',text:'Draft',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'}),/observation denied/);
 approved=true;current=snap({title:'Wrong'});await assert.rejects(d.draftText({pid:44,windowId:99,elementToken:'s00000001:1',text:'Draft',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'}),/identity changed/);
 current=snap({value:'already typed'});await assert.rejects(d.draftText({pid:44,windowId:99,elementToken:'s00000001:1',text:'Draft',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'}),/verified empty/);
 current={...snap(),elements:[{element_token:'s00000001:1',role:'button',value:''}]};await assert.rejects(d.draftText({pid:44,windowId:99,elementToken:'s00000001:1',text:'Draft',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'}),/changed or is ambiguous/);
});
test('CUA types through a fresh snapshot token only and never sends',async()=>{
 let current=snap();const client=new FakeMcp(['list_windows','get_window_state','click','type_text'],async(n,a)=>{if(n==='list_windows')return {windows:[{pid:44,window_id:99,app_name:'Chrome',title:'ChatGPT'}]};if(n==='get_window_state')return current;if(n==='click')return {effect:'confirmed'};if(n==='type_text'){current=snap({value:a.text});return {effect:'confirmed'};}throw Error(n);});
 const d=new CuaDesktopWorkspace({client,authorizeLocalAction:async a=>a.kind==='desktop_observe'||a.kind==='desktop_draft_inspect'||a.text==='draft only'});
 const observed=await d.observeWindow({pid:44,windowId:99,groupId:'group-1',sessionId:'session-1'});
 const result=await d.draftText({pid:44,windowId:99,elementToken:observed.elements[0].elementToken,text:'draft only',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'});
 assert.equal(result.state,'completed');assert.equal(result.submitted,false);assert.deepEqual(client.calls.find(c=>c.name==='click').args,{target:{kind:'window',pid:44,window_id:99},element_token:'s00000001:1',delivery_mode:'foreground',session:'rub-minds-backroom'});assert.deepEqual(client.calls.find(c=>c.name==='type_text').args,{text:'draft only',target:{kind:'window',pid:44,window_id:99},session:'rub-minds-backroom'});
});


test('CUA never types when the element-focus action is not confirmed',async()=>{
 let current=snap();const client=new FakeMcp(['list_windows','get_window_state','click','type_text'],async(n,a)=>{if(n==='list_windows')return {windows:[{pid:44,window_id:99,app_name:'Chrome',title:'ChatGPT'}]};if(n==='get_window_state')return current;if(n==='click')return {effect:'refused',error:{code:'no_target'}};if(n==='type_text')return {effect:'confirmed'};throw Error(n);});
 const d=new CuaDesktopWorkspace({client,authorizeLocalAction:async()=>true});
 const observed=await d.observeWindow({pid:44,windowId:99,groupId:'group-1',sessionId:'session-1'});
 const result=await d.draftText({pid:44,windowId:99,elementToken:observed.elements[0].elementToken,text:'draft only',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'});
 assert.equal(result.state,'needs_review');assert.equal(client.calls.some(c=>c.name==='type_text'),false);
});


test('CUA remaps snapshot-bound tokens by unique control identity and refuses cross-group reuse',async()=>{
 let snapshots=0,value='';
 const client=new FakeMcp(['list_windows','get_window_state','click','type_text'],async(name,args)=>{
  if(name==='list_windows')return {windows:[{pid:44,window_id:99,app_name:'Chrome',title:'ChatGPT'}]};
  if(name==='get_window_state'){
   snapshots++;
   return {pid:44,window_id:99,app_name:'Chrome',title:'ChatGPT',snapshot_id:'snap-'+snapshots,
    elements:[{element_token:'s'+String(snapshots).padStart(8,'0')+':1',role:'textbox',label:'Message input',depth:2,parent_index:1,frame:{x:4,y:8,w:320,h:40},value}]};
  }
  if(name==='click')return {effect:'confirmed'};
  if(name==='type_text'){value=args.text;return {effect:'confirmed'};}
  throw Error(name);
 });
 const d=new CuaDesktopWorkspace({client,authorizeLocalAction:async()=>true});
 const observed=await d.observeWindow({pid:44,windowId:99,groupId:'group-1',sessionId:'session-1'});
 assert.equal(observed.elements[0].elementToken,'s00000001:1');
 await assert.rejects(d.draftText({pid:44,windowId:99,elementToken:observed.elements[0].elementToken,text:'cross group',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-2',sessionId:'session-1'}),/Fresh local CUA observation required/);
 const result=await d.draftText({pid:44,windowId:99,elementToken:observed.elements[0].elementToken,text:'safe draft',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'});
 assert.equal(result.state,'completed');assert.equal(value,'safe draft');
 const click=client.calls.find(call=>call.name==='click');
 assert.equal(click.args.element_token,'s00000003:1');
 assert.notEqual(click.args.element_token,observed.elements[0].elementToken);
 assert.equal(client.calls.find(call=>call.name==='type_text').args.target.window_id,99);
});
test('CUA refuses an ambiguous selector instead of typing into one of several identical controls',async()=>{
 const client=new FakeMcp(['list_windows','get_window_state','click','type_text'],async(name,args)=>{
  if(name==='list_windows')return {windows:[{pid:44,window_id:99,app_name:'Chrome',title:'ChatGPT'}]};
  if(name==='get_window_state')return {pid:44,window_id:99,app_name:'Chrome',title:'ChatGPT',elements:[
   {element_token:'s00000001:1',role:'textbox',label:'Message',depth:2,parent_index:1,value:''},
   {element_token:'s00000001:2',role:'textbox',label:'Message',depth:2,parent_index:1,value:''}]};
  if(name==='click'||name==='type_text')return {effect:'confirmed'};
  throw Error(name);
 });
 const d=new CuaDesktopWorkspace({client,authorizeLocalAction:async()=>true});
 const observed=await d.observeWindow({pid:44,windowId:99,groupId:'g',sessionId:'s'});
 await assert.rejects(d.draftText({pid:44,windowId:99,elementToken:observed.elements[0].elementToken,text:'ambiguous',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'g',sessionId:'s'}),/changed or is ambiguous/);
 assert.equal(client.calls.some(call=>call.name==='click'||call.name==='type_text'),false);
});

test('ARTEMIS requires device/package allowlists, explicit approval and trace-bound lifecycle',async()=>{
 let approved=false;const client=new FakeMcp(['mobile_run_task','mobile_manage_task','mobile_get_device_state','mobile_diagnose'],async(n,a)=>{
  if(n==='mobile_run_task')return {trace_id:'trace:1',status:'running'};
  if(n==='mobile_manage_task'&&a.action==='status')return {trace_id:a.trace_id,device_serial:'emulator-5554',status:'completed',result:'verified'};
  if(n==='mobile_manage_task'&&a.action==='stop')return {status:'cancelled'};
  if(n==='mobile_get_device_state')return '<hierarchy />';
  if(n==='mobile_diagnose')return {verdict:'ready'};throw Error(n);
 });
 const d=new ArtemisAndroidWorkspace({client,allowedDevices:['emulator-5554'],allowedPackages:['com.example.app'],authorizeLocalAction:async()=>approved});
 await assert.rejects(d.runTask({deviceSerial:'emulator-5554',appPackage:'com.example.app',task:'Read the current page',groupId:'group-1',sessionId:'session-1'}),/denied/);
 await assert.rejects(d.runTask({deviceSerial:'other',appPackage:'com.example.app',task:'Read',groupId:'group-1',sessionId:'session-1'}),/allowlisted/);
 await assert.rejects(d.runTask({deviceSerial:'emulator-5554',appPackage:'com.other.app',task:'Read',groupId:'group-1',sessionId:'session-1'}),/allowlisted/);
 approved=true;const run=await d.runTask({deviceSerial:'emulator-5554',appPackage:'com.example.app',task:'Read current page',groupId:'group-1',sessionId:'session-1'});
 assert.equal(run.traceId,'trace:1');const call=client.calls.find(c=>c.name==='mobile_run_task');assert.equal(call.args.locked_app_package,'com.example.app');assert.equal(call.args.device_serial,'emulator-5554');assert.equal(call.args.verification_level,'strict');assert.equal(call.args.explorer_mode,'pro');
 await assert.rejects(d.status({traceId:'trace:1',deviceSerial:'wrong',groupId:'group-1',sessionId:'session-1'}),/scope mismatch/);
 assert.equal((await d.status({traceId:'trace:1',deviceSerial:'emulator-5554',groupId:'group-1',sessionId:'session-1'})).result,'verified');
 assert.equal((await d.observe({deviceSerial:'emulator-5554',appPackage:'com.example.app',groupId:'group-1',sessionId:'session-1'})).hierarchy,'<hierarchy />');
 assert.equal((await d.stop({traceId:'trace:1',deviceSerial:'emulator-5554',groupId:'group-1',sessionId:'session-1'})).stopped,true);
});
test('ARTEMIS diagnostics require local approval, scope and only call the diagnostic tool',async()=>{
 let approved=false;const client=new FakeMcp(['mobile_diagnose'],async(name,args)=>{assert.equal(name,'mobile_diagnose');assert.deepEqual(args,{});return {verdict:'ready',next_steps:[]};});
 const d=new ArtemisAndroidWorkspace({client,allowedDevices:[],allowedPackages:[],authorizeLocalAction:async action=>approved&&action.kind==='android_diagnose'&&action.verifyCredentials===false&&action.probeDevice===false});
 assert.equal(d.statusSummary.available,false);
 await assert.rejects(d.diagnose({groupId:'group-1',sessionId:'session-1'}),/denied/);
 approved=true;assert.deepEqual(await d.diagnose({groupId:'group-1',sessionId:'session-1'}),{verdict:'ready',next_steps:[]});
 const service=createExternalWorkspaceService({android:d});
 assert.equal(service.status().capabilities.android,false);assert.equal(service.status().android.diagnoseAvailable,true);
});

test('ARTEMIS cannot manage an unknown trace',async()=>{const d=new ArtemisAndroidWorkspace({client:new FakeMcp(['mobile_manage_task'],async()=>({status:'completed'})),allowedDevices:['device'],allowedPackages:['com.example.app'],authorizeLocalAction:async()=>true});await assert.rejects(d.status({traceId:'unknown',deviceSerial:'device',groupId:'g',sessionId:'s'}),/task scope mismatch/);});

test('safe project archive excludes VCS data, dependencies, environment secrets and symlinks',async()=>{
 const root=await projectFixture();
 try{
  const archive=await createSafeWorkspaceArchive(root),bytes=await readFile(archive.archivePath),names=tarNames(bytes);
  assert.ok(names.includes('package.json'));assert.ok(names.includes('src/index.js'));assert.ok(names.includes('README.md'));
  assert.equal(names.some(name=>name.startsWith('.git/')),false);assert.equal(names.some(name=>name.startsWith('node_modules/')),false);
  assert.equal(names.includes('.env'),false);assert.equal(names.includes('src/env-link'),false);assert.equal(names.includes('service-account.json'),false);
  assert.equal(names.includes('src/demo-config.js'),false);
  assert.ok(archive.omittedSensitive>=3);assert.ok(archive.sourceBytes>0);assert.match(archive.sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(createSafeWorkspaceArchive(root,{maxEntries:1}),/too many filesystem entries/);
  await rm(archive.tempDirectory,{recursive:true,force:true});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('CUA terminal syncs a filtered local project before approved argv execution',async()=>{
 const root=await projectFixture(),calls=[];
 try{
  const d=new CuaSandboxTerminalWorkspace({sandboxName:'rm-backroom-unit-1234',projectSourcePath:root,authorizeLocalAction:async a=>a.kind==='terminal_project_sync'||a.command?.[0]==='npm',spawnImpl:fakeSpawn([{code:0,stdout:'created'}],calls)});
  await d.start();
  const sync=await d.syncProject({groupId:'group-1',sessionId:'session-1'});
  assert.equal(sync.projectSynced,true);assert.ok(sync.fileCount>=3);assert.equal(d.status.projectSynced,true);
  const copy=calls.find(c=>c.args.includes('cp')&&c.args.some(x=>String(x).includes('/tmp/rub-backroom-source.tar')));
  assert.ok(copy);assert.ok(copy.args.includes('local:rm-backroom-unit-1234:/tmp/rub-backroom-source.tar'));assert.equal(copy.options.shell,false);
  const result=await d.exec({command:['npm','test','--','--run'],purpose:'Backroom tests',groupId:'group-1',sessionId:'session-1'});assert.equal(result.state,'completed');
  const cliExec=calls.find(c=>c.args.includes('exec')&&c.args.includes('npm'));
  assert.deepEqual(cliExec.args,['--json','sb','exec','-i','--local','--timeout','120','rm-backroom-unit-1234','--','npm','test','--','--run']);
  await assert.rejects(d.exec({command:['bash','-lc','echo unsafe'],purpose:'unsafe',groupId:'g',sessionId:'s'}),/Shell interpreters/);
  await d.close();assert.deepEqual(calls.at(-1).args,['--json','sb','rm','--local','rm-backroom-unit-1234']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('source archive applies total-byte cap after filtering credential-bearing files',async()=>{
 const root=await projectFixture();
 try{
  await writeFile(join(root,'src','oversized-secret.js'),"const key='sk-proj-"+'a'.repeat(40)+"';\n"+'x'.repeat(1400));
  const archive=await createSafeWorkspaceArchive(root,{maxBytes:1024,maxSingleFileBytes:4096});
  try{assert.ok(archive.sourceBytes<=1024);assert.ok(archive.omittedSensitive>=4);}
  finally{await rm(archive.tempDirectory,{recursive:true,force:true});}
 }finally{await rm(root,{recursive:true,force:true});}
});
async function makeSyncedTerminalWithPatch(root,patch,authorize=async()=>true){
 const calls=[],success={code:0,stdout:'ok',stderr:''};
 const results=[...Array.from({length:10},()=>({...success})),{code:0,stdout:patch,stderr:''}];
 const terminal=new CuaSandboxTerminalWorkspace({
  sandboxName:'rm-backroom-unit-1234',projectSourcePath:root,
  authorizeLocalAction:authorize,spawnImpl:fakeSpawn(results,calls)
 });
 await terminal.start();
 await terminal.syncProject({groupId:'group-1',sessionId:'session-1'});
 return {terminal,calls};
}
test('terminal diff is bounded, credential-scanned and review-only',async()=>{
 const root=await projectFixture();
 try{
  const {terminal,calls}=await makeSyncedTerminalWithPatch(root,'diff --git a/src/index.js b/src/index.js\n+export const safe=true;\n');
  const result=await terminal.diffProject({groupId:'group-1',sessionId:'session-1'});
  assert.equal(result.state,'completed');assert.equal(result.appliedToHost,false);assert.equal(result.destination,'Rub Minds Backroom browser review only');assert.match(result.sha256,/^[a-f0-9]{64}$/);assert.ok(result.patch.includes('safe=true'));
  assert.ok(calls.at(-1).args.includes('diff'));assert.ok(calls.at(-1).args.includes('--no-ext-diff'));assert.equal(calls.at(-1).options.shell,false);
  await terminal.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('terminal diff withholds patches containing high-confidence secrets',async()=>{
 const root=await projectFixture();
 try{
  const secretPatch="diff --git a/src/config.js b/src/config.js\n+const token = 'sk-proj-"+'b'.repeat(40)+"';\n";
  const {terminal}=await makeSyncedTerminalWithPatch(root,secretPatch);
  const result=await terminal.diffProject({groupId:'group-1',sessionId:'session-1'});
  assert.equal(result.state,'needs_review');assert.equal(result.patch,'');assert.match(result.reason,/credential|private-key/i);assert.equal(result.appliedToHost,undefined);
  await terminal.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('terminal diff rejects oversized patches before returning bytes to the browser',async()=>{
 const root=await projectFixture();
 try{
  const {terminal}=await makeSyncedTerminalWithPatch(root,'x'.repeat(512*1024+1));
  await assert.rejects(terminal.diffProject({groupId:'group-1',sessionId:'session-1'}),/512 KiB review limit/);
  await terminal.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('failed local sandbox deletion remains visible and can be retried',async()=>{
 const calls=[],results=[{code:0,stdout:'created'},{code:1,stdout:'denied'},{code:0,stdout:'removed'}];
 const terminal=new CuaSandboxTerminalWorkspace({sandboxName:'rm-backroom-unit-1234',authorizeLocalAction:async()=>true,spawnImpl:fakeSpawn(results,calls)});
 await terminal.start();
 const service=createExternalWorkspaceService({terminal});
 const first=await service.stop();assert.equal(first.closeFailures,1);assert.equal(service.status().terminal.cleanupPending,true);assert.equal(terminal.status.ready,true);
 const second=await service.stop();assert.equal(second.closeFailures,0);assert.equal(service.status().terminal.cleanupPending,false);assert.equal(terminal.status.ready,false);
 assert.equal(calls.filter(c=>c.args.includes('sb')&&c.args.includes('rm')).length,2);
});


test('terminal applies only an exact one-use patch after digest, Git-root, check and local approval',async()=>{
 const root=await projectFixture(),sandboxCalls=[],gitCalls=[];
 const patch='diff --git a/src/index.js b/src/index.js\n--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n-export const safe=true;\n+export const safe=false;\n';
 const results=[{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0,stdout:patch}];
 const localGitSpawnImpl=(executable,args,options)=>{
  const child=new EventEmitter();let input='';child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.killed=false;child.kill=()=>{child.killed=true;return true;};
  child.stdin=new Writable({write(chunk,enc,cb){input+=chunk.toString();cb();},final(cb){cb();queueMicrotask(()=>{gitCalls.push({executable,args,options,input});child.stdout.end(args[0]==='rev-parse'?root+'\n':'');child.stderr.end('');child.exitCode=0;child.emit('close',0,null);});}});
  return child;
 };
 const sandboxSpawn=fakeSpawn(results,sandboxCalls);
 const approved=[];
 const d=new CuaSandboxTerminalWorkspace({sandboxName:'rm-backroom-unit-1234',projectSourcePath:root,authorizeLocalAction:async a=>{approved.push(a);return ['terminal_project_sync','terminal_diff_export','terminal_patch_apply'].includes(a.kind);},spawnImpl:sandboxSpawn,localGitSpawnImpl});
 try{
  await d.start();await d.syncProject({groupId:'group-1',sessionId:'session-1'});
  const diff=await d.diffProject({groupId:'group-1',sessionId:'session-1'});
  assert.equal(diff.applyAvailable,true);assert.equal(diff.patch,patch);assert.deepEqual(diff.paths,['src/index.js']);assert.match(diff.exportKey,/^[a-f0-9]{64}$/);
  assert.equal(diff.sha256,createHash('sha256').update(patch).digest('hex'));
  await assert.rejects(d.applyProjectDiff({exportKey:diff.exportKey,sha256:diff.sha256,groupId:'group-2',sessionId:'session-1'}),/outside the original group\/session scope/);
  const applied=await d.applyProjectDiff({exportKey:diff.exportKey,sha256:diff.sha256,groupId:'group-1',sessionId:'session-1'});
  assert.equal(applied.appliedToHost,true);assert.equal(applied.committed,false);assert.equal(applied.pushed,false);assert.deepEqual(applied.paths,['src/index.js']);
  assert.deepEqual(gitCalls.map(call=>call.args[0]==='rev-parse'?'root':call.args[0]+' '+call.args[1]),['root','apply --check','apply']);
  assert.equal(gitCalls[1].input,patch);assert.equal(gitCalls[2].input,patch);
  assert.equal(gitCalls.every(call=>call.options.shell===false),true);
  await assert.rejects(d.applyProjectDiff({exportKey:diff.exportKey,sha256:diff.sha256,groupId:'group-1',sessionId:'session-1'}),/expired or outside/);
  assert.equal(approved.some(a=>a.kind==='terminal_patch_apply'&&a.files[0]==='src/index.js'&&a.commit===false&&a.push===false),true);
  await d.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('terminal patch apply consumes denied approvals without running git apply',async()=>{
 const root=await projectFixture(),sandboxCalls=[],gitCalls=[];
 const patch='diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Fixture project.\n+Changed project.\n';
 const results=[{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0},{code:0,stdout:patch}];
 const localGitSpawnImpl=(executable,args,options)=>{
  const child=new EventEmitter();let input='';child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>true;
  child.stdin=new Writable({write(chunk,enc,cb){input+=chunk.toString();cb();},final(cb){cb();queueMicrotask(()=>{gitCalls.push({args,input});child.stdout.end(args[0]==='rev-parse'?root+'\n':'');child.stderr.end('');child.exitCode=0;child.emit('close',0,null);});}});
  return child;
 };
 const d=new CuaSandboxTerminalWorkspace({sandboxName:'rm-backroom-unit-1234',projectSourcePath:root,authorizeLocalAction:async a=>a.kind!=='terminal_patch_apply',spawnImpl:fakeSpawn(results,sandboxCalls),localGitSpawnImpl});
 try{
  await d.start();await d.syncProject({groupId:'g',sessionId:'s'});const diff=await d.diffProject({groupId:'g',sessionId:'s'});
  await assert.rejects(d.applyProjectDiff({exportKey:diff.exportKey,sha256:diff.sha256,groupId:'g',sessionId:'s'}),/denied/);
  assert.equal(gitCalls.some(call=>call.args[0]==='apply'),false);
  await assert.rejects(d.applyProjectDiff({exportKey:diff.exportKey,sha256:diff.sha256,groupId:'g',sessionId:'s'}),/expired or outside/);
 }finally{await d.close().catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('terminal refuses arbitrary sandbox names, unapproved commands and path traversal',async()=>{
 assert.throws(()=>new CuaSandboxTerminalWorkspace({sandboxName:'dev',authorizeLocalAction:async()=>true}),/Dedicated rm-backroom/);
 const root=await projectFixture(),calls=[];
 try{
  const d=new CuaSandboxTerminalWorkspace({sandboxName:'rm-backroom-test-0001',projectSourcePath:root,authorizeLocalAction:async a=>a.kind==='terminal_project_sync',spawnImpl:fakeSpawn([{code:0}],calls)});
  await d.start();await d.syncProject({groupId:'g',sessionId:'s'});
  await assert.rejects(d.exec({command:['npm','test'],purpose:'test',groupId:'g',sessionId:'s'}),/denied/);
  await assert.rejects(d.exec({command:['npm','test'],purpose:'test',groupId:'g',sessionId:'s',cwd:'../escape'}),/cwd/);
  await d.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('external workspace service exposes only sanitized per-adapter startup errors',async()=>{
 const s=createExternalWorkspaceService({startupErrors:{desktop:'binary not found',android:'ARTEMIS requires local config',terminal:'TTY approval is required',ignored:'do not expose'}});
 assert.deepEqual(s.status().capabilities,{desktop:false,android:false,terminal:false});
 assert.deepEqual(s.status().startupErrors,{desktop:'binary not found',android:'ARTEMIS requires local config',terminal:'TTY approval is required'});
 await s.stop();assert.equal(s.status().stopped,true);
});
test('external workspace health needs the complete advertised tool contract and closes clients',async()=>{
 const incomplete=new FakeMcp(['list_windows'],async()=>null);
 const partial=createExternalWorkspaceService({desktop:{client:incomplete,listWindows:async()=>[]}});
 assert.deepEqual(partial.status().capabilities,{desktop:false,android:false,terminal:false});assert.deepEqual(partial.status().desktop.missingTools,['get_window_state','click','type_text']);await partial.stop();
 const client=new FakeMcp(['list_windows','get_window_state','click','type_text'],async()=>null);
 const s=createExternalWorkspaceService({desktop:{client,listWindows:async()=>[]}});
 assert.deepEqual(s.status().capabilities,{desktop:true,android:false,terminal:false});await s.stop();assert.equal(client.closed,true);await assert.rejects(s.listDesktopWindows(),/unavailable/);
});
