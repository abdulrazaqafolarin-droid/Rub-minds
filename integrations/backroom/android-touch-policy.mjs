const isPackageName = value => typeof value === "string" && value.length <= 255 &&
  value.split(".").length >= 2 &&
  value.split(".").every(part => /^[A-Za-z][A-Za-z0-9_]*$/.test(part));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateAndroidTouchMessage(value, { sessionId, appPackageName, controlGranted }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !["kind", "sessionId", "appPackageName", "gesture", "from", "to", "durationMs"].includes(key))) return null;
  if (value.kind !== "touch" || !UUID.test(sessionId ?? "") || value.sessionId !== sessionId ||
      !isPackageName(appPackageName) || value.appPackageName !== appPackageName || controlGranted !== true) return null;
  if (!["tap", "swipe", "long_press"].includes(value.gesture)) return null;
  const point = item => item && typeof item === "object" && Number.isFinite(item.x) && Number.isFinite(item.y) &&
    item.x >= 0 && item.x <= 1 && item.y >= 0 && item.y <= 1 &&
    Object.keys(item).every(key => key === "x" || key === "y");
  if (!point(value.from) || !point(value.to)) return null;
  if (!Number.isInteger(value.durationMs) || value.durationMs < 40 || value.durationMs > 1_500) return null;
  if (value.gesture === "tap" && (Math.abs(value.from.x - value.to.x) > 0.01 || Math.abs(value.from.y - value.to.y) > 0.01)) return null;
  if (value.gesture === "swipe" && Math.hypot(value.to.x - value.from.x, value.to.y - value.from.y) < 0.02) return null;
  return Object.freeze({ ...value, from: Object.freeze({ ...value.from }), to: Object.freeze({ ...value.to }) });
}

export function mapNormalizedAndroidPoint(point, bounds) {
  if (!point || !bounds || ![point.x, point.y, bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) ||
      point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 ||
      bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
  const maxX = bounds.right - 1;
  const maxY = bounds.bottom - 1;
  if (maxX < bounds.left || maxY < bounds.top) return null;
  return Object.freeze({
    x: Math.floor(bounds.left + point.x * (maxX - bounds.left)),
    y: Math.floor(bounds.top + point.y * (maxY - bounds.top))
  });
}
