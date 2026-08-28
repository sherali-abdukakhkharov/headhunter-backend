# headhunter-backend — working notes

NestJS API for **JobBridge**, a mobile-only recruitment platform for
Uzbekistan. The Flutter client lives at `d:\Dev\tgbots\headhunter-app`; a Claude
Code session rooted there can edit this repo too (see that repo's
`.claude/settings.json`).

## Which document to read

| File | Contents |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | The client specification. **Cite it** as §n, BR-nn, UAT-nn. |
| [docs/SPEC_CHANGELOG.md](docs/SPEC_CHANGELOG.md) | What changed between client revisions. **Read before assuming a section is unchanged.** |
| [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) | Frozen client-facing contracts. Read before touching a client-visible response. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design decisions and the data model. Read before adding a module. |
| [PLAN.md](PLAN.md) | Milestones in dependency order, mapped to BR/UAT. |
| [TODO.md](TODO.md) | Working checklist and the open blocking decisions. |
| [MEMORY.md](MEMORY.md) | Why decisions were made; traps already paid for. |
| [README.md](README.md) | Stack, commands, structure, environment gotchas. |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | The Cloudflare tunnel at hh.qitmir.uz, and what changes when the API is public. |
| [docs/SMS_PROVIDER.md](docs/SMS_PROVIDER.md) | Eskiz.uz: connected and delivering; the runbook, and the two-logins trap that cost an outage. |
| [docs/PAYMENTS.md](docs/PAYMENTS.md) | Payme and CLICK: both protocols, what to ask on purchase, and the three client questions — two answered, one half. |
| [docs/BACKUP.md](docs/BACKUP.md) | The daily dump, and the **rehearsed** restore with its real output. |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | §12.4 measured at 200k profiles, and the volume that would break it. |
| [docs/RETENTION.md](docs/RETENTION.md) | BR-14 as data: what is purged, when, and what the client still owes. |
| [docs/SUPPORT.md](docs/SUPPORT.md) | The runbook: symptoms, causes, and what needs a decision instead. |
| [docs/TEST_EVIDENCE.md](docs/TEST_EVIDENCE.md) | §13.2's test results, and the UAT-to-test mapping. |
| [docs/TEST_ACCOUNTS.md](docs/TEST_ACCOUNTS.md) | The ten seeded tester accounts: numbers, fixed codes, and what each one is in the middle of. Hand this to a QA pass. |
| [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) | §12.5 point by point: what is held, how, and the one gap left. |
| [docs/TELEGRAM_LOGIN_SETUP.md](docs/TELEGRAM_LOGIN_SETUP.md) | BotFather and Flutter setup for Telegram login *(deprecated path)*. |

Before implementing anything from the spec, check ARCHITECTURE.md first — several
requirements have already been designed against, and the reasoning is not
re-derivable from the text.

## Domain rules that are easy to get wrong

- **Filters take dictionary IDs, never labels.** BR-13: one stable ID, four
  localized labels. If you find yourself comparing translated text, stop.
- **Structured fields are authoritative for search; the CV is an attachment.**
  There is no CV parsing in this product (§1, §5.4).
- **A user may hold several roles.** Ask "may this user, acting as `active_role`,
  do this to this resource" — never "what role is this user" (§2.3).
- **Administration is a mobile role, not a web panel.** Admin endpoints are
  normal routes with strict guards (§10).
- **Every status change writes an audit row in the same transaction** (BR-08).
  Status update without history is a bug.
- **Blocked accounts are refused every mutation** (BR-10) — enforced by a guard on
  all mutating routes, not per module.
- **Contact details go through the one BR-09 helper.** Never inline the rule. Since M12 it has
  **three** granting inputs — an application, an accepted invitation, and a bought Candidate
  Unlock — and two properties that are load-bearing rather than incidental: `hasUnlock` must be
  part of the *denying* condition too (or an employer who paid loses access when the candidate
  hides their profile, silently), and `not_verified_employer` must keep short-circuiting first,
  because §7 is a precondition nobody may **buy** past. ARCHITECTURE.md §8 has both arguments.
