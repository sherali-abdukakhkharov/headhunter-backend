# Deployment — hh.qitmir.uz via Cloudflare tunnel

The API is published through a named Cloudflare tunnel, the same arrangement as
`sahih.qitmir.uz` and the other bots on this machine. Nothing is exposed inbound:
cloudflared holds an outbound connection to Cloudflare, so there is no port to
forward, no origin certificate to manage, and no listening socket to scan.

---

## 1. Create the tunnel

Once, from this directory. Both commands need a browser and your Cloudflare account.

```sh
# Authorizes cloudflared for the qitmir.uz zone and writes cert.pem.
cloudflared tunnel login

# Creates the tunnel and writes <tunnel-id>.json. Note the id it prints.
cloudflared tunnel create --credentials-file docker/cloudflared/headhunter.json headhunter

# Points hh.qitmir.uz at it - creates the CNAME in Cloudflare DNS.
cloudflared tunnel route dns headhunter hh.qitmir.uz
```

Then put the id into [`docker/cloudflared/config.yml`](../docker/cloudflared/config.yml),
in both `tunnel:` and `credentials-file:`, and move `cert.pem` into
`docker/cloudflared/` beside the JSON.

**Both files are gitignored, and must stay that way.** The JSON is a bearer
credential for the tunnel; `cert.pem` is account-level for the entire zone. Anyone
holding either can serve traffic as `hh.qitmir.uz`.

## 2. Bring it up

```sh
pnpm db:up          # Postgres
pnpm start:dev      # the API, on host port 3001
pnpm tunnel:up      # cloudflared
pnpm tunnel:logs    # watch it register
```

The tunnel's origin is `http://host.docker.internal:3001`, so it reaches the API
running on the host under `pnpm start:dev`. When the API is containerised (still on
the TODO — there is no Dockerfile yet), change the ingress to the service name and
put both on the same compose network.

Check it end to end:

```sh
curl https://hh.qitmir.uz/health
curl -H 'x-lang: ru' https://hh.qitmir.uz/dictionaries/region
```

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

## 4. Before this carries real users

Not blockers for a staging URL; each is a real gap for production.

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
| `curl https://hh.qitmir.uz/health` returns a Cloudflare 502/1033 | The tunnel is up but the origin is not. Is `pnpm start:dev` running on 3001? |
| Cloudflare 1016 / DNS error | `cloudflared tunnel route dns` was not run, or the CNAME was removed |
| Everything rate-limited at once | `CLIENT_IP_HEADER` is unset — every caller is sharing the loopback bucket |
| Boot refuses to start | Joi rejected a variable; the message names it and says why |
| Telegram login fails, nothing in our logs | The redirect URI is not registered in BotFather. It fails on the client, before reaching us |
