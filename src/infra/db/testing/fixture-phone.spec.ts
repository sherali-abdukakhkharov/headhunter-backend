import { fixturePhone, fixtureTelegramId } from '@infra/db/testing/int-db';
import { normalizePhone } from '@infra/phone/phone';

/**
 * The fixture identifiers, checked without a database.
 *
 * Worth a spec of its own for one reason: `fixturePhone` sits at `normalizePhone`'s upper
 * bound of fifteen digits, so widening it - one more digit of counter, a longer prefix -
 * would make every fixture number fail the real auth path with `auth.phone_invalid`, and it
 * would fail in the integration suites rather than here, where nothing points at the cause.
 */
describe('fixture identifiers', () => {
  it('survives the real normalizer, exactly at its fifteen-digit bound', () => {
    const phone = fixturePhone();

    expect(phone.replace('+', '')).toHaveLength(15);
    expect(normalizePhone(phone)).toBe(phone);
  });

  it('does not repeat over a run’s worth of draws', () => {
    // 500 is more users than a full integration run creates. Eleven digits makes a repeat
    // here about one in ten million, so a failure means the range shrank, not bad luck.
    const minted = Array.from({ length: 500 }, () => fixturePhone());

    expect(new Set(minted).size).toBe(500);
  });

  it('keeps Telegram ids clear of the range the old random scheme used', () => {
    // 500 000 000 to 600 000 000, which thousands of leftover rows still occupy.
    const id = Number(fixtureTelegramId());

    expect(id).toBeGreaterThan(600_000_000);
    expect(Number.isSafeInteger(id)).toBe(true);
  });
});
