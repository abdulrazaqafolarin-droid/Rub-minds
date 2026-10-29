import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const source=await readFile(resolve(process.cwd(),'supabase/functions/backroom-config/index.ts'),'utf8');

test('owner Edge Function CORS allows the Supabase JS v2 client-info header',()=>{
 assert.match(source,/Access-Control-Allow-Headers[^\n]*x-client-info/i);
 assert.match(source,/Access-Control-Allow-Headers[^\n]*apikey/i);
 assert.match(source,/Access-Control-Allow-Headers[^\n]*content-type/i);
});

test('owner Edge Function supports optional modern trace headers without wildcard origins',()=>{
 assert.match(source,/Access-Control-Allow-Headers[^\n]*traceparent[^\n]*tracestate[^\n]*baggage/i);
 assert.match(source,/const origins=new Set\(\[/);
 assert.match(source,/Access-Control-Allow-Origin':origin/);
 assert.doesNotMatch(source,/Access-Control-Allow-Origin':\s*'\*'/);
});
