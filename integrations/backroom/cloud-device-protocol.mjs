const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validatePairClaim(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = ["pairingCode", "deviceToken", "deviceId", "deviceLabel", "osVersion", "appVersion"];
  if (Object.keys(input).some(key => !keys.includes(key))) return false;
  return typeof input.pairingCode === "string" && SHA256.test(input.pairingCode) &&
    typeof input.deviceToken === "string" && SHA256.test(input.deviceToken) &&
    typeof input.deviceId === "string" && UUID.test(input.deviceId) &&
    typeof input.deviceLabel === "string" && input.deviceLabel.trim().length > 0 && input.deviceLabel.length <= 80 &&
    typeof input.osVersion === "string" && input.osVersion.length <= 40 &&
    typeof input.appVersion === "string" && input.appVersion.length <= 40;
}

export function validateSelectedApps(value) {
  if (!Array.isArray(value) || value.length > 100) return false;
  const seen = new Set();
  for (const app of value) {
    if (!app || typeof app !== "object" || Array.isArray(app)) return false;
    const keys = ["packageName", "label", "signingCertificateSha256", "versionName", "draftInsertionAllowed"];
    if (Object.keys(app).some(key => !keys.includes(key))) return false;
    if (typeof app.packageName !== "string" || !PACKAGE.test(app.packageName) || seen.has(app.packageName)) return false;
    if (typeof app.label !== "string" || app.label.trim().length === 0 || app.label.length > 120) return false;
    if (typeof app.signingCertificateSha256 !== "string" || !/^[a-f0-9]{64}(?:\.[a-f0-9]{64})*$/.test(app.signingCertificateSha256)) return false;
    if (typeof app.versionName !== "string" || app.versionName.length > 80) return false;
    if (typeof app.draftInsertionAllowed !== "boolean") return false;
    seen.add(app.packageName);
  }
  return true;
}

export function isDeviceControlAvailable(device, surface) {
  if (!device || device.status !== "active") return false;
  const capabilities = device.capabilities;
  return Boolean(capabilities && capabilities[surface] === true);
}

export function sanitizeDeviceEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const allowed = new Set(["app_open_requested", "app_added", "app_removed", "device_connected", "device_disconnected"]);
  if (!allowed.has(input.eventType)) return null;
  if (Object.keys(input).some(key => !["eventType", "packageName"].includes(key))) return null;
  if (input.packageName !== undefined && (typeof input.packageName !== "string" || !PACKAGE.test(input.packageName))) return null;
  return { eventType: input.eventType, ...(input.packageName ? { packageName: input.packageName } : {}) };
}

export const DEVICE_CAPABILITIES_V1 = Object.freeze({
  appDiscovery: true,
  separateAppData: false,
  embeddedVirtualApp: false,
  liveScreen: false,
  touchControl: false,
  desktopControl: false,
  terminalControl: false
});
