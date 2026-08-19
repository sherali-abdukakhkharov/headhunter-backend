# headhunter-backend - Delivery plan

Milestones in dependency order, each mapped to the business rules (BR-nn) and
acceptance scenarios (UAT-nn) of [docs/SPEC.md](docs/SPEC.md). Design rationale
lives in [ARCHITECTURE.md](ARCHITECTURE.md); the current working checklist is
[TODO.md](TODO.md).

> **Revised 2026-08-10.** The client issued a new specification adding an employer
> Coin wallet, Candidate Unlock, and Payme/CLICK top-up: M12 and M13 below. It also
> **edited four sections that M6, M7 and M8 already implement** - contact details and
> CV access are now bought rather than earned through a hiring interaction. That is
> not additive, and M12 carries the retrofit. See
> [docs/SPEC_CHANGELOG.md](docs/SPEC_CHANGELOG.md), and read the open question at the
> top of it before starting M12: one answer from the client removes half the retrofit.

The app repo has a matching `PLAN.md` with the same milestone numbering. **M2, M3
and M5 must land on the backend before the app's corresponding milestone can be
finished** - the client cannot build pickers without dictionaries or forms without
a profile contract.

---

## Milestone status

| # | Milestone | Blocks | State |
|---|---|---|---|
| M0 | Foundations (running service, health, migrations, CI-able) | everything | **done** |
| M1 | Auth, users, roles, sessions | all authenticated work | **done**; OTP login works on a fixed code, SMS delivery open |
| M2 | Dictionaries + seed data | M3, M5, M6, M7 | **done**; content awaiting client lists |
| M3 | Candidate profile + files | M6, M7 | **done**; BR-09 CV access delivered in M6, once its inputs existed |
| M4 | Employer profile + verification | M5, M7 | **done**; verification auto-approves until M10 gives it a reviewer |
| M5 | Vacancies + moderation | M6, M7 | **done**; BR-12 restrictions wait for M10 by design |
| M6 | Vacancy discovery + applications | M8 | **done - the MVP loop closes here** |
| M7 | Candidate search + invitations + shortlists | M8 | **done**; UAT-06 walkable end to end |
| M8 | Chat + interviews | - | **done** |
| M10 | Admin module + audit | - | **done**; both MVP flags now on |
| M9 | Notifications + push | - | **done**; FCM configured and verified end to end |
| M11 | Hardening: performance, security, offline, acceptance | release | **done** — §12.4 measured, §12.5 reviewed, restore rehearsed, UAT-01..15 executable, BR-14 answered |
| M12 | Employer wallet, Coins, Candidate Unlock | M13 | **done** — and the BR-09 retrofit landed with it, on the reading that an application is an approved entitlement |
| M13 | Payme and CLICK top-up | release | **done** — both providers, callbacks verified, crediting exactly once; needs merchant accounts to be switched on |

**Every milestone is now built.** What stands between this and a release is not code: the SMS
templates through Eskiz moderation (M1), the two payment merchant accounts (M13), a stable
public HTTPS host for the payment callbacks, and one IKPU classifier code for §6.7's receipt.
**The client answered the seven open questions on 2026-08-20** — see the top of
[TODO.md](TODO.md); six are closed and the fiscal one is half closed.

Two items that used to be on that list are off it, and for different reasons. **The first
administrator is granted by the seeder** since 2026-08-19 — `SEED_ADMIN_PHONES` carries
`phone[:full name]`, and no route grants the role on purpose. **The CI workflow is deferred
indefinitely** on the client's direction of the same date: the owner will wire it up before
going to production, and it is deliberately not counted as outstanding work here.

The 2026-08-10 revision added M12 and M13, and they were not small: money, an append-only
ledger, two payment providers and a change to a privacy rule that was already live. Nothing in
M0-M11 was invalidated, and **M6's BR-09 behaviour was not rewritten either** — because the
retrofit was built on the reading that an application *is* one of §11.1's "explicitly approved
entitlements". A candidate who applied to an employer volunteered contact with them, which is
what §11.1's own escape hatch allows, so the unlock is for candidates who have **not** applied.

