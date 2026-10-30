import test from 'node:test';
import assert from 'node:assert/strict';
import {buildScopedDeviceMessage,createDeviceCommand,validateDeviceCommand,classifyDeviceResponse,queueIceCandidate,takeIceCandidates} from './desktop-realtime-protocol.mjs';
const deviceId='123e4567-e89b-42d3-a456-426614174000',roomId='123e4567-e89b-42d3-a456-426614174001',requestId='123e4567-e89b-42d3-a456-426614174002';
test('creates immutable scoped messages and prevents scope override',()=>{
 const message=buildScopedDeviceMessage({action:'ping'},{deviceId,roomId});
 assert.deepEqual(message,{action:'ping',roomId,deviceId});
 assert.equal(Object.isFrozen(message),true);
 assert.throws(()=>buildScopedDeviceMessage({deviceId:'other'},{deviceId,roomId}),/override/);
 assert.throws(()=>buildScopedDeviceMessage({},{deviceId:'bad',roomId}),/scope/);
});
test('creates commands with fresh UUIDs, timestamp and immutable scope',()=>{
 const message=createDeviceCommand('launch_app',{appId:'123e4567-e89b-42d3-a456-426614174003'},{deviceId,roomId,now:5000,requestId});
 assert.deepEqual(message,{appId:'123e4567-e89b-42d3-a456-426614174003',requestId,action:'launch_app',issuedAt:5000,roomId,deviceId});
 assert.throws(()=>createDeviceCommand('write_terminal',{}, {deviceId,roomId}),/Invalid/);
 assert.throws(()=>createDeviceCommand('launch_app',{issuedAt:1},{deviceId,roomId}),/Invalid/);
});
test('rejects stale, future, replay-shaped and cross-device or cross-room envelopes',()=>{
 const message=createDeviceCommand('view_offer',{sessionId:requestId,offer:{sdp:'v=0\\r\\n'}},{deviceId,roomId,now:10_000,requestId});
 assert.equal(validateDeviceCommand(message,{deviceId,roomId,now:10_000}),true);
 assert.equal(validateDeviceCommand(message,{deviceId,roomId,now:50_001}),false);
 assert.equal(validateDeviceCommand({...message,issuedAt:50_000},{deviceId,roomId,now:10_000}),false);
 assert.equal(validateDeviceCommand({...message,roomId:deviceId},{deviceId,roomId,now:10_000}),false);
 assert.equal(validateDeviceCommand({...message,deviceId:roomId},{deviceId,roomId,now:10_000}),false);
 assert.equal(validateDeviceCommand({...message,requestId:'not-a-uuid'},{deviceId,roomId,now:10_000}),false);
});
test('classifies grant responses distinctly so draft permission cannot masquerade as control',()=>{
 assert.equal(classifyDeviceResponse({ok:true,capability:'control'}),'control');
 assert.equal(classifyDeviceResponse({ok:true,capability:'draft',expiresSeconds:60}),'draft');
 assert.equal(classifyDeviceResponse({ok:true,capability:'view'}),'view');
 assert.equal(classifyDeviceResponse({ok:true,capability:'terminal',sessionId:requestId}),'terminal');
 assert.equal(classifyDeviceResponse({ok:true,capability:'launch',pid:123}),'launch');
 assert.equal(classifyDeviceResponse({ok:true,expiresSeconds:60}),null);
 assert.equal(classifyDeviceResponse({ok:false,capability:'control'}),'error');
 assert.equal(classifyDeviceResponse({ok:true,capability:'admin'}),null);
});
test('ICE candidates are bounded per session and globally and are drained once',()=>{
 const queue=new Map();
 for(let i=0;i<64;i++)assert.equal(queueIceCandidate(queue,requestId,{candidate:String(i)}),true);
 assert.equal(queueIceCandidate(queue,requestId,{candidate:'overflow'}),false);assert.equal(queueIceCandidate(queue,requestId,{candidate:'x'.repeat(2049)}),false);assert.equal(queueIceCandidate(queue,requestId,{candidate:'x',evil:'field'}),false);
 assert.equal(takeIceCandidates(queue,requestId).length,64);
 assert.equal(takeIceCandidates(queue,requestId).length,0);
 assert.equal(queueIceCandidate(queue,'bad',{candidate:'x'}),false);
 for(let i=0;i<16;i++){
   const id='123e4567-e89b-42d3-a456-'+String(i).padStart(12,'0');
   queueIceCandidate(queue,id,{candidate:'x'});
 }
 assert.equal(queueIceCandidate(queue,roomId,{candidate:'too-many-sessions'}),false);
});

test('rejects invalid app IDs, missing session IDs and oversized WebRTC SDP',()=>{
 assert.throws(()=>createDeviceCommand('launch_app',{appId:'not-a-uuid'},{deviceId,roomId}),/Invalid/);
 assert.throws(()=>createDeviceCommand('terminal_start',{sessionId:requestId,offer:{sdp:''}},{deviceId,roomId}),/Invalid/);
 assert.throws(()=>createDeviceCommand('view_offer',{sessionId:requestId,offer:{sdp:'x'.repeat(65537)}},{deviceId,roomId}),/Invalid/);
 assert.throws(()=>createDeviceCommand('request_control',{sessionId:'bad'},{deviceId,roomId}),/Invalid/);
 assert.throws(()=>createDeviceCommand('stop_session',{sessionId:requestId,terminalSessionId:'bad'},{deviceId,roomId}),/Invalid/);
});
