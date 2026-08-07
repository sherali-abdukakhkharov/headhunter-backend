/**
 * Measures §12.4's two latency budgets against a running API.
 *
 *   pnpm load:seed          # volume first, or this measures an empty database
 *   pnpm perf               # 127.0.0.1:3001, 10 concurrent clients, 40 requests each
 *   pnpm perf 20 60         # 20 clients, 60 requests each
 *
 * §12.4 asks that 95% of standard requests finish within 2s and that the first page of
 * results comes back within 3s, both "under normal load". The spec puts no number on
 * normal load, so this states one instead of implying it: N concurrent clients, each
 * issuing requests back to back with no think time - which is heavier than N real
 * users, not lighter.
 *
 * Measured against the container directly, never through the tunnel: Cloudflare's
 * latency is real for users but it is not this API's, and §12.4 is a statement about
 * the API. Each virtual client sends its own `CF-Connecting-IP`, which the deployment
 * trusts - so per-IP rate limits treat them as the distinct callers they represent
 * rather than throttling the whole run as one address.
 *
 * Exits non-zero when a budget is missed, so this is a check rather than a report.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as dotenv from 'dotenv';

interface Scenario {
  name: string;
  /** §12.4 splits its budgets by kind, and so does the report. */
  kind: 'standard' | 'results';
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  as: 'employer' | 'candidate' | 'anonymous';
}

interface Sample {
  ms: number;
  status: number;
  /** Kept for the first failure only, so a 4xx says why rather than just how many. */
  detail?: string;
}

const BUDGET_MS = { standard: 2000, results: 3000 } as const;

/**
 * A fresh block of virtual addresses per run.
 *
 * Rate limiting is a **one-hour** fixed window keyed by IP (§12.5), and one run costs
 * each of its addresses `scenarios x perClient` requests. Reusing the same block would
 * therefore measure the limiter refusing the second run rather than the API serving
 * it - which is exactly what happened the first time this was written. A run
 * represents different callers each time, because it does.
 */
const RUN_BLOCK = Math.floor(Date.now() / 1000) % 250;

/** The seeded synthetic accounts - `pnpm load:seed` creates both. */
const EMPLOYER_PHONE = '+998009999999';
const CANDIDATE_PHONE = '+998000000001';

async function main(): Promise<void> {
  dotenv.config({ quiet: true });

  const clients = Number(process.argv[2] ?? 10);
  const perClient = Number(process.argv[3] ?? 40);
  const baseUrl = process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3001';

  console.log(
    `measuring ${baseUrl} with ${clients} clients x ${perClient} requests`,
  );

  const tokens = {
    employer: await login(baseUrl, EMPLOYER_PHONE, 'employer'),
    candidate: await login(baseUrl, CANDIDATE_PHONE, 'candidate'),
    anonymous: null,
  };

  const volume = await countVolume(baseUrl, tokens.employer);
  console.log(
    `searchable candidates: ${volume.count}${volume.isExact ? '' : '+ (SEARCH_COUNT_CAP)'}\n`,
  );

  // The count is deliberately bounded by SEARCH_COUNT_CAP (§7.2), so an inexact answer
  // is itself the confirmation that there is more than the cap to search - and an
  // exact small number is the only thing that means the volume is missing.
  if (volume.isExact && volume.count < 1000) {
    console.log(
      'WARNING: few searchable candidates - run `pnpm load:seed` first.\n',
    );
  }

  const scenarios = await buildScenarios(baseUrl);
  const failures: string[] = [];

  console.log(
    'scenario'.padEnd(42) +
      'rows'.padStart(6) +
      'n'.padStart(6) +
      'p50'.padStart(8) +
      'p95'.padStart(8) +
      'p99'.padStart(8) +
      'max'.padStart(8) +
      'budget'.padStart(9) +
      '  verdict',
  );
  console.log('-'.repeat(100));

  for (const scenario of scenarios) {
    const { samples, rows } = await run(
      baseUrl,
      scenario,
      tokens,
      clients,
      perClient,
    );
    const ok = samples.filter((sample) => sample.status < 400);
    const times = ok.map((sample) => sample.ms).sort((a, b) => a - b);
    const budget = BUDGET_MS[scenario.kind];
    const p95 = percentile(times, 95);
    const passed = times.length > 0 && p95 <= budget;

    if (!passed) {
      failures.push(scenario.name);
    }

    const bad = samples.filter((sample) => sample.status >= 400);
    const firstBad = bad[0];

    console.log(
      scenario.name.padEnd(42) +
        String(rows).padStart(6) +
        String(times.length).padStart(6) +
        fmt(percentile(times, 50)).padStart(8) +
        fmt(p95).padStart(8) +
        fmt(percentile(times, 99)).padStart(8) +
        fmt(times[times.length - 1] ?? 0).padStart(8) +
        `${budget}ms`.padStart(9) +
        `  ${passed ? 'PASS' : 'FAIL'}`,
    );

    if (firstBad) {
      console.log(
        `  ${bad.length}/${samples.length} answered ${firstBad.status}: ${firstBad.detail ?? ''}`,
      );
    }
  }

  console.log('');

  if (failures.length > 0) {
    console.log(`MISSED the budget: ${failures.join(', ')}`);
    // exitCode rather than exit(): a hard exit with sockets still open trips a libuv
    // assertion on Windows, which would bury the report it just printed.
    process.exitCode = 1;
    return;
  }

  console.log('every scenario within its §12.4 budget');
}

