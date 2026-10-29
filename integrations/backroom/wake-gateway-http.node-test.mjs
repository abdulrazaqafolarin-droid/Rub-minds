import test from 'node:test';
import assert from 'node:assert/strict';
import {createWakeGatewayHttpHandler} from './wake-gateway-http.mjs';
const token='b'.repeat(64);
const path='https://example.test/v1/backroom/wake/claim';
const valid={hostId:'40000000-0000-4000-8000-000000000011',sessionDigest:'a'.repeat(64),bindingId:'40000000-0000-4000-8000-000000000022',limit:2};
const request=(url=path,{body=valid,authorization='Bearer '+token,headers={},method='POST'}={})=>new Request(url,{
 method,headers:{'Content-Type':'application/json',Authorization:authorization,...headers},
 ...(method==='POST'?{body:JSON.stringify(body)}:{})
});
function fixture() {
 const calls=[];
 const gateway={claim:async input=>{calls.push(['claim',input]);return {ok:true,leases:[]};},
  acknowledge:async input=>{calls.push(['ack',input]);return {ok:true,accepted:true};},
  retry:async input=>{calls.push(['retry',input]);return {ok:true,state:'pending'};}
 };
 return {handler:createWakeGatewayHttpHandler({gateway}),calls};
}
test('HTTPS-only authenticated claim uses bearer token, no caching or CORS',async()=>{
 const {handler,calls}=fixture();
 const out=await handler(request());assert.equal(out.status,200);
 assert.equal(out.headers.get('cache-control'),'no-store, max-age=0');
 assert.equal(out.headers.get('access-control-allow-origin'),null);
 assert.deepEqual(await out.json(),{ok:true,leases:[]});
 assert.equal(calls[0][1].hostToken,token);
 assert.equal(calls[0][1].limit,2);
});
test('invalid origins, cookies, methods, paths, queries and tokens never reach gateway',async()=>{
 const {handler,calls}=fixture();
 const attempts=[
  request('http://example.test/v1/backroom/wake/claim'),
  request(path+'?token=leak'),
  request('https://example.test/v1/backroom/wake/unknown'),
  request(path,{headers:{Origin:'https://evil.test'}}),
  request(path,{headers:{Cookie:'session=abc'}}),
  request(path,{authorization:'Bearer garbage'}),
  request(path,{body:{...valid,serviceRoleKey:'secret'}}),
 ];
 for(const req of attempts){const out=await handler(req);assert.notEqual(out.status,200);}
 assert.equal(calls.length,0);
});
test('ack and retry preserve separate authorized operations',async()=>{
 const {handler,calls}=fixture();
 const ack=await handler(request('https://example.test/v1/backroom/wake/ack',{body:{
  hostId:valid.hostId,bindingId:valid.bindingId,sessionDigest:valid.sessionDigest,
  jobId:'id',leaseToken:'lease',outcome:'ignored'}}));
 assert.equal(ack.status,200);
 const retry=await handler(request('https://example.test/v1/backroom/wake/retry',{body:{
  hostId:valid.hostId,bindingId:valid.bindingId,sessionDigest:valid.sessionDigest,
  jobId:'id',leaseToken:'lease',retryAfterSeconds:5,errorCode:'provider_busy'}}));
 assert.equal(retry.status,200);
 assert.deepEqual(calls.map(x=>x[0]),['ack','retry']);
});
test('privileged store exceptions are redacted and unapproved requests are denied',async()=>{
 const handler=createWakeGatewayHttpHandler({gateway:{
  claim:async()=>{throw new Error('sensitive backend SQL details');},
  acknowledge:async()=>({ok:false}),
  retry:async()=>({ok:false})
 }});
 const failed=await handler(request());assert.equal(failed.status,503);
 assert.doesNotMatch(await failed.text(),/sensitive|SQL/);
 const denied=await handler(request('https://example.test/v1/backroom/wake/ack'));
 assert.equal(denied.status,401);
});
