# headhunter-backend - TODO

Working checklist. Milestone definitions and ordering are in [PLAN.md](PLAN.md);
design rationale in [ARCHITECTURE.md](ARCHITECTURE.md).

Convention: `[ ]` open · `[x]` done · `[~]` in progress · `[?]` blocked on a
decision (see the bottom section).

---

## Blocking decisions to resolve first

These change schema or dependencies, so settle them before the milestone that
needs them.

- [x] ~~**File service**~~ - **Telegram Bot API**, decided 2026-08-04 (client
      direction). Bytes go to one fixed chat with `sendDocument`; `stored_files`
      holds the metadata; downloads are proxied through this API because the
      Telegram file URL carries the bot token. Ceiling is 20 MB - `getFile`'s
      download limit, not the 50 MB send limit. See ARCHITECTURE.md §9. *No longer
      blocks M3.*
- [x] ~~**Push provider**~~ - deferred with M9 to after M10 (client direction
      2026-08-04). Recommendation stands: FCM only, APNs key uploaded to Firebase.
      Not an MVP blocker.
- [x] ~~**Time zone policy**~~ - single platform zone `Asia/Tashkent`, decided
      2026-08-04 and agreed with the client. `timestamptz` storage, responses carry
      offset + explicit `timeZone`. Per-user later is additive (`users.time_zone`)
      and changes no wire format. See [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) §2.
- [x] ~~**Retention periods** for deleted accounts and audit logs~~ (BR-14 defers
      to an approved privacy policy we do not have) - **no longer blocking, and
      the last blocking question to come off this list.** Resolved as *data*, the
      third time that pattern has worked: every period is declared in
      [retention-policy.ts](src/infra/retention/retention-policy.ts) with a
      `provenance` tag and a stated legal basis, and returned by
      `GET /admin/retention/policy`. `provisional` means an engineer chose the
      number and no lawyer has seen it, which is every period but one. The purge
      is triggered by an administrator rather than a timer, precisely because they
      are provisional. See [docs/RETENTION.md](docs/RETENTION.md) for what the
      client still has to confirm
