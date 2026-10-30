/**
 * Binds authenticated inbound commands to a native-only permission screen.
 * Network callers cannot get a grantId or invoke the trusted confirmation API.
 * The displayApproval callback MUST be backed by a trusted local window, not RPC.
 */
import {createCompanionCommandGate} from './companion-command-gate.mjs';
export function createCompanionSession({
 deviceId,userId,kernel,isAuthenticated,authorizeRoom,displayApproval,now=()=>Date.now(),
}={}){
 if(typeof displayApproval!=='function')throw new TypeError('Trusted device approval window required');
 const gate=createCompanionCommandGate({deviceId,userId,kernel,isAuthenticated,authorizeRoom,now});
 let stopped=false;
 const inflight=new Set();
 async function request(msg){
   if(stopped)throw new Error('Companion session disconnected');
   const response=await gate.receive(msg);
   if(msg.action==='close')return Object.freeze({commandId:msg.commandId,closed:true});
   const challenge=response.result;
   if(!challenge || typeof challenge.id!=='string'||!challenge.scope||
      !['launch','view','control','draft'].includes(challenge.operation))
     throw new Error('Invalid native permission challenge');
   // Approval is requested on the LOCAL computer. Never return grants over RPC.
   const task={cancelled:false};
   inflight.add(task);
   try {
     const localDecision=await displayApproval(Object.freeze({
       operation:challenge.operation,scope:challenge.scope,
       description:challenge.description,expiresAt:challenge.expiresAt
     }));
     if(stopped||task.cancelled)throw new Error('Companion disconnected during approval');
     // The boolean is produced by the local callback, not from msg or its payload.
     const approved=kernel.permissions.confirm({
       requestId:challenge.id,trustedLocalDecision:true,approved:localDecision===true
     });
     if(!approved.allowed)return Object.freeze({commandId:msg.commandId,approved:false});
     if(challenge.operation==='launch'){
       // Grant consumed internally, never sent to Backroom.
       const result=await kernel.launch({scope:challenge.scope,grantId:approved.grantId});
       return Object.freeze({commandId:msg.commandId,approved:true,result});
     }
     // View/control/draft are NOT active sessions until device-side driver
     // is available. Don't leak a one-time grant through an RPC response.
     kernel.permissions.revokeScope(challenge.scope);
     return Object.freeze({
       commandId:msg.commandId,approved:false,
       unavailable:true,reason:'Native media or input driver not configured'
     });
   } finally {inflight.delete(task)}
 }
 return Object.freeze({
   request,
   disconnect(){
     stopped=true;
     for(const item of inflight)item.cancelled=true;
     return gate.disconnect();
   },
   get status(){return Object.freeze({stopped,approvalRequests:inflight.size,gate:gate.status})}
 });
}
