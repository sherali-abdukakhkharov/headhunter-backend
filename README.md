# headhunter-backend

NestJS API for the Headhunter job search and recruitment platform.

Companion app: `headhunter-app` — `d:\Dev\tgbots\headhunter-app`.

## Stack

| Concern | Choice |
|---|---|
| Framework | NestJS 11 |
| Language | TypeScript 5.9.3 (pinned — see Gotchas) |
| Compiler | SWC (`nest build` with `builder: swc`) |
| Database | PostgreSQL 18 via Kysely 0.29 (query builder, not an ORM) |
| Migrations | Kysely migrator, run with `tsx` |
| Validation | Joi for env, class-validator for DTOs |
| Logging | pino via nestjs-pino |
| Docs | Swagger at `/docs`, Scalar at `/reference` |
| Formatting | Biome (formatter only) |
| Linting | ESLint 10 flat config + typescript-eslint (type-aware) |
| Tests | Jest + `@swc/jest` |
| Package manager | pnpm 10.30.3 |

Formatting and linting are deliberately split: **Biome formats, ESLint lints.**
Biome's linter is off (`biome.json`) and `eslint-config-prettier` is last in the
ESLint config, so the two never fight.

## Local ports

Neither is the default, and the reason matters:

| Service | Port | Why |
|---|---|---|
| API | **3001** | The `sahih-bot` container permanently publishes host port 3000 |
| Postgres | **5435** | This machine already runs Postgres on 5432/5433/5434 |

## Getting started

```sh
cp .env.example .env      # already done for local dev
pnpm install
pnpm db:up                # Postgres 18 in Docker
pnpm migrate:latest       # apply migrations
pnpm seed                 # dictionary content - the app needs it, see below
pnpm start:dev            # http://localhost:3001
```

Check it:

```sh
curl http://localhost:3001/health
# {"status":"ok","database":"up","version":"0.0.1","timestamp":"2026-08-04T15:00:00+05:00"}

curl -H 'x-lang: ru' http://localhost:3001/dictionaries/region
```

## Commands

```sh
pnpm start:dev            # watch mode
pnpm build                # SWC build + full type check
pnpm typecheck            # tsc --noEmit
pnpm lint                 # eslint --fix
pnpm format               # biome format --write
pnpm test                 # jest, database-free (DummyDriver)
pnpm test:int             # *.int.spec.ts against the dev Postgres - needs db:up
pnpm test:cov             # coverage

pnpm db:up / db:down      # Postgres container up/down
pnpm db:logs              # follow Postgres logs

pnpm migrate:latest       # apply all pending migrations
pnpm migrate:up           # apply the next one
pnpm migrate:down         # roll back the most recent
pnpm migrate:status        # what is applied and what is pending
pnpm migrate:typecheck    # type-check migrations without running them

pnpm kysely:generate      # regenerate src/infra/db/database.types.ts from the live DB

pnpm seed                 # apply the dictionary seed; idempotent, see below
```

## Public URL

Published at **https://hh.qitmir.uz** through a named Cloudflare tunnel — the same
arrangement as the other bots on this machine. Nothing is exposed inbound. Setup,
the production environment and the failure table are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

One setting decides whether rate limiting works at all there:
`CLIENT_IP_HEADER=cf-connecting-ip`. Without it every caller arrives as `127.0.0.1`
and shares one bucket; with `X-Forwarded-For` instead, the value is the Cloudflare
edge and is partly attacker-controlled. Boot warns if the combination is wrong.

```sh
pnpm tunnel:up / tunnel:logs / tunnel:down
```

## Login

**Telegram, for the MVP.** The app runs Telegram's official native SDK (OAuth2 +
PKCE, app-to-app) and posts the resulting OpenID Connect `id_token` to
`POST /auth/telegram`; we verify it and issue our own session. Setup for the parts
outside this repo — BotFather, Flutter, platform manifests — is in
[docs/TELEGRAM_LOGIN_SETUP.md](docs/TELEGRAM_LOGIN_SETUP.md).

The check that matters is **audience = our bot id**. A genuine, correctly signed
Telegram token issued for any other application must not sign anyone in here, and
that check is the only thing preventing it. Signature, issuer and `iat` age are
verified too — the age window is the replay defence, so the app must post a token
promptly and never cache one.

