# Test accounts

Ten seeded accounts a tester can sign in as, with a fixed code instead of an SMS.

They are created by `pnpm seed:demo` in `headhunter-backend` and removed by
`pnpm seed:demo:clean`. Everything about them is invented: the people, the
companies, the CVs, the photographs.

## Signing in

1. Open JobBridge and go to the phone screen.
2. Type the **nine digits** from the table. The field already shows `+998`.
3. Enter the six-digit code. It never changes and no SMS is sent.

The code behaves like any other: it expires after five minutes, five wrong
attempts lock it, and you request a new one the normal way. Requesting a new one
gives you the same digits back.

## The accounts

| Type this | Code | Role | Who |
|---|---|---|---|
| `011000001` | `111111` | Candidate | Aziza Karimova — Backend Developer |
| `011000002` | `111112` | Candidate | Jasur Toshmatov — Accountant |
| `011000003` | `111113` | Candidate | Nilufar Ergasheva — Barista |
| `011000004` | `111114` | Candidate | Bekzod Rahimov — Welder |
| `011000005` | `111115` | Candidate | Sardor Yo‘ldoshev — Tractor Driver |
| `011000006` | `111116` | Candidate | Malika Usmonova — Shift worker |
| `012000001` | `222221` | Employer | Uzum Technologies — Dilshod Nazarov |
| `012000002` | `222222` | Employer | Silk Road Logistics — Kamola Yusupova |
| `012000003` | `222223` | Employer | Otabek Sattorov (individual) |
| `019000001` | `999999` | Admin | Shahzod Alimov |

The second digit says what you are logging into: `1` a candidate, `2` an
employer, `9` the administrator.

## What each one is for

### Candidates

| Account | What to look at |
|---|---|
| **Aziza Karimova** `011000001` | The complete professional profile — 91 %, searchable, CV and photo uploaded, five skills, three languages, two jobs. She is at the **interview** stage on Uzum Technologies and has an open conversation with them. Uzbek Latin. |
| **Jasur Toshmatov** `011000002` | A second professional, **in Russian** and outside Tashkent (Samarkand). Use him for the Russian interface and for region filters. He has an **unanswered invitation**. |
| **Nilufar Ergasheva** `011000003` | Service and trade, **in Uzbek Cyrillic**. She has been **hired**, so her application history ends in a terminal stage. Photo, no CV. |
| **Bekzod Rahimov** `011000004` | Physical and industrial: licences, transport, tools and crew size — fields no other category shows. His application was **rejected**, with a reason. |
| **Sardor Yo‘ldoshev** `011000005` | Seasonal and agricultural, where the form asks for dates and readiness. One application still at the first stage, nobody has opened it. |
| **Malika Usmonova** `011000006` | **Deliberately unfinished**: 48 % complete and hidden from search. This is the account for the completeness card, the BR-02 gate and the empty states. She must **not** appear in an employer's candidate search — if she does, that is a finding. |

### Employers

| Account | What to look at |
|---|---|
| **Uzum Technologies** `012000001` | The main employer. Verified, has a logo, a Coin balance with the registration bonus and one spend, and three vacancies: one **active**, one **paused**, one **waiting for moderation**. Four applications across four stages. It has **unlocked Aziza**, so her phone and CV are visible on that one candidate and not on the others. |
| **Silk Road Logistics** `012000002` | **Waiting for verification**, documents already submitted. Use it to check what an unverified employer cannot do — it cannot publish a vacancy or invite anybody — and to give the administrator something in the queue. In Russian. |
| **Otabek Sattorov** `012000003` | An **individual**, not a company: a different profile form and different required evidence. Verified, one active seasonal vacancy with two applicants, one of them hired. |

### Administrator

`019000001` — the queues are deliberately not empty:

- **1 vacancy** waiting for moderation (Uzum's *Data Analyst*)
- **1 employer** waiting for verification (Silk Road Logistics)
- **1 complaint** waiting for review (about the harvest vacancy's pay)

Acting on any of them is a normal test. Note that the audit log is append-only
by design, so anything you approve or reject stays recorded.

## What is not real

- **The photographs are generated monograms**, not faces — initials on a
  coloured ground, which is what the product shows for a candidate with no
  photo anyway. A photograph of a person who does not exist is the one thing
  that would be actively misleading in a screenshot.
- **The CVs and the registration certificates are generated PDFs.** They open,
  they are readable, and each says what the profile it belongs to says. Every
  one is stamped as demo data. The registration certificate certifies nothing.
- **The phone numbers cannot exist.** After the country code, Uzbekistan's
  numbering plan has no destination code starting with `0` — `0` is the trunk
  prefix for dialling inside the country. So nobody can be issued one of these
  numbers, and nobody can register with one by accident.
- **Top-up still says it is unavailable.** That is the correct answer, not a
  defect: §6.7 needs Payme and CLICK test credentials that the client has not
  supplied. Please do not file it again.

## Resetting

```powershell
pnpm seed:demo:clean
pnpm seed:demo
```

Re-seeding without cleaning first is **refused**, because it would sign in to
the existing accounts and write a second set of vacancies and applications on
top of them rather than replacing them.

The clean-up deletes most accounts outright and **anonymises the rest**. Two
tables in this product are append-only on purpose — the administrator's audit
log (§10.4) and the Coin ledger — and an account that has written to either
cannot be deleted without erasing what it did. Those accounts lose their phone
number, name, roles and profile instead, which leaves nothing to sign into.
This is exactly what happens when a real user deletes their account.

Uploaded documents stay in the Telegram storage chat: a bot may only delete its
own messages for 48 hours.

## Turning it off

One value in the backend environment:

```
DEMO_ACCOUNTS_ENABLED=false
```

That stops the fixed codes being accepted without touching the data, for a
live demo. It is **not** `OTP_STATIC_CODE`, which fixes the code for every
account on the instance and is refused in production for that reason; this one
can only ever reach a number in the reserved range, which is why it is allowed
in production, where the testing actually happens.

Deleting the data removes the capability too — with no `demo_accounts` rows
there is no fixed code to resolve, and the reserved range is refused outright.
