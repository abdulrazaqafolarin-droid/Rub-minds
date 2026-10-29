import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,chmod,symlink,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadOrCreateHostIdentity,rotateHostIdentity} from './host-identity.mjs';
test('stable private host ID and credential survive restart without rekeying',async()=>{
 const root=await mkdtemp(join(tmpdir(),'backroom-host-identity-'));
 try{
  const filePath=join(root,'private','host.json');
  const first=await loadOrCreateHostIdentity({filePath});
  const second=await loadOrCreateHostIdentity({filePath});
  assert.deepEqual(first,second);
  assert.match(first.hostId,/^[a-f0-9-]{36}$/);
  assert.match(first.hostToken,/^[a-f0-9]{64}$/);
  assert.equal(first.credentialDigest,createHash('sha256').update(first.hostToken).digest('hex'));
  const file=await readFile(filePath,'utf8');
  assert.ok(file.includes(first.hostId));
  assert.ok(!file.includes(first.credentialDigest));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('concurrent first start cannot create two divergent host identities',async()=>{
 const root=await mkdtemp(join(tmpdir(),'backroom-host-concurrent-'));
 try{
  const filePath=join(root,'private','host.json');
  const outcomes=await Promise.allSettled(Array.from({length:5},()=>loadOrCreateHostIdentity({filePath})));
  const fulfilled=outcomes.filter(x=>x.status==='fulfilled').map(x=>x.value);
  assert.ok(fulfilled.length>=1);
  assert.ok(fulfilled.every(x=>x.hostId===fulfilled[0].hostId));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('corruption and permissive existing credentials fail closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'backroom-host-invalid-'));
 try{
  const privateDir=join(root,'private');await mkdir(privateDir,{mode:0o700});
  const path=join(privateDir,'host.json');
  await writeFile(path,'{}',{mode:0o600});
  await assert.rejects(()=>loadOrCreateHostIdentity({filePath:path}),/Invalid Backroom host identity/);
  if(process.platform!=='win32'){
   await chmod(path,0o644);
   await assert.rejects(()=>loadOrCreateHostIdentity({filePath:path}),/Unsafe Backroom host identity file/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('symlinked identity paths and directories are rejected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'backroom-host-link-'));
 try{
  const actual=join(root,'real');await mkdir(actual,{mode:0o700});
  const identity=join(actual,'host.json');
  await loadOrCreateHostIdentity({filePath:identity});
  const linkedFile=join(actual,'linked.json');await symlink(identity,linkedFile);
  await assert.rejects(()=>loadOrCreateHostIdentity({filePath:linkedFile}),/Unsafe Backroom host identity file/);
  const linkedDir=join(root,'linked-dir');await symlink(actual,linkedDir,'dir');
  await assert.rejects(()=>loadOrCreateHostIdentity({filePath:join(linkedDir,'host.json')}),/Unsafe Backroom host identity directory/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('explicit local rotation creates a new unrelated host ID and credential',async()=>{
 const root=await mkdtemp(join(tmpdir(),'backroom-host-rotate-'));
 try{
  const filePath=join(root,'private','host.json');
  const before=await loadOrCreateHostIdentity({filePath});
  const after=await rotateHostIdentity({filePath});
  assert.notEqual(after.hostId,before.hostId);
  assert.notEqual(after.hostToken,before.hostToken);
  assert.equal(after.credentialDigest,createHash('sha256').update(after.hostToken).digest('hex'));
  assert.ok(!JSON.stringify(after).includes(before.hostToken));
  assert.deepEqual(await loadOrCreateHostIdentity({filePath}),after);
 }finally{await rm(root,{recursive:true,force:true});}
});
