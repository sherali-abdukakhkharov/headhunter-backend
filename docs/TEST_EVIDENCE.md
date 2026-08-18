# Testing evidence (§13.2)

§13.2 asks for "functional, integration, and acceptance-test results for agreed
scenarios". This is that, plus the command that reproduces it - a result nobody can re-run
is a screenshot.

**As of 2026-08-19, on schema version 21: 970 tests, all passing.**

| Suite | Command | Suites | Tests | Needs Postgres |
|---|---|---|---|---|
| Unit / functional | `pnpm test` | 26 | 483 | no |
| Integration | `pnpm test:int` | 22 | 487 | yes |
| **Acceptance (UAT-01..23 of 24)** | `pnpm test:int -- --testRegex uat` | 1 | 24 | yes |

The acceptance suite is a subset of the integration one; 970 is the sum of the first two
rows, counted once.

> **Three integration suites were failing in `afterAll` before M13**, and every test inside
> them passed - which is exactly how that goes unnoticed. M12 made
> `employer_wallets.user_id` `ON DELETE RESTRICT`, and the wallet, retention and UAT suites
> all tried to delete users it protects (as does `wallet_transactions.actor_user_id`, for the
> administrators who made an adjustment). They now check what the constraint protects and skip
> it, saying why - the pattern `admin.int.spec.ts` set for the audit log. Read a run's
> **suite** count, not only its test count.

```
pnpm test        # database-free, runs anywhere
pnpm test:int    # against the dev database - pnpm db:up first
```

## The split, and why it is not a matter of taste

`pnpm test` is database-free and runs over Kysely's `DummyDriver`: queries are genuinely
compiled, so a malformed one fails, but nothing connects.

Everything enforced by a **trigger, a row lock, a partial unique index or a transaction
boundary** is in `pnpm test:int` instead, because over `DummyDriver` those tests would
compile the query, run nothing, and pass while the behaviour was entirely absent. That is
not hypothetical: two M1 security bugs had passing tests, because the tests asserted the
exception rather than the side effect the exception rolled back.

Integration fixtures go in through the production write path - the seeder, the service -
so a test cannot set up a state the application could not produce.

## Acceptance: twenty-three of the twenty-four agreed scenarios

> **The 2026-08-10 specification revision raised §13.1 from 15 scenarios to 24**, and
> UAT-16..UAT-23 - the wallet, Candidate Unlock and Payme/CLICK rows - are now covered by
> M12 and M13. UAT-24 is a restatement of UAT-13 and is covered by it.
>
> **Nothing is half-asserted any more.** UAT-17's full claim - that "protected phone/e-mail,
> CV, chat, and interview/contact actions become available" - holds since the BR-09 retrofit
> landed on 2026-08-19, and the test asserts the contact details, the file access *and* the
> chat gate. The original fifteen were not rewritten, because the retrofit took the reading
> that an application is one of §11.1's "explicitly approved entitlements" - see the question
> at the top of [../TODO.md](../TODO.md), which is answered but **still wants the client's
> sign-off**. What did change across three suites is one reason code: `no_interaction` became
> `unlock_required`.

`src/uat/uat.int.spec.ts` is one `describe` per row of §13.1's table, titled with the
scenario and asserting that row's own stated expected result. Both moderation flags are
**on**, because UAT-04 and UAT-05 describe a moderated product.

