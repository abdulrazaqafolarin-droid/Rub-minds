const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const LABEL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
export function validateDesktopApps(value){
 if(!Array.isArray(value)||value.length>100)return false;
 const ids=new Set();
 for(const app of value){
  if(!app||typeof app!=='object'||Array.isArray(app)||
   Object.keys(app).some(key=>!['appId','label','sha256'].includes(key))||
   Object.keys(app).length!==3||
   typeof app.appId!=='string'||!UUID.test(app.appId)||
   ids.has(app.appId.toLowerCase())||
   typeof app.label!=='string'||!app.label.trim()||app.label.length>120||LABEL_CONTROL.test(app.label)||
   typeof app.sha256!=='string'||!SHA256.test(app.sha256))return false;
  ids.add(app.appId.toLowerCase());
 }
 return true;
}
