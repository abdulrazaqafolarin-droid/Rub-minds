const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACES=new Set(["android_app","desktop_app","terminal"]);
const MAX_REQUEST_AGE_MS=30_000;
function exactKeys(value,keys){
  return !!value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
}
export function validateDeviceFrameBindingChallenge(value,{now=Date.now()}={}){
  const keys=["deviceId","roomId","requestId","issuedAt","runtimeSessionId","participantId","surface"];
  if(!exactKeys(value,keys)||!UUID.test(value.deviceId??"")||!UUID.test(value.roomId??"")||
    !UUID.test(value.requestId??"")||!UUID.test(value.runtimeSessionId??"")||!UUID.test(value.participantId??"")||
    !Number.isSafeInteger(value.issuedAt)||!Number.isSafeInteger(now)||Math.abs(now-value.issuedAt)>MAX_REQUEST_AGE_MS||
    !SURFACES.has(value.surface))return null;
  return Object.freeze({...value});
}
export function validateDeviceFrameBindingRevoke(value){
  const keys=["deviceId","roomId","runtimeSessionId","bindingId"];
  if(!exactKeys(value,keys)||!UUID.test(value.deviceId??"")||!UUID.test(value.roomId??"")||
    !UUID.test(value.runtimeSessionId??"")||!UUID.test(value.bindingId??""))return null;
  return Object.freeze({...value});
}
export function validateDeviceFrameBindingStatus(value){
  const keys=["deviceId","roomId","runtimeSessionId"];
  if(!exactKeys(value,keys)||!UUID.test(value.deviceId??"")||!UUID.test(value.roomId??"")||
    !UUID.test(value.runtimeSessionId??""))return null;
  return Object.freeze({...value});
}
