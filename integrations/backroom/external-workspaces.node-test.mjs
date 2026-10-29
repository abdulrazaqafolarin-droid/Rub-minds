import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { McpStdioClient } from './mcp-stdio-client.mjs';
import { ArtemisAndroidWorkspace, CuaDesktopWorkspace, CuaSandboxTerminalWorkspace, createExternalWorkspaceService } from './external-workspaces.mjs';

const names = values => values.map(name => ({ name }));
class FakeMcp {
  constructor(values, handler) { this.tools=names(values); this.handler=handler; this.calls=[]; this.closed=false; }
  async listTools(){return this.tools;}
  async callTool(name,args){this.calls.push({name,args});return this.handler(name,args);}
  async close(){this.closed=true;}
}
const snap=({value='',title='ChatGPT',appName='Chrome'}={})=>({pid:44,window_id:99,title,app_name:appName,elements:[{element_token:'s00000001:1',role:'textbox',value}]});
class FakeChild extends EventEmitter {
  constructor(){super();this.stdout=new PassThrough();this.stderr=new PassThrough();this.killed=false;this.exitCode=null;
    this.stdin=new Writable({write:(chunk,enc,cb)=>{try{const q=JSON.parse(chunk.toString().trim());if(q.id!==undefined){const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}:q.method==='tools/list'?{tools:[{name:'fixture_tool'}]}:{content:[{type:'text',text:JSON.stringify({echo:q.params.arguments})}]};queueMicrotask(()=>this.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n'));}cb();}catch(e){cb(e);}}});
  }
  kill(){this.killed=true;this.exitCode=0;queueMicrotask(()=>this.emit('exit',0,null));return true;}
}
function fakeSpawn(results,seen){return (executable,args,options)=>{seen.push({executable,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.killed=false;child.kill=()=>{child.killed=true;return true;};queueMicrotask(()=>{const r=results.shift()??{code:0,stdout:'ok',stderr:''};if(r.stdout)child.stdout.write(r.stdout);if(r.stderr)child.stderr.write(r.stderr);child.exitCode=r.code;child.emit('close',r.code,null);});return child;};}

test('MCP stdio client initializes and calls only advertised tools without shell or ambient credentials',async()=>{
 let seen;const client=new McpStdioClient({command:'/local/mcp',args:['mcp'],env:{LANG:'C'},sourceEnv:{PATH:'/bin',HOME:'/home/test',RUB_MINDS_TOKEN:'never-copy'},spawnImpl:(command,args,options)=>{seen={command,args,options};return new FakeChild();},timeoutMs:1000});
 const s=await client.start();assert.equal(s.connected,true);assert.deepEqual(s.tools,['fixture_tool']);assert.equal(seen.options.shell,false);assert.equal(seen.options.env.RUB_MINDS_TOKEN,undefined);assert.equal(seen.options.env.LANG,'C');
 assert.deepEqual(await client.callTool('fixture_tool',{x:2}),{echo:{x:2}});await assert.rejects(client.callTool('not-advertised',{}),/not advertised/);await client.close();assert.equal(client.status.state,'closed');
});
test('MCP child rejects credential-looking ad-hoc environment values',()=>assert.throws(()=>new McpStdioClient({command:'artemis',env:{GOOGLE_API_KEY:'secret'}}),/Credential-like/));

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
 current={...snap(),elements:[{element_token:'s00000001:1',role:'button',value:''}]};await assert.rejects(d.draftText({pid:44,windowId:99,elementToken:'s00000001:1',text:'Draft',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'}),/editable text control/);
});
test('CUA types through a fresh snapshot token only and never sends',async()=>{
 let current=snap();const client=new FakeMcp(['list_windows','get_window_state','click','type_text'],async(n,a)=>{if(n==='list_windows')return {windows:[{pid:44,window_id:99,app_name:'Chrome',title:'ChatGPT'}]};if(n==='get_window_state')return current;if(n==='click')return {effect:'confirmed'};if(n==='type_text'){current=snap({value:a.text});return {effect:'confirmed'};}throw Error(n);});
 const d=new CuaDesktopWorkspace({client,authorizeLocalAction:async a=>a.kind==='desktop_draft_inspect'||a.text==='draft only'});
 const result=await d.draftText({pid:44,windowId:99,elementToken:'s00000001:1',text:'draft only',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'});
 assert.equal(result.state,'completed');assert.equal(result.submitted,false);assert.deepEqual(client.calls.find(c=>c.name==='click').args,{target:{kind:'window',pid:44,window_id:99},element_token:'s00000001:1',delivery_mode:'foreground',session:'rub-minds-backroom'});assert.deepEqual(client.calls.find(c=>c.name==='type_text').args,{text:'draft only',target:{kind:'window',pid:44,window_id:99},session:'rub-minds-backroom'});
});


test('CUA never types when the element-focus action is not confirmed',async()=>{
 let current=snap();const client=new FakeMcp(['list_windows','get_window_state','click','type_text'],async(n,a)=>{if(n==='list_windows')return {windows:[{pid:44,window_id:99,app_name:'Chrome',title:'ChatGPT'}]};if(n==='get_window_state')return current;if(n==='click')return {effect:'refused',error:{code:'no_target'}};if(n==='type_text')return {effect:'confirmed'};throw Error(n);});
 const d=new CuaDesktopWorkspace({client,authorizeLocalAction:async()=>true});
 const result=await d.draftText({pid:44,windowId:99,elementToken:'s00000001:1',text:'draft only',expectedAppName:'Chrome',expectedTitle:'ChatGPT',groupId:'group-1',sessionId:'session-1'});
 assert.equal(result.state,'needs_review');assert.equal(client.calls.some(c=>c.name==='type_text'),false);
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
test('ARTEMIS cannot manage an unknown trace',async()=>{const d=new ArtemisAndroidWorkspace({client:new FakeMcp(['mobile_manage_task'],async()=>({status:'completed'})),allowedDevices:['device'],allowedPackages:['com.example.app'],authorizeLocalAction:async()=>true});await assert.rejects(d.status({traceId:'unknown',deviceSerial:'device',groupId:'g',sessionId:'s'}),/unknown trace/);});

test('CUA terminal uses a local isolated container, argv execution and per-command approval',async()=>{
 const calls=[];const d=new CuaSandboxTerminalWorkspace({sandboxName:'rm-backroom-unit-1234',authorizeLocalAction:async a=>a.command[0]==='npm',spawnImpl:fakeSpawn([{code:0,stdout:'created'},{code:0,stdout:'367 tests passed'},{code:0,stdout:'removed'}],calls)});
 await d.start();const result=await d.exec({command:['npm','test','--','--run'],purpose:'Backroom tests',groupId:'group-1',sessionId:'session-1'});assert.equal(result.state,'completed');
 assert.equal(calls[0].options.shell,false);assert.deepEqual(calls[0].args,['--json','sb','create','linux','--on','local','--kind','container','--runtime','gvisor','--headless','--name','rm-backroom-unit-1234']);
 assert.deepEqual(calls[1].args,['--json','sb','exec','-i','--local','--timeout','120','rm-backroom-unit-1234','--','npm','test','--','--run']);
 await assert.rejects(d.exec({command:['bash','-lc','echo unsafe'],purpose:'unsafe',groupId:'g',sessionId:'s'}),/Shell interpreters/);await d.close();assert.deepEqual(calls[2].args,['--json','sb','rm','--local','rm-backroom-unit-1234']);
});
test('terminal refuses arbitrary sandbox names, missing approval and path traversal',async()=>{
 assert.throws(()=>new CuaSandboxTerminalWorkspace({sandboxName:'dev',authorizeLocalAction:async()=>true}),/dedicated rm-backroom/);
 const d=new CuaSandboxTerminalWorkspace({sandboxName:'rm-backroom-test-0001',authorizeLocalAction:async()=>false,spawnImpl:fakeSpawn([{code:0},{code:0}],[])});
 await d.start();await assert.rejects(d.exec({command:['npm','test'],purpose:'test',groupId:'g',sessionId:'s'}),/denied/);await assert.rejects(d.exec({command:['npm','test'],purpose:'test',groupId:'g',sessionId:'s',cwd:'../escape'}),/cwd/);await d.close();
});
test('external workspace service reports disabled adapters and safely closes clients',async()=>{
 const client=new FakeMcp([],async()=>null),s=createExternalWorkspaceService({desktop:{client,listWindows:async()=>[]}});
 assert.deepEqual(s.status().capabilities,{desktop:true,android:false,terminal:false});await s.stop();assert.equal(client.closed,true);await assert.rejects(s.listDesktopWindows(),/unavailable/);
});
