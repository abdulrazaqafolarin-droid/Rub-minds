import { describe, expect, it } from 'vitest';
import { isValidInviteToken, readInviteToken } from './inviteLinks';

describe('invitation links', () => {
  it('reads the preferred query parameter format', () => {
    expect(readInviteToken('?invite=' + 'a'.repeat(64), '/')).toBe('a'.repeat(64));
  });

  it('supports legacy path-style invitation links', () => {
    expect(readInviteToken('', '/invite=' + 'b'.repeat(64))).toBe('b'.repeat(64));
  });

  it('prefers the query token when both formats are present', () => {
    expect(readInviteToken('?invite=query-token', '/invite=path-token')).toBe('query-token');
  });

  it('preserves malformed tokens so the UI can explain the problem', () => {
    expect(readInviteToken('?invite=short-token', '/')).toBe('short-token');
    expect(isValidInviteToken('short-token')).toBe(false);
  });

  it('accepts only exactly 64 hexadecimal characters', () => {
    expect(isValidInviteToken('a'.repeat(64))).toBe(true);
    expect(isValidInviteToken('g'.repeat(64))).toBe(false);
    expect(isValidInviteToken('a'.repeat(63))).toBe(false);
    expect(isValidInviteToken('a'.repeat(65))).toBe(false);
  });
});