That reading was the team's, taken 2026-08-19 to unblock the client's unlock UI, and it is the
one that leaves M6, M7, M8 and their tests as delivered. **The client signed it off on
2026-08-20**, so it is the product's reading now rather than a risk being carried. §9.1 read
strictly says the opposite, and had the client chosen it the change would have inverted two
reason codes and reached into M6, M7 and M8 — which is why the smaller reading shipped first
and why the reversal cost was written down while it was still a possibility.

---

## MVP scope

Client direction, 2026-08-04: **MVP first, notifications last to build and test.**
M9 therefore moves behind M10 despite its events existing from M6.

MVP is the core loop — employer posts, candidate applies: **M1 · M2 · M3 · M4 ·
M5 · M6**. Outside it: M7, M8, M9, M10.

Two consequences worth holding onto:

- **BR-04 has no enforcer inside the MVP.** "A vacancy requiring moderation is
  not visible until approved" needs the admin moderation screen, which is M10.
  Without it a submitted vacancy parks in `under_moderation` forever and the loop
  never closes. Resolved by `MODERATION_ENABLED` (see M5) rather than by pulling
  M10 forward.
- **Dropping M7 costs the spec's flagship scenario.** §7.4 / UAT-06 - "20 Russian
  C1 operators" - is employer-side candidate search, and §1 frames
  discovery-without-a-CV as the product's differentiator. A demo without M7 cannot
  walk the client's own controlled example. Recommendation on record: keep a
  reduced M7 (filters + result list + count-before-open) in the MVP and defer
  saved searches and shortlists.

---

## M0 - Foundations *(done)*

Running NestJS service with Kysely over Postgres 18, migration runner, Joi env
validation, pino logging, helmet, CORS, global validation pipe, Swagger + Scalar,
and `GET /health` verified end-to-end from the Flutter client.

## M1 - Auth, users, roles *(done - SMS delivery still owed)*

**Covers** §4, §2.3 · **BR-01, BR-10** · **UAT-01, UAT-14 (block enforcement)**

- Phone + OTP: send, verify, resend. Hashed OTP storage; server-configured TTL,
  resend delay, attempt limits. Rate limited per phone and per IP.
  - *Delivery is the one gap.* No SMS provider is bought, so `OTP_STATIC_CODE`
    issues a fixed code and production boot refuses it. Eskiz.uz is the intended
    provider ([docs/SMS_PROVIDER.md](docs/SMS_PROVIDER.md)); connecting it is
    additive — a sender behind the existing transaction, no route or DTO change.
  - Telegram login (`POST /auth/telegram`) was primary for one day on 2026-08-05
    and is now **deprecated but still working**. Both paths converge on the same
    session issuance, so an account can hold both credentials.
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

## M2 - Dictionaries *(done)*

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

*Status: the mechanism is complete and tested; the content is not, and cannot be
without the client.* `pnpm seed` is idempotent, so the lists can arrive in
batches. `occupation`, `skill`, `industry` and the districts under each region
serve empty sets until they do — which means the pickers M3 and M5 build against
work, but have nothing meaningful to offer yet. Four further types
(`language`, `skill_level`, `shift`, `education_level`) carry a conventional
default, and on 2026-08-20 the client chose to ship those sets unreviewed —
a correction stays one edit plus `pnpm seed`.

> Seeding is the largest single content task in the project and needs client
> input on the approved value lists. Start it early; it is not a day of work.

## M3 - Candidate profile + files *(done)*

**Covers** §5 · **BR-02, BR-09** · **UAT-02, UAT-03, UAT-12**

- `candidate_profiles` plus occupations, skills, languages, experience,
  education, attributes (§4 of ARCHITECTURE.md).
- Category-driven required-field sets returned to the client so the form adapts
  without hardcoding (§5.2).
