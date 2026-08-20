# Security review

§12.5's requirements, each with what was verified, how, and what is outstanding. Reviewed
2026-08-07 against the M11 code.

The general principle this codebase follows: **where a rule can be enforced by the
database or asserted by a test over the whole surface, it is** — a rule that lives only in
a service is true of today's code rather than of the system.

---

## TLS for all network communication

**Held, outside the application.** The API listens on plain HTTP inside the Docker network
and is published only through the Cloudflare tunnel, which terminates TLS at the edge. The
container publishes no host port, so there is no way to reach it unencrypted from outside
the machine. See [DEPLOYMENT.md](DEPLOYMENT.md).

*Note for a future deployment:* if the API is ever exposed without the tunnel, TLS becomes
this project's problem and `TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER` must be revisited
together — see below.

## Server-side role and permission enforcement for every protected API

**Held, and asserted as a whole** by `src/infra/api/api-surface.spec.ts`, which reads
Nest's own routing metadata off every controller and checks three things:

- The set of `@Public()` routes is **exactly** a frozen list of eleven. A new public route
  fails the suite until somebody adds it there with a reason, which forces the decision
  into review rather than into production.
- Every `/admin/*` route requires the `admin` role. That role is the only thing between
  §10's routes and any authenticated user.
- No route is both public and role-restricted, which would be a contradiction.

The list of controllers the suite audits is itself checked against `app.module.ts`, so a
whole module cannot escape the audit by being forgotten.

Beneath that, four guards run globally in order — rate limit → authenticated → role →
account status (BR-10) — so protection is the default and every exception is visible at the
handler.

**Ownership is per resource and checked in the service**, not by a guard: "this application
belongs to a vacancy of yours" is not expressible as a role. Those checks answer `404`
rather than `403` throughout, because confirming that an id exists elsewhere is information
we do not owe (§11.1).

## Rate limiting for OTP, authentication, search, messaging, and file operations

**Held.** All five buckets exist as of M11, with independent per-deployment budgets:

| Bucket | Keyed by | Default |
|---|---|---|
| `otp` | phone **and** IP | 5 / 30 per hour |
| `auth` | phone **and** IP | 20 / 120 |
| `search` | IP | 240 |
| `messaging` | IP | 600 |
| `files` | IP | 120 |

Counters live in Postgres (`rate_limit_counters`) as a fixed window, decided in **one
upsert** — a read-compare-write would let two concurrent requests both read the same count
and both be allowed, which is precisely the burst a limiter exists to stop. The window
boundary uses the database clock, so replicas cannot disagree about which window a request
falls in. Phone subjects are stored hashed. Every `429` carries `Retry-After`.

**Per-IP limits depend on `CLIENT_IP_HEADER`**, not on `X-Forwarded-For`: behind Cloudflare
the user is *first* in that header and the edge second, the opposite of what Express's hop
count reads. The header is only trusted when named in configuration, so an instance with
nothing in front cannot have its limits bypassed by a spoofed header.

## Secure storage of secrets; no secrets in the mobile application

**Held.** Every secret is an environment variable validated at boot (`infra/env-schema.ts`)
and never read ad hoc. `.env` is gitignored; `.env.example` carries placeholders only.

No endpoint returns a secret. The two credentials that could plausibly leak into a client
are structurally prevented from doing so:

- **The Telegram bot token** is in every storage URL, which is exactly why no storage URL
  ever reaches a client — file bytes are proxied (ARCHITECTURE.md §9).
- **The FCM service account** is used server-side only; the client's `google-services.json`
  is a different, non-secret artifact.

Two variables are refused outright when `NODE_ENV=production`: `OTP_STATIC_CODE` (a master
key to every account) and `OTP_ECHO_IN_RESPONSE`.

**Log hygiene:** pino redacts `authorization` and `cookie` headers; bodies are not logged.
Phone numbers pass through `maskPhone` at the one place they are logged, and OTP codes and
tokens are never logged at all — only hashes are stored.

*Closed 2026-08-20:* `API_DOCS_ENABLED=false` on the deployed instance, so `/docs`,
`/reference` **and `/docs-json`** all answer 404 — verified. The default in the schema stays
`true`, because a developer running this locally should get the documentation without
configuring anything; a deployment is where the decision belongs.

It was on until then because the mobile developers read `/docs-json` directly. They now read
`docs/openapi.json` from the repository, which is the same document from the same builder
(`buildOpenApiDocument`, shared with `pnpm docs:openapi`) — so what they read cannot drift
from what the server serves, which was the reason the two were never allowed to diverge.

