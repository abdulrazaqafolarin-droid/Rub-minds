import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCanonicalWakePrompt} from './coordination-core.mjs';
import {BrowserCanonicalWakeAdapter} from './browser-wake-adapter.mjs';
const eventId='event-1',prompt=buildCanonicalWakePrompt(eventId);
const pageUrl='https://chatgpt.com/c/test-chat';
const assistantSelector='[data-message-author-role="assistant"]';
const generatingSelector='button[data-testid="stop-button"],button[aria-label*="Stop generating"],button[aria-label*="Stop response"]';
const target={id:'target-1',roomId:'group-1',hostId:'host-1',spaceId:'browser:page-1',sessionId:'page-1',appId:'https://chatgpt.com',identityFingerprint:pageUrl+':page-1',surface:'browser_tab',locatorKind:'dom',locatorValue:'[role=textbox]',revision:1};
function fixture(options={}){
 let submitted=0,text='',currentUrl=options.url??pageUrl;
 const beforeCount=options.baselineAssistantCount??2;
 let responseCount=beforeCount,responseText='';
 let generating=options.generating===true;
 const handle={evaluate:async(fn,arg)=>{
  const src=String(fn);
  if(src.includes('const identity=()=>')){
   if(options.result)return options.result;
   if(options.occupied||text!=='')return {state:'composer_occupied',submitted:false};
   if(options.ambiguous){submitted++;return {state:'send_unconfirmed',submitted:true};}
   submitted++;text='';
   if(!options.noAssistantResponse){
    responseCount=beforeCount+1;
    responseText=options.responseText??'The task is complete.';
   }
   if(options.switchConversationAfterSend)currentUrl='https://chatgpt.com/c/another-chat';
   return {state:'submitted_pending_confirmation',submitted:true};
  }
  if(src.includes('const form=node instanceof'))return options.ready!==false;
  return true;
 },dispose:async()=>{}};
 const field={count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,inputValue:async()=>text,evaluate:async(fn,arg)=>handle.evaluate(fn,arg)};
 const assistant={
  count:async()=>responseCount,
  nth:index=>({isVisible:async()=>index<responseCount,innerText:async()=>responseText}),
 };
 const generatingControls={count:async()=>generating?1:0,nth:()=>({isVisible:async()=>generating})};
 const page={url:()=>currentUrl,isClosed:()=>false,locator:selector=>{
  if(options.responseObserverUnavailable && (selector===assistantSelector||selector===generatingSelector)) {
   return {count:async()=>{throw new Error('provider response observer unavailable');}};
  }
  if(selector===assistantSelector)return assistant;
  if(selector===generatingSelector)return generatingControls;
  return field;
 },waitForFunction:async(fn,arg,opts)=>{
  if(options.confirmation===false)throw new Error('timeout');
  return true;
 }};
 const adapter=new BrowserCanonicalWakeAdapter({
  page,origin:'https://chatgpt.com',path:'/c/test-chat',selector:'[role=textbox]',
  appId:target.appId,sessionId:target.sessionId,identityFingerprint:target.identityFingerprint,
  nodeHandle:handle,responseTimeoutMs:options.responseTimeoutMs??300,
  responseSettleMs:options.responseSettleMs??50,responsePollMs:options.responsePollMs??10
 });
 return {adapter,target,submitted:()=>submitted};
}
test('only exact canonical @RMconnects prompt can submit via one selected provider composer',async()=>{const f=fixture();const result=await f.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:f.target});assert.equal(result.state,'completed');assert.equal(result.result.triggerSubmitted,true);assert.equal(result.result.confirmation,'assistant-response-stable');assert.equal(f.submitted(),1);});
test('arbitrary text and another event payload are refused before UI execution',async()=>{const f=fixture();await assert.rejects(()=>f.adapter.execute({command:{operation:'wake',eventId,text:prompt+' extra'},target:f.target}),/canonical/);assert.equal(f.submitted(),0);});
test('stale URL, occupied composer and ambiguous send fail closed',async()=>{const stale=fixture({url:'https://chatgpt.com/c/another-chat'});await assert.rejects(()=>stale.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:stale.target}),/conversation changed/);const occupied=fixture({occupied:true});await assert.rejects(()=>occupied.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:occupied.target}),/refused before send/);const ambiguous=fixture({ambiguous:true});const result=await ambiguous.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:ambiguous.target});assert.equal(result.state,'needs_review');assert.equal(ambiguous.submitted(),1);});
test('provider origins must be explicitly supported in the runtime config',()=>{assert.throws(()=>new BrowserCanonicalWakeAdapter({page:{url:()=>'',locator:()=>({})},origin:'https://evil.example',path:'/x',selector:'textarea',appId:'evil',sessionId:'s',identityFingerprint:'x'}),/not approved/);});
test('Claude marketing origin is not treated as a conversation-capable wake surface',()=>{
 assert.throws(()=>new BrowserCanonicalWakeAdapter({
  page:{url:()=> 'https://claude.com/chat/123',locator:()=>({})},
  origin:'https://claude.com',path:'/chat/123',selector:'textarea',
  appId:'https://claude.com',sessionId:'s',identityFingerprint:'x',
  allowedOrigins:['https://claude.com']
 }),/provider response evidence is unavailable/);
});

