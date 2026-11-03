import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=process.cwd();
const manifest=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));

test('every node --test file referenced by any package script exists',async()=>{
 const references=[];
 for(const [script,command] of Object.entries(manifest.scripts??{})){
  if(!/^node --test(?:\s|$)/.test(command))continue;
  for(const token of command.replace(/^node --test\s*/,'').split(/\s+/).filter(Boolean)){
   if(token.startsWith('-'))continue;
   references.push({script,path:token});
  }
 }
 assert.ok(references.length>0,'At least one Node test suite must be registered.');
 const missing=[];
 for(const ref of references){
  try{await access(resolve(root,ref.path));}
  catch{missing.push(ref);}
 }
 assert.deepEqual(missing,[], 'package scripts reference missing test files: '+JSON.stringify(missing));
});

test('critical Backroom test suites remain registered in runtime and queue scripts',()=>{
 const required={
  'test:runtime':['integrations/backroom/host-wake-service.node-test.mjs',
   'integrations/backroom/host-identity.node-test.mjs',
   'integrations/backroom/multi-surface-execution.node-test.mjs',
   'integrations/backroom/native-wake-handoff.node-test.mjs'],
  'test:backroom':['integrations/backroom/host-server.node-test.mjs',
   'integrations/backroom/multi-surface-execution.node-test.mjs',
   'integrations/backroom/native-wake-handoff.node-test.mjs'],
  'test:durable-queue':['integrations/backroom/host-wake-service.node-test.mjs',
   'integrations/backroom/host-identity.node-test.mjs'],
  'test:companion':['integrations/backroom/android-native-wake-source.node-test.mjs']
 };
 for(const [name,paths] of Object.entries(required)){
  const command=manifest.scripts?.[name];
  assert.equal(typeof command,'string','Missing package script '+name);
  for(const path of paths)assert.ok(command.includes(path),name+' must include '+path);
 }
});



test('focused Backroom test commands cover multi-surface and hosted lifecycle contracts',()=>{
 const multi=manifest.scripts?.['test:multi-surface'];
 assert.equal(typeof multi,'string','Missing focused multi-surface test command');
 for(const path of ['integrations/backroom/multi-surface-execution.node-test.mjs',
  'integrations/backroom/native-accessibility-adapter.node-test.mjs',
  'integrations/backroom/terminal-draft-adapter.node-test.mjs',
  'integrations/backroom/native-wake-handoff.node-test.mjs'])
  assert.ok(multi.includes(path),'test:multi-surface must include '+path);
 const lifecycle=manifest.scripts?.['test:host-lifecycle'];
 assert.equal(typeof lifecycle,'string','Missing focused host lifecycle test command');
 for(const path of ['integrations/backroom/host-identity.node-test.mjs',
  'integrations/backroom/host-wake-service.node-test.mjs',
  'integrations/backroom/remote-wake-store.node-test.mjs'])
  assert.ok(lifecycle.includes(path),'test:host-lifecycle must include '+path);
});

test('host identity rotation is explicit and cannot be mistaken for server revocation',async()=>{
 const wrapper=await readFile(resolve(root,'scripts/backroom-host.mjs'),'utf8');
 const server=await readFile(resolve(root,'scripts/backroom-host-server.mjs'),'utf8');
 const rotateCommand=manifest.scripts?.['backroom:rotate-host'];
 assert.equal(rotateCommand,'node scripts/backroom-host.mjs --rotate-identity-only');
 assert.match(wrapper,/ambiguousRotate\s*=\s*process\.argv\.includes\("--rotate-identity"\)/);
 assert.match(wrapper,/Local rotation does not revoke a server host/);
 assert.match(server,/This only rotates the local file; it does NOT revoke the previous server registration/);
});


test('original-session bridge runner is explicit and its safety tests are registered',()=>{
 const runner=manifest.scripts?.['original-session:bridge'];
 assert.equal(runner,'node scripts/original-session-bridge.mjs');
 const focused=manifest.scripts?.['test:original-session-runner'];
 assert.equal(focused,'node --test integrations/playwright/original-session-cli.node-test.mjs');
 assert.ok(manifest.scripts?.['test:original-wake']?.includes('integrations/playwright/original-session-cli.node-test.mjs'));
 assert.ok(manifest.scripts?.['test:runtime']?.includes('integrations/playwright/original-session-cli.node-test.mjs'));
});


test('local Playwright runner isolates its browser profile and environment',async()=>{
 const runner=await readFile(resolve(root,'scripts/original-session-bridge.mjs'),'utf8');
 assert.match(runner,/launchPersistentContext\(profileDirectory,\s*\{[\s\S]*?env:\s*browserProcessEnvironment\(env\)/);
 assert.match(runner,/BROWSER_ENV_ALLOWLIST/);
 assert.match(runner,/join\(homedir\(\),\s*"\.rub-minds",\s*"original-session-profiles",\s*provider\)/);
 assert.doesNotMatch(runner,/connectOverCDP/);
 assert.match(runner,/controller\.signal\.aborted\s*&&\s*error\?\.name\s*===\s*"AbortError"/);
});
