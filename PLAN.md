# headhunter-backend - Delivery plan

Milestones in dependency order, each mapped to the business rules (BR-nn) and
acceptance scenarios (UAT-nn) of [docs/SPEC.md](docs/SPEC.md). Design rationale
lives in [ARCHITECTURE.md](ARCHITECTURE.md); the current working checklist is
[TODO.md](TODO.md).

The app repo has a matching `PLAN.md` with the same milestone numbering. **M2, M3
and M5 must land on the backend before the app's corresponding milestone can be
finished** - the client cannot build pickers without dictionaries or forms without
a profile contract.

---

## Milestone status

| # | Milestone | Blocks | State |
|---|---|---|---|
| M0 | Foundations (running service, health, migrations, CI-able) | everything | **done** |
| M1 | Auth, users, roles, sessions | all authenticated work | next |
| M2 | Dictionaries + seed data | M3, M5, M6, M7 | next (parallel with M1) |
| M3 | Candidate profile + files | M6, M7 | after M1+M2 |
| M4 | Employer profile + verification | M5, M7 | after M1 |
| M5 | Vacancies + moderation | M6, M7 | after M2+M4 |
| M6 | Vacancy discovery + applications | M8 | after M3+M5 |
| M7 | Candidate search + invitations + shortlists | M8 | after M3+M5 |
| M8 | Chat + interviews | - | after M6+M7 |
| M9 | Notifications + push | - | after M6 (events exist) |
| M10 | Admin module + audit | - | after M4+M5 |
| M11 | Hardening: performance, security, offline, acceptance | release | last |

---

## M0 - Foundations *(done)*

Running NestJS service with Kysely over Postgres 18, migration runner, Joi env
validation, pino logging, helmet, CORS, global validation pipe, Swagger + Scalar,
and `GET /health` verified end-to-end from the Flutter client.

## M1 - Auth, users, roles

**Covers** §4, §2.3 · **BR-01, BR-10** · **UAT-01, UAT-14 (block enforcement)**

- Phone + OTP: send, verify, resend. Hashed OTP storage; server-configured TTL,
  resend delay, attempt limits. Rate limited per phone and per IP.
- Access/refresh tokens with rotation and reuse detection; `active_role` claim.
- Sessions: list, revoke one, revoke all. New-device and phone-change
  confirmation.
- `users`, `user_roles` (multi-role), locale on the user, account status
  (`active | restricted | blocked | deletion_requested`).
- Role selection at the end of registration; role switch endpoint.
- Guard stack: authenticated → role → ownership → account status. **BR-10 blocked
  guard applied to every mutating route from day one** - retrofitting it later
  means auditing every endpoint.
- Account deletion request with confirmation.

**Done when:** a client can register with any of the four locales, pick
candidate/employer/both, switch roles, and a blocked user is refused every
mutation with a clear reason.

## M2 - Dictionaries

**Covers** §3.2, §3.3, §10.3 · **BR-13** · **UAT-13**

- `dictionary_types`, `dictionary_items` (self-referencing for region→district,
  `category` for occupation grouping, `merged_into_id` for skill merges),
  `dictionary_item_translations`.
- Read endpoints resolving labels by normalized `x-lang`, with the documented
  fallback chain and a warning log on miss. Cacheable responses with a
  **dictionary version/ETag** so the client can cache aggressively.
- Activation rule enforced: **all four locales present before `is_active`**, with
  a test.
- Seed the initial dictionaries from §13.2 "Initial dictionaries": occupations and
  work types across all five categories of §2.1, skills, industries, regions and
  districts, languages with CEFR levels, employment types, work formats, shifts,
  and tool/transport attributes - each with four labels.

**Done when:** selecting an occupation in any of the four variants yields the same
ID, and no endpoint can return a raw code as a label.

> Seeding is the largest single content task in the project and needs client
> input on the approved value lists. Start it early; it is not a day of work.

## M3 - Candidate profile + files

**Covers** §5 · **BR-02, BR-09** · **UAT-02, UAT-03, UAT-12**

- `candidate_profiles` plus occupations, skills, languages, experience,
  education, attributes (§4 of ARCHITECTURE.md).
- Category-driven required-field sets returned to the client so the form adapts
  without hardcoding (§5.2).
- Stored `completeness_percent` / `is_complete`, recomputed on write; missing-field
  list for the client's prompts.
- `visibility` enum; BR-02 gate on searchability.
- `last_meaningful_update_at` distinct from `updated_at`.
- File upload/replace/download/delete with type and size validation, authorized
  access via short-lived signed URLs. **Resolve the file-service decision first**
  (ARCHITECTURE.md §9).

