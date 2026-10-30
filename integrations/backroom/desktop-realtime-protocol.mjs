const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMANDS=new Set(['launch_app','terminal_start','request_control','request_draft_permission','view_offer','stop_session']);
const CAPABILITIES=new Set(['launch','terminal','view','control','draft','stop']);
export function isUuid(value){return typeof value==='string'&&UUID.test(value);}
export function buildScopedDeviceMessage(payload,{deviceId,roomId}={}){
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!isUuid(deviceId)||!isUuid(roomId))
  throw new TypeError('Valid device and room scope required');
 if(Object.hasOwn(payload,'deviceId')||Object.hasOwn(payload,'roomId'))
  throw new TypeError('Payload cannot override the device or room scope');
 return Object.freeze({...payload,roomId,deviceId});
}
export function createDeviceCommand(action,details,{deviceId,roomId,now=Date.now(),requestId=crypto.randomUUID()}={}){
 if(!COMMANDS.has(action)||!isUuid(requestId)||!Number.isSafeInteger(now)||
    !details||typeof details!=='object'||Array.isArray(details)||
    ['requestId','action','issuedAt','deviceId','roomId'].some(key=>Object.hasOwn(details,key))||
    !validCommandDetails(action,details))
  throw new TypeError('Invalid device command');
 return buildScopedDeviceMessage({...details,requestId,action,issuedAt:now},{deviceId,roomId});
}
function validCommandDetails(action,details){
 if(!details||typeof details!=='object'||Array.isArray(details))return false;
 if(action==='launch_app')return isUuid(details.appId);
 if(action==='terminal_start'||action==='view_offer'){
  return isUuid(details.sessionId)&&details.offer&&typeof details.offer==='object'&&
    typeof details.offer.sdp==='string'&&details.offer.sdp.length>0&&details.offer.sdp.length<=65_536;
 }
 if(action==='request_control'||action==='request_draft_permission')return isUuid(details.sessionId);
 if(action==='stop_session')return isUuid(details.sessionId)&&
   (details.terminalSessionId===undefined||isUuid(details.terminalSessionId));
 return false;
}
export function validateDeviceCommand(payload,{deviceId,roomId,now=Date.now(),maxAgeMs=30_000}={}){
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||
  !isUuid(deviceId)||!isUuid(roomId)||payload.deviceId!==deviceId||payload.roomId!==roomId||
  !isUuid(payload.requestId)||!COMMANDS.has(payload.action)||
  !Number.isSafeInteger(payload.issuedAt)||!Number.isSafeInteger(now)||
  !Number.isSafeInteger(maxAgeMs)||maxAgeMs<1_000||maxAgeMs>120_000||
  Math.abs(now-payload.issuedAt)>maxAgeMs||!validCommandDetails(payload.action,payload))
  return false;
 return true;
}
export function classifyDeviceResponse(payload){
 if(!payload||typeof payload!=='object'||payload.ok!==true)return 'error';
 if(payload.capability!==undefined)return CAPABILITIES.has(payload.capability)?payload.capability:null;
 if(typeof payload.sessionId==='string'&&Number.isInteger(payload.cols))return 'terminal';
 if(typeof payload.pid==='number')return 'launch';
 return null;
}
export function queueIceCandidate(queue,sessionId,candidate,{maxSessions=16,maxPerSession=64}={}){
 if(!isUuid(sessionId)||!candidate||typeof candidate!=='object'||Array.isArray(candidate))return false;
 const allowed=['candidate','sdpMid','sdpMLineIndex','usernameFragment'];
 if(Object.keys(candidate).some(key=>!allowed.includes(key)))return false;
 if(typeof candidate.candidate!=='string'||candidate.candidate.length===0||candidate.candidate.length>2048)return false;
 if(candidate.sdpMid!==undefined&&candidate.sdpMid!==null&&(typeof candidate.sdpMid!=='string'||candidate.sdpMid.length>128))return false;
 if(candidate.sdpMLineIndex!==undefined&&candidate.sdpMLineIndex!==null&&
    (!Number.isSafeInteger(candidate.sdpMLineIndex)||candidate.sdpMLineIndex<0||candidate.sdpMLineIndex>256))return false;
 if(candidate.usernameFragment!==undefined&&candidate.usernameFragment!==null&&
    (typeof candidate.usernameFragment!=='string'||candidate.usernameFragment.length>256))return false;
 let items=queue.get(sessionId);
 if(!items){if(queue.size>=maxSessions)return false;items=[];queue.set(sessionId,items);}
 if(items.length>=maxPerSession)return false;
 items.push(Object.freeze({...candidate}));return true;
}
export function takeIceCandidates(queue,sessionId){
 const items=queue.get(sessionId)||[];queue.delete(sessionId);return items;
}
