import test from "node:test";
import assert from "node:assert/strict";
import {validateDeviceFrameBindingChallenge,validateDeviceFrameBindingRevoke,validateDeviceFrameBindingStatus}
  from "./device-frame-binding-protocol.mjs";
const deviceId="123e4567-e89b-42d3-a456-426614174000";
const roomId="123e4567-e89b-42d3-a456-426614174001";
const requestId="123e4567-e89b-42d3-a456-426614174002";
const runtimeSessionId="123e4567-e89b-42d3-a456-426614174003";
const participantId="123e4567-e89b-42d3-a456-426614174004";
const bindingId="123e4567-e89b-42d3-a456-426614174005";
const now=1_000_000;
const request=(surface="android_app")=>({deviceId,roomId,requestId,issuedAt:now,runtimeSessionId,participantId,surface});
test("accepts fresh exact Android, desktop and terminal challenge requests",()=>{
  for(const surface of ["android_app","desktop_app","terminal"])
    assert.equal(validateDeviceFrameBindingChallenge(request(surface),{now})?.surface,surface);
});
test("rejects stale, future, malformed and extra-field challenge requests",()=>{
  const value=request();
  assert.equal(validateDeviceFrameBindingChallenge({...value,issuedAt:now-30_001},{now}),null);
  assert.equal(validateDeviceFrameBindingChallenge({...value,issuedAt:now+30_001},{now}),null);
  assert.equal(validateDeviceFrameBindingChallenge({...value,extra:true},{now}),null);
  assert.equal(validateDeviceFrameBindingChallenge({...value,deviceId:"bad"},{now}),null);
  assert.equal(validateDeviceFrameBindingChallenge({...value,participantId:"bad"},{now}),null);
  assert.equal(validateDeviceFrameBindingChallenge({...value,runtimeSessionId:"bad"},{now}),null);
  assert.equal(validateDeviceFrameBindingChallenge({...value,surface:"browser_host"},{now}),null);
});
test("revoke and status requests require exact UUID scopes",()=>{
  const revoke={deviceId,roomId,runtimeSessionId,bindingId};
  assert.deepEqual(validateDeviceFrameBindingRevoke(revoke),revoke);
  assert.equal(validateDeviceFrameBindingRevoke({...revoke,extra:true}),null);
  assert.equal(validateDeviceFrameBindingRevoke({...revoke,bindingId:"bad"}),null);
  const status={deviceId,roomId,runtimeSessionId};
  assert.deepEqual(validateDeviceFrameBindingStatus(status),status);
  assert.equal(validateDeviceFrameBindingStatus({...status,extra:true}),null);
  assert.equal(validateDeviceFrameBindingStatus({...status,runtimeSessionId:"bad"}),null);
});
