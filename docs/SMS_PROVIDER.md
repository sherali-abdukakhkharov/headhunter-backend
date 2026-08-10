# SMS delivery — Eskiz.uz

**Status: built, not bought.** The integration is written and tested; there is no
account. Set `ESKIZ_EMAIL` and `ESKIZ_PASSWORD` and codes go out - that is the whole
connection, and nothing in the codebase changes.

Until then the login path is unchanged: codes are issued and stored, `OTP_STATIC_CODE`
fixes them and `OTP_ECHO_IN_RESPONSE` returns them, and the logging sender reports
`failed` rather than pretending anything was delivered.

**Nothing here has been run against a real Eskiz account**, because there is not one.
The field spellings below are the part to re-check on purchase; everything else is
exercised by `src/modules/auth/sms/sms.spec.ts` against a stubbed `fetch`.

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

## How it is plugged in

`src/modules/auth/sms/`, the same seam shape as push:

| File | What it is |
|---|---|
| `sms-sender.ts` | The abstraction. Knows nothing about OTPs - it takes rendered text |
| `eskiz-sms.sender.ts` | The provider client: token login, one retry on 401, error classification |
| `logging-sms.sender.ts` | What runs with no account. Reports `failed`, never `sent` |

`AuthModule` picks between them at boot from `ESKIZ_EMAIL`, and warns when it picks the
logging one - so a deployment that was *supposed* to send announces the omission.

Five decisions are worth knowing before changing any of it.

- **Issue and deliver are separate methods.** An HTTP call inside the issuing
  transaction would hold the row lock for the provider's latency, and a provider
  timeout would roll back the code it had already sent. `issue` commits; `deliver`
  runs after.
- **A failed send deletes the code it was for.** Not only because a code nobody
  received should not occupy the one-live-code slot: the resend delay is measured from
  the most recent row *whatever its state*, so leaving it would lock the user out of
  retrying for a minute over a message that never arrived. That one is easy to miss and
  has its own integration test.
- **A send failure is a 502**, never a silent success - `auth.otp_send_failed`, in four
  variants. The user is staring at a code-entry screen.
- **"No provider configured" is not a failure.** The logging sender's
  `sms_not_configured` is the one result `deliver` treats as success, because deleting
  the code there would break every development and test login.
- **The message text lives in `messages.ts`** with everything else a user reads, in four
  variants, and is asserted to fit one Cyrillic SMS segment (70 characters) - two
  segments is twice the price for every login on the platform.

Neither the code nor the full number is ever logged; `maskPhone` is used throughout.

## Connecting it, on the day the account exists

1. Set `ESKIZ_EMAIL` and `ESKIZ_PASSWORD` in `.env`, then `pnpm api:up`.
2. Check the boot log: the warning about `ESKIZ_EMAIL` should be gone.
3. Send yourself a code. In test mode Eskiz accepts only its three fixed strings, so
   expect `sms_template_not_approved` until a template is approved - the client
   classifies that refusal specifically, because the fix is not in this codebase.
4. Submit the four `sms.otp_code` variants for approval (or one, if the client decides
   a single Russian/Uzbek text serves everyone).
5. Once codes arrive: clear `OTP_STATIC_CODE` and `OTP_ECHO_IN_RESPONSE`. Production
   boot already refuses both, so this is staging hygiene.
6. Confirm `ESKIZ_FROM` matches the originator on the account.
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
