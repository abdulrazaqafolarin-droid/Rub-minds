import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDesktopCommand,validateDesktopSignal} from './desktop-command-protocol.mjs';

const deviceId='10000000-0000-4000-8000-000000000001';
const roomId='20000000-0000-4000-8000-000000000002';
const sessionId='30000000-0000-4000-8000-000000000003';
const requestId='40000000-0000-4000-8000-000000000004';
const appId='50000000-0000-4000-8000-000000000005';
const offer={sdp:'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n'};
const base={deviceId,roomId,requestId,issuedAt:10_000};
const check=(command,details,now=10_000)=>validateDesktopCommand({...base,command,details},{now});

test('validates selected app launch and rejects extra or malformed properties',()=>{
 assert.equal(check('launch_app',{appId}).command,'launch_app');
 assert.equal(check('launch_app',{appId,executablePath:'C:\\private\\secret.exe'}),null);
 assert.equal(check('launch_app',{appId:'not-a-uuid'}),null);
 assert.equal(check('launch_app',{}),null);
});
test('validates screen and terminal offer sessions with bounded SDP',()=>{
 assert.equal(check('view_offer',{sessionId,offer}).details.sessionId,sessionId);
 assert.equal(check('view_offer',{sessionId,appId,offer}).details.appId,appId);
 assert.equal(check('view_offer',{sessionId,appId:'bad',offer}),null);
 assert.equal(check('terminal_start',{sessionId,offer}).command,'terminal_start');
 assert.equal(check('view_offer',{sessionId,offer:{sdp:'x'}}),null);
 assert.equal(check('view_offer',{sessionId,offer:{sdp:'v=0'+'.'.repeat(70_000)}}),null);
 assert.equal(check('terminal_start',{sessionId,offer,roomId}),null);
});
test('control, draft and stop require session IDs and terminal peer IDs must match',()=>{
 assert.equal(check('request_control',{sessionId}).command,'request_control');
 assert.equal(check('request_control',{sessionId,peerSessionId:sessionId}).command,'request_control');
 assert.equal(check('request_control',{sessionId,peerSessionId:'bad'}),null);
 assert.equal(check('request_control',{sessionId,peerSessionId:'60000000-0000-4000-8000-000000000006'}),null);
 assert.equal(check('request_draft_permission',{sessionId}).command,'request_draft_permission');
 assert.equal(check('stop_session',{sessionId}).command,'stop_session');
 assert.equal(check('stop_session',{sessionId,terminalSessionId:sessionId}),null);
 assert.equal(check('stop_session',{sessionId,extraProcessId:sessionId}),null);
 assert.equal(check('request_control',{sessionId,roomId}),null);
});
test('rejects cross-device, cross-room, stale, future, replay-shaped and malformed commands',()=>{
 assert.equal(validateDesktopCommand({...base,deviceId:'bad',command:'launch_app',details:{appId}}),null);
 assert.equal(validateDesktopCommand({...base,roomId:'bad',command:'launch_app',details:{appId}}),null);
 assert.equal(check('launch_app',{appId},40_001),null);
 assert.equal(validateDesktopCommand({...base,issuedAt:40_001,command:'launch_app',details:{appId}},{now:10_000}),null);
 assert.equal(validateDesktopCommand({...base,action:'request_control',command:'request_control',details:{sessionId}},{now:10_000}),null);
 assert.equal(validateDesktopCommand({...base,command:'shell_exec',details:{command:'whoami'}},{now:10_000}),null);
 assert.equal(validateDesktopCommand({...base,command:'launch_app',details:{appId},admin:true},{now:10_000}),null);
});
test('validates authenticated signal envelope with bounded ICE candidate details',()=>{
 const candidate={candidate:'candidate:1 1 UDP 2122260223 192.0.2.1 12345 typ host',sdpMid:'0',sdpMLineIndex:0};
 const valid=validateDesktopSignal({deviceId,roomId,sessionId,issuedAt:10_000,candidate},{now:10_000});
 assert.equal(valid.sessionId,sessionId);
 assert.equal(validateDesktopSignal({deviceId,roomId,sessionId,issuedAt:10_000,candidate:{candidate:'x',privateData:'secret'}},{now:10_000}),null);
 assert.equal(validateDesktopSignal({deviceId,roomId,sessionId,issuedAt:10_000,candidate:{candidate:'x'.repeat(2050)}},{now:10_000}),null);
 assert.equal(validateDesktopSignal({deviceId,roomId,sessionId,issuedAt:50_000,candidate},{now:10_000}),null);
 assert.equal(validateDesktopSignal({deviceId,roomId,sessionId,issuedAt:10_000,candidate:null},{now:10_000}),null);
});
