import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';

import type { Database } from '@infra/db/database.module';
import type { DB } from '@infra/db/database.types';

import type { CandidateSearchFilters } from './search-filters';
import { scoreGroups } from './search-filters';
import { SORTS } from './dto/candidate-search.dto';
import {
  cardColumns,
  cardJoins,
  matchedColumns,
  matchedJson,
  orderBy,
  scoreExpression,
  whereFilters,
  proximityRank,
} from './search-query';

/**
 * What the search compiles to.
 *
 * A real Kysely instance over `DummyDriver`, as `health.service.spec.ts` does: the
 * fragments are genuinely compiled, so a malformed one fails here, and nothing connects.
 * Whether the SQL is *correct* is `candidate-search.int.spec.ts`'s job against a real
 * Postgres; what these tests pin is the shape - which is where the privacy guarantee and
 * ARCHITECTURE.md §5's two-plan rule live.
 */

const db: Database = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (instance) => new PostgresIntrospector(instance),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const TODAY = '2026-08-07';
const ZONE = 'Asia/Tashkent';

function whereSql(filters: CandidateSearchFilters): string {
  return whereFilters(filters, TODAY, ZONE).compile(db).sql;
}

describe('the card query and §11.1', () => {
  it('never reads a phone number, because a card may not carry one', () => {
    const compiled = sql`
      SELECT ${cardColumns('employer-1', 'vacancy-1')} FROM ranked r ${cardJoins('employer-1')}
    `.compile(db);

    // §11.1: "Phone number and full contact details are not shown in general candidate
    // search cards." The strongest form of that is a query with no access to one - so
    // this asserts the absence of the table rather than the absence of the field, which
    // is the thing a future edit would have to break first.
    expect(compiled.sql).not.toMatch(/\busers\b/);
    expect(compiled.sql).not.toMatch(/\bphone\b/);
  });

  it('reads the photo through its purpose code, not by trusting a file id', () => {
    const compiled = sql`SELECT ${cardColumns('e1', null)}`.compile(db);

    expect(compiled.sql).toContain('stored_files');
    expect(compiled.sql).toContain("di.code = 'photo'");
  });

  it('does not query a shortlist when the search has no vacancy context', () => {
    const compiled = sql`SELECT ${cardColumns('e1', null)}`.compile(db);

    expect(compiled.sql).not.toContain('vacancy_shortlists');
  });

  it('scopes the invitation status to this employer and this vacancy', () => {
    const compiled = sql`SELECT ${cardColumns('e1', 'v1')}`.compile(db);

    // Both halves matter and for different reasons. Without the employer predicate one
    // employer would read another's invitation state off a shared candidate, which is
    // §11.1's kind of leak. Without `IS NOT DISTINCT FROM` the general slot - the one with
    // a null `vacancy_id` - would be unreachable, because `= NULL` matches nothing, and the
    // card would report "not invited" for a candidate who cannot be invited again.
    expect(compiled.sql).toContain('i.employer_user_id =');
    expect(compiled.sql).toContain('i.vacancy_id IS NOT DISTINCT FROM');
    // Bound, not interpolated - the same discipline the injection suite asserts wholesale.
    expect(compiled.sql).not.toContain('v1');
    expect(compiled.parameters).toContain('v1');
  });
});

