import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {WakeAuthorizationAuthority} from './wake-authorization.mjs';
import {buildCanonicalWakePrompt} from './coordination-core.mjs';
const scope={hostId:'host-1',groupId:'group-1',participantId:'claude-1',sessionId:'session-1',spaceId:'space-1',bindingId:'binding-1',targetId:'target-1',identityFingerprint:'window:claude:one',targetRevision:3};
function context(overrides={}){const eventId='event-1',text=buildCanonicalWakePrompt(eventId);return {purpose:'backroom.wake.v1',commandId:'command-1',eventId, ...scope,operation:'wake',textSha256:createHash('sha256').update(text,'utf8').digest('hex'),...overrides};}
test('continuous wake grant requires explicit confirmation and exact finite scope',()=>{
 const auth=new WakeAuthorizationAuthority();
 assert.throws(()=>auth.createGrant({...scope,confirmed:false}),/Explicit user confirmation/);
 const grant=auth.createGrant({...scope,confirmed:true});
 assert.equal(grant.scope.targetId,scope.targetId);
 assert.equal(auth.status(grant.grantId).active,true);
 assert.throws(()=>auth.createGrant({...scope,confirmed:true,ttlMs:60*60*1000+1}),/lifetime/);
});
test('canonical wake grant preflight and one-shot command consumption',()=>{
 const auth=new WakeAuthorizationAuthority(),grant=auth.createGrant({...scope,confirmed:true});
 const c=context();
 assert.equal(auth.verify(grant.grantId,c,{consume:false}),true);
 assert.equal(auth.verify(grant.grantId,c),true);
 assert.equal(auth.verify(grant.grantId,c),false);
 assert.equal(auth.status(grant.grantId).usedCommands,1);
});
test('wrong scope, non-canonical prompt digest, wrong operation and invalid IDs fail closed',()=>{
 const auth=new WakeAuthorizationAuthority(),grant=auth.createGrant({...scope,confirmed:true});
 for(const c of [
  context({targetId:'another-target'}),
  context({sessionId:'another-session'}),
  context({participantId:'another-ai'}),
  context({targetRevision:scope.targetRevision+1}),
  context({operation:'submit'}),
  context({textSha256:'0'.repeat(64)}),
  context({commandId:'bad command'}),
 ])assert.equal(auth.verify(grant.grantId,c),false);
});
test('rate limit is bounded per grant and resumes after rolling window',()=>{
 let now=1_000_000;
 const auth=new WakeAuthorizationAuthority({now:()=>now,maxPerMinute:2,maxGrantMs:300_000});
 const grant=auth.createGrant({...scope,confirmed:true,ttlMs:300_000});
 assert.equal(auth.verify(grant.grantId,context({commandId:'cmd-1'})),true);
 assert.equal(auth.verify(grant.grantId,context({commandId:'cmd-2'})),true);
 assert.equal(auth.verify(grant.grantId,context({commandId:'cmd-3'})),false);
 now+=60_001;
 assert.equal(auth.verify(grant.grantId,context({commandId:'cmd-3'})),false,'grant has expired');
});
test('revoked and expired grants cannot authorize future sends',()=>{
 let now=5000;
 const auth=new WakeAuthorizationAuthority({now:()=>now,maxGrantMs:60_000});
 const revoked=auth.createGrant({...scope,confirmed:true,ttlMs:60_000});
 assert.equal(auth.revoke(revoked.grantId),true);
 assert.equal(auth.verify(revoked.grantId,context()),false);
 const expired=auth.createGrant({...scope,confirmed:true,ttlMs:60_000});
 now+=60_000;
 assert.equal(auth.verify(expired.grantId,context()),false);
 assert.equal(auth.status(expired.grantId).active,false);
});
