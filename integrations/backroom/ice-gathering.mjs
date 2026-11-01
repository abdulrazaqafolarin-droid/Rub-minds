/**
 * Wait for ICE gathering to complete so the SDP contains its candidate set.
 * This avoids one Edge Function invocation per browser ICE candidate.
 * It is not a connectivity check: the peer can still fail on restrictive NAT.
 */
export function waitForIceGatheringComplete(peer,{timeoutMs=12_000}={}){
 if(!peer||typeof peer.iceGatheringState!=='string'||
    typeof peer.addEventListener!=='function'||typeof peer.removeEventListener!=='function'||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30_000)
  return Promise.reject(new TypeError('Invalid ICE peer or timeout'));
 if(peer.iceGatheringState==='complete')return Promise.resolve();
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error)=>{
   if(settled)return;settled=true;
   clearTimeout(timer);
   peer.removeEventListener('icegatheringstatechange',check);
   if(error)reject(error);else resolve();
  };
  const check=()=>{
   if(peer.iceGatheringState==='complete')finish();
  };
  const timer=setTimeout(()=>finish(new Error('ICE gathering did not complete before the timeout. Check STUN/network access and try again.')),timeoutMs);
  peer.addEventListener('icegatheringstatechange',check);
  check();
 });
}
