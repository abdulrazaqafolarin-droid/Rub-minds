/**
 * Portable HTTPS request boundary for the trusted hosted Backroom wake gateway.
 * Mount only in an authenticated server-side environment with authoritative
 * database lookup functions and the private service-role durable store.
 *
 * Deliberately no CORS, cookie auth, GET endpoints, or tokens in URLs.
 */
const routes=Object.freeze({
  '/activate':'activate',
  '/deactivate':'deactivate',
  '/claim':'claim',
  '/ack':'acknowledge',
  '/retry':'retry',
  '/v1/backroom/wake/activate':'activate',
  '/v1/backroom/wake/deactivate':'deactivate',
  '/v1/backroom/wake/claim':'claim',
  '/v1/backroom/wake/ack':'acknowledge',
  '/v1/backroom/wake/retry':'retry',
  '/functions/v1/backroom-wake/activate':'activate',
  '/functions/v1/backroom-wake/deactivate':'deactivate',
  '/functions/v1/backroom-wake/claim':'claim',
  '/functions/v1/backroom-wake/ack':'acknowledge',
  '/functions/v1/backroom-wake/retry':'retry',
  '/backroom-wake/activate':'activate',
  '/backroom-wake/deactivate':'deactivate',
  '/backroom-wake/claim':'claim',
  '/backroom-wake/ack':'acknowledge',
  '/backroom-wake/retry':'retry',
});
const response=(status,body)=>new Response(JSON.stringify(body),{status,headers:{
  'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'no-store, max-age=0',
  'X-Content-Type-Options':'nosniff'
}});
const bad=()=>response(401,{ok:false,reason:'unauthorized'});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST=/^[0-9a-f]{64}$/;
const RETRY_ERRORS=new Set(['target_unavailable','approval_required','provider_busy','transport_error','result_unconfirmed','authorization_denied','other']);
function validOperationBody(method,body) {
 if(!UUID.test(body.hostId??'')||!UUID.test(body.bindingId??'')||!DIGEST.test(body.sessionDigest??''))return false;
 if(method==='activate')return UUID.test(body.grantId??'')&&Number.isSafeInteger(body.ttlSeconds)&&body.ttlSeconds>=60&&body.ttlSeconds<=900;
 if(method==='deactivate')return UUID.test(body.grantId??'');
 if(method==='claim')return body.limit===undefined||(Number.isSafeInteger(body.limit)&&body.limit>=1&&body.limit<=20);
 if(method==='acknowledge')return UUID.test(body.jobId??'')&&UUID.test(body.leaseToken??'')&&['acknowledged','ignored'].includes(body.outcome);
 return UUID.test(body.jobId??'')&&UUID.test(body.leaseToken??'')&&
  Number.isSafeInteger(body.retryAfterSeconds)&&body.retryAfterSeconds>=1&&body.retryAfterSeconds<=300&&
  typeof body.errorCode==='string'&&RETRY_ERRORS.has(body.errorCode);
}
async function readSmallJson(request,maxBytes) {
 const reader=request.body?.getReader();
 if(!reader)throw new Error('Missing body');
 const chunks=[];let bytes=0;
 try {
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   bytes+=value.byteLength;
   if(bytes>maxBytes)throw new Error('Payload too large');
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const buffer=new Uint8Array(bytes);
 let offset=0;
 for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected JSON object');
 return value;
}
/**
 * @typedef {{ok:boolean,[key:string]:unknown}} WakeGatewayHttpResult
 * @typedef {{activate:(input:any)=>Promise<WakeGatewayHttpResult>,deactivate:(input:any)=>Promise<WakeGatewayHttpResult>,claim:(input:any)=>Promise<WakeGatewayHttpResult>,acknowledge:(input:any)=>Promise<WakeGatewayHttpResult>,retry:(input:any)=>Promise<WakeGatewayHttpResult>}} WakeGatewayHttpContract
 * @typedef {{gateway:WakeGatewayHttpContract,maxBodyBytes:number}} WakeGatewayHttpOptions
 * @param {Partial<WakeGatewayHttpOptions>} [options]
 */
export function createWakeGatewayHttpHandler({gateway,maxBodyBytes=4096}={}) {
 if(!gateway||['activate','deactivate','claim','acknowledge','retry'].some(key=>typeof gateway[key]!=='function'))
  throw new TypeError('Authenticated wake gateway required');
 if(!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<512||maxBodyBytes>16384)
  throw new RangeError('Invalid body bound');
 return async function handleWakeGatewayRequest(request) {
  if(!(request instanceof Request))return response(400,{ok:false,reason:'invalid_request'});
  const url=new URL(request.url);
  // Supabase terminates public TLS at its gateway; the internal Edge Runtime URL
  // is HTTP even when the caller used HTTPS. Trust only the gateway's normalized
  // x-forwarded-proto value for the external scheme, while preserving direct HTTPS
  // behavior for local/hosted adapter tests.
  const forwardedProto=(request.headers.get('x-forwarded-proto')??'').split(',')[0].trim().toLowerCase();
  const externallyHttps=url.protocol==='https:'||(url.protocol==='http:'&&forwardedProto==='https');
  if(!externallyHttps||url.search||url.hash||request.method!=='POST'||
     !Object.hasOwn(routes,url.pathname))return response(404,{ok:false,reason:'not_found'});
  if(request.headers.has('origin')||request.headers.has('cookie')||
     request.headers.get('content-type')?.toLowerCase()!=='application/json')return bad();
  const header=request.headers.get('authorization')??'';
  const match=/^Bearer ([0-9a-f]{64})$/i.exec(header);
  if(!match)return bad();
  const contentLength=request.headers.get('content-length');
  if(contentLength && (!/^\d+$/.test(contentLength)||Number(contentLength)>maxBodyBytes))return response(413,{ok:false,reason:'payload_too_large'});
  let body;
  try {body=await readSmallJson(request,maxBodyBytes);}catch{return response(400,{ok:false,reason:'invalid_body'});}
  const method=routes[url.pathname];
  const permitted=method==='activate'?['hostId','sessionDigest','bindingId','grantId','ttlSeconds']:
    method==='deactivate'?['hostId','sessionDigest','bindingId','grantId']:
    method==='claim'?
    ['hostId','sessionDigest','bindingId','limit']:
    method==='acknowledge'?
      ['hostId','sessionDigest','bindingId','jobId','leaseToken','outcome']:
      ['hostId','sessionDigest','bindingId','jobId','leaseToken','retryAfterSeconds','errorCode'];
  if(Object.keys(body).some(key=>!permitted.includes(key))||!validOperationBody(method,body))
   return response(400,{ok:false,reason:'invalid_body'});
  const input={...body,hostToken:match[1]};
  try {
   const result=await gateway[method](input);
   if(!result?.ok)return result?.reason==='invalid_request'?response(400,{ok:false,reason:'invalid_request'}):bad();
   return response(200,result);
  }catch {
   // Do not leak privileged query errors, host identity, lease token details,
   // or raw provider diagnostics to an untrusted remote caller.
   return response(503,{ok:false,reason:'service_unavailable'});
  }
 };
}
