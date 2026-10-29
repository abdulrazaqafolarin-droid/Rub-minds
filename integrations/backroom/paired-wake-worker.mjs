/**
 * One bounded pass of the paired Backroom host worker.
 * Trusted host process only. The Supabase RPC client must remain server-side;
 * a remote transport must authenticate the host BEFORE giving this worker a lease.
 * No timers, credentials, or standing grants are hidden in this module.
 */
import {dispatchClaimedWake} from './durable-wake-runtime.mjs';

export async function pollPairedWakeJobs({
  store,hostId,sessionDigest,bindingId,limit=5,
  resolveContext,dispatcher,verifyApproval
}={}) {
  if (!store || typeof store.claim!=='function' || typeof store.acknowledge!=='function' || typeof store.retry!=='function')
    throw new TypeError('Private durable wake store required');
  if (typeof resolveContext!=='function') throw new TypeError('Trusted binding resolver required');
  if (typeof verifyApproval!=='function') throw new TypeError('Non-consuming wake-grant verifier required');
  if (!dispatcher || typeof dispatcher.enqueue!=='function' || typeof dispatcher.step!=='function' || typeof dispatcher.status!=='function')
    throw new TypeError('Dispatcher required');
  if (!Number.isInteger(limit) || limit<1 || limit>20) throw new RangeError('Invalid poll limit');
  // Claims and acknowledgment remain scoped by host, hosted MCP session and binding.
  const leases=await store.claim({hostId,sessionDigest,bindingId,limit});
  if (!Array.isArray(leases) || leases.length>limit) throw new Error('Invalid lease batch');
  const results=[];
  for (const lease of leases) {
    if (lease.hostId!==hostId || lease.sessionDigest!==sessionDigest || lease.bindingId!==bindingId) {
      // Do not ack a lease that has crossed an identity boundary.
      results.push(Object.freeze({jobId:lease.jobId,state:'rejected',reason:'claim-scope-mismatch'}));
      continue;
    }
    let context;
    try {
      context=await resolveContext(Object.freeze({hostId,sessionDigest,bindingId,lease}));
    } catch {
      // Resolution failure is not permission to act. A bounded retry is safe
      // because no composer or dispatcher side effect has happened.
      context=null;
    }
    if (!context || !context.approval || !context.targetRegistry || !context.binding || !context.participant) {
      const result=await dispatchClaimedWake({
        lease,store,dispatcher,approval:null,verifyApproval
      });
      results.push(Object.freeze({jobId:lease.jobId,...result}));
      continue;
    }
    const result=await dispatchClaimedWake({
      lease,store,dispatcher,verifyApproval,
      hostId,sessionDigest,approval:context.approval,
      targetRegistry:context.targetRegistry,binding:context.binding,
      participant:context.participant,composerEmpty:context.composerEmpty,
      foregroundSessionId:context.foregroundSessionId
    });
    results.push(Object.freeze({jobId:lease.jobId,...result}));
  }
  return Object.freeze(results);
}
