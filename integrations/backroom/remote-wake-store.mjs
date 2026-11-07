/**
 * Unprivileged local Backroom-to-hosted-server queue transport.
 * This module never accepts or contains a Supabase service-role key.
 * Host token must come from private host pairing storage, not UI code.
 */
const HEX64=/^[0-9a-f]{64}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkScope({hostId,sessionDigest,bindingId}={}){
 if(!UUID.test(hostId??'')||!UUID.test(bindingId??'')||!HEX64.test(sessionDigest??''))
  throw new TypeError('Invalid remote wake scope');
 return {hostId,sessionDigest,bindingId};
}
export function createRemoteWakeStore({baseUrl,hostToken,apiKey,fetchImpl=fetch,verifyLocalGrant}={}){
 if(typeof baseUrl!=='string')throw new TypeError('Hosted wake gateway URL required');
 let url;
 try{url=new URL(baseUrl);}catch{throw new TypeError('Invalid hosted wake gateway URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
    !['/','/functions/v1/backroom-wake/'].includes(url.pathname)||!url.hostname)throw new TypeError('Exact HTTPS gateway origin required');
 if(typeof hostToken!=='string'||!HEX64.test(hostToken))throw new TypeError('Private 256-bit host token required');
 if(apiKey!==undefined&&(typeof apiKey!=='string'||apiKey.length<20||apiKey.length>4096||!/^[A-Za-z0-9._-]+$/.test(apiKey)))
  throw new TypeError('Invalid public Supabase project API key');
 if(typeof fetchImpl!=='function')throw new TypeError('Fetch transport required');
 const token=hostToken;
 async function post(endpoint,body){
  const response=await fetchImpl(new URL(url.pathname==='/'?'/v1/backroom/wake/'+endpoint:endpoint,url).href,{
   method:'POST',redirect:'error',credentials:'omit',cache:'no-store',
   signal:AbortSignal.timeout(15000),
   headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json',...(apiKey?{'apikey':apiKey}:{})},
   body:JSON.stringify(body),
  });
  if(!response||response.status!==200||!response.ok){
   const error=new Error('Remote Backroom queue unavailable or unauthorized');
   error.status=response?.status??0;
   error.code=response?.status===401||response?.status===403?
    'REMOTE_BACKROOM_UNAUTHORIZED':'REMOTE_BACKROOM_QUEUE_FAILURE';
   throw error;
  }
  const result=await response.json();
  if(!result||result.ok!==true)throw new Error('Invalid remote wake response');
  return result;
 }
 return Object.freeze({
  async activate({hostId,sessionDigest,bindingId,grantId,ttlSeconds}={}){
   const scope=checkScope({hostId,sessionDigest,bindingId});
   if(!UUID.test(grantId??'')||!Number.isSafeInteger(ttlSeconds)||ttlSeconds<60||ttlSeconds>86400)
    throw new TypeError('Invalid local wake grant');
   if(typeof verifyLocalGrant!=='function')throw new Error('Trusted local grant verifier required');
   let verified=false;
   try{verified=(await verifyLocalGrant(Object.freeze({...scope,grantId,ttlSeconds})))===true;}catch{verified=false;}
   if(!verified)throw new Error('Local wake grant not verified');
   const result=await post('activate',{...scope,grantId,ttlSeconds});
   if(typeof result.activated!=='boolean')throw new Error('Invalid wake activation result');
   return result.activated;
  },
  async deactivate({hostId,sessionDigest,bindingId,grantId}={}){
   const scope=checkScope({hostId,sessionDigest,bindingId});
   if(!UUID.test(grantId??''))throw new TypeError('Invalid remote wake grant ID');
   const result=await post('deactivate',{...scope,grantId});
   if(typeof result.deactivated!=='boolean')throw new Error('Invalid remote wake deactivation result');
   return result.deactivated;
  },
  async claim({hostId,sessionDigest,bindingId,limit=5}={}){
   const scope=checkScope({hostId,sessionDigest,bindingId});
   if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new RangeError('Invalid remote claim limit');
   const result=await post('claim',{...scope,limit});
   if(!Array.isArray(result.leases)||result.leases.length>limit)throw new Error('Invalid remote lease batch');
   return result.leases.map(lease=>{
    if(!lease||lease.hostId!==hostId||lease.sessionDigest!==sessionDigest||lease.bindingId!==bindingId)
     throw new Error('Cross-scope remote lease rejected');
    const providerDigest=lease.providerConversationIdentityDigest;
    if(providerDigest!==undefined&&providerDigest!==null&&
      (typeof providerDigest!=='string'||! /^[a-f0-9]{64}$/.test(providerDigest)))
     throw new Error('Invalid remote provider-conversation identity digest');
    return Object.freeze(lease);
   });
  },
  async acknowledge({hostId,sessionDigest,bindingId,jobId,leaseToken,outcome='acknowledged'}={}){
   const scope=checkScope({hostId,sessionDigest,bindingId});
   if(!UUID.test(jobId??'')||!UUID.test(leaseToken??'')||!['acknowledged','ignored'].includes(outcome))
    throw new TypeError('Invalid remote acknowledgment');
   const result=await post('ack',{...scope,jobId,leaseToken,outcome});
   if(typeof result.accepted!=='boolean')throw new Error('Invalid remote acknowledgement result');
   return result.accepted;
  },
  async retry({hostId,sessionDigest,bindingId,jobId,leaseToken,retryAfterSeconds=5,errorCode='other'}={}){
   const scope=checkScope({hostId,sessionDigest,bindingId});
   if(!UUID.test(jobId??'')||!UUID.test(leaseToken??'')||
     !Number.isSafeInteger(retryAfterSeconds)||retryAfterSeconds<1||retryAfterSeconds>300||
     !['target_unavailable','approval_required','provider_busy','transport_error','result_unconfirmed','authorization_denied','other'].includes(errorCode))
    throw new TypeError('Invalid remote retry');
   const result=await post('retry',{...scope,jobId,leaseToken,retryAfterSeconds,errorCode});
   if(!['pending','failed'].includes(result.state))throw new Error('Invalid remote retry state');
   return result.state;
  }
 });
}
