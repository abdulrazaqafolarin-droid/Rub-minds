import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForIceGatheringComplete} from './ice-gathering.mjs';
class FakePeer extends EventTarget{
 constructor(state='gathering'){super();this.iceGatheringState=state;}
 setState(state){this.iceGatheringState=state;this.dispatchEvent(new Event('icegatheringstatechange'));}
}
test('already-complete gathering resolves without subscribing',async()=>{
 const peer=new FakePeer('complete');
 await waitForIceGatheringComplete(peer);
 assert.equal(peer.listenerCount,undefined);
});
test('waits until the peer reports complete gathering',async()=>{
 const peer=new FakePeer();
 const pending=waitForIceGatheringComplete(peer,{timeoutMs:1000});
 peer.setState('gathering');
 peer.setState('complete');
 await pending;
});
test('rejects if ICE gathering never completes',async()=>{
 const peer=new FakePeer();
 await assert.rejects(waitForIceGatheringComplete(peer,{timeoutMs:100}),/did not complete/);
});
test('rejects malformed peers and out-of-range timeouts',async()=>{
 await assert.rejects(waitForIceGatheringComplete(null),/Invalid ICE/);
 await assert.rejects(waitForIceGatheringComplete(new FakePeer(),{timeoutMs:31_000}),/Invalid ICE/);
});
