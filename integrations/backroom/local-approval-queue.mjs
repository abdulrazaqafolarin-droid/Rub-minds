/**
 * Serializes trusted-console decisions so concurrent workspace requests cannot
 * open multiple readline interfaces against the same stdin at once.
 *
 * Rejection is returned to its caller but absorbed in the internal tail so a
 * cancelled/failed prompt never permanently blocks future approvals.
 */
export function createSerializedLocalApproval(authorize){
  if(typeof authorize!=='function')throw new TypeError('Trusted local authorizer function required');
  let tail=Promise.resolve();
  return function authorizeSerially(action){
    const current=tail.then(()=>authorize(action),()=>authorize(action));
    tail=current.then(()=>undefined,()=>undefined);
    return current;
  };
}
