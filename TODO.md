# headhunter-backend - TODO

Working checklist. Milestone definitions and ordering are in [PLAN.md](PLAN.md);
design rationale in [ARCHITECTURE.md](ARCHITECTURE.md).

Convention: `[ ]` open · `[x]` done · `[~]` in progress · `[?]` blocked on a
decision (see the bottom section).

---

## Blocking decisions to resolve first

These change schema or dependencies, so settle them before the milestone that
needs them.

- [?] **File service** - reuse `d:\Dev\secure-file-router` or implement in-repo?
      Review `secure-file-router` first; authorized short-lived access is exactly
      its purpose. *Blocks M3.*
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
- [?] **Individual-employer verification evidence** - what is actually required
      (§6.1 "if required by policy")? *Blocks M4.*
- [?] **Permitted age/gender justifications** (BR-12) - moderation must validate
      against an enumerated list. *Blocks M5.*
- [?] **Approved dictionary value lists** from the client (§13.2). *Blocks M2
      seeding, which is large - ask now.*

---

## M0 - Foundations *(done)*

- [x] NestJS 11 + SWC, Biome/ESLint split, Jest via `@swc/jest`
- [x] Kysely + pg with pooled global provider, pool closed on shutdown
- [x] Migration runner (`tsx`, Windows-safe file URL provider)
- [x] Joi env validation at boot, pino logging with redaction
- [x] helmet, CORS, global `ValidationPipe`, Swagger `/docs` + Scalar `/reference`
- [x] `GET /health` verified from the Flutter client on an emulator
- [ ] Add `docs/` deliverables scaffold: deployment, backup/restore notes (§13.2)
- [ ] Dockerfile + CI workflow (lint, typecheck, test, build)

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

### Endpoints
- [ ] `POST /auth/otp/send`, `/auth/otp/verify`, `/auth/otp/resend`
- [ ] `POST /auth/refresh` with rotation + reuse detection
- [ ] `POST /auth/logout`, `POST /auth/logout-all`
- [ ] `GET /auth/sessions`, `DELETE /auth/sessions/:id`
- [ ] `POST /auth/roles` (select roles at onboarding), `POST /auth/active-role`
- [ ] `POST /users/me/deletion-request`
- [ ] `PATCH /users/me/locale`

### Cross-cutting
- [ ] Store OTP as a **hash**; never log codes or full phone numbers
- [ ] Server-config TTL / resend delay / attempt limits via env + Joi
- [ ] Rate limit OTP and auth per phone **and** per IP
- [ ] `active_role` claim; server validates the role is actually granted
- [ ] Guard stack: authenticated → role → ownership → account status
- [ ] **BR-10 blocked-account guard on every mutating route** (do this now, not
      later - retrofitting means auditing every endpoint)
- [ ] Localized error messages, keys present in all four variants
- [ ] Tests: OTP expiry, attempt lockout, refresh reuse detection, role switch to
      an ungranted role is refused, blocked user refused on each mutation kind

## M2 - Dictionaries

Wire shapes are frozen in [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) §3.

### Schema
- [ ] `dictionary_types` (code)
- [ ] `dictionary_items` (id, type_code, code, category, parent_id, sort_order,
      `rank`, is_active, merged_into_id, `revision`)
- [ ] `dictionary_item_translations` (item_id, locale, label, `revision`) - unique
      per pair
- [ ] Index `dictionary_item_translations(item_id, locale)`
- [ ] Monotonic global `revision` sequence; bumped on every item **and**
      translation write. Type version = max revision across its rows, which is what
      makes `?since=` a real delta.
- [ ] A merge bumps the revision of **both** rows, so one delta carries the loser
      in `removed` (with `mergedIntoId`) and the survivor in `items`

### Endpoints
- [ ] `GET /dictionaries/manifest` - per-type versions **and** the 10 schema
      versions, so a cold client revalidates in one request
- [ ] `GET /dictionaries/{type}?since=<version>` with locale resolution, ETag,
      `Vary: x-lang`, 304 on `If-None-Match`
- [ ] `GET /dictionaries/items?ids=` resolving inactive and merged ids, for
      historical records
