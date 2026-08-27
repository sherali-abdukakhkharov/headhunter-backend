# Deployment — hh.qitmir.uz via Cloudflare tunnel

The API is published through a named Cloudflare tunnel, the same arrangement as
`sahih.qitmir.uz` and the other bots on this machine. Nothing is exposed inbound:
cloudflared holds an outbound connection to Cloudflare, so there is no port to
forward, no origin certificate to manage, and no listening socket to scan.

---

## 1. The tunnel — already created

Done on 2026-08-05. Recorded here so it can be rebuilt or moved.

| | |
|---|---|
| Tunnel name | `headhunter` |
| Tunnel id | `3d0cec91-0f40-4f1d-848a-76c4c952142b` |
| Hostname | `hh.qitmir.uz` (CNAME to the tunnel, in Cloudflare DNS) |
| Credentials | `docker/cloudflared/<tunnel-id>.json` — gitignored |
| Account credential | `cert.pem`, **not in this repo**; see below |

`cloudflared` is installed on this machine (`winget install Cloudflare.cloudflared`,
2026.7.3). It lands in `C:\Program Files (x86)\cloudflared\` — **open a new terminal
after installing**, or it will not be on `PATH`.

### cert.pem deliberately lives elsewhere

A tunnel needs only its credentials JSON to **run**. The account-level `cert.pem` is
needed only for management commands (`create`, `delete`, `route dns`), and it
authorizes those for the *entire* `qitmir.uz` zone — so it is not copied here. The one
that already existed for the other tunnels is reused in place:

```sh
CERT="D:/Dev/tgbots/sahih-bot/docker/cloudflared/cert.pem"

cloudflared tunnel --origincert "$CERT" list
cloudflared tunnel --origincert "$CERT" create headhunter
cloudflared tunnel --origincert "$CERT" route dns headhunter hh.qitmir.uz
```

Note `create` writes the credentials JSON **next to the cert it found**, ignoring
`--credentials-file`; move it into `docker/cloudflared/` afterwards.

Starting from nothing instead, `cloudflared tunnel login` writes a fresh `cert.pem`
after a browser round trip.

**Both credential files are gitignored and must stay that way.** The JSON is a bearer
credential for this tunnel; `cert.pem` is account-level for the whole zone. Anyone
holding either can serve traffic as `hh.qitmir.uz`.

## 2. Bring it up

```sh
pnpm db:up          # Postgres
pnpm migrate:latest # schema, then content
pnpm seed           # dictionaries, field schemas, and the administrators
pnpm api:up         # build the image and run the API container
pnpm tunnel:up      # cloudflared
pnpm tunnel:logs    # watch it register
```

### `pnpm seed` is also what grants the first administrator

§10 is a role inside the mobile app and there is deliberately **no API route that grants it**:
a product where administrators can create administrators has no floor. So set
`SEED_ADMIN_PHONES` — comma-separated `phone[:full name]` entries — before seeding, and the
seeder grants the role idempotently, creating the account if that number has never registered.

```
SEED_ADMIN_PHONES=+998901234567:Karimov Anvar Rustam o'g'li,+998901234568
```

The name is optional and lands in `users.full_name`. It is worth setting: an administrator has
no candidate profile and no employer row, so without it §10.2's user list shows the account
nameless and its name filter cannot find it — an administrator could not look up a colleague.
Re-seeding with a changed name updates it; re-seeding without one leaves it alone, because
erasing a name is BR-14's job and goes through the purge.

**Do not skip this on a fresh instance.** Both MVP flags have been on since M10, so an instance
with no administrator does not merely lack a feature: every employer who registers parks in
`under_review`, no vacancy can be moderated, and nothing in the logs explains why. `pnpm seed`
says so out loud when the variable is unset.

It grants an entitlement, never a credential — login is still phone + OTP, so the person still
has to hold the SIM. The numbers are per-deployment configuration rather than committed, so a
development instance and production do not share an administrator by default; that matters most
where `OTP_STATIC_CODE` is set, because there the number would be the whole of the
authentication.

**The API runs in a container as of 2026-08-05** (`Dockerfile`,
`docker-compose.api.yml`). The tunnel's origin is `http://api:3001` — the service
name over the Docker network the three compose files share, because they live in one
directory and Compose therefore gives them one project and one default network.

