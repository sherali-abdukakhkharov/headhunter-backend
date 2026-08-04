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
pnpm start:dev            # http://localhost:3001
```

Check it:

```sh
curl http://localhost:3001/health
# {"status":"ok","database":"up","version":"0.0.1","timestamp":"..."}
```

## Commands

```sh
pnpm start:dev            # watch mode
pnpm build                # SWC build + full type check
pnpm typecheck            # tsc --noEmit
pnpm lint                 # eslint --fix
pnpm format               # biome format --write
pnpm test                 # jest
pnpm test:cov             # coverage

pnpm db:up / db:down      # Postgres container up/down
pnpm db:logs              # follow Postgres logs

pnpm migrate:latest       # apply all pending migrations
pnpm migrate:up           # apply the next one
pnpm migrate:down         # roll back the most recent
pnpm migrate:status        # what is applied and what is pending
pnpm migrate:typecheck    # type-check migrations without running them

pnpm kysely:generate      # regenerate src/infra/db/database.types.ts from the live DB
```

## Structure

```
src/
  main.ts                        bootstrap: helmet, CORS, validation, Swagger, shutdown hooks
  app.module.ts                  config + logging + database + feature modules
  infra/
    env-schema.ts                Joi schema; a bad env var fails the boot, not a request
    db/
      database.module.ts         global Kysely provider (KYSELY token), closes the pool on shutdown
      database.types.ts          Kysely schema types (regenerate with kysely:generate)
      migrate.ts                 standalone migration runner
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

## Not built yet

Auth (JWT), domain modules (users, vacancies, applications), rate limiting,
e2e tests, Dockerfile, CI. The `/health` module is scaffolding that proves the
API ↔ Postgres wiring — replace it with real features rather than building on it.