§4.1's **phone + OTP is built and tested but switched off** (`OTP_LOGIN_ENABLED=false`,
routes answer 404). It was not deleted: the spec still specifies it, and one
environment variable brings it back. A Telegram login carrying a Telegram-verified
phone links to the account the OTP flow created rather than duplicating it.

## File storage

Bytes live in **Telegram**, not in object storage. A bot posts each upload to one
fixed chat with `sendDocument`; `stored_files` keeps the metadata; retrieval is
`getFile` plus a download. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STORAGE_CHAT_ID`
— boot logs whether the credentials work rather than failing, so a Telegram outage
does not stop the rest of the API from serving.

Three things to know before touching this code:

- **Never hand a Telegram file URL to a client.** It is
  `api.telegram.org/file/bot<token>/<path>` — unauthenticated, and it leaks the bot
  token. Downloads are proxied through `GET /files/:id/content` after an ownership
  check. That is also the §11.1 requirement: no permanently public links.
- **20 MB is the hard ceiling**, because that is `getFile`'s *download* limit. A bot
  can send 50 MB, so it is possible to store a file that can never be read back;
  boot refuses a `FILE_MAX_SIZE_BYTES` above 20 MB for exactly that reason.
- **The bot token is part of the data layer.** `file_id` values are per-bot, so
  replacing the token orphans every stored file rather than re-authenticating.

Whoever can read the storage chat can read every uploaded CV, so it should be a
private channel whose only other member is the bot.

## Seeding dictionaries

`pnpm seed` applies `src/modules/dictionaries/seed/dictionary-seed.data.ts`. It is
deliberately **not** a migration: dictionary content is reviewed and revised by
the client (§13.2), so a corrected label has to be editable in place rather than
needing a new migration file forever.

It is idempotent in the strong sense — **a second run writes nothing at all**, not
merely "creates no duplicates". Every item and translation write bumps the global
revision by trigger, so a seeder that rewrote identical values would advance every
dictionary's version on each deployment and make every client refetch everything.

To add or correct content: edit the data file, run `pnpm seed`, and only the
difference is applied. Each type is tagged with where its values come from —
`spec` (enumerated in the specification), `default` (a compiled starting set that
still needs client approval) or `awaiting`.

Currently **487 items, 1 950 labels**. The four large lists are in `seed/data/`:

| File | Contents |
|---|---|
| `locations.data.ts` | 14 regions and all 175 districts, by `parentCode` |
| `occupations.data.ts` | 162 occupations across the five §2.1 categories |
| `skills.data.ts` | 118 skills by family, and 32 industries |

The content files use **positional** label helpers — `place(code, uzLatn, uzCyrl,
ru, en)` — so a whole region stays reviewable at a glance. That makes a swapped
column easy to write, which is why `dictionaries.int.spec.ts` asserts over the whole
seed that no Latin-script slot contains Cyrillic and no Cyrillic slot lacks it,
except where a label is deliberately untransliterated (`PostgreSQL`, `1C`).

## Structure

```
src/
  main.ts                        bootstrap: helmet, CORS, validation, Swagger, shutdown hooks
  app.module.ts                  config + logging + database + feature modules
  infra/
    env-schema.ts                Joi schema; a bad env var fails the boot, not a request
    api/
      decorators/                @Public, @RequireRole, @RateLimit, @XLang, @ActiveUser
      guards/                    the global stack: rate limit → auth → role → account status
      filters/                   api-exception.filter.ts - the one error body, localized
      exceptions/                LocalizedException subclasses, carrying a catalog key
    crypto/hash.ts               HMAC hashing for OTP codes and refresh tokens
    i18n/                        the message catalog, four variants per key
    locale/locale.ts             x-lang normalization and the §3.2 fallback chain
    files/                       Telegram-backed file storage
    phone/phone.ts               E.164 normalization, log masking
    rate-limit/                  §12.5 buckets over rate_limit_counters
    time/format.ts               the one timestamp serializer (explicit offset, never Z)
    db/
      database.module.ts         global Kysely provider (KYSELY token), closes the pool on shutdown
      database.types.ts          Kysely schema types (regenerate with kysely:generate)
      migrate.ts                 standalone migration runner
      seed.ts                    standalone dictionary seed runner
      testing/int-db.ts          the pool every *.int.spec.ts connects with
  modules/<feature>/
    <feature>.controller.ts      HTTP layer, Swagger decorators
    <feature>.service.ts         business logic
    dto/                         request/response DTOs
