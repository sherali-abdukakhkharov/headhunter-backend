import {
  generateOtpCode,
  generateRefreshToken,
  hashSecret,
  verifySecret,
} from './hash';

const PEPPER = 'test-pepper-at-least-32-characters-long';

describe('hashSecret', () => {
  it('is deterministic for the same secret and pepper', () => {
    expect(hashSecret('123456', PEPPER)).toBe(hashSecret('123456', PEPPER));
  });

  it('never returns the secret itself', () => {
    expect(hashSecret('123456', PEPPER)).not.toContain('123456');
  });

  it('produces a different hash under a different pepper', () => {
    // Rotating the pepper must invalidate every stored hash.
    expect(hashSecret('123456', PEPPER)).not.toBe(
      hashSecret('123456', `${PEPPER}-rotated`),
    );
  });
});

describe('verifySecret', () => {
  it('accepts the correct secret', () => {
    const stored = hashSecret('123456', PEPPER);
    expect(verifySecret('123456', stored, PEPPER)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const stored = hashSecret('123456', PEPPER);
    expect(verifySecret('123457', stored, PEPPER)).toBe(false);
  });

  it('rejects the correct secret under the wrong pepper', () => {
    const stored = hashSecret('123456', PEPPER);
    expect(
      verifySecret('123456', stored, 'another-pepper-32-characters-long!'),
    ).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored hash', () => {
    // timingSafeEqual throws on a length mismatch; a truncated column value
    // must not turn into a 500.
    expect(verifySecret('123456', 'deadbeef', PEPPER)).toBe(false);
    expect(verifySecret('123456', '', PEPPER)).toBe(false);
  });
});

describe('generateRefreshToken', () => {
  it('returns 256 bits of URL-safe output', () => {
    const token = generateRefreshToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('does not repeat', () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateRefreshToken()),
    );
    expect(tokens.size).toBe(100);
  });
});

describe('generateOtpCode', () => {
  it('returns exactly the requested number of digits', () => {
    for (const length of [4, 6, 8]) {
      expect(generateOtpCode(length)).toMatch(new RegExp(`^\\d{${length}}$`));
    }
  });

  it('zero-pads rather than shortening low values', () => {
    // 1000 draws would be an extraordinary coincidence to all exceed 99999,
    // so this genuinely exercises the padding path over time.
    const codes = Array.from({ length: 1000 }, () => generateOtpCode(6));
    expect(codes.every((code) => code.length === 6)).toBe(true);
  });
});
