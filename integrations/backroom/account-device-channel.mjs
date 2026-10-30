/**
 * Validated outbound device connection lifecycle, independent of transport.
 * Transport must use TLS and verified Supabase user authentication.
 * This does not treat matching user IDs as authentication: the verifier
 * must validate the JWT against the auth server on every connection.
 */
import { randomUUID } from 'node:crypto';

const IDENTIFIER=/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/;
const TYPES=new Set(['launch','view','control','draft','close','ping']);
function validId(x){return typeof x==='string'&&IDENTIFIER.test(x)}
export function createAccountDeviceChannel({
  verifyAccessToken, connectTransport, onRequest,
  now=()=>Date.now(), maxRequestAgeMs=30_000,
}={}){
  if(![verifyAccessToken,connectTransport,onRequest,now].every(f=>typeof f==='function'))
    throw new TypeError('Authenticated transport and handler required');
  if(!Number.isSafeInteger(maxRequestAgeMs)||maxRequestAgeMs<1000||maxRequestAgeMs>120_000)
    throw new TypeError('Invalid request timeout');
  let current=null, closed=false;
  const seen=new Map();
  function disconnected(){
    current=null;
    seen.clear();
  }
  async function open({accessToken,deviceId}={}){
    if(closed)throw new Error('Channel stopped');
    if(current)throw new Error('Device already connected');
    if(!validId(deviceId)||typeof accessToken!=='string'||accessToken.length<20)
      throw new Error('Invalid identity');
    const verified=await verifyAccessToken(accessToken);
    // A caller-supplied user id is never trusted. It must come from JWT verification.
    if(!verified||!validId(verified.userId)||verified.deviceId!==deviceId||verified.revoked===true)
      throw new Error('Device identity not authorized');
    const nonce=randomUUID();
    const link=await connectTransport({accessToken,deviceId,nonce});
    if(!link||typeof link.send!=='function'||typeof link.close!=='function')
      throw new Error('Secure device transport unavailable');
    current={link,deviceId,userId:verified.userId,nonce};
    return Object.freeze({connected:true,deviceId,userId:verified.userId});
  }
  async function receive(message){
    if(closed||!current)throw new Error('Device disconnected');
    if(!message||typeof message!=='object'||Array.isArray(message))
      throw new Error('Invalid request');
    const {id,type,deviceId,issuedAt,payload}=message;
    if(!validId(id)||!TYPES.has(type)||deviceId!==current.deviceId||
       !Number.isSafeInteger(issuedAt)||Math.abs(now()-issuedAt)>maxRequestAgeMs)
      throw new Error('Invalid or stale request');
    if(seen.has(id))throw new Error('Duplicate request');
    // Bound cache growth; aged request identifiers are removed on disconnect.
    if(seen.size>=1024)throw new Error('Request limit reached: reconnect required');
    seen.set(id,issuedAt);
    // The native handler receives NO trustedLocalDecision, userId or grant via
    // the network envelope. Ignore all such fields even if an attacker sends them.
    const allowedPayload=(payload && typeof payload==='object' && !Array.isArray(payload))
      ? Object.fromEntries(Object.entries(payload).filter(([key])=>![
        'trustedLocalDecision','approved','accessToken','refreshToken','userId','deviceId'
      ].includes(key))) : {};
    const result=await onRequest(Object.freeze({
      id,type,deviceId:current.deviceId,userId:current.userId,
      payload:Object.freeze(allowedPayload),
    }));
    // The transport only acknowledges receipt and outcome; no secrets included.
    current?.link.send({id,type:'result',success:true,result});
    return result;
  }
  return Object.freeze({
    open,receive,
    disconnect(){
      if(current)current.link.close();
      disconnected();
    },
    stop(){
      if(current)current.link.close();
      disconnected();closed=true;
    },
    get status(){return Object.freeze({connected:!!current,deviceId:current?.deviceId||null,closed});},
  });
}