| ID | Scenario | Asserted |
|---|---|---|
| UAT-01 | Registers by phone and OTP, enters onboarding | Account created, selected locale retained, role selection sticks |
| UAT-02 | Occupation, experience, Russian C1, location, preferences | Profile saved; found by the employer's search. A second test proves an incomplete profile stays out whatever its visibility |
| UAT-03 | Uploads a PDF CV | Authorized employer reads it through a live application; before one exists, and for a different employer, refused |
| UAT-04 | Creates and submits a company profile | `not_submitted` → `under_review` → administrator decision with its reason, plus the BR-08 history rows |
| UAT-05 | 20-position call-centre vacancy, Russian C1 | Stored with its language requirement and level; `under_moderation` until approved, then `active` |
| UAT-06 | Opens candidate search from the vacancy | Occupation, region, district, employment type and **language with its level** prefill as an editable filter set |
| UAT-07 | Saves candidates and sends invitations | Candidate gets a notification in their own language and can accept; the employer is notified of the answer |
| UAT-08 | Applies to an active vacancy | One application, visible to both sides; a second attempt is refused by the database (BR-07) |
| UAT-09 | Moves to Interview and creates an appointment | Candidate sees the status and the appointment details, and is notified |
| UAT-10 | Seasonal cotton-planting vacancy | Category derived from the occupation, worker count, start/end dates as date-only strings, daily payment period |
| UAT-11 | Administrator approves an employer and moderates a vacancy | Both statuses change, the employer is notified, and both decisions are in the audit log |
| UAT-12 | Hides the profile from global search | Gone from new searches - and `last_meaningful_update_at` is unchanged, because a privacy toggle is not a content edit (§5.3) |
| UAT-13 | Switches through all four interface variants | Four distinct dictionary labels and four distinct notification texts; the candidate's own name and the employer's message are untouched |
| UAT-14 | Temporarily blocks a user | Mutations refused with a localized reason, an `account_status_history` row and an audit row; lifting it writes its own |
| UAT-15 | A vacancy deadline expires | New applications refused, gone from both discovery feeds, still visible to its owner |
| UAT-16 | First employer registration | Wallet created and exactly ten Coins credited - then three further attempts credit nothing, which is §6.6's logout/reinstall/device-change/role-switch clause as one index |
| UAT-17 | Unlocks a new candidate with 10 Coins | Two Coins debited, balance 8 - then the whole clause: the phone number and the file list appear with `exposureReason: 'candidate_unlock'`, and §9.1 chat opens. Asserted from the locked state first, so it proves the change rather than the end state |
| UAT-18 | Revisits an already-unlocked candidate | Nothing charged, `charged: false`, balance still 8, entitlement intact (BR-16) |
| UAT-19 | Attempts an unlock holding fewer than 2 Coins | Refused with `wallet.insufficient_coins`, no entitlement written, and the wallet reports what an unlock costs and which providers can take a top-up |
| UAT-20 | Buys 10 Coins through Payme at the initial price | UZS 100,000 order, then Payme's own `CheckPerformTransaction` → `CreateTransaction` → `PerformTransaction` in tiyin with a real Basic credential; order `paid`, exactly 10 Coins credited |
| UAT-21 | Buys Coins through CLICK | `Prepare` then `Complete`, both MD5-signed, the completion signed over the `merchant_prepare_id` the preparation handed out; order `paid`, Coins credited once |
| UAT-22 | The same successful callback delivered twice | Second delivery still answers success - telling a provider otherwise makes it retry forever - and the ledger holds exactly one `top_up` row. A second test does it **concurrently** |
| UAT-23 | A Payme/CLICK payment fails or is cancelled | Both providers: no Coins credited, both orders `cancelled` with the provider's reason visible in the Wallet list, and a retry opens a new order |

Two things are simulated, and both say so at the line where they happen: the SMS that
would carry an OTP (no provider is connected - `OTP_ECHO_IN_RESPONSE` returns the code
instead), and the passage of time in UAT-15, which is one raw `UPDATE` because the write
path correctly refuses a deadline in the past.

**Nothing about the payment providers is simulated except the providers themselves.** The
callbacks go in through the real entry point with real Basic credentials and real MD5
signatures, computed in the test from CLICK's documented field order rather than borrowed from
the adapter - a signature check verified against its own implementation verifies nothing. What
is absent is Payme's and CLICK's servers, which is what a sandbox account is for (§12.6, and
[PAYMENTS.md](PAYMENTS.md)).

