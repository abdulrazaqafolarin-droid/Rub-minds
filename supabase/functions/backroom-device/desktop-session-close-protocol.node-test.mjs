import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDesktopSessionClose} from './desktop-session-close-protocol.mjs';
const roomId='20000000-0000-4000-8000-000000000002';
const sessionId='30000000-0000-4000-8000-000000000003';
test('accepts exact valid session close scope',()=>{
 assert.deepEqual(validateDesktopSessionClose({action:'desktop/session-close',roomId,sessionId}),{roomId,sessionId});
});
test('rejects invalid IDs, missing fields and extra caller-controlled scope',()=>{
 assert.equal(validateDesktopSessionClose({action:'desktop/session-close',roomId,sessionId,deviceId:'40000000-0000-4000-8000-000000000004'}),null);
 assert.equal(validateDesktopSessionClose({action:'desktop/session-close',roomId,sessionId:'bad'}),null);
 assert.equal(validateDesktopSessionClose({action:'desktop/session-close',roomId}),null);
 assert.equal(validateDesktopSessionClose({action:'owner/revoke',roomId,sessionId}),null);
 assert.equal(validateDesktopSessionClose([]),null);
});
test('normalizes uppercase UUID input to canonical lowercase',()=>{
 const value=validateDesktopSessionClose({
  action:'desktop/session-close',
  roomId:roomId.toUpperCase(),
  sessionId:sessionId.toUpperCase()
 });
 assert.equal(value.roomId,roomId);
 assert.equal(value.sessionId,sessionId);
});
