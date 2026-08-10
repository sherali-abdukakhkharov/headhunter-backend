# Support notes

§13.2's "support notes": what breaks, how to tell, and what to do about it. Setup and
deployment are in [README.md](../README.md) and [DEPLOYMENT.md](DEPLOYMENT.md); this is the
runbook for when something is already wrong.

## First: what is actually running

Most confusing reports end here, so start here.

```
docker ps --filter name=headhunter          # api, postgres, cloudflared, backup
curl -s http://127.0.0.1:3001/health        # the container, no tunnel involved
curl -s https://hh.qitmir.uz/health         # through Cloudflare
docker logs headhunter-api --tail 50
```

**`/health` never throws.** A failing dependency is reported as `degraded` with a **200**,
so monitoring can tell "up but Postgres is down" from "not responding at all". A non-200
from `/health` means the process is gone or the tunnel is not reaching it - two different
problems, which is why the two curls above are separate.

| `/health` says | Meaning |
|---|---|
| `{"status":"ok","database":"up"}` | Everything |
| `{"status":"degraded","database":"down"}` | The API is fine; Postgres is not reachable |
| connection refused on 127.0.0.1:3001 | The container is not running |
| 502 from hh.qitmir.uz but 200 locally | The tunnel lost its origin - see below |

## The trap that has cost the most time

**The container serves a built image, not your source.** After changing code or `.env`:

```
pnpm api:up      # rebuilds and restarts - this is the whole redeploy
```

A bare `docker compose up -d` **reuses the existing image** and reproduces the bug you just
fixed. The classic symptom is a correct-looking 404 from `/auth/otp/send`: the guard is
reading an `OTP_LOGIN_ENABLED` that was false when the image was built. Migrations are a
separate, deliberate host step (`pnpm migrate:latest`) - a container that migrated at boot
would race itself the moment there were two.

## Symptoms

### "The app can't log in"

1. **404 from `/auth/otp/*`** - `OTP_LOGIN_ENABLED` is false in the *running image*. A
   disabled endpoint answers 404 rather than 403 on purpose: it should be
   indistinguishable from one that never existed. Fix the variable, then `pnpm api:up`.
2. **429 `auth.otp_resend_too_soon`** - the resend delay (`OTP_RESEND_DELAY_SECONDS`, 60s).
   Working as intended; `Retry-After` says how long.
3. **429 `error.too_many_requests`** - the per-phone OTP budget, five an hour. Also working
   as intended. On a dev box you can clear the window:
   `docker exec headhunter-postgres psql -U headhunter -d headhunter -c "DELETE FROM rate_limit_counters;"`
   Never on production without deciding to.
4. **401 `auth.otp_invalid` with the right code** - the code is single-use and expires in
   `OTP_TTL_SECONDS`. `OTP_STATIC_CODE` fixes *which* code is issued; it is **not** a
   second acceptance path, so it still needs a live, unconsumed row. Send again.
5. **No SMS at all** - correct: no provider is connected. `OTP_ECHO_IN_RESPONSE` returns
   the code in the send response. See [SMS_PROVIDER.md](SMS_PROVIDER.md).

### "Everyone is being rate limited"

Almost always `CLIENT_IP_HEADER`. Behind Cloudflare it must be `cf-connecting-ip`; if it is
empty, every caller looks like the tunnel and the whole world shares one bucket. It is
**not** `x-forwarded-for` - Cloudflare puts the user's address first and its own second,
the opposite of what Express's hop count reads, and it appends to a client-supplied header
rather than replacing it. The boot log prints which header it is reading.

With nothing in front of the API, leave it empty: trusting the header without a proxy lets
any caller spoof its address.

### "The API is up but the site is down"

The tunnel drops its QUIC connection when the origin goes away and takes a few seconds to
re-register, so the first call after a restart can fail through `hh.qitmir.uz` while
`127.0.0.1:3001` is already fine. Wait, then `docker logs headhunter-cloudflared --tail 20`.

### "Notifications aren't arriving"

Push is **best effort**; the in-app list is the record. In order of likelihood:

1. The device has no Google Play services (any post-2019 Huawei). Nothing to fix - the
   banner is lost, the in-app list is not.
2. `FCM_SERVICE_ACCOUNT_BASE64` is empty. Then nothing is pushed at all, a warning is
   logged at boot and once per dispatch, and every row is stored `failed` with
   `push_not_configured`. Nothing pretends to have delivered.
3. The token was rejected as `invalid` and has been disabled - the client re-registers on
   next launch.

Check what the server believes: `GET /notifications` returns the same list the user sees.

### "A file won't download"

Every download re-checks the rule that grants access on **every** request, so a link that
worked yesterday can legitimately stop working - a withdrawn application revokes exposure
(BR-09), which is the design. A 404 rather than a 403 is also deliberate: confirming that
an id exists elsewhere is information we do not owe.

A 502 from a download means Telegram. Bytes live in a private channel; the ceiling is
20 MB because `getFile` refuses to download anything larger.

### "An administrator can't be deleted"

Correct, and it cannot be overridden. An audit row that forgot who acted is not an audit
row, so the account is **anonymized** instead - identity erased, id kept. See
[RETENTION.md](RETENTION.md); `POST /admin/retention/purge` does it.

### A test fails only in the full run

Check whether it compares a JavaScript timestamp against Postgres's clock. The host and the
container drift by about a second, so anything with less than a minute of margin is a coin
flip. This is not cross-suite interference, which is what it looks like.

Also: **the dev server and `pnpm test:int` share one database.** Driving live requests while
the suite runs is cross-talk - a known-flaky *arrangement*, not a known-flaky test.

## Reading the logs

JSON lines through pino (`LOG_PRETTY=false` in the container - `pino-pretty` is a
devDependency and the image carries production dependencies only).

- `authorization` and `cookie` headers are redacted; bodies are never logged.
- **Phone numbers appear only as `***67`**, and only where they are logged at all. OTP
  codes and tokens are never logged - only hashes are stored.
- Every read of protected data is logged with who read it and why (§11.1), which is what
  makes "who looked at this candidate" answerable.

```
docker logs headhunter-api --tail 200 | Select-String "ERROR"
docker logs headhunter-api -f
```

## Backups

Daily at 21:00 UTC into `./backups`, 14 days, every dump verified when written. `pnpm
backup:logs` shows the schedule and every run. **The restore is rehearsed** and its real
output is in [BACKUP.md](BACKUP.md) - read that before you need it, not after.

> **Never pass `--remove-orphans`** to a `docker compose` command in this project. All four
> compose files share one project name, so each command sees the other three services as
> orphans and that flag would delete the API, the database and the tunnel.

## Escalation: what needs a decision rather than a fix

- **The OTP SMS provider is not bought.** Real users cannot receive a code.
- **`API_DOCS_ENABLED` is on and the hostname is public.** `/docs` describes every endpoint
  to anyone who asks.
- **No administrator account exists on the deployed instance**, so
  `EMPLOYER_VERIFICATION_ENABLED` and `MODERATION_ENABLED` are false there. The first admin
  is granted by hand - the SQL is in `.env.example`, and no route grants that role by
  design.
- **Retention periods are provisional** until the client approves a privacy policy.
