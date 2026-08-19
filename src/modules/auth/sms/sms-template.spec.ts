import { MESSAGES } from '@infra/i18n/messages';
import { CANONICAL_LOCALES } from '@infra/locale/locale';

/**
 * The OTP SMS body, against Eskiz's own billing rules.
 *
 * Source: <https://my.eskiz.uz/assets/data/sms-symbols.pdf>, read 2026-08-19.
 *
 * **Why this is a test and not a note in a document.** An SMS is billed per segment, and the
 * segment size is decided by the characters in the text rather than by us: 160 if *every*
 * character is in the Latin set below, and **70 the moment one is not**. So a single
 * typographic apostrophe - `oʻ` instead of `o'`, which is the correct Uzbek letter and which
 * every text editor and phone keyboard produces by default - silently doubles the cost of
 * every login on the platform. Nothing fails, no log line appears; the invoice is just twice
 * the size.
 *
 * That is exactly the kind of rule that belongs in a test rather than in a comment somebody
 * reads after the fact. Client direction 2026-08-19: the ASCII apostrophe is acceptable for
 * `o'` and `g'`, which is what makes a one-segment Latin message possible at all.
 *
 * The Cyrillic variants are *always* on the 70-character tariff - Cyrillic is never in the
 * Latin set - so for those the assertion is only that they fit one segment. They sit within a
 * few characters of the limit, which is deliberate: the alternative is dropping the "do not
 * share this code" warning that every anti-fraud guideline asks for.
 */

/**
 * Eskiz's Latin set, verbatim. A message is billed at 160 only if every character is here.
 *
 * Not the full GSM 03.38 alphabet, which also contains `£ ¥ é è ù ì ò Ç Ø å Δ Φ ...`: Eskiz's
 * document is narrower, and it is Eskiz that bills us.
 */
const ESKIZ_LATIN = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  ' ',
  '\n',
  ...`.,!?:;'"@#$%&()*+-/<=>_`,
]);

/** In the Latin set, but each costs two of the 160. */
const ESKIZ_LATIN_DOUBLE = new Set([...'{}[]\\^']);

interface Measurement {
  slots: number;
  limit: number;
  segments: number;
  unicode: boolean;
  offenders: string[];
}

/** What Eskiz will bill for this text. */
function measure(text: string): Measurement {
  let slots = 0;
  const offenders = new Set<string>();

  for (const character of text) {
    if (ESKIZ_LATIN.has(character)) {
      slots += 1;
    } else if (ESKIZ_LATIN_DOUBLE.has(character)) {
      slots += 2;
    } else {
      offenders.add(
        `${character} (U+${character
          .codePointAt(0)
          ?.toString(16)
          .toUpperCase()
          .padStart(4, '0')})`,
      );
    }
  }

  const unicode = offenders.size > 0;
  // One character outside the set and the *whole* message is billed as Unicode, so the count
  // becomes a plain character count rather than a slot count.
  const slotsUsed = unicode ? [...text].length : slots;
  const limit = unicode ? 70 : 160;
  const perSegment = unicode ? 67 : 153;

  return {
    slots: slotsUsed,
    limit,
    segments: slotsUsed <= limit ? 1 : Math.ceil(slotsUsed / perSegment),
    unicode,
    offenders: [...offenders],
  };
}

/** The text as it is actually sent: `{code}` is a six-digit OTP (`OTP_LENGTH`). */
function rendered(locale: (typeof CANONICAL_LOCALES)[number]): string {
  return MESSAGES['sms.otp_code'][locale].replace('{code}', '123456');
}

describe('the OTP SMS fits one segment in every language', () => {
  it.each(CANONICAL_LOCALES)('costs one SMS in %s', (locale) => {
    const result = measure(rendered(locale));

    // The assertion that protects the bill. A second segment is not a bug that shows up
    // anywhere except on an invoice, which is why it is asserted rather than reviewed.
    expect({ locale, segments: result.segments }).toEqual({
      locale,
      segments: 1,
    });
  });

  it('keeps the Latin variants on the 160-character tariff', () => {
    // `uz-Latn` and `en` have no reason to be on the Unicode tariff, and the one way they
    // would end up there is a typographic character nobody noticed - `oʻ`, `’`, `—`, `№`.
    // The offender list is in the failure message on purpose: the character is invisible in a
    // diff, so the test has to name it.
    for (const locale of ['uz-Latn', 'en'] as const) {
      const result = measure(rendered(locale));

      expect({ locale, offenders: result.offenders }).toEqual({
        locale,
        offenders: [],
      });
      expect(result.limit).toBe(160);
    }
  });

  it('still fits if the code gains a digit', () => {
    // **The meaningful headroom assertion**, rather than an arbitrary number of spare
    // characters. `OTP_LENGTH` is configuration (§4.2 requires it to be), so the one realistic
    // way these texts grow is somebody raising it - and at seven digits the Cyrillic variants
    // land exactly on 70. An eighth digit would need the wording shortened first, and this is
    // where that gets said out loud instead of appearing on an invoice.
    for (const locale of CANONICAL_LOCALES) {
      const longer = MESSAGES['sms.otp_code'][locale].replace(
        '{code}',
        '1234567',
      );

      expect({ locale, segments: measure(longer).segments }).toEqual({
        locale,
        segments: 1,
      });
    }
  });

  it('records how much room each language actually has', () => {
    // Not a constraint - a record, so the numbers are in the suite output rather than in
    // somebody's memory. The Cyrillic variants are the tight ones, and that is the cost of
    // keeping the "do not share this code" warning that anti-fraud guidance asks for.
    const headroom = Object.fromEntries(
      CANONICAL_LOCALES.map((locale) => {
        const result = measure(rendered(locale));

        return [locale, `${result.slots}/${result.limit}`];
      }),
    );

    expect(headroom).toEqual({
      'uz-Latn': '94/160',
      'uz-Cyrl': '69/70',
      ru: '66/70',
      en: '74/160',
    });
  });
});

describe('what Eskiz moderation requires of a code message', () => {
  it.each(CANONICAL_LOCALES)('names the resource in %s', (locale) => {
    // Eskiz refuses a template that does not identify the resource the code is for. The brand
    // is the resource here, and it is spelled the same in all four variants on purpose - a
    // moderator has to recognise it, and so does the person reading the SMS.
    expect(rendered(locale)).toContain('Universal HeadHunter');
  });

  it.each(CANONICAL_LOCALES)('states what the code is for in %s', (locale) => {
    // The second half of the rule: the *purpose*. Wording differs by language, so this
    // asserts one of the words that carries it rather than a phrase.
    const purposes = ['kirish', 'кириш', 'входа', 'login'];

    expect(purposes.some((word) => rendered(locale).includes(word))).toBe(true);
  });

  it('carries the code itself exactly once', () => {
    // Two interpolations would be two codes to read and a longer message; zero would be a
    // template that arrives useless. Both have happened to other people.
    for (const locale of CANONICAL_LOCALES) {
      expect(MESSAGES['sms.otp_code'][locale].split('{code}')).toHaveLength(2);
    }
  });
});
