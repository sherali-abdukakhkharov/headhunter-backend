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
pnpm seed
pnpm api:up         # build the image and run the API container
pnpm tunnel:up      # cloudflared
pnpm tunnel:logs    # watch it register
```

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

Two settings are refused at boot in production, both deliberately:

- `OTP_ECHO_IN_RESPONSE` must be `false`. It is currently `true` in the local `.env`
  and would hand any caller a login code for any phone number.
- `TELEGRAM_JWKS_URL` must be `https`. Signing keys fetched over plaintext can be
  substituted, which forges every login.

`OTP_STATIC_CODE` is refused too, which is why **the container does not set
`NODE_ENV`**: the image would refuse to boot against the current `.env`, and the
fixed code is intentional until an SMS provider exists. The flag to flip when that
day comes is in `.env`, not in the image.

Because of that, log format is controlled by `LOG_PRETTY`, not by `NODE_ENV`. The
container sets `LOG_PRETTY=false`: `pino-pretty` is a devDependency and the image
carries production dependencies only, so pretty printing would fail at boot on a
transport it does not have.

### `API_DOCS_ENABLED`

`/docs` and `/reference` describe every endpoint and payload. Useful for the mobile
devs, and public once the hostname is. Either set it to `false`, or leave it on and
put a Cloudflare Access policy in front of those two paths — the second is better
while the client is still being written.

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

- **No SMS provider.** Login codes are not delivered anywhere; `OTP_STATIC_CODE` and
  `OTP_ECHO_IN_RESPONSE` stand in, and production boot refuses both. Connecting
  Eskiz.uz is therefore a hard prerequisite for real users, not a nice-to-have — see
  [SMS_PROVIDER.md](SMS_PROVIDER.md).
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
| No SMS arrives after `/auth/otp/send` | Expected — no provider is connected. The code is `OTP_STATIC_CODE`, and `devCode` in the response |
| `/auth/otp/*` returns 404 | `OTP_LOGIN_ENABLED` is false. The 404 is deliberate; see `OtpEnabledGuard` |
| Boot logs `OTP_STATIC_CODE is set` | Not an error. It warns on every start because a fixed code is a master key |
| Telegram login fails, nothing in our logs | The redirect URI is not registered in BotFather. It fails on the client, before reaching us |
