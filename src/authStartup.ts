/** True only for startup auth errors that should be shown to a visitor. */
export function shouldShowSessionRestoreError(
  error: { name?: string } | null | undefined,
): boolean {
  // Supabase Auth can report this when there is no persisted session. That is
  // the normal state for a first-time visitor and must not look like a failure.
  return Boolean(error && error.name !== 'AuthSessionMissingError');
}