- Stored `completeness_percent` / `is_complete`, recomputed on write; missing-field
  list for the client's prompts.
- `visibility` enum; BR-02 gate on searchability.
- `last_meaningful_update_at` distinct from `updated_at`.
- ~~File upload/replace/download/delete with type and size validation~~ **done**,
  on the Telegram Bot API (ARCHITECTURE.md §9). Note the shape differs from the
  original plan: **no signed URLs**, because Telegram's file URL carries the bot
  token. Bytes are proxied through this API after an ownership check, which is a
  stricter reading of §11.1. What M3 adds is attaching a file to a profile and
  BR-09's rule for employer access.

**Done when:** a profile with occupation, experience, Russian C1, location and
preferences saves, reports completeness, becomes searchable only when complete
and visible, and its CV is reachable only by an authorized employer.

*Status: done, with one part deliberately deferred.* Everything above is built and
tested: the schema endpoint, the uniform field write with server-side
re-validation, stored completeness with a missing-field list, the BR-02 gate, the
privacy toggle that does not refresh `last_meaningful_update_at`, the bespoke
experience and education sub-resources, and profile attachments with §5.4's
replace-by-superseding.

**BR-09's employer access to a CV is not built**, because two of the helper's three
inputs do not exist yet - there is no employer profile before M4 and no
application or invitation before M6/M7, so "an allowed hiring interaction" has
nothing to evaluate. Today a CV is reachable **only by its owner**, which is
stricter than BR-09 asks, so the gap exposes nothing; it is a missing capability,
not a missing check. It lands with M4's verified employer and M7's candidate
serializer, which is where the callers are. Building the helper now would mean an
abstraction with no caller and a rule tested only against invented inputs.

Two decisions worth knowing before building on this:

- **The field schema is one declaration serving three jobs** - the client's form,
  the server's re-validation of a write, and the completeness calculation. That is
  what makes §4.1's rule ("every `requiredForSearchable` code resolves to a
  rendered field") true by construction rather than by review. M5's vacancy schema
  should reuse the same shape.
- **A profile has no category until a primary occupation is chosen**, and only the
  fields common to all five categories exist until then. The client's first profile
  screen is therefore choosing the target work.

## M4 - Employer profile + verification *(done)*

**Covers** §6.1 · **BR-03** · **UAT-04**

- Company and individual employer profiles; verification submission with
  evidence files.
- Status: `not_submitted | under_review | verified | rejected | changes_required`,
  with admin reason text.
- BR-03 precondition wired into invitation and vacancy-submit routes.

*Status: done.* Three decisions worth carrying into M5:

- **`EMPLOYER_VERIFICATION_ENABLED` is off**, for the same reason `MODERATION_ENABLED`
  exists below: the admin module is M10, so nobody can approve a submission, and
  BR-03 would strand every employer in `under_review` and make the employer half of
  the product unreachable. Submit therefore transitions straight to `verified` — and
  **still writes its BR-08 history row**, with a null actor and an
  `auto_verified_no_reviewer` reason, so the audit trail never claims a person
  reviewed anything. The statuses, transitions, evidence rules and BR-03 are all
  implemented; only the queue is absent, and flipping the flag needs no client change.
- **§6.1's open question is answered as data, not deferred.** What each employer type
  must upload lives in `employer-requirements.ts` with a `spec | default` provenance
  tag per value, exactly as dictionary content does. The client's answer is one edit
  to one file — no migration, no endpoint, no release. This is what stopped the
  milestone being blocked, and the same move is available for BR-12's permitted
  age/gender justifications, which currently block M5's moderation.
- **BR-03 is one method, not three checks.** `EmployersService.gate` returns the two
  conditions separately, because "finish your profile" and "wait for verification"
  are different refusals. M5's vacancy submit and M7's search and invitations call it
  rather than reading the status; a precondition duplicated across three modules is
  one that drifts, and the failure mode is an unverified employer reaching candidate
  contact details.

