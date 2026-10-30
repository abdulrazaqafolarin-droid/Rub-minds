/** Local owner-confirmation facade; not an OS driver or remote consent API. */
import {createMultiSurfaceExecutionService} from './multi-surface-execution.mjs';
import {createDesktopTerminalPermissions} from './desktop-terminal-permissions.mjs';
export function createDesktopTerminalOnboarding({hostId,permission,isConnected}={}){
 if(typeof permission!=='function'||typeof isConnected!=='function')throw new TypeError('Host permission and connection checks required');
 const grants=createDesktopTerminalPermissions({hostId});
 const engine=createMultiSurfaceExecutionService({hostId,isConnected,
  permission:async({command,target})=>grants.allows({target,capability:'draft'})&&
   (await permission({command,target}))===true&&grants.allows({target,capability:'draft'})});
 return Object.freeze({
  select({target,driver,ownerConfirmed=false}={}){
   grants.approve({target,capability:'draft',ownerConfirmed});
   try{return engine.register({target,driver,consented:true})}
   catch(error){grants.revoke({target});throw error}
  },
  list:()=>engine.list(),
  draft:({command,approved=false}={})=>engine.draft({command,approved}),
  revoke({target,roomId}={}){
   if(!target||roomId!==target.roomId)return false;
   grants.revoke({target});return engine.revoke({targetId:target.id,roomId});
  },
  stop(){grants.stop();return engine.stop()},
  get status(){return Object.freeze({permissions:grants.status,execution:engine.status})}
 });
}
