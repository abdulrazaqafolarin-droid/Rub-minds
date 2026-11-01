import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionPermissionBroker } from './desktop-companion-permissions.mjs';
const target = Object.freeze({
  roomId: 'room-001', spaceId: 'space-001', appId: 'terminal-1',
  surface: 'terminal', identityFingerprint: 'sha256-fake-identity',
});
test('default deny and no remote grant from a web request', () => {
  const broker = createCompanionPermissionBroker();
  const request = broker.request({scope:target,operation:'launch'});
  assert.throws(() => broker.confirm({requestId:request.id,approved:true}), /Local device confirmation/);
  assert.equal(broker.consume({scope:target,operation:'launch',grantId:'not-granted'}), false);
});
test('one local launch approval cannot become desktop control or another app launch', () => {
  const broker = createCompanionPermissionBroker();
  const request = broker.request({scope:target,operation:'launch'});
  const grant = broker.confirm({requestId:request.id,approved:true,trustedLocalDecision:true});
  assert.equal(broker.consume({scope:target,operation:'control',grantId:grant.grantId}),false);
  assert.equal(broker.consume({scope:{...target,appId:'other-app'},operation:'launch',grantId:grant.grantId}),false);
  assert.equal(broker.consume({scope:target,operation:'launch',grantId:grant.grantId}),true);
  assert.equal(broker.consume({scope:target,operation:'launch',grantId:grant.grantId}),false);
});
test('one-time grant binds room, space, surface and app fingerprint', () => {
  const broker = createCompanionPermissionBroker();
  for(const change of [{roomId:'other-room'},{spaceId:'another-space'},{surface:'desktop_app'},{identityFingerprint:'new-signature'}]){
    const request=broker.request({scope:target,operation:'view'});
    const approval=broker.confirm({requestId:request.id,approved:true,trustedLocalDecision:true});
    assert.equal(broker.consume({scope:{...target,...change},operation:'view',grantId:approval.grantId}),false);
    assert.equal(broker.consume({scope:target,operation:'view',grantId:approval.grantId}),true);
  }
});
test('device rejection, expiration, revocation and emergency stop fail closed', () => {
  let clock=1000;
  const broker=createCompanionPermissionBroker({now:()=>clock,ttlMs:1000});
  let request=broker.request({scope:target,operation:'launch'});
  assert.equal(broker.confirm({requestId:request.id,trustedLocalDecision:true,approved:false}).allowed,false);
  request=broker.request({scope:target,operation:'launch'});
  clock+=1001;
  assert.throws(()=>broker.confirm({requestId:request.id,trustedLocalDecision:true,approved:true}),/expired/);
  request=broker.request({scope:target,operation:'draft'});
  let grant=broker.confirm({requestId:request.id,trustedLocalDecision:true,approved:true});
  broker.revokeScope(target);
  assert.equal(broker.consume({scope:target,operation:'draft',grantId:grant.grantId}),false);
  request=broker.request({scope:target,operation:'launch'});
  grant=broker.confirm({requestId:request.id,trustedLocalDecision:true,approved:true});
  broker.stop();
  assert.equal(broker.consume({scope:target,operation:'launch',grantId:grant.grantId}),false);
  assert.throws(()=>broker.request({scope:target,operation:'launch'}),/stopped/);
});
test('malformed app identity and unsupported capabilities rejected', () => {
  const broker = createCompanionPermissionBroker();
  assert.throws(()=>broker.request({scope:{...target,roomId:'x; rm -rf /'},operation:'launch'}),/Verified/);
  assert.throws(()=>broker.request({scope:target,operation:'exec'}),/Unsupported/);
});
