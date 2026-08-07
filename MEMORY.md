# headhunter-backend - Decision and context log

Durable context that is **not** recoverable from the code: decisions and their
reasons, traps already paid for, and facts about this environment. Append new
entries at the top of the relevant section; do not delete an entry when something
changes - supersede it, so the reasoning stays readable.

Not for: things the code already says, or the milestone checklist (that is
[TODO.md](TODO.md)).

---

## Project facts

- **Product**: Universal HeadHunter - a mobile-only recruitment platform for
  Uzbekistan covering professional, service, physical, seasonal/agricultural and
  temporary/shift work. Client specification: [docs/SPEC.md](docs/SPEC.md)
  (converted from the client's approval-version .docx, Tashkent 2026).
- **Client repo pair**: this API plus `d:\Dev\tgbots\headhunter-app` (Flutter,
  Android + iOS). Both are separate GitHub repos under
  `sherali-abdukakhkharov`.
- **There is no web anything.** No public site, no desktop client, and
  critically **no web admin panel** - administration is a role inside the mobile
  app. Admin endpoints are therefore ordinary API routes with strict role guards.
- **Four interface variants, three languages**: Uzbek Latin, Uzbek Cyrillic,
  Russian, English. Uzbek ships in two scripts, which is why the count is four.
- **Hard out-of-scope list** (§2.4): payroll/tax/HR records, in-app payments,
  built-in video calling, automatic translation of user content, automatic
  government-registry verification. Treat requests for these as scope changes.

## Architectural decisions

### 2026-08-07 (M7) - An interaction is derived from data, never from the id in the URL
`CandidateViewService.read` used to take the application id the route was called with and
treat it as the interaction BR-09 needs. Wiring §7.3's "View profile" onto the same method
exposed what that meant: a withdrawn application is still addressable, so requesting the
view *through the application the candidate withdrew* would have re-granted the exposure
the withdrawal took back.
*The fix is one line and the shape is the lesson:* the interaction comes from
`applicationWith(employer, candidate)` - the query that already knows withdrawn ones do not
count - and the path is derived from what that returns, not the other way round. A URL is a
request, not a fact.
*What caught it:* M6's own "a withdrawal revokes the exposure" integration test, which
asserted the *side effect* rather than the exception. That is the second time in this
project a test written that way has caught a real regression.

### 2026-08-07 (M7) - The strongest way to keep a phone number off a card is not to select it
§11.1 forbids contact details on a candidate search card, and ARCHITECTURE.md §8 asked for
the card to be built from `expose()`'s output. What shipped is stricter: the card query
never joins `users` at all, `CandidateCard` has no field for a phone number, and a unit
test asserts over the *compiled SQL* that neither `users` nor `phone` appears.
*Why that beats calling the rule:* a serializer that fetches a phone number and then nulls
it is one careless edit from leaking it, and the rule would return "no" every time anyway -
a card is not a hiring interaction, whatever else exists between those two people. A
constant answer is not a decision worth making at runtime.
*Where BR-09 still decides:* the profile view, which goes through M6's single gatherer and
can legitimately return a phone number when an application or an accepted invitation
exists.

### 2026-08-07 (M7) - The score's weights and the client's explanation come from one function
§7.3's match score is a weighted average of `matched / asked` over the groups the filters
actually asked about. `scoreGroups(filters)` is the only source of the weights, of what
each group was asked for, and of which groups take part; the SQL expression is built by
iterating that list and the response's breakdown reports the same objects.
*Why one function rather than a scoring expression plus a breakdown query:* the two would
drift, and the failure is invisible - a ranking that no longer matches the explanation
shown beside it. "Why did this candidate rank here" is the first question an employer asks.
*A property worth keeping:* a search with no filters scores everyone 100 rather than
dividing by zero. Nothing was asked, so everyone matched what was asked.

### 2026-08-07 (M7) - The profile photo is a deliberate hole in BR-09's file gate
§7.3 puts a photo on the candidate card; §5.4 keeps candidate files behind an authorized
hiring interaction. Both are satisfied by treating the *purpose* as the distinction: a file
whose purpose is `photo` is served to a verified employer for a searchable profile, and
every other file still needs an application or an accepted invitation.
*Why not treat the photo as a document:* §7.3 would be unimplementable, and the client's
own specification asks for the card to show one. *Why not widen the gate instead:* BR-09
would mean nothing. The seam is one route with one purpose check, which is the smallest
shape this can have. It wants client sign-off, like the other decisions this project
answers as data.

### 2026-08-07 (M7, later the same day) - Two of the three gaps closed, on client direction
The entry below recorded three §7.1/§7.3 items that could not be built as worded. The
client answered two of them within the hour, and both answers were the id-shaped one.
*Specialization is now a dictionary.* 60 items in eight groups (`specializations.data.ts`,
tagged `default`), and the field is `dictionary_multi` on **both** the candidate profile
and the vacancy - they have to move together, because the schema contract test pins a
shared field code to one meaning, and UAT-06's prefill copies it straight across. Both
schema versions bumped to 2, so clients refetch. Existing free-text values were **deleted,
not mapped**: "Информатика" could be `computer_science` or `information_systems`, and
choosing for somebody would put a claim in their profile they did not make.
*Proximity is tiered:* same district 2, same region 1, elsewhere 0. The trap, found by the
first test written for it: measuring against the *district filter* collapses the tiers,
because filtering by district has already excluded everyone who is not in it. The
reference point therefore has its own field, `proximityDistrictId` - a wide filter plus a
point to sort around is the only shape in which a proximity sort means anything.
*The third gap stands:* remote-work readiness was never missing, only differently shaped -
it is a `work_format` id, and saying so in the commit as though it were a gap was
imprecise.

### 2026-08-07 (M7) - Two §7.1 filters could not be built as worded, and were not faked
"Specialization" and "remote-work readiness" are listed as filters in §7.1. Neither shipped
in that form: a free-text specialization filter is a substring match on prose, which cannot
behave identically in four interface variants (§3.3, BR-13), and remote work is a
`work_format` dictionary item rather than a boolean.
*The same reasoning killed a sort option:* §7.3 offers "location proximity where permission
exists", and this data model has region and district **ids**, not coordinates. A distance
invented from the region tree would be a made-up number in a control an employer would read
as real.
*Why this is recorded rather than quietly omitted:* each is a client conversation, not a
bug - a dictionary for specializations would make it work, and so would storing
coordinates. The gap is in the specification's assumptions, not in the build.

### 2026-08-05 (M6) - BR-09 was worth waiting for, and the wait is the lesson
The contact-exposure rule was on M3's checklist and deliberately not built there. It
landed in M6, unchanged in shape from what M3 would have written, because that is when its
inputs existed: a verified employer (M4) and a hiring interaction (M6).
*Why deferring was right rather than lazy:* built in M3 it would have had **no caller**
and could only have been tested against invented inputs - "does this function return false
when I pass it false". Meanwhile the actual behaviour in M3 was *stricter* than BR-09
requires (a CV was owner-only), so the gap exposed nothing. A missing capability is not a
missing check, and telling the two apart is what made it safe to wait.
*What the finished rule looks like:* one pure function taking (viewer, visibility,
interaction) and returning two booleans **and a reason code**. The reason is not
decoration - §11.1 requires logging access to protected data, and a log that cannot
distinguish "was entitled" from "asked and was refused" answers no audit question. Two
denials with different causes are not the same denial.
*The property M7 must not break:* a search card is not an interaction. §11.1 forbids a
phone number on one, so candidate-search cards have to be built from `expose()`'s output
rather than from the profile row.

### 2026-08-05 (M6) - The employer's file access is its own route, not a flag on the owner's
`GET /files/:id/content` stays owner-only. An employer downloads a CV through
`GET /applications/:id/files/:fileId/content`.
*Why not teach the existing route about BR-09:* the entitlement comes from the
application, so the route that serves it has to be the one that can see the application.
Adding an "or an authorized employer" branch to the owner route would put a privacy rule
in `infra/files`, which has no business knowing what a hiring interaction is - and
`FilesService.readAsAuthorized` exists precisely so the check happens above it.
*Why BR-09 is re-evaluated on every download rather than trusted from the listing:* a
client may hold a `downloadPath` from a moment when the interaction still existed. A
candidate who withdraws stops the download working, which is the point of the rule.
*Why `readAsAuthorized` is a separate method and not a boolean parameter:* a flag named
`authorized` is how "authorized" ends up defaulting to true at some future call site.

### 2026-08-05 (M6) - Idempotency claims the key before doing the work
`IdempotencyService.run` inserts the key row **first**, then performs the operation, then
records the resource id.
*Why that order and not check-then-insert:* two concurrent retries would both pass a
check. Claiming first means the second conflicts on the primary key, waits, and finds the
first one's result - which is the whole window the mechanism exists to close.
*Why the resource id and not the response body:* a cached body goes stale the moment the
resource changes. Re-reading the resource keeps one source of truth for what a client gets
back on a replay.
*Why it is not redundant with BR-07's unique index:* the index prevents the duplicate but
answers a retry with a conflict, which a client cannot distinguish from "somebody else got
there first". The key makes an interrupted-but-committed request replay as the success it
was. Both are needed, and §12.4 asks for both.

### 2026-08-05 (M6) - A saved list is not discovery
Saved vacancies are deliberately **not** filtered by the visibility predicate that BR-11
imposes on the feed.
*Why:* BR-11 removes a closed vacancy from *active discovery*. A candidate who saved
something needs to see that it closed - a saved item that silently vanished reads as a bug
and loses the information the candidate wanted. Everything else in the discovery module
starts from one shared `visible` fragment precisely so this exception is the only one, and
is visible as such.

### 2026-08-05 (M5) - BR-12 overrides the missing-moderator flag, and that is the point
A vacancy carrying an age or gender restriction goes to `under_moderation` **regardless
of `MODERATION_ENABLED`**, so with no admin module it cannot be published at all.
*Why that is correct rather than a gap:* BR-12 makes "administrator review" part of the
rule. The flag exists so *ordinary* vacancies are not stranded behind a moderator who
does not exist yet; letting it also wave through a restriction nobody checked would use
a convenience to defeat the one rule in the specification specifically about
discrimination. Refusing to publish is the safe failure, and the employer sees
`under_moderation` rather than silence.
*The same reasoning covers a live vacancy whose restriction changes:* it has not been
reviewed as it now reads, so it leaves discovery until it is. That is why `active →
under_moderation` is a legal transition.
*Generalisable:* when a feature flag exists to work around a missing dependency, decide
explicitly which rules it is allowed to bypass. A flag that bypasses everything reachable
from its code path is a flag that will eventually bypass something that mattered.

### 2026-08-05 (M5) - BR-12's reasons: the labels are content, the rule is code
The permitted justifications live in two places on purpose. The four labels are a
`restriction_justification` dictionary (BR-13, like every selectable value). The *rule* -
which reason can support which restriction, and the argument for each - is
`age-gender-justifications.ts`.
*Why not put `applies` in the dictionary row's `item_group`:* dictionary content is
admin-editable by design (§10.3). If the rule lived there, an administrator could widen
BR-12 by editing a label row - turning "minimum age" into something that justifies a
gender restriction. The rule belongs where changing it is a code review.
*Why enumerate at all rather than take free text:* BR-12 requires moderation to
**validate** the reason. Prose cannot be validated, and a text box collects "young
dynamic team" and leaves a moderator arguing case by case.
*What the tests hold:* that the two code lists match exactly, that a reason must cover
every restriction kind present, and that no preference-shaped code ("client_preference",
"team_culture") is on the list. That last test looks paranoid and is not - it is the
exact failure mode BR-12 exists to prevent, and the list is the only thing preventing it.

### 2026-08-05 (M4) - An unanswered policy question can be a declaration instead of a blocker
§6.1 asks for "identity verification data **if required by policy**" and no policy
exists, which had M4 marked as blocked. It is now answered as *data*:
`employer-requirements.ts` declares, per employer type, which profile fields BR-03
requires and which documents a submission must carry - each with a `spec | default`
provenance tag and a note arguing the value.
*Why this is not a guess dressed up as a decision:* the provenance tag is the same
device the dictionary seed uses, and it records **who may change the value**. A
`default` is ours until the client approves it; changing one is one edit to one file,
with no migration, endpoint or client release. The `file_purpose` rows are seeded
either way, so the upload slots already render.
*The defaults, and why they are asymmetric:* a company must upload a registration
certificate - verifying nothing makes the verified badge meaningless. An individual
must **not**. That is deliberate: an individual hiring two seasonal workers is the case
this product exists to serve, demanding an identity document up front is the surest way
to lose them, and storing scans of identity documents is a data-protection liability to
accept only when a policy says to. A test pins both, so flipping either is deliberate.
*Generalisable, and worth doing next:* BR-12's permitted age/gender justifications are
the same shape of question and currently block M5's moderation. They can be declared
the same way.

### 2026-08-05 (M4) - The missing-reviewer flag, a second time
`EMPLOYER_VERIFICATION_ENABLED` defaults to **off**, exactly as PLAN.md specifies
`MODERATION_ENABLED` for M5. Submitting therefore transitions straight to `verified`.
*Why a flag rather than skipping verification:* BR-03 blocks vacancy submission and
invitations on a verified employer, so with no admin module (M10) every employer would
park in `under_review` forever and the entire employer half of the product would be
unreachable. The statuses, transitions, evidence rules and BR-03 all stay implemented;
only the queue is absent.
*Why the automatic approval still writes its BR-08 row:* an audit trail that silently
omits the approvals nobody made is worse than one that records them honestly. The row
carries a **null actor** and an `auto_verified_no_reviewer` reason, and every use logs
a warning. Both paths are tested, so turning the flag on is not a leap of faith.
*The pattern to reuse:* when a milestone's approver does not exist yet, flag the
transition rather than the feature, and make the audit row admit what happened.

### 2026-08-05 (M4) - Evidence is RESTRICT, so a purge has an ordering requirement
`verification_submission_files.file_id` is `ON DELETE RESTRICT` on purpose: evidence
must not vanish from under a submission an administrator is reading.
*The consequence, found by a test cleanup that failed:* deleting a user's
`stored_files` while a submission still references them **fails**. A BR-14 purge must
delete the employer row first (which cascades its submissions and their file links),
then the files, then the user. Nothing does this today - `purge_after` is still
nullable pending the retention decision - but the purge implementation has to know it,
and the failure would otherwise appear as a mysterious foreign-key error in production
rather than in a test.

### 2026-08-05 - The API is a container, and the tunnel addresses it by service name
`Dockerfile` + `docker-compose.api.yml`; the tunnel origin changed from
`host.docker.internal:3001` to `http://api:3001`. Three compose files in one directory
share a Compose project and therefore one network, which is what makes both service
names resolve with no network block anywhere.
*Why not keep `host.docker.internal`, which does work here:* the container publishes
its port to **loopback only**, and Docker Desktop's port proxy happens to make that
reachable from `host.docker.internal` while a Linux host does not. The API would be
unreachable on a real server with no clue as to why. Addressing the service directly
also means nothing has to be published at all for the tunnel to work - the loopback
mapping survives purely so a developer can curl the origin.
*Why `NODE_ENV` is not baked into the image:* Joi refuses `OTP_STATIC_CODE` in
production, and the fixed code is intentional until an SMS provider exists, so a
`production` image would refuse to boot against the current `.env`. That forced a real
improvement: log format is now `LOG_PRETTY`, not `NODE_ENV`. Without it the container
crashed at boot requiring `pino-pretty`, a devDependency the production image does not
carry - "development mode" and "pretty logs" were never the same concern.
*Why migrations do not run at boot:* two replicas would race, and a rollback would
become a database event. `pnpm migrate:latest` from the host, before `pnpm api:up`.
*Why pnpm needed `--node-linker=hoisted` for the production install:* pnpm's default
layout is symlinks into a content-addressed store, which do not survive a
`COPY --from` into a stage that has no store. A hoisted tree is a plain directory.
*An unplanned benefit worth keeping:* the container runs **UTC** while the platform
zone is `Asia/Tashkent`, so it permanently exercises the case the date handling exists
for. A birth date round-tripped unchanged and timestamps carried `+05:00` on the first
try - which is the entry below, verified against a differently-zoned server rather
than argued about.

### 2026-08-05 (M3) - `date` columns come back as strings, or a birth date shifts a day
`kysely:generate` runs with `--date-parser string` and `infra/db/pg-types.ts` registers
the matching runtime parser for OID 1082. The two are a **pair**: changing one alone
makes the generated types lie about what the driver returns.
*The trap:* node-postgres parses a `date` into `new Date(y, m-1, d)` - **local**
midnight on the server. That is a value with a time and a zone standing in for one
that has neither, and every later formatting choice can move the day: UTC getters, or
`formatWithOffset` for `Asia/Tashkent`, shift a birth date or an availability date by
one whenever the server's zone and the platform zone disagree. It looks correct on a
machine configured for Tashkent and wrong in production.
*Why a string is not a workaround:* `'2026-08-12'` is what Postgres stores, what the
driver now returns, and what API_CONTRACTS.md §4.2 puts on the wire for `kind: "date"`.
No conversion exists to get wrong. Date comparisons are then lexicographic, which is
exactly right for ISO dates.
*Related:* `formatDateOnly(date, zone)` exists for "today" in the platform zone -
`toISOString().slice(0,10)` is the previous day for five hours out of every
twenty-four, which would make a `notAfter: 'today'` rule reject a legitimate value
every night. The validator takes `today` as an **injected** value, so the rule is
testable at all.

### 2026-08-05 (M3) - The field schema is one declaration serving three jobs
`modules/schemas/candidate-profile.schema.ts` is simultaneously the client's form
(API_CONTRACTS.md §4), the server's write-routing and validation table, and the
completeness definition. Each field carries its four labels, its requiredness per
category, and where its value is stored.
*Why not three separate lists:* §4.1 promises that every code in
`requiredForSearchable` resolves to a field the client can render, so a completeness
prompt can always focus something. With one declaration that is true by
construction. With three it is true until someone edits one of them - and the
failure is a client stuck on "something is missing" with nothing to tap.
*Consequence to keep:* `storage` is part of the field declaration and is stripped
from the response. Adding a field is one edit in one place; a mapping table next door
would be the second place to forget.
*For M5:* the vacancy schema should reuse this shape and the same validator. The
validator is provided by `CandidatesModule` today because it has one caller; it moves
to a shared module when the second arrives, not before.

### 2026-08-05 (M3) - Completeness is two answers, and `is_complete` is not a threshold
`completeness_percent` is measured over **every** entry the category's form has -
engine fields plus experience and education as one entry each. `is_complete` is about
the **required** entries only.
*Why they must stay separate:* a percentage over only the mandatory fields moves in
20-point jumps and tells an employer nothing, while a threshold on the percentage
("80% is complete") would let a profile with no occupation into search and break
BR-02. Two different questions, computed in one pass, never derived from each other.
*The contract forces one detail:* a bespoke section has no fields, so
`requiredForSearchable` can never name experience or education. BR-02 therefore never
blocks on having entered a job - completeness still counts them, so an empty history
is a lower percentage rather than a locked profile. That is the contract's shape, not
an oversight.

### 2026-08-05 (M3) - Gender is a dictionary row, because the field union has no enum
§5.1 asks for gender and §7.1/BR-12 let a moderated vacancy restrict on it. It is
stored as `gender_id` referencing `dictionary_items`, and `gender` is seeded as a 15th
dictionary type.
*Why not a native enum, which was the first implementation:* §4.2's `kind` union
deliberately has no `enum` member (§3.1 - everything selectable is a dictionary), so
an enum column would have had no way to reach the client except a bespoke field kind
or a hand-maintained id mapping. It also has to be the **same id** a BR-12 vacancy
restriction references, or the moderation review compares two vocabularies.
*Why adding a "frozen" type is safe:* a field names its own `dictionaryType` and the
client fetches whatever is named, so a new type changes nothing existing. The frozen
list documents what exists; it is not a limit on additions.
*The same reasoning kept visibility out of the field engine* - but there the answer
was its own route, not a dictionary, because it also must not touch
`last_meaningful_update_at`.

### 2026-08-05 (M3) - Validate before opening the transaction, again
`CandidatesService.patch` resolves the category, validates every field and collects
every violation **before** `db.transaction()`. `applyFields` cannot throw.
*Why this is written down a second time:* it is the same trap as the two M1 security
bugs below, approached from the other side. There the throw was after the write; here
the discipline is that by the time a transaction opens there is nothing left that can
throw. The history service does the mirror thing - it returns the outcome from the
transaction and throws the 404 after the commit, so the derived-state refresh is not
rolled back by the exception that reports a missing row.
*Also relevant:* the whole request fails as a unit. One bad field in a body of five
writes none of them, which a test asserts - a client that got a 422 must not have to
guess which half landed.

### 2026-08-05 (M3) - `candidate_attributes` is the generic field store, not just category fields
One key/value table keyed by the **schema field's code** holds every §5.2 category
field *and* the core multi-selects (employment type, work format, shift, industry).
One row per scalar, one row per selected id.
*Why the core multi-selects went there too:* they need no column of their own, and one
indexed table answers "has this tool" and "accepts this employment type" with the same
join in M7. Four more child tables would have been four more migrations for no new
capability.
*What keeps it honest:* a CHECK requires exactly one of the six value columns per row,
so a field whose kind changed cannot leave two values behind for readers to choose
between; and two partial unique indexes (scalar rows have a null `item_id`, multi rows
do not) express "one row per scalar field, one per selected id" - which a primary key
cannot, because `item_id` is nullable.

### 2026-08-05 (later the same day) - Login reverts to phone + OTP; Telegram is deprecated
Client direction, superseding the two Telegram entries below after one day: the app logs
in with §4.1's phone + OTP, which is what the specification and UAT-01 said all along.
`OTP_LOGIN_ENABLED` now defaults to **true**; `POST /auth/telegram` is marked
`deprecated` in Swagger but still works.
*Why the reversal was cheap:* the OTP flow had been switched off behind a flag rather
than deleted, so its schema, service and 12 integration tests were still compiling and
running the whole time. Turning it back on was one environment variable. **This is the
payoff for that decision, and the reason to keep making it** - had the flow been
commented out or reverted, one day of Telegram would have cost a rebuild.
*Why neither path was deleted even now:* both converge on the same `AuthService` session
issuance and an account can hold both credentials, so a Telegram login carrying a
verified phone links to the account OTP created. Account linking is what makes the
switch survivable **in either direction**.
*The Telegram reasoning below is not obsolete* - it records why that particular one of
four Telegram flows was chosen, which is not recoverable from code that nobody calls.

### 2026-08-05 - A fixed OTP code belongs at code generation, not in `verify`
No SMS provider is bought (Eskiz.uz is the intended one), so `OTP_STATIC_CODE=666666`
substitutes for the random code - **at the single line where `generateOtpCode` would be
called**, inside the same transaction, and nowhere else.
*Why not a magic value accepted in `verify`:* that is a second code path. Everything
exercised during development would be the shortcut, and the day the provider arrives the
branch nobody has run becomes the live one. At generation, the hash, the row, the TTL,
supersession, the attempt counter, the `FOR UPDATE` lock and single-use consumption are
all the production path - clearing one environment variable is the entire removal.
*Why Joi refuses it in production rather than a runbook note:* it is a master key to
every account on the instance. `NODE_ENV=production` plus a non-empty value fails at
boot. A length disagreeing with `OTP_LENGTH` also fails at boot, because the alternative
is a client rendering six input boxes for a code that does not fit them - silent and
baffling. And every startup logs a warning while it is set.
*The exposure this creates is real, not theoretical:* `hh.qitmir.uz` is public, so two
unauthenticated calls with any phone number currently get a session. Intended for now -
the mobile devs need a working login - but it is a property of the deployment, recorded
in docs/DEPLOYMENT.md §3a, and the reason to be deliberate about who knows the hostname.
*What is still owed:* delivery. `OtpService.send` issues and stores a code and tells
nobody. The send must happen **after** the transaction commits - an HTTP call inside it
holds a row lock for the provider's latency, and a timeout would roll back a code that
was already sent. See docs/SMS_PROVIDER.md, including the constraint that Eskiz approves
message templates and a fresh account accepts only three fixed test strings, so the OTP
text needs approval before it can be sent at all.

### 2026-08-05 - Behind Cloudflare, the client IP is `CF-Connecting-IP`, not `X-Forwarded-For`
Published at hh.qitmir.uz through a named Cloudflare tunnel. Per-IP rate limiting reads
the header named by `CLIENT_IP_HEADER` via one helper, never `req.ip` directly.
*Why XFF is actively wrong here:* Cloudflare puts the user's address **first** and its
own second, while Express's `trust proxy` hop count reads from the **right**. So
`TRUSTED_PROXY_HOPS=1` makes `req.ip` the Cloudflare edge - every user on earth in one
bucket. Cloudflare also *appends* to a client-supplied XFF rather than replacing it, and
cloudflared has a standing bug that corrupts the result, so the header is partly
attacker-controlled. `CF-Connecting-IP` is set and overwritten by Cloudflare.
*Why it must be named explicitly and never inferred:* with nothing in front, any caller
can send `CF-Connecting-IP` and mint a fresh budget per request. Trusting a header is a
deployment fact, not something code can detect.
*Fail-safe direction:* a missing header falls back to the socket address - too strict
(one shared bucket) rather than absent (no limit at all).
*The two remain separate settings:* `TRUSTED_PROXY_HOPS` still exists for Express's
`req.protocol`/`req.secure`, and boot warns when it is set without `CLIENT_IP_HEADER`,
because that combination silently breaks per-IP limits.


### 2026-08-05 - Login is Telegram OIDC; the audience check is what makes it safe
**Superseded the same day** by the reversal to phone + OTP, above. The endpoint still
exists and still works, so the reasoning below still governs it.

Client direction: the MVP logs in with Telegram, not §4.1's phone + OTP. The app runs
Telegram's official native SDK (OAuth2 + PKCE, app-to-app) and posts the resulting
`id_token`; we verify signature, issuer, **audience = our bot id**, and `iat` age.
*Why accepting a client-supplied id_token is sound:* the audience check. A genuine,
correctly signed Telegram token minted for any other application fails it, so the
only tokens that pass are ones produced by an authorization for our bot. Same
reasoning as Google/Apple sign-in on mobile. Remove that check and the endpoint
accepts every Telegram login on earth.
*Why `iat` age and not just `exp`:* a captured token would otherwise be replayable
for its full hour. OIDC's `nonce` is the better answer but needs the client SDK to
accept a server-issued nonce, which the Flutter package does not expose - the claim
is verified when present, ready for the day it does.
*Why not the legacy Login Widget, Mini App initData, or a bot deep link:* browser-only,
Telegram-client-only, and needs an inbound webhook plus a second round trip for the
phone, respectively. The deciding factor was the `phone` scope - see below.

### 2026-08-05 - Telegram does not send `phone_number_verified`; the docs say it does
Its live `openid-configuration` advertises `claims_supported` as `aud
preferred_username phone_number exp iat iss name picture sub`. The prose documentation
mentions `phone_number_verified`, `id`, `given_name` and `family_name`; none of them is
in that list.
*Why it mattered:* the verifier required `phone_number_verified === true`, which would
have refused **every** real login with `auth.telegram_phone_required`. Caught by
fetching the discovery document while checking the client's configuration, not by any
test - the tests asserted the shape the docs described.
*The rule now:* a `phone_number` counts as verified unless the claim is explicitly
`false`. Sound rather than a workaround: a Telegram account *is* a confirmed phone
number, so the only way Telegram can name a user's phone is that the user proved
control of it to Telegram.
*Generalisable lesson:* for any OIDC provider, trust `/.well-known/
openid-configuration` over the prose, and fetch it before writing the verifier.

### 2026-08-05 - The `phone` scope is what keeps the identity model intact
§4.1 makes the platform's identity a phone number and BR-09 is about revealing it to
employers. Telegram's `phone` scope returns `phone_number_verified`, so the model
survives the switch: `telegram_user_id` becomes the credential, `phone` becomes
nullable but is still unique, and a CHECK requires at least one of the two.
*`TELEGRAM_REQUIRE_PHONE` defaults to on:* an account with no phone silently cannot
take part in hiring, and saying so at login beats letting the user find out after
building a profile.
*Only a verified phone is ever matched on.* Linking on an unverified value would let
anyone claim an existing account by naming its number. And an account already claimed
by a different Telegram user is never taken over - mobile numbers get recycled, so
that case is real, not theoretical. It also has to be handled explicitly because
`phone` is unique: writing it blindly on the new account turns a recycled number into
a 500 on somebody's first login.

### 2026-08-05 - Disabling a flow means a flag and a 404, not commented-out code
**The flag is back on** (see the reversal at the top), which is precisely what this
entry predicted would be cheap. The mechanism and its reasoning stand unchanged, and
`OtpEnabledGuard` still answers 404 when the flag is off.

Phone + OTP is switched off with `OTP_LOGIN_ENABLED=false`, its routes moved to their
own controller behind a guard that answers **404**.
*Why 404 and not 403:* a disabled endpoint should be indistinguishable from one that
was never built. A 403 advertises that it exists and is merely off, which invites
probing - and a reachable OTP endpoint is a second, unwatched way into every account.
*Why not comment it out or delete it:* §4.1 still specifies phone + OTP, so this is a
deferral. Keeping the controller registered means the code, the schema and its 12
integration tests all still compile and run, so it cannot rot silently while off.
Turning it back on is one environment variable, not a revert.

### 2026-08-04 - Files live in Telegram, and are always proxied, never redirected
Client direction: the file store is a Telegram bot posting to one fixed chat.
*The consequence that shapes the code:* Telegram's download URL is
`api.telegram.org/file/bot<token>/<path>` - unauthenticated, and it contains the
bot token. It can never be given to a client, not even briefly, so
`GET /files/:id/content` streams the bytes after an ownership check. This is a
**stronger** reading of §11.1 than the signed URLs originally planned: there is no
URL to leak in the first place.
*The limit is 20 MB, not 50.* A bot may send 50 MB but `getFile` refuses to
download above 20 MB, so the upload cap is validated against the download ceiling
at boot - above it a file stores fine and is permanently unreadable.
*`file_id` is per-bot,* so `TELEGRAM_BOT_TOKEN` is part of the data layer:
replacing it orphans every stored file rather than merely re-authenticating. Never
"rotate it like a secret".
*Two properties of the choice, not of the code:* uploaded documents live in a
Telegram chat, so that chat's membership is part of the privacy surface; and file
retention is bounded by that chat's existence rather than by our database.

### 2026-08-04 - Only the exception filter knows the request language
User-facing strings live in exactly one catalog; exceptions carry a **key plus
parameters**, and `ApiExceptionFilter` renders them once it has resolved `x-lang`.
*Why not render at the throw site:* a service deep in the stack has no business
knowing the request locale, and threading one through every method signature is
worse than the English-only strings this replaced. `ValidationPipe`'s
`exceptionFactory` settles it - it never sees the request, so localized validation
messages (which §3.2 names explicitly) are only possible in a filter.
*Side benefit worth keeping:* the catalog key doubles as a stable machine-readable
`code` in the error body, so a client branches on the cause instead of matching
translated prose - and an unexpected error is now logged with its stack and
answered generically, rather than returning Nest's default body.

### 2026-08-04 - Dictionary content states its own provenance
Every seeded type is tagged `spec`, `default` or `awaiting`, in the data file next
to the values.
*Why:* the distinction decides **who may change a value**. A `spec` list is a
specification change; a `default` is a conventional list we compiled so the
dependent milestones could be built, and the client still has to approve it. Losing
that distinction means nobody can tell which lists are load-bearing agreements and
which are placeholders that shipped.
*Cyrillic-in-a-Latin-slot is caught by a test.* The large content files use
positional label helpers - `place(code, uzLatn, uzCyrl, ru, en)` - because 175
districts have to stay reviewable, which makes a swapped column easy to write. A
script assertion over the whole seed catches it.

### 2026-08-04 - A side effect and the throw that reports it cannot share a transaction
Two M1 security bugs had one shape: code wrote a row inside
`db.transaction().execute()` and then threw to report the failure. Kysely rolls
back on a rejected callback, so **the write was undone and only the exception
survived**.

- `OtpService.verify` incremented `attempts` then threw → every wrong guess reset
  the counter, so §4.2's lockout could never fire and a six-digit code was
  brute-forceable for its whole TTL.
- `SessionService.rotate` revoked the session family on reuse then threw → the
  revocation vanished; reuse detection logged a warning, refused one request, and
  left every stolen session live.

Both now **return an outcome from the transaction and throw after the commit**.
*Why this is worth remembering:* both looked correct in review, and both had
tests that passed - the tests asserted the exception, which was never the part
that was broken. When a transaction has a side effect on the failure path, the
test has to assert the side effect, not the error.

### 2026-08-04 - Rate limiting is a Postgres fixed window, not an in-memory counter
`rate_limit_counters` holds one row per (bucket, subject); one
`INSERT ... ON CONFLICT` both counts and decides.
*Why not in-memory:* the counter would be per instance, so N replicas grant N×
the budget - the opposite of a limit.
*Why one statement:* read-compare-write lets two concurrent requests both read
the same count and both pass, which is exactly the burst being prevented.
*Why one row per subject rather than per window:* the table stays bounded by the
number of distinct phones and IPs instead of growing forever.
*Phone subjects are hashed* under the OTP pepper, so this table does not become a
second register of every phone number that has touched the API.
*Accepted cost:* a fixed window allows up to 2× the limit across a boundary. The
buckets exist to stop abuse and SMS spend, not to shape traffic.

### 2026-08-04 - Per-IP limits depend on `trust proxy`, so it is explicit config
`TRUSTED_PROXY_HOPS` defaults to `0`.
*Why it cannot be guessed either way:* behind a proxy, every request carries the
proxy's address and one bucket is shared by all users; trusting
`X-Forwarded-For` without a proxy in front lets any caller spoof its address and
empty its own bucket at will. Too low a value only makes the limit stricter, so
the default trusts nothing.

### 2026-08-04 - Dictionary revisions and the four-locale rule are triggers
The revision counter and "no activation without all four labels" are enforced by
database triggers, not service code.
*Why revision:* a write path that forgets to bump raises **no error at all** - the
client silently never learns of the change and its cache stays wrong until
something else touches the same type. There is no failure to notice.
*Why the locale rule:* §3.2 forbids ever showing a technical key, and the rule has
to survive an admin write path (M10), a seeder, and a manual SQL fix. It is a
`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` so a caller may insert the
item and its labels in either order within one transaction.
*The required label count is derived from the `locale_code` enum*, so a fifth
interface variant tightens the rule automatically.

### 2026-08-04 - The dictionary seeder must be a no-op when nothing changed
Not merely "must not duplicate": it must not *write*, because every write bumps
the revision by trigger. A seeder that rewrote identical values would advance
every type's version on every deployment and make every client refetch every
dictionary. Hence read-and-compare before each write, and a test asserting the
second run reports zero changes.
*Why a seeder and not a migration:* dictionary content is reviewed and revised by
the client (§13.2), so a corrected label must be editable in place rather than
needing a new migration file forever.

### 2026-08-04 - Dictionary IDs are the only filterable currency
Every occupation, skill, region, language, employment type and work attribute is
a `dictionary_items` row with a stable ID and one label per locale. Profiles,
vacancies and search filters store **IDs only**.
*Why:* §3.3 and BR-13 require that selecting "Call-centre operator" in any of the
four variants returns the same candidates. Any design that stores or filters on
translated text cannot satisfy that.
*Consequence:* an item cannot be activated until all four translations exist, and
dictionary items are never hard-deleted - only deactivated, with `merged_into_id`
for skill merges so old references still resolve.

### 2026-08-04 - Canonical locale codes are BCP-47, header accepts house aliases
Internally: `uz-Latn`, `uz-Cyrl`, `ru`, `en`. The `x-lang` header also accepts
`uz` → `uz-Latn` and `oz` → `uz-Cyrl`.
*Why:* the Flutter client's `Locale` maps to the script-suffixed form directly,
and `oz` is opaque. But `d:\Dev\digital-edo-api` already uses `x-lang` with
`uz`/`oz`, so accepting those aliases costs nothing and keeps the service family
consistent.
*Note:* the existing `x-lang.decorator.ts` in digital-edo-api passes arbitrary
strings through. We cannot copy that, because the value is a translation-table
key - ours needs a strict allow-list.

### 2026-08-04 - No search engine; normalized Postgres with deliberate indexes
Candidate search runs on normalized tables with composite indexes, not
Elasticsearch.
*Why:* the dataset size does not require it, and a second index would become a
second source of truth for **privacy rules** (BR-02, BR-09). A privacy rule
drifting between two stores is a data-protection incident, not a bug.
*Escape hatch, in this order:* measure p95 → add a denormalized
`candidate_search_projection` maintained on profile write → only then consider a
search engine.

### 2026-08-04 - Skills and languages are rows, not JSON
*Why:* "match all skills" needs `GROUP BY ... HAVING COUNT(DISTINCT skill_id) =
n` and "language at least C1" needs an ordered level comparison. Neither is
usefully indexable as JSON containment. CEFR levels are stored as an **ordered**
rank so `>= C1` is a range scan.

### 2026-08-04 - Completeness is stored, not computed per query
`completeness_percent` and `is_complete` are columns recomputed on profile write.
*Why:* search filters on minimum completeness (§7.1), and recomputing across six
child tables for every candidate row would consume the entire 3-second
first-page budget.

### 2026-08-04 - `last_meaningful_update_at` is separate from `updated_at`
*Why:* §5.3 shows the last meaningful update and §7.3 allows sorting by it.
Toggling a privacy switch must not make a stale profile look freshly maintained -
that would be gameable and misleading to employers.

### 2026-08-04 - Business rules live in the database where they are races
BR-07 (one active application per vacancy) is a **partial unique index**, not a
service check. BR-06 (deadline) is verified inside the insert transaction.
BR-08's stage-history row is written in the same transaction as the status change.
*Why:* mobile clients retry on flaky connections. A service-layer uniqueness
check loses to a concurrent double-submit; the database does not.

### 2026-08-04 - Idempotency keys are separate from uniqueness constraints
Non-idempotent writes (apply, invite, message, schedule, upload) accept an
`Idempotency-Key`. Same key + same fingerprint replays the original response;
same key + different fingerprint is a `409`.
*Why:* §12.4 demands safe retry without duplicates. The unique index prevents
logical duplicates; idempotency keys make an interrupted-but-committed request
replayable and let the client tell "already done" from "genuine conflict".

### 2026-08-04 - Contact exposure is one helper, never inlined
BR-09's rule (contact details revealed per candidate privacy settings **and** an
allowed hiring interaction) is implemented in a single serializer helper taking
(viewer, candidate, interaction state).
*Why:* a privacy rule duplicated across endpoints will drift, and the failure
mode is leaking phone numbers.

