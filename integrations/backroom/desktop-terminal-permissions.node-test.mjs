import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopTerminalPermissions as create,desktopTerminalIdentity} from './desktop-terminal-permissions.mjs';
const t={id:'one',hostId:'h',roomId:'r',spaceId:'s',sessionId:'ss',appId:'signed:editor',identityFingerprint:'window+signer',locatorKind:'accessibility',locatorValue:'field',revision:1,surface:'windows_app'};
test('owner confirmation and separate draft-only capability',()=>{
 const p=create({hostId:'h'});assert.equal(p.allows({target:t,capability:'draft'}),false);
 assert.throws(()=>p.approve({target:t,capability:'draft'}),/confirmation/);
 assert.throws(()=>p.approve({target:t,capability:'execute',ownerConfirmed:true}),/capability/);
 p.approve({target:t,capability:'draft',ownerConfirmed:true});
 assert.equal(p.allows({target:t,capability:'draft'}),true);
 assert.equal(p.allows({target:t,capability:'submit'}),false);
});
test('scope, signer, session, locator and revision are bound',()=>{
 const p=create({hostId:'h'});p.approve({target:t,capability:'draft',ownerConfirmed:true});
 for(const k of ['id','hostId','roomId','spaceId','sessionId','appId','identityFingerprint','locatorValue'])
  assert.equal(p.allows({target:{...t,[k]:'changed'},capability:'draft'}),false,k);
 assert.equal(p.allows({target:{...t,revision:2},capability:'draft'}),false);
 assert.notEqual(desktopTerminalIdentity(t),desktopTerminalIdentity({...t,revision:2}));
});
test('terminal requires PTY binding; no shell execution permission',()=>{
 const p=create({hostId:'h'});const term={...t,surface:'terminal',locatorKind:'terminal_pty'};
 assert.throws(()=>p.approve({target:{...term,locatorKind:'accessibility'},capability:'draft',ownerConfirmed:true}),/binding/);
 assert.throws(()=>p.approve({target:{...t,locatorKind:'screen_region'},capability:'draft',ownerConfirmed:true}),/binding/);
 p.approve({target:term,capability:'draft',ownerConfirmed:true});
 assert.equal(p.allows({target:term,capability:'draft'}),true);
 assert.equal(p.allows({target:term,capability:'execute'}),false);
});
test('revoke, emergency stop and cross-host fail closed',()=>{
 const p=create({hostId:'h'});p.approve({target:t,capability:'draft',ownerConfirmed:true});
 assert.equal(p.revoke({target:t}),true);assert.equal(p.allows({target:t,capability:'draft'}),false);
 assert.throws(()=>p.approve({target:{...t,hostId:'other'},capability:'draft',ownerConfirmed:true}),/Wrong host/);
 p.approve({target:t,capability:'draft',ownerConfirmed:true});p.stop();
 assert.equal(p.allows({target:t,capability:'draft'}),false);
 assert.throws(()=>p.approve({target:t,capability:'draft',ownerConfirmed:true}),/paused/);
});
