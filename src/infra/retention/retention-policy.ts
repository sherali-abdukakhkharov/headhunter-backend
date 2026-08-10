/**
 * BR-14's retention policy, as data.
 *
 * BR-14 says deletion and retention "follow the approved privacy policy and applicable
 * legal requirements", and **there is no approved privacy policy yet**. That has blocked
 * the purge since M1. This file unblocks it the same way the dictionary content and BR-12's
 * justifications were unblocked: every period is declared here with a stated default and a
 * provenance tag, so the client's answer is an edit to this table rather than a milestone.
 *
 * Three properties make that safe to ship ahead of the answer.
 *
 * - **Nothing runs on a timer.** There is no scheduler behind this; an administrator
 *   triggers a purge, sees what it would remove first, and every removal is audited. A
 *   wrong number here cannot quietly destroy anything.
 * - **Every rule says where its number came from.** `provisional` means an engineer chose
 *   it and a lawyer has not seen it. That tag is what makes the gap visible in the API
 *   response instead of only in a document.
 * - **The periods are floors, not deadlines.** Data is purged *after* its period, when
 *   somebody runs the purge - never before it. Erring towards keeping is the recoverable
 *   direction.
 *
 * The numbers are compiled from what Uzbek practice and comparable platforms do, and are
 * deliberately conservative. `legalBasis` names the reason a period cannot simply be
 * shortened to zero, which is the part a privacy policy will need to argue rather than
 * assert.
 */

/** What happens to a subject's rows when its period expires. */
export type RetentionAction =
  /** The rows are deleted outright. */
  | 'purge'
  /** The row survives with its identifying columns cleared - see `users` below. */
  | 'anonymize'
  /** Kept indefinitely, and the rule says why. */
  | 'keep';

export type RetentionProvenance =
  /** An engineer's conservative default. No lawyer has seen it. */
  | 'provisional'
  /** Confirmed by the client against their approved privacy policy. */
  | 'client_approved'
  /** Fixed by law or by another rule in this specification, not by preference. */
  | 'required';

export interface RetentionRule {
  /** Stable code, used by the admin API and by the purge. */
  code: string;
  /** What data this covers, in the client's terms. */
  subject: string;
  /**
   * Days after the trigger event before the action applies. `null` means "never", which
   * is only valid with `action: 'keep'`.
   */
  days: number | null;
  /** The event the period counts from. */
  trigger: string;
  action: RetentionAction;
  provenance: RetentionProvenance;
  /** Why this cannot be zero, or why it must be finite. */
  legalBasis: string;
}

/**
 * The policy.
 *
 * Read by `RetentionService` and returned verbatim by `GET /admin/retention/policy`, so an
 * administrator can see what the platform believes its own retention rules are - which is
 * itself part of §11's transparency.
 */