- [x] ~~**Individual-employer verification evidence**~~ (§6.1 "if required by
      policy") - **no longer blocking.** Resolved as *data*: the requirement is
      declared per employer type in
      [employer-requirements.ts](src/modules/employers/employer-requirements.ts)
      with a provenance tag and a note, so the client's answer is one edit to one
      file. The current default is that an individual employer need not upload an
      identity document, and a company must upload a registration certificate.
      What remains is sign-off, not delivery.
- [x] ~~**Permitted age/gender justifications**~~ (BR-12) - **no longer blocking.**
      Enumerated as *data*, the same way the employer evidence rules were: five
      permitted reasons in
      [age-gender-justifications.ts](src/modules/vacancies/age-gender-justifications.ts),
      each with a provenance tag and an argument, plus a
      `restriction_justification` dictionary for the four labels. Each reason
      declares which restriction kinds it can support, so a gender restriction
      justified by a minimum-age rule is refused. **Wants legal review** - nothing
      on that list has been seen by a lawyer, which is why every entry is tagged
      `default`.
- [?] **Does a candidate's own application still reveal their contact details?**
      *(2026-08-10 revision. **Answered by the team on 2026-08-19 and shipped**; still wants
      the client's sign-off, and blocks nothing.)*
      §11.1 says contact and CV become available "only after a successful Candidate Unlock
      **or another explicitly approved entitlement**", and §9.1, read strictly, says an
      application is *not* one - which would supersede M6's delivered BR-09 behaviour.
      **The answer taken: an application *is* an approved entitlement**, as is an accepted
      invitation. A candidate who applies has volunteered their interest in that employer,
      which is the reading every other recruitment product takes and the one §11.1's own
      escape hatch allows. So the unlock is for candidates who have **not** applied, and
      M6, M7, M8 and their tests are untouched.
      It was taken rather than waited on because the client's unlock UI was blocked on it and
      the alternative reading is strictly larger - it can still be built later. **If the
      client overrules it**, the cost is real: two reason codes invert meaning
      (`application` stops granting, `unlock_required` starts appearing where an application
      exists) and M6, M7 and M8 all need revisiting. Nothing about the purchase, the ledger
      or the entitlement changes.
- [?] **Payme and CLICK merchant accounts** *(blocks switching M13 on, and nothing else
      now)* - **the code is finished and verified.** Both adapters, both callback routes,
      exactly-once crediting and 65 tests are in; with no credentials the adapters refuse
      every callback and `GET /payments/providers` answers with an empty list, so the
      product is complete and honest without an account. Same shape as Eskiz: it cannot be
      *switched on* without one.
      Everything to ask for is in [docs/PAYMENTS.md](docs/PAYMENTS.md) - merchant ids and
      secret keys for both, plus the callback URLs to register. **The harder half is not
      the credentials but the host**: a production merchant account should not point at
      `hh.qitmir.uz`, which is a Cloudflare tunnel on a developer machine, and
      re-registering a callback URL later is a support ticket with the provider.
- [?] **Fiscal receipt attributes** *(§6.7)* - **not blocking a payment, only a receipt.**
      §6.7 leaves the service/product code, VAT and merchant configuration to "the
      Client/accounting function", so it is declared as data in
      [payment-fiscal.ts](src/modules/payments/payment-fiscal.ts) with a `provenance` tag -
      the fourth time that pattern has answered an open question here. **While it reads
      `unknown` no receipt is sent to either provider**, and a unit test asserts that: a
      guessed IKPU code on a real transaction ends up on a tax return rather than in a log.
      One edit to one file when the codes arrive.
- [?] **Who absorbs a refund of Coins that were already spent?** *(new with M13)* BR-16
      makes an unlock permanent, so a reversal can only recover what is still in the wallet.
      The code takes `min(balance, coins)` and writes the shortfall into the ledger row's
      reason, because a full debit would drive the balance negative, which the database
      refuses - and a refused transaction would leave the order stuck at `paid` while the
      provider believed it was refunded. The data stays honest either way; **who eats the
      difference is a commercial decision**, and there is a test for the case.
- [?] **§12.7: which payment channel ships per storefront** *(new)* - Coins unlock
      in-app digital functionality, so Apple and Google may require their own billing
      rather than Payme/CLICK. The specification requires the ledger to stay
      provider-agnostic so the answer is a configuration choice rather than a rebuild,
      and M13 is designed that way - but somebody has to **verify the store rules
      immediately before release**, which §12.7 says explicitly.
- [?] **Approved dictionary value lists** from the client (§13.2). **No longer
      blocking anything.** All 16 types are seeded and working - 575 items, 2 300
      labels - so M3, M5, M6 and the UAT-06 demo all have real values to select.
      What remains is *review*, not delivery: `occupation` (162), `skill` (118),
      `industry` (32), `language`, `skill_level`, `shift` and `education_level` are
      compiled starting sets rather than client-approved lists, and each states so.
      District-vs-city status and recent redistricting need checking against the
      official register. A correction is one edit plus `pnpm seed`.

---

## M0 - Foundations *(done)*

- [x] NestJS 11 + SWC, Biome/ESLint split, Jest via `@swc/jest`
- [x] Kysely + pg with pooled global provider, pool closed on shutdown
- [x] Migration runner (`tsx`, Windows-safe file URL provider)
- [x] Joi env validation at boot, pino logging with redaction
- [x] helmet, CORS, global `ValidationPipe`, Swagger `/docs` + Scalar `/reference`
- [x] `GET /health` verified from the Flutter client on an emulator
- [x] Add `docs/` deliverables scaffold: deployment, backup/restore notes (§13.2) -
      delivered in M11 as DEPLOYMENT, BACKUP, SUPPORT, PERFORMANCE, RETENTION,
      SECURITY_REVIEW and TEST_EVIDENCE
- [x] **Dockerfile** - multi-stage, runtime carries `dist` plus production
      dependencies only, non-root, tini for signals, healthcheck on `/health`.
      `docker-compose.api.yml` runs it as `headhunter-api` and the tunnel origin is
      now `http://api:3001`; `pnpm api:up` is the whole redeploy. Migrations stay a
      deliberate host command - a container that migrates at boot races itself the
      moment there are two
- [~] **CI workflow - deferred indefinitely, client direction 2026-08-19.** The owner will
      set this up himself when the service goes to production; **do not count it as
      outstanding backend work.** Kept here rather than deleted so the design is not
      re-derived later: the image build is the natural place to hang it, because
      `nest build` inside the Dockerfile already type-checks, so CI is `docker build` plus
      the two test suites. Two things belong in it that exist only as commands today -
      `pnpm docs:openapi` with a check that `docs/openapi.json` came back **unchanged** (a
      stale committed contract is worse than none), and `pnpm perf` against §12.4's budgets.
      Until then `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before every
      commit is the whole of the gate

## M1 - Auth, users, roles

### Schema *(done - `20260804130000_create_auth_tables`)*
- [x] `users` (id, phone unique, locale, status, created_at, ...)
- [x] `user_roles` (user_id, role) - many-to-many, **not** a column on users
- [x] `otp_codes` (phone, code_hash, purpose, expires_at, attempts, consumed_at)
      - `phone` is deliberately not a FK: a registration OTP precedes the user row
      - partial unique index keeps **one unconsumed code per (phone, purpose)**, so
        a retrying client supersedes rather than accumulates
- [x] `sessions` (id, user_id, device fingerprint, refresh token hash, revoked_at)
      - plus `family_id` and `replaced_by_session_id`: reuse detection revokes the
        whole rotation family in one statement instead of walking the chain
- [x] `account_status_history` (actor, from, to, reason) - feeds UAT-14 audit
- [x] `deletion_requests` (user_id, requested_at, confirmed_at, purge_after)
      - partial unique index allows one open request per user
      - `purge_after` stays nullable until BR-14 retention is answered
- [x] Native enums `locale_code`, `user_role`, `account_status`, `otp_purpose` -
      kysely-codegen turns these into string-literal unions rather than `string`

### Login: phone + OTP *(the live path - client direction 2026-08-05, second)*
`OTP_LOGIN_ENABLED=true` (now the default). Telegram login is deprecated, below.

- [x] `POST /auth/otp/send`, `/auth/otp/resend`, `/auth/otp/verify` serving again
- [x] `OTP_STATIC_CODE=666666` so login works with **no SMS provider bought**. It
      substitutes at code generation only, so TTL, supersession, the resend delay,
      the attempt limit and single-use consumption are the production path. Joi
      refuses a non-empty value when `NODE_ENV=production`, and a length that
      disagrees with `OTP_LENGTH` fails at boot
- [x] Tests: the fixed code verifies, is consumed on first use, does not make wrong
      codes pass, and a wrong-length value refuses to boot
- [x] **Build the Eskiz.uz integration** - done, behind the same seam as push:
      `SmsSender` with `EskizSmsSender` and `LoggingSmsSender`, chosen at boot from
      `ESKIZ_EMAIL`. Issuing and delivering are separate methods (an HTTP call inside
      the issuing transaction would hold a row lock), a failed send deletes its code (or
      the resend delay locks the user out over a message that never arrived), and a
      failure is a 502 rather than a silent success. 11 unit tests over a stubbed
      `fetch`, 4 integration tests over the real table
- [ ] **Buy the account and connect it** - two environment variables and a redeploy;
      the runbook is at the end of [docs/SMS_PROVIDER.md](docs/SMS_PROVIDER.md).
      *Blocked: not bought yet.* **Nothing has been run against a real account**
- [ ] Submit the OTP message for template approval (four interface variants, or a
      client decision to use one). Approval turnaround is the long pole, not the code
- [ ] Clear `OTP_STATIC_CODE` and `OTP_ECHO_IN_RESPONSE` once a provider sends -
      production boot already refuses both, so this is a staging-hygiene item
- [ ] Flutter client: replace the Telegram sign-in screen with phone + code entry

### Login: Telegram *(deprecated 2026-08-05, still working)*
Superseded by the above after one day as the MVP path. Kept whole: the verification
is correct, the tests still run, and `POST /auth/telegram` still issues sessions
through the same `AuthService`, so an account can hold both credentials. Marked
`deprecated` in Swagger.

- [x] `POST /auth/telegram` - verifies a Telegram OIDC `id_token` against JWKS with
      **audience = our bot id**, the check that stops a token minted for another app
      signing someone in here
- [x] `iat` age window as the replay defence; `nonce` verified when present
- [x] `telegram_user_id` as the credential, `phone` nullable, CHECK requiring one
- [x] Account linking on a **Telegram-verified** phone, with a BR-08 audit row; never
      takes over an account another Telegram user already holds
- [x] `TELEGRAM_REQUIRE_PHONE` (default on) - BR-09 has nothing to reveal without one
- [x] Setup guide for BotFather + Flutter: [docs/TELEGRAM_LOGIN_SETUP.md](docs/TELEGRAM_LOGIN_SETUP.md)
- [x] 22 tests with real RSA keys and a local JWKS: forged signature, wrong audience,
      wrong issuer, expired, stale-but-unexpired, unknown `kid`, linking, takeover
- [~] Bind an OIDC `nonce`, verify on a device **without** Telegram installed, and
      complete one real end-to-end login against the live bot. All three were the
      open items when Telegram was primary; they are **parked**, not dropped, and
      only matter if it is made primary again

### Endpoints *(sessions, roles, users)*

- [x] `POST /auth/refresh` with rotation + reuse detection
- [x] `POST /auth/logout`, `POST /auth/logout-all`
- [x] `GET /auth/sessions`, `DELETE /auth/sessions/:id`
- [x] `POST /auth/roles` (select roles at onboarding), `POST /auth/active-role`
- [x] `POST /users/me/deletion-request` - in `users`, not `auth`: the module map
      gives account state to `users` (ARCHITECTURE.md §2)
- [x] `PATCH /users/me/locale`, plus `GET /users/me`

### Cross-cutting
- [x] Store OTP as a **hash**; never log codes or full phone numbers
- [x] Server-config TTL / resend delay / attempt limits via env + Joi
- [x] Rate limit OTP and auth per phone **and** per IP - `rate_limit_counters`,
      fixed window in Postgres so replicas cannot each grant the full budget.
      Phone subjects stored hashed; every 429 carries `Retry-After`
- [x] `TRUSTED_PROXY_HOPS` - per-IP limits need the real caller behind a proxy,
      and trusting `X-Forwarded-For` without one is a bypass. Default trusts
      nothing
- [x] `active_role` claim; server validates the role is actually granted
- [x] Guard stack: rate limit → authenticated → role → account status.
      *Ownership* is per-resource and arrives with the first owned resource (M3)
- [x] **BR-10 blocked-account guard on every mutating route**, by HTTP method in
      one global guard
- [x] Localized error messages, keys present in all four variants -
      `infra/i18n/messages.ts` is the only place a user-facing string is written,
      and the type makes a missing locale a compile error. `ApiExceptionFilter`
      renders per request `x-lang`; validation messages too (§3.2 names them
      explicitly). The catalog key doubles as a stable machine-readable `code`
- [x] Tests: OTP expiry, attempt lockout, code supersession, refresh reuse
      detection and family revocation, concurrent-rotation single winner, role
      switch to an ungranted role refused, blocked user refused at login
- [x] **Test: blocked user refused on each mutation kind** *(done 2026-08-19)*. Written as a
      pair, because the interesting property is not per-route: `api-surface.spec.ts` asserts
      that every mutating method the product **routes** is one `MUTATING_METHODS` recognises -
      the guard is global, so BR-10 was never at risk from a route that forgot it, only from a
      method the guard does not count as mutating - and
      `guards/account-status.guard.int.spec.ts` asserts the behaviour, enumerating the methods
      from that same set so a fifth is covered without anybody remembering. It also closed two
      cases nothing covered: a token outliving its account is refused, and an anonymous
      mutating request passes, which M13's provider callbacks made reachable

## M2 - Dictionaries

Wire shapes are frozen in [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) §3.

### Schema *(done - `20260804150000_create_dictionary_tables`)*
- [x] `dictionary_types` (code, `has_rank`)
- [x] `dictionary_items` (id, type_code, code, category, `item_group`, parent_id,
      sort_order, `rank`, is_active, merged_into_id, `revision`)
      - `item_group` is a second grouping used by `attribute` items only; it is an
        additive contract field, see API_CONTRACTS.md §3.4
- [x] `dictionary_item_translations` (item_id, locale, label, `revision`) - the
      pair is the primary key, so no separate uniqueness index is needed
- [x] Monotonic global `revision` sequence, **bumped by trigger** on every item
      and translation write. A write path that forgets to bump raises no error at
      all - the client simply never learns of the change - so it cannot be left to
      service code
- [x] A merge bumps the revision of **both** rows, so one delta carries the loser
      in `removed` (with `mergedIntoId`) and the survivor in `items`
- [x] `schema_versions`, ten rows generated from the two enums, so the manifest
      can publish them before the field schemas exist (M3/M5)

### Endpoints *(done)*
- [x] `GET /dictionaries/manifest` - per-type versions **and** the 10 schema
      versions. Locale-independent, so no `Vary`
- [x] `GET /dictionaries/{type}?since=<version>` with locale resolution, ETag,
      `Vary: x-lang`, 304 on `If-None-Match`, 404 on an unknown type
- [x] `GET /dictionaries/items?ids=` resolving inactive and merged ids, for
      historical records
- [x] Regions come from `type=region` via `parentId`, not a bespoke tree endpoint
- [x] All three are `@Public()`: the language and its pickers are chosen *before*
      registration (§3.2, §4.1)

### Cross-cutting
- [x] `x-lang` normalization to `uz-Latn | uz-Cyrl | ru | en`, accepting `uz`/`oz`
      aliases - strict allow-list, unknown → default
- [x] Responses always **emit** canonical casing, in `locale` and in the ETag
- [x] Fallback chain `uz-Cyrl→uz-Latn`, any→`en`, **with a warning log** (once per
      response, not once per row)
- [x] Reject activation of an item missing any of the four locales - a deferrable
      constraint trigger, so it holds against any write path including a manual
      SQL fix, and the required count is derived from the `locale_code` enum
- [x] Test: no dictionary endpoint can ever return a bare code as a label
- [x] Test: the same item resolves to one id via each locale (UAT-13)
- [x] Test: emitted locale casing is exactly the four canonical codes
- [x] Test: a second identical seed run bumps no revision - otherwise every
      deployment would make every client refetch every dictionary

### Seed content
`pnpm seed` applies [dictionary-seed.data.ts](src/modules/dictionaries/seed/dictionary-seed.data.ts),
idempotently. Not a migration: content is revised by the client far more often
than schema changes, and a migration could never correct a label in place.

Each type is tagged `spec` (enumerated in the specification), `default` (a
conventional list seeded so dependent milestones can be built - **client still
has to approve it**) or `awaiting` (a large list only the client can supply).

All 16 types are populated - **575 items, 2 300 labels**. The four large lists live
in `seed/data/`.

- [x] `region` - 14 first-level units **plus all 175 districts** by `parent_id`
      *(spec)*
- [x] `language_level` `A1..C2` + `native` with `rank` *(spec)*
- [x] `employment_type`, `work_format`, `payment_period`, `file_purpose`,
      `attribute` (licence / transport / tools / readiness groups) *(spec)*
- [x] `language`, `skill_level` with `rank`, `shift`, `education_level`
      *(default - needs client approval)*
- [x] `occupation` - 162 across all five §2.1 categories, each with its `category`
      *(default - starting set, needs client approval)*
- [x] `skill` - 118, grouped by family; `industry` - 32 *(default)*
- [ ] Client review of the four `default` lists, and of district-vs-city status
      against the official register. Content review, not a build task

### Seed invariants asserted by tests
- [x] Every item has all four labels, and no active item can exist without them
- [x] No Cyrillic in a `uz-Latn` or `en` label, and none missing from `uz-Cyrl` or
      `ru` - the content files use positional label helpers to stay reviewable at
      175 rows, so a swapped column has to be caught mechanically
- [x] Codes unique per type - a duplicate would silently overwrite the first row
- [x] Every district resolves to one of the 14 regions
- [x] Every occupation carries one of the five §2.1 categories

## M3 - Candidate profile + files *(done, except BR-09 - see below)*

Wire shapes are in [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) §4 and §4a.

### Schema *(done - `20260805120000_create_candidate_profiles`)*
- [x] `candidate_profiles` with `visibility`, `completeness_percent`,
      `is_complete`, `last_meaningful_update_at`, and `category` derived from the
      primary occupation
- [x] `candidate_occupations`, `candidate_skills`, `candidate_languages`,
      `candidate_experience`, `candidate_education`, `candidate_attributes`
- [x] Indexes from ARCHITECTURE.md §5 created **with** the tables, including the
      two partial indexes over `visibility = 'searchable' AND is_complete` that
      make BR-02's gate an index scan
- [x] Race- and coherence-shaped rules in the database: one primary occupation
      (partial unique index), exactly one value per attribute row (CHECK),
      negotiable-excludes-a-range (CHECK), `from <= to` (CHECK), no future or
      under-14 birth date (CHECK)
- [x] `gender_id` is a **dictionary reference, not an enum** - §4.2's `kind` union
      has no `enum` member, and BR-12 vacancy restrictions will reference the same
      ids. `gender` is seeded as a 15th dictionary type

### Field schemas *(done)*
- [x] `GET /schemas/candidate-profile?category=` - core and category sections
      together, ETag, `Vary: x-lang`, 304 on `If-None-Match`
- [x] One declaration drives the form, the write routing **and** completeness
      (`candidate-profile.schema.ts`), so a `requiredForSearchable` code cannot
      fail to resolve to a field
- [x] `pnpm seed` publishes the declared version into `schema_versions`, which is
      what the manifest and the ETag read
- [x] Contract tests over all five categories: every required code resolves, every
      dictionary type exists, all four labels present, `accept` is a subset of what
      the file service stores

### Endpoints *(done)*
- [x] `GET /candidates/me/profile` - an unstarted profile reads as empty with
      `isStarted: false` rather than 404, so the form has one code path
- [x] `PATCH /candidates/me/profile` - partial by field code, re-validated
      server-side against the same schema (§4.2 rule 3), 422 per field
- [x] `PUT /candidates/me/visibility` - its own route, and the only write that
      does **not** move `last_meaningful_update_at`
- [x] `GET/POST/PUT/DELETE /candidates/me/experience` and `.../education` - the
      bespoke repeating sections
- [x] `GET/POST/DELETE /candidates/me/attachments` - declared purposes only;
      exceeding a purpose's `maxCount` supersedes the oldest, which is how §5.4's
      "replace" works
- [x] Recompute completeness and the derived category on every content write, in
      the same transaction; expose the missing-field list with `required` flags
- [x] BR-02: `is_complete AND visibility='searchable'`, reported as `isSearchable`

### Files *(done in M0/M2 era, unchanged)*
- [x] File upload / download / delete with type and size validation
- [x] Authorized access without a public link - proxied, ownership-checked
- [x] ~~Type + size validation; no public links~~ - done in `infra/files`. Note the
      shape changed from the original plan: **no signed URLs**. The Telegram file
      URL carries the bot token, so downloads are proxied through this API instead,
      which is a stronger reading of §11.1 than a short-lived URL

### Tests *(done - 34 new unit, 28 new integration)*
- [x] Completeness maths, including that `isComplete` is not a threshold on the
      percentage
- [x] Every validator rule, over pure functions with injected dictionary facts
- [x] BR-02 gate end to end; privacy toggle does not refresh
      `last_meaningful_update_at`; a calendar date survives a round trip unshifted
- [x] One primary occupation across a change of primary; a leveled set rewrite
      removes an entry; an invalid field in a body writes nothing at all
- [x] Cascade from `users` through the profile to every child table
- [x] One candidate cannot read, update or delete another's records or files

### Deferred out of M3, delivered in M6
- [x] **BR-09 employer access to a candidate CV** - built once all three inputs
      existed (a verified employer from M4, an application from M6). The rule is one
      pure function, `infra/privacy/contact-exposure.ts`; `CandidateViewService`
      gathers its inputs and `GET /applications/:id/files/:fileId/content` serves the
      bytes. `GET /files/:id/content` stays **owner-only** - an employer's
      entitlement comes from the application, so the route that serves them is the one
      that can see it. Every access is logged with its decision reason (§11.1).
- [ ] Flutter: mirror `CandidateProfileDto`, `FieldSchemaDto` and the history and
      attachment DTOs (the app repo's M3)

## M4 - Employer profile + verification *(done)*

### Schema *(done - `20260805150000_create_employers`)*
- [x] `employers` (type: company | individual) + `companies` detail as its own
      table - §6.1 gives the two types different fields, and nullable columns for
      both on one table would make "which of these must be filled" a property of
      code rather than of the schema
- [x] `verification_submissions` + `verification_submission_files`, with a partial
      unique index allowing **one open submission** per employer
- [x] `employer_verification_history` - BR-08 for the verification machine, same
      shape as `account_status_history` so an auditor reads one layout
- [x] CHECK: `verified_at` is present exactly when the status is `verified`, so a
      rejection cannot leave a stale verification timestamp behind

### Endpoints *(done)*
- [x] `GET /employers/me` - 404 before creation, unlike the candidate profile:
      `type` decides which fields exist, so there is no neutral empty employer
- [x] `PUT /employers/me` - full replacement; `type` is immutable after creation
- [x] `GET /employers/me/verification` - state, past attempts and their reasons,
      plus the **required evidence list served as data**
- [x] `POST /employers/me/verification` - requires a complete profile and every
      required document, each owned by the caller
- [x] Status `not_submitted | under_review | verified | rejected | changes_required`
      + admin reason, transitions validated in one place, every one writing its
      BR-08 history row in the same transaction
- [x] `VerificationService.decide` - the administrator's decision with a mandatory
      reason for anything other than an approval (§6.1). M10 adds the queue and the
      route; the rules and the audit row live with the machine

### `EMPLOYER_VERIFICATION_ENABLED` *(off for the MVP)*
- [x] The same reasoning as `MODERATION_ENABLED` in PLAN.md's M5: the admin module
      is M10, so nobody *can* approve a submission, and BR-03 would park every
      employer in `under_review` forever - making the whole employer half of the
      product unreachable. With the flag off, submit goes straight to `verified`,
      **still writing its history row** with a null actor and an
      `auto_verified_no_reviewer` reason, and logging a warning on every use.
      Both paths are tested

### The open §6.1 decision, resolved as data
- [x] **`employer-requirements.ts` declares what each type must provide**, with a
      `spec | default` provenance tag and a note per value - the same pattern the
      dictionary seed uses. Current defaults: a company must upload a registration
      certificate; an individual **need not** upload an identity document. The
      asymmetry is deliberate and argued in the file: an individual hiring two
      seasonal workers is the case the product exists for, and storing scans of
      identity documents is a liability to accept only when a policy says to
- [ ] Client sign-off on those two defaults. A change is one edit to that file -
      no migration, no endpoint change, no client release. **No longer blocking**

### BR-03 *(the rule, ready for its callers)*
- [x] `EmployersService.gate` / `assertVerified` - the two conditions returned
      separately, because "finish your profile" and "wait for verification" are
      different refusals with different fixes. `canPublish` on the profile response
      is BR-03 in one field so no client re-implements it
- [x] Applied at the call sites as they arrived: vacancy submit (M5) and candidate search
      (M7, on every method of `CandidateSearchService`). Invitations are the last caller.
      Still not a guard, deliberately: the two conditions are different refusals and the
      routes want to say which

### Tests *(done - 10 unit, 21 integration)*
- [x] Completeness measured against that type's requirements only; missing-field list
- [x] Type immutability; company detail absent for an individual
- [x] Submission refused when incomplete, when a required document is missing, and
      when the file belongs to another account
- [x] Auto-verify writes an honest audit row (null actor, named reason)
- [x] Queued path: one open submission, BR-03 still blocking under review
- [x] Rejection and changes-required with a mandatory reason, then a resubmission
      keeping both attempts and three history rows
- [x] BR-03's gate across the whole lifecycle
- [x] Test: unverified employer cannot search candidates (§7) - written in M7 with the
      route it guards (`candidate-search.int.spec.ts`). The invitation half lands with
      invitations

### Noticed while building, worth knowing before BR-14
- [x] `verification_submission_files.file_id` is `RESTRICT` on purpose: evidence must
      not vanish from under a submission an administrator is reading. That means a
      **purge** must delete the employer row (which cascades submissions) *before*
      the files, or it fails. Nothing does today - `purge_after` is still nullable
      pending BR-14 - but the purge implementation has to know this ordering.
      **This note was right, and it was not the only one:** M11's purge hit exactly
      this, plus `companies.logo_file_id` and `messages.file_id`, all three
      `RESTRICT` against `stored_files`. `RetentionService` clears them in an
      explicit order and `retention.int.spec.ts` builds the entangled shape

## M5 - Vacancies + moderation *(done)*

### Schema *(done - `20260805170000_create_vacancies`)*
- [x] `vacancies` + `vacancy_requirements` (skills/languages with level and
      mandatory-vs-preferred, experience, education, attributes) - **one**
      requirements table keyed by field code, because a vacancy's requirements are
      read whole rather than filtered across vacancies the way candidate skills are
- [x] `vacancy_status_history` - BR-08, same shape as the employer and account
      histories
- [x] BR-05 check constraint `worker_count >= 1`
- [x] BR-12 as a CHECK too: any age or gender restriction requires a justification
      in the same row, so no admin path or manual SQL fix can write an unexplained
      restriction
- [x] CHECKs keeping the timestamps honest: `published_at` present once published,
      `closed_at` exactly when closed
- [x] Partial indexes expressing BR-11 - discovery reads `status = 'active'` only,
      so a closed vacancy cannot appear in it by forgetting a filter

### The vacancy field schema *(done)*
- [x] `GET /schemas/vacancy?category=` - the second target `schema_versions` has
      published since M2, now real. Same resolver, same validator, same
      `requiredForSearchable` guarantee as the candidate profile
- [x] Contract tests generalized to run over **both** targets, plus two new ones:
      shared field codes mean the same thing on both sides (M7 maps one to the other
      by code for UAT-06's prefill), and each target uses only storage kinds its
      writer implements

### Endpoints *(done)*
- [x] `POST /vacancies` (draft), `GET /vacancies/mine`, `GET /vacancies/:id`
- [x] `PATCH /vacancies/:id` - partial by field code, re-validated server-side.
      Editing a rejected vacancy returns it to `draft` and clears the stale reason
- [x] `POST /vacancies/:id/submit` - BR-03, completeness (one 422 violation per
      unfilled field), deadline sanity, BR-12 justification
- [x] `PUT /vacancies/:id/status` - pause, resume, close with a reason
- [x] `POST /vacancies/:id/moderation` - the admin decision, admin role only. M10
      adds the *queue*; the rules and audit rows live with the machine
- [x] Status machine + transition validation in one place (`vacancy-status.ts`),
      and the one method that changes a status always writes its history row

### `MODERATION_ENABLED` *(off for the MVP)* and the BR-12 exception
- [x] Off, so an ordinary vacancy publishes on submit with an
      `auto_approved_no_moderator` audit row and a warning - otherwise BR-04 would
      strand every vacancy and close the MVP loop
- [x] **A BR-12 restricted vacancy goes to review regardless of the flag.** BR-12
      requires "administrator review", and a flag meant to stop ordinary vacancies
      being stranded must not become a way to publish an unchecked restriction. Such
      a vacancy therefore cannot publish until M10 - the right outcome, and the
      employer sees `under_moderation` rather than silence
- [x] Changing a restriction on a *live* vacancy sends it back for review too: it
      has not been reviewed as it now reads

### BR-06
- [x] `isOpenForApplications(status, deadline, today)` - one definition, exported,
      so M6's feed filter and its in-transaction apply check cannot disagree. A feed
      that advertised a vacancy the apply route refuses is the failure this prevents
- [x] Apply it in M6: the deadline check inside the insert transaction with the
      vacancy read `FOR SHARE` (ARCHITECTURE.md §6) - done with `applications.apply`,
      and UAT-15 walks the expiry end to end

### Tests *(done - 22 unit, 25 integration)*
- [x] The transition table pinned exactly, `closed` terminal (BR-11), no self
      transitions, and which statuses are editable
- [x] BR-06 boundary: open *on* the deadline day, closed the day after
- [x] BR-12: unknown reason refused, mismatched reason refused, a reason must cover
      every restriction present, and no preference-shaped reason is on the list
- [x] Seasonal shape end to end: work type, date range, worker count, hours,
      transport, tools, crew, payment method (UAT-10)
- [x] reject → edit → draft → resubmit → approve, with all six history rows
- [x] Pause and resume without moving `published_at`; close keeps it in the list
- [x] One employer never sees another's vacancy (404, not 403)
- [x] Cascade from the employer through vacancies to requirements and history

## M6 - Discovery + applications *(done - the MVP loop closes here)*

### Schema *(done - `20260805190000_create_applications`)*
- [x] `applications` + **BR-07 partial unique index** (`WHERE status NOT IN
      ('withdrawn','rejected')`), so a withdrawn or rejected candidate may apply again
- [x] `application_stage_history` (BR-08), `application_notes` as **its own table**
      so §6.5's internal note is never one forgotten `select` from the candidate
- [x] `saved_vacancies`, keyed so saving twice is saving once
- [x] `complaints` - generic `target_type` + `target_id` from the start, because
      §5.6 needs vacancy reports now and §10 reviews four target kinds later
- [x] `idempotency_keys` storing a fingerprint and the resource id, never a response
      body - a cached body would go stale the moment the resource changed

### Candidate side *(done)*
- [x] Feed: recommended (rule-based on occupation, region and category), recent,
      saved, with §5.5's filters. One visibility fragment behind all of them, so
      BR-04, BR-06 and BR-11 cannot be forgotten by one query
- [x] `GET /discovery/vacancies/:id` - §5.6's detail with the employer's verification
      status and the structured requirements
- [x] Apply / withdraw / save / unsave / report
- [x] **Saved vacancies are deliberately not visibility-filtered**: a candidate who
      saved something needs to see that it closed, not have it vanish. BR-11 removes a
      closed vacancy from *discovery*, and a personal list is not discovery
- [x] `Idempotency-Key` on apply (ARCHITECTURE.md §7): same key + same body replays
      the original application, a different body is a 409

### Employer side *(done)*
- [x] Applications grouped by vacancy, filterable by status (§6.5)
- [x] Stage moves with §8.1's who-may-set-what, forward-only, skipping allowed
- [x] Internal notes, and `hired` incrementing the vacancy counter in the same
      transaction (§6.5's hired-vs-required)
- [x] `GET /applications/:id/candidate` - the applicant as much as BR-09 allows,
      with the authorized CV download

### Tests *(done - 19 unit, 30 integration)*
- [x] **Test: concurrent double-apply produces exactly one application** - two applies
      fired together, exactly one succeeds, one row in the table
- [x] BR-06 after the deadline, BR-04/BR-11 for paused and closed
- [x] The idempotent replay, and a 409 for a reused key with a different body
- [x] Backwards moves refused; an employer cannot withdraw for a candidate
- [x] BR-09 across the lifecycle: revealed on application, withdrawn on withdrawal
- [x] The internal note appears in no candidate-facing read
- [x] BR-07 counts only active applications, so re-applying after withdrawal works

## M7 - Candidate search + invitations *(done)*

Wire shapes are in [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) §4e and §4f.

### Schema *(done - `20260806120000_create_candidate_saves`)*
- [x] `saved_candidates`, with §7.3's private employer note **on the save** - one note per
      employer per candidate, written where the employer already keeps them, so "a note
      without a save" is unrepresentable rather than a state to decide about
- [x] `vacancy_shortlists`, keyed by vacancy because "vacancy-specific" is the point of
      it; the shortlist's owner is the vacancy's owner, so there is no second notion of
      who may edit it
- [x] Deliberately *not* enforced: that a shortlisted candidate was saved first. §7.3
      describes a user's flow, and a foreign key demanding it would fail a two-tap action
      for a rule nothing depends on

### Search *(done)*
- [x] All §7.1 filter groups, verified-employer only (`assertVerified` on every method,
      the saved list included), every read behind BR-02's one gate fragment
- [x] Skills match-all as `count(DISTINCT ...) = n`, match-any as `EXISTS` - two plans,
      deliberately not unified (ARCHITECTURE.md §5)
- [x] Language minimum level via `level_rank >=`, one ANDed predicate per language
- [x] `{count, isExact}` bounded by `SEARCH_COUNT_CAP`, so "200+" is honest
- [x] Match score with per-group breakdown; `scoreGroups()` is the single source of the
      weights *and* of what the response reports, so the number that ranked a candidate
      and the number explaining it cannot disagree
- [x] §7.3 sorts: match, recent, experience, salary and **tiered proximity** - same
      district, then same region, then the rest, against `proximityDistrictId`. Each sort
      ends with a total order, or two pages of one search can repeat a candidate. A real
      distance needs a centroid per district and would not change the contract
- [x] Vacancy→search prefill (UAT-06) as a pure function over the vacancy aggregate:
      mandatory requirements become filters, preferred ones deliberately do not, and a
      BR-12 restriction carries the justification the vacancy already holds
- [x] Saved candidates, vacancy shortlists, private notes
- [x] **BR-09** used by every candidate serializer: the card has no contact fields and the
      query never joins `users`; `CandidateViewService.forCandidate` is §7.3's "View
      profile" and reuses M6's one gatherer rather than a second copy of the rule
- [x] §7.1's two filters that could not be built as written, both resolved as ids:
      `specialization` is now a **dictionary** (60 items, `default`, client owns the final
      list) on both the candidate profile and the vacancy, with both schema versions
      bumped to 2 and the old free text deleted rather than guessed at; remote-work
      readiness was never missing, it is a `work_format` id rather than a boolean
- [x] BR-12 on the search side: an age or gender filter needs a justification from the
      same declaration a vacancy's restriction needs, covering the same kinds, and every
      accepted use is logged for M10's audit
- [x] **The profile photo is the one exception to BR-09's file gate** - §7.3 puts a photo
      on the card, and a photo is not §5.4's authorized document. One route, one purpose
      check, searchable profiles only. *Wants client sign-off, like the other decisions
      answered as data*
- [x] `search` rate-limit bucket (§12.5) with `RATE_LIMIT_SEARCH_PER_IP`

### Invitations *(done - `20260806130000_create_invitations`)*
- [x] `invitations` with the two §8.2 shapes made exclusive by a CHECK - a vacancy
      invitation or a general one carrying its own occupation, place, schedule and pay -
      plus `invitation_status_history` for BR-08 and a response note, because "Request
      details" without room for the question is a button that says nothing
- [x] One open invitation per employer, candidate and vacancy: a partial unique index with
      **`NULLS NOT DISTINCT`**, without which two general invitations (both with a null
      `vacancy_id`) would count as different rows
- [x] `POST /invitations` with BR-03, BR-02's gate on who may be invited, M5's
      `isOpenForApplications` on the vacancy, and `Idempotency-Key`
- [x] Accept / decline / request-details in one method: the three differ only in the status
      they set, and splitting them is how one ends up without its audit row.
      `details_requested` is a question, not an ending; asking twice is refused
- [x] `hasAcceptedInvitation` wired into the BR-09 helper - one line, no change to the rule
      - plus `GET /invitations/:id/files/:fileId/content`, the invitation's counterpart to
      the application-scoped download, re-evaluated per download
- [x] §7.4's invited/accepted counts per vacancy; the interviewed and hired halves are
      application stages and stay where they are
- [x] Test: unverified employer cannot invite (§7) - the second half of M4's outstanding
      test
- [x] Tests: the transition table pinned exactly, a concurrent double-tap producing one
      invitation, the idempotent replay and the 409 for a reused key, inviting a hidden
      candidate refused, a paused and an expired vacancy refused, contact details closed
      while only sent and open on acceptance, and the download refused for another employer

### The daily quota *(added 2026-08-20, client direction via mobile)*

**Sending an invitation is free** - §7.3 lists it beside "View profile" and "Save", and §7.4's
example fills twenty openings by inviting people, which at 2 Coins each would exceed the
registration bonus many times over. The candidate's **acceptance** is what opens contact
(BR-09), and §8.2's apparent unlock precondition was resolved that way. So no gate was added;
what was added is what the free path needs instead, because BR-03's verification is an
admission gate rather than a volume limit.

- [x] `EMPLOYER_DAILY_INVITATION_LIMIT`, default 30, beside the money knobs. §7.4's example
      needs ~60 invitations for twenty openings, so 30/day finishes it in two days; a small
      employer never meets it, a blast of thousands is stopped, and a future paid tier has
      something to sell
- [x] `GET /invitations/quota` → `{ remaining, limit, resetsAt }`. **Declared before
      `@Get(':id')`**, or Nest reads "quota" as an id and fails its UUID pipe. `limit` is the
      **effective** total, not free-plus-purchased: when extra invitations become purchasable
      the number grows and no client changes
- [x] **409 `invitation.daily_limit_reached`**, not 429: a business rule with a known reset,
      where a 429 says "too fast" and invites proxies to retry
- [x] **The quota is a count of rows, not a stored counter**, which settles three rules at once
      rather than one policy each: a sent invitation is never refunded (no status filter, so a
      decline cannot return the slot), re-inviting after a decline counts (a second row is a
      second notification), and **an idempotent replay consumes nothing** - `IdempotencyService`
      returns the recorded id without calling the insert, so there is no row to count. That last
      one is the "the app ate my quota" failure, and it now holds by construction rather than by
      placing a decrement correctly
- [x] Checked **inside the insert transaction behind a lock on the employer's own row**. No
      unique index can express "at most 30 per day", so this is one of the few rules here
      enforced by a lock; a test fires two sends at the boundary
- [x] `dayBoundsInZone` - a **calendar** day in `PLATFORM_TIME_ZONE`, not a rolling window,
      because "12 left today, resets at midnight" is plannable and "another in 7h 22m" is not.
      Every machine on this project sits at UTC+5, so `setUTCHours(0, 0, 0, 0)` agrees locally
      and is wrong for the five hours a day the two zones disagree on the date - the tests cover
      that window and a Europe/Berlin DST boundary
- [x] `LocalizedException` gained an opt-in `details` object. **The 402's docstring had claimed
      its `params` let a screen show "2 needed, 1 left" without a second request, which was
      false** - params only interpolate the message - and mobile had read it as a promise and
      shipped against it. Both the 402 and this 409 now carry real structured fields; every
      other error body is byte-identical
- [ ] Owed later, and free: **purchasable invitations**. `limit` is already the effective
      total, so a purchase raises it and no client changes. It will want a ledger kind beside
      `candidate_unlock` (BR-24) when it is specified
- [ ] Not asked for: a **per-vacancy** cap. §7.4's "invited counts against the target" hints at
      one; the client asked for a daily cap per employer, and raising it later is additive

### Tests *(done - 85 unit, 66 integration across both halves)*
- [x] Test: search result cards never contain a phone number - asserted twice, once
      mechanically over the compiled SQL (no `users`, no `phone`) and once over a real
      response body
- [x] Unit: the scoring groups, the prefill mapping, and what every filter compiles to
- [x] Integration: match-all really demands every skill, a language floor really compares
      ranks, BR-02 really keeps a hidden or incomplete profile out, a negotiable
      expectation passes a budget, the bounded count answers "n+", the page comes back in
      the order it was scored
- [x] Test: unverified employer cannot search candidates (§7) - M4's outstanding test,
      written with the route it guards
- [x] Test: hiding a profile removes it from a saved list it was already on
- [x] Measure p95 against the 3s budget before optimizing anything - done in M11 at
      200k profiles: 231ms worst case, nothing optimized
      ([docs/PERFORMANCE.md](docs/PERFORMANCE.md))

## M8 - Chat + interviews *(done)*

Wire shapes are in [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) §4g.

### Schema *(done - `20260807100000_create_conversations`, `20260807130000_create_interviews`)*
- [x] `conversations` (one per employer/candidate pair), `messages` with a one-file
      attachment, `conversation_blocks`. **No column says a conversation is permitted** -
      that is asked live, so nothing has to remember to un-set it
- [x] Read state as two timestamps on the conversation, not a `message_reads` table: two
      participants make it one comparison and one aggregate
- [x] `interviews` with §8.3's conditional requirement as a CHECK over all three permitted
      shapes, plus `interview_status_history` for BR-08

### Chat *(done)*
- [x] Gated conversation creation and message send, through the **one**
      `HiringInteractionService` that BR-09 already uses - extracted on its third caller,
      so "may see a phone number" and "may send a message" cannot drift apart
- [x] Attachments (sender-owned files only), per-recipient read state, report as a
      `complaints` row with `target_type = 'message'`, block that is read-only for both
      sides, read-only when the interaction closes - and readable throughout
- [x] `Idempotency-Key` on message send
- [x] **No `delivered` state**: §9.1 asks for it "where supported by the backend", and it
      is a property of push. It arrives with M9's dispatcher rather than as a column set
      at the same instant as `created_at`

### Interviews *(done)*
- [x] Type-dependent required fields (§8.3), refused with a field-level violation and a
      CHECK constraint behind it
- [x] Scheduling moves the application to §8.1's `interview` stage **in the same
      transaction**, with its BR-08 row - the stage and the interview are one event
- [x] Candidate confirm / request-another-time; `confirmed` is not terminal, because plans
      change; rescheduling always resets the answer
- [x] `cancelled`, which §8.3 does not list - the alternative is a stale interview nobody
      can retract

### Tests *(done - 35 unit, 39 integration)*
- [x] The two rule tables pinned exactly, including §8.3's absence checks - a phone
      interview carrying a meeting link is refused
- [x] Integration: no conversation without a permitted interaction, a sent invitation is
      not enough, withdrawal closes sending and keeps the history, a new interaction
      reopens it, a rejection deliberately does not close it, a block stops both sides,
      read state per recipient, an attachment must be the sender's own
- [x] Integration: scheduling moves the stage atomically, a rejected application is
      refused **and writes nothing**, and the CHECK constraints refuse a direct write that
      the service would have refused too

## M9 - Notifications *(done)*

Wire shapes are in [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) §4i.

### Schema *(done - `20260807150000_create_notifications`)*
- [x] `notifications` storing an **event code and its parameters, never text**:
      `users.locale` can change after the event, and a list frozen in last month's language
      is the §3.2 failure the catalog exists to prevent
- [x] `notification_preferences` per category, with §9.2's always-on category as a **CHECK
      constraint** so a row disabling it cannot exist
- [x] `device_tokens`, unique on the token across users - a token identifies an app
      installation, not a person, and phones here are handed on

### Endpoints and events *(done)*
- [x] All nine §9.2 events with the recipients the specification names, emitted by the six
      modules that own them (ten codes: "interview created or changed" is one setting and
      two sentences)
- [x] Unread count over a partial index, mark one, mark all, list filtered to unread
- [x] Preferences, including the always-on category **listed and flagged** rather than
      hidden - a user who cannot find it will assume it is off
- [x] Security and account notices not disableable: vacancy moderation, verification
      result and administrative action, each of which the user must act on and cannot act
      on unseen
- [x] Device registration and push dispatch, independent of the stored row: `notify` never
      throws and never awaits the push
- [x] **FCM over HTTP v1**, direct rather than through `firebase-admin` - the SDK exists to
      hide an OAuth2 exchange and one POST, and `jose` already signs JWTs here for Telegram

### The provider decision *(answered 2026-08-07: FCM, client direction)*
- [x] FCM only, with the APNs key uploaded to Firebase so iOS goes through the same call.
      Free, and works with a sideloaded APK - what it needs is Google Play services on the
      device
- [x] A phone without them (a post-2019 Huawei) loses the banner and nothing else, because
      the in-app row is the record. Huawei Push Kit would be a second `PushSender`, not a
      rewrite
- [x] ~~**Owed by the client: the Firebase service-account JSON**~~ - **received
      2026-08-07** and configured in `.env` (project `headhunter-app-b463f`). Verified
      end to end: a token is obtained and FCM rejects only the fake device token, which
      proves auth, the v1 API and the `invalid` classification at once
- [~] APNs `.p8` in that Firebase project - **iOS is paused, client direction 2026-08-19.**
      No iOS build is planned, so this is not outstanding work; it becomes one line of Firebase
      configuration whenever iOS is picked up again. Nothing in the push path is
      platform-specific: `PushDispatcher` sends to whatever device tokens are registered

### Tests *(done - 42 unit, 18 integration)*
- [x] **The four translations of every event key interpolate exactly the same
      placeholders** - a placeholder present in Russian and missing in Uzbek renders as
      braces to one user and no request in review would surface it
- [x] One row read in three languages returns three sentences and one id
- [x] A disabled category stores nothing at all; the always-on one is refused by the
      service *and* by the constraint
- [x] A token registered by a second account moves; an unregistered one is disabled and
      revived by re-registration
- [x] The row survives a sender that fails and a user with no device at all
- [x] Every other integration suite now constructs the real notifications service, so a
      miswired event fails where it is emitted

## M10 - Admin + audit *(done)*

Wire shapes are in [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) §4h.

### Schema *(done - `20260807140000_create_admin_audit_log`)*
- [x] `admin_audit_log`, **append-only in the database**: three statement-level triggers
      refuse `UPDATE`, `DELETE` and `TRUNCATE`. Statement-level because a row trigger never
      fires for an `UPDATE` matching nothing, and `TRUNCATE` needs its own or it is the
      one-line way around the other two
- [x] The actor is `ON DELETE RESTRICT`, so a user who has acted as an administrator cannot
      be deleted - which collides with BR-14 on purpose rather than letting a cascade take
      the trail with it. Even the test cannot clean up after itself. **M11 resolved it:**
      the person is erased and the actor kept, and the constraint got the answer it was
      holding out for rather than being relaxed
- [x] `users.restricted_until`, which is what makes §10.4's restriction *temporary*

### Endpoints *(done)*
- [x] Dashboard counters (§10.1) in one statement - eleven `count`s as scalar subqueries,
      because a request per tile would be the slowest screen for the person who opens it
      most
- [x] Verification and moderation decisions with mandatory reasons, delegating to M4's and
      M5's machines - the queue, the actor and the audit row are all M10 adds
- [x] Verification evidence download, scoped to that employer's own submissions and logged
      (§11.1) - the fourth entitlement-bearing file route
- [x] §10.2's "pause, or remove a vacancy": `VacanciesService.administrate`, a separate
      method from the employer's `changeStatus` rather than an ownership flag on it
- [x] Complaints over users, vacancies, messages and profiles from the one generic table,
      with the target resolved per kind, and the audit row written **in the same
      transaction** because nothing else records a review
- [x] User search by partial phone, name, role, status or registration date; warn (audit row
      only, no status change), restrict/block/unblock with a mandatory reason, a BR-08 row
      and an audit row in one transaction (UAT-14)
- [x] An administrator cannot target their own account, and an account awaiting deletion is
      left to BR-14 - which M11 answered, so those accounts now have somewhere to go
- [x] Dictionary management (§10.3): create, edit labels and metadata, activate/deactivate,
      merge. The four-locale rule, the revision bump and the merge's double bump stay the
      database's; there is **no delete route** at all
- [x] `GET /admin/audit` — §10.4's read, by actor or by target

### The two MVP flags are on *(both default to `true` since M10)*
- [x] `EMPLOYER_VERIFICATION_ENABLED` and `MODERATION_ENABLED` flipped, and **no domain code
      changed** - which was the promise M4 and M5 made when they were switched off
- [x] **A BR-12 restricted vacancy can finally publish.** Unreachable from M5 by design; it
      needed a reviewer, not code
- [x] **The first administrator is granted by the seeder** *(done 2026-08-19)*. There is still
      deliberately no route that grants the role - a product where administrators can create
      administrators has no floor - so it comes from outside the API, and `pnpm seed` is where:
      idempotent by the `(user_id, role)` primary key, creating the account if that number has
      never registered. `SEED_ADMIN_PHONES` carries the numbers rather than a literal in the
      file, because a committed administrator is granted in **every** environment the code
      reaches, including any instance where `OTP_STATIC_CODE` is set - and there, knowing the
      number would be the whole of the authentication. It grants an entitlement, never a
      credential: login is still phone + OTP. An instance with no administrator is not merely
      reduced but **stuck** (every employer parks in `under_review`), so the seeder says so out
      loud when the variable is unset

### Tests *(done - 34 integration)*
- [x] **Test: no update or delete path exists on the audit log** - all three triggers,
      including an `UPDATE` that matches nothing, which is the case a row-level trigger
      would let through
- [x] A BR-12 restricted vacancy queued with its restriction shown, then published on
      approval
- [x] Mandatory reasons refused when blank, on all five decision kinds
- [x] Warning writes an audit row and **no** `account_status_history` row; blocking writes
      both
- [x] A restriction with a past end date is lifted by the guard, with a null-actor history
      row; a block is not
- [x] Dictionary: activation refused until the fourth label exists, the type version bumps
      on a label edit, a duplicate code is refused, and a merge leaves the loser resolvable
- [x] The audit log answers both of its questions - by actor and by target

## M11 - Hardening

- [x] Load test both budgets; fix misses before adding a search projection -
      [docs/PERFORMANCE.md](docs/PERFORMANCE.md). **Both met**: at 200 000
      searchable candidates and 10 concurrent clients the worst p95 in the
      product is 231ms against a 3s budget. Nothing to fix, so the projection
      stays deferred - and the doc names the volume that changes that (500k
      searchable profiles), because the unfiltered search is measurably linear
      in the searchable population and its recency index is never chosen
- [x] Five rate-limit buckets: OTP, auth, search, messaging, files - all five
- [x] Security review: [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) covers
      §12.5 point by point. The public route surface is frozen by a test rather
      than by review (`infra/api/api-surface.spec.ts`), and the search's
      hand-written SQL has injection tests. Two things came out of it and are
      **not** closed:
  - [ ] Malware scanning is not implemented and cannot be here - the bytes go to
        Telegram, which does not scan a bot upload. Stated as a gap, not fixed.
  - [ ] `API_DOCS_ENABLED` is on and the hostname is public: decide between
        turning it off and a Cloudflare Access policy on `/docs` + `/reference`
- [x] **BR-14 as data, and the audit-log purge collision resolved** -
      [docs/RETENTION.md](docs/RETENTION.md). Every period declared with a provenance
      tag; the purge runs on request, not a timer; an administrator who has acted is
      anonymized rather than deleted, so §10.4 and BR-14 both hold. Migration 18 adds
      `users.purged_at` and the two checks that make a half-done purge unrepresentable.
      Two things it left explicitly open, both stated in the doc:
  - [ ] The file **bytes** stay in the Telegram channel - the purge removes the metadata
        that points at them, so nothing here can serve one, but unreachable is not erased.
        Emptying that channel is an operational step somebody has to own
  - [ ] Backups taken before a purge still contain what it removed, for 14 days. Normal,
        but it belongs in the privacy policy rather than being discovered
- [x] Scheduled backups + **rehearsed** restore, documented -
      [docs/BACKUP.md](docs/BACKUP.md). Daily `pg_dump` at 21:00 UTC (02:00
      Tashkent), 14 days, every dump verified with `pg_restore --list`. The drill
      was run on 2026-08-07 and its output is in the doc: identical schema
      (49/122/8/425/19), matching migration state, an append-only trigger firing
      and BR-07's partial index intact with its predicate. Two gaps are stated
      there rather than hidden:
  - [ ] Off-machine copies - the dumps are on the same disk as the database.
        Needs a decision on where Uzbek personal data may be stored first
  - [ ] Point-in-time recovery: a daily dump means up to 24h of loss. Raise once
        there is traffic worth losing
- [x] §13.2 deliverables, the backend's share:
  - [x] **API description** - `docs/openapi.json`, 115 paths, committed. `pnpm
        docs:openapi` regenerates it from the same builder `/docs` serves, so the
        delivered file and the running service cannot disagree - and a renamed field
        shows up in that diff rather than in a Flutter deserialization error
  - [x] Migrations (18), `.env.example`, deployment package (Dockerfile + four compose
        files + [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))
  - [x] **Technical documentation**: environment setup (README), deployment, backup and
        **rehearsed** restore, configuration, and now support notes -
        [docs/SUPPORT.md](docs/SUPPORT.md)
  - [x] **Testing evidence** - [docs/TEST_EVIDENCE.md](docs/TEST_EVIDENCE.md): 847 tests,
        the UAT-01..15 mapping, and the gaps in the evidence stated rather than left out
  - [ ] Initial dictionaries are delivered and seeded, but four types and the occupation
        set still want client review (tracked at the top of this file)
- [x] Walk all 15 UAT scenarios - `src/uat/uat.int.spec.ts`, one `describe` per
      row of §13's table, run with both moderation flags **on** because that is
      the product the scenarios describe. 16 tests. They found no defect: every
      failure on the first run was the test asserting a name the code never
      used, which is what a walkthrough written against the spec rather than
      against the code is supposed to feel like

## M12 - Employer wallet, Coins, Candidate Unlock *(done)*

Wire shapes are in [docs/openapi.json](docs/openapi.json); the design record is
[ARCHITECTURE.md](ARCHITECTURE.md) §10b.

### Schema *(done - `20260810120000_create_wallets`, `20260810140000_wallet_survives_purge`)*
- [x] `employer_wallets`, `wallet_transactions`, `candidate_unlocks`. **The ledger is the
      truth and the balance is a cache**; a test asserts they agree after every kind of
      transaction, which is the only thing that keeps a denormalized balance honest
- [x] Append-only in the database (BR-24) - the same three statement-level triggers M10 used
      for the audit log, so `UPDATE ... WHERE false` is refused too
- [x] BR-16 is the `(employer, candidate)` primary key, not a check: two taps race and the
      database picks a winner
- [x] BR-15 is a partial unique index, which answers all four of §6.6's cases - logout,
      reinstall, device change, role switch - because each is a retry of the same insert
- [x] Row-level arithmetic: `balance_after = balance_before + amount_coins`, an unlock cannot
      be positive, an adjustment cannot exist without a reason **and** an actor
- [x] A unique index for one `top_up` per payment order, **written before M13 existed** - so
      no row could ever have been written without it
- [x] **A test found that deleting a user cascaded into the append-only ledger**, so BR-14's
      purge could not delete any employer who had ever held a Coin. Same collision as the
      audit log, one milestone later. `employer_wallets` now references `users` with
      `RESTRICT` so the refusal is legible at the top of the purge rather than half way down
      a cascade, and those accounts are anonymized instead

### Endpoints *(done)*
- [x] `GET /wallet` - balance, pricing, and the wallet created on first read, which
      back-grants the bonus to employers who registered before this shipped. Relying on the
      index rather than on "has this employer registered" settles that case without writing
      money into a data migration
- [x] `GET /wallet/transactions`, `GET /wallet/unlocks/{id}`, `POST /wallet/unlocks`
- [x] `GET /admin/wallets`, `GET /admin/wallets/{userId}`,
      `POST /admin/wallets/{userId}/adjust` (§10.5) - mandatory reason, a ledger row **and**
      an audit row in one transaction
- [x] **No `Idempotency-Key` on the unlock, deliberately.** The pair is a natural key, so a
      retry returns the existing entitlement with `charged: false`. A header key answers the
      same question worse: one key per tap is two keys for one intent
- [x] The debit and the entitlement are one transaction (BR-18), and it **returns an outcome
      rather than throwing** - throwing inside would roll back the write and report
      "insufficient balance" having taken the money

### The BR-09 retrofit *(done 2026-08-19, on the small reading)*

Until this landed, **nothing read the entitlement**: `candidate_unlocks` appeared only inside
the wallet module, so an employer could pay two Coins and see exactly what they saw before.
The client had shipped the wallet screen and deliberately stopped before the unlock button for
that reason.

- [x] **The change went in `HiringInteractionService`, not only in `expose()`**, so §9.1's chat
      gate and §8.2's interviews inherit it and cannot drift from BR-09. A third `kind`,
      `unlocks`, whose `id` is the candidate's - `candidate_unlocks` has no surrogate key,
      because the pair is its primary key. Read directly rather than through `WalletService`:
      that file has no module dependencies on purpose, and three modules import it
- [x] `expose()` gained `hasUnlock` and the granting reason `candidate_unlock`.
      **Precedence: application, then accepted invitation, then unlock** - all three grant
      identically, so this only decides what the log and the client are told, and an employer
      holding an application should not be shown a purchase as the reason
- [x] **`hasUnlock` is in the no-entitlement condition, and leaving it out would have failed
      silently.** An employer who paid, whose candidate then hid their profile, arrives with no
      application and no invitation; without it the branch returns `hidden_by_candidate` and
      refuses contact that was paid for, with a log line as the only symptom
- [x] `not_verified_employer` still short-circuits **before** any of it (§7): an employer must
      not be able to buy past BR-03. The test enumerates every entitlement including the
      unlock, because that is the one way this change could have leaked a phone number
- [x] **`no_interaction` renamed `unlock_required`** - a coordinated breaking change with the
      client, who maps all seven codes exhaustively. The old name described a world where the
      only remedy was waiting; the remedy is now a purchase, and the client turns the code
      into the sentence that says so
- [x] A third download route, `GET /unlocks/:candidateUserId/files/:fileId/content`, because
      `downloadPath` is scoped to whatever granted the entitlement. Beside the other two in the
      applications module, re-evaluated per download, and one `file.not_found` for "no unlock",
      "no such file" and "not theirs" alike
- [x] **Two ways to take money for nothing, closed.** `POST /wallet/unlocks` checked the role
      but not verification, so an employer could be charged for access §7 would then refuse -
      harmless while nothing read the entitlement, a real bug the moment something did. And an
      unknown `candidateUserId` hit a foreign key instead of answering 404. Both are refused
      before any Coins move
- [x] `UnlockStateDto` gained `balanceCoins`. §6.6 and UAT-17 need cost, balance **and**
      remainder on the confirmation sheet, and without the balance every sheet was two requests
      - which is the thing that route was written to avoid
- [x] `wallet.unlock_required` was already in the message catalogue in all four variants, so
      this was a code change and not a translation round

### Tests *(done - 19 integration, four of them concurrent)*
- [x] Two concurrent unlocks of the same pair: one debit, one entitlement
- [x] Two concurrent first-registrations: one bonus
- [x] A wallet holding 1 Coin refuses the unlock and writes no ledger row
- [x] The cached balance equals the ledger sum after a mixed sequence
- [x] `UPDATE` and `DELETE` on `wallet_transactions` are refused by the database, including
      an `UPDATE` that matches nothing
- [x] UAT-16..UAT-19 walked in `src/uat/uat.int.spec.ts`
- [x] **The retrofit's own suite**, `applications/unlock-gating.int.spec.ts` (10 tests): the
      three-way precedence through real applications and invitations, an unlocked candidate's
      phone and files with the right `downloadPath`, the unlock surviving `hidden`, the new
      route refusing an employer who has not paid, and the two purchase refusals. The rule
      itself stays a unit test - `contact-exposure.spec.ts` enumerates every combination,
      including the two the unlock added

---

## M13 - Payme and CLICK top-up *(done; needs merchant accounts to switch on)*

Everything is in [docs/PAYMENTS.md](docs/PAYMENTS.md), including what to ask for on purchase.

### Schema *(done - `20260810160000_create_payments`)*
- [x] `payment_orders` with §6.7's six statuses, the price quoted **onto the order** (§10.5),
      and `amount_uzs = coins * coin_price_uzs` as a **check constraint** - §12.3.1's "client
      totals are never trusted" as arithmetic on the row rather than a habit at a call site
- [x] A unique index on `(provider, provider_transaction_id)`, so one provider transaction
      belongs to exactly one order and a callback cannot be replayed against another
- [x] A paid order cannot exist without a provider transaction id and a `paid_at` - a paid
      order nobody can reconcile is the thing §6.7 exists to prevent
- [x] `payment_events`, the reconciliation trail, **append-only** with the same three
      triggers. `order_id` is **nullable on purpose**: a callback that fails its signature or
      names no order is exactly the event an incident review wants, and it has nothing to
      attach to
- [x] A check constraint makes **a rejected event with a state change unrepresentable**,
      which is §12.6's "verify before changing the internal state" as a property of the table
- [x] **No raw provider payload is stored** - §12.6 says log only non-sensitive identifiers,
      so each adapter hands over the fields this system understands. A redaction denylist
      would have to be maintained forever; not holding the data cannot leak it

### The provider seam, for the third time *(done)*
- [x] One `PaymentProvider` abstraction, `PaymeProvider`, `ClickProvider`, and a registry that
      only offers what is configured. **An unconfigured adapter refuses by construction**
      rather than via a fourth no-op class: verifying Payme needs the merchant key and
      verifying CLICK needs the secret, so with no credential there is no path that returns a
      verified command
- [x] **The adapter owns the wire format; the service owns the state machine.** Six Payme
      methods and CLICK's two collapse into one normalized command union, so there is one
      state machine and its tests cover both providers
- [x] **No outbound HTTP in this milestone, and that is not an omission** - both integrations
      are inbound and checkout is a URL the client opens. No HTTP client, no timeouts, no
      retry policy: the provider retries, and BR-19 makes that safe
- [x] Payme: JSON-RPC, Basic `Paycom:<key>`, **amounts in tiyin** - converted in one pair of
      functions with a test pinning both directions, because that is the one place in this
      milestone to be wrong by two orders of magnitude
- [x] CLICK: MD5 `sign_string`, and the **signed field list differs between `Prepare` and
      `Complete`**. `merchant_prepare_id` is derived from the order id rather than stored, so
      a completion naming a different one fails verification instead of being accepted
- [x] `PAYME_ACCOUNT_FIELD` is configuration because it is *their* setting; a mismatch makes
      every callback fail as "order not found", which is a confusing way to find out

### Endpoints *(done)*
- [x] `GET /payments/providers` - what the top-up screen may offer, so an empty list and a
      §12.7 storefront decision are both configuration rather than an app release
- [x] `POST /payments/orders`, `GET /payments/orders`, `GET /payments/orders/{id}`. The
      request carries a **Coin count, never a total**
- [x] `POST /payments/callbacks/payme` and `.../click` - **the first public mutating routes in
      the product.** Added to `api-surface.spec.ts`'s frozen list with the argument written
      out, given their own rate-limit bucket, excluded from the client's OpenAPI document,
      and never localized: a provider is not a person
- [x] Both callbacks answer **200 with the provider's own error in the body**, because an HTTP
      error makes a provider retry a request already decided

### Tests *(done - 29 unit, 32 integration, 4 UAT)*
- [x] **UAT-22, the most important test in the milestone**: the same successful callback
      delivered twice credits once. And again *concurrently*, which is the case the row lock
      exists for
- [x] BR-19 is four constraints in four places, and each is tested: the row lock, the
      conditional `UPDATE ... WHERE status = 'pending'`, the ledger's unique index, and the
      one-order-per-provider-transaction index
- [x] BR-20: a cancelled Payme transaction and a CLICK `Complete` carrying its own error both
      credit nothing, and the reason is visible in Wallet (UAT-23)
- [x] A reversal after payment is a **new** ledger row and the balance moves; nothing is
      rewritten (BR-24). When the Coins were already spent it recovers what is left and
      records the shortfall - see the open question below
- [x] An amount one soum short is refused; the comparison is exact, not a tolerance
- [x] A wrong signature, a wrong `service_id`, a wrong username on the Basic credential, and a
      key that is a prefix of the right one are all refused - and the order is untouched
- [x] An account field that is not a UUID at all does not abort the transaction that records
      it. `WHERE id = 'garbage'` is a Postgres type error, which would have taken the event
      row with it
- [x] **Found while testing:** a `CreateTransaction` reusing another order's transaction id
      hit the unique index as a raw error thrown out of the transaction - rolling back the
      event row that explained it and answering the provider with a 500. The collision is now
      read first and the index is a backstop
- [x] `payment_events` refuses `UPDATE`, `DELETE`, and an `UPDATE` matching nothing

### What is left, and none of it is code
- [ ] **Merchant accounts for Payme and CLICK.** Sandbox credentials are enough to finish and
      verify everything; §12.6 requires provider-test-environment testing before production
      credentials are activated, so that order is the client's constraint too
- [ ] **A stable public HTTPS callback host.** `hh.qitmir.uz` is a dev tunnel on a developer
      machine: a sandbox can reach it, but a production merchant account should not point at
      something that stops answering when the machine is off - and re-registering a callback
      URL is a support ticket with the provider
- [ ] **Fiscal receipt attributes** (§6.7). Declared as data with a `provenance` tag, and
      **no receipt is sent while it reads `unknown`** - a guessed IKPU code on a real
      transaction ends up on a tax return. Payments work without one
- [ ] **Who absorbs a refund of Coins already spent?** BR-16 makes an unlock permanent, so a
      reversal can only recover what is left. The code takes `min(balance, coins)` and records
      the shortfall, because a negative balance is refused by the database. Commercial
      question, not a technical one
- [ ] **§12.7's store-billing check**, which §12.6 and §12.7 both say must happen immediately
      before release. If the answer is Apple or Google billing, it costs one adapter and one
      `ALTER TYPE` - the ledger has no provider column, which is the whole point
