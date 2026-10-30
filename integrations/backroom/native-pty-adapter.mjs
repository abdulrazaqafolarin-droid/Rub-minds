/**
 * ConPTY on Windows and POSIX PTY via node-pty's native binding.
 * node-pty is an OPTIONAL companion-only dependency: this code runs only in
 * the installed desktop host, never in the Vercel browser bundle.
 */
export function createNativePtyAdapter({pty,platform=process.platform}={}){
 if(!pty || typeof pty.spawn!=='function')throw new Error('Native node-pty binding required');
 if(!['win32','darwin','linux'].includes(platform))throw new Error('Unsupported desktop platform');
 return async function createPty({shell,args=[],cols=80,rows=24,onData}={}){
   if(typeof shell!=='string'||shell.length===0||!Array.isArray(args)||
      args.some(x=>typeof x!=='string')||typeof onData!=='function'||
      !Number.isInteger(cols)||cols<20||cols>500||
      !Number.isInteger(rows)||rows<5||rows>200)
     throw new TypeError('Invalid native PTY session request');
   const session=pty.spawn(shell,args,{
     name:platform==='win32'?'xterm':'xterm-256color',
     cols,rows,cwd:process.cwd(),env:{...process.env},
     useConpty:platform==='win32',
   });
   const subscription=session.onData(data=>{
     if(typeof data==='string')onData(data.slice(0,32768));
   });
   let killed=false;
   return Object.freeze({
     write(data){
       if(killed)throw new Error('PTY stopped');
       if(typeof data!=='string'||data.length>4000||data.includes('\0'))throw new TypeError('Invalid PTY input');
       session.write(data);
     },
     resize(columns,lines){
       if(killed)throw new Error('PTY stopped');
       if(!Number.isInteger(columns)||columns<20||columns>500||
          !Number.isInteger(lines)||lines<5||lines>200)throw new TypeError('Invalid terminal dimensions');
       session.resize(columns,lines);
     },
     kill(){if(killed)return;killed=true;subscription?.dispose?.();session.kill();}
   });
 };
}
