/**
 * Native companion execution kernel, deliberately not an HTTP server.
 * A separate signed-in account/device transport must authenticate requests.
 * The native UI must deliver trusted approval through the permission broker;
 * remote JSON cannot set trustedLocalDecision.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createCompanionPermissionBroker } from './desktop-companion-permissions.mjs';

const ID=/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/;
function assertIdentity(scope) {
  if (!scope || ['roomId','spaceId','appId','surface','identityFingerprint'].some(k=>typeof scope[k]!=='string'||!scope[k].trim()))
    throw new Error('Verified scope required');
}
function safeProgram(spec) {
  if (!spec || typeof spec.path!=='string' || !path.isAbsolute(spec.path) ||
      !Array.isArray(spec.args) || spec.args.length>24 ||
      spec.args.some(v=>typeof v!=='string'||v.length>1000) ||
      typeof spec.fingerprint!=='string'||!ID.test(spec.fingerprint))
    throw new Error('Invalid executable metadata');
  // Do not support shell mode; inventory must be produced by trusted native discovery.
  return {path:spec.path,args:spec.args,fingerprint:spec.fingerprint};
}
export function createNativeCompanionKernel({
  inventory, spawnProcess = spawn, createPty, permissions = createCompanionPermissionBroker(),
  isDeviceConnected = ()=>false, onOutput = ()=>{},
} = {}) {
  if (typeof inventory!=='function'||typeof spawnProcess!=='function'||
      typeof isDeviceConnected!=='function'||typeof onOutput!=='function')
    throw new TypeError('Native discovery, connection and output adapters are required');
  const sessions=new Map();
  let stopped=false;
  function requireConnected() {
    if(stopped||!isDeviceConnected())throw new Error('Trusted device connection required');
  }
  async function lookup(scope) {
    assertIdentity(scope);
    const entries=await inventory(scope.surface);
    if(!Array.isArray(entries))throw new Error('Trusted installed app inventory unavailable');
    const row=entries.find(item=>item.id===scope.appId && item.fingerprint===scope.identityFingerprint);
    if(!row)throw new Error('Executable identity changed; rediscover and approve');
    return row;
  }
  async function launch({scope,grantId}={}) {
    requireConnected();
    const row=await lookup(scope);
    // Consume a native UI approval for the exact executable immediately before spawning it.
    if(!permissions.consume({scope,operation:'launch',grantId}))throw new Error('Device launch permission required');
    if(sessions.has(scope.spaceId))throw new Error('Space already running');
    if(scope.surface==='terminal'){
      if(typeof createPty!=='function')throw new Error('Native PTY backend not installed');
      if(!row.terminal || typeof row.shell!=='string' || !path.isAbsolute(row.shell))throw new Error('Verified absolute terminal path required');
      // createPty must implement a ConPTY backend on Windows, or PTY on macOS/Linux.
      const term=await createPty({shell:row.shell,args:row.args||[],cols:80,rows:24,
        onData:data=>{if(typeof data==='string')onOutput({spaceId:scope.spaceId,data:data.slice(0,32768)});}});
      const handle={scope,type:'terminal',stop:()=>term.kill(),write:data=>term.write(data),resize:(cols,rows)=>term.resize(cols,rows)};
      sessions.set(scope.spaceId,handle);
      return {spaceId:scope.spaceId,type:'terminal',realProcess:true};
    }
    if(!['desktop_app','windows_app'].includes(scope.surface))throw new Error('Unsupported native surface');
    const program=safeProgram(row);
    const proc=spawnProcess(program.path,program.args,{shell:false,detached:false,stdio:'ignore',windowsHide:false});
    // A spawned process may still report a delayed OS launch error.
    const handle={scope,type:'desktop',stop:()=>proc.kill(),process:proc};
    sessions.set(scope.spaceId,handle);
    proc.once('exit',()=>{if(sessions.get(scope.spaceId)===handle)sessions.delete(scope.spaceId);});
    proc.once('error',()=>{if(sessions.get(scope.spaceId)===handle)sessions.delete(scope.spaceId);});
    return {spaceId:scope.spaceId,type:'desktop',realProcess:true,started:true};
  }
  function get(scope) {
    const session=sessions.get(scope?.spaceId);
    if(!session||JSON.stringify(session.scope)!==JSON.stringify(scope))throw new Error('Active session not found');
    return session;
  }
  return Object.freeze({
    permissions,
    async requestLaunch(scope){
      requireConnected();
      await lookup(scope);
      return permissions.request({scope,operation:'launch'});
    },
    launch,
    async requestCapability(scope,operation){
      requireConnected();
      get(scope);
      if(!['view','control','draft'].includes(operation))throw new Error('Unsupported capability');
      return permissions.request({scope,operation});
    },
    writeTerminal({scope,grantId,text}={}){
      requireConnected();
      const session=get(scope);
      if(session.type!=='terminal')throw new Error('Not a terminal');
      if(typeof text!=='string'||text.length===0||text.length>4000||text.includes('\0'))
        throw new Error('Invalid terminal input');
      if(!permissions.consume({scope,operation:'control',grantId}))throw new Error('Device terminal control permission required');
      session.write(text);
      return {written:true,submitted:text.includes('\r')||text.includes('\n')};
    },
    close(scope){
      const session=get(scope);
      sessions.delete(scope.spaceId);
      permissions.revokeScope(scope);
      session.stop();
      return {closed:true};
    },
    emergencyStop(){
      stopped=true;
      permissions.stop();
      for(const session of sessions.values())session.stop();
      sessions.clear();
      return {stopped:true};
    },
    get activeSpaces(){return Object.freeze([...sessions.keys()])},
  });
}
