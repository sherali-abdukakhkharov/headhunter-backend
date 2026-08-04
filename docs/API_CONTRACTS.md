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
`education_level` · `payment_period` · `file_purpose`

Everything selectable anywhere in the product is one of these. There is no
inline enum in any contract: BR-13 requires a stable id plus four locales, and
§10.3 requires admin management — both of which only the dictionary tables
provide.

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
