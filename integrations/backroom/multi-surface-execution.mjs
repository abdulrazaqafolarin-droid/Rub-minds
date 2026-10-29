/**
 * Multi-surface local execution foundation.
 * Browser, desktop, Windows, terminal and Android use a single target/guard
 * contract. No OS driver is installed or enabled by this module.
 *
 * Native and terminal operations are deliberately draft-only. A remote
 * message, boolean "approved", or target registration never authorizes Send.
 */
import {TargetRegistry,validateTarget} from './target-registry.mjs';
import {LocalExecutionGuard} from './host-runtime.mjs';
import {NativeAccessibilityDraftAdapter} from './native-accessibility-adapter.mjs';
import {TerminalDraftAdapter} from './terminal-draft-adapter.mjs';

const NATIVE=new Set(['desktop_app','windows_app','android_app']);
const SURFACES=new Set(['browser_tab',...NATIVE,'terminal']);
const CONTROL=/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
function requireCommand(command,target) {
 if(!command||typeof command!=='object'||Array.isArray(command)||
    command.operation!=='draft'||typeof command.text!=='string'||
    !command.text.trim()||command.text.length>4000||CONTROL.test(command.text))
  throw new TypeError('Draft-only single-line text command required');
 const scope=['hostId','roomId','spaceId','sessionId','identityFingerprint'];
 if(scope.some(k=>command[k]!==target[k])||command.targetId!==target.id||
    command.targetRevision!==target.revision)
  throw new Error('Command target scope mismatch');
}
function makeAdapter(target,driver) {
 const args={driver,appId:target.appId,sessionId:target.sessionId,
  identityFingerprint:target.identityFingerprint,locatorValue:target.locatorValue};
 if(NATIVE.has(target.surface)) {
  if(target.locatorKind!=='accessibility')throw new Error('Native targets require accessibility binding');
  return new NativeAccessibilityDraftAdapter({...args,surface:target.surface});
 }
 if(target.surface==='terminal'){
  if(target.locatorKind!=='terminal_pty')throw new Error('Terminal requires verified assistant composer PTY binding');
  return new TerminalDraftAdapter(args);
 }
 throw new Error('Browser target is managed by BrowserHostRuntime, not the native executor');
}

export function createMultiSurfaceExecutionService({hostId,permission,isConnected}={}){
 if(typeof hostId!=='string'||!hostId.trim()||
    typeof permission!=='function'||typeof isConnected!=='function')
  throw new TypeError('Host identity and explicit permission/connection checks required');
 const registry=new TargetRegistry(),drivers=new Map();
 let stopped=false;
 function resolve(targetId,command){
  if(stopped)throw new Error('Host automation stopped');
  if(typeof targetId!=='string'||!drivers.has(targetId))throw new Error('Driver missing or target revoked');
  const entry=drivers.get(targetId);
  return registry.resolve(targetId,{roomId:entry.target.roomId,hostId,
   spaceId:entry.target.spaceId,sessionId:entry.target.sessionId,
   identityFingerprint:entry.target.identityFingerprint,
   expectedRevision:entry.target.revision});
 }
 return Object.freeze({
  register({target:candidate,driver,consented=false}={}){
   if(stopped)throw new Error('Host automation stopped');
   if(consented!==true)throw new Error('Explicit local input registration consent required');
   const target=validateTarget(candidate);
   if(target.hostId!==hostId||!SURFACES.has(target.surface))
    throw new Error('Host/surface mismatch');
   if(target.surface==='browser_tab')throw new Error('Browser targets require BrowserHostRuntime');
   const adapter=makeAdapter(target,driver);
   if(drivers.has(target.id))throw new Error('Target already registered');
   registry.register(target);
   drivers.set(target.id,Object.freeze({target,adapter}));
   return Object.freeze({targetId:target.id,surface:target.surface,operations:['draft'],submitted:false});
  },
  list(){
   if(stopped)return [];
   return [...drivers.values()].map(({target})=>Object.freeze({
    id:target.id,surface:target.surface,roomId:target.roomId,
    spaceId:target.spaceId,sessionId:target.sessionId,operations:['draft']
   }));
  },
  async draft({command,approved=false}={}){
   if(approved!==true)throw new Error('Explicit approval required for this draft');
   const target=resolve(command?.targetId,command);
   requireCommand(command,target);
   const entry=drivers.get(target.id);
   const guard=new LocalExecutionGuard({
    host:{hostId,deviceLabel:'Backroom local runtime',
      surfaces:[target.surface],operations:['draft']},
    adapter:entry.adapter,
    permission:async({command:c,target:t})=>
      !stopped && (await permission({command:c,target:t}))===true,
    isConnected:async()=>!stopped && (await isConnected(hostId))===true
   });
   const result=await guard.execute({command,target});
   return Object.freeze({state:result.state,submitted:false,result:result.result??null});
  },
  revoke({targetId,roomId}={}){
   if(stopped)return false;
   const entry=drivers.get(targetId);
   if(!entry||entry.target.roomId!==roomId)return false;
   registry.unregister(targetId,{roomId,hostId});
   drivers.delete(targetId);
   return true;
  },
  stop(){
   stopped=true;
   for(const id of [...drivers.keys()])drivers.delete(id);
   return Object.freeze({stopped:true,remaining:0});
  },
  get status(){return Object.freeze({running:!stopped,registered:drivers.size,
    capabilities:Object.freeze({browserDraft:false,desktopAccessibility:false,
      androidAccessibility:false,terminal:false})});}
 });
}
