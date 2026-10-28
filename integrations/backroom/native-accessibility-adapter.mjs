/**
 * Native accessibility typing adapter contract for desktop, Windows and Android.
 * Requires a user-authorized OS-specific driver. This module neither installs
 * accessibility services nor bypasses OS/application policy or permissions.
 * Draft-only until platform submit/response completion is independently tested.
 */
const nativeSurfaces = new Set(["desktop_app","windows_app","android_app"]);
export class NativeAccessibilityDraftAdapter {
  constructor({driver,surface,appId,sessionId,identityFingerprint,locatorValue}) {
    if(!nativeSurfaces.has(surface))throw new TypeError("unsupported native surface");
    if(!driver||typeof driver.inspect!=="function"||typeof driver.writeText!=="function")throw new TypeError("native accessibility driver required");
    if([appId,sessionId,identityFingerprint,locatorValue].some(v=>typeof v!=="string"||!v))throw new TypeError("native binding required");
    Object.assign(this,{driver,surface,appId,sessionId,identityFingerprint,locatorValue});
  }
  async #current() {
    const state=await this.driver.inspect({locator:this.locatorValue});
    if(!state||state.connected!==true||state.focused!==true||state.editable!==true||
      state.surface!==this.surface||state.appId!==this.appId||state.sessionId!==this.sessionId||
      state.identityFingerprint!==this.identityFingerprint||state.locatorValue!==this.locatorValue||
      typeof state.text!=="string")throw new Error("native app focus or identity changed");
    return state;
  }
  async probe({target,operation}) {
    if(operation!=="draft"||target?.surface!==this.surface||target.locatorKind!=="accessibility"||
      target.locatorValue!==this.locatorValue)return {connected:false,focused:false};
    try {
      const state=await this.#current();
      if(state.text!=="")return {connected:false,focused:false};
      return {connected:true,focused:true,surface:this.surface,appId:this.appId,
        sessionId:this.sessionId,identityFingerprint:this.identityFingerprint,locatorKinds:["accessibility"]};
    }catch{return {connected:false,focused:false}}
  }
  async execute({command,target}) {
    if(command.operation!=="draft"||target.surface!==this.surface||
      target.locatorKind!=="accessibility"||target.locatorValue!==this.locatorValue||
      target.appId!==this.appId||target.sessionId!==this.sessionId||
      target.identityFingerprint!==this.identityFingerprint)throw new Error("native binding changed");
    const before=await this.#current();
    if(before.text!=="")throw new Error("cannot replace occupied native input");
    // Driver.writeText must only enter text; never implicitly click submit or send.
    await this.driver.writeText({locator:this.locatorValue,text:command.text,appId:this.appId,sessionId:this.sessionId});
    const after=await this.#current();
    return after.text===command.text ?
      {state:"completed",verified:true,result:{drafted:true,submitted:false}} :
      {state:"needs_review",verified:false};
  }
}
