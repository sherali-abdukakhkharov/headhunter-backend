#!/bin/sh
# Runs backup.sh once a day at BACKUP_AT_HOUR (UTC), forever.
#
# A sleep loop rather than cron: the alpine image has no crond running, the schedule
# is one line here instead of a crontab in a third place, and `docker logs
# headhunter-backup` shows both the schedule and every run. It is also restartable -
# `restart: unless-stopped` plus the catch-up below means a machine that was off at
# 02:00 takes its backup when it comes back rather than skipping the day.
set -eu

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) schedule: $*"
}

mkdir -p "${BACKUP_DIR}"

log "daily at ${BACKUP_AT_HOUR}:00 UTC, keeping ${BACKUP_RETENTION_DAYS} days in ${BACKUP_DIR}"

# Catch-up on start: if nothing was written today, take one now. This is what makes
# the schedule survive a reboot, and it also means `up -d` produces a backup
# immediately rather than leaving the first one a day away.
if [ -z "$(find "${BACKUP_DIR}" -maxdepth 1 -name "headhunter-$(date -u +%Y%m%d)T*.dump" -type f 2>/dev/null)" ]; then
  log 'no backup yet today - taking one now'
  /backup.sh || log 'catch-up backup FAILED; the schedule continues'
fi

while true; do
  NOW_H="$(date -u +%H)"
  NOW_M="$(date -u +%M)"
  NOW_S="$(date -u +%S)"
  # Seconds until the next BACKUP_AT_HOUR:00:00 UTC. Recomputed every iteration from
  # the clock rather than accumulated, so drift cannot build up over months.
  SECONDS_TODAY=$((${NOW_H#0} * 3600 + ${NOW_M#0} * 60 + ${NOW_S#0}))
  TARGET_SECONDS=$((${BACKUP_AT_HOUR#0} * 3600))
  WAIT=$((TARGET_SECONDS - SECONDS_TODAY))
  [ "${WAIT}" -le 0 ] && WAIT=$((WAIT + 86400))

  log "next run in ${WAIT}s"
  sleep "${WAIT}"

  # A failed backup must not kill the loop: tomorrow's attempt is the recovery, and a
  # dead container is a backup system that stopped silently.
  /backup.sh || log 'backup FAILED; will try again at the next scheduled time'
done
