import { BadRequestError } from '@infra/api/exceptions/localized.exception';
import { maskPhone, normalizePhone } from '@infra/phone/phone';

import { defaultActiveRole } from './auth.service';

describe('normalizePhone', () => {
  it('strips formatting to E.164 digits', () => {
    expect(normalizePhone('+998 (90) 123-45-67')).toBe('+998901234567');
    expect(normalizePhone('998901234567')).toBe('+998901234567');
  });

  it('is idempotent', () => {
    const once = normalizePhone('+998 90 123 45 67');
    expect(normalizePhone(once)).toBe(once);
  });

  it('rejects lengths that cannot be a phone number', () => {
    expect(() => normalizePhone('12345')).toThrow(BadRequestError);
    expect(() => normalizePhone('1234567890123456')).toThrow(BadRequestError);
  });
});

describe('maskPhone', () => {
  it('reveals only the last two digits', () => {
    // §12.1: a full phone number must never reach the logs.
    const masked = maskPhone('+998901234567');
    expect(masked).toBe('***67');
    expect(masked).not.toContain('9989012345');
  });
});

describe('defaultActiveRole', () => {
  it('picks the only role a single-role account holds', () => {
    expect(defaultActiveRole(['candidate'])).toBe('candidate');
  });

  it('returns null for a multi-role account', () => {
    // Guessing would silently decide which permissions the session starts with.
    expect(defaultActiveRole(['candidate', 'employer'])).toBeNull();
  });

  it('returns null when no role has been chosen yet', () => {
    expect(defaultActiveRole([])).toBeNull();
  });
});
