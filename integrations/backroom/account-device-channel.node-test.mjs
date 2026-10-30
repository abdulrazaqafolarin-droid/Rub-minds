import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountDeviceChannel} from './account-device-channel.mjs';
const token='test-access-token-of-sufficient-length';
const setup=(overrides={})=>{
 const sent=[],handled=[];
 let closed=0,now=123456;
 const channel=createAccountDeviceChannel({
  verifyAccessToken:async t=>t===token?{userId:'owner-1',deviceId:'desktop-1'}:null,
  connectTransport:async()=>({send:data=>sent.push(data),close:()=>closed++}),
  isDeviceAuthorized:async()=>true,
  onRequest:async request=>(handled.push(request),{accepted:true}),
  now:()=>now,...overrides
 });
 return {channel,sent,handled,get closed(){return closed},setNow:v=>now=v};
};
test('account registration requires a verified token and bound device',async()=>{
 const s=setup();
 await assert.rejects(s.channel.open({accessToken:'invalid',deviceId:'desktop-1'}),/Invalid identity/);
 await assert.rejects(s.channel.open({accessToken:token,deviceId:'desktop-2'}),/not authorized/);
 assert.deepEqual(await s.channel.open({accessToken:token,deviceId:'desktop-1'}),
 {connected:true,deviceId:'desktop-1',userId:'owner-1'});
 assert.equal(s.channel.status.connected,true);
 s.channel.disconnect();
 assert.equal(s.closed,1);
});
test('remote approval fields are stripped, replay and wrong device fail closed',async()=>{
 const s=setup();
 await s.channel.open({accessToken:token,deviceId:'desktop-1'});
 const request={id:'request-1',type:'launch',deviceId:'desktop-1',issuedAt:123456,
  payload:{appId:'calculator',approved:true,trustedLocalDecision:true,userId:'admin',accessToken:'stolen'}};
 await s.channel.receive(request);
 assert.deepEqual(s.handled[0].payload,{appId:'calculator'});
 assert.equal(s.handled[0].userId,'owner-1');
 assert.equal(s.sent.length,1);
 await assert.rejects(s.channel.receive(request),/Duplicate/);
 await assert.rejects(s.channel.receive({...request,id:'request-2',deviceId:'wrong-device'}),/stale request/);
});
test('expired requests, disconnected devices and shutdown are denied',async()=>{
 const s=setup();
 await assert.rejects(s.channel.receive({}),/disconnected/);
 await s.channel.open({accessToken:token,deviceId:'desktop-1'});
 await assert.rejects(s.channel.receive({id:'old',type:'control',deviceId:'desktop-1',issuedAt:1}),/stale/);
 s.channel.stop();
 assert.equal(s.closed,1);
 await assert.rejects(s.channel.open({accessToken:token,deviceId:'desktop-1'}),/stopped/);
});

test('device revoked after connection is disconnected before delivering a command',async()=>{
 const s=setup({isDeviceAuthorized:async()=>false});
 await s.channel.open({accessToken:token,deviceId:'desktop-1'});
 await assert.rejects(s.channel.receive({id:'revoked-1',type:'launch',deviceId:'desktop-1',issuedAt:123456,payload:{}}),/revoked/);
 assert.equal(s.handled.length,0);
 assert.equal(s.channel.status.connected,false);
 assert.equal(s.closed,1);
});