export const RETENTION_POLICY: readonly RetentionRule[] = [
  {
    code: 'account_deletion_grace',
    subject:
      'An account that has requested deletion, before anything is erased',
    days: 30,
    trigger: 'the deletion request',
    action: 'keep',
    provenance: 'provisional',
    legalBasis:
      'A grace period is a protection, not a delay: a request made in anger or by ' +
      'somebody who got hold of a phone has to be reversible, and 30 days is the ' +
      'shortest window in common use. Deleting on confirmation would make a stolen ' +
      'session enough to destroy a work history permanently.',
  },
  {
    code: 'account_personal_data',
    subject:
      'The phone number, name, profile, files, messages and applications',
    days: 30,
    trigger: 'the deletion request',
    action: 'purge',
    provenance: 'provisional',
    legalBasis:
      'This is the erasure BR-14 exists for, and it happens as soon as the grace ' +
      'period above ends. Nothing here is needed for any other rule.',
  },
  {
    code: 'admin_actor_identity',
    subject: 'The account of a user who has acted as an administrator',
    days: 30,
    trigger: 'the deletion request',
    action: 'anonymize',
    provenance: 'required',
    legalBasis:
      '§10.4 requires an immutable audit log, and an audit row that forgot who acted ' +
      'is not an audit row. The two duties are reconciled by erasing the person and ' +
      'keeping the actor: the phone number, name and Telegram identity go, the row and ' +
      'its id stay, so every decision still resolves to a distinct administrator ' +
      'without naming one. This is the only rule here that is not a preference.',
  },
  {
    code: 'admin_audit_log',
    subject:
      'Administrator decisions - who approved, rejected, blocked or edited what',
    days: null,
    trigger: 'never',
    action: 'keep',
    provenance: 'provisional',
    legalBasis:
      'An accountability record with an expiry date protects the wrong party. Kept ' +
      'indefinitely, and made lawful by holding no personal data of its own: the actor ' +
      'is an id, and `admin_actor_identity` above is what empties the person behind it.',
  },
  {
    code: 'status_history',
    subject:
      'BR-08 status trails - verification, moderation, applications, invitations',
    days: null,
    trigger: 'never',
    action: 'keep',
    provenance: 'required',
    legalBasis:
      'BR-08 makes the history row part of the status change itself. These rows follow ' +
      'the record they describe: they are deleted when it is (a purged account takes ' +
      'its own trail), and they have no independent period.',
  },
  {
    code: 'otp_codes',
    subject: 'One-time codes, used or expired',
    days: 1,
    trigger: 'the code being issued',
    action: 'purge',
    provenance: 'provisional',
    legalBasis:
      'A code is dead within minutes (OTP_TTL_SECONDS); the row is worth one more day ' +
      'only for investigating a login somebody disputes. Hashed, never the code itself.',
  },
  {
    code: 'sessions',
    subject: 'Refresh-token families for devices that stopped being used',
    days: 90,
    trigger: 'the session expiring or being revoked',
    action: 'purge',
    provenance: 'provisional',
    legalBasis:
      'A revoked family has to outlive its own refresh token so that reuse detection ' +
      'still recognises a stolen one (§4.2). 90 days is well past REFRESH_TOKEN_TTL_DAYS.',
  },
  {
    code: 'rate_limit_counters',
    subject: 'Per-phone and per-IP request counters',
    days: 2,
    trigger: 'the window closing',
    action: 'purge',
    provenance: 'provisional',
    legalBasis:
      'A closed window is never read again - the phone subject is hashed and the IP is ' +
      'personal data under most readings, so keeping either past its window has no ' +
      'purpose to point at.',
  },
  {
    code: 'idempotency_keys',
    subject:
      'Replay-protection keys for applications, invitations and messages',
    days: 7,
    trigger: 'the key being stored',
    action: 'purge',
    provenance: 'provisional',
    legalBasis:
      'These exist so a retry from a flaky mobile connection does not create a second ' +
      'application. A retry a week later is a new intent, not a duplicate.',
  },
  {
    code: 'notifications',
    subject: 'Delivered in-app notifications',
    days: 180,
    trigger: 'the notification being created',
    action: 'purge',
    provenance: 'provisional',
    legalBasis:
      'The in-app list is the record of what a user was told (§9.2) and is the fallback ' +
      'for a device with no Google Play services. Six months is longer than any hiring ' +
      'cycle it describes.',
  },
] as const;

/** A rule by code, or `undefined` - callers name a literal, so a miss is a bug. */
export function retentionRule(code: string): RetentionRule | undefined {
  return RETENTION_POLICY.find((rule) => rule.code === code);
}

/** The same lookup for internal callers, where a missing code cannot be recovered from. */
export function requireRetentionRule(code: string): RetentionRule {
  const rule = retentionRule(code);

  if (!rule) {
    throw new Error(`no retention rule named ${code}`);
  }

  return rule;
}

/**
 * The cut-off for a rule: rows whose trigger happened before this are due.
 *
 * Computed from a caller-supplied `now` rather than the clock, so the purge and its
 * preview cannot disagree about the boundary by the time one finishes.
 */
export function retentionCutoff(code: string, now: Date): Date | null {
  const rule = requireRetentionRule(code);

  if (rule.days === null) {
    return null;
  }

  return new Date(now.getTime() - rule.days * 24 * 60 * 60 * 1000);
}

/** Every rule whose period an engineer chose - what the client still has to confirm. */
export function provisionalRules(): RetentionRule[] {
  return RETENTION_POLICY.filter((rule) => rule.provenance === 'provisional');
}