### 2026-08-04 - `discovery` and `candidate-search` are separate modules
Both are "search", but they differ in authorization (candidate vs verified
employer), filter sets and ranking. Kept apart on purpose.

### 2026-08-04 - Multi-role means `active_role`, not "the user's role"
Tokens carry `roles[]` plus an `active_role` the client sets explicitly and the
server validates against granted roles. Authorization always asks "may this user,
acting as R, do this to X".

## Environment traps already paid for

Full list with symptoms in [README.md](README.md) "Gotchas worth knowing". The
ones most likely to bite again:

- **Kysely 0.29 is pure ESM.** Node 24 can `require()` it so the compiled CJS app
  runs, but Jest cannot - hence `transformIgnorePatterns`.
- **`Migrator` moved to `kysely/migration`**, not the package root.
- **Kysely's `FileMigrationProvider` is broken on Windows**: it `import()`s a bare
  `D:\...` path and Node's ESM loader rejects it. We use a custom provider that
  converts via `pathToFileURL`.
- **TypeScript is pinned to 5.9.3.** `typescript@latest` is 7.x, but
  `typescript-eslint` caps at `<6.1.0`; TS 7 silently breaks linting.
- **Postgres 18 changed the volume path** to `/var/lib/postgresql` (not `/data`);
  the old mount makes the container refuse to start.
