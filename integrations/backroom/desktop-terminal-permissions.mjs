/** Local owner permission record; never an OS permission or shell executor. */
const fields=['id','hostId','roomId','spaceId','sessionId','appId','identityFingerprint','locatorKind','locatorValue'];
export function desktopTerminalIdentity(t){
 if(!t||!['desktop_app','windows_app','terminal'].includes(t.surface)||fields.some(k=>typeof t[k]!=='string'||!t[k].trim())||!Number.isSafeInteger(t.revision)||t.revision<1)throw new TypeError('Verified native target required');
 if((t.surface==='terminal'&&t.locatorKind!=='terminal_pty')||(t.surface!=='terminal'&&t.locatorKind!=='accessibility'))throw new TypeError('Unsupported input binding');
 return JSON.stringify([...fields.map(k=>t[k]),t.revision,t.surface]);
}
export function createDesktopTerminalPermissions({hostId}={}){
 if(typeof hostId!=='string'||!hostId.trim())throw new TypeError('Host identity required');
 const grants=new Set();let stopped=false;
 return Object.freeze({
  // ownerConfirmed is ONLY meaningful from a trusted local human UI.
  approve({target,capability,ownerConfirmed=false}={}){
   if(stopped)throw new Error('Control paused');
   if(ownerConfirmed!==true)throw new Error('Local owner confirmation required');
   if(capability!=='draft')throw new Error('Unsupported capability');
   const key=desktopTerminalIdentity(target);
   if(target.hostId!==hostId)throw new Error('Wrong host');
   grants.add(key);return Object.freeze({targetId:target.id,capability,submitted:false});
  },
  allows({target,capability}={}){
   if(stopped||capability!=='draft')return false;
   try{return target.hostId===hostId&&grants.has(desktopTerminalIdentity(target))}catch{return false}
  },
  revoke({target}={}){try{return grants.delete(desktopTerminalIdentity(target))}catch{return false}},
  stop(){stopped=true;grants.clear();return {stopped:true,remaining:0}},
  get status(){return Object.freeze({stopped,granted:grants.size})}
 });
}
