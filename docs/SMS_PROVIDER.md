# SMS delivery — Eskiz.uz

**Status: connected and delivering, since 2026-08-20.** Setting `ESKIZ_EMAIL` and
`ESKIZ_PASSWORD` was the whole connection, and nothing in the codebase changed — which is
what the seam was for.

The first real code, end to end:

| | |
|---|---|
| Sent | 2026-08-20 12:48 Tashkent, `POST /auth/otp/send` on hh.qitmir.uz |
| Eskiz `request_id` | `1341d6dd-ad30-4510-a8fc-b87203df0267` |
| Status | **`DELIVERED`** |
| Originator | `4546` (the shared code — the account has no branded sender) |
| Encoding | `0` (GSM-7), one segment, 66 characters |
| Price | 160 UZS |
| Text | `JobBridge ilovasiga kirish kodi: 666666. Kodni hech kimga bermang.` |

All four templates are approved and carry `status: service` (ids 86345–86348). The billing
prediction the template tests make held exactly: one segment, GSM-7, no UCS-2 surprise.

**`OTP_STATIC_CODE` was cleared the same day**, so codes are now random — verified with
`request_id` `cf3abc09-a0fa-48c7-862d-69a401d54b01`, also `DELIVERED`, carrying a code that
was not `666666`.

**The echo is off too, since 2026-08-20**, and `NODE_ENV=production` is set — so the schema
now *refuses* both that flag and `OTP_STATIC_CODE` at boot rather than trusting an `.env` file
to stay correct. §4.1 is closed and neither hole can be reopened by editing a file; the
container stops instead.

That was the gap worth closing, and it was not delivery. `OTP_ECHO_IN_RESPONSE=true` on a
**public** `POST /auth/otp/send` let any caller post any registered number and read that
account's code out of the response body — no SMS and no credential required. The env schema
says as much in its own comment: *"this flag would hand any caller a login code for any phone
number."*

The cost is the one it was always going to be: a real SMS per login, about 160 UZS. Owner
confirmed on 2026-08-26 that real numbers are signing in through it.

Keep `LOG_PRETTY=false`: the image carries no `pino-pretty`.

Also still unexercised: the field spellings here were confirmed against the live account only
for the endpoints the login path uses, and the delivery-callback shape has never been run.

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

### The four templates to submit

**Contract signed 2026-08-19.** These are the exact strings in `sms.otp_code`, with the
`{code}` placeholder filled in with a real six-digit example — Eskiz's moderation form
requires the text *as the subscriber will receive it*, with no placeholders or masks of our
own. The moderator applies the mask to the variable part.

| Locale | Text | Billed |
|---|---|---|
| `uz-Latn` | `JobBridge ilovasiga kirish kodi: 123456. Kodni hech kimga bermang.` | 66/160, 1 SMS |
| `uz-Cyrl` | `JobBridge иловасига кириш коди: 123456. Кодни ҳеч кимга берманг.` | 64/70, 1 SMS |
| `ru` | `JobBridge: код входа в приложение 123456. Никому не сообщайте.` | 62/70, 1 SMS |
| `en` | `JobBridge app login code: 123456. Do not share it with anyone.` | 62/160, 1 SMS |

Two moderation rules shaped the wording, both from Eskiz's own form:

- **A message carrying a confirmation code must name the resource *and* the purpose.**
  `JobBridge: kirish kodi` names the brand but not what kind of resource it is;
  `JobBridge ilovasiga kirish kodi` names both — the app, and what the code is for.
- **The text is submitted in its final form, not as a template.** A real example code, no
  `{code}` and no `(NAME)`-style masks; the moderator applies the mask themselves.

The product was renamed from *Universal HeadHunter* to **JobBridge** on 2026-08-19, before any
template was submitted. That shortened the brand by eleven characters, which is more than
cosmetic here: Cyrillic is capped at 70, so at the old length the `uz-Cyrl` text had to be
terser than the `uz-Latn` one just to fit one segment, and the same person saw different wording
depending on which script they had selected. Both are now transliterations of each other.

### Write `o'`, never `oʻ`

