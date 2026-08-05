# SMS delivery — Eskiz.uz

**Status: not bought, not integrated.** Login codes are issued and stored but
delivered nowhere; `OTP_STATIC_CODE` stands in (README "Login"). This file exists so
that connecting the provider is a morning's work rather than a research task, and so
the two questions that can *change the OTP text* are asked before money changes hands.

Client direction 2026-08-05: the provider is **Eskiz.uz**, vendor reference
<https://documenter.getpostman.com/view/663428/RzfmES4z?version=latest>.

> The vendor page is a JavaScript-rendered Postman collection, so the shapes below were
> read from Eskiz's generated OpenAPI client
> ([iota-uz/eskiz](https://github.com/iota-uz/eskiz)) and community clients, **not from
> the vendor document itself**. Treat every field name as *to be confirmed against the
> account dashboard on purchase*. Endpoints and paths are reliable; body field spelling
> is the part worth re-checking.

## Shape of the API

Base URL `https://notify.eskiz.uz`. Bearer token, obtained by posting credentials —
there is no API key.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | email + password → token |
| PATCH | `/api/auth/refresh` | extend the token |
| POST | `/api/message/sms/send` | send one message |
| GET | `/api/message/sms/status_by_id/{id}` | delivery status |
| GET | `/api/user/templates` | the approved template list |

Send fields, as community clients use them: `mobile_phone`, `message`, `from`
(the originator, typically the short code `4546`), `callback_url`.

## The two facts that constrain us

**1. Message text is approved, not free-form.** Eskiz operates an approved-template
model, and a fresh account is in **test mode where only three exact strings are
accepted** — `Bu Eskiz dan test`, `Это тест от Eskiz`, `This is test from Eskiz`.
Anything else is refused until a template is approved.

*Consequence for this product:* the OTP message is not ours to write on the day we
integrate. It has to be submitted for approval, and §3.2 says user-facing text exists
in four interface variants — so the approval request is for **four** templates (or one
Russian/Uzbek text accepted for all users, which is a client decision, not ours).
Submit them the day the account is bought; approval is the long pole, not the code.

**2. The token is a login, not a secret we are given.** It is obtained with the account
email and password and has to be refreshed. So `ESKIZ_EMAIL` / `ESKIZ_PASSWORD` are
boot-validated env vars, the token is held in memory, and a 401 means re-login rather
than fail — a token that expired mid-flight must not turn into a user-visible login
failure.

## How it plugs in

`OtpService.send` already issues, hashes, stores and supersedes the code inside one
transaction. Delivery is the one thing it does not do, and it is additive:

- **A sender interface with two implementations** — `EskizSmsSender` and a
  `LoggingSmsSender` that records "would have sent" and nothing else. The no-op is what
  keeps `pnpm test` and `pnpm test:int` database-only and offline; it is also the
  correct behaviour for a dev machine.
- **Send after the transaction commits, never inside it.** This is the trap MEMORY.md
  already records in another form: an HTTP call inside a transaction holds a row lock
  for the provider's latency, and a provider timeout would roll back the code that was
  already sent. Issue, commit, then hand the code to the sender.
- **A send failure is a 502-class error, not a silent success.** The user is staring at
  a code entry screen; "sent" when nothing was sent is the worst available outcome. It
  needs its own `messages.ts` key in four variants.
- **Never log the code or the full number.** `maskPhone` already exists and the OTP
  logging rule is in CLAUDE.md; a provider client is the easiest place to leak both.
- **`OTP_STATIC_CODE` is removed by clearing it**, not by editing code. It substitutes
  at code generation only, so a real sender inherits every behaviour the fixed code was
  tested with.

## Ask on purchase

1. Which originator (`from`) is on the account — the shared `4546` or a branded sender?
2. Exact template approval process and turnaround, and whether one template can carry
   all four interface variants or needs four.
3. Is there a per-minute or per-day send cap? Our own per-phone limit is
   `RATE_LIMIT_OTP_PER_PHONE=5/hour`, which should sit under theirs, not above.
4. Delivery callback: does `callback_url` need to be registered in the dashboard, and
   does it require a public HTTPS endpoint? (We have one — `hh.qitmir.uz` — but it is a
   dev tunnel, and an inbound webhook is a new public route with its own auth problem.)
5. Test-mode credentials for CI, separate from the production account.
