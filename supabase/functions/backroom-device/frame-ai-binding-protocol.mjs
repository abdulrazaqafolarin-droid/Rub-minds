const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[a-f0-9]{64}$/i;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SURFACES = new Set(["android_app", "desktop_app", "windows_app", "terminal"]);
const MAX_REQUEST_AGE_MS = 30_000;

function exactKeys(value, allowed, required = allowed) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key));
}

export function validateFrameAIBindingChallengeRequest(value, { now = Date.now() } = {}) {
  const required = ["deviceId","roomId","runtimeSessionId","participantId","surface","appId","requestId","issuedAt"];
  if (!exactKeys(value, required) ||
      !UUID.test(value.deviceId ?? "") || !UUID.test(value.roomId ?? "") ||
      !UUID.test(value.runtimeSessionId ?? "") || !UUID.test(value.participantId ?? "") ||
      !UUID.test(value.requestId ?? "") || !Number.isSafeInteger(value.issuedAt) ||
      !Number.isSafeInteger(now) || Math.abs(now-value.issuedAt)>MAX_REQUEST_AGE_MS ||
      !SURFACES.has(value.surface) || typeof value.appId!=="string") return null;

  if (value.surface==="android_app") {
    if (value.appId.length>255 || !PACKAGE.test(value.appId)) return null;
  } else if (!UUID.test(value.appId)) return null;

  return Object.freeze({...value});
}

export function validateFrameAIBindingCompletion(value) {
  const required = [
    "challengeId","nonce","runtimeSessionId","surface","appId",
    "appIdentityFingerprint","runtimeIdentityDigest",
  ];
  const optional = [
    "composerIdentityDigest","sendControlIdentityDigest","providerConversationIdentityDigest",
  ];
  if (!exactKeys(value,[...required,...optional],required) ||
      !UUID.test(value.challengeId??"") || !HEX.test(value.nonce??"") ||
      !UUID.test(value.runtimeSessionId??"") || !SURFACES.has(value.surface) ||
      typeof value.appId!=="string" || !HEX.test(value.runtimeIdentityDigest??"")) return null;

  if (value.surface==="android_app") {
    if (value.appId.length>255 || !PACKAGE.test(value.appId) ||
        !/^[a-f0-9]{64}(?:\.[a-f0-9]{64})*$/i.test(value.appIdentityFingerprint??"")) return null;
  } else if (!UUID.test(value.appId) || !HEX.test(value.appIdentityFingerprint??"")) return null;

  for (const key of optional) {
    if (value[key] !== undefined && value[key] !== null && !HEX.test(value[key])) return null;
  }
  if (value.surface==="terminal" &&
      optional.some(key=>value[key]!==undefined && value[key]!==null)) return null;
  if (value.providerConversationIdentityDigest &&
      (!value.composerIdentityDigest || !value.sendControlIdentityDigest)) return null;

  return Object.freeze({...value});
}

export function validateFrameAIBindingRevoke(value) {
  const required=["bindingId","roomId","deviceId"];
  return exactKeys(value,required) && UUID.test(value.bindingId??"") &&
    UUID.test(value.roomId??"") && UUID.test(value.deviceId??"")
    ? Object.freeze({...value}) : null;
}