Redeploying after a code change is one command: `pnpm api:up` rebuilds the image and
replaces the container.

Two things this arrangement deliberately does **not** do:

- **The container does not migrate at boot.** Two replicas would race, and a
  rollback would become a database event. Run `pnpm migrate:latest` from the host,
  before `pnpm api:up`, exactly as above.
- **The container's port is published to loopback only** (`127.0.0.1:3001`).
  cloudflared does not use it — it addresses `api` directly — so nothing is reachable
  from the LAN. The mapping exists only so a developer can curl the origin.

*Why not `host.docker.internal:3001`, which also appears to work here:* Docker
Desktop's port proxy makes a loopback-bound published port reachable from that name,
and a Linux host does not. The API would be unreachable on a real server with no
clue as to why. Addressing the service by name removes the host from the path
altogether.

*The previous arrangement, for the record:* `pnpm start:dev` (or `node dist/main.js`)
on the host with the tunnel pointing at `host.docker.internal:3001`. Still workable
for debugging — stop the container first so 3001 is free, and point the ingress back.

Check it end to end:

```sh
curl https://hh.qitmir.uz/health
curl -H 'x-lang: ru' https://hh.qitmir.uz/dictionaries/region
```

### Verified working, 2026-08-05

Four edge connections registered (waw05 ×2, vno01, plus one more), `/health` 200 in
0.7s, dictionaries served in Russian, ETag revalidation returning 304 through the
proxy, and localized errors intact.

The check that actually mattered: a request to `https://hh.qitmir.uz/auth/telegram`
incremented a rate-limit counter keyed on the **real public client address**, not on
the tunnel's loopback. That is `CLIENT_IP_HEADER=cf-connecting-ip` working end to end;
without it that same request would have keyed on `::ffff:127.0.0.1` along with
everyone else's.

---

## 3. Environment for a public deployment

Going public changes the meaning of several settings. These are the ones that matter.

### `CLIENT_IP_HEADER=cf-connecting-ip` — set this, or per-IP limits do nothing

cloudflared connects to the API from loopback, so without it every request looks like
`127.0.0.1` and **all users on earth share one rate-limit bucket**.

`X-Forwarded-For` is *not* the answer here, and this is the trap worth understanding:
Cloudflare puts the user's address **first** and its own after it, while Express's
`trust proxy` hop count reads from the **right**. So `TRUSTED_PROXY_HOPS=1` makes
`req.ip` the Cloudflare edge address. Cloudflare also *appends* to a client-supplied
`X-Forwarded-For` rather than replacing it, and cloudflared has a standing bug that
can corrupt the result — so the header is partly attacker-controlled. `CF-Connecting-IP`
is set and overwritten by Cloudflare, so a client cannot forge it.

It is only read when named here. With nothing in front of the service, anyone could
send the header and mint a fresh budget per request — which is why the code never
infers it from the header's presence.

### `TRUSTED_PROXY_HOPS=1`

Separate concern: it makes Express proxy-aware so `req.protocol` and `req.secure`
reflect the original HTTPS request. It does **not** feed rate limiting. Setting it
without `CLIENT_IP_HEADER` logs a warning at boot for exactly that reason.

### `NODE_ENV=production`

**Five** settings are refused at boot in production, all deliberately:

- `OTP_ECHO_IN_RESPONSE` must be `false`. It would hand any caller a login code for
  any phone number, over a **public** route.
- `OTP_STATIC_CODE` must be empty. A fixed code is a master key to every account.
- `TELEGRAM_JWKS_URL` must be `https`. Signing keys fetched over plaintext can be
  substituted, which forges every login.
- **`MODERATION_ENABLED` must be `true`** *(since 2026-08-27, MT-003)*. Off, a
  vacancy becomes discoverable with no administrator decision — §6.4, BR-04, BR-12,
  UAT-05 and UAT-11 all unenforced, while the moderation screen still exists and
  looks like it is doing something.
- **`EMPLOYER_VERIFICATION_ENABLED` must be `true`** *(same change)*. Off, every
  employer self-verifies and §6.1's decision never happens.

`src/infra/env-schema.spec.ts` covers all five. They had been trusted and untested,
which is a boot check that can stop working silently.