- [ ] Regions come from `type=region` via `parentId`, not a bespoke tree endpoint

### Cross-cutting
- [ ] `x-lang` normalization to `uz-Latn | uz-Cyrl | ru | en`, accepting `uz`/`oz`
      aliases (ARCHITECTURE.md §3.1) - strict allow-list, unknown → default
- [ ] Responses always **emit** canonical casing, in `locale` and in the ETag; the
      client keys its cache off the response, so a casing slip is a permanent miss
- [ ] Fallback chain `uz-Cyrl→uz-Latn`, any→`en`, **with a warning log**
- [ ] Reject activation of an item missing any of the four locales
- [ ] Test: no dictionary endpoint can ever return a bare code as a label
- [ ] Test: same occupation selected via each locale resolves to one ID (UAT-13)
- [ ] Test: emitted locale casing is exactly the four canonical codes

### Seed content *(large; needs client input)*
- [ ] Occupations / work types across all five §2.1 categories, with `category`
- [ ] Skills, industries
- [ ] Regions + districts/cities of Uzbekistan
- [ ] Languages, plus `language_level` `A1..C2` + `native` carrying `rank`
- [ ] `skill_level` scale carrying `rank`
- [ ] Employment types, work formats, shift values
- [ ] `payment_period`: monthly / daily / per-task (§6.3)
- [ ] `education_level`
- [ ] `file_purpose`: cv / certificate / evidence - drives the schema
      `attachments[]` block, so a new evidence type stays data
- [ ] Tool / transport / physical attributes

## M3 - Candidate profile + files

- [ ] `candidate_profiles` with `visibility`, `completeness_percent`,
      `is_complete`, `last_meaningful_update_at`
- [ ] `candidate_occupations`, `candidate_skills`, `candidate_languages`,
      `candidate_experience`, `candidate_education`, `candidate_attributes`
- [ ] Indexes from ARCHITECTURE.md §5 created **with** the tables
- [ ] Category-driven required-field contract endpoint (§5.2) so the client form
      adapts without hardcoding
- [ ] Recompute completeness on write; expose the missing-field list
- [ ] BR-02: searchable only when `is_complete AND visibility='searchable'`
- [ ] `last_meaningful_update_at` must **not** move on a privacy-toggle-only change
- [ ] `candidate_files`: upload, replace, download, delete; PDF/DOC/DOCX for CV
- [ ] Type + size validation; short-lived signed download URLs; no public links
- [ ] Tests: completeness maths, BR-02 gate, privacy toggle does not refresh
      the update timestamp, unauthorized file access refused

## M4 - Employer profile + verification

- [ ] `employers` (type: company | individual) + `companies` detail
- [ ] `verification_submissions` with evidence file references
- [ ] Status `not_submitted | under_review | verified | rejected | changes_required`
      + admin reason
- [ ] BR-03 precondition on invitation and vacancy-submit routes
- [ ] Test: unverified employer cannot search candidates (§7) or invite

## M5 - Vacancies + moderation

- [ ] `vacancies` + `vacancy_requirements` (skills/languages with level and
      mandatory-vs-preferred, experience, education, attributes)
- [ ] Status machine + transition validation in one place
- [ ] `vacancy_status_history` audit rows on every transition
- [ ] BR-05 check constraint `worker_count >= 1`
- [ ] BR-06 deadline/closure enforcement
- [ ] BR-11 closed leaves discovery, stays in history
- [ ] BR-12 age/gender need justification and force `under_moderation`
- [ ] Seasonal shape test: work type, date range, worker count, hours, transport,
      payment method (UAT-10)

## M6 - Discovery + applications

- [ ] Candidate feed: recommended (rule-based), recent, saved + §5.5 filters
- [ ] `applications` + **BR-07 partial unique index**
- [ ] `application_stage_history` written in the same transaction (BR-08)
- [ ] BR-06 deadline check inside the insert transaction, vacancy read `FOR SHARE`
- [ ] Apply / withdraw / save / report
- [ ] Employer application management, internal notes, hired-vs-required counts
- [ ] `Idempotency-Key` on apply
- [ ] Test: concurrent double-apply produces exactly one application

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
