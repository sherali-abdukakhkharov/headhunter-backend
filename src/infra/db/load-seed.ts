/**
 * Synthetic volume, for measuring §12.4's latency budgets.
 *
 *   pnpm load:seed          50 000 searchable candidates and 5 000 active vacancies
 *   pnpm load:seed 10000    a smaller body
 *   pnpm load:clean         removes every row this ever wrote
 *
 * **Not the dictionary seeder** (`pnpm seed`), and not a fixture builder. Every other
 * seeding path in this repository goes through the production write path on purpose;
 * this one is deliberately raw `INSERT ... SELECT generate_series`, because 50 000
 * profiles through `CandidatesService.patch` is hours of validation to produce rows
 * whose *content* nobody reads. What matters here is the shape and the volume: the
 * rows must satisfy BR-02's gate and carry the child rows every filter joins to, or
 * the measurement is of an empty table.
 *
 * Everything it writes is identifiable and reversible: the phone numbers are all
 * `+99800…`, which is not a real Uzbek mobile prefix, so `load:clean` can find them
 * without a marker column and without ever touching a real row.
 */
import * as dotenv from 'dotenv';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from './database.types';
import { configurePgTypeParsers } from './pg-types';

/** No real Uzbek mobile number starts with these digits, so nothing else can match. */
const LOAD_PHONE_PREFIX = '+99800';

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  configurePgTypeParsers();

  const candidateCount = Number(process.argv[2] ?? 50_000);
  const vacancyCount = Number(
    process.argv[3] ?? Math.ceil(candidateCount / 10),
  );
  const clean = process.argv.includes('--clean');

  const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5435),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5_000,
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  try {
    if (clean) {
      await removeLoadRows(db);
      return;
    }

    await seed(db, candidateCount, vacancyCount);
  } finally {
    await db.destroy();
  }
}

async function removeLoadRows(db: Kysely<DB>): Promise<void> {
  // ON DELETE CASCADE from `users` carries the profile and all of its child rows, so
  // one statement is the whole teardown - the reason the prefix trick is worth it.
  //
  // It is also slow, and silent while it runs: 200 000 candidates is about 1.2 million
  // cascaded rows and took eleven minutes here, in one transaction, so nothing is
  // visible until it commits. That is not a hang.
  const result = await sql<{ count: string }>`
    WITH removed AS (
      DELETE FROM users WHERE phone LIKE ${LOAD_PHONE_PREFIX + '%'} RETURNING 1
    )
    SELECT count(*) AS count FROM removed
  `.execute(db);

  console.log(
    `removed ${result.rows[0]?.count ?? 0} synthetic users and everything they owned`,
  );
}

