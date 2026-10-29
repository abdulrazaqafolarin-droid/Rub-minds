/** Authenticated loopback routes for opt-in external Backroom workspaces. */
const ALLOWED={
 '/v1/workspaces/desktop/windows':['groupId','sessionId'],
 '/v1/workspaces/desktop/observe':['pid','windowId','groupId','sessionId'],
 '/v1/workspaces/desktop/draft':['pid','windowId','elementToken','text','expectedAppName','expectedTitle','groupId','sessionId'],
 '/v1/workspaces/android/diagnose':['groupId','sessionId'],
 '/v1/workspaces/android/observe':['deviceSerial','appPackage','groupId','sessionId'],
 '/v1/workspaces/android/tasks':['deviceSerial','appPackage','task','groupId','sessionId'],
 '/v1/workspaces/android/task-status':['traceId','deviceSerial','groupId','sessionId'],
 '/v1/workspaces/android/task-stop':['traceId','deviceSerial','groupId','sessionId'],
 '/v1/workspaces/android/task-inspect':['traceId','deviceSerial','action','query','groupId','sessionId'],
 '/v1/workspaces/terminal/start':['groupId','sessionId'],
 '/v1/workspaces/terminal/exec':['command','cwd','purpose','groupId','sessionId'],
 '/v1/workspaces/terminal/sync':['groupId','sessionId'],
 '/v1/workspaces/terminal/diff':['groupId','sessionId'],
 '/v1/workspaces/terminal/apply':['exportKey','sha256','groupId','sessionId']
};
function bearer(request){const m=/^Bearer ([a-f0-9]{64})$/i.exec(request.headers.authorization??'');return m?.[1]??null;}
function onlyKeys(input,allowed){return !!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>allowed.includes(k));}
function statusFor(error){const m=String(error?.message??'');if(/unavailable|not ready|not initialized|disabled/i.test(m))return 503;if(/denied|approval/i.test(m))return 403;if(/timed out|capacity/i.test(m))return 504;return 409;}

/** Returns false for unrelated paths, otherwise writes the HTTP response and returns true. */
export async function handleWorkspaceHttpRequest({request,response,url,authority,workspaceRuntime=null,corsHeaders={},writeJson,readJson}={}){
 if(typeof url?.pathname!=='string'||!url.pathname.startsWith('/v1/workspaces/'))return false;
 if(typeof writeJson!=='function'||typeof readJson!=='function'||!authority||typeof authority.authorize!=='function')throw new TypeError('Workspace HTTP dependencies required');
 const session=authority.authorize({origin:request.headers.origin,token:bearer(request)});
 if(!session){writeJson(response,401,{error:'host_session_invalid'},corsHeaders);return true;}
 if(url.pathname==='/v1/workspaces/status'){
  if(request.method!=='GET'){writeJson(response,405,{error:'method_not_allowed'},corsHeaders);return true;}
  writeJson(response,200,workspaceRuntime?workspaceRuntime.status():{stopped:false,capabilities:{desktop:false,android:false,terminal:false},desktop:{available:false},android:{available:false},terminal:{available:false,hostShellAvailable:false}},corsHeaders);return true;
 }
 const allowed=ALLOWED[url.pathname];
 if(!allowed){writeJson(response,404,{error:'not_found'},corsHeaders);return true;}
 if(request.method!=='POST'){writeJson(response,405,{error:'method_not_allowed'},corsHeaders);return true;}
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']??'')){writeJson(response,415,{error:'application_json_required'},corsHeaders);return true;}
 let input;
 try{input=await readJson(request);}catch(error){writeJson(response,error?.status??400,{error:error?.status===413?'request_too_large':'invalid_json'},corsHeaders);return true;}
 if(!onlyKeys(input,allowed)){writeJson(response,400,{error:'invalid_workspace_request'},corsHeaders);return true;}
 if(typeof input.groupId!=='string'||!input.groupId.trim()||typeof input.sessionId!=='string'||!input.sessionId.trim()){writeJson(response,400,{error:'backroom_group_and_session_required'},corsHeaders);return true;}
 if(!workspaceRuntime){writeJson(response,503,{error:'workspace_runtime_unavailable'},corsHeaders);return true;}
 try{
  let result,status=200;
  switch(url.pathname){
   case '/v1/workspaces/desktop/windows':result={windows:await workspaceRuntime.listDesktopWindows(input)};break;
   case '/v1/workspaces/desktop/observe':result=await workspaceRuntime.observeDesktop(input);break;
   case '/v1/workspaces/desktop/draft':result=await workspaceRuntime.draftDesktop(input);status=200;break;
   case '/v1/workspaces/android/diagnose':result=await workspaceRuntime.diagnoseAndroid(input);break;
   case '/v1/workspaces/android/observe':result=await workspaceRuntime.observeAndroid(input);break;
   case '/v1/workspaces/android/tasks':result=await workspaceRuntime.runAndroidTask(input);status=201;break;
   case '/v1/workspaces/android/task-status':result=await workspaceRuntime.androidTaskStatus(input);break;
   case '/v1/workspaces/android/task-stop':result=await workspaceRuntime.stopAndroidTask(input);break;
   case '/v1/workspaces/android/task-inspect':result=await workspaceRuntime.inspectAndroidTask(input);break;
   case '/v1/workspaces/terminal/start':result=await workspaceRuntime.startTerminal(input);status=202;break;
   case '/v1/workspaces/terminal/exec':result=await workspaceRuntime.execTerminal(input);status=200;break;
   case '/v1/workspaces/terminal/sync':result=await workspaceRuntime.syncTerminalProject(input);status=200;break;
   case '/v1/workspaces/terminal/diff':result=await workspaceRuntime.diffTerminalProject(input);status=200;break;
   case '/v1/workspaces/terminal/apply':result=await workspaceRuntime.applyTerminalProjectDiff(input);status=200;break;
   default:writeJson(response,404,{error:'not_found'},corsHeaders);return true;
  }
  writeJson(response,status,result,corsHeaders);
 }catch(error){const status=statusFor(error);writeJson(response,status,{error:status===503?'workspace_runtime_unavailable':status===403?'local_approval_denied':status===504?'workspace_operation_timeout':'workspace_operation_failed'},corsHeaders);}
 return true;
}
