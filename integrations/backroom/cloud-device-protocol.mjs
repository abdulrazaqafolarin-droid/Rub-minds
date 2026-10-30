// Shared protocol validators are bundled with the Backroom device Edge Function.
export {
  validatePairClaim,
  validateSelectedApps,
  isDeviceControlAvailable,
  sanitizeDeviceEvent,
  DEVICE_CAPABILITIES_V1,
} from "../../supabase/functions/backroom-device/cloud-device-protocol.mjs";