test('composer timeout after click is reported uncertain and never re-sends',async()=>{
 const f=fixture({confirmation:false});
 const result=await f.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:f.target});
 assert.equal(result.state,'needs_review');
 assert.equal(result.result.reason,'composer-clear-unconfirmed');
 assert.equal(f.submitted(),1);
});
test('versioned task-assignment event reaches only the bound composer as its exact canonical wake',async()=>{
 const taskEventId='task_550e8400-e29b-41d4-a716-446655440000_v7';
 const taskPrompt=buildCanonicalWakePrompt(taskEventId);
 const f=fixture();
 const result=await f.adapter.execute({command:{operation:'wake',eventId:taskEventId,text:taskPrompt},target:f.target});
 assert.equal(result.state,'completed');
 assert.equal(result.result.triggerSubmitted,true);
 assert.equal(result.result.eventId,taskEventId);
 assert.equal(f.submitted(),1);
});

test('response observers are preflighted before any one-shot wake effect',async()=>{
 const f=fixture({responseObserverUnavailable:true});
 const result=await f.adapter.probe({target:f.target,operation:'wake'});
 assert.equal(result.connected,false);
 assert.equal(result.focused,false);
 assert.equal(result.reason,'assistant-response-observer-unavailable');
 assert.equal(f.submitted(),0);
});
test('completion waits for a new stable assistant response, not only composer clearing',async()=>{
 const f=fixture({responseText:'The requested work is complete.'});
 const result=await f.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:f.target});
 assert.equal(result.state,'completed');
 assert.equal(result.result.assistantResponseConfirmed,true);
 assert.equal(result.result.confirmation,'assistant-response-stable');
 assert.equal('responseText' in result.result,false);
 assert.equal('responseSha256' in result.result,false);
 assert.equal(f.submitted(),1);
});
test('a composer-clear with no new assistant response remains needs_review and is never resent',async()=>{
 const f=fixture({noAssistantResponse:true,responseTimeoutMs:250});
 const result=await f.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:f.target});
 assert.equal(result.state,'needs_review');
 assert.equal(result.result.confirmation,'composer-cleared');
 assert.equal(result.result.assistantResponseConfirmed,false);
 assert.equal(result.result.reason,'assistant-response-unconfirmed');
 assert.equal(f.submitted(),1);
});
test('an unfinished streaming response cannot be reported as completed',async()=>{
 const f=fixture({generating:true,responseTimeoutMs:250});
 const result=await f.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:f.target});
 assert.equal(result.state,'needs_review');
 assert.equal(result.result.assistantResponseConfirmed,false);
 assert.equal(f.submitted(),1);
});
test('a provider conversation change after composer clear cannot confirm the new response',async()=>{
 const f=fixture({switchConversationAfterSend:true,responseTimeoutMs:250});
 const result=await f.adapter.execute({command:{operation:'wake',eventId,text:prompt},target:f.target});
 assert.equal(result.state,'needs_review');
 assert.equal(result.result.reason,'conversation-changed-before-response');
 assert.equal(f.submitted(),1);
});