/** Percentile by nearest rank, which is what "at least 95% of requests" means. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }

  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );

  return sorted[Math.max(0, index)];
}

function fmt(ms: number): string {
  return Number.isNaN(ms) ? '-' : `${Math.round(ms)}`;
}

/**
 * Where a token is kept between runs.
 *
 * A real client holds its access token; a harness that logs in on every run does not,
 * and would hit RATE_LIMIT_OTP_PER_PHONE (five an hour) on the sixth measurement. That
 * limit is correct - each send is an SMS somebody pays for - so the harness caches
 * instead of asking for it to be relaxed. Outside the repository, because it holds a
 * live bearer token.
 */
const TOKEN_CACHE = join(tmpdir(), 'headhunter-perf-tokens.json');

/** Well inside ACCESS_TOKEN_TTL_SECONDS, so a cached token cannot expire mid-run. */
const TOKEN_REUSE_SECONDS = 600;

function cachedToken(phone: string): string | null {
  try {
    const cache = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')) as Record<
      string,
      { token: string; at: number } | undefined
    >;
    const entry = cache[phone];

    if (entry && Date.now() - entry.at < TOKEN_REUSE_SECONDS * 1000) {
      return entry.token;
    }
  } catch {
    // No cache yet, or unreadable - log in.
  }

  return null;
}

function cacheToken(phone: string, token: string): void {
  let cache: Record<string, { token: string; at: number }> = {};

  try {
    cache = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')) as typeof cache;
  } catch {
    // First run.
  }

  cache[phone] = { token, at: Date.now() };
  writeFileSync(TOKEN_CACHE, JSON.stringify(cache), { mode: 0o600 });
}

/** A token, through the real login flow - send, verify, and choose the role (§2.3). */
async function login(
  baseUrl: string,
  phone: string,
  role: 'employer' | 'candidate',
): Promise<string> {
  const reused = cachedToken(phone);

  if (reused) {
    const check = await request(baseUrl, 'GET', '/users/me', {
      token: reused,
      ip: `10.${RUN_BLOCK}.255.1`,
    });

    if (check.status < 400) {
      return reused;
    }
  }

  const code = await sendAndReadCode(baseUrl, phone);

  const verified = await request(baseUrl, 'POST', '/auth/otp/verify', {
    body: { phone, code, locale: 'uz-Latn' },
    ip: `10.${RUN_BLOCK}.255.1`,
  });

  const tokens = verified.json as {
    accessToken?: string;
    roles?: string[];
    activeRole?: string | null;
  };

  if (!tokens.accessToken) {
    throw new Error(
      `login failed for ${phone}: ${JSON.stringify(verified.json)}`,
    );
  }

  if (!tokens.roles?.includes(role)) {
    // Registration and login are deliberately the same call (§4.1), so the send above
    // has just *created* this account rather than found it - which is why the recovery
    // is clean-then-seed and not seed alone: the seeder refuses to run while any
    // synthetic row exists, including the empty one this line is reporting.
    throw new Error(
      `${phone} holds no ${role} role (got ${JSON.stringify(tokens.roles)}).\n` +
        'The synthetic accounts are missing. Run: pnpm load:clean && pnpm load:seed',
    );
  }

  if (tokens.activeRole === role) {
    cacheToken(phone, tokens.accessToken);

    return tokens.accessToken;
  }

  // A multi-role account has to say which role it is acting as (§2.3), and the answer
  // is a new pair of tokens rather than a header.
  const switched = await request(baseUrl, 'POST', '/auth/active-role', {
    body: { role },
    token: tokens.accessToken,
    ip: `10.${RUN_BLOCK}.255.1`,
  });

  const after =
    (switched.json as { accessToken?: string }).accessToken ??
    tokens.accessToken;
  cacheToken(phone, after);

  return after;
}

