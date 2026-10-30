/**
 * Device-side inbound command gate. No localhost pairing, network approval
 * endpoint, or access to permissions.confirm() is exposed here.
 *
 * The real transport must validate the Supabase session/JWT, device ownership,
 * and group membership SERVER-SIDE before it delivers commands to this gate.
 * A trusted native UI separately receives a request and decides approval.
 */
const ACTIONS=new Set(['request_launch','request_view','request_control','request_draft','close']);
const IDENT=/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/;
function ident(s){return typeof s==='string'&&IDENT.test(s)}
function validateEnvelope(msg) {
  if(!msg||typeof msg!=='object'||Array.isArray(msg)||
    !ident(msg.commandId)||!ident(msg.deviceId)||!ident(msg.userId)||
    !Number.isSafeInteger(msg.sentAt)||!ACTIONS.has(msg.action)||
    !msg.scope||typeof msg.scope!=='object'||
    ['roomId','spaceId','appId','identityFingerprint'].some(k=>!ident(msg.scope[k]))||
    !['desktop_app','windows_app','terminal'].includes(msg.scope.surface))
    throw new Error('Invalid companion command envelope');
}
export function createCompanionCommandGate({
  deviceId,userId,kernel,isAuthenticated,authorizeRoom,
  now=()=>Date.now(),maxAgeMs=30_000
}={}) {
  if(!ident(deviceId)||!ident(userId)||!kernel||
    typeof isAuthenticated!=='function'||typeof authorizeRoom!=='function'||
    typeof now!=='function'||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000)
    throw new TypeError('Verified device identity and authorization adapters required');
  let stopped=false;
  const seen=new Map();
  const pending=new Map();
  const devicescope=new Set();
  async function receive(msg){
    if(stopped)throw new Error('Companion disconnected');
    validateEnvelope(msg);
    if(msg.deviceId!==deviceId||msg.userId!==userId)throw new Error('Wrong device owner');
    const time=now();
    if(Math.abs(time-msg.sentAt)>maxAgeMs)throw new Error('Command expired or from the future');
    if(seen.has(msg.commandId)||pending.has(msg.commandId))throw new Error('Duplicate command');
    if((await isAuthenticated({deviceId,userId}))!==true)
      throw new Error('Device session not authenticated');
    if((await authorizeRoom({deviceId,userId,roomId:msg.scope.roomId,action:msg.action}))!==true)
      throw new Error('Room permission denied');
    // Never run an incoming command directly: native confirmation remains separate.
    const operation=msg.action.replace(/^request_/,'');
    const execute=async()=>{
      if(msg.action==='request_launch')return kernel.requestLaunch(msg.scope);
      if(msg.action==='close')return kernel.close(msg.scope);
      return kernel.requestCapability(msg.scope,operation);
    };
    pending.set(msg.commandId,true);
    try {
      const result=await execute();
      // Limit retained deduplication IDs, including normal close commands.
      seen.set(msg.commandId,time);
      for(const [id,at] of seen)if(time-at>maxAgeMs)seen.delete(id);
      if(seen.size>2048)seen.delete(seen.keys().next().value);
      devicescope.add(msg.scope.roomId);
      return Object.freeze({commandId:msg.commandId,result});
    }finally{pending.delete(msg.commandId)}
  }
  return Object.freeze({
    receive,
    disconnect(){
      stopped=true;seen.clear();pending.clear();devicescope.clear();
      kernel.emergencyStop();
      return {disconnected:true};
    },
    get status(){return Object.freeze({connected:!stopped,seen:seen.size,rooms:devicescope.size})},
  });
}
