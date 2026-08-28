import { fixturePhone } from '@infra/db/testing/int-db';

import { DEMO_PHONE_PREFIX, demoPhone, isDemoPhone } from './demo-phone';
import { normalizePhone } from './phone';

/**
 * The reserved range, checked where getting it wrong would be expensive.
 *
 * Two of these are about *collision*, and they are the ones worth having. A demo
 * number that overlapped the load seeder's range would be deleted by `pnpm load:clean`
 * halfway through a QA pass; one that overlapped the integration fixtures' range would
 * hand a fixed login code to a row some test suite created. Neither would fail loudly.
 */
describe('demo phone range', () => {
  const numbers = [
    demoPhone('1000001'),
    demoPhone('2000003'),
    demoPhone('9000001'),
  ];

  it('cannot collide with the load seeder or the test fixtures', () => {
    for (const phone of numbers) {
      // `+99800` is load-seed.ts, removed wholesale by `pnpm load:clean`.
      expect(phone.startsWith('+99800')).toBe(false);
      // `+9987` is int-db.ts, and thousands of those rows share this database.
      expect(phone.startsWith('+9987')).toBe(false);
    }

    expect(isDemoPhone(fixturePhone())).toBe(false);
  });

  it('is a range the numbering plan cannot allocate', () => {
    // The whole safety argument in one assertion: after the country code the next
    // digit is `0`, which is Uzbekistan's domestic trunk prefix and therefore never
    // the start of a subscriber number. No real person can be issued one of these and
    // then find a stranger's fixed login code attached to their account.
    for (const phone of numbers) {
      expect(phone.slice(0, 5)).toBe('+9980');
    }
  });

  it('survives the real normalizer unchanged', () => {
    // The login path normalizes before it looks anything up, so a number this builds
    // and a number the API stores must be the same string.
    for (const phone of numbers) {
      expect(normalizePhone(phone)).toBe(phone);
    }
  });

  it('is nine national digits, which is what the app’s field accepts', () => {
    // The sign-in field is `maxLength: 9` and digits-only, and `UzPhone.parse` strips a
    // leading zero only from an over-length input - so exactly nine digits starting
    // `01` reaches the API as typed. Ten would silently lose the zero.
    for (const phone of numbers) {
      expect(phone.replace('+998', '')).toHaveLength(9);
    }
  });

  it('recognises its own range and nothing else', () => {
    expect(isDemoPhone(demoPhone('1000001'))).toBe(true);
    expect(isDemoPhone('+998901234567')).toBe(false);
    expect(isDemoPhone('+998001234567')).toBe(false);
  });

  it('refuses a tail that is not seven digits', () => {
    // A wrong length would produce a number outside what the app can type, and the
    // failure would surface as "the code never arrives".
    expect(() => demoPhone('123456')).toThrow(/seven digits/);
    expect(() => demoPhone('12345678')).toThrow(/seven digits/);
    expect(() => demoPhone('12345a7')).toThrow(/seven digits/);
  });

  it('matches the prefix the database CHECK constraint enforces', () => {
    // `demo_accounts_phone_is_reserved` hardcodes this string in SQL; the two cannot
    // be shared, so they are pinned together here instead.
    expect(DEMO_PHONE_PREFIX).toBe('+99801');
  });
});
