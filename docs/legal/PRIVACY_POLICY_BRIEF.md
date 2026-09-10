# Brief for the agent drafting the JobBridge privacy policy

*Hand everything below this line to the drafting agent as its prompt. It is
self-contained: the product facts it needs are all here, gathered by the
engineering team from the running system on 2026-09-10. Where a fact is
uncertain it says so, and the agent is told to ask rather than guess.*

---

## Your task

You are drafting the **privacy policy** and the **account-deletion page** for
**JobBridge**, an Android-only recruitment app for Uzbekistan. Both documents
will be published on public web pages and linked from the app's Google Play
listing, and the privacy policy is also what Google Play's *Data safety* form
will be checked against.

Produce, as separate Markdown files:

1. `privacy-policy.uz-Latn.md` — Uzbek in Latin script. **This is the primary
   text**; write it first and translate from it.
2. `privacy-policy.ru.md` — Russian.
3. `privacy-policy.en.md` — English.
4. `account-deletion.uz-Latn.md`, `.ru.md`, `.en.md` — the page Google Play
   requires that explains how a user deletes their account and what happens
   next. Short: one screen.
5. `questions.md` — every point where you needed a fact you did not have, or
   where the facts below raise a legal question. Numbered, each with your
   recommended answer. **Do not resolve these silently in the policy text.**

Write in plain language a job seeker with secondary education can follow. No
boilerplate that could describe any app: every sentence should be true of
*this* app specifically. Use the product name "JobBridge" throughout. Include an
effective-date placeholder and a contact-email placeholder; both will be filled
in by the operator.

The policy must satisfy Google Play's requirements for a privacy policy: it must
name the app, describe what data is collected, how it is used, whether it is
shared and with whom, how long it is kept, how a user can delete it, and how to
contact the operator. It must also be consistent with the *Data safety* answers
listed at the end of this brief.

Uzbekistan's Law "On Personal Data" (ЗРУ-547 of 2 July 2019, as amended in
2021) is the governing law as the engineering team understands it, including
its requirement that personal data of citizens of Uzbekistan be stored on
servers physically located in Uzbekistan. You are not the lawyer of record;
flag every place where that law bears on the facts below, in `questions.md`.

## The parties

- **Operator of the service (proposed):** "ELITE BRIDGE GROUP" MCHJ (LLC),
  Uzbekistan. It commissioned the product and decides what it is for.
  **Confirm with the operator** that it is the data controller named in the
  policy.
- **Publisher on Google Play (for now):** the developer's personal Google Play
  developer account. The app is expected to be transferred to the operator's
  organisation account later. The policy should name the operator, not the
  publisher; note the arrangement in `questions.md`.
- **Users:** three roles in one app, and one person may hold more than one:
  *candidates* (job seekers), *employers* (a company or an individual hiring),
  and *administrators* (the operator's own staff, who verify employers,
  moderate vacancies and review complaints inside the same app).
- Distribution is Uzbekistan-only. There is no web version and no iOS version.

## What the app collects, and why