## M5 - Vacancies + moderation *(done)*

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
- **`MODERATION_ENABLED` env flag.** With the admin module out of the MVP there is
  nothing that can approve a vacancy, so submit would strand every vacancy in
  `under_moderation` and BR-04 would silently block the whole loop. When the flag
  is off, submit transitions `draft → active` directly. The status enum,
  `under_moderation`, `rejected` and the BR-04 visibility rule all stay
  implemented; only the queue is absent. The transition **still writes its audit
  row** (BR-08) with a system actor and an `auto_approved_no_moderator` reason, so
  the history never claims a human approved it. Flipping the flag on when M10
  lands needs no client change.

*Status: done.* Four things worth carrying forward:

- **BR-12 overrides the flag, deliberately.** A vacancy carrying an age or gender
  restriction goes to `under_moderation` whatever `MODERATION_ENABLED` says, because
  BR-12 makes "administrator review" part of the rule rather than an optimisation. The
  consequence is real and accepted: such a vacancy **cannot be published until M10**.
  That is the right failure — the alternative is auto-approving a restriction nobody
  checked — and the employer sees the status rather than silence. Changing a
  restriction on an already-live vacancy sends it back for review for the same reason.
- **BR-12's permitted reasons are enumerated as data**, like M4's evidence rules:
  `age-gender-justifications.ts` for the rule (which reason supports which
  restriction, with an argument per entry) and a `restriction_justification` dictionary
  for the four labels. The split is deliberate — a dictionary row is admin-editable
  (§10.3), and widening BR-12 must not be a content edit. **It wants legal review.**
- **The vacancy field schema shares the candidate profile's mechanism entirely** — one
  resolver, one validator, one contract test over both targets. The contract test also
  pins that shared field codes mean the same thing on both sides, which is what M7's
  UAT-06 prefill depends on: it maps a vacancy's requirements onto candidate filters by
  code.
- **BR-06 has one definition**, `isOpenForApplications(status, deadline, today)`,
  exported for M6. The feed filter and the in-transaction apply check must both use it;
  a feed advertising a vacancy the apply route refuses is the failure that guards
  against.

## M6 - Discovery + applications *(done)*

**Covers** §5.5, §5.6, §8.1 · **BR-06, BR-07, BR-08** · **UAT-08, UAT-15**

- Candidate vacancy feed: recommended (rule-based on occupation/location/
  preferences), recent, saved. Filters per §5.5.
- Apply / withdraw / save / report.
- **BR-07 partial unique index**, **BR-06 in-transaction deadline check**,
  **BR-08 stage-history row in the same transaction**.
- Employer application management: grouping, filters, stage moves, internal notes
  not visible to candidates, hired-count against required worker count (§6.5).
- `Idempotency-Key` support on apply (ARCHITECTURE.md §7).

*Status: done. **The MVP core loop is complete*** - an employer publishes, a candidate
finds and applies, the employer moves them through the stages to a hire. Verified end to
end through hh.qitmir.uz.

Four things worth carrying into M7:

- **BR-09 is built**, and it is one pure function
  (`infra/privacy/contact-exposure.ts`) taking (viewer, visibility, interaction). It
  was deferred out of M3 for want of its inputs and landed here as soon as they existed.
  M7's candidate search **must** build its cards from `expose()` and never from the
  profile row: §11.1 forbids a phone number on a search card, and a card is not an
  interaction. Adding invitations as the second interaction is one line in
  `CandidateViewService`, not a change to the rule.
- **The employer's file access is a separate route**,
  `GET /applications/:id/files/:fileId/content`. `GET /files/:id/content` stays
  owner-only: an employer's entitlement comes from the application, so the route that
  serves them has to be the one that can see it. BR-09 is re-evaluated per download,
  because a client may hold a path from a moment when the interaction still existed.
