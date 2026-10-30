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
    ['requestId','action','issuedAt','deviceId','roomId'].some(key=>Object.hasOwn(details,key)))
  throw new TypeError('Invalid device command');
 return buildScopedDeviceMessage({...details,requestId,action,issuedAt:now},{deviceId,roomId});
}
export function validateDeviceCommand(payload,{deviceId,roomId,now=Date.now(),maxAgeMs=30_000}={}){
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||
  !isUuid(deviceId)||!isUuid(roomId)||
  payload.deviceId!==deviceId||payload.roomId!==roomId||
  !isUuid(payload.requestId)||!COMMANDS.has(payload.action)||
  !Number.isSafeInteger(payload.issuedAt)||Math.abs(now-payload.issuedAt)>maxAgeMs)
  return false;
 return true;
}
export function classifyDeviceResponse(payload){
 if(!payload||typeof payload!=='object'||payload.ok!==true)return 'error';
 if(CAPABILITIES.has(payload.capability))return payload.capability;
 if(typeof payload.sessionId==='string'&&Number.isInteger(payload.cols))return 'terminal';
 if(typeof payload.pid==='number')return 'launch';
 return null;
}
export function queueIceCandidate(queue,sessionId,candidate,{maxSessions=16,maxPerSession=64}={}){
 if(!isUuid(sessionId)||!candidate||typeof candidate!=='object')return false;
 let items=queue.get(sessionId);
 if(!items){if(queue.size>=maxSessions)return false;items=[];queue.set(sessionId,items);}
 if(items.length>=maxPerSession)return false;
 items.push(candidate);return true;
}
export function takeIceCandidates(queue,sessionId){
 const items=queue.get(sessionId)||[];queue.delete(sessionId);return items;
}
