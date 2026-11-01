const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const PLATFORMS = new Set(['windows','macos','linux']);
const CAPABILITIES = new Set(['liveScreen','desktopControl','terminalControl','filePicker','accessibility']);
const LABEL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export function validateDesktopRegistration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['deviceId','deviceLabel','platform','osVersion','appVersion','roomId','devicePublicKey'];
  if (Object.keys(value).some(key => !allowed.includes(key)) ||
      allowed.some(key => !Object.hasOwn(value,key))) return null;
  if (typeof value.deviceId !== 'string' || !UUID.test(value.deviceId) ||
      typeof value.roomId !== 'string' || !UUID.test(value.roomId) ||
      typeof value.devicePublicKey !== 'string' || !SHA256.test(value.devicePublicKey) ||
      typeof value.deviceLabel !== 'string' || !value.deviceLabel.trim() ||
      value.deviceLabel.length > 80 || LABEL_CONTROL.test(value.deviceLabel) ||
      typeof value.platform !== 'string' || !PLATFORMS.has(value.platform) ||
      typeof value.osVersion !== 'string' || value.osVersion.length > 40 || LABEL_CONTROL.test(value.osVersion) ||
      typeof value.appVersion !== 'string' || !value.appVersion.trim() ||
      value.appVersion.length > 40 || LABEL_CONTROL.test(value.appVersion)) return null;
  return Object.freeze({
    deviceId:value.deviceId.toLowerCase(),
    deviceLabel:value.deviceLabel.trim(),
    platform:value.platform,
    osVersion:value.osVersion,
    appVersion:value.appVersion.trim(),
    roomId:value.roomId.toLowerCase(),
    devicePublicKey:value.devicePublicKey.toLowerCase(),
  });
}

export function validateDesktopCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !CAPABILITIES.has(key))) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([,enabled]) => typeof enabled !== 'boolean')) return null;
  // No server-side request can enable an OS grant by itself. This is only a
  // report from the native app; the trusted OS adapter must recheck the grant
  // before each operation. Control remains false until a real driver is wired.
  if (value.liveScreen === true || value.desktopControl === true || value.terminalControl === true ||
      value.filePicker === true || value.accessibility === true) return null;
  return Object.freeze(Object.fromEntries(entries));
}

export function isValidDesktopDeviceToken(value) {
  return typeof value === 'string' && SHA256.test(value);
}