- **User-facing text is never written at a throw site.** Add a key to
  `src/infra/i18n/messages.ts` with all four labels and throw a
  `LocalizedException` subclass carrying it; only `ApiExceptionFilter` knows the
  request's `x-lang`. The key is also the client-visible error `code`.
- **Never give a client a Telegram file URL.** It embeds the bot token. File bytes
  are proxied through this API after an ownership check (ARCHITECTURE.md §9).
- **Five settings are refused at boot when `NODE_ENV=production`**, not warned
  about: `OTP_ECHO_IN_RESPONSE`, `OTP_STATIC_CODE`, a plaintext
  `TELEGRAM_JWKS_URL`, and — since 2026-08-27 (MT-003) — `MODERATION_ENABLED`
  and `EMPLOYER_VERIFICATION_ENABLED` being **false**. Both stay flags because an
  instance with no administrator has to be able to turn review off; a production
  instance has `SEED_ADMIN_PHONES`, and seeding runs against the database rather
  than through this API, so there is no ordering problem.
  Refusing rather than warning is the finding: three consecutive audits found
  `MODERATION_ENABLED=false` on the deployed API *while the warning printed on
  every start*. `env-schema.spec.ts` covers all five — they had been trusted and
  untested, which is a boot check that can stop working silently.
- **Login is phone + OTP** (§4.1). **Eskiz delivers, and codes are random, since 2026-08-20**
  — connecting the provider was two environment variables and no code change, which is what
  the `SmsSender` seam was for ([docs/SMS_PROVIDER.md](docs/SMS_PROVIDER.md)).
  `OTP_STATIC_CODE` is cleared; it substituted at the one line a random code is generated, so
  everything downstream was always the production path — never add a second acceptance path in
  `verify`, and never relax the TTL, the attempt limit or single-use consumption because "it's
  only the dev code". `OTP_ECHO_IN_RESPONSE` has been off since 2026-08-20 and
  **`NODE_ENV=production` since 2026-08-27** — this paragraph claimed the second one for a
  week while the container reported `development`, so the schema was refusing nothing and
  `OTP_STATIC_CODE=666666` was live on a public host. Both are true now, checked against
  the running container. §4.1 is closed, and reopening any refused setting stops the
  container instead of weakening login. Three rules here are easy to undo: issuing and delivering are separate methods,
  because an HTTP call inside the issuing transaction holds a row lock for the provider's
  latency; a *failed* send deletes its code, or the resend delay locks the user out over a
  message that never arrived; and `sms_not_configured` is **exempt** from that deletion while
  `sms_transport_failed` is not. That last asymmetry is why a *misconfigured* provider takes
  login down while *no* provider does not — it cost an outage, and the reasoning is in
  MEMORY.md under 2026-08-20.
- **Ten tester accounts sign in with a fixed code, and that is not a second
  acceptance path.** `demo_accounts` holds one code per phone; `OtpService`
  substitutes it at the same single line `OTP_STATIC_CODE` used, so the hash, the
  TTL, the attempt limit, single-use consumption and the one shared
  `auth.otp_invalid` are all untouched — `verify` does not know demo accounts
  exist. What is different is delivery: the provider is never called for them, so
  nothing is charged and nothing can fail. Two gates guard the lookup, and the
  first is checked in memory so a real login never reaches the table: the phone
  must be in the `+99801` reserved range, and `DEMO_ACCOUNTS_ENABLED` must be on.
  **That flag is deliberately allowed in production** where the other two are
  refused, and the reason is the range: Uzbekistan's numbering plan cannot
  allocate a number whose first digit after the country code is `0`, so there is
  no real account it can reach — while production is exactly where the QA pass
  runs. A reserved number with no row is refused rather than handed to Eskiz.
  `pnpm seed:demo:clean` deletes the rows and the capability goes with them.
  See [docs/TEST_ACCOUNTS.md](docs/TEST_ACCOUNTS.md).
- **Telegram login is deprecated but still works** (`POST /auth/telegram`). If you
  touch it: an `id_token` is trusted only after signature, issuer, `aud` = our bot id
  and `iat` age all pass, and an account is never matched on a phone Telegram did not
  mark verified. Both paths issue sessions through the same `AuthService`.
