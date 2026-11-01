/**
 * Durable local one-time execution seal, written before any AI-provider UI effect.
 * Entries are intentionally not automatically released after a crash or ambiguous
 * submit. Reconciliation requires explicit operator action and a new wake event.
 */
import {createHash} from 'node:crypto';
import {mkdir,open,lstat,realpath} from 'node:fs/promises';
import {resolve,join,win32} from 'node:path';

const DIGEST=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
async function hasSymlinkInPath(directory) {
 if (process.platform !== "win32") return false;
 const parsed = win32.parse(directory);
 if (!parsed.root) return true;
 let current = parsed.root;
 if ((await lstat(current)).isSymbolicLink()) return true;
 for (const component of directory.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
  current = win32.join(current, component);
  if ((await lstat(current)).isSymbolicLink()) return true;
 }
 return false;
}

function validRecord(job) {
  return job && DIGEST.test(job.jobKey??'') && UUID.test(job.jobId??'') &&
    UUID.test(job.hostId??'') && UUID.test(job.bindingId??'') &&
    DIGEST.test(job.sessionDigest??'') && ID.test(job.targetId??'');
}
export class FileWakeExecutionJournal {
  constructor({directory}={}) {
    if(typeof directory!=='string'||!directory.trim())throw new TypeError('Private journal directory required');
    this.directory=resolve(directory);
  }
  async reserve(job) {
    if(!validRecord(job))throw new TypeError('Valid scoped wake job required');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    // Refuse symlinked journal directories; do not trust a browser-selected path.
    const stat=await lstat(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform==='win32' ? await hasSymlinkInPath(this.directory) : await realpath(this.directory)!==this.directory) ||
       (process.platform!=='win32' && (stat.mode & 0o077)!==0))
      throw new Error('Unsafe wake journal directory');
    const digest=createHash('sha256').update(JSON.stringify([
      job.jobKey,job.jobId,job.hostId,job.bindingId,job.sessionDigest,job.targetId
    ])).digest('hex');
    const path=join(this.directory,digest+'.sealed');
    let file;
    try {file=await open(path,'wx',0o600);}
    catch(error){if(error?.code==='EEXIST')return false;throw error;}
    try {
      await file.writeFile('wake-execution-reserved\n','utf8');
      await file.sync();
      return true;
    } finally {await file.close();}
  }
}
