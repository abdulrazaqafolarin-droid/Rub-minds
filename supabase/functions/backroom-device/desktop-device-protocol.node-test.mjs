import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDesktopRegistration,validateDesktopCapabilities,isValidDesktopDeviceToken} from './desktop-device-protocol.mjs';
const valid={
 deviceId:'123e4567-e89b-42d3-a456-426614174000',
 roomId:'123e4567-e89b-42d3-a456-426614174001',
 deviceLabel:'Razaq workstation',
 platform:'windows',
 osVersion:'Windows 11',
 appVersion:'0.1.0',
 devicePublicKey:'a'.repeat(64),
};
test('accepts normalized Windows/macOS/Linux native registration',()=>{
 for(const platform of ['windows','macos','linux']){
  const result=validateDesktopRegistration({...valid,platform});
  assert.equal(result.platform,platform);
  assert.equal(result.deviceLabel,'Razaq workstation');
 }
 assert.equal(validateDesktopRegistration({...valid,deviceLabel:'  PC  '}).deviceLabel,'PC');
});
test('rejects missing fields, extra fields, malformed IDs and platform spoofing',()=>{
 assert.equal(validateDesktopRegistration({...valid,deviceId:'../../etc/passwd'}),null);
 assert.equal(validateDesktopRegistration({...valid,roomId:'not-a-uuid'}),null);
 assert.equal(validateDesktopRegistration({...valid,platform:'android'}),null);
 assert.equal(validateDesktopRegistration({...valid,devicePublicKey:'x'.repeat(64)}),null);
 assert.equal(validateDesktopRegistration({...valid,untrustedOwnerId:'victim'}),null);
 const missing={...valid};delete missing.devicePublicKey;
 assert.equal(validateDesktopRegistration(missing),null);
});
test('rejects empty, oversized and control-character labels / metadata',()=>{
 assert.equal(validateDesktopRegistration({...valid,deviceLabel:'  '}),null);
 assert.equal(validateDesktopRegistration({...valid,deviceLabel:'x'.repeat(81)}),null);
 assert.equal(validateDesktopRegistration({...valid,deviceLabel:'PC\nadmin'}),null);
 assert.equal(validateDesktopRegistration({...valid,osVersion:'x'.repeat(41)}),null);
 assert.equal(validateDesktopRegistration({...valid,appVersion:' '}),null);
});
test('capabilities are default-deny and reject unverified OS permission claims',()=>{
 assert.deepEqual(validateDesktopCapabilities({liveScreen:false,desktopControl:false,terminalControl:false}),
  {liveScreen:false,desktopControl:false,terminalControl:false});
 assert.equal(validateDesktopCapabilities({desktopControl:true}),null);
 assert.equal(validateDesktopCapabilities({liveScreen:true}),null);
 assert.equal(validateDesktopCapabilities({filePicker:true}),null);
 assert.equal(validateDesktopCapabilities({shell:true}),null);
 assert.equal(validateDesktopCapabilities({}),null);
 assert.equal(validateDesktopCapabilities({desktopControl:'yes'}),null);
});
test('device tokens must be cryptographically sized lowercase hex',()=>{
 assert.equal(isValidDesktopDeviceToken('1'.repeat(64)),true);
 assert.equal(isValidDesktopDeviceToken('1'.repeat(63)),false);
 assert.equal(isValidDesktopDeviceToken('G'.repeat(64)),false);
 assert.equal(isValidDesktopDeviceToken(null),false);
});
