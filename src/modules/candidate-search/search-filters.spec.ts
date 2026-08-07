import {
  type CandidateSearchFilters,
  restrictionKinds,
  scoreGroups,
} from './search-filters';

/**
 * The scoring groups, which are §7.3's "overall requirement match" in one pure function.
 *
 * Worth unit tests of its own because two properties of the score depend entirely on it
 * and neither is visible from the SQL: which groups take part, and what they are measured
 * against. A group that stayed in the list with nothing asked for would divide by zero;
 * one that dropped out when it was asked for would silently stop counting.
 */
describe('scoreGroups', () => {
  it('scores nothing when nothing was filtered', () => {
    expect(scoreGroups({})).toEqual([]);
  });

  it('counts each group by how many items it asked for', () => {
    const filters: CandidateSearchFilters = {
      occupationIds: ['a', 'b'],
      skillIds: ['c', 'd', 'e'],
      languages: [{ itemId: 'f' }],
      regionId: 'g',
      districtIds: ['h', 'i'],
      employmentTypeIds: ['j'],
      shiftIds: ['k'],
      attributeIds: ['l'],
    };

    expect(scoreGroups(filters)).toEqual([
      { code: 'occupation', weight: 3, asked: 2 },
      { code: 'skills', weight: 3, asked: 3 },
      { code: 'languages', weight: 2, asked: 1 },
      // Region and district are one point each however many districts are listed: the
      // question is "is this candidate where the work is", asked two ways.
      { code: 'location', weight: 1, asked: 2 },
      { code: 'preferences', weight: 1, asked: 2 },
      { code: 'attributes', weight: 1, asked: 1 },
    ]);
  });

  it('leaves out a group whose filter is absent, so it neither divides nor pads', () => {
    expect(scoreGroups({ skillIds: ['a'] })).toEqual([
      { code: 'skills', weight: 3, asked: 1 },
    ]);
  });

  it('leaves out a group whose filter is present but empty', () => {
    expect(scoreGroups({ skillIds: [], languages: [] })).toEqual([]);
  });

  it('weights occupation and skills above the qualifiers', () => {
    const weights = new Map(
      scoreGroups({
        occupationIds: ['a'],
        skillIds: ['b'],
        languages: [{ itemId: 'c' }],
        regionId: 'd',
        employmentTypeIds: ['e'],
        attributeIds: ['f'],
      }).map((group) => [group.code, group.weight]),
    );

    expect(weights.get('occupation')).toBeGreaterThan(
      weights.get('location') as number,
    );
    expect(weights.get('skills')).toBeGreaterThan(
      weights.get('languages') as number,
    );
  });
});

/** BR-12 on the search side: which kinds of restriction a justification has to cover. */
describe('restrictionKinds', () => {
  it('finds nothing in an ordinary filter set', () => {
    expect(restrictionKinds({ skillIds: ['a'] })).toEqual([]);
  });

  it.each([
    ['ageMin', { ageMin: 30 }],
    ['ageMax', { ageMax: 40 }],
  ])('reports an age restriction from %s alone', (_name, filters) => {
    expect(restrictionKinds(filters)).toEqual(['age']);
  });

  it('reports both kinds when both are filtered', () => {
    expect(restrictionKinds({ ageMin: 18, genderId: 'g' })).toEqual([
      'age',
      'gender',
    ]);
  });
});