async function seed(
  db: Kysely<DB>,
  candidateCount: number,
  vacancyCount: number,
): Promise<void> {
  const existing = await sql<{ count: string }>`
    SELECT count(*) AS count FROM users WHERE phone LIKE ${LOAD_PHONE_PREFIX + '%'}
  `.execute(db);

  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    console.log('synthetic rows already present - run `pnpm load:clean` first');
    return;
  }

  console.log(
    `seeding ${candidateCount} candidates and ${vacancyCount} vacancies`,
  );
  const startedAt = Date.now();

  // One transaction: a half-seeded database would silently measure the wrong volume.
  await db.transaction().execute(async (trx) => {
    // Dictionary ids, picked once. `generate_series` then indexes into these arrays by
    // modulo, which is what spreads the rows across regions and occupations - a body
    // of candidates who all share one occupation would make every filter either match
    // everything or nothing, and measure neither.
    await sql`
      CREATE TEMP TABLE load_pick AS
      SELECT
        (SELECT array_agg(id ORDER BY id) FROM dictionary_items
          WHERE type_code = 'occupation' AND is_active) AS occupations,
        (SELECT array_agg(id ORDER BY id) FROM dictionary_items
          WHERE type_code = 'region' AND parent_id IS NULL AND is_active) AS regions,
        (SELECT array_agg(id ORDER BY id) FROM dictionary_items
          WHERE type_code = 'skill' AND is_active) AS skills,
        (SELECT array_agg(id ORDER BY id) FROM dictionary_items
          WHERE type_code = 'language' AND is_active) AS languages,
        (SELECT array_agg(id ORDER BY id) FROM dictionary_items
          WHERE type_code = 'employment_type' AND is_active) AS employment_types,
        (SELECT array_agg(id ORDER BY id) FROM dictionary_items
          WHERE type_code = 'skill_level' AND is_active) AS skill_levels,
        (SELECT array_agg(id ORDER BY rank) FROM dictionary_items
          WHERE type_code = 'language_level' AND is_active) AS language_levels,
        (SELECT array_agg(rank ORDER BY rank) FROM dictionary_items
          WHERE type_code = 'language_level' AND is_active) AS language_ranks,
        (SELECT id FROM dictionary_items
          WHERE type_code = 'payment_period' AND code = 'monthly') AS monthly
    `.execute(trx);

    await sql`
      INSERT INTO users (phone, locale, status, created_at)
      SELECT
        ${LOAD_PHONE_PREFIX} || lpad(n::text, 7, '0'),
        (ARRAY['uz-Latn','uz-Cyrl','ru','en'])[1 + n % 4]::locale_code,
        'active',
        now() - make_interval(days => (n % 365)::int)
      FROM generate_series(1, ${candidateCount}::int) AS n
    `.execute(trx);

    await sql`
      INSERT INTO user_roles (user_id, role)
      SELECT id, 'candidate' FROM users WHERE phone LIKE ${LOAD_PHONE_PREFIX + '%'}
    `.execute(trx);

    // The profile itself. `is_complete` and `visibility` are set directly, which is
    // the one thing this script asserts rather than derives - BR-02's gate is what
    // the search filters on, and computing it here would duplicate
    // `completeness.ts` for no gain.
    await sql`
      INSERT INTO candidate_profiles (
        user_id, full_name, date_of_birth, region_id, district_id, category,
        available_from, salary_from, salary_to, salary_period_id, visibility,
        completeness_percent, is_complete, last_meaningful_update_at
      )
      SELECT
        u.id,
        'Nomzod ' || right(u.phone, 7),
        (date '1970-01-01' + make_interval(days => ((row_number() OVER (ORDER BY u.id) * 37) % 11000)::int))::date,
        r.region_id,
        d.id,
        o.category,
        current_date + make_interval(days => ((row_number() OVER (ORDER BY u.id)) % 60)::int),
        2000000 + ((row_number() OVER (ORDER BY u.id)) % 20) * 500000,
        4000000 + ((row_number() OVER (ORDER BY u.id)) % 20) * 500000,
        p.monthly,
        'searchable',
        70 + ((row_number() OVER (ORDER BY u.id)) % 31),
        true,
        now() - make_interval(hours => ((row_number() OVER (ORDER BY u.id)) % 8760)::int)
      FROM users u
      CROSS JOIN load_pick p
      CROSS JOIN LATERAL (
        SELECT p.regions[1 + (('x' || substr(md5(u.id::text), 1, 8))::bit(32)::bigint % array_length(p.regions, 1))] AS region_id
      ) r
      CROSS JOIN LATERAL (
        SELECT id FROM dictionary_items
        WHERE parent_id = r.region_id AND is_active
        ORDER BY md5(u.id::text || id::text) LIMIT 1
      ) d
      CROSS JOIN LATERAL (
        SELECT id, category FROM dictionary_items
        WHERE type_code = 'occupation' AND is_active
        ORDER BY md5(u.id::text) LIMIT 1
      ) o
      WHERE u.phone LIKE ${LOAD_PHONE_PREFIX + '%'}
    `.execute(trx);

    // A primary occupation each: without one no occupation filter matches, and that
    // filter is on the hot path of every search the client will run.
    await sql`
      INSERT INTO candidate_occupations (user_id, item_id, is_primary)
      SELECT cp.user_id, o.id, true
      FROM candidate_profiles cp
      JOIN users u ON u.id = cp.user_id
      CROSS JOIN LATERAL (
        SELECT id FROM dictionary_items
        WHERE type_code = 'occupation' AND is_active AND category = cp.category
        ORDER BY md5(cp.user_id::text || id::text) LIMIT 1
      ) o
      WHERE u.phone LIKE ${LOAD_PHONE_PREFIX + '%'}
    `.execute(trx);

    // Three skills and two languages each - enough that a match-all filter has to do
    // real counting work rather than short-circuiting on an empty table.
    await sql`
      INSERT INTO candidate_skills (user_id, item_id, level_id, level_rank)
      SELECT cp.user_id, s.id, l.id, l.rank
      FROM candidate_profiles cp
      JOIN users u ON u.id = cp.user_id
      CROSS JOIN generate_series(1, 3) AS k
      CROSS JOIN LATERAL (
        SELECT id FROM dictionary_items
        WHERE type_code = 'skill' AND is_active
        ORDER BY md5(cp.user_id::text || k::text || id::text) LIMIT 1
      ) s
      CROSS JOIN LATERAL (
        SELECT id, coalesce(rank, sort_order) AS rank FROM dictionary_items
        WHERE type_code = 'skill_level' AND is_active
        ORDER BY md5(cp.user_id::text || k::text) LIMIT 1
      ) l
      WHERE u.phone LIKE ${LOAD_PHONE_PREFIX + '%'}
      ON CONFLICT DO NOTHING
    `.execute(trx);

    await sql`
      INSERT INTO candidate_languages (user_id, item_id, level_id, level_rank, has_certificate)
      SELECT cp.user_id, g.id, l.id, l.rank, (('x' || substr(md5(cp.user_id::text), 1, 8))::bit(32)::bigint % 5) = 0
      FROM candidate_profiles cp
      JOIN users u ON u.id = cp.user_id
      CROSS JOIN generate_series(1, 2) AS k
      CROSS JOIN LATERAL (
        SELECT id FROM dictionary_items
        WHERE type_code = 'language' AND is_active
        ORDER BY md5(cp.user_id::text || k::text || id::text) LIMIT 1
      ) g
      CROSS JOIN LATERAL (
        SELECT id, rank FROM dictionary_items
        WHERE type_code = 'language_level' AND is_active AND rank IS NOT NULL
        ORDER BY md5(cp.user_id::text || k::text) LIMIT 1
      ) l
      WHERE u.phone LIKE ${LOAD_PHONE_PREFIX + '%'}
      ON CONFLICT DO NOTHING
    `.execute(trx);

    // Experience, because §7.1's "years in occupation" filter reads these rows and
    // aggregates them - the most expensive predicate in the search.
    await sql`
      INSERT INTO candidate_experience (
        user_id, employer_name, role_title, occupation_id, started_on, ended_on, is_current
      )
      SELECT
        co.user_id,
        'Korxona ' || right(u.phone, 4),
        'Mutaxassis',
        co.item_id,
        (current_date - make_interval(years => (2 + (('x' || substr(md5(co.user_id::text), 1, 8))::bit(32)::bigint % 8))::int))::date,
        NULL,
        true
      FROM candidate_occupations co
      JOIN users u ON u.id = co.user_id
      WHERE u.phone LIKE ${LOAD_PHONE_PREFIX + '%'} AND co.is_primary
    `.execute(trx);

    // A work-preference attribute each, so §7.1's employment-type filter - which the
    // client's own screens default to - has rows to read.
    await sql`
      INSERT INTO candidate_attributes (user_id, field_code, item_id)
      SELECT cp.user_id, 'employment_type_ids', e.id
      FROM candidate_profiles cp
      JOIN users u ON u.id = cp.user_id
      CROSS JOIN LATERAL (
        SELECT id FROM dictionary_items
        WHERE type_code = 'employment_type' AND is_active
        ORDER BY md5(cp.user_id::text) LIMIT 1
      ) e
      WHERE u.phone LIKE ${LOAD_PHONE_PREFIX + '%'}
      ON CONFLICT DO NOTHING
    `.execute(trx);

    await seedVacancies(trx, vacancyCount);

    await sql`DROP TABLE load_pick`.execute(trx);
  });

  // The planner chooses differently at 50 000 rows than at 10, and it only knows that
  // after ANALYZE. Measuring before this runs measures stale statistics.
  console.log('analyzing');
  await sql`ANALYZE`.execute(db);

  const counts = await sql<{
    candidates: string;
    searchable: string;
    vacancies: string;
    skills: string;
  }>`
    SELECT
      (SELECT count(*) FROM candidate_profiles) AS candidates,
      (SELECT count(*) FROM candidate_profiles WHERE visibility = 'searchable' AND is_complete) AS searchable,
      (SELECT count(*) FROM vacancies WHERE status = 'active') AS vacancies,
      (SELECT count(*) FROM candidate_skills) AS skills
  `.execute(db);

  console.log(counts.rows[0]);
  console.log(`done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

/** Active vacancies for the candidate-side feeds, owned by one synthetic employer. */
async function seedVacancies(
  trx: Kysely<DB>,
  vacancyCount: number,
): Promise<void> {
  const employer = await sql<{ id: string }>`
    INSERT INTO users (phone, locale, status)
    VALUES (${LOAD_PHONE_PREFIX + '9999999'}, 'uz-Latn', 'active')
    RETURNING id
  `.execute(trx);

  const employerUserId = employer.rows[0]?.id;

  if (!employerUserId) {
    throw new Error('failed to create the synthetic employer');
  }

  await sql`INSERT INTO user_roles (user_id, role) VALUES (${employerUserId}, 'employer')`.execute(
    trx,
  );

  // The company half of an employer profile is its own table (`companies`), so this
  // is two inserts - the same split `EmployersService.upsert` writes through.
  await sql`
    INSERT INTO employers (
      user_id, type, contact_phone, region_id, description,
      verification_status, verified_at, completeness_percent, is_complete
    )
    SELECT
      ${employerUserId}, 'company', '+998901234567',
      (SELECT id FROM dictionary_items WHERE type_code = 'region' AND parent_id IS NULL AND is_active ORDER BY id LIMIT 1),
      'Synthetic employer for load measurement.', 'verified', now(), 100, true
  `.execute(trx);

  await sql`
    INSERT INTO companies (employer_user_id, legal_name, public_name, industry_id, contact_person_name)
    SELECT
      ${employerUserId}, 'Load Test LLC', 'LoadTest',
      (SELECT id FROM dictionary_items WHERE type_code = 'industry' AND is_active ORDER BY id LIMIT 1),
      'Anvar Karimov'
  `.execute(trx);

  await sql`
    INSERT INTO vacancies (
      employer_user_id, category, occupation_id, title, description, worker_count,
      region_id, district_id, salary_from, salary_to, salary_period_id,
      status, published_at, deadline_on
    )
    SELECT
      ${employerUserId},
      o.category,
      o.id,
      'Ish oʻrni ' || n,
      'Synthetic vacancy for load measurement; content is not read by any assertion.',
      1 + n % 20,
      d.region_id,
      d.id,
      3000000 + (n % 15) * 500000,
      5000000 + (n % 15) * 500000,
      (SELECT id FROM dictionary_items WHERE type_code = 'payment_period' AND code = 'monthly'),
      'active',
      now() - make_interval(hours => (n % 2000)::int),
      (current_date + make_interval(days => (30 + n % 60)::int))::date
    FROM generate_series(1, ${vacancyCount}::int) AS n
    CROSS JOIN LATERAL (
      SELECT id, category FROM dictionary_items
      WHERE type_code = 'occupation' AND is_active
      ORDER BY md5(n::text) LIMIT 1
    ) o
    CROSS JOIN LATERAL (
      SELECT di.id, di.parent_id AS region_id FROM dictionary_items di
      JOIN dictionary_items parent ON parent.id = di.parent_id
      WHERE parent.type_code = 'region' AND parent.parent_id IS NULL AND di.is_active
      ORDER BY md5(n::text || di.id::text) LIMIT 1
    ) d
  `.execute(trx);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
