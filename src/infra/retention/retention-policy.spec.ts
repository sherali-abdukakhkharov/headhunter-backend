import {
  RETENTION_POLICY,
  provisionalRules,
  requireRetentionRule,
  retentionCutoff,
  retentionRule,
} from './retention-policy';

/**
 * The policy is data, so these are the checks that keep it coherent as data.
 *
 * Nothing here asserts that 30 days is the *right* answer - no test can, until the client
 * approves a privacy policy. What they assert is that every rule says where its number
 * came from and that the numbers cannot contradict each other, which is what makes the
 * table safe to hand to a lawyer and edit in one place.
 */

describe('the retention policy as data', () => {
  it('gives every rule a unique code', () => {
    const codes = RETENTION_POLICY.map((rule) => rule.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('states a legal basis and a trigger for every rule', () => {
    for (const rule of RETENTION_POLICY) {
      // The basis is the part a privacy policy has to argue rather than assert, so an
      // empty one would make the whole table an assertion.
      expect(rule.legalBasis.length).toBeGreaterThan(40);
      expect(rule.subject.length).toBeGreaterThan(10);
      expect(rule.trigger.length).toBeGreaterThan(3);
    }
  });

  it('only allows an unbounded period when the action is to keep', () => {
    for (const rule of RETENTION_POLICY) {
      if (rule.days === null) {
        expect(rule.action).toBe('keep');
      } else {
        // A zero-day period would mean "erase on request", which no rule here intends
        // and which would make the grace period meaningless.
        expect(rule.days).toBeGreaterThan(0);
      }
    }
  });

  it('erases personal data no sooner than the grace period protecting it', () => {
    const grace = requireRetentionRule('account_deletion_grace');
    const personal = requireRetentionRule('account_personal_data');

    // The grace period exists so a request made in anger, or with a stolen session, is
    // reversible. A purge that ran first would make it decorative.
    expect(personal.days).not.toBeNull();
    expect(personal.days as number).toBeGreaterThanOrEqual(
      grace.days as number,
    );
  });

  it('keeps the audit log and erases the administrator behind it', () => {
    // The two halves of §10.4-versus-BR-14. If either of these ever changed, the
    // resolution would be broken in one direction or the other: a purged audit log, or
    // a phone number kept forever because an account once approved a vacancy.
    expect(requireRetentionRule('admin_audit_log').action).toBe('keep');
    expect(requireRetentionRule('admin_actor_identity').action).toBe(
      'anonymize',
    );
    expect(requireRetentionRule('admin_actor_identity').provenance).toBe(
      'required',
    );
  });

  it('outlives the refresh token it protects against reuse', () => {
    // Reuse detection needs the revoked family to still exist when a stolen token is
    // presented, so this period has to clear REFRESH_TOKEN_TTL_DAYS (30 by default).
    expect(requireRetentionRule('sessions').days as number).toBeGreaterThan(30);
  });

  it('names the rules a lawyer has not seen', () => {
    const provisional = provisionalRules().map((rule) => rule.code);

    expect(provisional).toContain('account_personal_data');
    // `required` rules are fixed by another rule in the specification, so they are not
    // waiting on anybody.
    expect(provisional).not.toContain('admin_actor_identity');
    expect(provisional).not.toContain('status_history');
  });
});

describe('retentionCutoff', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');

  it('counts back from the caller’s clock, not its own', () => {
    // The purge and its preview both pass the same `now`, so they cannot disagree about
    // the boundary while one of them is running.
    expect(retentionCutoff('otp_codes', now)?.toISOString()).toBe(
      '2026-08-07T12:00:00.000Z',
    );
    expect(retentionCutoff('account_personal_data', now)?.toISOString()).toBe(
      '2026-07-09T12:00:00.000Z',
    );
  });

  it('has no cutoff for something kept indefinitely', () => {
    expect(retentionCutoff('admin_audit_log', now)).toBeNull();
  });

  it('refuses a code that does not exist, rather than returning null', () => {
    // A typo must not read as "nothing is ever due": that failure would be silent, and
    // silently retaining personal data is the failure mode BR-14 is about.
    expect(() => retentionCutoff('no_such_rule', now)).toThrow(
      /no retention rule/,
    );
    expect(retentionRule('no_such_rule')).toBeUndefined();
  });
});
