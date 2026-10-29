import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileWakeExecutionJournal} from './file-wake-execution-journal.mjs';
const job={jobKey:'a'.repeat(64),jobId:'40000000-0000-4000-8000-000000000011',
 hostId:'40000000-0000-4000-8000-000000000022',
 bindingId:'40000000-0000-4000-8000-000000000033',
 sessionDigest:'b'.repeat(64),targetId:'target-1'};
test('persistent atomic seal refuses duplicate executions across restarts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-seal-'));
 try{
  const directory=join(dir,'journal');
  const first=new FileWakeExecutionJournal({directory});
  const second=new FileWakeExecutionJournal({directory});
  assert.equal(await first.reserve(job),true);
  assert.equal(await second.reserve(job),false);
  const files=await readdir(directory);
  assert.equal(files.length,1);
  assert.match(files[0],/^[0-9a-f]{64}\.sealed$/);
  assert.equal(await readFile(join(directory,files[0]),'utf8'),'wake-execution-reserved\n');
  assert.deepEqual(await Promise.all([first.reserve({...job,jobId:'40000000-0000-4000-8000-000000000044'}),
  first.reserve({...job,jobId:'40000000-0000-4000-8000-000000000044'})]).then(x=>x.sort()),[false,true]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('fails closed on missing identity or unsafe symlinked directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-seal-security-'));
 try{
  const journal=new FileWakeExecutionJournal({directory:join(dir,'journal')});
  await assert.rejects(()=>journal.reserve({...job,sessionDigest:'invalid'}),/Valid scoped/);
  const link=join(dir,'redirect');
  await symlink(dir,link,'dir');
  await assert.rejects(()=>new FileWakeExecutionJournal({directory:link}).reserve(job),/Unsafe wake journal/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
