import { CANONICAL_LOCALES } from '@infra/locale/locale';

import { MESSAGES, type MessageKey } from './messages';
import { translate } from './translate';

const KEYS = Object.keys(MESSAGES) as MessageKey[];

describe('the message catalog', () => {
  it('is not empty', () => {
    expect(KEYS.length).toBeGreaterThan(30);
  });

  it('has a non-blank message in all four interface variants', () => {
    // §3.2: every validation message, status and system label exists in all four
    // variants. The catalog's type enforces the *shape*; this catches an entry
    // that is present but empty or whitespace.
    const gaps: string[] = [];

    for (const key of KEYS) {
      for (const locale of CANONICAL_LOCALES) {
        if (!MESSAGES[key][locale]?.trim()) {
          gaps.push(`${key}/${locale}`);
        }
      }
    }

    expect(gaps).toEqual([]);
  });

  it('uses the same placeholders in every variant', () => {
    // A placeholder present in one language and missing in another renders as a
    // sentence with a hole in it for that user, and only for that user - the kind
    // of bug that ships because nobody tests in all four.
    const mismatches: string[] = [];

    for (const key of KEYS) {
      const perLocale = CANONICAL_LOCALES.map((locale) =>
        [...MESSAGES[key][locale].matchAll(/\{(\w+)\}/g)]
          .map((match) => match[1])
          .sort()
          .join(','),
      );

      if (new Set(perLocale).size > 1) {
        mismatches.push(`${key}: ${perLocale.join(' | ')}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('never leaves a translated message identical across all four variants', () => {
    // Three languages: a key whose four values are byte-identical is almost
    // always an untranslated placeholder that was pasted four times. Codes and
    // numbers are legitimately identical, so this only flags entries with letters.
    const suspicious = KEYS.filter((key) => {
      const values = CANONICAL_LOCALES.map((locale) => MESSAGES[key][locale]);
      return new Set(values).size === 1 && /[a-z]{4}/i.test(values[0]);
    });

    expect(suspicious).toEqual([]);
  });
});

describe('translate', () => {
  it('renders the requested locale', () => {
    expect(translate('error.not_found', 'ru')).toBe(
      'Запрашиваемые данные не найдены.',
    );
    expect(translate('error.not_found', 'en')).toBe(
      'The requested data was not found.',
    );
  });

  it('gives each interface variant a distinct string', () => {
    const rendered = CANONICAL_LOCALES.map((locale) =>
      translate('auth.otp_invalid', locale),
    );

    expect(new Set(rendered).size).toBe(4);
  });

  it('substitutes placeholders', () => {
    expect(translate('validation.too_long', 'en', { max: 24 })).toContain('24');
    expect(translate('dictionary.unknown_type', 'ru', { type: 'skill' })).toBe(
      'Неизвестный тип справочника: skill.',
    );
  });

  it('leaves an unmatched placeholder visible rather than blanking it', () => {
    // A mismatch between catalog and call site should be obvious in the response,
    // not produce a sentence missing a word.
    expect(translate('validation.too_long', 'en', {})).toContain('{max}');
  });

  it('returns the key for an unknown message', () => {
    // Deliberately ugly: an untranslated error is a bug, and hiding it behind a
    // bland fallback hides it from the only people who can fix it.
    expect(translate('nope.not.a.key' as MessageKey, 'en')).toBe(
      'nope.not.a.key',
    );
  });
});
