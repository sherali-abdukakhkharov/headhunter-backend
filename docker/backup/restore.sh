#!/bin/sh
# Restores a dump, by default into a scratch database.
#
#   docker compose -f docker-compose.backup.yml run --rm backup \
#     /restore.sh headhunter-20260807T210000Z.dump [--into <db>] [--force]
#
# The default target is `headhunter_restore_check`, not the live database. A restore
# rehearsal that can destroy production is a rehearsal nobody runs, and the whole
# point of the drill is that it is boring enough to do often. Restoring over a
# database that already has tables needs --force, said out loud.
set -eu

DUMP=""
TARGET_DB="headhunter_restore_check"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --into) TARGET_DB="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) DUMP="$1"; shift ;;
  esac
done

if [ -z "${DUMP}" ]; then
  echo "usage: restore.sh <dump-file> [--into <database>] [--force]" >&2
  echo "available:" >&2
  ls -1t "${BACKUP_DIR}" 2>/dev/null | head -20 >&2
  exit 2
fi

case "${DUMP}" in
  /*) SOURCE="${DUMP}" ;;
  *) SOURCE="${BACKUP_DIR}/${DUMP}" ;;
esac

[ -f "${SOURCE}" ] || { echo "no such dump: ${SOURCE}" >&2; exit 2; }

export PGPASSWORD="${DB_PASSWORD}"
PSQL="psql --host=${DB_HOST} --port=${DB_PORT} --username=${DB_USER} --no-psqlrc --quiet"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restore: $*"
}

# Verify the archive before touching any database.
pg_restore --list "${SOURCE}" > /dev/null
log "archive ${SOURCE} is readable"

if [ -f "${SOURCE}.sha256" ]; then
  (cd "${BACKUP_DIR}" && sha256sum -c "$(basename "${SOURCE}").sha256" > /dev/null)
  log 'checksum matches'
fi

EXISTS="$(${PSQL} --dbname=postgres --tuples-only --no-align \
  --command="SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'")"

if [ -n "${EXISTS}" ]; then
  TABLES="$(${PSQL} --dbname="${TARGET_DB}" --tuples-only --no-align \
    --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"

  if [ "${TABLES}" -gt 0 ] && [ "${FORCE}" -eq 0 ]; then
    echo "${TARGET_DB} already has ${TABLES} tables. Pass --force to replace it." >&2
    exit 3
  fi

  log "dropping and recreating ${TARGET_DB} (${TABLES} tables)"
  ${PSQL} --dbname=postgres --command="DROP DATABASE \"${TARGET_DB}\" WITH (FORCE)"
fi

${PSQL} --dbname=postgres --command="CREATE DATABASE \"${TARGET_DB}\" OWNER \"${DB_USER}\""
log "created ${TARGET_DB}"

# --exit-on-error, because a restore that reports success after skipping half the
# archive is the failure mode this whole exercise exists to rule out.
pg_restore \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_USER}" \
  --dbname="${TARGET_DB}" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "${SOURCE}"

# What was actually restored. `schema_version` is the migration state, and a restore
# that lands on a different one than the running API expects is a broken restore
# however clean pg_restore's exit code was.
SUMMARY="$(${PSQL} --dbname="${TARGET_DB}" --tuples-only --no-align --field-separator=' ' --command="
  SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'),
         (SELECT count(*) FROM users),
         (SELECT count(*) FROM dictionary_items),
         (SELECT value FROM app_meta WHERE key = 'schema_version')")"

log "restored into ${TARGET_DB}: tables/users/dictionary_items/schema_version = ${SUMMARY}"
log 'done'
