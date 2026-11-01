const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validatePeerHeartbeat(value,{sessionId,now=Date.now(),maxAgeMs=45_000,maxFutureSkewMs=5_000}={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).length!==3||!['kind','sessionId','sentAt'].every(key=>Object.hasOwn(value,key))||
    value.kind!=='heartbeat'||typeof sessionId!=='string'||!UUID.test(sessionId)||
    typeof value.sessionId!=='string'||!UUID.test(value.sessionId)||value.sessionId!==sessionId||
    !Number.isSafeInteger(value.sentAt)||!Number.isSafeInteger(now)||
    Math.abs(now-value.sentAt)>maxAgeMs||value.sentAt-now>maxFutureSkewMs)return null;
 return Object.freeze({sessionId,sentAt:value.sentAt});
}
