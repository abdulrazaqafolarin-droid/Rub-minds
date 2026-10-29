import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkspaceHttpRequest } from './workspace-http-api.mjs';

const token='a'.repeat(64);
function f({runtime=null,authorized=true,body={}}={}){
 const response={status:0,body:null,headers:null};
 const request={method:'POST',headers:{origin:'https://rub-minds.vercel.app',authorization:'Bearer '+token,'content-type':'application/json'}};
 const authority={authorize:({origin,token:got})=>authorized&&origin===request.headers.origin&&got===token?{hostId:'local-host'}:null};
 return {request,response,authority,writeJson:(_r,status,payload,headers)=>Object.assign(response,{status,body:payload,headers}),readJson:async()=>body,workspaceRuntime:runtime};
}
test('ignores paths outside workspaces',async()=>assert.equal(await handleWorkspaceHttpRequest({...f(),url:new URL('http://127.0.0.1/health')}),false));
test('authenticates paired session and reports disabled adapters truthfully',async()=>{
 const x=f({authorized:false});await handleWorkspaceHttpRequest({...x,request:{...x.request,method:'GET'},url:new URL('http://127.0.0.1/v1/workspaces/status')});assert.equal(x.response.status,401);
 const y=f();await handleWorkspaceHttpRequest({...y,request:{...y.request,method:'GET'},url:new URL('http://127.0.0.1/v1/workspaces/status')});assert.equal(y.response.status,200);assert.deepEqual(y.response.body.capabilities,{desktop:false,android:false,terminal:false});
});
test('rejects unknown request fields before runtime call',async()=>{
 let called=false;const x=f({body:{groupId:'g',sessionId:'s',deviceSerial:'device',appPackage:'com.example.app',task:'inspect',hostToken:'forbidden'},runtime:{runAndroidTask:async()=>{called=true;return {};}}});
 await handleWorkspaceHttpRequest({...x,url:new URL('http://127.0.0.1/v1/workspaces/android/tasks')});assert.equal(x.response.status,400);assert.equal(called,false);
});

test('ARTEMIS diagnostics route is authenticated, scoped, and carries no live credential-verification request',async()=>{
 let seen;
 const x=f({body:{groupId:'group-1',sessionId:'session-1'},runtime:{diagnoseAndroid:async input=>{seen=input;return {verdict:'ready',next_steps:[]};}}});
 await handleWorkspaceHttpRequest({...x,url:new URL('http://127.0.0.1/v1/workspaces/android/diagnose')});
 assert.equal(x.response.status,200);assert.equal(seen.groupId,'group-1');assert.equal(seen.sessionId,'session-1');assert.deepEqual(x.response.body,{verdict:'ready',next_steps:[]});
});

test('forwards group/session with Android task and returns trace as accepted',async()=>{
 let seen;const x=f({body:{groupId:'group-1',sessionId:'session-1',deviceSerial:'device',appPackage:'com.example.app',task:'Read current page'},runtime:{runAndroidTask:async input=>{seen=input;return {traceId:'trace-1',status:'running'};}}});
 assert.equal(await handleWorkspaceHttpRequest({...x,url:new URL('http://127.0.0.1/v1/workspaces/android/tasks')}),true);assert.equal(x.response.status,201);assert.equal(seen.groupId,'group-1');assert.equal(seen.sessionId,'session-1');assert.equal(x.response.body.traceId,'trace-1');
});
test('maps local terminal denial to 403 with sanitized result',async()=>{
 const x=f({body:{groupId:'g',sessionId:'s',command:['npm','test'],purpose:'verify'},runtime:{execTerminal:async()=>{throw Error('Local terminal command denied');}}});
 await handleWorkspaceHttpRequest({...x,url:new URL('http://127.0.0.1/v1/workspaces/terminal/exec')});assert.equal(x.response.status,403);assert.deepEqual(x.response.body,{error:'local_approval_denied'});
});

test('terminal diff route carries scope and returns a review-only patch without applying it',async()=>{
 let seen;
 const patch='diff --git a/src/index.js b/src/index.js\n+safe change\n';
 const x=f({body:{groupId:'group-1',sessionId:'session-1'},runtime:{diffTerminalProject:async input=>{seen=input;return {state:'completed',patch,bytes:Buffer.byteLength(patch),sha256:'a'.repeat(64),appliedToHost:false};}}});
 await handleWorkspaceHttpRequest({...x,url:new URL('http://127.0.0.1/v1/workspaces/terminal/diff')});
 assert.equal(x.response.status,200);assert.equal(seen.groupId,'group-1');assert.equal(seen.sessionId,'session-1');assert.equal(x.response.body.patch,patch);assert.equal(x.response.body.appliedToHost,false);
});

test('ARTEMIS task-inspect route forwards only bounded trace inspection fields',async()=>{
 let seen;
 const x=f({body:{traceId:'trace-1',deviceSerial:'device-1',action:'search',query:'visible text',groupId:'group-1',sessionId:'session-1'},runtime:{inspectAndroidTask:async input=>{seen=input;return {state:'completed',traceId:input.traceId,action:input.action,summary:'local trace only',sharedToGroup:false};}}});
 await handleWorkspaceHttpRequest({...x,url:new URL('http://127.0.0.1/v1/workspaces/android/task-inspect')});
 assert.equal(x.response.status,200);assert.equal(seen.traceId,'trace-1');assert.equal(seen.action,'search');assert.equal(x.response.body.sharedToGroup,false);
 const bad=f({body:{traceId:'trace-1',deviceSerial:'device-1',action:'search',query:'q',groupId:'g',sessionId:'s',rawTrace:'forged'},runtime:{inspectAndroidTask:async()=>{throw Error('must not execute');}}});
 await handleWorkspaceHttpRequest({...bad,url:new URL('http://127.0.0.1/v1/workspaces/android/task-inspect')});assert.equal(bad.response.status,400);
});

test('terminal apply route accepts only the one-use digest and scope fields',async()=>{
 let seen;
 const x=f({body:{groupId:'group-1',sessionId:'session-1',exportKey:'a'.repeat(64),sha256:'b'.repeat(64)},runtime:{applyTerminalProjectDiff:async input=>{seen=input;return {state:'completed',appliedToHost:true,committed:false,pushed:false,sha256:input.sha256,paths:['src/index.js'],repositoryRoot:'/workspace/project'};}}});
 await handleWorkspaceHttpRequest({...x,url:new URL('http://127.0.0.1/v1/workspaces/terminal/apply')});
 assert.equal(x.response.status,200);assert.equal(seen.exportKey,'a'.repeat(64));assert.equal(seen.groupId,'group-1');assert.equal(x.response.body.committed,false);
 const bad=f({body:{groupId:'g',sessionId:'s',exportKey:'a'.repeat(64),sha256:'b'.repeat(64),patch:'forged'},runtime:{applyTerminalProjectDiff:async()=>{throw Error('must not execute');}}});
 await handleWorkspaceHttpRequest({...bad,url:new URL('http://127.0.0.1/v1/workspaces/terminal/apply')});assert.equal(bad.response.status,400);
});

test('requires JSON content type and avoids leaking error messages for unknown routes',async()=>{
 const a=f();a.request.headers['content-type']='text/plain';await handleWorkspaceHttpRequest({...a,url:new URL('http://127.0.0.1/v1/workspaces/android/tasks')});assert.equal(a.response.status,415);
 const b=f();await handleWorkspaceHttpRequest({...b,url:new URL('http://127.0.0.1/v1/workspaces/unknown')});assert.equal(b.response.status,404);assert.deepEqual(b.response.body,{error:'not_found'});
});
