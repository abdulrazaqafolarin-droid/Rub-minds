/** Bounded MCP-over-stdio client for trusted local Backroom runtimes. */
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SAFE_ENV=['PATH','HOME','USERPROFILE','TMPDIR','TEMP','TMP','SYSTEMROOT','WINDIR','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','LANG','LC_ALL','VIRTUAL_ENV','UV_PROJECT_ENVIRONMENT'];
const SECRET=/(?:TOKEN|SECRET|PASSWORD|PRIVATE|SERVICE_ROLE|API_KEY|ACCESS_KEY|CREDENTIAL)/i;

function makeEnv(source, extra) {
  const env={};
  for(const key of SAFE_ENV) if(typeof source?.[key]==='string') env[key]=source[key];
  for(const [key,value] of Object.entries(extra??{})) {
    if(!/^[A-Z_][A-Z0-9_]*$/i.test(key)||typeof value!=='string') throw new TypeError('MCP environment must be named string values');
    if(SECRET.test(key)) throw new Error('Credential-like environment variable denied for MCP adapter: '+key);
    env[key]=value;
  }
  return env;
}

export class McpStdioClient {
  #child=null; #reader=null; #pending=new Map(); #tools=new Map(); #id=1; #state='stopped'; #stderrSeen=false;
  constructor({command,args=[],cwd,env={},sourceEnv=process.env,timeoutMs=12000,spawnImpl=nodeSpawn}={}) {
    if(typeof command!=='string'||!command.trim()||command.includes('\0')) throw new TypeError('Local MCP executable required');
    if(!Array.isArray(args)||args.some(x=>typeof x!=='string'||x.includes('\0'))) throw new TypeError('MCP args must be strings');
    if(cwd!==undefined&&(typeof cwd!=='string'||!cwd.trim())) throw new TypeError('MCP cwd must be non-empty');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<250||timeoutMs>120000) throw new RangeError('Invalid MCP timeout');
    this.command=command; this.args=Object.freeze([...args]); this.cwd=cwd; this.env=makeEnv(sourceEnv,env); this.timeoutMs=timeoutMs; this.spawnImpl=spawnImpl;
  }
  get status(){return Object.freeze({state:this.#state,connected:this.#state==='ready',tools:[...this.#tools.keys()],stderrSeen:this.#stderrSeen});}
  async start(){
    if(this.#state==='ready') return this.status;
    if(this.#state==='starting') throw new Error('MCP process already starting');
    if(this.#state==='closed') throw new Error('MCP client is closed');
    this.#state='starting';
    let child;
    try { child=this.spawnImpl(this.command,[...this.args],{cwd:this.cwd,env:{...this.env},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']}); }
    catch { this.#state='failed'; throw new Error('Could not launch configured local MCP process'); }
    if(!child?.stdin||!child?.stdout||!child?.stderr||typeof child.once!=='function'){this.#state='failed';throw new Error('MCP process must expose stdio pipes');}
    this.#child=child; this.#reader=createInterface({input:child.stdout,crlfDelay:Infinity});
    this.#reader.on('line',line=>this.#onLine(line)); child.stderr.on('data',()=>{this.#stderrSeen=true;});
    child.once('error',()=>this.#fail('MCP subprocess failed'));
    child.once('exit',()=>{if(this.#state!=='closed')this.#state='failed';this.#fail('MCP subprocess exited');});
    try {
      await this.#request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'rub-minds-backroom',version:'0.1.0'}});
      this.#notify('notifications/initialized',{});
      const response=await this.#request('tools/list',{});
      if(!Array.isArray(response?.tools)) throw new Error('Missing MCP tool catalog');
      this.#tools=new Map(response.tools.filter(t=>t&&typeof t.name==='string'&&/^[a-zA-Z0-9_.-]{1,128}$/.test(t.name)).map(t=>[t.name,Object.freeze({name:t.name,description:typeof t.description==='string'?t.description.slice(0,1000):''})]));
      this.#state='ready'; return this.status;
    } catch {this.#state='failed';await this.#terminate();throw new Error('Local MCP server did not complete initialization');}
  }
  async listTools(){if(this.#state!=='ready')throw new Error('MCP server is not ready');return Object.freeze([...this.#tools.values()]);}
  async callTool(name,args={}){
    if(this.#state!=='ready')throw new Error('MCP server is not ready');
    if(typeof name!=='string'||!this.#tools.has(name))throw new Error('Tool is not advertised by selected MCP server');
    if(!args||typeof args!=='object'||Array.isArray(args))throw new TypeError('MCP arguments must be an object');
    const result=await this.#request('tools/call',{name,arguments:args});
    if(result?.isError===true)throw new Error('MCP tool returned an error: '+name);
    if(result?.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent;
    const text=(result?.content??[]).filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text);
    if(text.length===1){try{return JSON.parse(text[0]);}catch{return text[0];}}
    return text.length?text:(result??null);
  }
  async close(){if(this.#state==='closed')return;this.#state='closed';await this.#terminate();}
  #onLine(line){
    if(Buffer.byteLength(line,'utf8')>2*1024*1024){this.#fail('MCP message too large');void this.#terminate();return;}
    let m;try{m=JSON.parse(line);}catch{return;}
    if(!m||m.jsonrpc!=='2.0'||m.id===undefined)return;
    const p=this.#pending.get(String(m.id));if(!p)return;
    this.#pending.delete(String(m.id));clearTimeout(p.timer);
    if(m.error)p.reject(new Error('MCP request failed: '+String(m.error.message??'protocol error').slice(0,160)));else p.resolve(m.result);
  }
  #request(method,params){
    if(!this.#child?.stdin||this.#child.stdin.destroyed||this.#pending.size>=64)return Promise.reject(new Error('MCP request channel unavailable'));
    const id=this.#id++, key=String(id), raw=JSON.stringify({jsonrpc:'2.0',id,method,params});
    if(Buffer.byteLength(raw,'utf8')>2*1024*1024)return Promise.reject(new Error('MCP request too large'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#pending.delete(key);reject(new Error('MCP request timed out'));},this.timeoutMs);timer.unref?.();
      this.#pending.set(key,{resolve,reject,timer});
      try{this.#child.stdin.write(raw+'\n','utf8',error=>{if(error){const p=this.#pending.get(key);if(p){this.#pending.delete(key);clearTimeout(p.timer);p.reject(new Error('MCP request write failed'));}}});}
      catch{this.#pending.delete(key);clearTimeout(timer);reject(new Error('MCP request write failed'));}
    });
  }
  #notify(method,params){try{this.#child?.stdin?.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');}catch{}}
  #fail(message){for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(new Error(message));}this.#pending.clear();}
  async #terminate(){
    const child=this.#child;this.#reader?.close();this.#reader=null;this.#fail('MCP client stopped');this.#child=null;
    if(!child||child.exitCode!==null||child.killed)return;
    try{child.kill('SIGTERM');}catch{return;}
    await new Promise(resolve=>{const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}resolve();},1500);timer.unref?.();child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
}
