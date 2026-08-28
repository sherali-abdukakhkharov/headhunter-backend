import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isDemoPhone } from '@infra/phone/demo-phone';

import {
  DEMO_ADMIN,
  DEMO_CANDIDATES,
  DEMO_EMPLOYERS,
  demoRoster,
} from './people';

/**
 * The fixture, and the document that publishes it.
 *
 * `docs/TEST_ACCOUNTS.md` is a credential list a tester types from. A wrong digit in
 * it is not a documentation defect, it is an account nobody can sign into — and the
 * person who hits it has no way to tell whether the document is stale or the feature
 * is broken. So the document is checked against the fixture that seeded it, the same
 * way `field-schema.contract.spec.ts` checks the schema against its own contract.
 */
const DOCUMENT = readFileSync(
  join(__dirname, '../../../../docs/TEST_ACCOUNTS.md'),
  'utf8',
);

describe('the demo roster', () => {
  const roster = demoRoster();

  it('covers all three roles', () => {
    expect(roster.filter((a) => a.role === 'candidate')).toHaveLength(6);
    expect(roster.filter((a) => a.role === 'employer')).toHaveLength(3);
    expect(roster.filter((a) => a.role === 'admin')).toHaveLength(1);
  });

  it('is entirely inside the reserved range', () => {
    // The one property that makes a published fixed code safe. A fixture that slipped
    // a real number in would be given a permanent password.
    for (const account of roster) {
      expect(isDemoPhone(account.phone)).toBe(true);
    }
  });

  it('uses each number and each fixture key once', () => {
    // `users.phone` is unique, so a duplicate would not create a second account - the
    // second person would silently overwrite the first one's profile.
    const phones = roster.map((a) => a.phone);
    expect(new Set(phones).size).toBe(phones.length);

    const keys = [
      ...DEMO_CANDIDATES.map((c) => c.key),
      ...DEMO_EMPLOYERS.map((e) => e.key),
      DEMO_ADMIN.key,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses codes the client can render and the constraint accepts', () => {
    // `demo_accounts_code_is_digits` refuses anything else, and OTP_LENGTH is 6, so a
    // five-digit code would not fit the boxes the code screen draws.
    for (const account of roster) {
      expect(account.code).toMatch(/^\d{6}$/);
    }
  });

  it('covers every §2.1 category, and leaves exactly one profile unfinished', () => {
    // What the cast is *for*: a category with no fixture is a form nobody exercises,
    // and without an incomplete profile there is nothing to test BR-02's gate against.
    const searchable = DEMO_CANDIDATES.filter(
      (c) => c.visibility === 'searchable',
    );

    expect(searchable).toHaveLength(5);
    expect(
      DEMO_CANDIDATES.filter((c) => c.visibility === 'hidden'),
    ).toHaveLength(1);
  });

  it('leaves each administrator queue something to do', () => {
    expect(
      DEMO_EMPLOYERS.filter((e) => e.verification === 'under_review'),
    ).toHaveLength(1);

    const vacancies = DEMO_EMPLOYERS.flatMap((e) => e.vacancies);
    expect(vacancies.filter((v) => v.land === 'under_moderation')).toHaveLength(
      1,
    );
  });
});

describe('docs/TEST_ACCOUNTS.md', () => {
  const roster = demoRoster();

  it('lists every account with the digits a tester types', () => {
    for (const account of roster) {
      // The document shows the national part, because that is what the field takes -
      // it already displays `+998`. Publishing the E.164 form would have testers type
      // twelve digits into a nine-digit field.
      const typed = account.phone.replace('+998', '');

      expect(DOCUMENT).toContain(`\`${typed}\``);
    }
  });

  it('publishes the code that was actually seeded', () => {
    for (const account of roster) {
      const typed = account.phone.replace('+998', '');
      const row = DOCUMENT.split('\n').find(
        (line) => line.includes(`\`${typed}\``) && line.includes('|'),
      );

      expect(row).toBeDefined();
      expect(row).toContain(`\`${account.code}\``);
    }
  });

  it('lists no number that is not in the fixture', () => {
    // The direction the check above cannot catch: an account removed from the fixture
    // but left in the document sends a tester to a number that now refuses outright.
    const published = [...DOCUMENT.matchAll(/`(01\d{7})`/g)].map((m) => m[1]);
    const seeded = new Set(roster.map((a) => a.phone.replace('+998', '')));

    for (const number of published) {
      expect(seeded.has(number)).toBe(true);
    }

    expect(new Set(published).size).toBe(roster.length);
  });

  it('names every person, so the table can be matched to a screen', () => {
    for (const candidate of DEMO_CANDIDATES) {
      expect(DOCUMENT).toContain(candidate.fullName);
    }

    for (const employer of DEMO_EMPLOYERS) {
      expect(DOCUMENT).toContain(employer.publicName ?? employer.contactName);
    }
  });
});
