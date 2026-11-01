const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateDesktopSessionAbandon(value,{now=Date.now(),maxAgeMs=30_000}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const keys=['action','deviceId','roomId','sessionId','requestId','issuedAt'];
 if(Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))||
    keys.some(key=>!Object.hasOwn(value,key))||value.action!=='desktop/session-abandon'||
    ![value.deviceId,value.roomId,value.sessionId,value.requestId].every(id=>typeof id==='string'&&UUID.test(id))||
    !Number.isSafeInteger(value.issuedAt)||!Number.isSafeInteger(now)||
    !Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000||maxAgeMs>120_000||
    Math.abs(now-value.issuedAt)>maxAgeMs)return null;
 return Object.freeze({
  deviceId:value.deviceId.toLowerCase(),roomId:value.roomId.toLowerCase(),
  sessionId:value.sessionId.toLowerCase(),requestId:value.requestId.toLowerCase(),
  issuedAt:value.issuedAt
 });
}
