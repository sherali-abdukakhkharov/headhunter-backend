import {
  CANONICAL_LOCALES,
  DEFAULT_LOCALE,
  localeFallbackChain,
  normalizeLocale,
} from './locale';

describe('normalizeLocale', () => {
  it('accepts the house aliases of digital-edo-api', () => {
    // §3.1 and the alias table in docs/API_CONTRACTS.md §1.
    expect(normalizeLocale('uz')).toBe('uz-Latn');
    expect(normalizeLocale('oz')).toBe('uz-Cyrl');
  });

  it('accepts the canonical codes in any casing and any separator', () => {
    expect(normalizeLocale('uz-Latn')).toBe('uz-Latn');
    expect(normalizeLocale('UZ-LATN')).toBe('uz-Latn');
    expect(normalizeLocale('uz_Cyrl')).toBe('uz-Cyrl');
    expect(normalizeLocale('ru-RU')).toBe('ru');
    expect(normalizeLocale('en-GB')).toBe('en');
  });

  it('emits exactly the four canonical codes and nothing else', () => {
    // The client caches by the emitted value, so a fifth spelling would split
    // its cache permanently (API_CONTRACTS.md §1).
    const outputs = [
      'uz',
      'oz',
      'uz-latn',
      'uz_Cyrl',
      'RU',
      'en-us',
      'de',
      '',
    ].map(normalizeLocale);

    for (const output of outputs) {
      expect(CANONICAL_LOCALES).toContain(output);
    }
  });

  it('falls back to the default rather than refusing an unknown language', () => {
    // §3.2 requires a configured fallback. Serving Uzbek to a client that asked
    // for German beats failing its first screen.
    expect(normalizeLocale('de')).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale('zz-ZZ')).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale('')).toBe(DEFAULT_LOCALE);
  });

  it('takes the first entry of an Accept-Language style list', () => {
    expect(normalizeLocale('ru,en;q=0.8')).toBe('ru');
    expect(normalizeLocale('  oz , ru ')).toBe('uz-Cyrl');
  });
});

describe('localeFallbackChain', () => {
  it('prefers the other Uzbek script over English', () => {
    // Same language, different writing system - a Cyrillic reader is far better
    // served by Latin Uzbek than by English (§3.2).
    expect(localeFallbackChain('uz-Cyrl')).toEqual([
      'uz-Cyrl',
      'uz-Latn',
      'en',
    ]);
  });

  it('ends every chain at English', () => {
    for (const locale of CANONICAL_LOCALES) {
      const chain = localeFallbackChain(locale);
      expect(chain[0]).toBe(locale);
      expect(chain[chain.length - 1]).toBe('en');
    }
  });
});
