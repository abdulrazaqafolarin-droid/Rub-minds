import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionCommandGate} from './companion-command-gate.mjs';
const scope={roomId:'room-1',spaceId:'space-1',appId:'terminal-1',surface:'terminal',identityFingerprint:'fingerprint-1'};
const msg={commandId:'command-1',deviceId:'device-1',userId:'user-1',sentAt:10_000,action:'request_launch',scope};
function fixture(overrides={}){
 const calls=[];
 const kernel={requestLaunch:async s=>{calls.push(['launch',s]);return {id:'local-confirmation-1'}},
 requestCapability:async (s,o)=>{calls.push(['capability',o]);return {id:'local-confirmation-2'}},
 close:async s=>{calls.push(['close',s]);return {closed:true}},
 emergencyStop:()=>{calls.push(['stop'])}};
 const gate=createCompanionCommandGate({deviceId:'device-1',userId:'user-1',kernel,
 isAuthenticated:async()=>true,authorizeRoom:async()=>true,now:()=>10_000,...overrides});
 return {gate,calls};
}
test('only forwards requests after device and room authentication',async()=>{
 const {gate,calls}=fixture();
 const v=await gate.receive(msg);
 assert.equal(v.result.id,'local-confirmation-1');
 assert.equal(calls.length,1);
 await assert.rejects(gate.receive(msg),/Duplicate/);
 await assert.rejects(gate.receive({...msg,commandId:'command-2',userId:'other-user'}),/Wrong device/);
 await assert.rejects(gate.receive({...msg,commandId:'command-3',sentAt:-100_000}),/expired/);
 assert.equal(calls.length,1);
});
test('rejects expired session and room membership before any execution',async()=>{
 const a=fixture({isAuthenticated:async()=>false});
 await assert.rejects(a.gate.receive(msg),/not authenticated/);
 assert.equal(a.calls.length,0);
 const b=fixture({authorizeRoom:async()=>false});
 await assert.rejects(b.gate.receive(msg),/Room permission denied/);
 assert.equal(b.calls.length,0);
});
test('rejects duplicate IDs even during asynchronous authentication',async()=>{
 let release;
 const blocker=new Promise(resolve=>{release=resolve});
 const a=fixture({isAuthenticated:()=>blocker});
 const p=a.gate.receive(msg);
 await assert.rejects(a.gate.receive(msg),/Duplicate command/);
 release(true);
 await p;
 assert.equal(a.calls.length,1);
});
test('disconnect fails closed, clears session and emergency-stops native kernel',async()=>{
 const {gate,calls}=fixture();
 gate.disconnect();
 assert.equal(calls[0][0],'stop');
 await assert.rejects(gate.receive(msg),/disconnected/);
});
test('an incoming command cannot grant local permission or send terminal keystrokes',async()=>{
 const {gate,calls}=fixture();
 await assert.rejects(gate.receive({...msg,action:'confirm',approved:true}),/Invalid companion/);
 await assert.rejects(gate.receive({...msg,action:'writeTerminal',text:'rm -rf /'}),/Invalid companion/);
 await gate.receive({...msg,commandId:'command-4',action:'request_control'});
 assert.deepEqual(calls,[['capability','control']]);
});
