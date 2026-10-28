import test from "node:test";
import assert from "node:assert/strict";
import {HostPairingAuthority} from "./host-pairing.mjs";
const setup=(options={})=>new HostPairingAuthority({allowedOrigins:["https://rub-minds.vercel.app"],hostId:"host",pairingCode:"ab".repeat(16),...options});
test("pair once; store only digest and bind session to origin",()=>{const a=setup();const result=a.pair({origin:"https://rub-minds.vercel.app",pairingCode:"ab".repeat(16)});assert.match(result.token,/^[a-f0-9]{64}$/);assert.equal(a.authorize({origin:"https://rub-minds.vercel.app",token:result.token}).hostId,"host");assert.equal(a.authorize({origin:"https://evil.test",token:result.token}),null);assert.throws(()=>a.pair({origin:"https://rub-minds.vercel.app",pairingCode:"ab".repeat(16)}),/expired/)});
test("hex pairing codes and bearer tokens tolerate uppercase hex without changing entropy",()=>{
 const a=setup();
 const uppercaseCode="AB".repeat(16);
 const v=a.pair({origin:"https://rub-minds.vercel.app",pairingCode:uppercaseCode});
 assert.equal(a.authorize({origin:"https://rub-minds.vercel.app",token:v.token.toUpperCase()}).hostId,"host");
 assert.equal(a.revoke({origin:"https://rub-minds.vercel.app",token:v.token.toUpperCase()}),true);
 assert.equal(a.authorize({origin:"https://rub-minds.vercel.app",token:v.token}),null);
});
test("origin wildcard and path origins are rejected",()=>{assert.throws(()=>setup({allowedOrigins:["*"]}),/exact/);assert.throws(()=>setup({allowedOrigins:["https://rub-minds.vercel.app/path"]}),/exact/)});
test("sessions expire and can be revoked",()=>{let now=100;const a=setup({now:()=>now,sessionTtlMs:1000});const v=a.pair({origin:"https://rub-minds.vercel.app",pairingCode:"ab".repeat(16)});now=1100;assert.equal(a.authorize({origin:"https://rub-minds.vercel.app",token:v.token}),null)});
test("attempt limit locks pairing",()=>{const a=setup({maxPairAttempts:2});for(let i=0;i<2;i++)assert.throws(()=>a.pair({origin:"https://rub-minds.vercel.app",pairingCode:"cd".repeat(16)}),/invalid/);assert.throws(()=>a.pair({origin:"https://rub-minds.vercel.app",pairingCode:"ab".repeat(16)}),/rate_limited/)});
test("revocation removes permission immediately",()=>{const a=setup();const v=a.pair({origin:"https://rub-minds.vercel.app",pairingCode:"ab".repeat(16)});assert.equal(a.revoke({origin:"https://rub-minds.vercel.app",token:v.token}),true);assert.equal(a.authorize({origin:"https://rub-minds.vercel.app",token:v.token}),null)});

test("revoke-all requires the exact paired origin and a live token, then revokes host access",()=>{
 const a=setup();
 const v=a.pair({origin:"https://rub-minds.vercel.app",pairingCode:"ab".repeat(16)});
 assert.equal(a.revokeAll({origin:"https://evil.test",token:v.token}),false);
 assert.equal(a.authorize({origin:"https://rub-minds.vercel.app",token:v.token}).hostId,"host");
 assert.equal(a.revokeAll({origin:"https://rub-minds.vercel.app",token:"0".repeat(64)}),false);
 assert.equal(a.authorize({origin:"https://rub-minds.vercel.app",token:v.token}).hostId,"host");
 assert.equal(a.revokeAll({origin:"https://rub-minds.vercel.app",token:v.token}),true);
 assert.equal(a.authorize({origin:"https://rub-minds.vercel.app",token:v.token}),null);
 assert.equal(a.revokeAll({origin:"https://rub-minds.vercel.app",token:v.token}),false);
});