**These tests found no defect on their first run.** Every failure was the test naming
something the code does not - `draft` for `not_submitted`, `employer_verified` for
`verification_decided` - which is the expected shape for a file written from the
specification rather than from the source.

The M13 additions did find one, and not from the UAT rows: `payments.int.spec.ts` reused a
constant provider transaction id, which collided with a row an earlier run had left behind
(the trail is append-only, so the suite cannot tidy up). That surfaced a real bug - a
`CreateTransaction` naming another order's transaction id threw a raw database error out of the
transaction, rolling back the event row that explained it and answering the provider with a 500
instead of `-31008`.

## What else the suites hold

Beyond the scenarios themselves, the parts worth naming to a reviewer:

- **The authorization surface as a whole** (`infra/api/api-surface.spec.ts`): the set of
  public routes is frozen at twelve, each with a written reason - the last two are M13's provider callbacks, the first public **mutating** routes in the product; every `/admin/*` route is
  checked to require the admin role; and the controller list is checked against
  `app.module.ts`, so a module cannot escape the audit by being forgotten.
- **Injection** (`candidate-search/search-query.spec.ts`): a hostile string pushed through
  twelve filters at once reaches Postgres only as a bound parameter.
- **Immutability** (`admin.int.spec.ts`): the audit log refuses `UPDATE`, `DELETE` **and**
  `TRUNCATE` at the database. `wallet.int.spec.ts` and `payments.int.spec.ts` prove the same
  for the Coin ledger and the payment event trail, including the `UPDATE` matching no rows
  that a row-level trigger would let through.
- **A privacy rule with three inputs** (`infra/privacy/contact-exposure.spec.ts`, 14 tests):
  every combination of viewer, visibility and entitlement, asserting the **reason** and not
  only the outcome. Two of them exist because M12 made an entitlement purchasable - that an
  unlock cannot buy past §7's verification gate, and that it survives the candidate hiding
  their profile. The plumbing is `applications/unlock-gating.int.spec.ts` (11 tests), which
  includes the property that made the retrofit cheap: §9.1's chat gate inherited the new
  entitlement without a line of chat code changing.
- **Races** (`invitations.int.spec.ts`, `applications.int.spec.ts`): two concurrent
  invitations and two concurrent applications, proving the partial unique indexes rather
  than the service checks.
- **BR-09 contact exposure**, including the regression where a view requested through a
  *withdrawn* application re-granted access - caught by an M6 test after an M7 change.
- **BR-14's purge** (`retention.int.spec.ts`): an account entangled with a company logo,
  verification evidence and a message attachment, which is the shape a plain
  `DELETE FROM users` fails on.

## Known gaps in the evidence

- **No load test in CI.** §12.4's budgets are measured on demand by `pnpm perf`, with the
  numbers in [PERFORMANCE.md](PERFORMANCE.md); nothing re-checks them automatically.
- **No CI workflow yet.** The suites run locally and before every commit. Wiring them to a
  pipeline is an open M0 item.
- **The Telegram file service is stubbed in tests** that are about *who may read a file*
  rather than about Telegram. `files.int.spec.ts` covers the real client.
- **No test drives the Flutter client**; this is the backend's evidence only.
- **No payment provider has ever answered one of these calls.** Both protocols are exercised
  with real signatures in both directions, but §12.6 requires testing in the *provider's* test
  environment before production credentials are activated, and that needs an account. Until
  then the gap is theirs-against-ours, not ours ([PAYMENTS.md](PAYMENTS.md)).
- **The integration suites accumulate rows in the dev database on purpose.** Employers who
  hold a wallet, administrators who have acted, and every payment event are all protected by
  `RESTRICT` or an append-only trigger, so no suite can delete them - which is the guarantee
  under test, working. The fixtures therefore ask the unique index for a free phone number
  rather than assuming a random one is free.