- **Idempotency and BR-07 are both needed and do different jobs.** The index prevents a
  duplicate but answers a retry with a conflict, indistinguishable from "somebody else
  got there first". The key makes an interrupted-but-committed request replay as the
  success it was. M7's invitations and M8's messages need the same treatment.
- **One visibility fragment behind every discovery read.** BR-04, BR-06 and BR-11 live
  in it, and a feed that advertised a vacancy the apply route refuses would look like a
  bug in Apply. M7's candidate search wants the same discipline with BR-02's gate.

## M7 - Candidate search + invitations *(done)*

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

*Status: done.* §7.4's controlled example is walkable end to end - open the search from a
vacancy, review the ranked operators, save the good ones, invite them, and read the invited
and accepted counts against the target. Five things to carry into M8:

- **The query is four stages and the order is the performance story**: filter and count,
  score, sort and take the page, and only then build the cards. The card's aggregates run
  for at most one page. M8's message lists should be shaped the same way.
- **A card carries no contact details and BR-09 is not asked about it.** §11.1 is
  unconditional for cards, so the query does not join `users` and the type has no field for
  a phone number; a test asserts that over the compiled SQL. The rule still decides the
  profile view, through M6's single gatherer.
- **Both of BR-09's interactions now exist.** An accepted invitation was the second, and
  adding it was one line in the gatherer - which is what passing both flags explicitly was
  for. M8's chat gate (§9.1) should read applications and invitations rather than invent a
  third notion of "may these two talk"; §8.2 already says acceptance "enables the
  corresponding communication flow".
- **An interaction is derived from data, never from an id in the URL.** Wiring the second
  entry point onto M6's reader exposed that trusting the path would let a view requested
  through a *withdrawn* application re-grant what the withdrawal took back. M6's own test
  caught it because it asserted the side effect rather than the exception.
- **Three §7.1/§7.3 items could not be built as worded**, and the client answered two of
  them the same day. Specialization became a **dictionary** on both the profile and the
  vacancy (schema versions bumped to 2, clients refetch, old free text deleted rather than
  guessed at), and proximity shipped as a **tiered** sort with its own reference field.
  The third was never a gap: remote-work readiness is a `work_format` id, not a boolean.
  The pattern is worth keeping - where the specification's wording and BR-13 disagree, the
  id-shaped form is the one that works in four languages.

## M8 - Chat + interviews *(done)*

**Covers** §9.1, §8.3 · **UAT-09**

- Gated conversation creation, message send with attachments, per-recipient
  read state, report/block, read-only when the interaction closes.
- Interview scheduling with type-dependent required fields and candidate
  response.

*Status: done.* Three things to carry into M10 and M9:

- **The gate is one service, asked live.** `HiringInteractionService` answers BR-09 and
  §9.1 alike, and stores nothing - so a withdrawal closes the channel and a new
  interaction reopens it with no repair step anywhere. M10's admin actions should read it
  rather than add a third notion of who may talk to whom.
- **`delivered` is deliberately missing from the message state.** §9.1 asks for it "where
  supported by the backend", and it is a property of push: M9 adds the dispatcher, and the
  column with it. Adding one now would have meant a field set at the same instant as
  `createdAt`, which answers nothing.
- **Chat reports are `complaints` rows** with `target_type = 'message'`, so M10's review
  queue already covers them - the generic table M6 built is now carrying its third target
  kind without a schema change.

## M9 - Notifications *(done)*

**Covers** §9.2

- In-app records for all nine event types with correct recipients; unread count;
  mark read; preferences with non-disableable security notices.
- Push dispatch (provider decision pending), device token registration, delivery
  independent of the stored record.

*Status: done.* The provider question is answered - **FCM**, client direction 2026-08-07 -
and four things are worth carrying into M11:

- **A notification stores a message key and its parameters, never text.** `users.locale`
  can change after the event, so rendering at write time would freeze a user's history in
  the language they used last month. The consequence to remember when writing any new
  notification: a status name cannot be interpolated, because an enum code would reach the
  reader untranslated.
