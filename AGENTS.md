Start with [CLAUDE.md](CLAUDE.md) — it lists which document to read for what, and
the domain rules that are easy to get wrong.

| File | Contents |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Client specification (cite as §n, BR-nn, UAT-nn) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design decisions and data model |
| [PLAN.md](PLAN.md) | Milestones in dependency order |
| [TODO.md](TODO.md) | Working checklist + open blocking decisions |
| [MEMORY.md](MEMORY.md) | Why decisions were made; traps already paid for |
| [README.md](README.md) | Stack, commands, structure, environment gotchas |

Quick orientation:

- **Product:** JobBridge — mobile-only recruitment platform, four interface
  variants (Uzbek Latin/Cyrillic, Russian, English). Renamed from *Universal
  HeadHunter* on 2026-08-19; the repository, database and container names still
  carry the old one on purpose (see MEMORY.md)
- **Stack:** NestJS 11, TypeScript 5.9.3, Kysely 0.29, PostgreSQL 18, SWC
- **Architecture:** lean modular — Controller → Service → (Repository when earned)
- **API on port 3001, Postgres on 5435** (3000 and 5432 are taken on this machine)
- **Before committing:** `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
- **Companion app:** `d:\Dev\tgbots\headhunter-app` (Flutter)
