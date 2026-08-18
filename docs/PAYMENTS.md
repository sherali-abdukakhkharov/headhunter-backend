# Coin top-up — Payme and CLICK

**Status: built, not bought.** The whole flow is written and tested; there are no merchant
accounts. Set one provider's credentials and employers can buy Coins — that is the entire
connection, and nothing in the codebase changes.

Until then the wallet works exactly as it does with a provider: employers get BR-15's ten
free Coins, unlocks debit them, and `GET /payments/providers` answers with an **empty list**,
which is what the client renders the top-up screen from. Both adapters refuse every callback
they receive, because verifying a Payme request needs the merchant key and verifying a CLICK
request needs the secret — with no credential there is no code path that returns a verified
command. Third time this house pattern has been used, after `SmsSender` and `PushSender`, and
the rule is the same: **the unconfigured implementation reports failure, never a success**.

**Nothing here has been run against a real merchant account**, because there is not one. What
*has* been exercised is every shape below, against real signatures: 29 unit tests over the two
wire formats in `src/modules/payments/providers/payment-providers.spec.ts`, and 32 integration
tests over the state machine in `src/modules/payments/payments.int.spec.ts` — including the
same callback delivered twice, and twice concurrently.

§12.6 requires provider-test-environment testing **before production credentials are
activated**, so sandbox first is the client's constraint as much as ours.

---

## What to ask for when the accounts are bought

Both providers, if both are wanted. One is enough to ship.

### Payme

| What | Environment variable | Notes |
|---|---|---|
| Merchant / cash-box id | `PAYME_MERCHANT_ID` | Public. Appears in the checkout URL. |
| Merchant key | `PAYME_MERCHANT_KEY` | **Secret.** The password half of the Basic credential Payme authenticates its callbacks with; the username is the fixed string `Paycom`. |
| Account field name | `PAYME_ACCOUNT_FIELD` | Configured **on Payme's side** when the cash-box is created. Default `order_id`. |
| Checkout base URL | `PAYME_CHECKOUT_URL` | `https://checkout.paycom.uz` for production; the sandbox has its own. |

**Register the callback URL as `https://<host>/payments/callbacks/payme`.** All six methods
§12.6 names arrive there.

### CLICK

| What | Environment variable | Notes |
|---|---|---|
| Service id | `CLICK_SERVICE_ID` | Public. Identifies the service being paid for. |
| Merchant id | `CLICK_MERCHANT_ID` | Public. |
| Secret key | `CLICK_SECRET_KEY` | **Secret.** What the `Prepare` and `Complete` signatures are computed with. |
| Merchant user id | `CLICK_MERCHANT_USER_ID` | Only needed for CLICK's outbound API, which this milestone does not call. Carried so connecting it stays one edit. |

**Register the same URL, `https://<host>/payments/callbacks/click`, for both `Prepare` and
`Complete`** — the adapter tells them apart by CLICK's own `action` field.

### The host is the problem, not the credentials

Both providers need a **public HTTPS callback URL**. Today that is `hh.qitmir.uz`, a
Cloudflare tunnel on a developer machine ([DEPLOYMENT.md](DEPLOYMENT.md)). It resolves and it
has a valid certificate, so a sandbox can reach it — but it is not somewhere a production
merchant account should point, because when the machine is off, a `PerformTransaction` gets
no answer. Registering a URL and then changing it is a support ticket with the provider.

---

## Three questions that need an answer from somebody other than an engineer

### 1. Fiscal receipt attributes (§6.7) — blocking a receipt, not the payment

§6.7 assigns the service/product code, VAT and related merchant configuration to "the
Client/accounting function". Nobody here can guess an IKPU (ИКПУ/MXIK) class for prepaid
access to in-app functionality, and guessing wrong is a tax problem rather than a bug.

Declared as data in
[`src/modules/payments/payment-fiscal.ts`](../src/modules/payments/payment-fiscal.ts) with a
`provenance` tag, the same way the employer evidence rules, the BR-12 justifications and the
retention periods were. **While `provenance` is `unknown`, no receipt is sent to either
provider** — the field is simply absent from Payme's `CheckPerformTransaction` response, and a
unit test asserts that. Payments work; they are just not accompanied by a fiscal receipt.

Ask for: the IKPU/MXIK product code, a package code if the classifier needs one, the VAT
percent, and the unit of measure. Then one edit to that file, and `provenance: 'client'`.

### 2. What happens when a refund arrives after the Coins were spent

A provider can cancel a transaction it already performed. The Coins are taken back with a
`reversal` ledger row — but the employer may have spent them on Candidate Unlocks, and BR-16
makes an unlock permanent.

The code recovers `min(balance, coins)` and records the shortfall in the ledger row's reason,
because the alternative is a negative balance, which the database refuses — and a refused
transaction would leave the order stuck at `paid` while the provider believed it was refunded.
That is an engineering decision made to keep the data honest. **Who absorbs the difference is
a commercial one**, and it has not been made. `payments.int.spec.ts` has the case
("recovers only what is left when the Coins were already spent").

### 3. §12.7: which payment channel ships per storefront

Coins unlock digital functionality inside the app, so Apple and Google may require their own
billing rather than Payme or CLICK. §12.7 says the team "shall verify store billing rules
immediately before release", which is a date-sensitive check nobody can do early.