- **The credential is the only thing owed**, and its absence is a supported state: the
  no-op sender reports `failed` rather than pretending, and every notification is still
  written and readable in-app. Setting `FCM_SERVICE_ACCOUNT_BASE64` is the whole
  difference.
- **FCM needs Google Play services on the device, not a Play Store install** - so a
  sideloaded APK is fine, and a post-2019 Huawei is not. Those users lose the banner and
  nothing else. Huawei Push Kit is a second `PushSender` if the client ever asks.
- **Every integration suite now constructs the real notifications service**, so a miswired
  event fails in the suite that owns the flow rather than in M9's.

## M10 - Admin module + audit *(done)*

**Covers** §10, §11 · **BR-12, BR-14** · **UAT-11, UAT-14**

- Dashboard counters (§10.1).
- Employer verification and vacancy moderation decisions with mandatory reasons.
- Complaint review over users, vacancies, messages, profiles.
- User management: search, status, warn/restrict/block/unblock with reason.
- Dictionary management including localized labels and skill merging.
- **Append-only audit log** - no update or delete path exists, enforced by
  permissions and asserted in a test.

*Status: done, and it is the milestone that closes two deferrals.* Four things to carry
forward:

- **Both MVP flags are on, and no domain code changed to turn them on.** M4's
  `VerificationService.decide` and M5's `VacanciesService.moderate` already held the
  transitions, the mandatory reasons and the BR-08 rows; M10 supplied the queue, the actor
  and the audit row. That is the whole argument for the pattern: when a milestone is missing
  its *actor*, build the rule with the actor as a parameter and disable the route, not the
  rule.
- **A BR-12 restricted vacancy publishes for the first time.** It was unreachable from M5
  by design, and resolving it needed a reviewer rather than a line of code.
- **Immutability is enforced by the table.** Three statement-level triggers refuse `UPDATE`,
  `DELETE` and `TRUNCATE` on the audit log — a service with no write path is a fact about
  today's code, not about the data. The actor is `RESTRICT`, so an administrator who has
  acted cannot be deleted: that collides with **BR-14** deliberately, and M11 has to resolve
  it rather than let a cascade take the trail.
- **§10.4's "temporary" restriction has no scheduler behind it.** `AccountStatusGuard`
  already reads the user's row on every mutation, so it lifts an expired restriction there
  and writes the history row with a null actor. The stated imperfection: a read-only request
  does not trigger the lift.

Still open here, and it is an ops step rather than code: **the deployed instance has no
administrator account.** There is deliberately no route that grants the role, so the first
one is one `INSERT INTO user_roles` — until then that instance has to keep both flags off.

## M11 - Hardening and acceptance *(done)*

**Covers** §12.4, §12.5, §13 · **BR-14**

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

*Built, and six things are worth carrying forward.*

- **The two budgets pass with an order of magnitude to spare**, so the projection stays
  deferred. The useful result was the *curve*, not the pass: measuring at 50k and again at
  200k showed the unfiltered search is linear in the searchable population, and
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md) names the volume that reopens the question
  (500k) and the cheaper fix to try before a projection.
- **The public route surface is frozen by a test**, not by review. "Permission enforcement
  for every protected API" is a property of the *set* of routes, and the realistic failure
  is an unintended `@Public()`, not a missing guard.
- **The fifteen acceptance scenarios are a test file** (`src/uat/uat.int.spec.ts`), one
  `describe` per row of §13.1, run with both moderation flags on because that is the
  product the scenarios describe. They found no defect.
- **The restore is rehearsed**, and the drill provokes a rule rather than counting objects:
  so many of this product's guarantees *are* database objects that a dump which restored
  the tables and dropped a predicate would look healthy.
- **BR-14 came off the blocking list without the client answering it**, using the pattern
  that already worked twice: the policy is data with a provenance tag. The M10 collision is
  resolved by erasing the person and keeping the actor - `RESTRICT` got the answer it was
  holding out for rather than being relaxed.
