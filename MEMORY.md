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

- API on **3001**, not 3000: the `sahih-bot` container permanently publishes 3000.
- Postgres on **5435**, not 5432: this machine already runs Postgres on
  5432/5433/5434 for other projects.
- Reusable pieces in the wider `d:\Dev` tree worth reviewing before building:
  `secure-file-router` (authorized file access - see the open decision),
  `digital-edo-api`'s guard and decorator layout under `src/infra/api/`.

## Open questions with the client

Tracked as `[?]` items at the top of [TODO.md](TODO.md). Summary: data-retention
periods (BR-14), individual-employer verification evidence, time-zone policy,
permitted age/gender justifications (BR-12), push provider, and the approved
dictionary value lists - the last is the largest content dependency in the
project and should be requested immediately.
