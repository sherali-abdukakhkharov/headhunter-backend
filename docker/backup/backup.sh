#!/bin/sh
# Takes one dump, verifies it, and prunes old ones.
#
# Run by the loop in `schedule.sh`, or on demand with `pnpm backup:now`. Everything
# it needs comes from the environment, so a manual run and a scheduled one are the
# same code path - the usual reason a backup works until the day it is needed.
set -eu

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/headhunter-${STAMP}.dump"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"
}

log "dumping ${DB_NAME} from ${DB_HOST}:${DB_PORT} to $(basename "${TARGET}")"

# --format=custom, not plain SQL: it is compressed, and pg_restore can read a single
# table out of it, which is what a partial recovery actually needs. Written to .part
# first so a crash mid-dump cannot leave a truncated file that looks like a backup.
PGPASSWORD="${DB_PASSWORD}" pg_dump \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_USER}" \
  --dbname="${DB_NAME}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="${TARGET}.part"

mv "${TARGET}.part" "${TARGET}"

# A dump nobody can read is not a backup. Listing the archive's table of contents
# costs milliseconds and catches a truncated or corrupt file here, rather than during
# the incident that needs it. It is not a restore - that is what the rehearsal in
# docs/BACKUP.md is for - but it is the cheapest check that means anything.
if ! pg_restore --list "${TARGET}" > /dev/null 2>&1; then
  log "FAILED: ${TARGET} is not a readable archive; keeping it for inspection"
  exit 1
fi

sha256sum "${TARGET}" | sed "s| .*/| |" > "${TARGET}.sha256"

SIZE="$(du -h "${TARGET}" | cut -f1)"
log "wrote ${TARGET} (${SIZE}), archive verified"

# Prune by age, and only ever files this script's own naming produced.
DELETED="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'headhunter-*.dump' -type f \
  -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')"
find "${BACKUP_DIR}" -maxdepth 1 -name 'headhunter-*.dump.sha256' -type f \
  -mtime "+${BACKUP_RETENTION_DAYS}" -delete

KEPT="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'headhunter-*.dump' -type f | wc -l | tr -d ' ')"
log "pruned ${DELETED} older than ${BACKUP_RETENTION_DAYS} days; ${KEPT} kept"
