const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMANDS=new Set(['launch_app','terminal_start','request_control','request_draft_permission','view_offer','stop_session']);
const EVENTS=new Set(['command','signal','device_revoked']);
const KEYS={
 launch_app:['appId'],
 terminal_start:['sessionId','offer'],
 view_offer:['sessionId','offer'],
 request_control:['sessionId'],
 request_draft_permission:['sessionId'],
 stop_session:['sessionId','terminalSessionId'],
};
const SIGNAL_KEYS=['sessionId','candidate'];
const ICE_KEYS=['candidate','sdpMid','sdpMLineIndex','usernameFragment'];
const isUuid=value=>typeof value==='string'&&UUID.test(value);
function exactKeys(value,keys){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));}
function validOffer(value){
 return exactKeys(value,['sdp'])&&typeof value.sdp==='string'&&value.sdp.length>=8&&value.sdp.length<=65_536&&value.sdp.startsWith('v=0');
}
function validCandidate(value){
 return exactKeys(value,Object.keys(value))&&Object.keys(value).length>0&&Object.keys(value).every(key=>ICE_KEYS.includes(key))&&
  typeof value.candidate==='string'&&value.candidate.length>0&&value.candidate.length<=2048&&
  (value.sdpMid===undefined||value.sdpMid===null||typeof value.sdpMid==='string'&&value.sdpMid.length<=128)&&
  (value.sdpMLineIndex===undefined||value.sdpMLineIndex===null||Number.isSafeInteger(value.sdpMLineIndex)&&value.sdpMLineIndex>=0&&value.sdpMLineIndex<=256)&&
  (value.usernameFragment===undefined||value.usernameFragment===null||typeof value.usernameFragment==='string'&&value.usernameFragment.length<=256);
}
export function validateDesktopCommand(value,{now=Date.now(),maxAgeMs=30_000}={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||!isUuid(value.deviceId)||!isUuid(value.roomId)||
    !isUuid(value.requestId)||!Number.isSafeInteger(value.issuedAt)||!Number.isSafeInteger(now)||
    !Number.isSafeInteger(maxAgeMs)||maxAgeMs<1_000||maxAgeMs>120_000||
    Math.abs(now-value.issuedAt)>maxAgeMs||!COMMANDS.has(value.command)||
    !exactKeys(value.details,KEYS[value.command]))return null;
 const d=value.details;
 if(value.command==='launch_app'&&!isUuid(d.appId))return null;
 if(value.command==='terminal_start'||value.command==='view_offer'){
  if(!isUuid(d.sessionId)||!validOffer(d.offer))return null;
 }
 if(value.command==='request_control'||value.command==='request_draft_permission'||value.command==='stop_session'){
  if(!isUuid(d.sessionId))return null;
 }
 if(value.command==='stop_session'&&d.terminalSessionId!==undefined&&!isUuid(d.terminalSessionId))return null;
 if(value.command==='request_draft_permission'&&value.sessionType==='terminal')return null;
 return Object.freeze({deviceId:value.deviceId.toLowerCase(),roomId:value.roomId.toLowerCase(),
  requestId:value.requestId.toLowerCase(),issuedAt:value.issuedAt,command:value.command,
  details:Object.freeze({...d, ...(d.offer?{offer:Object.freeze({...d.offer})}:{})})});
}
export function validateDesktopSignal(value,{now=Date.now(),maxAgeMs=30_000}={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||!isUuid(value.deviceId)||!isUuid(value.roomId)||
    !isUuid(value.sessionId)||!Number.isSafeInteger(value.issuedAt)||!Number.isSafeInteger(now)||
    !Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000||maxAgeMs>120_000||
    Math.abs(now-value.issuedAt)>maxAgeMs||!validCandidate(value.candidate))return null;
 return Object.freeze({deviceId:value.deviceId.toLowerCase(),roomId:value.roomId.toLowerCase(),
  sessionId:value.sessionId.toLowerCase(),issuedAt:value.issuedAt,candidate:Object.freeze({...value.candidate})});
}
export function validatePrivateBroadcast(value,{topic,event,payload}={}){
 if(typeof topic!=='string'||!/^backroom-device:[0-9a-f-]{36}$/i.test(topic)||!EVENTS.has(event)||
    !payload||typeof payload!=='object'||Array.isArray(payload))return false;
 const deviceId=topic.slice('backroom-device:'.length);
 return payload.deviceId===deviceId&&payload.roomId===value?.roomId;
}
