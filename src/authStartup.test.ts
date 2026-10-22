import { describe, expect, it } from 'vitest';
import { shouldShowSessionRestoreError } from './authStartup';

describe('auth startup error handling', () => {
  it('does not show a restore error when a visitor has no saved session', () => {
    expect(shouldShowSessionRestoreError({ name: 'AuthSessionMissingError' })).toBe(false);
  });

  it('does not show a restore error when there is no error', () => {
    expect(shouldShowSessionRestoreError(null)).toBe(false);
    expect(shouldShowSessionRestoreError(undefined)).toBe(false);
  });

  it('still surfaces unexpected session restoration failures', () => {
    expect(shouldShowSessionRestoreError({ name: 'AuthRetryableFetchError' })).toBe(true);
    expect(shouldShowSessionRestoreError({ name: 'StorageError' })).toBe(true);
    expect(shouldShowSessionRestoreError({})).toBe(true);
  });
});
