# Testing evidence (§13.2)

§13.2 asks for "functional, integration, and acceptance-test results for agreed
scenarios". This is that, plus the command that reproduces it - a result nobody can re-run
is a screenshot.

**As of 2026-08-10, on schema version 18: 847 tests, all passing.**

| Suite | Command | Suites | Tests | Needs Postgres |
|---|---|---|---|---|
| Unit / functional | `pnpm test` | 24 | 439 | no |
| Integration | `pnpm test:int` | 19 | 408 | yes |
| **Acceptance (UAT-01..15 of 24)** | `pnpm test:int -- --testPathPattern uat` | 1 | 16 | yes |

The acceptance suite is a subset of the integration one; 847 is the sum of the first two
rows, counted once.

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

## Acceptance: fifteen of the twenty-four agreed scenarios

> **The 2026-08-10 specification revision raised §13.1 from 15 scenarios to 24.**
> UAT-16..UAT-23 are the wallet, Candidate Unlock and Payme/CLICK scenarios and are
> **not covered** - they belong to M12 and M13, which are not built. UAT-24 is a
> restatement of UAT-13 and is covered by it. The fifteen below are the original set and
> all pass; three of them (UAT-03's CV access through an application, UAT-07's invitation,
> UAT-09's interview) assert the **pre-revision** BR-09 contract and will change with
> M12's retrofit - see [SPEC_CHANGELOG.md](SPEC_CHANGELOG.md).

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

Two things are simulated, and both say so at the line where they happen: the SMS that
would carry an OTP (no provider is connected - `OTP_ECHO_IN_RESPONSE` returns the code
instead), and the passage of time in UAT-15, which is one raw `UPDATE` because the write
path correctly refuses a deadline in the past.

**These tests found no defect on their first run.** Every failure was the test naming
something the code does not - `draft` for `not_submitted`, `employer_verified` for
`verification_decided` - which is the expected shape for a file written from the
specification rather than from the source.

## What else the suites hold

Beyond those fifteen scenarios, the parts worth naming to a reviewer:

- **The authorization surface as a whole** (`infra/api/api-surface.spec.ts`): the set of
  public routes is frozen at eleven, each with a written reason; every `/admin/*` route is
  checked to require the admin role; and the controller list is checked against
  `app.module.ts`, so a module cannot escape the audit by being forgotten.
- **Injection** (`candidate-search/search-query.spec.ts`): a hostile string pushed through
  twelve filters at once reaches Postgres only as a bound parameter.
- **Immutability** (`admin.int.spec.ts`): the audit log refuses `UPDATE`, `DELETE` **and**
  `TRUNCATE` at the database.
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