> ### If the container stops booting after this change, that is the change working
>
> Three consecutive audits found `MODERATION_ENABLED=false` on the deployed API,
> which is why it is now a refusal and not a warning — a warning is demonstrably
> what was being ignored. The boot log names the variable and says why.
>
> **The fix is `MODERATION_ENABLED=true` and `EMPLOYER_VERIFICATION_ENABLED=true`
> in the deployment's `.env`, then `pnpm api:up`.** Both need an administrator to
> exist, which `pnpm seed` grants to `SEED_ADMIN_PHONES` — that runs against the
> database rather than through this API, so there is no ordering problem.
>
> They are deliberately **not** pinned in `docker-compose.api.yml` beside
> `LOG_PRETTY`. Pinning them would make the deployment correct and silent; the
> point of a fail-closed check is that somebody finds out.

`OTP_STATIC_CODE` is refused too, and **since 2026-08-20 `NODE_ENV=production` is
set**: Eskiz delivers, both variables are cleared, and the guarantee has moved off
the `.env` file and onto boot validation. Reopening either hole now stops the
container instead of weakening login, which is the point.

Until that day the container deliberately did *not* set `NODE_ENV`, because the
image would have refused to boot against the `.env` it had. If a future change
needs a fixed code again, that ordering is the one to repeat — clear the flags
first, set `NODE_ENV` second.

Because of that, log format is controlled by `LOG_PRETTY`, not by `NODE_ENV`. The
container sets `LOG_PRETTY=false`: `pino-pretty` is a devDependency and the image
carries production dependencies only, so pretty printing would fail at boot on a
transport it does not have.

### `API_DOCS_ENABLED=false` *(since 2026-08-20)*

`/docs`, `/reference` and `/docs-json` describe every endpoint and payload, and the hostname
is public. All three now answer **404**.

The schema still defaults to `true`: somebody running this locally should get the
documentation without configuring anything, and a deployment is where the decision belongs.

The mobile developers read `docs/openapi.json` from the repository instead. That is not a
downgrade — it is the same document from the same builder (`buildOpenApiDocument`, shared
with `pnpm docs:openapi`), so the file cannot drift from what the server would have served.
Regenerate it whenever a client-visible response changes.

A Cloudflare Access policy in front of the two paths was the alternative. Turning the flag
off is stronger: a policy guards a route that still exists.

### `PUBLIC_BASE_URL=https://hh.qitmir.uz`

Operator-facing only: it makes the boot log print real URLs instead of `localhost`.
Never used to build a client-facing link.

### `CORS_ORIGINS`

`*` is fine for now — the mobile client is not origin-bound and the API authenticates
with bearer tokens, not cookies, so a reflected origin grants nothing. Narrow it if a
web build ever appears.

---

## 3a. Live right now, and worth knowing

`hh.qitmir.uz` is reachable with `NODE_ENV=development`. Three things are true of that
state, and the first one changed on 2026-08-05:

- **Anyone who can reach this URL can log in as any phone number.** Login is now
  phone + OTP, `OTP_LOGIN_ENABLED=true`, and there is no SMS provider — so
  `OTP_STATIC_CODE=666666` issues a known code and `OTP_ECHO_IN_RESPONSE=true` returns
  it in the send response as well. Two public calls with any number get a valid session.
  That is **intended for now**: the mobile devs need a working login and no SMS can be
  sent. It is not a bug and not a code fix — it is a property of this deployment, and
  the reason to be deliberate about who knows the hostname.
  *What removes it:* `NODE_ENV=production`, which makes boot **refuse** both variables,
  by which point a provider must be connected. Nothing else needs changing.
  *What reduces it meanwhile:* a Cloudflare Access policy in front of the hostname, or
  taking the tunnel down between sessions (`pnpm tunnel:down`) — this is a dev URL, not
  an environment that needs to be up.
- **`/docs`, `/reference` and `/docs-json` answer 200 publicly.** Every endpoint and
  payload is described to anyone who asks. Deliberate for now — the mobile devs are
  working against it — but it belongs behind the same Access policy.
- **The production guards are not being enforced generally**, because they key off
  `NODE_ENV=production`. The two OTP flags above are the ones that matter today.
