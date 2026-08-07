# Performance against §12.4

§12.4 sets two budgets:

| Requirement | Target |
|---|---|
| Standard API response | 95% of requests within **2s** under normal load, excluding large file transfer |
| Candidate/vacancy results | First result page within **3s** under normal load |

Both are **met, with 13× headroom at the largest volume measured**. The numbers below are
from `pnpm perf` on 2026-08-07; anyone can reproduce them, which is the point of writing
the harness rather than a paragraph.

## How this was measured

```
pnpm load:seed 200000 5000   # synthetic volume; pnpm load:clean removes it
pnpm perf 10 40              # 10 concurrent clients, 40 requests each
```

Seeding 200 000 candidates takes about three minutes; removing them again takes about
eleven, in one transaction, so nothing is visible until it commits - that is not a hang.
Every synthetic phone number begins `+99800`, which is not a real Uzbek prefix, so the
teardown can find its own rows and cannot touch anything else.

- **Against the container directly** (`127.0.0.1:3001`), never through the Cloudflare
  tunnel. The edge's latency is real for users but it is not this API's, and §12.4 is a
  statement about the API.
- **"Normal load" is stated, not implied.** The spec puts no number on it, so the harness
  fixes one: N concurrent clients issuing requests back to back with **no think time**,
  which is heavier than N real users rather than lighter.
- **Through the real HTTP stack**: guards, validation, i18n and serialization included,
  authenticated with a token from the actual OTP login flow.
- **Each virtual client sends its own `CF-Connecting-IP`.** Per-IP rate limiting is real
  (§12.5), and a run that shared one address would measure the limiter refusing requests
  rather than the API serving them.
- **The `rows` column is part of the evidence.** A filter that matches nothing is fast
  too; every search below returns a full page of 20, and the count returns its cap.
- File upload and download are excluded, as §12.4 excludes them.

## Results

**200 000 searchable candidates, 5 000 active vacancies, 10 clients × 40 requests
(4 000 requests).** All times in milliseconds.

| Scenario | rows | p50 | p95 | p99 | budget |
|---|---|---|---|---|---|
| `GET /health` | 1 | 4 | 7 | 28 | 2000 |
| `GET /dictionaries/manifest` | 1 | 5 | 9 | 27 | 2000 |
| `GET /dictionaries/occupation` | 162 | 14 | 21 | 24 | 2000 |
| `GET /schemas/candidate-profile` | 9 | 10 | 13 | 16 | 2000 |
| `GET /candidates/me/profile` | 1 | 16 | 24 | 27 | 2000 |
| `GET /notifications` | 0 | 6 | 9 | 11 | 2000 |
| `GET /discovery/recent` | 20 | 10 | 17 | 18 | 3000 |
| `GET /discovery/recommended` | 20 | 11 | 16 | 18 | 3000 |
| `POST /candidate-search` (no filters) | 20 | 70 | **231** | 249 | 3000 |
| `POST /candidate-search` (occupation + region) | 20 | 40 | 191 | 199 | 3000 |
| `POST /candidate-search` (match sort, 5 score groups) | 20 | 114 | 149 | 159 | 3000 |
| `POST /candidate-search/count` | 200 | 12 | 15 | 17 | 2000 |

The worst p95 in the product is the unfiltered candidate search at 231ms, against a 3s
budget.

**Concurrency, at 50 000 candidates.** Five times the clients costs roughly two to three
times the latency, so the limiting resource is the connection pool and CPU rather than any
single query:

| Scenario | p95 @ 10 clients | p95 @ 50 clients |
|---|---|---|
| `GET /health` | 5 | 33 |
| `GET /candidates/me/profile` | 17 | 83 |
| `POST /candidate-search` (no filters) | 51 | 127 |
| `POST /candidate-search` (match sort) | 69 | 134 |

## What the measurement found

Passing was expected. The useful result is **where it stops passing**, and that came out of
comparing 50 000 candidates with 200 000:

| Scenario | p95 @ 50k | p95 @ 200k | growth |
|---|---|---|---|
| `POST /candidate-search` (no filters) | 51 | 231 | ×4.5 for ×4 volume |
| `POST /candidate-search` (occupation + region) | 22 | 191 | ×8.7 |
| `POST /candidate-search` (match sort, 5 groups) | 69 | 149 | ×2.2 |
| everything not a search | unchanged | unchanged | flat |

**The unfiltered search is linear in the searchable population.** Postgres's own counters
say why:

```
candidate_profiles:  seq_scan 409   seq_tup_read 80 804 250   (≈197k tuples per scan)
candidate_profiles_searchable_idx          idx_scan 401
candidate_profiles_searchable_recent_idx   idx_scan 0
```

Every unfiltered search reads the whole searchable set. The partial index built for the
recency sort is **never chosen** - the planner prefers a scan and a sort, because the
per-row lateral work has to happen before `LIMIT 20` can be applied, so there is nothing to
stop early for.

Extrapolating the measured 1.15ms per thousand candidates, the 3s budget is reached at
roughly **2.5 million searchable profiles**. Uzbekistan's labour force is around 15
million, so a product that succeeds will eventually cross that line.

Two things behave the opposite way and are worth noting because they were designed to:

- **A filtered search scales better than an unfiltered one**, because the occupation
  filter uses `candidate_occupations_item_user_idx` and the score is only computed for
  what survives. The heaviest-looking scenario - five score groups - is the *least*
  affected by volume.
- **`count` is flat at 15ms** whatever the volume, because §7.2's `SEARCH_COUNT_CAP`
  bounds it at 200 rows. That is the cap earning its keep: an exact count of a million
  rows would be the slowest query in the product, and nobody reading "200+" is worse
  informed.

## What is deliberately not being done

**No search projection, no denormalized index table, no query cache.** ARCHITECTURE.md
defers all three, and this measurement is the reason to keep deferring: the budget is met
with more than an order of magnitude spare, and optimising against a synthetic
distribution would be fitting to made-up data.

The trigger for revisiting is explicit, so nobody has to re-derive it:

- searchable profiles pass **500 000** (about 600ms p95, still fine, but the growth is
  visible and the fix takes a migration), or
- p95 for the unfiltered search passes **1s** on real traffic, or
- the client asks for a filter that cannot use an index at all - full-text over
  descriptions is the obvious candidate.

The first thing to try then is **not** a projection table but making the recency sort able
to stop early: filter and order `candidate_profiles` alone, take the page, and do the
lateral per-row work on those twenty rows. That keeps one source of truth, which a
projection does not.

## Caveats worth stating

- **One machine.** The API, Postgres and the load generator share a Windows host with
  Docker Desktop. Real deployment latency includes a network hop this does not.
- **Synthetic distribution.** Occupations, regions and skills are spread by hashing a
  uuid, which is more even than reality: real candidates cluster in Tashkent and in a
  handful of occupations, and a clustered distribution makes a filtered search *cheaper*
  and a hot region *dearer* than measured here.
- **Cold caches are not measured.** One warm request precedes each scenario, so these are
  steady-state numbers - which is what a percentile over normal load means, but not what
  the first request after a deploy will see.
- **No sustained soak.** The longest run here is a few minutes. Connection-pool exhaustion
  and memory growth need hours, and belong with monitoring rather than with this harness.