/**
 * Sends an OTP and reads the code back, waiting out the resend delay if it has to.
 *
 * OTP_ECHO_IN_RESPONSE returns the code instead of sending an SMS, which is the only
 * reason this can run unattended - and it is the same code path a real client uses.
 *
 * A rerun within OTP_RESEND_DELAY_SECONDS is refused, and there is deliberately no way
 * around that: OTP_STATIC_CODE fixes *which* code is issued, it does not add a second
 * acceptance path in `verify`, so a known code with no live unconsumed row still fails.
 * Waiting is the only correct answer, and the wait is bounded by the delay itself.
 */
async function sendAndReadCode(
  baseUrl: string,
  phone: string,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sent = await request(baseUrl, 'POST', '/auth/otp/send', {
      body: { phone, purpose: 'login' },
      ip: `10.${RUN_BLOCK}.255.1`,
    });

    const body = sent.json as { devCode?: string; code?: string };

    if (body.devCode) {
      return body.devCode;
    }

    if (body.code !== 'auth.otp_resend_too_soon' || attempt === 1) {
      throw new Error(
        `no devCode in the send response - OTP_ECHO_IN_RESPONSE must be on: ${JSON.stringify(sent.json)}`,
      );
    }

    const wait = Number(process.env.OTP_RESEND_DELAY_SECONDS ?? 60) + 1;
    console.log(`  resend delay for ${phone}; waiting ${wait}s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }

  throw new Error(`could not obtain an OTP for ${phone}`);
}

async function countVolume(
  baseUrl: string,
  employerToken: string,
): Promise<{ count: number; isExact: boolean }> {
  const counted = await request(baseUrl, 'POST', '/candidate-search/count', {
    body: { filters: {} },
    token: employerToken,
    ip: `10.${RUN_BLOCK}.255.2`,
  });

  const body = counted.json as { count?: number; isExact?: boolean };

  return { count: body.count ?? 0, isExact: body.isExact ?? true };
}

/**
 * The scenarios, chosen as the client's own hot paths.
 *
 * The searches are the ones §7 puts on the employer's first screen: everybody, then a
 * filtered set, then the two sorts that cannot use an index alone (match score and
 * proximity), which are the realistic worst case for the 3s budget.
 */
async function buildScenarios(baseUrl: string): Promise<Scenario[]> {
  const dictionary = await request(baseUrl, 'GET', '/dictionaries/occupation', {
    ip: `10.${RUN_BLOCK}.255.3`,
  });

  // Three occupations, so the filter matches a slice of the body rather than all of
  // it: a filter every row satisfies measures a sequential scan, not a filter.
  const occupations = (
    (dictionary.json as { items?: { id: string }[] }).items ?? []
  )
    .slice(0, 3)
    .map((item) => item.id);

  const regions = await request(baseUrl, 'GET', '/dictionaries/region', {
    ip: `10.${RUN_BLOCK}.255.3`,
  });
  const regionId = (
    (regions.json as { items?: { id: string; parentId?: string | null }[] })
      .items ?? []
  ).find((item) => !item.parentId)?.id;

  const page = { limit: 20, offset: 0 };

  return [
    {
      name: 'GET /health',
      kind: 'standard',
      method: 'GET',
      path: '/health',
      as: 'anonymous',
    },
    {
      name: 'GET /dictionaries/manifest',
      kind: 'standard',
      method: 'GET',
      path: '/dictionaries/manifest',
      as: 'anonymous',
    },
    {
      // The heaviest public payload in the product: every occupation with four
      // localized labels, which every client fetches on first run.
      name: 'GET /dictionaries/occupation',
      kind: 'standard',
      method: 'GET',
      path: '/dictionaries/occupation',
      as: 'anonymous',
    },
    {
      name: 'GET /schemas/candidate-profile',
      kind: 'standard',
      method: 'GET',
      path: '/schemas/candidate-profile?category=professional',
      as: 'candidate',
    },
    {
      name: 'GET /candidates/me/profile',
      kind: 'standard',
      method: 'GET',
      path: '/candidates/me/profile',
      as: 'candidate',
    },
    {
      name: 'GET /notifications',
      kind: 'standard',
      method: 'GET',
      path: '/notifications?limit=20',
      as: 'candidate',
    },
    {
      name: 'GET /discovery/recent',
      kind: 'results',
      method: 'GET',
      path: '/discovery/recent?limit=20&offset=0',
      as: 'candidate',
    },
    {
      name: 'GET /discovery/recommended',
      kind: 'results',
      method: 'GET',
      path: '/discovery/recommended?limit=20&offset=0',
      as: 'candidate',
    },
    {
      name: 'POST /candidate-search (no filters)',
      kind: 'results',
      method: 'POST',
      path: '/candidate-search',
      body: { filters: {}, sort: 'recent', ...page },
      as: 'employer',
    },
    {
      name: 'POST /candidate-search (occupation+region)',
      kind: 'results',
      method: 'POST',
      path: '/candidate-search',
      body: {
        filters: {
          occupationIds: occupations,
          ...(regionId ? { regionId } : {}),
        },
        sort: 'match',
        ...page,
      },
      as: 'employer',
    },
    {
      name: 'POST /candidate-search (match sort, 5 groups)',
      kind: 'results',
      method: 'POST',
      path: '/candidate-search',
      body: {
        filters: {
          occupationIds: occupations,
          ...(regionId ? { regionId } : {}),
          experienceYearsMin: 2,
          minCompleteness: 70,
          availableImmediately: false,
        },
        sort: 'match',
        ...page,
      },
      as: 'employer',
    },
    {
      name: 'POST /candidate-search/count',
      kind: 'standard',
      method: 'POST',
      path: '/candidate-search/count',
      body: { filters: { occupationIds: occupations } },
      as: 'employer',
    },
  ];
}

async function run(
  baseUrl: string,
  scenario: Scenario,
  tokens: Record<string, string | null>,
  clients: number,
  perClient: number,
): Promise<{ samples: Sample[]; rows: number }> {
  const token = tokens[scenario.as];

  // One warm request outside the measurement: the first call to a route pays for the
  // plan cache and the connection, and reporting that as a percentile would be
  // measuring the process starting up.
  const warm = await request(baseUrl, scenario.method, scenario.path, {
    body: scenario.body,
    token,
    ip: `10.${RUN_BLOCK}.255.9`,
  });

  const results = await Promise.all(
    Array.from({ length: clients }, async (_unused, client) => {
      const samples: Sample[] = [];
      // A distinct address per client: per-IP rate limits are real, and a run that
      // shared one would measure 429s rather than latency.
      const ip = `10.${RUN_BLOCK}.${Math.floor(client / 256)}.${client % 256}`;

      for (let i = 0; i < perClient; i += 1) {
        const startedAt = performance.now();
        const response = await request(
          baseUrl,
          scenario.method,
          scenario.path,
          {
            body: scenario.body,
            token,
            ip,
          },
        );

        samples.push({
          ms: performance.now() - startedAt,
          status: response.status,
          detail:
            response.status >= 400
              ? JSON.stringify(response.json).slice(0, 200)
              : undefined,
        });
      }

      return samples;
    }),
  );

  return { samples: results.flat(), rows: rowsIn(warm.json) };
}

/** The payload size a scenario returns, however the route happens to shape it. */
function rowsIn(json: unknown): number {
  if (json === null || typeof json !== 'object') {
    return 0;
  }

  const body = json as {
    items?: unknown[];
    count?: number;
    sections?: unknown[];
  };

  if (Array.isArray(body.items)) {
    return body.items.length;
  }

  if (typeof body.count === 'number') {
    return body.count;
  }

  if (Array.isArray(body.sections)) {
    return body.sections.length;
  }

  return 1;
}

async function request(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; token?: string | null; ip?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'x-lang': 'uz-Latn' };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  if (options.ip) {
    headers['cf-connecting-ip'] = options.ip;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  // Read the body even when it is discarded: a measurement that stops at the headers
  // is not measuring what a client waits for.
  const text = await response.text();

  let json: unknown = text;

  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON - a plain-text error page, which the status code already reports.
  }

  return { status: response.status, json };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