- **Port 3001 is still bound on all interfaces.** With
  `CLIENT_IP_HEADER=cf-connecting-ip` set, anyone who can reach the origin directly on
  the LAN can send that header and bypass per-IP limits. Not reachable from the
  internet — the tunnel is outbound-only — but worth closing on a shared network.

## 4. Before this carries real users

Not blockers for a staging URL; each is a real gap for production.

- ~~**No SMS provider.**~~ **Done 2026-08-20.** Eskiz.uz delivers, codes are random,
  and both stand-ins are cleared with `NODE_ENV=production` refusing them at boot.
  Real numbers have been signing in since; owner confirmed 2026-08-26. See
  [SMS_PROVIDER.md](SMS_PROVIDER.md), including the outage connecting it caused.
  Left listed rather than deleted because this is the section somebody reads to
  decide whether the deployment can carry users, and an item that vanishes reads as
  one that was never considered.
- **Rate limits are per instance-independent but the counter table is never pruned.**
  `rate_limit_counters` holds one row per phone and per IP seen. Bounded, but it only
  grows — the maintenance job is an M11 ops task.
- **No Dockerfile or CI.** The API runs under `pnpm start:dev`, which is a watcher,
  not a supervised process.
- **Backups.** §13.2 wants scheduled dumps and a *rehearsed* restore. Neither exists.
- **`/health` is public** and reports whether Postgres is reachable. Standard, and a
  small amount of information; a Cloudflare Access policy on it costs nothing.
- **Malware scanning on uploads** (§12.5 "where infrastructure permits"). Telegram
  performs none on a bot upload, and the checks in `FilesService` are type validation,
  not scanning.
- **`TELEGRAM_STORAGE_CHAT_ID` is currently a personal chat.** Every uploaded CV lands
  there, so that Telegram account's security is the platform's document security. A
  private channel with the bot as its only other member separates the two and survives
  a person leaving.

---

## 5. Diagnosing a failure

| Symptom | Where to look |
|---|---|
| `curl https://hh.qitmir.uz/health` returns a Cloudflare 502/1033 | The tunnel is up but the origin is not. `docker ps` — is `headhunter-api` running and healthy? Right after a restart, give it a few seconds: cloudflared drops its QUIC connection when the origin goes away and re-registers |
| 502 that persists, and the container *is* healthy | The tunnel and the API are not on the same Docker network. Both compose files must run from this directory so Compose gives them one project; check with `docker inspect headhunter-cloudflared --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'` |
| The container serves old code | `pnpm api:up` rebuilds; a bare `docker compose up -d` reuses the existing image. This is the containerised version of the trap that cost an afternoon when the origin was `node dist/main.js` |
| `headhunter-api` restart-loops at boot | Read `docker logs headhunter-api`. If it mentions `pino-pretty`, `LOG_PRETTY` is true in an image that has production dependencies only |
| The API cannot reach Postgres from the container | `DB_HOST=postgres` and `DB_PORT=5432` inside the network — the host's 5435 mapping does not exist there. `docker-compose.api.yml` overrides both |
| Cloudflare 1016 / DNS error | `cloudflared tunnel route dns` was not run, or the CNAME was removed |
| Everything rate-limited at once | `CLIENT_IP_HEADER` is unset — every caller is sharing the loopback bucket |
| Boot refuses to start | Joi rejected a variable; the message names it and says why |
| No SMS arrives after `/auth/otp/send` | A real failure now — Eskiz delivers, and there is no `devCode` to fall back on. Check the boot log for `ESKIZ_EMAIL`, then the response code: `sms_template_not_approved` is fixed in Eskiz's dashboard, not here |
| `/auth/otp/*` returns 404 | `OTP_LOGIN_ENABLED` is false. The 404 is deliberate; see `OtpEnabledGuard` |
| Boot logs `OTP_STATIC_CODE is set` | Should no longer happen. It warns because a fixed code is a master key to every account — if you see it, somebody set the variable, and `NODE_ENV=production` should have refused the boot outright |
| Logs `auto-verified: EMPLOYER_VERIFICATION_ENABLED is off` | Expected until M10. Nobody can approve a submission yet, so it self-approves; the audit row records a null actor. Turn the flag on when the admin module lands |
| Telegram login fails, nothing in our logs | The redirect URI is not registered in BotFather. It fails on the client, before reaching us |
