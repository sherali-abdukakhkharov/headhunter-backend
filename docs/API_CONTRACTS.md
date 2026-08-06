# Client-facing API contracts

Frozen contracts the Flutter client builds against. Agreed with the mobile
engineer on 2026-08-04 in the HeadHunter channel; this file is the source of
truth, not the chat thread.

Design rationale lives in [../ARCHITECTURE.md](../ARCHITECTURE.md); spec
citations are `§n`, `BR-nn`, `UAT-nn` against [SPEC.md](SPEC.md).

Changing anything marked **frozen** is a coordinated release with the client.

---

## 1. Locale on the wire

`x-lang` header on every request. Canonical codes, **frozen casing**:

`uz-Latn` · `uz-Cyrl` · `ru` · `en`

BCP-47 rules: lowercase language subtag, title-case script subtag.

- Input is accepted case-insensitively and the house aliases `uz`/`oz` normalize
  to `uz-Latn`/`uz-Cyrl` (§3.1, and alignment with `d:\Dev\digital-edo-api`).
- Responses **always emit the canonical form**, in the body's `locale` field and
  in the `ETag`. The client keys its cache off the response `locale`, never off
  the string it sent — otherwise an alias or a casing slip silently splits the
  cache and every read is a permanent miss.
- Asserted by test: emitted casing is exactly the four codes above.

## 1a. Login — phone + OTP

Client direction, 2026-08-05 (second, superseding the Telegram period below):
**login is §4.1's phone + OTP**, which is also what UAT-01 walks.

```
POST /auth/otp/send     { phone, purpose? }         ->  OtpSent
POST /auth/otp/resend   { phone, purpose? }         ->  OtpSent
POST /auth/otp/verify   { phone, code, ... }        ->  AuthTokens
```

All three are `@Public()` and rate limited — `send`/`resend` on the `otp` bucket,
`verify` on the `auth` bucket — per phone **and** per IP, with `Retry-After` on
every 429.

**`OtpSent`** — `{ expiresAt, resendAvailableAt, devCode? }`. Both timestamps are
§2 offset strings. `devCode` appears only while `OTP_ECHO_IN_RESPONSE` is on, which
boot refuses in production; a client must never depend on it existing.

**`AuthTokens`** is unchanged and stays **frozen**: `accessToken`, `refreshToken`,
`expiresInSeconds`, `roles`, `activeRole`, `isNewUser`. Telegram login returns the
same shape, so everything after login is identical whichever path was used.

### The flow

1. The user picks an interface language, then enters a phone number (§3.1, §4.1).
2. `POST /auth/otp/send`. Registration and login are the **same call**: the client
   cannot know which one it is doing, and a route that told it would let anyone probe
   which numbers are registered.
3. The user types the code. `POST /auth/otp/verify` consumes it and returns tokens.
4. `isNewUser: true` routes into role selection (`POST /auth/roles`) rather than the
   home screen.

Verifying a code is what makes the number verified, so every account that reaches a
session this way satisfies **BR-01** by construction.

### What the client must send

- `phone` — E.164 preferred. The server normalizes, so `+998 90 123 45 67` and
  `998901234567` reach the same account; `auth.phone_invalid` rejects the rest.
- `code` — as typed, `OTP_LENGTH` digits (6).
- `purpose` — omit it. Defaults to `login`, which covers registration too. Send
  `phone_change` only from the authenticated phone-change flow.
- `locale` on **verify** — the interface language stored on a newly created account,
  defaulting to `uz-Latn`. This is the one place a body field carries the locale
  rather than `x-lang`: registration is the only moment the value is *written*, and
  the account is created inside this call. Send both and keep them equal; change it
  later with `PATCH /users/me/locale`.
- Optional device fields (`deviceName`, `platform`, `appVersion`,
  `deviceFingerprint`) on verify, which populate the §4.2 session list.

### No SMS is sent yet

No provider is bought, so nothing leaves the server. Until one is connected:

| Variable | Effect | In production |
|---|---|---|
| `OTP_STATIC_CODE=666666` | every issued code is `666666` | boot refuses a non-empty value |
| `OTP_ECHO_IN_RESPONSE=true` | the code comes back as `devCode` | boot refuses `true` |

**Nothing else about the flow is relaxed.** The fixed code is substituted at the one
point a random code would be generated, so it is hashed into the same row, expires on
the same TTL, is superseded by the next send, counts against the same
`OTP_MAX_ATTEMPTS`, and is **consumed on first use** — it is not a standing password.
Three integration tests hold that shape. Connecting a provider therefore changes
delivery only: no route, no DTO, no client change, and nothing the client has already
exercised can behave differently.

### Errors

| Code | Status | Meaning |
|---|---|---|
| `auth.phone_invalid` | 400 | Not a usable phone number. |
| `auth.otp_invalid` | 401 | Wrong code, expired code, or no code outstanding. One code for all three on purpose — distinguishing them reveals which numbers have a pending code. |
| `auth.otp_too_many_attempts` | 429 | `OTP_MAX_ATTEMPTS` reached. The code is consumed; request a new one. **No `Retry-After`** — it is not waiting on a clock. |
| `auth.otp_resend_too_soon` | 429 | Inside `OTP_RESEND_DELAY_SECONDS`. Carries `Retry-After`. |
| `account.blocked` | 403 | BR-10 — a blocked account cannot authenticate at all. |
| `error.too_many_requests` | 429 | The bucket limit, with `Retry-After`. |
| `error.not_found` | 404 | `OTP_LOGIN_ENABLED` is off. Not a client-handled case: it means the deployment closed the route. |

## 1b. Login — Telegram *(deprecated 2026-08-05)*

**The app no longer calls this.** It is kept working rather than deleted: the JWKS
verification is correct, its 22 integration tests still run, and Telegram stays the
obvious cheap-verification path if it is wanted again. `POST /auth/telegram` is marked
`deprecated` in Swagger and converges on the same session issuance as OTP, so an
account can hold both credentials — a Telegram login carrying a Telegram-verified
phone links to the account the OTP flow created rather than duplicating it.

Everything below documents that path as built.

```
POST /auth/telegram      { idToken }  ->  AuthTokens
```

### The flow