- **Two gaps are stated rather than closed**: malware scanning cannot be done where the
  bytes live, and `API_DOCS_ENABLED` on a public hostname is an operator decision.

---

## M12 - Employer wallet, Coins, Candidate Unlock

**Covers** §6.6, §10.5, §11.1, §12.3.1 · **BR-15, BR-16, BR-17, BR-18, BR-21, BR-24** ·
**UAT-16, UAT-17, UAT-18, UAT-19**

New in the 2026-08-10 revision. Money enters the product, and with it the first data in
this system somebody can be *wrong about* in a way they will notice on a bank statement.
Two properties drive every decision below: **the ledger is append-only** (BR-24) and **the
debit and the entitlement are one transaction** (BR-18).

### Schema

- `employer_wallets` - one row per employer, holding the **cached** balance and the
  registration-bonus timestamp. Cached, not authoritative: the ledger is the truth, and the
  column exists so a balance read is not a sum over history. A test proves the two agree
  after every kind of transaction.
- `wallet_transactions` - the immutable Coin ledger. `REGISTRATION_BONUS`, `TOP_UP`,
  `CANDIDATE_UNLOCK`, `ADMIN_ADJUSTMENT`, `REVERSAL`; amount, balance before and after,
  reference, timestamp. **Append-only in the database** - the same three statement-level
  triggers the audit log uses. BR-24 is not a promise the service makes; it is a property
  of the table.
- `candidate_unlocks` - the entitlement. **A unique index on (employer_user_id,
  candidate_user_id)** is what makes BR-16 true under a double tap, not a check in the
  service; §12.3.1 asks for exactly that.
- The 10-Coin bonus needs a **partial unique index** on
  `wallet_transactions (employer_user_id) WHERE kind = 'REGISTRATION_BONUS'`. BR-15's
  "exactly once, and not again after logout, reinstall, device change or role switch" is a
  uniqueness problem - every one of those four is a retry of the same insert.

### Pricing is configuration, and the price is stored on the row

§6.6 makes the Coin price and unlock cost "server-side business configuration, not
hard-coded in Flutter", and §10.5 adds that a change "affects future transactions only and
does not rewrite historical ledger records". So the price is read at transaction time and
**written onto the transaction**: a ledger that recomputed value from today's price would
restate last month's history every time the client repriced.

### Endpoints

