# headhunter-backend — working notes

NestJS API for the Headhunter platform. The Flutter client lives at
`d:\Dev\tgbots\headhunter-app`; a Claude Code session rooted there can edit this
repo too (see that repo's `.claude/settings.json`).

Read `README.md` first for stack, commands, structure and the list of
environment gotchas. This file covers how to work in the codebase.

## Coding principles, in priority order

**1. KISS.** Always pick the simplest thing that works. A complex solution means
more bugs and harder comprehension. If code needs explaining, simplify it.

**2. DRY.** The same logic should not live in two places. Abstract after the
third repetition, not before — sometimes duplication is better, because two
similar pieces of code often need to change in different directions.

**3. SOLID, applied where complexity justifies it.**
- *Single responsibility* — always: one function, one job.
- *Open/closed* — once there are 3+ types or cases, use an extension pattern.
- *Liskov* — only relevant when actually using inheritance.
- *Interface segregation* — split an interface once it reaches ~5 methods.
- *Dependency inversion* — always; NestJS DI already provides it.

**Do not add complexity** when there is only one use case today, when the reason
is "we might need it later", or when an abstraction would have exactly one
implementation.

**Stop and reconsider** when a function exceeds 20 lines, a file exceeds 200
lines, you need three layers of abstraction, or you have failed at the same
approach three times — change approach rather than pushing harder.

## Conventions

- **Env vars are validated at boot**, never read ad hoc. Add to `AppEnv` and the
  Joi schema in `src/infra/env-schema.ts`, then read via
  `ConfigService<AppEnv, true>` with `{ infer: true }`.
- **Database access goes through the `KYSELY` token**:
  `constructor(@Inject(KYSELY) private readonly db: Database) {}`. Kysely is a
  query builder — write SQL-shaped queries, do not build an ORM layer over it.
- **Every endpoint is documented.** `@ApiTags`, `@ApiOperation` and a DTO-typed
  `@ApiOkResponse`; the DTO carries `@ApiProperty` on each field. The Swagger
  document is the contract the Flutter client is written against.
- **Health checks never throw.** A failing dependency is reported as `degraded`
  with a 200, so monitoring can distinguish "up but Postgres is down" from "not
  responding".
- **`any` is an ESLint error** outside `migrations/` and `*.spec.ts`.
- Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before
  committing. `pnpm build` runs the full type check too.

## Testing

Unit tests use Nest's `Test.createTestingModule`. For anything touching the
database, build a **real** `Kysely` instance over `DummyDriver` rather than
mocking Kysely's internals — see `src/modules/health/health.service.spec.ts`.
Queries are then genuinely compiled (a malformed query still fails the test)
while nothing connects. Subclass `DummyDriver` and reject in
`acquireConnection()` to simulate an unreachable database.

Mocking `db.executeQuery` does **not** work: `sql\`...\`.execute(db)` goes
through `db.getExecutor()` → `transformQuery` → `compileQuery` → `executeQuery`,
so a naive stub silently takes the error path.

## The client contract

`GET /health` returns `HealthResponseDto`. Its Dart counterpart is
`HealthStatus` in
`headhunter-app/lib/src/features/health/domain/health_status.dart`.
**Change both together** — the Dart model is generated from hand-written field
declarations, so a rename here is a silent deserialization failure there.

## Adding a feature module

1. `src/modules/<feature>/` with controller, service, `dto/`, and `<feature>.module.ts`.
2. Register the module in `app.module.ts`.
3. Add a migration under `migrations/`, run `pnpm migrate:latest`, then
   `pnpm kysely:generate` to refresh `database.types.ts`.
4. Write the spec alongside the service.
5. Mirror any new response DTO in the Flutter app.
