import { describe, expect, it } from 'vitest';
import { errorMessage } from './errorMessage';

describe('errorMessage', () => {
  it('preserves ordinary Error messages', () => {
    expect(errorMessage(new Error('Invitation expired or unavailable'))).toBe('Invitation expired or unavailable');
  });

  it('extracts a structured API error message', () => {
    expect(errorMessage({ message: 'Invitation expired or unavailable', code: 'P0001' }))
      .toBe('Invitation expired or unavailable');
  });

  it('unwraps an opaque Error message to its useful cause', () => {
    const error = new Error('[object Object]');
    Object.assign(error, { cause: { message: 'Invitation expired or unavailable' } });
    expect(errorMessage(error)).toBe('Invitation expired or unavailable');
  });

  it('skips opaque message strings and checks structured details', () => {
    expect(errorMessage({ message: '[object Object]', details: 'Invitation expired or unavailable' }))
      .toBe('Invitation expired or unavailable');
  });

  it('never exposes a stringified object or stack trace as the message', () => {
    expect(errorMessage(new Error('[object Object]'))).toBe('Something went wrong. Please try again.');
    expect(errorMessage('[object Object]')).toBe('Something went wrong. Please try again.');
  });
});