- `GET /wallet` - balance, current pricing, recent activity (§6.2's Wallet tile).
- `GET /wallet/transactions` - the ledger, paged.
- `GET /wallet/unlocks/{candidateUserId}` - already unlocked or not, so the client can
  render the unlocked state without guessing.
- `POST /wallet/unlocks` - the atomic debit plus entitlement, **idempotent** by
  `Idempotency-Key`; the existing `IdempotencyService` already covers this shape, and a
  duplicate must return the first outcome rather than debit twice.
- `GET /admin/wallets`, `GET /admin/wallets/{userId}`,
  `POST /admin/wallets/{userId}/adjust` (§10.5) - the adjustment carries a mandatory
  reason and writes a ledger row **and** an audit row, exactly as §10.4's actions do.

### The retrofit, and why it belongs to this milestone

§11.1 and §9.1 now gate contact details, CV, chat, interviews and invitations on the
entitlement. M6/M7/M8 gate them on a live hiring interaction
(`HiringInteractionService`). The unlock is a **third condition**, not a replacement for
the privacy settings - so the BR-09 helper gains a parameter and every caller is
re-checked:

- `infra/privacy/contact-exposure.ts` - the one place the rule lives, so this is one edit
  plus a table of cases.
- `CandidateViewService.forApplication` / `forCandidate` - structured data stays free;
  contact and files need the entitlement.
- The four entitlement-bearing file routes.
- `ChatService` - employer-initiated conversations (§9.1).
- `InvitationsService.invite` (§8.2).

**Every existing BR-09 test asserts the old contract and has to change deliberately** -
including M6's regression test for a withdrawn application revoking exposure, which is
still a rule, now one of three.

*Blocking question for the client, and it halves this work:* §11.1 says contact becomes
available "after a successful Candidate Unlock **or another explicitly approved
entitlement**". Does a candidate's own application count as one? A candidate who applies
has volunteered their interest, and reading it that way leaves M6 intact. §9.1 as written
says no. **Ask before building.**

### Tests that carry their weight

- Two concurrent unlocks of the same pair: one debit, one entitlement.
- Two concurrent first-registrations of the same employer: one bonus.
- A wallet holding 1 Coin refuses the unlock and writes no ledger row.
- The cached balance equals the ledger sum after a mixed sequence.
- `UPDATE` and `DELETE` on `wallet_transactions` are refused by the database.
- A reversal is a new row and the balance moves; nothing is rewritten.

---

## M13 - Payme and CLICK top-up

**Covers** §6.7, §12.6, §12.7 · **BR-19, BR-20, BR-22, BR-23** ·
**UAT-20, UAT-21, UAT-22, UAT-23**

A wallet with no way to fill it is a demo, so this follows M12 immediately. The whole
milestone turns on one sentence in §6.7: *"A client-side success redirect is not sufficient
to credit Coins."*

### Schema

- `payment_orders` - internal order id, employer, provider, requested Coins, UZS amount,
  status, provider transaction id, timestamps, provider metadata. Statuses at least
  `CREATED`, `PENDING`, `PAID`, `FAILED`, `CANCELLED`, `REVERSED`.
- `payment_events` - every callback and status poll with its verification result and
  idempotency key (§12.3). The reconciliation trail, append-only for the same reason the
  ledger is.
- **A unique constraint on (provider, provider_transaction_id)**, and a state machine that
  can only reach `PAID` once. BR-19 - "credits Coins exactly once regardless of duplicate
  callbacks or retries" - is that constraint plus a conditional
  `UPDATE ... WHERE status <> 'PAID'`, not an `if` in a handler. UAT-22 delivers the same
  callback twice and is the most important test in the milestone.

### The provider seam, for the third time

Two providers with genuinely different protocols - Payme's Merchant API
(`CheckPerformTransaction`, `CreateTransaction`, `PerformTransaction`,
`CancelTransaction`, `CheckTransaction`, `GetStatement`, amounts **in tiyin**) and
CLICK's Shop API (`Prepare` / `Complete` with signature verification). Both go behind one
`PaymentProvider` abstraction - the same seam shape as `SmsSender` and `PushSender`:

- The wallet knows `PaymentOrder`, never a provider's field names.
- A no-op provider for a deployment with no merchant account, reporting failure rather
  than a credit, per the house rule.
- §12.7 requires the ledger to stay provider-agnostic so a store build can substitute
  Apple IAP or Google Play Billing **without changing unlock behaviour**. Designing to
  that now is far cheaper than retrofitting a fourth implementation.

### Callbacks are a new public route surface

Provider callbacks arrive unauthenticated by our own scheme, making them the first public
**mutating** routes in the product. To design for rather than discover:

- Each provider's signature check runs **before** the order is touched, and a failed check
  is a logged event, not a state change.
- They must be added to `api-surface.spec.ts`'s frozen public list with a written reason.
  That test exists to make exactly this decision visible.
- Their own rate-limit bucket, and no localization: a provider is not a person.
- The amount is recalculated server-side from the Coin price - §12.3.1, "client-provided
  totals are never trusted as the source of truth".

### What the client owes before this can finish

Merchant accounts and credentials for both providers, the fiscal receipt attributes (§6.7
leaves VAT and service codes to their accounting function), and a §12.7 decision per
storefront. Sandbox credentials are enough to build and test everything short of
production activation - and §12.6 requires provider-test-environment testing before
production credentials are activated, so that order is their constraint as much as ours.

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
