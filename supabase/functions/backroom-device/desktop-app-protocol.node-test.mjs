import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDesktopApps} from './desktop-app-protocol.mjs';
const app={appId:'123e4567-e89b-42d3-a456-426614174000',label:'ChatGPT Desktop',sha256:'a'.repeat(64)};
test('accepts an explicit user-selected executable inventory',()=>{assert.equal(validateDesktopApps([app]),true);assert.equal(validateDesktopApps([]),true);});
test('rejects paths, tokens, extra fields and malformed hashes',()=>{
 for(const invalid of [{...app,path:'C:\\secret\\chatgpt.exe'},{...app,token:'secret'},{...app,sha256:'g'.repeat(64)},{...app,appId:'../x'},{...app,extra:true}])assert.equal(validateDesktopApps([invalid]),false);
});
test('rejects duplicate app IDs and unsafe labels',()=>{
 assert.equal(validateDesktopApps([app,{...app,label:'Other'}]),false);
 assert.equal(validateDesktopApps([{...app,label:'x'.repeat(121)}]),false);
 assert.equal(validateDesktopApps([{...app,label:'evil\\nlabel'}]),false);
});
test('caps app inventory at 100 items and rejects malformed input',()=>{
 assert.equal(validateDesktopApps(Array.from({length:101},(_,i)=>({...app,appId:'123e4567-e89b-42d3-a456-'+String(i).padStart(12,'0')}))),false);
 assert.equal(validateDesktopApps({apps:[app]}),false);
});