describe('whereFilters', () => {
  it('starts from BR-02’s gate with no filters at all', () => {
    expect(whereSql({})).toBe("p.visibility = 'searchable' AND p.is_complete");
  });

  it('keeps the gate in front of every filter', () => {
    expect(whereSql({ regionId: 'r1' })).toContain(
      "p.visibility = 'searchable' AND p.is_complete AND",
    );
  });

  it.each([
    ['occupationIds', { occupationIds: ['o1'] }, 'candidate_occupations'],
    ['skillIds', { skillIds: ['s1'] }, 'candidate_skills'],
    ['languages', { languages: [{ itemId: 'l1' }] }, 'candidate_languages'],
    ['educationLevelIds', { educationLevelIds: ['e1'] }, 'candidate_education'],
    [
      'currentOccupationIds',
      { currentOccupationIds: ['o1'] },
      'candidate_experience',
    ],
    ['experienceYearsMin', { experienceYearsMin: 3 }, 'candidate_experience'],
    ['attributeIds', { attributeIds: ['a1'] }, 'candidate_attributes'],
    ['crewSizeMin', { crewSizeMin: 3 }, 'crew_size'],
    ['minCompleteness', { minCompleteness: 50 }, 'completeness_percent'],
    [
      'updatedSince',
      { updatedSince: '2026-01-01' },
      'last_meaningful_update_at',
    ],
    ['ageMin', { ageMin: 30 }, 'date_of_birth'],
    ['genderId', { genderId: 'g1' }, 'gender_id'],
    ['availableImmediately', { availableImmediately: true }, 'available_from'],
  ])('%s contributes a predicate', (_name, filters, expected) => {
    expect(whereSql(filters)).toContain(expected);
  });

  it('matches a work preference by its schema field code', () => {
    // The field code is a bound parameter, not inlined SQL - which is also what keeps
    // the index on (field_code, item_id, user_id) usable.
    expect(
      whereFilters({ employmentTypeIds: ['t1'] }, TODAY, ZONE).compile(db)
        .parameters,
    ).toContain('employment_type_ids');
  });

  it('uses different plans for match-all and match-any skills (ARCHITECTURE.md §5)', () => {
    const any = whereSql({ skillIds: ['s1', 's2'], skillsMatchMode: 'any' });
    const all = whereSql({ skillIds: ['s1', 's2'], skillsMatchMode: 'all' });

    expect(any).toContain('EXISTS');
    expect(any).not.toContain('count(DISTINCT');
    // Match-all counts distinct matches against the number asked for; the two are
    // deliberately not unified behind one clever query.
    expect(all).toContain('count(DISTINCT');
    expect(
      whereFilters(
        { skillIds: ['s1', 's2'], skillsMatchMode: 'all' },
        TODAY,
        ZONE,
      ).compile(db).parameters,
    ).toContain(2);
  });

  it('defaults skills to match-any', () => {
    expect(whereSql({ skillIds: ['s1'] })).toContain('EXISTS');
  });

  it('compares a language level as a rank floor', () => {
    expect(
      whereSql({ languages: [{ itemId: 'l1', minLevelRank: 5 }] }),
    ).toContain('cl.level_rank >=');
  });

  it('asks for the certificate only when the filter did', () => {
    expect(whereSql({ languages: [{ itemId: 'l1' }] })).not.toContain(
      'has_certificate',
    );
    expect(
      whereSql({ languages: [{ itemId: 'l1', requireCertificate: true }] }),
    ).toContain('has_certificate');
  });

  it('ANDs one predicate per language, so two requirements are both required', () => {
    const two = whereSql({
      languages: [{ itemId: 'l1' }, { itemId: 'l2' }],
    });

    expect(two.match(/candidate_languages/g)).toHaveLength(2);
  });

  it('matches a specialization by id, not by text (§3.3, BR-13)', () => {
    const sqlText = whereSql({ specializationIds: ['s1'] });

    expect(sqlText).toContain('candidate_attributes');
    // The filter this replaced was an ILIKE over prose. Nothing here may compare text.
    expect(sqlText).not.toContain('ILIKE');
    expect(
      whereFilters({ specializationIds: ['s1'] }, TODAY, ZONE).compile(db)
        .parameters,
    ).toContain('specialization');
  });

  it('lets a negotiable expectation pass a budget', () => {
    expect(whereSql({ salaryMax: 5_000_000 })).toContain(
      'p.salary_is_negotiable',
    );
  });

  it('resolves "available immediately" against the platform date, not the server’s', () => {
    expect(
      whereFilters({ availableImmediately: true }, TODAY, ZONE).compile(db)
        .parameters,
    ).toContain(TODAY);
  });

  it('ignores occupation experience with no occupation to measure it in', () => {
    // The route refuses this combination outright; the fragment must not quietly filter
    // on every occupation instead.
    expect(whereSql({ occupationExperienceYearsMin: 5 })).toBe(
      "p.visibility = 'searchable' AND p.is_complete",
    );
  });
});

