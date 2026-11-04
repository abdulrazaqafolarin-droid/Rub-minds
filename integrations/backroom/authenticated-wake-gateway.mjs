/**
 * Trusted, server-side authenticated RPC boundary for a paired remote Backroom host.
 * Use only behind HTTPS. The service-role Supabase client and host credential digest
 * must NEVER be exposed in a browser, CLI response, or local device bundle.
 *
 * register/revoke and user login are deliberately separate operations: this adapter
 * authorizes an existing provisioned, unrevoked host + binding.
 */
import {createHash,timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST=/^[0-9a-f]{64}$/;
const TOKEN=/^[0-9a-f]{64}$/;
const WAKE_ERROR_CODES=new Set(['target_unavailable','approval_required','provider_busy','transport_error','result_unconfirmed','authorization_denied','other']);
const invalidRequest=()=>Object.freeze({ok:false,reason:'invalid_request'});
const sha256 = v => createHash('sha256').update(v,'utf8').digest('hex');

/**
 * The factory intentionally accepts optional properties so malformed setup is
 * rejected by the runtime guards below, while callers receive a real typed
 * contract from Deno/TypeScript rather than an inferred `now`-only options
 * shape (which silently hid required gateway dependencies).
 *
 * @typedef {{hostId:string,ownerId:string,credentialDigest:string,expiresAt:string,revokedAt?:string|null}} WakeHostRecord
 * @typedef {{bindingId:string,hostId:string,ownerId:string,sessionDigest:string,providerConversationIdentityDigest?:string|null,revokedAt?:string|null,wakeEnabled?:boolean,confirmedAt?:string|null,wakeExpiresAt?:string|null}} WakeBindingRecord
 * @typedef {{claim:(input:any)=>Promise<any>,acknowledge:(input:any)=>Promise<any>,retry:(input:any)=>Promise<any>}} WakeQueueStore
 * @typedef {{lookupHost:(hostId:string)=>Promise<WakeHostRecord|null>,lookupBinding:(bindingId:string)=>Promise<WakeBindingRecord|null>,store:WakeQueueStore,activateBinding?:(input:any)=>Promise<any>,deactivateBinding?:(input:any)=>Promise<any>,now?:()=>number}} WakeGatewayFactoryOptions
 * @param {Partial<WakeGatewayFactoryOptions>} [options]
 */
export function createAuthenticatedWakeGateway({lookupHost,lookupBinding,store,activateBinding,deactivateBinding,now=()=>Date.now()}={}) {
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
    const providerConversationIdentityDigest=binding.providerConversationIdentityDigest??null;
    if(providerConversationIdentityDigest!==null&&!DIGEST.test(providerConversationIdentityDigest))return null;
    return Object.freeze({hostId,sessionDigest,bindingId,providerConversationIdentityDigest});
  }
  return Object.freeze({
    // Only an authenticated *host*, never a user browser, may activate a
    // previously registered inactive binding after checking a local wake grant.
    async activate(input) {
      if(typeof activateBinding!=='function')return Object.freeze({ok:false,reason:'unauthorized'});
      const scope=await authorize(input??{},false);
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      if(!UUID.test(input.grantId??'')||!Number.isSafeInteger(input.ttlSeconds)||
         input.ttlSeconds<60||input.ttlSeconds>86400)return invalidRequest();
      const {providerConversationIdentityDigest: _providerDigest,...hostScope}=scope;
      return Object.freeze({ok:true,activated:await activateBinding({...hostScope,grantId:input.grantId,ttlSeconds:input.ttlSeconds})});
    },
    async deactivate(input) {
      if(typeof deactivateBinding!=='function')return Object.freeze({ok:false,reason:'unauthorized'});
      const scope=await authorize(input??{},false);
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      if(!UUID.test(input.grantId??''))return invalidRequest();
      const {providerConversationIdentityDigest: _providerDigest,...hostScope}=scope;
      return Object.freeze({ok:true,deactivated:await deactivateBinding({...hostScope,grantId:input.grantId})});
    },
    // Returns an explicit denied status but never reveals whether a host, token or binding exists.
    async claim(input) {
      const scope=await authorize(input??{});
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      const limit=input.limit??5;
      if(!Number.isSafeInteger(limit)||limit<1||limit>20)return invalidRequest();
      const leases=await store.claim({...scope,limit});
      if(!Array.isArray(leases)||leases.length>limit)throw new Error('Invalid private wake lease batch');
      for(const lease of leases){
        if(!lease||lease.hostId!==scope.hostId||lease.sessionDigest!==scope.sessionDigest||
           lease.bindingId!==scope.bindingId||
           (lease.providerConversationIdentityDigest??null)!==scope.providerConversationIdentityDigest){
          throw new Error('Claimed wake lease does not match the authenticated input binding');
        }
      }
      return Object.freeze({ok:true,leases:Object.freeze(leases)});
    },
    async acknowledge(input) {
      const scope=await authorize(input??{});
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      if(!UUID.test(input.jobId??'')||!UUID.test(input.leaseToken??'')||
         !['acknowledged','ignored'].includes(input.outcome))return invalidRequest();
      const {providerConversationIdentityDigest: _providerDigest,...hostScope}=scope;
      return Object.freeze({ok:true,accepted:await store.acknowledge({...hostScope,jobId:input.jobId,leaseToken:input.leaseToken,outcome:input.outcome})});
    },
    async retry(input) {
      const scope=await authorize(input??{});
      if(!scope)return Object.freeze({ok:false,reason:'unauthorized'});
      const errorCode=input.errorCode??'other';
      if(!UUID.test(input.jobId??'')||!UUID.test(input.leaseToken??'')||
         !Number.isSafeInteger(input.retryAfterSeconds)||input.retryAfterSeconds<1||input.retryAfterSeconds>300||
         !WAKE_ERROR_CODES.has(errorCode))return invalidRequest();
      const {providerConversationIdentityDigest: _providerDigest,...hostScope}=scope;
      return Object.freeze({ok:true,state:await store.retry({...hostScope,jobId:input.jobId,leaseToken:input.leaseToken,
        retryAfterSeconds:input.retryAfterSeconds,errorCode})});
    }
  });
}
