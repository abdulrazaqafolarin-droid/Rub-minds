/**
 * Trusted, server-side authenticated RPC boundary for a paired remote Backroom host.
 * Use only behind HTTPS. The service-role Supabase client and host credential digest
 * must NEVER be exposed in a browser, CLI response, or local device bundle.
 *
 * register/revoke and user login are deliberately separate operations: this adapter
 * authorizes an existing provisioned, unrevoked host + binding.
 */
import {createHash,timingSafeEqual} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST=/^[0-9a-f]{64}$/;
const TOKEN=/^[0-9a-f]{64}$/;
const sha256 = v => createHash('sha256').update(v,'utf8').digest('hex');

export function createAuthenticatedWakeGateway({lookupHost,lookupBinding,store,activateBinding,now=()=>Date.now()}={}) {
  if(typeof lookupHost!=='function'||typeof lookupBinding!=='function')throw new TypeError('Trusted host and binding lookups required');
  if(!store||typeof store.claim!=='function'||typeof store.acknowledge!=='function'||typeof store.retry!=='function')throw new TypeError('Private durable store required');
  if(typeof now!=='function')throw new TypeError('Clock required');
  async function authorize({hostId,hostToken,sessionDigest,bindingId},requireConsent=true) {
    if(!UUID.test(hostId??'')||!TOKEN.test(hostToken??'')||!DIGEST.test(sessionDigest??'')||!UUID.test(bindingId??''))return null;
    const host=await lookupHost(hostId);
    // No host-controlled owner identity or binding metadata is trusted.
    if(!host||host.hostId!==hostId||!UUID.test(host.ownerId??'')||!DIGEST.test(host.credentialDigest??'')||
       host.revokedAt!=null||!Number.isFinite(Date.parse(host.expiresAt))||Date.parse(host.expiresAt)<=now())return null;
    const supplied=Buffer.from(sha256(hostToken.toLowerCase()),'hex');
    const expected=Buffer.from(host.credentialDigest,'hex');
    if(expected.length!==32||!timingSafeEqual(supplied,expected))return null;
    const binding=await lookupBinding(bindingId);
    if(!binding||binding.bindingId!==bindingId||binding.hostId!==hostId||binding.ownerId!==host.ownerId||
       binding.sessionDigest!==sessionDigest||binding.revokedAt!=null)return null;
    if(requireConsent&&(binding.wakeEnabled!==true||binding.confirmedAt==null||
       !Number.isFinite(Date.parse(binding.wakeExpiresAt))||Date.parse(binding.wakeExpiresAt)<=now()))return null;
    return Object.freeze({hostId,sessionDigest,bindingId});
  }
  return Object.freeze({
    // Only an authenticated *host*, never a user browser, may activate a
    // previously registered inactive binding after checking a local wake grant.
    async activate(input) {
      if(typeof activateBinding!=='function')return Object.freeze({ok:false,reason:'unauthorized'});
      const scope=await authorize(input??{},false);
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      if(!UUID.test(input.grantId??'')||!Number.isSafeInteger(input.ttlSeconds)||
         input.ttlSeconds<60||input.ttlSeconds>900)throw new TypeError('Invalid local consent grant');
      return Object.freeze({ok:true,activated:await activateBinding({...scope,grantId:input.grantId,ttlSeconds:input.ttlSeconds})});
    },
    // Returns an explicit denied status but never reveals whether a host, token or binding exists.
    async claim(input) {
      const scope=await authorize(input??{});
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      const limit=input.limit??5;
      if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new RangeError('Invalid claim limit');
      return Object.freeze({ok:true,leases:await store.claim({...scope,limit})});
    },
    async acknowledge(input) {
      const scope=await authorize(input??{});
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      return Object.freeze({ok:true,accepted:await store.acknowledge({...scope,jobId:input.jobId,leaseToken:input.leaseToken,outcome:input.outcome})});
    },
    async retry(input) {
      const scope=await authorize(input??{});
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      return Object.freeze({ok:true,state:await store.retry({...scope,jobId:input.jobId,leaseToken:input.leaseToken,
        retryAfterSeconds:input.retryAfterSeconds,errorCode:input.errorCode})});
    }
  });
}
