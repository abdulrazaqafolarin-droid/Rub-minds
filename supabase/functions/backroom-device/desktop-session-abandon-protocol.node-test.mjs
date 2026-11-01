import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDesktopSessionAbandon} from './desktop-session-abandon-protocol.mjs';
const valid={action:'desktop/session-abandon',deviceId:'10000000-0000-4000-8000-000000000001',
 roomId:'20000000-0000-4000-8000-000000000002',sessionId:'30000000-0000-4000-8000-000000000003',
 requestId:'40000000-0000-4000-8000-000000000004',issuedAt:10_000};
test('accepts only fresh exactly-scoped abandon requests',()=>{
 assert.deepEqual(validateDesktopSessionAbandon(valid,{now:10_000}),{
  deviceId:valid.deviceId,roomId:valid.roomId,sessionId:valid.sessionId,requestId:valid.requestId,issuedAt:10_000
 });
});
test('rejects missing, extra, malformed and stale abandon inputs',()=>{
 assert.equal(validateDesktopSessionAbandon({...valid,deviceId:'bad'}),null);
 assert.equal(validateDesktopSessionAbandon({...valid,ownerId:'somebody'}),null);
 assert.equal(validateDesktopSessionAbandon({...valid,issuedAt:1},{now:100_000}),null);
 assert.equal(validateDesktopSessionAbandon({...valid,action:'desktop/session-close'}),null);
 assert.equal(validateDesktopSessionAbandon([]),null);
});
test('allows bounded clock skew and rejects requests outside the maximum window',()=>{
 assert.ok(validateDesktopSessionAbandon({...valid,issuedAt:10_001},{now:10_000}));
 assert.equal(validateDesktopSessionAbandon({...valid,issuedAt:40_001},{now:10_000}),null);
});
