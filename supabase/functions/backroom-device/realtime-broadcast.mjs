const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS=new Set(['command','signal','device_revoked']);
export async function broadcastPrivateDeviceEvent({
 projectUrl,apiKey,deviceId,event,payload,fetchImpl=fetch
}={}){
 if(typeof projectUrl!=='string'||typeof apiKey!=='string'||apiKey.length<20||
    typeof fetchImpl!=='function'||typeof deviceId!=='string'||!UUID.test(deviceId)||
    !EVENTS.has(event)||!payload||typeof payload!=='object'||Array.isArray(payload)||
    payload.deviceId!==deviceId.toLowerCase()||typeof payload.roomId!=='string'||!UUID.test(payload.roomId))
   throw new TypeError('Invalid private device broadcast');
 const base=projectUrl.replace(/\/$/,'');
 const url=new URL(base);
 const localLoopback=(url.hostname==='127.0.0.1'||url.hostname==='localhost'||url.hostname==='[::1]')&&url.protocol==='http:';
 const localGateway=url.hostname==='kong'&&url.port==='8000'&&url.protocol==='http:';
 const local=localLoopback||localGateway;
 if(url.protocol!=='https:'&&!local)throw new TypeError('Private broadcast requires HTTPS');
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/')
   throw new TypeError('Invalid Supabase project URL');
 if(!local&&!/(?:^|\.)supabase\.(?:co|in)$/i.test(url.hostname))
   throw new TypeError('Expected a Supabase project URL');
 const topic='backroom-device:'+deviceId.toLowerCase();
 const endpoint=base+'/realtime/v1/api/broadcast/'+encodeURIComponent(topic)+'/events/'+encodeURIComponent(event)+'?private=true';
 const response=await fetchImpl(endpoint,{
  method:'POST',
  headers:{apikey:apiKey,'Content-Type':'application/json'},
  body:JSON.stringify(payload),
 });
 if(!response?.ok)throw new Error('Private device broadcast was rejected');
 return Object.freeze({sent:true,event,deviceId:deviceId.toLowerCase()});
}