describe('injection (§12.5)', () => {
  const HOSTILE = "'; DROP TABLE users; --";

  it('never puts a filter value into the SQL text', () => {
    const compiled = whereFilters(
      {
        occupationIds: [HOSTILE],
        skillIds: [HOSTILE],
        skillsMatchMode: 'all',
        languages: [{ itemId: HOSTILE, minLevelRank: 3 }],
        specializationIds: [HOSTILE],
        regionId: HOSTILE,
        districtIds: [HOSTILE],
        genderId: HOSTILE,
        employmentTypeIds: [HOSTILE],
        attributeIds: [HOSTILE],
        availableBy: HOSTILE,
      },
      '2026-08-07',
      ZONE,
    ).compile(db);

    // Every value reaches Postgres as a bound parameter. The query builder is what makes
    // that true; this asserts that the hand-written `sql` fragments did not undo it - the
    // one place in this codebase where they could.
    //
    // `updatedSince` is absent because it is now stronger than bound - see the next test.
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.parameters).toContain(HOSTILE);
  });

  it('refuses a malformed updatedSince rather than compiling it', () => {
    // Stronger than the parameterisation above: `updatedSince` filters a `timestamptz`, so
    // it is converted to an instant in the platform zone before it reaches SQL. A value
    // that is not a calendar date therefore never becomes a query at all - not as text,
    // and not as a bound parameter either.
    expect(() => whereFilters({ updatedSince: HOSTILE }, TODAY, ZONE)).toThrow(
      RangeError,
    );
  });

  it('interpolates only closed-union group codes into raw SQL', () => {
    // `sql.raw` appears three times in the search, each time building a column alias from
    // a `ScoreGroupCode`. Those come from a hardcoded weight table, never from a request -
    // and this fails if a future edit ever routes a filter value through one.
    const sqlText = [
      ...matchedColumns(
        { skillIds: [HOSTILE] },
        scoreGroups({ skillIds: [HOSTILE] }),
      ),
      scoreExpression(scoreGroups({ skillIds: [HOSTILE] })),
      matchedJson(scoreGroups({ skillIds: [HOSTILE] })),
    ]
      .map((fragment) => fragment.compile(db).sql)
      .join(' ');

    expect(sqlText).not.toContain('DROP TABLE');
    expect(sqlText).toContain('matched_skills');
  });
});

describe('scoreExpression', () => {
  it('scores every candidate 100 when no group was asked about', () => {
    expect(scoreExpression([]).compile(db).sql).toBe('100');
  });

  it('divides by the weights of the groups in play, and nothing else', () => {
    const groups = scoreGroups({
      skillIds: ['s1', 's2'],
      regionId: 'r1',
    });
    const compiled = scoreExpression(groups).compile(db);

    // skills (3) + location (1); the four absent groups must not pad the denominator.
    expect(compiled.parameters).toContain(4);
    expect(compiled.sql).toContain('m.matched_skills');
    expect(compiled.sql).toContain('m.matched_location');
    expect(compiled.sql).not.toContain('matched_languages');
  });

  it('caps a group at what was asked for, so a superset cannot exceed 100', () => {
    const compiled = scoreExpression(scoreGroups({ skillIds: ['s1'] })).compile(
      db,
    );

    expect(compiled.sql).toContain('LEAST(');
  });

  it('reports the same counts it scored, capped the same way', () => {
    const groups = scoreGroups({ skillIds: ['s1'] });

    expect(matchedJson(groups).compile(db).sql).toContain(
      'LEAST(r.matched_skills',
    );
  });

  it('reports an empty breakdown for an unfiltered search', () => {
    expect(matchedJson([]).compile(db).sql).toBe(`'{}'::json`);
  });
});

describe('orderBy', () => {
  it.each([
    ['match', 'r.match_score DESC'],
    ['recent', 'r.last_meaningful_update_at DESC'],
    ['experience', 'r.experience_years DESC'],
    ['salary', 'r.salary_from ASC'],
    ['proximity', 'r.proximity_rank DESC'],
  ] as const)('%s sorts by its own key first', (sort, expected) => {
    expect(orderBy(sort).compile(db).sql.startsWith(expected)).toBe(true);
  });

  it('ends every sort with a total order, so pages cannot repeat a candidate', () => {
    for (const sort of SORTS) {
      expect(orderBy(sort).compile(db).sql).toMatch(/r\.user_id$/);
    }
  });
});

describe('proximityRank', () => {
  it('ranks the same district above the same region', () => {
    const compiled = proximityRank({
      regionId: 'r1',
      districtIds: ['d1'],
    }).compile(db);

    // Tiers, not kilometres: there are no coordinates in this data model, and a distance
    // computed from the region tree would be a number nobody measured.
    expect(compiled.sql).toContain('THEN 2');
    expect(compiled.sql).toContain('THEN 1');
    expect(compiled.sql).not.toMatch(/earth|point|<->|distance/i);
  });

  it('ranks everybody equally when nothing was filtered on', () => {
    // Nothing to be near, so the sort falls through to its tiebreaker rather than
    // inventing an order.
    const compiled = proximityRank({}).compile(db);

    expect(compiled.parameters).toContain(null);
    expect(compiled.sql).toContain('ELSE 0');
  });
});
