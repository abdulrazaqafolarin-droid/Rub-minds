import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveOwnerFromJwt} from './owner-jwt.mjs';

const ownerId='40000000-0000-4000-8000-000000000011';
const token='eyJ'+'.'.repeat(80);
function request(authorization,body={ownerId:'99999999-9999-4999-8999-999999999999'}){
 return new Request('https://edge.example.test/functions/v1/backroom-config/host',{
  method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{})},
  body:JSON.stringify(body)
 });
}

test('owner identity comes from Supabase getUser, never from the request body',async()=>{
 let receivedToken;
 const resolved=await resolveOwnerFromJwt(request('Bearer '+token),async value=>{
  receivedToken=value;
  return {data:{user:{id:ownerId}},error:null};
 });
 assert.equal(resolved,ownerId);
 assert.equal(receivedToken,token);
});

test('missing or malformed bearer headers fail before calling Supabase Auth',async()=>{
 let calls=0;
 const verify=async()=>{calls++;return {data:{user:{id:ownerId}},error:null};};
 for(const header of [null,'','bearer '+token,'Basic '+token,'Bearer short','Bearer '+'x'.repeat(4097),'Bearer bad/token']){
  assert.equal(await resolveOwnerFromJwt(request(header),verify),null);
 }
 assert.equal(calls,0);
});

test('invalid, revoked or expired Supabase access tokens fail closed',async()=>{
 const invalid=await resolveOwnerFromJwt(request('Bearer '+token),async()=>({
  data:{user:null},error:{message:'invalid token'}
 }));
 const absent=await resolveOwnerFromJwt(request('Bearer '+token),async()=>({
  data:{user:null},error:null
 }));
 assert.equal(invalid,null);
 assert.equal(absent,null);
});

test('an Auth response without a canonical user UUID is never accepted',async()=>{
 for(const id of [undefined,'','not-a-uuid',123,'00000000-0000-0000-0000-000000000000']){
  const result=await resolveOwnerFromJwt(request('Bearer '+token),async()=>({
   data:{user:{id}},error:null
  }));
  assert.equal(result,null);
 }
});

test('Auth service transport failures propagate instead of being disguised as authorization success',async()=>{
 await assert.rejects(()=>resolveOwnerFromJwt(request('Bearer '+token),async()=>{throw new Error('auth transport unavailable');}),/auth transport unavailable/);
});

test('helper rejects incomplete dependencies rather than accepting caller-supplied identities',async()=>{
 await assert.rejects(()=>resolveOwnerFromJwt(null,async()=>({})),/HTTP request/);
 await assert.rejects(()=>resolveOwnerFromJwt(request('Bearer '+token),null),/verifier/);
});