- **`OTP_LOGIN_ENABLED` off answers 404, not 403** — a disabled endpoint should be
  indistinguishable from one that never existed.
- **The caller's IP comes from `resolveClientIp`, never `req.ip` directly.** Behind
  Cloudflare, `X-Forwarded-For` has the user first and the edge second - the opposite
  of what Express's hop count reads - so per-IP limits must key off
  `CF-Connecting-IP`, and only when `CLIENT_IP_HEADER` names it.
- **The field schema is one declaration, not three.** `modules/schemas/*.schema.ts`
  is the client's form, the server's write-routing/validation table *and* the
  completeness definition. Never add a parallel list of required fields, a mapping
  from field code to column, or a second copy of a label — API_CONTRACTS.md §4.1
  promises every `requiredForSearchable` code resolves to a rendered field, and one
  declaration is what makes that true by construction. Bump its `version` and run
  `pnpm seed` when a change needs clients to refetch.
- **`completeness_percent` and `is_complete` answer different questions.** The
  percentage is over every field of the category; `is_complete` is over the required
  ones only, and is BR-02's gate. Never derive one from the other — a threshold on
  the percentage would let a profile with no occupation into search.
- **A calendar date is a `'YYYY-MM-DD'` string end to end**, never a `Date`. `date`
  columns are typed as strings (`--date-parser string` plus `infra/db/pg-types.ts`,
  which are a pair). "Today" comes from `formatDateOnly(new Date(), zone)`, never
  `toISOString().slice(0, 10)` — in Tashkent that is yesterday for five hours a day.
- **Privacy toggles must not refresh `last_meaningful_update_at`** (§5.3, §7.3). This
  is structural, not conditional: visibility has its own route, and every *content*
  write goes through `CandidatesService.refreshDerived`. Keep it that way rather than
  adding a "was this meaningful" branch.
- **Race-shaped rules belong in the database**: BR-07 is a partial unique index,
  BR-06 is checked inside the insert transaction.
- **Never throw from inside a transaction that already wrote something.** Kysely
  rolls back on a rejected callback, so the write disappears and only the
  exception survives. Return an outcome from `transaction().execute()` and throw
  after the commit. This cost two M1 security bugs — an OTP attempt counter and a
  session-family revocation, both undone by the very throw that reported them —
  and both had passing tests, because the tests asserted the exception rather
  than the side effect.
- **Never hard-delete a dictionary item** — deactivate, and use `merged_into_id`
  for merges, so historical references still resolve.
- **Every guarantee about money is a database constraint, not service code** (§12.3.1, M12
  and M13). The ledger is append-only by trigger, BR-16 is a primary key, BR-15 is a partial
  unique index, and BR-19 — one credit per payment order however many times a provider
  retries — is *four* things in four places: a row lock, a conditional
  `UPDATE ... WHERE status = 'pending'`, a unique index on the ledger's `reference_id`, and
  one on `(provider, provider_transaction_id)`. Each catches what the others cannot; do not
  simplify one away. A rule about money that lives only in application code holds until the
  second caller. ARCHITECTURE.md §10b has the reasoning.