- **pnpm needs `CI=true`** to wipe `node_modules` non-interactively, plus
  `--no-frozen-lockfile` when `package.json` changed.

## Local environment

- **The public URL is https://hh.qitmir.uz** — named Cloudflare tunnel `headhunter`,
  id `3d0cec91-0f40-4f1d-848a-76c4c952142b`, created 2026-08-05. Origin is
  `http://api:3001`, the `headhunter-api` container over the shared compose network.
  Bring it up with `pnpm db:up && pnpm api:up && pnpm tunnel:up`.
  *Trap paid for on 2026-08-05, and it survives containerisation:* the origin serves a
  **built artefact, never a watcher**, so it keeps serving old code while the source
  and `.env` have both moved on. The symptom was a correct-looking 404 from
  `/auth/otp/send` — the guard reading an `OTP_LOGIN_ENABLED` that was false when the
  build was made. `pnpm api:up` rebuilds; a bare `docker compose up -d` reuses the
  existing image and reproduces the trap exactly. Before believing any live response,
  confirm what is actually serving: `docker ps --filter name=headhunter-api`.
  *Also worth knowing:* the tunnel drops its QUIC connection when the origin goes
  away and takes a few seconds to re-register, so the first call after a restart can
  fail once through `hh.qitmir.uz` while `127.0.0.1:3001` is already fine.
