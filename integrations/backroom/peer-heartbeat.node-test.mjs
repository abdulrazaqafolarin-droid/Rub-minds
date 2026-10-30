import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePeerHeartbeat} from './peer-heartbeat.mjs';
const sessionId='30000000-0000-4000-8000-000000000003';
const make=(sentAt=10_000)=>({kind:'heartbeat',sessionId,sentAt});
test('accepts an exact fresh heartbeat for the correct peer session',()=>{
 assert.equal(validatePeerHeartbeat(make(),{sessionId,now:10_000}).sessionId,sessionId);
});
test('rejects stale, future, wrong-session and malformed heartbeat payloads',()=>{
 assert.equal(validatePeerHeartbeat(make(1),{sessionId,now:10_000}),null);
 assert.equal(validatePeerHeartbeat(make(20_000),{sessionId,now:10_000}),null);
 assert.equal(validatePeerHeartbeat({...make(),sessionId:'40000000-0000-4000-8000-000000000004'},{sessionId,now:10_000}),null);
 assert.equal(validatePeerHeartbeat({...make(),extra:true},{sessionId,now:10_000}),null);
 assert.equal(validatePeerHeartbeat(null,{sessionId,now:10_000}),null);
});
test('enforces a bounded configurable freshness window',()=>{
 assert.ok(validatePeerHeartbeat(make(9_000),{sessionId,now:10_000,maxAgeMs:1_500}));
 assert.equal(validatePeerHeartbeat(make(8_000),{sessionId,now:10_000,maxAgeMs:1_500}),null);
});