Billing is per segment, and the segment size depends on the characters:
**160 if every character is in Eskiz's Latin set, and 70 the moment one is not**
([sms-symbols.pdf](https://my.eskiz.uz/assets/data/sms-symbols.pdf), read 2026-08-19). That
set is narrower than GSM 03.38 — Latin letters, digits, space, newline, and
`. , ! ? : ; ' " @ # $ % & ( ) * + - / < = > _`, with `{ } [ ] \ ^` allowed but costing two
slots each.

The correct Uzbek letters `oʻ` and `gʻ` use U+02BB, which is **not** in that set. One of them
anywhere in the message halves the limit and doubles the cost of every login on the platform,
with nothing failing and no log line to show for it. Client direction 2026-08-19: the ASCII
apostrophe is acceptable for these letters, so the Latin text stays on the 160 tariff.

The four texts above happen to need no apostrophe at all, so this is a rule for the *next* edit
rather than something the current wording depends on. It applies only to the SMS body — the app's
own messages in `messages.ts` keep the correct `oʻ`/`gʻ`, because nobody bills us per character
for text rendered on a screen.

The same trap catches `’` (U+2019, which editors substitute for `'` automatically), `—`, `…`,
`№`, `` ` ``, `~`, `|` and any emoji.

**`sms-template.spec.ts` asserts all of this** — one segment per language, no non-Latin
character in the Latin variants, the resource name and purpose present, and that the text
still fits if `OTP_LENGTH` gains a digit. The Cyrillic variants have one to four characters
spare, so that suite is the thing to run before touching their wording.

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

## The credential trap, which cost an outage *(2026-08-20)*

**Eskiz issues two logins, and only one of them works here.** The `my.eskiz.uz` *personal
cabinet* login is not the *SMS gateway* login, and `POST /api/auth/login` refuses the first
one with a `401` whose message says so in as many words:

> «Возможно, Вы вводите логин и пароль от персонального кабинета, необходимо использовать
> логин и пароль только от смс шлюза»

That mistake took login **down**, not merely degraded, and the mechanism is worth
understanding because it will recur with any provider:

1. `ESKIZ_EMAIL` being set is what selects `EskizSmsSender` at boot. It does not have to
   be *correct* to be selected.
2. `OtpService.deliver` deletes the code when a send fails — deliberately, because
   otherwise the resend delay locks a user out over a message that never arrived.
3. `sms_not_configured` is exempt from that deletion; `sms_transport_failed` is not.

So a *configured but broken* provider is strictly worse than no provider: every
`POST /auth/otp/send` issued a code, failed to deliver it, deleted it and answered `502`,
and `OTP_STATIC_CODE` could not help because the row was already gone.

**Verify credentials before deploying them.** A token in the response means the gateway
login; a `401` means the cabinet one:

```bash
curl -s -X POST https://notify.eskiz.uz/api/auth/login \
  -F "email=<gateway-email>" -F "password=<gateway-password>"
```

The trigger was a redeploy rather than an edit: the variables sat in `.env` for hours while
the running container — started before they were added — kept using the logging sender. The
next `pnpm api:up` read them and the outage began, which made it look like an application
change had caused it.

## Connecting it — the runbook, and where this instance stands

0. ✅ **Verify the credentials with the `curl` above first.** See the trap above for why.
1. ✅ Set `ESKIZ_EMAIL` and `ESKIZ_PASSWORD` in `.env`, then `pnpm api:up`.
2. ✅ Check the boot log: the warning about `ESKIZ_EMAIL` should be gone.
3. ✅ Send yourself a code. In test mode Eskiz accepts only its three fixed strings, so
   expect `sms_template_not_approved` until a template is approved - the client
   classifies that refusal specifically, because the fix is not in this codebase.
4. ✅ Submit the four `sms.otp_code` variants for approval. All four are live with
   `status: service`, ids 86345–86348.
5. ✅ **Clear `OTP_STATIC_CODE` and `OTP_ECHO_IN_RESPONSE`.** Both done 2026-08-20, the
   static code first and the echo a little over an hour later. The echo was the half that
   mattered, for the reason at the top of this file.
7. ✅ **Set `NODE_ENV=production`.** Done the same day, once the echo was off — until then
   the image would have refused to boot, which is the schema doing its job. Now neither hole
   can be reopened by an `.env` edit: the guarantee has moved from a file to boot validation,
   which is where this codebase prefers to keep them.
   **This runbook is complete.** It said otherwise for six days after it was, while CLAUDE.md
   said it was done — a contradiction between two files in this repository, resolved on
   2026-08-26 in favour of what the deployment actually does.
6. ✅ Confirm `ESKIZ_FROM` matches the originator on the account. `4546`, the shared code —
   `GET /api/nick/me` returns an empty list, so there is no branded sender to point at.
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
