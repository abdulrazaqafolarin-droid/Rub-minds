/** Sends ONLY the fixed @RMconnects protocol to a user-selected AI web composer.
 * This is intentionally separate from BrowserDraftAdapter: no arbitrary text is accepted.
 * User consent is checked by WakeAuthorizationAuthority + LocalExecutionGuard upstream.
 */
import {createHash} from 'node:crypto';
import {isCanonicalWakePrompt} from './coordination-core.mjs';
const DEFAULT_ALLOWED_ORIGINS=new Set([
 'https://claude.ai','https://claude.com','https://chatgpt.com','https://chat.openai.com',
]);
const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
export class BrowserCanonicalWakeAdapter {
 constructor({page,origin,path,search='',hash='',selector,verificationSelector=selector,appId,sessionId,identityFingerprint,nodeHandle=null,allowedOrigins=[...DEFAULT_ALLOWED_ORIGINS]}={}){
  if(!page||typeof page.url!=='function'||typeof page.locator!=='function')throw new TypeError('Playwright page required');
  if([origin,path,selector,appId,sessionId,identityFingerprint].some(v=>typeof v!=='string'||!v))throw new TypeError('wake target binding incomplete');
  const parsed=new URL(origin);
  if(parsed.protocol!=='https:'||parsed.origin!==origin||!path.startsWith('/')||!Array.isArray(allowedOrigins)||!allowedOrigins.includes(origin))throw new TypeError('provider origin is not approved for canonical wake');
  if(nodeHandle!==null&&(!nodeHandle||typeof nodeHandle.evaluate!=='function'))throw new TypeError('exact DOM element handle required');
  if(typeof verificationSelector!=='string'||!verificationSelector)throw new TypeError('composer verification selector required');
  Object.assign(this,{page,origin,path,search,hash,selector,verificationSelector,appId,sessionId,identityFingerprint,nodeHandle,allowedOrigins:new Set(allowedOrigins)});
 }
 async #field(){
  if(this.page.isClosed?.())throw new Error('page closed');
  const u=new URL(this.page.url());
  if(u.origin!==this.origin||u.pathname!==this.path||u.search!==this.search||u.hash!==this.hash)throw new Error('conversation changed');
  const field=this.page.locator(this.selector);
  if(await field.count()!==1||!(await field.isVisible())||!(await field.isEnabled()))throw new Error('composer unavailable');
  if(this.nodeHandle){
   const exact=await this.nodeHandle.evaluate((node,selector)=>{
    if(!(node instanceof HTMLElement)||!node.isConnected||!node.matches(selector))return false;
    try{const found=document.querySelectorAll(selector);return found.length===1&&found[0]===node;}catch{return false;}
   },this.selector).catch(()=>false);
   if(!exact)throw new Error('selected composer was replaced');
  }
  return field;
 }
 async #read(field){
  if(this.nodeHandle)return this.nodeHandle.evaluate(node=>node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement?node.value:node instanceof HTMLElement&&node.isContentEditable?(node.textContent??''):null);
  try{return await field.inputValue();}catch{return await field.textContent();}
 }
 async probe({target,operation}={}){
  if(operation!=='wake'||target?.surface!=='browser_tab'||target.locatorKind!=='dom'||target.locatorValue!==this.selector||
   target.appId!==this.appId||target.sessionId!==this.sessionId||target.identityFingerprint!==this.identityFingerprint)return {connected:false,focused:false};
  try{
   const field=await this.#field();
   if(await this.#read(field)!=='')return {connected:false,focused:false,reason:'composer_occupied'};
   const ready=await (this.nodeHandle??field).evaluate(node=>{
    if(!(node instanceof HTMLElement)||!node.isConnected)return false;
    const form=node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement?node.form:node.closest('form');
    if(!form)return false;
    const candidates=[...form.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(button=>{
      const style=getComputedStyle(button),rect=button.getBoundingClientRect();
      if(!button.isConnected||button.disabled||button.getAttribute('aria-disabled')==='true'||
        style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||rect.width<=0||rect.height<=0)return false;
      const label=[button.getAttribute('aria-label'),button.getAttribute('title'),button.getAttribute('data-testid'),button.textContent].filter(Boolean).join(' ').trim();
      return /(^|[\s_-])(send|submit|reply)([\s_-]|$)/i.test(label);
    });
    return candidates.length===1;
   });
   return ready?{connected:true,focused:true,appId:this.appId,sessionId:this.sessionId,identityFingerprint:this.identityFingerprint,surface:'browser_tab',locatorKinds:['dom']}:{connected:false,focused:false,reason:'unique_send_control_unavailable'};
  }catch{return {connected:false,focused:false};}
 }
 async execute({command,target}={}){
  if(command?.operation!=='wake'||target?.surface!=='browser_tab'||target.locatorKind!=='dom'||
   target.locatorValue!==this.selector||target.appId!==this.appId||target.sessionId!==this.sessionId||
   target.identityFingerprint!==this.identityFingerprint||!isCanonicalWakePrompt(command.text,command.eventId)){
   throw new Error('Only the canonical, event-bound @RMconnects wake operation is permitted');
  }
  const field=await this.#field();
  const request={text:command.text,origin:this.origin,path:this.path,search:this.search,hash:this.hash,
   selector:this.selector,bindingMarker:/\[data-rm-backroom-binding="([a-f0-9-]{36})"\]$/i.exec(this.selector)?.[1]??null};
  const performWake=async(element,expected)=>{
   const identity=()=>{
    const u=window.location;
    if(u.origin!==expected.origin||u.pathname!==expected.path||u.search!==expected.search||u.hash!==expected.hash)return 'conversation_changed';
    if(!(element instanceof HTMLElement)||!element.isConnected||!element.matches(expected.selector)||
      (expected.bindingMarker&&element.getAttribute('data-rm-backroom-binding')!==expected.bindingMarker)||
      element.closest('[aria-hidden="true"],[inert],[hidden]')||('disabled'in element&&element.disabled)||
      element.matches(':disabled')||('readOnly'in element&&element.readOnly)||element.getAttribute('aria-disabled')==='true'||
      element.getAttribute('aria-readonly')==='true')return 'composer_unavailable';
    if(element instanceof HTMLInputElement&&!['text','search','url','tel','email'].includes(element.type))return 'composer_unavailable';
    if(!(element instanceof HTMLInputElement)&&!(element instanceof HTMLTextAreaElement)&&!element.isContentEditable)return 'composer_unavailable';
    try{const found=document.querySelectorAll(expected.selector);if(found.length!==1||found[0]!==element)return 'composer_replaced';}catch{return 'composer_unavailable';}
    const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
    if(rect.width<=8||rect.height<=8||style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return 'composer_unavailable';
    return 'valid';
   };
   const read=()=>element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement?element.value:element instanceof HTMLElement&&element.isContentEditable?(element.textContent??''):null;
   if(identity()!=='valid')return {state:identity(),submitted:false};
   if(read()===null)return {state:'composer_unavailable',submitted:false};
   if(read()!=='')return {state:'composer_occupied',submitted:false};
   const form=element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement?element.form:element.closest('form');
   if(!form)return {state:'submit_control_unavailable',submitted:false};
   const findButton=()=>{
    const found=[...form.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(button=>{
     const style=getComputedStyle(button),rect=button.getBoundingClientRect();
     if(!button.isConnected||button.disabled||button.getAttribute('aria-disabled')==='true'||style.display==='none'||
       style.visibility!=='visible'||Number(style.opacity)===0||rect.width<=0||rect.height<=0)return false;
     const label=[button.getAttribute('aria-label'),button.getAttribute('title'),button.getAttribute('data-testid'),button.textContent].filter(Boolean).join(' ').trim();
     return /(^|[\s_-])(send|submit|reply)([\s_-]|$)/i.test(label);
    });
    return found.length===1?found[0]:null;
   };
   const button=findButton();if(!button)return {state:'submit_control_unavailable',submitted:false};
   element.focus({preventScroll:true});
   if(element instanceof HTMLInputElement)Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set?.call(element,expected.text);
   else if(element instanceof HTMLTextAreaElement)Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set?.call(element,expected.text);
   else{
    const selection=window.getSelection();if(!selection)return {state:'composer_unavailable',submitted:false};
    const range=document.createRange();range.selectNodeContents(element);range.collapse(false);
    selection.removeAllRanges();selection.addRange(range);
    if(!document.execCommand('insertText',false,expected.text))return {state:'insert_unverified',submitted:false};
   }
   if(!(element instanceof HTMLElement)||!element.isConnected)return {state:'insert_unverified',submitted:false};
   if(!element.isContentEditable){
    element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:expected.text}));
    element.dispatchEvent(new Event('change',{bubbles:true}));
   }
   await Promise.resolve();
   if(identity()!=='valid'||read()!==expected.text||findButton()!==button||button.disabled)return {state:'insert_unverified',submitted:false};
   // A click is allowed only for this provider's unique submit control in the same form.
   button.click();
   return {state:'submitted_pending_confirmation',submitted:true};
  };
  const outcome=await (this.nodeHandle??field).evaluate(performWake,request);
  if(outcome?.state==='conversation_changed'||outcome?.state==='composer_occupied'||outcome?.state==='composer_unavailable'||outcome?.state==='composer_replaced'||outcome?.state==='submit_control_unavailable'){
   const error=new Error('Canonical wake refused before send: '+outcome.state);error.code='BACKROOM_PREFLIGHT';throw error;
  }
  if(outcome?.state!=='submitted_pending_confirmation'||outcome.submitted!==true){
   return {state:'needs_review',verified:false,result:{submitted:outcome?.submitted===true,reason:outcome?.state??'unknown'}};
  }
  // Provider submit handlers are asynchronous; never infer acceptance from an immediate DOM read.
  // Wait for the exact conversation's unique composer to clear, but do not re-send on timeout.
  try {
   await this.page.waitForFunction(expected=>{
    const u=window.location;
    if(u.origin!==expected.origin||u.pathname!==expected.path||u.search!==expected.search||u.hash!==expected.hash)return false;
    try{
     const fields=document.querySelectorAll(expected.selector);
     if(fields.length!==1)return false;
     const el=fields[0];
     if(!(el instanceof HTMLElement)||!el.isConnected||el.closest('[aria-hidden="true"],[inert],[hidden]')||
       ('disabled'in el&&el.disabled)||el.getAttribute('aria-disabled')==='true')return false;
     const text=el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement?el.value:
       el.isContentEditable?(el.textContent??''):null;
     return text==='';
    }catch{return false;}
   },{origin:this.origin,path:this.path,search:this.search,hash:this.hash,selector:this.verificationSelector},{timeout:8000});
  } catch {
   return {state:'needs_review',verified:false,result:{submitted:true,reason:'composer-clear-unconfirmed'}};
  }
  return {state:'completed',verified:true,result:{triggerSubmitted:true,submitted:true,confirmation:'composer-cleared',eventId:command.eventId,textSha256:sha256(command.text)}};
 }
}