The alternative considered and not taken was a Cloudflare Access policy in front of the two
paths. Turning the flag off is stronger: an access policy protects a route that still exists,
and this one no longer does.

## File-type and size validation, malware scanning where possible, protected download URLs

**Held, with one honest gap.** Validation is content-based: extension, declared MIME type
and magic bytes must agree, which is what stops a renamed executable being accepted as a
CV. `application/octet-stream` is tolerated because mobile pickers send it. Size is capped
at 10 MB, validated at boot against the 20 MB ceiling `getFile` imposes — above that a file
would store successfully and be permanently unreadable.

**There are no public download URLs anywhere in the product.** Bytes are served by four
entitlement-bearing routes, each of which re-checks the rule that grants access on *every*
request rather than trusting a path the client is holding:

| Route | Who may read, and why |
|---|---|
| `/files/{id}/content` | The owner, and nobody else |
| `/applications/{id}/files/{fileId}/content` | BR-09, through a live application |
| `/invitations/{id}/files/{fileId}/content` | BR-09, through an accepted invitation |
| `/conversations/{id}/messages/{id}/file` | A participant in that conversation |
| `/admin/employers/{id}/evidence/{fileId}` | An administrator, for that employer's own submissions |
| `/candidate-search/candidates/{id}/photo` | A verified employer; **only** the `photo` purpose |

A stored file's SHA-256 is recorded on upload and verified on read: serving an employer a
document that is not the one the candidate uploaded is worse than serving none.

***Malware scanning is not implemented.*** §12.5 asks for it "where infrastructure
permits", and this deployment's infrastructure does not: files live in a Telegram chat,
which performs no scanning on a bot upload, and there is no scanning service in the
deployment. This is a stated gap rather than an oversight. If it matters, the shape is an
ICAP or ClamAV call in `FilesService.upload` before the bytes are sent, which is one
injected dependency.

## Input validation and protection against common API and database attacks

**Held.** The global `ValidationPipe` runs with `whitelist`, `forbidNonWhitelisted` and
`transform`: an unknown field is **rejected**, not silently dropped, so a client cannot
smuggle a property past a DTO. Every body has a DTO; every id parameter goes through
`ParseUUIDPipe`.

**SQL injection:** all data access is through Kysely, which parameterizes. The candidate
search is the one place that hand-writes SQL fragments, and it is covered by two tests in
`search-query.spec.ts` — a hostile string pushed through twelve filters at once appears
only in the bound parameters and never in the SQL text, and the three `sql.raw` call sites
are shown to interpolate only closed-union group codes from a hardcoded table.

**Mass assignment** is prevented by the same whitelist, and by the field-schema write path:
a profile or vacancy write is routed by declared field code, so a body naming a column
directly reaches nothing.

`helmet` sets the standard response headers. CORS is configurable rather than open by
default. Downloads carry `X-Content-Type-Options: nosniff` and `Cache-Control:
private, no-store`.

---

## Summary

| Requirement | State |
|---|---|
| TLS | Held at the tunnel edge |
| Role/permission enforcement | Held, asserted over the whole route surface |
| Rate limiting, five buckets | Held |
| Secret storage, none in the client | Held; `API_DOCS_ENABLED=false` since 2026-08-20 |
| File validation and protected downloads | Held |
| Malware scanning | **Not implemented** — infrastructure does not permit it |
| Input validation, injection, mass assignment | Held, with tests |

**One §12.5 gap remains, and it is the one that cannot be closed here:** malware scanning.
The bytes go to a Telegram chat, and the Bot API does not scan a bot upload, so
`FilesService` does type and size validation and nothing pretends otherwise.

Also worth a reviewer's attention, in the order the login path acquired them on 2026-08-20:
**OTP delivery is real** (Eskiz, codes random, `OTP_ECHO_IN_RESPONSE=false`), and
`NODE_ENV=production` now makes both of the flags that used to weaken it — the echo and
`OTP_STATIC_CODE` — refused at boot rather than merely unset. That moves two access
guarantees from "the `.env` file is correct" to "the process will not start otherwise".

Two things outside §12.5: **BR-14's retention periods are still unanswered** (no approved
privacy policy), and the audit log's actor reference is `RESTRICT`, so an administrator who
has acted cannot be deleted — a collision the retention decision resolved deliberately, by
anonymizing rather than cascading.