migrations/                      timestamped Kysely migrations
```

Architecture is **lean modular**: Controller → Service → (Repository, once a
module's data access earns one). No CQRS buses or DDD entities; add them
per-module only where they actually pay for themselves.

Path aliases live in three places that must stay in sync — `tsconfig.json`,
`.swcrc`, and Jest's `moduleNameMapper`: `src/*`, `@core/*`, `@infra/*`,
`@modules/*`, `@shared/*`, `@utils/*`.

## Adding a migration

Create `migrations/<YYYYMMDDHHMMSS>_<name>.ts` exporting `up` and `down`:

```ts
import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> { /* ... */ }
export async function down(db: Kysely<any>): Promise<void> { /* ... */ }
```

`Kysely<any>` is required — each migration runs against a different schema
version, so the generated `DB` type does not apply. ESLint allows `any` under
`migrations/` for exactly this reason.

Then `pnpm migrate:latest && pnpm kysely:generate`.

## Gotchas worth knowing

Every one of these was hit while setting the project up:

- **Kysely 0.29 is pure ESM** (`"type": "module"`, no CJS build). Node 24 can
  `require()` an ESM graph so the compiled CJS app runs fine, but Jest cannot —
  hence `transformIgnorePatterns` in `package.json`, which lets `@swc/jest`
  transform it.
- **The migrator moved.** Import `Migrator` from `kysely/migration`, not the
  package root.
- **Kysely's `FileMigrationProvider` is broken on Windows** — it `import()`s a
  bare `D:\...` path, which Node's ESM loader rejects with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME` (it reads `D:` as a URL scheme). `migrate.ts`
  uses a small custom provider that converts paths with `pathToFileURL` first.
- **TypeScript is pinned to 5.9.3, not `latest`.** npm's `typescript@latest` is
  now 7.x, but `typescript-eslint` declares `typescript: >=4.8.4 <6.1.0`, so
  TS 7 silently breaks the lint stack.
- **Postgres 18 changed its volume layout.** The mount must be at
  `/var/lib/postgresql`, *not* `/var/lib/postgresql/data`; the old path makes the
  container refuse to start.
- **pnpm needs `CI=true`** to remove `node_modules` non-interactively, plus
  `--no-frozen-lockfile` alongside it when `package.json` has changed.

- **A throw inside `db.transaction().execute()` rolls back the write that
  preceded it.** This cost two security bugs in M1 (an OTP attempt counter and a
  session-family revocation, both silently undone by the exception reporting
  them). When a transaction has a side effect on its failure path, return an
  outcome and throw after the commit — and assert the side effect in the test,
  not just the error. See MEMORY.md.
- **Postgres `bigint` arrives as a JavaScript string** through node-pg. The
  dictionary revision columns are `bigint` and cast with `::int` in the SELECT so
  the wire contract stays numeric.

## Built so far

- **M0** foundations: health, migrations, env validation, logging, Swagger.
- **M1** auth: **Telegram login** (MVP), refresh rotation with reuse detection,
  sessions, multi-role with `active_role`, account status guard (BR-10), rate
  limiting. Phone + OTP is built and switched off behind `OTP_LOGIN_ENABLED`.
- **M2** dictionaries: manifest / delta / by-id reads with ETag revalidation,
  four-locale enforcement, the idempotent seeder, and the content — 487 items in
  four variants including all 175 districts.
- **Cross-cutting**: every user-facing message localized into all four variants
  (`infra/i18n`), and Telegram-backed file storage with owner-scoped
  upload / download / delete (`infra/files`, `/files`).

## Not built yet

Candidate and employer profiles, vacancies, applications, search, chat,
notifications, admin (M3 onward). Smaller gaps worth knowing: a Dockerfile and CI,
the pruning job for `rate_limit_counters`, and malware scanning on uploads (§12.5
asks for it "where infrastructure permits"; Telegram does none on a bot upload, and
the content checks in `FilesService` are type validation, not scanning). The
`/health` module remains the wiring proof.
