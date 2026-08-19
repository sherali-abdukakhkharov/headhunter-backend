import {
  FISCAL_ATTRIBUTES,
  type FiscalAttributes,
  fiscalDetail,
} from './payment-fiscal';

/**
 * The one gate between an unanswered accounting question and a real tax filing.
 *
 * `fiscalDetail()` is deliberately the only way to read these values, so this suite is what
 * makes that worth something: three provenance states, and only one of them opens.
 *
 * The case that matters is `partial`. The client answered the VAT question on 2026-08-20 and
 * not the classifier one, so the file now holds a *real* zero next to a missing IKPU code -
 * which is exactly the shape that tempts a caller to send "most of" a receipt. A receipt with
 * a correct VAT rate and a guessed product code is no safer than one with two guesses.
 */
const complete: FiscalAttributes = {
  productCode: '10306001001000000',
  packageCode: '1512168',
  vatPercent: 12,
  unitCode: '5',
  provenance: 'client',
  note: 'Test fixture.',
};

describe('fiscalDetail', () => {
  it('withholds the receipt while nothing has been supplied', () => {
    expect(
      fiscalDetail({
        productCode: null,
        packageCode: null,
        vatPercent: null,
        unitCode: null,
        provenance: 'unknown',
        note: 'Test fixture.',
      }),
    ).toBeNull();
  });

  it('withholds it on a half answer, however complete the half is', () => {
    // The live state as of 2026-08-20: VAT established at zero, classifier code missing.
    expect(
      fiscalDetail({ ...complete, productCode: null, provenance: 'partial' }),
    ).toBeNull();

    // And the other direction, in case a future answer arrives in the opposite order: the
    // gate is the provenance tag, not a count of non-null fields.
    expect(fiscalDetail({ ...complete, provenance: 'partial' })).toBeNull();
  });

  it('withholds it when a value is missing even though the tag says client', () => {
    expect(fiscalDetail({ ...complete, productCode: null })).toBeNull();
    expect(fiscalDetail({ ...complete, vatPercent: null })).toBeNull();
  });

  it('sends it once the client has supplied both', () => {
    expect(fiscalDetail(complete)).toEqual({
      productCode: '10306001001000000',
      packageCode: '1512168',
      vatPercent: 12,
      unitCode: '5',
    });
  });

  it('distinguishes an established zero rate from an unestablished one', () => {
    // §6.7's VAT is a number the client owns, and this client is not VAT-registered. Zero has
    // to survive the gate that `null` does not, or a lawful zero-rated receipt could never be
    // sent - which is the bug a truthiness check would introduce.
    expect(fiscalDetail({ ...complete, vatPercent: 0 })).toMatchObject({
      vatPercent: 0,
    });
  });
});

describe('the declared attributes', () => {
  it('hold the client VAT answer and still send nothing', () => {
    // Pins the live file, not a fixture: the day somebody fills in the IKPU code, this test
    // fails and forces a deliberate decision about switching receipts on.
    expect(FISCAL_ATTRIBUTES.vatPercent).toBe(0);
    expect(FISCAL_ATTRIBUTES.provenance).toBe('partial');
    expect(FISCAL_ATTRIBUTES.productCode).toBeNull();
    expect(fiscalDetail()).toBeNull();
  });
});