- **Coins are credited from a verified provider callback and nowhere else** (§6.7: "a
  client-side success redirect is not sufficient"). One method does it. No route an
  employer's own client can reach is on that path, which is why the callbacks live in their
  own controller — the first public **mutating** routes in the product, listed in
  `api-surface.spec.ts` with the argument written out. A provider adapter translates the wire
  format in both directions and **never touches the database**; the state machine is the
  service's. Provider responses carry the provider's own error vocabulary and are never
  localized: a provider is not a person.
- **Retention periods are declared, never inlined.** `infra/retention/retention-policy.ts`
  is the one table, each rule tagged with where its number came from. Never hard-code a
  cut-off at a call site — and never delete a user with a plain `DELETE`: three tables
  hold `RESTRICT` references to `stored_files` and the cascade reaches the files first,
  which is why `RetentionService` clears them in order. An account that has acted as an
  administrator is **anonymized, never deleted** (§10.4 owns that constraint).

Read `README.md` for stack, commands, structure and the list of environment
gotchas. The rest of this file covers how to work in the codebase.

## Coding principles, in priority order

**1. KISS.** Always pick the simplest thing that works. A complex solution means
more bugs and harder comprehension. If code needs explaining, simplify it.

**2. DRY.** The same logic should not live in two places. Abstract after the
third repetition, not before — sometimes duplication is better, because two
similar pieces of code often need to change in different directions.

**3. SOLID, applied where complexity justifies it.**
- *Single responsibility* — always: one function, one job.
- *Open/closed* — once there are 3+ types or cases, use an extension pattern.
- *Liskov* — only relevant when actually using inheritance.
- *Interface segregation* — split an interface once it reaches ~5 methods.
- *Dependency inversion* — always; NestJS DI already provides it.

**Do not add complexity** when there is only one use case today, when the reason
is "we might need it later", or when an abstraction would have exactly one
implementation.

**Stop and reconsider** when a function exceeds 20 lines, a file exceeds 200
lines, you need three layers of abstraction, or you have failed at the same
approach three times — change approach rather than pushing harder.

## Conventions

- **Env vars are validated at boot**, never read ad hoc. Add to `AppEnv` and the
  Joi schema in `src/infra/env-schema.ts`, then read via
  `ConfigService<AppEnv, true>` with `{ infer: true }`.
- **Database access goes through the `KYSELY` token**:
  `constructor(@Inject(KYSELY) private readonly db: Database) {}`. Kysely is a
  query builder — write SQL-shaped queries, do not build an ORM layer over it.
- **Every endpoint is documented.** `@ApiTags`, `@ApiOperation` and a DTO-typed
  `@ApiOkResponse`; the DTO carries `@ApiProperty` on each field. The Swagger
  document is the contract the Flutter client is written against.
- **Health checks never throw.** A failing dependency is reported as `degraded`
  with a 200, so monitoring can distinguish "up but Postgres is down" from "not
  responding".
- **`any` is an ESLint error** outside `migrations/` and `*.spec.ts`.
- Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before
  committing. `pnpm build` runs the full type check too.

## Testing

Two suites, split by whether they need Postgres:

- `pnpm test` — `*.spec.ts`, database-free, runs anywhere.
- `pnpm test:int` — `*.int.spec.ts` against the dev database via
  `createIntTestDb()`. Everything enforced by a trigger, a row lock, a partial
  unique index or a transaction boundary belongs here: over `DummyDriver` those
  tests would compile the query, run nothing, and pass while the behaviour was
  entirely absent. Fixtures go in through the production write path (the seeder,
  the service) and clean up after themselves.

Unit tests use Nest's `Test.createTestingModule`. For anything touching the
database, build a **real** `Kysely` instance over `DummyDriver` rather than
mocking Kysely's internals — see `src/modules/health/health.service.spec.ts`.
Queries are then genuinely compiled (a malformed query still fails the test)
while nothing connects. Subclass `DummyDriver` and reject in
`acquireConnection()` to simulate an unreachable database.

Mocking `db.executeQuery` does **not** work: `sql\`...\`.execute(db)` goes
through `db.getExecutor()` → `transformQuery` → `compileQuery` → `executeQuery`,
so a naive stub silently takes the error path.

## The client contract

`GET /health` returns `HealthResponseDto`. Its Dart counterpart is
`HealthStatus` in
`headhunter-app/lib/src/features/health/domain/health_status.dart`.
**Change both together** — the Dart model is generated from hand-written field
declarations, so a rename here is a silent deserialization failure there.

## Adding a feature module

1. `src/modules/<feature>/` with controller, service, `dto/`, and `<feature>.module.ts`.
2. Register the module in `app.module.ts`.
3. Add a migration under `migrations/`, run `pnpm migrate:latest`, then
   `pnpm kysely:generate` to refresh `database.types.ts`.
4. Write the spec alongside the service.
5. Mirror any new response DTO in the Flutter app.
