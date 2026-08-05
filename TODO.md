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
- [?] **Retention periods** for deleted accounts and audit logs (BR-14 defers to
      an approved privacy policy we do not have). *Blocks M1 deletion flow and
      M10 audit.*
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
- [ ] Add `docs/` deliverables scaffold: deployment, backup/restore notes (§13.2)
- [x] **Dockerfile** - multi-stage, runtime carries `dist` plus production
      dependencies only, non-root, tini for signals, healthcheck on `/health`.
      `docker-compose.api.yml` runs it as `headhunter-api` and the tunnel origin is
      now `http://api:3001`; `pnpm api:up` is the whole redeploy. Migrations stay a
      deliberate host command - a container that migrates at boot races itself the
      moment there are two
- [ ] CI workflow (lint, typecheck, test, build). The image build is the natural
      place to hang it: `nest build` inside the Dockerfile already type-checks, so CI
      is `docker build` plus the two test suites

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
- [ ] **Connect Eskiz.uz** - the one thing standing between this and real users.
      Shape, constraints and the questions to ask on purchase:
      [docs/SMS_PROVIDER.md](docs/SMS_PROVIDER.md). *Blocked: not bought yet.*
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
- [ ] Test: blocked user refused on each *mutation kind* - can only be written
      once there are mutations beyond auth itself (M3)

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
- [ ] Apply it at the call sites, which arrive with the routes: vacancy submit (M5),
      candidate search and invitations (M7). Deliberately not a guard yet - a guard
      with no route to guard is an abstraction with no caller

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
- [ ] Test: unverified employer cannot search candidates (§7) or invite - written
      with those routes, in M7

### Noticed while building, worth knowing before BR-14
- [ ] `verification_submission_files.file_id` is `RESTRICT` on purpose: evidence must
      not vanish from under a submission an administrator is reading. That means a
      **purge** must delete the employer row (which cascades submissions) *before*
      the files, or it fails. Nothing does today - `purge_after` is still nullable
      pending BR-14 - but the purge implementation has to know this ordering

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
- [ ] Apply it in M6: the deadline check inside the insert transaction with the
      vacancy read `FOR SHARE` (ARCHITECTURE.md §6)

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

## M7 - Candidate search + invitations

- [ ] Search over all §7.1 filter groups, verified-employer only
- [ ] Skills match-all as `HAVING COUNT(DISTINCT ...) = n`; match-any as `IN`
- [ ] Language minimum level via `level_rank >=`
- [ ] `{count, isExact}` count endpoint
- [ ] Match score with per-group breakdown; §7.3 sort options
- [ ] Vacancy→search filter prefill contract (UAT-06)
- [ ] Saved candidates, vacancy shortlists, private notes
- [ ] Invitations + accept/decline/request-details
- [ ] **BR-09 single contact-exposure helper** used by every candidate serializer
- [ ] Test: search result cards never contain a phone number
- [ ] Measure p95 against the 3s budget before optimizing anything

## M8 - Chat + interviews

- [ ] Gated conversation creation and message send
- [ ] Attachments, per-recipient read state, report/block, read-only on close
- [ ] Interviews with type-dependent required fields + candidate response
- [ ] `Idempotency-Key` on message send

## M9 - Notifications *(deferred: last feature milestone, after M10)*

Client direction 2026-08-04: MVP first, notifications last to build and test.

- [ ] `notifications` rows for all nine §9.2 events with correct recipients
- [ ] Unread count, mark read, preferences
- [ ] Security/account notices not disableable
- [ ] Device token registration + push dispatch, independent of the stored row
- [?] Push provider - FCM only (recommended) vs FCM + APNs. No longer urgent;
      needed before this milestone opens, not before the MVP.

## M10 - Admin + audit

- [ ] Dashboard counters (§10.1)
- [ ] Verification + moderation decisions with mandatory reasons
- [ ] Complaints over users, vacancies, messages, profiles
- [ ] User search, warn/restrict/block/unblock with reason (UAT-14)
- [ ] Dictionary management incl. localized labels and skill merge
- [ ] **Append-only audit log**; test asserts no update/delete path exists

## M11 - Hardening

- [ ] Load test both budgets; fix misses before adding a search projection
- [ ] Five rate-limit buckets: OTP, auth, search, messaging, files
- [ ] Security review: route-level permission checks, input validation,
      file scanning, log redaction, no secrets shipped
- [ ] Scheduled backups + **rehearsed** restore, documented
- [ ] §13.2 deliverables: OpenAPI, migrations, `.env.example`, deployment
      package, technical docs, test evidence
- [ ] Walk all 15 UAT scenarios in the test environment