What it costs if the answer is "store billing": one more adapter behind `PaymentProvider`, one
`ALTER TYPE payment_provider ADD VALUE`, and **nothing else**. `wallet_transactions` has no
provider column at all and Candidate Unlock never reads one, which is what §12.7 means by the
ledger staying provider-agnostic. The presentation is already configurable — the client reads
`GET /payments/providers` rather than hard-coding buttons.

---

## Shape of the two integrations

Both are **inbound**. Payme's Merchant API calls this API; CLICK's Shop API calls this API;
checkout is a URL the app opens. **There is no outbound HTTP in this milestone at all** — no
HTTP client, no timeout policy, no retry policy. The provider retries, and BR-19 is what makes
that safe.

### Payme Merchant API — six methods, all inbound

`POST /payments/callbacks/payme`, JSON-RPC 2.0, authenticated with
`Authorization: Basic base64("Paycom:<merchant key>")`. **Amounts are in tiyin** (1/100 soum).

| Method | What it means here | Effect on the order |
|---|---|---|
| `CheckPerformTransaction` | May this order be paid at this amount? | none |
| `CreateTransaction` | A transaction is open against the order | `created → pending` |
| `PerformTransaction` | The money arrived | `pending → paid`, **and the Coins are credited** |
| `CancelTransaction` | Cancelled or refunded | `pending → cancelled`, or `paid → reversed` |
| `CheckTransaction` | Status poll | none |
| `GetStatement` | Reconciliation over a date range | none |

Errors are answered as `{"error": {"code": …}}` with **HTTP 200**, because an HTTP error makes
Payme retry a request that has already been decided. Codes used: `-31001` wrong amount,
`-31003` transaction not found, `-31007` already cancelled, `-31008` cannot perform, `-31050`
order not found, `-32504` authentication failed.

### CLICK Shop API — two callbacks

`POST /payments/callbacks/click`, form-encoded, authenticated by an MD5 `sign_string` over a
fixed field order with the secret in the middle. **The signed field list differs between the
two actions**: `Complete` includes `merchant_prepare_id` and `Prepare` does not.

| `action` | Method | Effect on the order |
|---|---|---|
| `0` | `Prepare` | `created → pending` |
| `1` | `Complete` | `pending → paid`, **and the Coins are credited** |

A callback carrying a negative `error` is CLICK reporting its own failure, and it maps to a
cancellation rather than a completion — so the credit path is never entered at all (BR-20).

`merchant_prepare_id` is a value this API chooses and CLICK echoes. It is derived from the
order id rather than stored, so there is no extra column and nothing to look up on
completion — and because the signature covers it, a `Complete` naming a different one fails
verification instead of being quietly accepted.

---

## Why crediting can only happen once (BR-19)

Four things, in four different places, each catching what the others cannot. UAT-22 delivers
the same successful callback twice; a second test delivers it twice **concurrently**.

1. `SELECT … FOR UPDATE` on the order, so two simultaneous callbacks queue rather than
   interleave. The second reads what the first committed.
2. A conditional `UPDATE … WHERE status = 'pending'`. The loser of a race updates no rows and
   takes the already-paid branch.
3. `wallet_transactions_one_credit_per_reference_idx` — one `top_up` ledger row per order id.
   M12 created it before there was anything to write into it, precisely so that no row could
   ever have been written without it.
4. `payment_orders_provider_transaction_idx` — one provider transaction belongs to exactly one
   order, so a callback cannot be replayed against a different one.

A duplicate `PerformTransaction` is answered as a **success** with no second credit. Telling a
provider otherwise makes it retry forever.

## What is stored, and what deliberately is not

`payment_orders` holds the internal order id, employer, provider, Coin count, the price the
order was quoted at, the UZS amount, status, provider transaction id and timestamps — §6.7's
list. `payment_events` is the reconciliation trail: every callback and poll, with its
verification result and any transition. It is **append-only in the database**, with the same
three statement-level triggers the wallet ledger and the audit log use.

Two things are on purpose:

- **`payment_events.order_id` is nullable.** A callback whose signature fails, or that names an
  order that does not exist, still gets a row. Those are the events an incident review most
  wants, and they have no order to attach to.
- **No raw provider payload is stored.** §12.6 says to log only non-sensitive identifiers, so
  each adapter hands over the fields this system understands and nothing else is kept.
  Maintaining a redaction denylist forever is worse than not holding the data.

Card data never reaches this API in any form (BR-22): payment happens on the provider's own
checkout, and the app opens a URL.

## What a purge does to a payment record

Nothing, and that is deliberate. §6.7 requires payment records for reconciliation and BR-24
forbids rewriting the ledger, so `employer_wallets.user_id` is `ON DELETE RESTRICT` and
`payment_orders` points at the wallet the same way. BR-14's erasure duty is met as it is for
administrators: **the person is anonymized and the record stays**, attached to an id nobody can
resolve. See [RETENTION.md](RETENTION.md).

## Going live, in order

1. Buy one or both merchant accounts; get the sandbox credentials first.
2. Point the merchant configuration at a **stable** public HTTPS host, not the dev tunnel.
3. Set the environment variables and restart. `GET /payments/providers` now lists the provider,
   and the boot log says which are configured.
4. Run the provider's own sandbox suite — §12.6 requires repeated `Create`/`Perform`/`Cancel`
   requests and invalid amount/account cases. All of those already have tests here; what the
   sandbox adds is *their* client against *our* endpoint.
5. Supply the fiscal attributes and flip `provenance` to `client`.
6. Verify the storefront billing rules (§12.7) immediately before release.
7. Activate production credentials.
