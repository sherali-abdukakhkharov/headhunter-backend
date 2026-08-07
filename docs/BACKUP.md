# Backup and restore

§12.3 asks for regular backups. This document is the other half of that: a backup
nobody has restored is a hypothesis, so the restore below was **rehearsed on
2026-08-07** and its real output is recorded here.

## What runs

`docker-compose.backup.yml` starts one container, `headhunter-backup`, which takes a
`pg_dump` of the live database once a day and prunes old ones.

| | |
|---|---|
| **When** | 21:00 UTC daily, which is 02:00 in Tashkent |
| **Where** | `./backups/headhunter-<UTC timestamp>.dump`, a bind mount on the host |
| **Format** | `pg_dump --format=custom`, compressed, restorable table by table |
| **Retention** | 14 days (`BACKUP_RETENTION_DAYS`) |
| **Verified** | every dump is listed with `pg_restore --list` before it counts as written, and gets a `.sha256` beside it |

```
pnpm backup:up      # start the daily schedule
pnpm backup:now     # take one right now
pnpm backup:list    # what is on disk
pnpm backup:logs    # the schedule and every run
pnpm backup:down    # stop the schedule
```

Four decisions in there are deliberate and worth knowing before changing them.

- **A bind mount, not a Docker volume.** A backup living inside Docker's own storage
  is lost to the accident most likely to require it. `backups/` is gitignored: a
  dump holds every phone number, message and file reference in the product, and is
  the most sensitive artifact this repository can produce.
- **The same `postgres:18-alpine` the server runs.** `pg_dump` refuses to dump a
  server newer than itself, so a pinned older client would start failing silently on
  the day Postgres is upgraded.
- **A sleep loop rather than cron.** No crond in the image, the schedule reads as one
  line, and `docker logs` shows both the schedule and every run. It recomputes the
  wait from the clock each iteration, so drift cannot accumulate; if the machine was
  off at 21:00 it takes the missed backup on start rather than skipping the day.
- **A failed backup never kills the loop.** Tomorrow's attempt is the recovery, and a
  container that exited is a backup system that stopped without telling anyone.

> **Never pass `--remove-orphans`** to a `docker compose` command in this project.
> All four compose files share one project name, so each command sees the other
> three services as orphans and that flag would delete the API, the database and the
> tunnel. The warning it prints is noise; the flag is not.

## Restoring

```
pnpm restore <dump-file>                      # into headhunter_restore_check
pnpm restore <dump-file> --into headhunter --force   # over the live database
```

The default target is a scratch database, not production. A drill that can destroy
the live data is a drill nobody runs, and this one needs to be boring enough to
repeat. Restoring over a database that already has tables requires `--force`, typed
out.

The script verifies the archive and its checksum **before** touching any database,
runs `pg_restore --exit-on-error` so a half-restored archive cannot report success,
and prints what actually landed - including `schema_version`, because a restore that
lands on a migration state the running API does not expect is a broken restore
however clean the exit code was.

**Run these from PowerShell or through `pnpm`, not from Git Bash**: MSYS rewrites the
container-absolute `/backup.sh` into a Windows path and the container dies with
`exec C:/Program failed`.

## The rehearsal, 2026-08-07

Taking a backup:

```
$ pnpm backup:now
backup: dumping headhunter from postgres:5432 to headhunter-20260807T184352Z.dump
backup: wrote /backups/headhunter-20260807T184352Z.dump (1.0M), archive verified
backup: pruned 0 older than 14 days; 1 kept
```

Restoring it into the scratch database:

```
$ pnpm restore headhunter-20260807T184352Z.dump
restore: archive /backups/headhunter-20260807T184352Z.dump is readable
restore: checksum matches
restore: created headhunter_restore_check
restore: restored into headhunter_restore_check: tables/users/dictionary_items/schema_version = 49 4251 635 17
restore: done
```

Then four checks, because "pg_restore exited 0" is not the same as "the database is
back".

**1. The schema is identical, object for object.**

| | live | restored |
|---|---|---|
| tables | 49 | 49 |
| indexes | 122 | 122 |
| triggers | 8 | 8 |
| constraints | 425 | 425 |
| enum types | 19 | 19 |

**2. The migration state matches.** `kysely_migration` holds 17 rows, the same set
the running API expects, so the restored database is one it could boot against
rather than one that would immediately try to migrate.

**3. A rule still fires.** Object counts can match while behaviour is missing, so the
drill provokes one:

```
$ psql -d headhunter_restore_check -c "DELETE FROM admin_audit_log WHERE true;"
ERROR:  admin_audit_log is append-only: DELETE refused (SPEC 10.4)
CONTEXT:  PL/pgSQL function admin_audit_log_append_only() line 3 at RAISE
```

**4. A partial index survived with its predicate** - BR-07 is that index, not a check
in a service, so losing the `WHERE` clause would silently permit two active
applications:

```
CREATE UNIQUE INDEX applications_one_active_idx ON public.applications
  USING btree (vacancy_id, candidate_user_id)
  WHERE (status <> ALL (ARRAY['withdrawn'::application_status, 'rejected'::application_status]))
```

The scratch database was then dropped:

```
$ docker exec headhunter-postgres psql -U headhunter -d postgres \
    -c "DROP DATABASE headhunter_restore_check WITH (FORCE);"
```

**Re-run this drill whenever a migration changes a trigger, a partial index or an
enum** - those are the objects a dump can lose quietly - and after any Postgres
upgrade.

## What this does not cover yet

- **Off-machine copies.** The dumps sit on the same disk as the database they came
  from, which protects against a bad migration or a dropped table but not against
  losing the machine. Somewhere else - object storage, or another host - is the next
  step, and it needs a decision about where Uzbek personal data may be stored before
  it can be a technical one.
- **Point-in-time recovery.** A daily dump means up to 24 hours of loss in the worst
  case. WAL archiving would close that, at the cost of somewhere to stream to; worth
  raising with the client once there is real traffic to lose.
- **A restore of the file bytes.** Uploaded files live in a Telegram chat and are not
  in this dump - only the metadata rows that point at them. Restoring an old dump
  alongside the current chat is therefore consistent in one direction only: files
  uploaded after the dump remain in Telegram with no row to find them. There is
  nothing to do about that here; it is a property of ARCHITECTURE.md §9's storage
  choice, and it is written down so nobody discovers it during an incident.
