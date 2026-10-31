import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativePtyAdapter} from './native-pty-adapter.mjs';
test('Windows terminal requests ConPTY and forwards real bounded output',async()=>{
 const events=[],stream=[];
 const pty={spawn:(shell,args,opts)=>{
  events.push({shell,args,opts});
  return {onData:fn=>{stream.push(fn);return {dispose:()=>events.push('disposed')}},
   write:s=>events.push(['write',s]),resize:(c,r)=>events.push(['resize',c,r]),
   kill:()=>events.push('killed')};
 }};
 const create=createNativePtyAdapter({pty,platform:'win32'});
 const out=[];
 const term=await create({shell:'powershell.exe',args:[],onData:s=>out.push(s)});
 assert.equal(events[0].opts.useConpty,true);
 stream[0]('real session output');
 assert.deepEqual(out,['real session output']);
 term.write('Get-Location\r');
 term.resize(100,40);
 assert.deepEqual(events[1],['write','Get-Location\r']);
 assert.deepEqual(events[2],['resize',100,40]);
 term.kill();term.kill();
 assert.equal(events.filter(x=>x==='killed').length,1);
 assert.throws(()=>term.write('pwd'),/stopped/);
});
test('unsupported platform, invalid native binding and PTY parameters are rejected',async()=>{
 assert.throws(()=>createNativePtyAdapter({}),/binding/);
 assert.throws(()=>createNativePtyAdapter({pty:{spawn(){}},platform:'android'}),/Unsupported/);
 const create=createNativePtyAdapter({pty:{spawn(){throw new Error('should not run')}},platform:'linux'});
 await assert.rejects(create({shell:'/bin/bash',cols:0,onData:()=>{}}),/Invalid/);
});

test('draft-only PTY transport never forwards Enter, control keys, or ANSI escapes',async()=>{
 const writes=[];
 const pty={spawn:()=>({onData:()=>({dispose(){}}),write:s=>writes.push(s),resize(){},kill(){}})};
 const term=await createNativePtyAdapter({pty,platform:'linux'})({shell:'/bin/sh',onData:()=>{}});
 for(const value of ['x\r','x\n','\u001b[31m','x\u007f','x\u2028','x\u0085','', '   ']){
   assert.throws(()=>term.writeDraft(value),/draft-only/);
 }
 term.writeDraft('Claude Code prompt only');
 assert.deepEqual(writes,['Claude Code prompt only']);
 term.kill();
 assert.throws(()=>term.writeDraft('another'),/stopped/);
});
