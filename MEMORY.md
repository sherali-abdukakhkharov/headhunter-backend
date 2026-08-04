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
  `host.docker.internal:3001`, so it serves whatever runs under `pnpm start:dev`.
  Bring it up with `pnpm tunnel:up`.
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
retention), **individual-employer verification evidence** (§6.1, blocks M4), and
the **permitted age/gender justifications** (BR-12, blocks M5 moderation).

Answered: time-zone policy (single platform zone), push provider (deferred with
M9), file service (Telegram Bot API).

The dictionary value lists are no longer a blocker - all 14 types are seeded and
working - but four of them and the occupation set are compiled starting points
awaiting client review, and each says so in its data file. Getting that review is
now a quality task, not a dependency.
