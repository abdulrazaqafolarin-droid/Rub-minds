const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateDesktopSessionClose(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const keys=['action','roomId','sessionId'];
 if(Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))||
    keys.some(key=>!Object.hasOwn(value,key))||value.action!=='desktop/session-close'||
    typeof value.roomId!=='string'||!UUID.test(value.roomId)||
    typeof value.sessionId!=='string'||!UUID.test(value.sessionId))return null;
 return Object.freeze({roomId:value.roomId.toLowerCase(),sessionId:value.sessionId.toLowerCase()});
}