1. The app calls the official Telegram Login SDK ([iOS](https://github.com/TelegramMessenger/telegram-login-ios),
   [Android](https://github.com/TelegramMessenger/telegram-login-android); wrapped
   for Flutter by [`telegram_login`](https://pub.dev/packages/telegram_login)).
2. Telegram opens app-to-app — or a web sheet when Telegram is not installed — and
   the user approves the scopes **inside Telegram**. There is no password and no
   OTP anywhere in this flow.
3. The SDK completes the OAuth2 authorization-code exchange with PKCE and returns a
   signed `id_token`.
4. The app posts that token to `POST /auth/telegram` and receives our own tokens.

### What the client must send

- `idToken` — the SDK's `result.idToken`, verbatim. **Never** the raw OAuth `code`;
  the SDK owns that exchange.
- `x-lang` — becomes the account's stored locale when this login creates it. There
  is deliberately no `locale` body field: two ways to state the interface language
  is two ways for them to disagree.
- Optional device fields (`deviceName`, `platform`, `appVersion`,
  `deviceFingerprint`), which populate the §4.2 session list.

### Scopes the app must request

`openid profile phone`

The `phone` scope is **required** in practice: while `TELEGRAM_REQUIRE_PHONE` is on,
a token with no `phone_number` is refused with `401` and
`code: "auth.telegram_phone_required"`, plus a localized message telling the user to
allow it. The reason is BR-09 — contact exposure to an employer has nothing to reveal
without a phone number, so an account created without one silently cannot take part
in hiring.

Consider adding `telegram:bot_access` too. It lets the bot message the user directly,
which is a candidate delivery channel for M9's notifications — and asking for it at
login is far easier than asking again later.

### Claims Telegram actually sends

Verified against `https://oauth.telegram.org/.well-known/openid-configuration`:

```
aud  preferred_username  phone_number  exp  iat  iss  name  picture  sub
```

Two things follow, and both bit us:

- **There is no `phone_number_verified`.** The prose docs mention it; the discovery
  document does not list it. A `phone_number` from Telegram is treated as verified
  unless the claim is explicitly `false` — sound, because a Telegram account *is* a
  confirmed phone number: Telegram will not issue one without verifying it, so the
  only way it can name a user's phone is that the user proved control of it.
- **No `id`, `given_name` or `family_name`** either. The user id comes from `sub`.

Signing algorithms offered are `RS256 ES256 EdDSA ES256K`; we accept the first two.
**Do not select EdDSA or ES256K in BotFather** — they restrict the token to the
`openid` scope, so it could not carry the phone number.

### Errors

| Code | Status | Meaning |
|---|---|---|
| `auth.telegram_token_invalid` | 401 | Bad signature, wrong audience, wrong issuer, expired, or older than the age window. One code for all of them on purpose. |
| `auth.telegram_phone_required` | 401 | The `phone` scope was not granted. Re-run login and allow it. |
| `account.blocked` | 403 | BR-10 — a blocked account cannot authenticate at all. |
| `error.too_many_requests` | 429 | The `auth` bucket, with `Retry-After`. |

### Token freshness

An `id_token` is accepted for `TELEGRAM_ID_TOKEN_MAX_AGE_SECONDS` (default 300) from
its `iat`, not merely until `exp`. **The app must post it promptly** — do not stash
one and reuse it later; run the SDK again instead.

## 2. Timestamps — frozen format

Every timestamp in every response is ISO-8601 with an **explicit numeric offset
resolved for that instant**:

```
2026-08-12T14:00:00+05:00
```

Never `Z`, never offsetless. Interview-bearing payloads also carry the zone name:

```json
{ "scheduledAt": "2026-08-12T14:00:00+05:00", "timeZone": "Asia/Tashkent" }
```

Why this is a contract and not an implementation detail: Dart's
`DateTime.parse` discards the offset and normalizes to UTC, and `toLocal()` then
re-renders in the *device* zone. The client therefore reads the wall-clock
components straight off the string and labels them with `timeZone`. A stray
`Z` from our side would silently shift every displayed interview time for any
user outside Uzbekistan.

Implementation consequence on our side: `Date.prototype.toISOString()` emits
`Z`, so serialization goes through one deliberate formatter with a test — not
per-DTO `toISOString()` calls.

Platform zone is `Asia/Tashkent` (single zone, §8.3). Storage is `timestamptz`.
Going per-user later adds `users.time_zone` defaulting to the platform zone and
does not change the wire format.

## 3. Dictionaries

```
GET /dictionaries/manifest
GET /dictionaries/{type}?since=<version>
GET /dictionaries/items?ids=<uuid,uuid>
```

### 3.1 Types — frozen

`occupation` · `skill` · `industry` · `region` · `language` · `employment_type` ·
`work_format` · `shift` · `attribute` · `skill_level` · `language_level` ·
`education_level` · `payment_period` · `file_purpose` · `gender`

Everything selectable anywhere in the product is one of these. There is no
inline enum in any contract: BR-13 requires a stable id plus four locales, and
§10.3 requires admin management — both of which only the dictionary tables
provide.

**`gender` added 2026-08-05 with M3.** §5.1 asks for gender on the profile and
§7.1/BR-12 let a moderated vacancy restrict on it, so it needed four labels and a
stable id that a profile and a vacancy requirement can share. A native enum was
rejected because §4.2's `kind` union has no `enum` member — deliberately, per §3.1.
Adding a type is **additive**: a field names its own `dictionaryType` and the client
fetches whatever is named, so nothing existing changed. `file_purpose` also gained a
`photo` item for §5.1's optional profile photo.

### 3.2 Categories — frozen

`professional` · `service_operations` · `physical_industrial` ·
`seasonal_agricultural` · `temporary_shift`

Closed enum from §2.1. Safe to key client layouts and icons off these.

### 3.3 Manifest

`count` is the number of **active** items — what a picker would show. An
inactive item still resolves through `/dictionaries/items` but is not counted.

```json
{
  "version": 1187,
  "types": [
    { "type": "occupation", "version": 1187, "count": 412 },
    { "type": "region", "version": 1150, "count": 212 }
  ],
  "schemas": [
    { "target": "candidate_profile", "category": "professional", "version": 7 },
    { "target": "vacancy", "category": "professional", "version": 7 }
  ]
}
```

`schemas` is 10 entries (5 categories × 2 targets). Versions are
locale-independent: a label edit in any locale bumps the version for all four.
That over-invalidates slightly and is chosen deliberately over per-locale
versions. A client only ever needs its active locale, so a cold revalidation is
at most 10 conditional GETs and normally zero.

### 3.4 Items and deltas

`version` is a **monotonic global revision counter** bumped on every item or
translation write. A type's version is the max revision across its rows.

```json
{
  "type": "skill",
  "locale": "uz-Latn",
  "version": 1187,
  "since": 1150,
  "isFull": false,
  "items": [
    {
      "id": "b1f2…",
      "code": "call_centre_operator",
      "label": "Call-markaz operatori",
      "category": "service_operations",
      "group": null,
      "parentId": null,
      "sortOrder": 120,
      "rank": null,
      "isActive": true,
      "mergedIntoId": null
    }
  ],
  "removed": [
    { "id": "9ac4…", "reason": "inactive", "mergedIntoId": null },
    { "id": "7de1…", "reason": "merged", "mergedIntoId": "b1f2…" }
  ]
}
```

- `ETag: W/"skill:1187:uz-Latn"`, `Vary: x-lang`,
  `Cache-Control: private, max-age=0, must-revalidate`. `If-None-Match` → `304`
  with no body.
- `since` omitted → full set, `isFull: true`.
- `rank` is a non-null integer **only on the level types** (`skill_level`,
  `language_level`). It is the ordering used for `>= C1` range comparisons, is
  uniform per type, and never varies per item.
- `group` is a non-null string **only on `attribute` items**, and is what a
  schema field's `group` (§4.1) selects on: `licence`, `transport`, `tools`,
  `readiness`. **Added 2026-08-04, during M2 implementation** — it is additive,
  so no existing field changed, but without it the `"group": "tools"` in a
  schema field has nothing to match and that field cannot be rendered.
  `category` could not carry it: that column holds the five closed §2.1 work
  categories and client layouts are keyed off them.
- **Deactivated ≠ deleted.** A `removed` entry means "drop from pickers"; the id
  still resolves forever.
- **Merges reach the client in one round trip.** A merge writes `merged_into_id`
  on the losing row and bumps the revision of *both* rows, so the same delta
  carries the loser in `removed` with `mergedIntoId` inline **and** the surviving
  item in `items`. No follow-up `/items?ids=` call is needed to repoint local
  references (§10.3).
- `GET /dictionaries/items?ids=…` resolves any id including inactive and merged
  ones. Its purpose is rendering historical records that reference values the
  client never cached — never showing a raw code (§3.2).
- Labels are display-only. Every filter and every write body carries ids
  (BR-13). If a label ever needs to travel client → server, the contract is
  wrong.

## 4. Field schemas

```
GET /schemas/candidate-profile?category=<code>
GET /schemas/vacancy?category=<code>
```

`ETag: W/"schema:candidate-profile:seasonal_agricultural:7:ru"`.

### 4.1 The schema is the complete form

`sections[]` contains **core sections and category sections together**,
distinguished by `source`. Core fields are backed by fixed columns; category
fields by `candidate_attributes` rows. The client does not care which.

This exists so that **every code in `requiredForSearchable` resolves to a field
in `sections[].fields[]`** — a completeness prompt can always focus something.
Asserted by a contract test: no unresolvable code, in any category, in either
target.

```json
{
  "target": "candidate_profile",
  "category": "seasonal_agricultural",
  "schemaVersion": 7,
  "locale": "ru",
  "sections": [
    {
      "code": "location",
      "source": "core",
      "label": "Локация",
      "repeating": false,
      "editor": "engine",
      "fields": [
        { "code": "region_id", "kind": "dictionary_single",
          "dictionaryType": "region", "label": "Регион", "required": true }
      ]
    },
    {
      "code": "availability",
      "source": "category",
      "label": "Доступность",
      "repeating": false,
      "editor": "engine",
      "fields": [
        { "code": "available_from", "kind": "date", "label": "Доступен с",
          "required": true, "validation": { "notBefore": "today" } },
        { "code": "own_transport", "kind": "bool", "label": "Свой транспорт",
          "required": false },
        { "code": "tools", "kind": "dictionary_multi",
          "dictionaryType": "attribute", "group": "tools",
          "label": "Инструменты", "required": false,
          "validation": { "maxItems": 10 } },
        { "code": "crew_size", "kind": "int", "label": "Размер бригады",
          "required": false, "validation": { "min": 1, "max": 200 } }
      ]
    },
    {
      "code": "experience",
      "source": "core",
      "label": "Опыт работы",
      "repeating": true,
      "editor": "bespoke",
      "endpoint": "/candidates/me/experience",
      "fields": []
    }
  ],
  "attachments": [
    { "purposeId": "c3a1…", "code": "cv", "label": "Резюме", "required": false,
      "accept": ["pdf", "doc", "docx"], "maxSizeBytes": 10485760, "maxCount": 1 },
    { "purposeId": "d4b2…", "code": "certificate", "label": "Сертификаты",
      "required": false, "accept": ["pdf", "jpg", "png"],
      "maxSizeBytes": 10485760, "maxCount": 10 }
  ],
  "requiredForSearchable": ["region_id", "occupation_ids", "available_from"]
}
```

`editor: "bespoke"` marks a repeating section the form engine hands off to a
purpose-built widget (experience, education). `fields` is empty there and
`endpoint` names its own sub-resource. This is the boundary the mobile
architecture asks for: the engine handles the generic remainder, bespoke layout
stays bespoke.

### 4.2 `kind` — frozen closed union, 13 members

| `kind` | Value shape |
|---|---|
| `text` | `string` |
| `long_text` | `string` |
| `int` | `number` |
| `decimal` | `number` |
| `bool` | `boolean` |
| `date` | `"2026-08-12"` |
| `date_range` | `{ from, to }`, either side nullable |
| `url` | `string` |
| `phone` | `string`, E.164 |
| `money_range` | see §4.3 |
| `dictionary_single` | `uuid` |
| `dictionary_multi` | `uuid[]` |
| `dictionary_leveled` | see §4.4 |

Two field properties were **added 2026-08-05 with M3**, both additive:

- **`parentFieldCode`** on a `dictionary_single` — restrict the options to the
  children of the item chosen in that field. Only `district_id` uses it today
  (`parentFieldCode: "region_id"`). Without it the client would have to hardcode
  "districts are the children of a region", which is exactly the hardcoding the
  schema exists to remove. The server enforces it: a district under another region
  is `422` with `rule: "parentField"`, checked against the stored region when the
  request does not resend one.
- **`validation.notAfter: "today"` and `validation.minAgeYears`** on a `date`. The
  mirror of §4.1's `notBefore` example, plus the rule a birth date needs.
  `date_of_birth` carries both, and the column keeps the same rule as a CHECK — the
  schema layer exists so an under-age entry gets a field-level message instead of a
  constraint failure.

There is no `enum` and no file kind. Both were considered and rejected — §3.1
and §4.5.

Rules that make the union safe to extend:

1. **Unknown `kind` → skip the field and log.** Never crash. This is what lets
   the server add a field type without a lockstep app release.
2. **Adding a *field* is not breaking; adding a *kind* is.** New fields of
   existing kinds are picked up for free. A new kind is announced and released
   together.
3. **The server re-validates every write against the same schema.** Client
   validation is UX. A stale client schema produces a clean `422`, never corrupt
   data.

### 4.3 `money_range`

§6.3 requires "Range, daily/monthly/per-task, or negotiable" — one field with
one label and one required flag, not two `decimal`s stapled together.

```json
{ "code": "salary", "kind": "money_range", "label": "Оплата", "required": false,
  "currency": "UZS", "periodDictionaryType": "payment_period",
  "allowNegotiable": true,
  "validation": { "min": 0, "max": 500000000, "requireFromLteTo": true } }
```

```json
{ "salary": { "from": 5000000, "to": 8000000, "periodId": "aa11…",
              "currency": "UZS", "isNegotiable": false } }
```

- The period is a **dictionary** (`payment_period`), not an inline enum — same
  rule as everything else selectable.
- `isNegotiable: true` requires `from` and `to` both null. "Negotiable, 5–8M" is
  a contradiction the salary filter cannot rank, so it is rejected, not
  normalized.
- Single-sided ranges are valid (`from` only = "from 5M").
- `from <= to` is a CHECK constraint, not only a service check.
- `currency` is carried in the field so it is never hardcoded client-side.
  Single currency in v1.

### 4.4 `dictionary_leveled`

The level scale is its own dictionary type, referenced explicitly. Per-row
extras are declared by the field and limited to `bool` and `text` — depth 1, no
further nesting.

```json
{ "code": "languages", "kind": "dictionary_leveled",
  "dictionaryType": "language", "levelDictionaryType": "language_level",
  "label": "Языки", "required": false,
  "extras": [
    { "code": "has_certificate", "kind": "bool", "label": "Есть сертификат" }
  ] }
```

```json
{ "languages": [
  { "itemId": "…", "levelId": "…", "has_certificate": true }
] }
```

Extras exist because the spec forces them: candidate languages carry optional
certificate details (§5.4) and vacancy language requirements carry a
mandatory/preferred flag (§6.3).

Level comparison (`>= C1`, §7.4) is a `rank` range test server-side, which is
why level items carry `rank`.

### 4.5 Attachments live outside the field union

CV and evidence files are **never** a schema field. Reasons: uploads need signed
URLs, progress, cancel, retry and malware scanning (§5.4, §9, §12.5); they are
authorized per viewer (BR-09); and the file-service decision is still open.
A dynamic form field cannot carry that lifecycle.

They are still **declarative** — the `attachments[]` block above is
category-scoped and driven by the `file_purpose` dictionary. So a new required
evidence type is a dictionary row plus a schema entry, not a renderer change and
not a coordinated release. The client renders one purpose-built upload widget
over that list.

`accept` and `maxSizeBytes` are advisory mirrors of the server rules; the server
rejects violations regardless.

### 4.6 Profile writes

One uniform write for every engine-rendered field, keyed by field code:

```
PATCH /candidates/me/profile
{ "fields": { "region_id": "…", "available_from": "2026-08-12", "crew_size": 12 } }
```

The server routes each code to its column or attribute row. Bespoke repeating
sections use their own `endpoint`. Attachments use the file endpoints.

Validation failures:

```json
{ "statusCode": 422,
  "errors": [
    { "code": "salary", "rule": "requireFromLteTo", "message": "…" }
  ] }
```

`code` is the field code from the schema, so the client can attach the message
to the field that produced it.

`completenessPercent` and `isComplete` are computed and stored server-side
(§7.1 filters on them). Read them from the profile response; recomputing
client-side guarantees the two disagree.

## 4a. The candidate profile

Built 2026-08-05 with M3. Every route requires an **active role of `candidate`** —
an account may hold several roles (§2.3), and holding one is not acting as it.

```
GET   /candidates/me/profile                 ->  CandidateProfile
PATCH /candidates/me/profile                 ->  CandidateProfile   (§4.6 body)
PUT   /candidates/me/visibility              ->  CandidateProfile

GET   /candidates/me/experience               ->  { items: Experience[] }
POST  /candidates/me/experience               ->  Experience
PUT   /candidates/me/experience/{id}          ->  Experience
DELETE/candidates/me/experience/{id}          ->  204

GET   /candidates/me/education                ->  { items: Education[] }
POST  /candidates/me/education                ->  Education
PUT   /candidates/me/education/{id}           ->  Education
DELETE/candidates/me/education/{id}           ->  204

GET   /candidates/me/attachments               ->  { items: Attachment[] }
POST  /candidates/me/attachments               ->  Attachment  (multipart)
DELETE/candidates/me/attachments/{id}          ->  204
```

### The profile response

```json
{
  "isStarted": true,
  "category": "professional",
  "visibility": "hidden",
  "completenessPercent": 52,
  "isComplete": true,
  "isSearchable": false,
  "missingFields": [
    { "code": "available_from", "section": "preferences", "required": false }
  ],
  "fields": { "full_name": "Anvar Karimov", "region_id": "…", "…": "…" },
  "lastMeaningfulUpdateAt": "2026-08-05T18:02:55+05:00",
  "updatedAt": "2026-08-05T18:03:05+05:00"
}
```

Five things the client should rely on:

- **`fields` is keyed by schema field codes and shaped exactly as `PATCH` accepts.**
  Read, change one value, send it back. There is no second mapping to maintain.
- **A profile that does not exist yet is not a 404.** `isStarted: false`, every field
  present and null, completeness 0. The form screen has one code path.
- **`category` is derived from the primary occupation** and is what to pass to
  `GET /schemas/candidate-profile`. It is `null` until an occupation is chosen, and
  only the fields common to all five categories exist until then — so the first
  profile screen is choosing the target work. Sending a category-specific code
  before that is `422 validation.unknown_field`.
- **`isSearchable` is BR-02 in one field**: `isComplete && visibility === 'searchable'`.
  ANDing it client-side would be a second implementation of the rule that decides
  who is findable.
- **`missingFields` carries optional gaps too**, flagged by `required`. The `true`
  ones are §5.3's mandatory list and block searchability; the rest are prompts.
  `code` is a field code (or a bespoke section's code) and `section` is what to open.

### Visibility is its own route, not a field

`PUT /candidates/me/visibility` with `{ "visibility": "searchable" | "hidden" | "visible_after_apply" }`.

Two reasons it is not in `fields`: §4.2's `kind` union has no `enum` member, and this
is the **only write that does not refresh `lastMeaningfulUpdateAt`** (§5.3, §7.3) —
a privacy toggle must not let a stale profile present itself as freshly maintained.
It is accepted while the profile is incomplete: BR-02 gates the *effect*, not the
setting.

### Experience and education

The `editor: "bespoke"` sections of §4.1, at the `endpoint` the schema publishes.
Fixed shapes rather than schema-driven ones, and `PUT` is a full replacement — the
records are small and a bespoke editor submits the whole form.

Only `roleTitle` and `startedOn` are required on experience: §5.1 asks for a
simplified entry for informal or seasonal work, where there is often no employer to
name. `isCurrent` and `endedOn` are mutually exclusive (`422`
`validation.current_has_no_end`), and an end before the start is
`validation.date_order`.

Both count toward `completenessPercent`, refreshed in the same transaction as the
write. Neither can ever be *required* — a bespoke section has no field for
`requiredForSearchable` to name — so an empty work history lowers the percentage
without locking the profile out of search.

### Attachments

`POST` is `multipart/form-data` with `purpose` (a `file_purpose` **code** —
`cv`, `photo`, `certificate`, `evidence`) and `file`.

- Only purposes the category's `attachments[]` declares are accepted; anything else
  is `400 candidate.attachment_purpose_invalid`.
- **`maxCount` is how "replace" works** (§5.4). Uploading a second CV supersedes the
  first: the new file is stored, then the oldest beyond the limit is soft-deleted.
  There is deliberately no "replace" operation — delete-then-upload leaves a
  candidate with no CV if the second call fails.
- `downloadPath` is a path on this API (`/files/{id}/content`). There is never a
  storage URL: Telegram's carries the bot token, so bytes are proxied after an
  ownership check (§11.1, ARCHITECTURE.md §9).
- Deletes are soft. BR-14's retention period is still open.

**Employer access to a candidate's CV (BR-09) is not built yet.** A CV is currently
readable only by its owner — stricter than BR-09 requires, so nothing is exposed. It
arrives with M4's verified employer and M7's candidate serializer, where "an allowed
hiring interaction" can actually be evaluated.

## 4b. The employer profile and verification

Built 2026-08-05 with M4. Every route requires an **active role of `employer`**.

```
GET   /employers/me                ->  EmployerProfile
PUT   /employers/me                ->  EmployerProfile
GET   /employers/me/verification    ->  VerificationState
POST  /employers/me/verification    ->  VerificationState
```

### The profile

`PUT` is a full replacement — §6.1 is one screen and submits whole. `type` is
`company` or `individual`, chosen once: it decides which fields apply and what
verification asks for, so changing it later would strand the other type's answers and
the evidence verification was granted against. A later `PUT` with a different `type`
is `403 employer.type_immutable`.

Unlike the candidate profile, **`GET` is a 404 before the first `PUT`**
(`employer.profile_not_found`). There is no neutral empty employer to render, because
`type` decides which fields exist at all.

Fields by type, per §6.1:

| Type | Required for BR-03 | Also accepted |
|---|---|---|
| `company` | `contactPhone`, `regionId`, `legalName`, `publicName`, `industryId`, `contactPersonName`, `description` | `districtId`, `address`, `logoFileId` |
| `individual` | `contactPhone`, `regionId`, `fullName`, `description` | `districtId`, `address` |

- **`legalName` and `publicName` are both kept.** They differ often enough that
  showing the legal name on a vacancy card would be wrong and verifying against the
  public name would be impossible.
- **`contactPhone` is not the login phone.** BR-01's verified number stays on the
  account; this is the number a candidate should call, which is often a different
  person.
- `logoFileId` is a stored file of purpose `logo`, uploaded through `POST /files`.

**`canPublish` is BR-03 in one field**: `isComplete && verificationStatus ===
'verified'`. Read it rather than ANDing the two — a client that re-derived it would be
a second implementation of the rule that decides who may post a vacancy.
`missingFields[]` names the unfilled required fields so the client can focus one.

### Verification

`verificationStatus` is §6.1's five states exactly: `not_submitted`, `under_review`,
`verified`, `rejected`, `changes_required`. `verificationReason` is the
administrator's text for a rejection or a correction request — **human prose in
whatever language they wrote it**, not a translatable key.

```json
{
  "status": "not_submitted",
  "reason": null,
  "verifiedAt": null,
  "requiredEvidence": [
    { "purposeCode": "company_registration", "required": true },
    { "purposeCode": "evidence", "required": false }
  ],
  "submissions": []
}
```

**Read `requiredEvidence` rather than hardcoding a document list.** §6.1 says
"verification documents if required" and "identity verification data if required by
policy", and that policy is still an open client decision — so the answer is served as
data and will change without a client release. Today a company must provide
`company_registration` and an individual need not provide anything.

`POST` takes `{ "fileIds": [...] }` — files uploaded through `POST /files` with the
purpose the list names, each owned by the caller. Refusals:

| Code | Status | Meaning |
|---|---|---|
| `employer.profile_incomplete` | 403 | BR-03: finish the profile first. |
| `employer.verification_evidence_missing` | 403 | A `required` document is absent. |
| `employer.verification_not_submittable` | 409 | Already under review, or already verified. A 409 rather than a 403: the state forbids it, not the caller. |
| `file.not_found` | 404 | A file id is unknown, deleted, or belongs to another account. |

`submissions[]` is newest first and keeps every attempt with its reason, so a client
can show why a previous try was refused. After a `changes_required` decision the
employer may submit again.

**Verification currently approves immediately.** The admin module is M10, so
`EMPLOYER_VERIFICATION_ENABLED` is off and a submission goes straight to `verified`.
The client should not special-case this: it is the same response shape, and the
`under_review` state will start appearing when the flag goes on. The audit row records
a null actor and an `auto_verified_no_reviewer` reason, so nothing claims a person
reviewed it.

## 4c. Vacancies

Built 2026-08-05 with M5. The employer side; what a *candidate* sees is discovery (M6),
a separate module with different authorization and ranking.

```
POST  /vacancies                    ->  Vacancy   (a draft)
GET   /vacancies/mine                ->  { items: Vacancy[] }
GET   /vacancies/{id}                ->  Vacancy
PATCH /vacancies/{id}                ->  Vacancy   (§4.6 body)
POST  /vacancies/{id}/submit         ->  Vacancy
PUT   /vacancies/{id}/status         ->  Vacancy   (pause | resume | close)
POST  /vacancies/{id}/moderation     ->  Vacancy   (admin role only)
```

The form comes from `GET /schemas/vacancy?category=<code>` — **the same mechanism as the
candidate profile**, so one form engine renders both, and `fields` is keyed by the same
field codes in both directions. `category` is derived from `occupation_id`, as on a
candidate profile.

### Statuses (§6.4)

`draft` · `under_moderation` · `active` · `paused` · `closed` · `rejected`

```
draft            → under_moderation | active
under_moderation → active | rejected
rejected         → draft            (an edit does this automatically)
active           → paused | closed | under_moderation
paused           → active | closed | under_moderation
closed           → nothing          (BR-11: leaves discovery, stays in history)
```

- **`isOpenForApplications`** is BR-06 in one field: `active`, and either no deadline or
  one that has not passed. The deadline day itself still accepts applications.
- **`missingForSubmit`** lists required codes still unfilled. `POST /submit` refuses
  while it is non-empty, with **one 422 violation per code** so each can be focused.
- **Editing a `rejected` vacancy returns it to `draft`** and clears the moderator's
  reason — otherwise a stale reason would read as current.
- **A vacancy under review cannot be edited** (`409 vacancy.under_moderation`): a
  moderator is reading it, and an edit would have them approve something else.
- `closed` is terminal, and closing is the employer's action with a reason.

### BR-12: age and gender restrictions

Optional fields, in the `restrictions` section: `age_min`, `age_max`, `gender_id`,
`restriction_justification_id`, `restriction_justification_note`.

Four things the client must know:

1. **A restriction requires `restriction_justification_id`** — an id from the
   `restriction_justification` dictionary, never free text, because BR-12 requires
   moderation to validate the reason. The note is elaboration for the reviewer.
2. **Each reason supports only certain restriction kinds.** A gender restriction
   justified by a minimum-age rule is `403 vacancy.restriction_not_justified`.
3. **A restricted vacancy always goes to `under_moderation`**, even while
   `MODERATION_ENABLED` is off. Until the admin module exists it therefore **cannot be
   published** — deliberately: the flag exists so ordinary vacancies are not stranded,
   not so an unchecked restriction can go live.
4. **Adding or changing a restriction on a live vacancy sends it back for review**, so
   it leaves discovery until approved.

### Errors

| Code | Status | Meaning |
|---|---|---|
| `employer.profile_incomplete` / `employer.not_verified` | 403 | BR-03, on create and submit. |
| `vacancy.not_found` | 404 | Unknown, or another employer's — we do not confirm which (§11.1). |
| `vacancy.under_moderation` | 409 | Being reviewed; not editable yet. |
| `vacancy.not_editable` | 409 | Closed. BR-11 keeps it as history. |
| `vacancy.not_submittable` | 409 | Only a `draft` or a `rejected` vacancy may be submitted. |
| `vacancy.transition_not_allowed` | 409 | Not a legal move in the machine above. |
| `vacancy.deadline_passed` | 403 | Publishing something BR-06 would refuse every application to. |
| `vacancy.restriction_not_justified` | 403 | BR-12: absent or unsuitable justification. |
| `validation.failed` | 422 | Per-field, on a write **and** on an incomplete submit. |

**Publication currently happens on submit.** `MODERATION_ENABLED` is off until the admin
module (M10), so an unrestricted vacancy goes straight to `active` with an
`auto_approved_no_moderator` audit row. The client should not special-case that: the
response shape is identical, and `under_moderation` starts appearing when the flag goes
on — and already appears today for anything BR-12 touches.

## 4d. Discovery and applications

Built 2026-08-05 with M6. This is the loop: an employer publishes, a candidate finds and
applies, the employer moves them through the stages.

```
GET   /discovery/recommended                  ->  { items: FeedItem[] }
GET   /discovery/recent                       ->  { items: FeedItem[] }
GET   /discovery/saved                        ->  { items: FeedItem[] }
GET   /discovery/vacancies/{id}                ->  VacancyDetail
PUT   /discovery/vacancies/{id}/saved          ->  204
DELETE/discovery/vacancies/{id}/saved          ->  204
POST  /discovery/vacancies/{id}/report         ->  { id }

POST  /vacancies/{id}/applications             ->  Application    (candidate)
GET   /applications/mine                        ->  { items: Application[] }
POST  /applications/{id}/withdraw                ->  Application

GET   /vacancies/{id}/applications               ->  { items: Application[] }   (employer)
GET   /vacancies/{id}/applications/counts         ->  ApplicationCounts
PUT   /applications/{id}/stage                    ->  Application
GET   /applications/{id}/candidate                 ->  CandidateForEmployer
GET   /applications/{id}/files/{fileId}/content     ->  bytes
POST  /applications/{id}/notes                     ->  ApplicationNote
GET   /applications/{id}/notes                     ->  { items: ApplicationNote[] }

GET   /applications/{id}/history                    ->  { items: StageHistoryEntry[] }  (both)
```

### The feed

All three lists share one card shape, and two of its fields save the client a round trip:
`isSaved`, and `applicationStatus` — the caller's own stage for that vacancy, or null,
so a card can show Apply or the current status directly (§5.6). The card also carries the
employer's `isVerified`, which is what makes BR-03's badge worth having.

Filters (§5.5) are query parameters, id lists comma-separated:
`occupationIds`, `category`, `regionId`, `districtId`, `employmentTypeIds`,
`workFormatIds`, `shiftIds`, `salaryFrom`, `publishedFrom`, plus `limit` (max 50)
and `offset`.

- **`recommended` is rule-based**, not a model: occupation counts double, region and
  category one each, ties break on recency. A candidate with no profile gets the recent
  feed rather than an empty one.
- **`salaryFrom` keeps negotiable vacancies.** One has not said no to the figure, and
  excluding them would hide much of the seasonal work.
- **Everything except `saved` is filtered to visible vacancies** — active, deadline not
  passed (BR-04, BR-06, BR-11). `saved` deliberately is not: a candidate who saved
  something needs to see that it closed rather than have it vanish.

### Applying

`POST /vacancies/{id}/applications` with an optional `coverNote`, and an optional
**`Idempotency-Key` header**. Send one: a retry with the same key and body returns the
original application instead of failing, which is what makes a lost response safe (§12.4).
A different body under the same key is `409 idempotency.key_reused`.

| Code | Status | Meaning |
|---|---|---|
| `candidate.profile_required` | 403 | BR-02 — fill in the profile first. |
| `application.already_applied` | 409 | BR-07 — one active application per vacancy. |
| `application.vacancy_closed` | 409 | BR-06, and BR-04/BR-11. From the candidate's side "paused", "closed" and "deadline passed" are one fact: applications are not being taken. |

**Withdrawing frees the BR-07 slot**, so a candidate may apply again later. It is allowed
up to an accepted offer, which `hired` being terminal expresses.

### Stages (§8.1)

`submitted` · `viewed` · `shortlisted` · `interview` · `offer` · `hired` ·
`rejected` · `withdrawn`

- **Forward moves may skip a stage** — real hiring does. Backwards moves are refused: a
  candidate told they were shortlisted and then returned to `viewed` has been told
  something false.
- **`withdrawn` is the candidate's alone**; everything from `viewed` on is the
  employer's. `hired`, `rejected` and `withdrawn` are terminal.
- `hired` increments the vacancy's counter in the same transaction — read it from
  `/counts` alongside `workerCount` (§6.5).
- `GET /applications/{id}/history` is BR-08's trail and is readable by **both** sides.

### What the employer may see of the applicant (BR-09)

`GET /applications/{id}/candidate` returns the profile plus:

- **`phone`** — present only where the candidate's privacy settings **and** a hiring
  interaction both allow it. **Null is a normal answer, not an error.**
- **`canViewFiles`** and **`files[]`**, each with a `downloadPath` pointing at
  `/applications/{id}/files/{fileId}/content`. Not `/files/{id}/content`, which stays
  owner-only: the entitlement comes from the application, so the route that serves it is
  the one that can see it.
- **`exposureReason`** — a stable code (`application`, `no_interaction`,
  `hidden_by_candidate`, `not_verified_employer`, `accepted_invitation`, `admin`)
  saying which rule decided. Every call is logged (§11.1).

**A withdrawal revokes the exposure**, including in-flight download paths: BR-09 is
re-evaluated per download rather than trusted from the listing.

**Internal notes are employer-only** (§6.5). No candidate-facing response contains them,
and they live in their own table so exposing one would take a deliberate new query.

---

## 4e. Candidate search

Built 2026-08-07 with M7. The employer's half of discovery: §7's structured search over
the candidate database, and what an employer keeps from it.

```
POST  /candidate-search                             ->  { items: CandidateCard[], groups }
POST  /candidate-search/count                        ->  { count, isExact }
GET   /candidate-search/prefill/{vacancyId}           ->  CandidateSearchFilters
GET   /candidate-search/candidates/{id}                ->  CandidateForEmployer
GET   /candidate-search/candidates/{id}/photo           ->  bytes

GET   /candidate-search/saved                          ->  { items: CandidateCard[] }
PUT   /candidate-search/saved/{id}                      ->  204
DELETE/candidate-search/saved/{id}                      ->  204
PUT   /candidate-search/saved/{id}/note                 ->  204

GET   /vacancies/{id}/shortlist                          ->  { items: CandidateCard[] }
PUT   /vacancies/{id}/shortlist/{candidateUserId}         ->  204
DELETE/vacancies/{id}/shortlist/{candidateUserId}         ->  204
```

**Every route requires a verified employer** (§7, BR-03), including the saved list: an
employer who loses verification loses the candidate database, not just the search box.
`employer.profile_incomplete` and `employer.not_verified` are separate refusals because
they have different fixes.

### Why search is a POST

The filter set is nested — `languages` is an array of `{itemId, minLevelRank,
requireCertificate}` — and §7.1 has eleven groups. Encoding that into a query string
would trade a documented DTO for hand-rolled parsing on both sides. Both routes are
reads with no side effects; they are rate limited as §12.5 requires of search.

### The filters (§7.1)

All optional, all **dictionary ids** (BR-13). Two of §7.1's entries deliberately do not
appear as they are worded:

- **No `specialization` text filter.** It would be a substring match on prose, which
  cannot behave identically in four interface variants (§3.3). Education level and
  occupation are the id-shaped ways to ask the same question; if the client wants
  specialization, it needs a dictionary.
- **Remote-work readiness is `workFormatIds`**, not a boolean — remote is a
  `work_format` item, and every selectable value in this product is a row.

`skillsMatchMode` and `attributesMatchMode` are §7.1's "match all or match any", `any`
by default. `languages` are always **all** of them: two language requirements are two
requirements, and a level is a floor (`minLevelRank`), not an equality.

BR-12's `ageMin` / `ageMax` / `genderId` need `restrictionJustificationId` — an id from
the `restriction_justification` dictionary that the declaration permits for the kinds of
restriction present, the same rule a vacancy's restriction is held to.
`search.restriction_not_justified` otherwise, and every accepted use is logged.

### The card (§7.3)

**No phone number and no CV.** §11.1 forbids contact details on a search card, so the
card has no field for one and the query does not read `users` at all. `photoPath` is the
single candidate file a card carries, argued below. To reach contact details, open
`/candidate-search/candidates/{id}`, which is the same BR-09 answer
`/applications/{id}/candidate` gives — `phone`, `canViewFiles`, `files[]` and
`exposureReason` — and it is readable while the candidate is **findable** (searchable and
complete) or while an interaction exists. An applicant who then hides their profile stays
readable to the employer they wrote to.

`matchScore` is 0–100 and `matchBreakdown` says how it was reached: per group, `asked`
against `matched`. Only the groups the filters asked about take part, so a search for one
skill scores purely on that skill, and a search with no filters scores everyone 100.
`groups` on the response is the same list with the weights, so a client can render the
explanation without hardcoding them.

Sorts: `match` (default), `recent`, `experience`, `salary`. **Location proximity is not
offered** even though §7.3 allows it "where permission exists": places are dictionary ids
here, not coordinates, and a distance derived from a region tree would be a made-up
number in a control the employer would read as real.

### The profile photo is the one exception to BR-09's file gate

§7.3 puts a photo on the card; §5.4 keeps candidate files behind an authorized hiring
interaction. Both hold, because a profile photo is not a document: only the file whose
purpose is `photo`, only for a searchable profile, only for a verified employer, on one
route. A CV still needs an application or an accepted invitation.

### Saved candidates and shortlists (§7.3)

- `PUT .../saved/{id}` is idempotent — saving twice is saving once.
- The **private note lives on the save**, so writing one saves the candidate. It is
  never in a candidate-facing response.
- The shortlist is **per vacancy**, which is what "vacancy-specific" means; its owner is
  the vacancy's owner, so there is no second notion of who may edit it.
- **The saved list is still behind BR-02's gate**: a candidate who hides their profile
  leaves every employer's saved list, because otherwise "hide me from search" would be
  defeated by whoever saved them first. The row survives, so they come back if they
  choose to.

### Count-before-open (§7.2)

`{count, isExact}`. The count stops at `SEARCH_COUNT_CAP` (200 by default) and answers
`isExact: false`, so the client renders "200+" rather than a number presented as the
truth. §7.2 asks for this "where technically reasonable"; an exact count of a huge set is
the part that is not.

### Prefill from a vacancy (UAT-06)

`GET /candidate-search/prefill/{vacancyId}` returns a filter set the client may edit and
post back. **Mandatory requirements become filters; preferred ones do not** — a
preference that excluded candidates would not be a preference, and the score rewards it
instead. Mandatory skills prefill as match-all, which may match nobody: that is the
honest starting point, and it is what the count is for. A BR-12 restriction comes across
**with the justification the vacancy already carries**, so the employer is not asked to
re-justify a restriction the platform has reviewed.

---

## 4f. Invitations

Built 2026-08-07 with M7. §8.2, and the third action on §7.3's candidate card.

```
POST  /invitations                                 ->  Invitation      (employer)
GET   /invitations/sent?vacancyId=&status=          ->  { items: Invitation[] }
GET   /invitations/counts/{vacancyId}                ->  { byStatus }
GET   /invitations/{id}/files/{fileId}/content         ->  bytes

GET   /invitations/received                           ->  { items: Invitation[] }  (candidate)
POST  /invitations/{id}/respond                        ->  Invitation

GET   /invitations/{id}                                 ->  Invitation   (both)
GET   /invitations/{id}/history                          ->  { items }
```

### The two shapes, and why they are exclusive

§8.2: an employer may invite a candidate **to an active vacancy** or send a **general work
invitation** carrying occupation, location, schedule, payment and contact context. Exactly
one of `vacancyId` and `occupationId` must be present — `invitation.shape_invalid`
otherwise, and a CHECK constraint underneath. A vacancy invitation reads its details from
the vacancy; a general one carries `occupationId`, `regionId`, `districtId`, the four
salary fields, `scheduleNote` and `message` itself.

`scheduleNote` is free text on purpose: a general invitation is a message, and the
structured version of it is what publishing a vacancy is for.

### What sending one requires

- **A verified employer** (BR-03), the same gate as candidate search.
- **A search-visible candidate** (§8.2) — BR-02's gate again, so hiding a profile stops
  invitations and not merely search results. `candidate.profile_not_found`.
- **An active vacancy**, checked with the same definition of "open" the apply route uses
  (BR-06). An invitation must not advertise something the application would be refused
  for. `invitation.vacancy_not_open`.
- **One open invitation** per employer, candidate and vacancy — a partial unique index,
  BR-07's shape. Answering frees the slot, so an employer may invite again after a decline.
  `invitation.already_invited`.

Send an **`Idempotency-Key`**: a retry with the same key and body returns the original
invitation rather than that conflict, which is what makes a lost response safe (§12.4).

### Statuses

`sent` · `details_requested` · `accepted` · `declined`

Every transition is the candidate's — that is the whole of §8.2's "Accept, Decline, or
Request details" — so there is one response route and it is candidate-only.
`details_requested` is a **question, not an ending**: accepting or declining afterwards is
allowed, asking twice is not. `accepted` and `declined` are terminal. There is no
`withdrawn` and no `expired`: neither is in the specification, and a status nothing sets is
a state every client has to handle for nothing.

Every change writes a `GET /invitations/{id}/history` row with its time and actor (BR-08's
rule, applied beyond applications), and the candidate's `note` is kept as that row's
reason.

### Accepting opens BR-09's second interaction

Until the candidate accepts, an employer who invited them sees exactly what a stranger
sees: `phone: null`, `canViewFiles: false`, `exposureReason: 'no_interaction'`. Inviting
somebody is not an interaction they agreed to. On acceptance the reason becomes
`accepted_invitation` and the files arrive with `downloadPath` pointing at
`/invitations/{id}/files/{fileId}/content` — the invitation's counterpart to the
application-scoped download, for the same reason: the entitlement comes from the
interaction, so the route that serves the bytes is the one that can see it. Re-evaluated
per download.

### Counts

`GET /invitations/counts/{vacancyId}` answers the first half of §7.4's "track invited,
accepted, interviewed and hired counts against the target of 20". The other half is
application stages, from `/vacancies/{id}/applications/counts`.

---

## 5. Deferred

- **No `visibleIf` / conditional field visibility in v1.** Category-scoped
  schemas already satisfy §5.2's "irrelevant fields shall not be mandatory".
  The mobile `hh_conditional_field` rail is satisfied with the category as its
  trigger. If a real case appears it becomes an explicit versioned change.
- **Push and device registration are last** (client direction, 2026-08-04:
  MVP first, notifications last to build and test). Note the split: in-app
  notification *rows* are the record and are written by the flows that generate
  them from M6 onward; the dispatch adapter, device registration and the
  notification screen are the deferred part.
