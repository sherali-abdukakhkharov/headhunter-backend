import { configuredAdministrators } from './admin-seed';

/**
 * `SEED_ADMIN_PHONES` is a hand-edited string in a `.env` file on a server, which is the
 * least forgiving place a format can live: nobody validates it, nothing type-checks it, and
 * a misparse grants the `admin` role to the wrong row or to no row at all. So the parsing is
 * pinned separately from the writing - this suite needs no database, and it is the one that
 * catches a name with a colon in it or a stray trailing separator.
 */
describe('configuredAdministrators', () => {
  it('is empty when the instance has not been told who administers it', () => {
    expect(configuredAdministrators(undefined)).toEqual([]);
    expect(configuredAdministrators('')).toEqual([]);
  });

  it('reads a bare phone number as an unnamed administrator', () => {
    expect(configuredAdministrators('+998901234567')).toEqual([
      { phone: '+998901234567', fullName: null },
    ]);
  });

  it('reads `phone:name`', () => {
    expect(
      configuredAdministrators(
        "+998941779737:Abduqaxxarov Sherali Rasuljon o'g'li",
      ),
    ).toEqual([
      {
        phone: '+998941779737',
        fullName: "Abduqaxxarov Sherali Rasuljon o'g'li",
      },
    ]);
  });

  it('takes several, named or not, and tolerates the whitespace a human leaves', () => {
    expect(
      configuredAdministrators(
        ' +998901234567 : Karimov Anvar , +998901234568 ,+998901234569:Yusupova Dilnoza',
      ),
    ).toEqual([
      { phone: '+998901234567', fullName: 'Karimov Anvar' },
      { phone: '+998901234568', fullName: null },
      { phone: '+998901234569', fullName: 'Yusupova Dilnoza' },
    ]);
  });

  it('splits on the first colon only, so a name may contain one', () => {
    expect(
      configuredAdministrators('+998901234567:Director: Karimov A.'),
    ).toEqual([{ phone: '+998901234567', fullName: 'Director: Karimov A.' }]);
  });

  it('treats a trailing colon as no name rather than an empty one', () => {
    // The column is nullable so that an unnamed administrator stays unnamed; an empty
    // string would render as a blank name in §10.2's list instead of falling through to
    // whatever the account's profile says.
    expect(configuredAdministrators('+998901234567:')).toEqual([
      { phone: '+998901234567', fullName: null },
    ]);
    expect(configuredAdministrators('+998901234567:   ')).toEqual([
      { phone: '+998901234567', fullName: null },
    ]);
  });

  it('ignores the empty entry a trailing comma leaves behind', () => {
    expect(configuredAdministrators('+998901234567,')).toHaveLength(1);
    expect(configuredAdministrators(',,')).toEqual([]);
  });
});
