const FALLBACK_ERROR = 'Something went wrong. Please try again.';

function isOpaqueObjectString(value: string): boolean {
  return /^\[object (?:Object|[A-Za-z][A-Za-z0-9]*)\]$/.test(value.trim());
}

/**
 * Convert thrown SDK/API values into a useful, safe message.
 * Some browser/client wrappers turn structured errors into "[object Object]".
 * Inspect structured details and causes before falling back; never render the
 * stringified object or expose stack traces.
 */
export function errorMessage(error: unknown, depth = 0): string {
  if (depth > 5) return FALLBACK_ERROR;

  if (typeof error === 'string') {
    const message = error.trim();
    return message && !isOpaqueObjectString(message) ? message : FALLBACK_ERROR;
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    if (message && !isOpaqueObjectString(message)) return message;
  }

  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    for (const key of ['message', 'details', 'hint', 'error_description', 'description']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim() && !isOpaqueObjectString(candidate)) {
        return candidate.trim();
      }
    }
    for (const key of ['cause', 'error', 'context', 'response']) {
      const nested = value[key];
      if (nested !== undefined && nested !== null) {
        const message = errorMessage(nested, depth + 1);
        if (message !== FALLBACK_ERROR) return message;
      }
    }
  }

  return FALLBACK_ERROR;
}
