# Data retention and deletion (BR-14)

BR-14 says deletion and retention "follow the approved privacy policy and applicable legal
requirements". **There is no approved privacy policy yet**, and that has blocked the purge
since M1. This is how the block was removed without pretending the question is answered.

## The short version, for the client

Every retention period is now **declared in one place**
(`src/infra/retention/retention-policy.ts`) and returned by `GET /admin/retention/policy`.
Each rule carries a `provenance` tag:

| Tag | Meaning |
|---|---|
| `provisional` | An engineer chose this number. **No lawyer has seen it.** |
| `required` | Fixed by another rule in the specification, not by preference |
| `client_approved` | Confirmed against the approved privacy policy |

**Nothing is currently `client_approved`.** What we need from you is a review of the table
below; the answer is an edit to one file, not a change to the product.

| What | We assume | Why not shorter |
|---|---|---|
| Grace period after a deletion request | **30 days** | A request made in anger, or from a stolen phone, has to be reversible |
| Personal data after that | **erased** | This is the erasure BR-14 is about |
| An administrator's own account | **identity erased, id kept** | §10.4 requires an immutable audit log; see below |
| Administrator decisions | **kept indefinitely** | An accountability record with an expiry date protects the wrong party |
| One-time codes | 1 day | Dead within minutes; kept for a disputed login |
| Sessions | 90 days | Must outlive its refresh token so reuse detection still works (§4.2) |
| Rate-limit counters | 2 days | An IP address is personal data; a closed window is never read again |
| Idempotency keys | 7 days | A retry a week later is a new intent, not a duplicate |
| In-app notifications | 180 days | Longer than any hiring cycle they describe |

## The one rule that is not a preference

An account that has **acted as an administrator** cannot be deleted, and the constraint is
deliberate: `admin_audit_log.actor_user_id` is `ON DELETE RESTRICT`, because an audit row
that forgot who acted is not an audit row (§10.4). A cascade would have resolved this by
quietly destroying the trail.

The two duties are reconciled by **erasing the person and keeping the actor**:

- The phone number, Telegram identity, name and login history are cleared.
- The row and its id survive, so every past decision still resolves to a *distinct*
  administrator without naming one.
- The account's own data - profile, employer record, sessions, roles, devices - goes with
  everybody else's.
- `purged_at` records when, and two constraints make the two ways this can go wrong
  unwritable rather than merely unwritten: `users_purged_has_no_credential` for "purged but
  still holding a phone number", and `users_purged_has_no_name` for "anonymized but still
  named". They are separate checks because reachability and identity fail differently.
  `users.full_name` is the column the second one guards, and it exists only for the seeded
  administrators - everybody else's name lives on a profile that is deleted outright.

This is the only rule in the table tagged `required`. It is not open to a shorter period,
because the alternative is losing the record of who approved what.

## Running it

There is **no scheduler**, on purpose. While the periods are provisional, an administrator
looks at what is due before anything is erased, and every erasure is audited.

```
GET  /admin/retention/policy   what the platform believes its rules are
GET  /admin/retention/due      what a purge would remove, right now
POST /admin/retention/purge    do it - irreversible
```

`due` reports, per account, whether it would be deleted or anonymized, and how many audit
rows, wallet ledger rows and Payment Orders depend on its id. `purge` works **one account per
transaction**: an account that cannot be purged is reported in `failed` rather than rolling
back the others.

The only recovery from a purge is a restore from [BACKUP.md](BACKUP.md).

## Money outlives the account, and that decides `anonymize` too

M12 and M13 added a second reason an account cannot be deleted, alongside §10.4's audit log.
§6.7 requires payment records "for support and reconciliation" and BR-24 forbids rewriting the
ledger, so `employer_wallets.user_id` is `ON DELETE RESTRICT` — as is
`wallet_transactions.actor_user_id`, which is what keeps §10.5's "who adjusted this balance"
answerable. `payment_orders` points at the wallet the same way.

So **an employer who has ever held a Coin is anonymized, never deleted**: phone, Telegram
identity and login history are cleared, the id stays, and the balance remains attached to an id
nobody can resolve to a person. Exactly the arrangement administrators already get.

**One subtlety, and it was a real defect:** the decision is made on *holding a wallet*, not on
how many ledger rows are in it. Those are different questions — a wallet with an empty ledger
still refuses the delete — and they only look the same because the default configuration grants
a registration bonus, so every wallet has a row. Set `EMPLOYER_REGISTRATION_BONUS_COINS=0`,
which the environment schema deliberately permits as a pricing decision, and an account would
have been classified `purge` and then failed at the constraint. `retention.int.spec.ts` pins
the empty-wallet case.

## What the implementation had to work around

**A plain `DELETE FROM users` fails.** Sixteen foreign keys cascade from `users`, but three
tables hold `ON DELETE RESTRICT` references to `stored_files` - a company logo, a
verification submission's evidence, and a message attachment - and the cascade reaches the
files before those rows release them:

```
ERROR:  update or delete on table "stored_files" violates RESTRICT setting of foreign key
        constraint "companies_logo_file_id_fkey" on table "companies"
```

So the purge clears those three references in an explicit order first. This was found by
trying it against a real database, not by reading the schema, and
`retention.int.spec.ts` builds exactly that entangled shape so it cannot regress.

## What this does not do yet

- **The file bytes stay in Telegram.** The purge deletes the metadata rows that point at
  them; the bytes live in a private Telegram channel (ARCHITECTURE.md §9) and the Bot API
  offers no deletion this could rely on. After a purge nothing in this system can find or
  serve them - every download route resolves through the metadata that is now gone - but
  "unreachable" is not "erased", and a privacy policy that promises erasure has to
  reckon with that. Emptying that channel is an operational step somebody has to own.
- **Backups still contain purged accounts.** A dump taken before the purge holds the data
  it removed, for as long as the 14-day retention in [BACKUP.md](BACKUP.md). That is
  normal and defensible, but it should be stated in the privacy policy rather than
  discovered.
- **No user-facing export.** BR-14 is about deletion; a data-portability request would
  currently be answered by hand.
