/**
 * Stable local Backroom host identity. The 256-bit host credential must remain
 * in this trusted host process/private file, NEVER in web UI or console logs.
 */
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,open,readFile,lstat,realpath,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[a-f0-9]{64}$/;
async function privateDirectory(directory){
 await mkdir(directory,{recursive:true,mode:0o700});
 const stat=await lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||
   (process.platform!=='win32'&&(stat.mode&0o077)!==0))
  throw new Error('Unsafe Backroom host identity directory');
}
function normalizedIdentity(record){
 if(!record||record.version!==1||!UUID.test(record.hostId??'')||!TOKEN.test(record.hostToken??''))
  throw new Error('Invalid Backroom host identity: manual recovery required');
 return Object.freeze({hostId:record.hostId,hostToken:record.hostToken,
   credentialDigest:createHash('sha256').update(record.hostToken,'utf8').digest('hex')});
}
export async function loadOrCreateHostIdentity({filePath}={}){
 if(typeof filePath!=='string'||!filePath.trim())throw new TypeError('Private host identity path required');
 const path=resolve(filePath);
 await privateDirectory(dirname(path));
 let file,created=false;
 try{
  file=await open(path,'wx',0o600);
  created=true;
 }catch(error){
  if(error?.code!=='EEXIST')throw error;
 }
 if(created){
  try{
   const record={version:1,hostId:randomUUID(),hostToken:randomBytes(32).toString('hex')};
   await file.writeFile(JSON.stringify(record)+'\n','utf8');
   await file.sync();
  }finally{await file.close();}
 }
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||
   (process.platform!=='win32'&&(stat.mode&0o077)!==0))
  throw new Error('Unsafe Backroom host identity file');
 if(stat.size>512||stat.size<110)throw new Error('Invalid Backroom host identity size');
 let record;
 try{record=JSON.parse(await readFile(path,'utf8'));}
 catch{throw new Error('Corrupt Backroom host identity: manual recovery required');}
 return normalizedIdentity(record);
}

/**
 * Deliberate local rotation after remote host revocation or suspected compromise.
 * Run only while the host process is stopped. Removing the old identity makes
 * the next host startup generate a fresh host ID and unrelated 256-bit secret.
 */
export async function rotateHostIdentity({filePath}={}){
 if(typeof filePath!=='string'||!filePath.trim())throw new TypeError('Private host identity path required');
 const path=resolve(filePath);
 await privateDirectory(dirname(path));
 try{
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||
    (process.platform!=='win32'&&(stat.mode&0o077)!==0))
   throw new Error('Unsafe Backroom host identity file');
  await unlink(path);
 }catch(error){
  if(error?.code!=='ENOENT')throw error;
 }
 return loadOrCreateHostIdentity({filePath:path});
}
