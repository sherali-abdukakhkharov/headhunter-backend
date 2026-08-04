See [CLAUDE.md](CLAUDE.md) for coding principles, conventions, testing approach
and the client contract, and [README.md](README.md) for stack, commands,
structure and environment gotchas.

Quick orientation:

- **Stack:** NestJS 11, TypeScript 5.9.3, Kysely 0.29, PostgreSQL 18, SWC
- **Architecture:** lean modular — Controller → Service → (Repository when earned)
- **API on port 3001, Postgres on 5435** (3000 and 5432 are taken on this machine)
- **Before committing:** `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
- **Companion app:** `d:\Dev\tgbots\headhunter-app` (Flutter)