- **The dev server and `pnpm test:int` share one database.** Driving live requests
  while the integration suite runs is cross-talk: one `auth.int.spec.ts` failure
  appeared during exactly that overlap and did not reproduce in four clean runs
  afterwards. Not a known-flaky test — a known-flaky *arrangement*.
- **`cert.pem` is shared across the qitmir.uz tunnels and is deliberately not in this
  repo.** A tunnel needs only its credentials JSON to *run*; the account-level cert is
  needed only to create, delete or route, and authorizes the whole zone. The existing
  one at `d:\Dev\tgbots\sahih-bot\docker\cloudflared\cert.pem` is referenced with
  `--origincert` rather than copied into a third place.
  *Trap:* `cloudflared tunnel create` ignores `--credentials-file` and writes the JSON
  **next to whichever cert it found**. Move it into this project afterwards.
- **cloudflared is installed via winget** at `C:\Program Files (x86)\cloudflared\`. It
  is not on the PATH of a shell that was already open — start a new one.
- API on **3001**, not 3000: the `sahih-bot` container permanently publishes 3000.
- Postgres on **5435**, not 5432: this machine already runs Postgres on
  5432/5433/5434 for other projects.
- Reusable pieces in the wider `d:\Dev` tree worth reviewing before building:
  `secure-file-router` (authorized file access - see the open decision),
  `digital-edo-api`'s guard and decorator layout under `src/infra/api/`.

## Open questions with the client

Tracked as `[?]` items at the top of [TODO.md](TODO.md). Still open and still
blocking: **data-retention periods** (BR-14, blocks the deletion purge and audit
retention). That is now the only one.

Answered: time-zone policy (single platform zone), push provider (deferred with
M9), file service (Telegram Bot API).

No longer blocking, though still wanting sign-off - both declared as data with stated
defaults and provenance tags, so an answer is one file edit rather than a milestone
dependency: **individual-employer verification evidence** (§6.1) and the **permitted
age/gender justifications** (BR-12). The second wants **legal** review specifically;
nothing on that list has been seen by a lawyer.

The dictionary value lists are no longer a blocker - all 16 types are seeded and
working - but four of them and the occupation set are compiled starting points
awaiting client review, and each says so in its data file. Getting that review is
now a quality task, not a dependency.