Every field below is entered by the user or produced by their use of the app.
**The app requests no device permissions except Internet and notifications**:
it does not read location, contacts, call logs, SMS, or the camera roll (photos
and documents come through the system file picker, one file at a time, at the
user's choice).

### Account (every role)

| Data | Why | Notes |
|---|---|---|
| Phone number | The account's identity and the only login credential; verified by a one-time code sent by SMS | E.164, unique per account |
| One-time codes | Login | Stored as a salted hash, never in clear; expire in 5 minutes |
| Interface language | To show the app in the user's language | One of Uzbek (Latin), Uzbek (Cyrillic), Russian, English |
| Session records | To keep the user signed in and let them see and revoke their devices | Per device: a device fingerprint, device name, platform, app version, refresh-token hash, creation and last-use times |
| IP address of a login attempt | Abuse prevention and rate limiting | Stored with the one-time code request; also in rate-limit counters keyed by IP and by phone |
| Account status and its history | Moderation (blocked / restricted / active) with the reason and the administrator who acted | Required by the platform's audit rules |

### Candidate profile

Structured fields, because search matches on them (there is **no CV parsing**;
the CV is an attachment):

- Full name, date of birth (minimum age enforced: **14**), gender
- Region, district and settlement — **typed by the user, not taken from the
  device**; willingness to relocate and to travel
- Occupations (primary and additional) and level, skills with levels, languages
  with levels and whether a certificate exists
- Preferred employment types, work formats, shifts; expected pay; available-from
  date
- Work history (employer name, role, dates, responsibilities) and education
  (level, institution, specialisation, year)
- Category-specific fields depending on the kind of work: driving licences,
  own transport, own tools, readiness (physical work, field travel, crew work,
  relocation), crew size, specialisation, portfolio link
- **Files:** a CV (PDF/DOC/DOCX, up to 20 MB), a profile photo, certificates
- A visibility setting: *searchable*, *visible only to employers I applied to*,
  or *hidden*
- A completeness percentage computed from the above

### Employer profile

- Type: company or individual
- Contact person's name and a contact phone; region, district, address;
  description
- For a company: legal name, public name, industry, logo
- **Verification evidence, uploaded to prove the employer is real:** for a
  company, a **company registration document** and an **identity document of
  the representative**; for an individual, an **identity document**. These are
  reviewed by an administrator, who may approve, reject with a reason, or
  request changes. Every administrator download of such a document is logged.
- Verification status and its history

### What users create and do

- **Vacancies** (employer content): title, description, occupation, location,
  schedule, pay, dates, requirements; and their moderation history
- **Applications**: which candidate applied to which vacancy, an optional cover
  note, the stage (submitted → viewed → shortlisted → interview → offer → hired,
  or rejected with a reason), employer notes on an application, and the full
  stage history
- **Invitations** from an employer to a candidate, and the candidate's answer
- **Interviews**: type (in person, phone, link), time, place or link, status
- **Conversations and messages** between an employer and a candidate, including
  file attachments; who blocked whom; read markers
- **Complaints**: a report about a vacancy, a profile, a user or a message, with
  the reporter's reason and the administrator's decision
- Saved vacancies (candidates), saved candidates and shortlists (employers)
- **Candidate unlocks**: a record that a given employer paid Coins to see a given
  candidate's contact details and CV. See "Who can see what".

### Coins and payments

- Employers hold a **Coin balance** with a ledger of every credit and debit
  (registration bonus, unlocks, administrator adjustments). The ledger is
  **append-only** and kept permanently; see retention.
- **Buying Coins is not yet available.** When it is, payment will go through
  Payme and/or CLICK; **card details never reach JobBridge** — only the
  provider's transaction identifier, the amount in UZS, and the outcome. Write
  the policy so this section is true today and needs only a date when payments
  launch; note it in `questions.md`.

### Notifications and devices

- In-app notifications (a list inside the app) and the user's preferences per
  category
- **Push notifications** via Google's Firebase Cloud Messaging: the app registers
  a device token with Google; the notification content sent through Google is
  the notification's title and text in the user's language and an identifier
  of what it refers to (a vacancy, an application, a conversation). It does
  **not** carry documents or message bodies beyond what the notification says.
  *Engineering to confirm the exact payload fields before publication.*

### Server-side technical data

- **Server logs** carry request metadata and the client's IP address. Phone
  numbers are **never logged in full** (last two digits only) and one-time codes
  are never logged. Log retention is **not yet defined** (see questions).
- **Backups**: a full database dump nightly, kept **14 days**, on the same
  server as the database.
- **Administrator audit log**: every administrator action (who, what, when,
  reason). **Append-only by database rule**; kept permanently.

## Where the data is, and who processes it

| Where | What | Operated by | Location |
|---|---|---|---|
| The JobBridge database (PostgreSQL) | Everything above except files | The operator, on its own server (self-hosted) | **Uzbekistan** — *confirm the physical location of the server with the operator* |
| **Telegram** (Bot API, used as the file store) | **Every uploaded file**: CVs, photos, logos, certificates, **identity documents and company registration documents**, chat attachments. Each file is a message in a private Telegram chat controlled by the operator. Downloads are always proxied through the JobBridge server; Telegram links are never given to users. | Telegram FZ-LLC / Telegram Messenger Inc. | Telegram's servers, **outside Uzbekistan** |
| **Firebase Cloud Messaging** | Push device tokens; notification titles/texts as described above | Google LLC | Google's servers, outside Uzbekistan |
| **Eskiz.uz** | The phone number and the one-time code text, to deliver the login SMS | Eskiz (Uzbekistan) | Uzbekistan |
| **Cloudflare** | Sits in front of the server: terminates TLS and forwards requests, so it sees traffic in transit including IP addresses | Cloudflare, Inc. | Cloudflare's network, global |
| Nightly backups | A copy of the database | The operator | Same server |
| Google Play | Distribution of the app; Google's own install/crash statistics | Google LLC | — |
| Payme / CLICK (future) | Payment processing for Coins | Their operators (Uzbekistan) | Uzbekistan |

**Nothing is sold, and nothing is shared for advertising.** There are no ads, no
analytics SDK, no tracking, and no data brokers. The only third parties are the
processors in the table.

## Who can see what

- A candidate's **phone number, CV and other contact details are never shown
  on a search card** and are **not** released by an application alone. An
  employer sees them only after a **paid unlock** of that specific candidate
  with Coins. This is a deliberate product rule.
- A candidate controls whether their profile is searchable at all (the
  visibility setting). A hidden profile is invisible to employers.
- Employers see applications to their own vacancies, and candidates they have
  unlocked or who are in a conversation with them.
- **Administrators** can see accounts, verification documents (downloads are
  logged), vacancies awaiting moderation, and the content of a **reported**
  message when reviewing a complaint. They cannot browse private conversations
  that nobody has reported.
- Anyone with access to the operator's **Telegram storage chat** can see every
  uploaded file. Access to that chat is therefore part of the operator's
  security obligations; say who has it in `questions.md`.
- Search results and a "match" indicator are computed from the structured
  fields (occupation, skills, location, pay). No decision with legal effect is
  automated; an employer or administrator always acts.

## How long data is kept

Every period below was chosen by an engineer and **has not been reviewed by a
lawyer**. Treat them as proposals and flag any you think should change.

| What | Proposed | Why |
|---|---|---|
| Account and profile after a deletion request | **30-day grace period**, then erased | So a request made in haste, or from a stolen phone, can be undone |
| Personal data after the grace period | Erased | — |
| Administrator accounts | Identity erased, record kept | The audit log must keep naming who acted |
| Administrator decisions (audit log) | Kept permanently | Accountability |
| Coin ledger | Kept permanently, with the account anonymised | Financial record |
| One-time codes | 1 day | Kept briefly for a disputed login |
| Sessions | 90 days after last use | Token-reuse detection |
| Rate-limit counters (IP, phone) | 2 days | — |
| In-app notifications | 180 days | — |
| Backups | 14 days | Disaster recovery |
| Server logs | **Undefined** — ask | — |
| Uploaded files after deletion | The database record is removed; **the file may remain in the Telegram chat**, because a bot can delete its own messages only for 48 hours. Files older than that can be removed manually by the operator. | Flag this: it affects what "deleted" means |

## What a user can do in the app

- See and edit every profile field; remove any uploaded file
- Change the interface language
- See their sessions (devices) and sign any of them out
- Block another user in a conversation; report a vacancy, a profile, a user or
  a message
- Set profile visibility (candidates)
- **Delete the account**: *Profile → Account → Delete account*. The account is
  scheduled for erasure after the 30-day grace period. **There is currently no
  in-app way to cancel a deletion request** — ask what should happen if the
  user signs in during the grace period, and write the page accordingly.
- **Data export is not implemented.** If the law requires a right of access in
  the form of a copy, say so in `questions.md`.

## Age

The profile validator accepts a date of birth of **14 years or older**, following
Uzbekistan's labour law on the minimum age of employment. Google Play's
target-audience declaration will need to match whatever the policy says. Ask
whether the policy should address under-18 users specifically, and whether 14
is the right floor.

## Security measures (state them; do not overstate them)

- All traffic is encrypted in transit (HTTPS)
- Login codes and refresh tokens are stored as salted hashes, not in clear
- Phone numbers are masked in logs; codes are never logged
- Rate limits per phone number and per IP address on login and on uploads
- Uploaded files are validated by content, not only by name
- A file can be downloaded only by its owner or by someone the product rules
  entitle (an employer after an unlock, an administrator reviewing evidence);
  every administrator download is logged
- Nightly backups
- **Not encrypted at rest**: the database and the backups are ordinary files on
  the operator's server. Do not claim encryption at rest.
- The app has no card-payment surface; card data never touches it

## Questions you must raise in `questions.md`

At minimum:

1. Does storing personal data (including identity documents) in Telegram and
   push tokens in Firebase comply with the data-localisation requirement of
   ЗРУ-547 as amended, given both are outside Uzbekistan? If not, what must
   change before publication?
2. Must the operator register its personal-data database with the authorised
   state body, and does that need to happen before launch?
3. Is "ELITE BRIDGE GROUP" MCHJ the correct controller while the app is
   published from a personal developer account?
4. Consent: is a checkbox on sign-up required, or is a link to the policy
   sufficient? Draft the exact consent sentence for the sign-in screen.
5. The retention periods above; log retention (undefined); backup retention.
6. What "deleted" must mean given the Telegram file limitation.
7. Cancelling a deletion request during the grace period.
8. Right of access / data export, which the app does not offer.
9. The minimum age of 14 and any duties towards minors.
10. Who at the operator has access to the Telegram storage chat and to the
    server, and whether that must be stated.
11. Government or court requests for data.
12. Anything in the Data safety answers below you believe is wrong.

## The Google Play *Data safety* answers this policy must agree with

| Data type | Collected | Shared with third parties | Purpose | Optional? |
|---|---|---|---|---|
| Name | Yes | No | App functionality (profile) | Required for a candidate profile |
| Phone number | Yes | No (delivered by an SMS processor for login only) | Account, login, contact after unlock | Required |
| Address (region/district/settlement, user-typed) | Yes | No | App functionality (search) | Required for a searchable profile |
| Other personal info (date of birth, gender, work history, education) | Yes | No | App functionality | Partly |
| Photos | Yes | No | Profile photo, company logo | Optional |
| Files and documents (CV, certificates, identity and registration documents) | Yes | No | Profile, employer verification | CV optional; verification documents required for employers |
| In-app messages | Yes | No | Chat between employer and candidate | Optional |
| Other user-generated content (vacancies, cover notes, complaints) | Yes | No | App functionality | Optional |
| Device or other IDs (push token, device fingerprint) | Yes | No | Notifications, session management | Required for push |
| Financial info | Not yet (Coin balance is app data; no card data ever) | — | — | — |
| Location (from the device) | **No** | — | — | — |
| Contacts, calendar, call logs, SMS | **No** | — | — | — |
| Crash logs / diagnostics / analytics | **No** | — | — | — |
| Data encrypted in transit | Yes | | | |
| Deletion available | Yes — in-app, and by request on the deletion page | | | |

"Shared" is answered *No* on the basis that Telegram, Firebase, Eskiz and
Cloudflare act as processors on the operator's instructions rather than as
independent recipients. **Challenge this if you disagree**; it is the single
most consequential answer on the form.
