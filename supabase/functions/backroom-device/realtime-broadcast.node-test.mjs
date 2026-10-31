import test from 'node:test';
import assert from 'node:assert/strict';
import {broadcastPrivateDeviceEvent} from './realtime-broadcast.mjs';
const deviceId='10000000-0000-4000-8000-000000000001';
const roomId='20000000-0000-4000-8000-000000000002';
const payload={deviceId,roomId,requestId:'30000000-0000-4000-8000-000000000003',action:'launch_app'};
test('sends one event to a correctly scoped private Realtime topic using server credentials',async()=>{
 let called;
 const result=await broadcastPrivateDeviceEvent({
  projectUrl:'https://example-project.supabase.co/',apiKey:'server-key-long-enough',
  deviceId,event:'command',payload,fetchImpl:async(url,init)=>(called={url,init},{ok:true,status:202})
 });
 assert.equal(result.sent,true);
 assert.match(called.url,/realtime\/v1\/api\/broadcast\/backroom-device%3A/);
 assert.match(called.url,/events\/command\?private=true$/);
 assert.equal(called.init.method,'POST');
 assert.equal(called.init.headers.apikey,'server-key-long-enough');
 assert.equal(called.init.headers.Authorization,undefined);
 assert.deepEqual(JSON.parse(called.init.body),payload);
});
test('rejects payloads that escape their topic or invalid private event types',async()=>{
 await assert.rejects(broadcastPrivateDeviceEvent({projectUrl:'https://example.supabase.co',apiKey:'x'.repeat(20),deviceId,event:'command',payload:{...payload,deviceId:'40000000-0000-4000-8000-000000000004'}}),/Invalid/);
 await assert.rejects(broadcastPrivateDeviceEvent({projectUrl:'https://example.supabase.co',apiKey:'x'.repeat(20),deviceId,event:'something',payload}),/Invalid/);
 await assert.rejects(broadcastPrivateDeviceEvent({projectUrl:'https://example.supabase.co',apiKey:'x'.repeat(20),deviceId,event:'command',payload:{...payload,roomId:'bad'}}),/Invalid/);
});
test('accepts a device-scoped response event for a private channel',async()=>{
 const result=await broadcastPrivateDeviceEvent({
  projectUrl:'https://example-project.supabase.co',apiKey:'server-key-long-enough',
  deviceId,event:'response',payload:{deviceId,roomId,requestId,ok:true,capability:'control',sessionId:requestId},
  fetchImpl:async()=>({ok:true,status:202})
 });
 assert.equal(result.event,'response');
});
test('rejects attacker URLs, credentials in URL, paths, and unsupported protocols',async()=>{
 for(const projectUrl of ['https://evil.example','https://user:pass@evil.example','https://project.supabase.co.attacker.com','https://project.supabase.co/path','http://project.supabase.co','https://project.supabase.co?token=secret']){
  await assert.rejects(broadcastPrivateDeviceEvent({projectUrl,apiKey:'x'.repeat(20),deviceId,event:'command',payload}),/Supabase|HTTPS|URL/);
 }
});
test('allows the exact internal local Supabase Kong gateway only',async()=>{
 let called=0;
 await broadcastPrivateDeviceEvent({
  projectUrl:'http://kong:8000',apiKey:'x'.repeat(20),deviceId,event:'command',payload,
  fetchImpl:async()=>{called++;return {ok:true,status:202};}
 });
 assert.equal(called,1);
 await assert.rejects(broadcastPrivateDeviceEvent({
  projectUrl:'http://kong:8080',apiKey:'x'.repeat(20),deviceId,event:'command',payload,
  fetchImpl:async()=>({ok:true,status:202})
 }),/HTTPS|Supabase/);
 await assert.rejects(broadcastPrivateDeviceEvent({
  projectUrl:'http://attacker:8000',apiKey:'x'.repeat(20),deviceId,event:'command',payload,
  fetchImpl:async()=>({ok:true,status:202})
 }),/HTTPS|Supabase/);
});
test('does not report success if Realtime server rejects the private event',async()=>{
 await assert.rejects(broadcastPrivateDeviceEvent({
  projectUrl:'https://example-project.supabase.co',apiKey:'x'.repeat(20),
  deviceId,event:'device_revoked',payload:{deviceId,roomId,status:'revoked'},
  fetchImpl:async()=>({ok:false,status:401})
 }),/rejected/);
});

test('Android SDP and permission responses are sent to the exact device-room topic',async()=>{
 let calledUrl='';
 const result=await broadcastPrivateDeviceEvent({
  projectUrl:'https://example-project.supabase.co',apiKey:'server-key-long-enough',
  deviceId,event:'android_signal',
  payload:{deviceId,roomId,sessionId:requestId,issuedAt:Date.now(),stop:true},
  fetchImpl:async(url)=>{calledUrl=url;return {ok:true,status:202};}
 });
 assert.equal(result.event,'android_signal');
 assert.ok(calledUrl.includes(encodeURIComponent('backroom-android:'+deviceId+':'+roomId)));
 assert.ok(calledUrl.endsWith('/events/android_signal?private=true'));
});
test('Android-specific events are accepted but remain distinct from generic desktop events',async()=>{
 let calledUrl='';
 const result=await broadcastPrivateDeviceEvent({
  projectUrl:'https://example-project.supabase.co',apiKey:'server-key-long-enough',
  deviceId,event:'android_response',
  payload:{deviceId,roomId,requestId,sessionId:requestId,ok:false,capability:'control'},
  fetchImpl:async(url)=>{calledUrl=url;return {ok:true,status:202};}
 });
 assert.equal(result.event,'android_response');
 assert.ok(calledUrl.includes(encodeURIComponent('backroom-android:'+deviceId+':'+roomId)));
});