**Done when:** a profile with occupation, experience, Russian C1, location and
preferences saves, reports completeness, becomes searchable only when complete
and visible, and its CV is reachable only by an authorized employer.

## M4 - Employer profile + verification

**Covers** §6.1 · **BR-03** · **UAT-04**

- Company and individual employer profiles; verification submission with
  evidence files.
- Status: `not_submitted | under_review | verified | rejected | changes_required`,
  with admin reason text.
- BR-03 precondition wired into invitation and vacancy-submit routes.

## M5 - Vacancies + moderation

**Covers** §6.3, §6.4 · **BR-04, BR-05, BR-06, BR-11, BR-12** · **UAT-05, UAT-10, UAT-15**

- `vacancies` + structured `vacancy_requirements` (skills with level, languages
  with level and mandatory/preferred flag, experience, education, attributes).
- Status machine of ARCHITECTURE.md §6 with audit rows on every transition.
- Worker-count check constraint (BR-05); deadline and closure logic (BR-06, and
  BR-11 removal from active discovery while retained in history); moderation
  queue and decisions (BR-04).
- Conditional age/gender fields require justification and force moderation
  (BR-12).
- Seasonal/agricultural shape verified explicitly: work type, date range, worker
  count, hours, transport, payment method (§7.5, UAT-10).

## M6 - Discovery + applications

**Covers** §5.5, §5.6, §8.1 · **BR-06, BR-07, BR-08** · **UAT-08, UAT-15**

- Candidate vacancy feed: recommended (rule-based on occupation/location/
  preferences), recent, saved. Filters per §5.5.
- Apply / withdraw / save / report.
- **BR-07 partial unique index**, **BR-06 in-transaction deadline check**,
  **BR-08 stage-history row in the same transaction**.
- Employer application management: grouping, filters, stage moves, internal notes
  not visible to candidates, hired-count against required worker count (§6.5).
- `Idempotency-Key` support on apply (ARCHITECTURE.md §7).

## M7 - Candidate search + invitations

**Covers** §7, §8.2 · **BR-09** · **UAT-06, UAT-07**

- Structured search over all filter groups of §7.1, verified-employer only.
- Count-before-open endpoint returning `{count, isExact}`.
- Match scoring with per-group breakdown; sort options of §7.3.
- Prefill contract: search opened from a vacancy returns the vacancy's
  requirements as an editable filter set (UAT-06).
- Saved candidates, vacancy-scoped shortlists, private employer notes.
- Invitations: to a vacancy or general; accept / decline / request details.
- **BR-09 contact-exposure helper** applied to every candidate serializer; cards
  never carry phone numbers (§11.1).

## M8 - Chat + interviews

**Covers** §9.1, §8.3 · **UAT-09**

- Gated conversation creation, message send with attachments, per-recipient
  read state, report/block, read-only when the interaction closes.
- Interview scheduling with type-dependent required fields and candidate
  response.

## M9 - Notifications

**Covers** §9.2

- In-app records for all nine event types with correct recipients; unread count;
  mark read; preferences with non-disableable security notices.
- Push dispatch (provider decision pending), device token registration, delivery
  independent of the stored record.

## M10 - Admin module + audit

**Covers** §10, §11 · **BR-12, BR-14** · **UAT-11, UAT-14**

- Dashboard counters (§10.1).
- Employer verification and vacancy moderation decisions with mandatory reasons.
- Complaint review over users, vacancies, messages, profiles.
- User management: search, status, warn/restrict/block/unblock with reason.
- Dictionary management including localized labels and skill merging.
- **Append-only audit log** - no update or delete path exists, enforced by
  permissions and asserted in a test.

## M11 - Hardening and acceptance

**Covers** §12.4, §12.5, §13

- Load-test the two budgets (p95 < 2s standard, < 3s search first page) and fix
  what misses. Only then consider the denormalized projection escape hatch.
- Five rate-limit buckets: OTP, auth, search, messaging, files.
- Security pass: server-side permission checks on every protected route,
  input validation, file-type/size and malware scanning, no secrets in the client,
  log redaction review.
- Backups: scheduled dumps plus a **documented and rehearsed restore**.
- Deliverables of §13.2: OpenAPI description, migrations, `.env.example`,
  deployment package, technical documentation, test evidence.
- Walk all 15 UAT scenarios in the test environment.

---

## Cross-cutting work not owned by one milestone

| Work | When |
|---|---|
| Seed dictionary content (client input) | starts at M2, likely continues to M5 |
| OpenAPI accuracy (it is a contract deliverable, §13.2) | every milestone |
| Audit rows for new state changes | with each status machine |
| Rate-limit bucket for each new sensitive route | with the route |
| Idempotency on each new non-idempotent write | with the route |
| Localized error messages | from M1; keys must exist in all four variants |
