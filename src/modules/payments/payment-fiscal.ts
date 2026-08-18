/**
 * Fiscal receipt attributes (§6.7), as data.
 *
 * §6.7 leaves these to somebody who is not on this team: *"Fiscal receipt attributes such as
 * applicable service/product code, VAT, and related merchant configuration are supplied by
 * the Client/accounting function and configured according to current provider and legal
 * requirements."* Nobody here can guess an IKPU code or a VAT rate, and guessing wrong is a
 * tax problem rather than a bug.
 *
 * So it is declared here with provenance tags instead of being left as a gap - the fourth
 * time this pattern has answered an open client question, after the employer evidence rules,
 * the BR-12 justifications and the retention periods. **When the client answers, this file
 * changes and nothing else does**: no migration, no endpoint, no client release.
 *
 * **Nothing is sent to a provider until `provenance` is `client`.** Payme accepts a fiscal
 * receipt in its `detail` field, and CLICK has its own equivalent; sending a receipt built
 * from an engineer's placeholder would put a wrong tax code on a real transaction, which is
 * worse than sending none. `fiscalDetail()` returns null while the values are unconfirmed,
 * and the adapters simply omit the field - which is what they do today.
 *
 * The corresponding question, and what to ask for, is in docs/PAYMENTS.md.
 */

/** Where a value came from. `client` is the only one that may reach a provider. */
export type FiscalProvenance = 'client' | 'unknown';

export interface FiscalAttributes {
  /**
   * The state classifier code for what is being sold - IKPU in Uzbekistan (ИКПУ / MXIK).
   *
   * Coins are prepaid access to a digital service, so the code is most likely one of the
   * information-services classes; which one is an accounting decision, not a technical one.
   */
  productCode: string | null;
  /** The package code, where the classifier requires one alongside the product code. */
  packageCode: string | null;
  /** VAT percent as an integer. `null` means "not established", not "zero". */
  vatPercent: number | null;
  /**
   * The unit of measure the classifier expects. One Coin is one unit of something, and the
   * something has a code.
   */
  unitCode: string | null;
  provenance: FiscalProvenance;
  /** Why it is what it is, next to the value rather than in a commit message. */
  note: string;
}

/**
 * Today's answer: nothing is known.
 *
 * Written out rather than left as an empty object, because "we asked and have not been told"
 * is a different state from "nobody thought about it", and only the first one is honest.
 */
export const FISCAL_ATTRIBUTES: FiscalAttributes = {
  productCode: null,
  packageCode: null,
  vatPercent: null,
  unitCode: null,
  provenance: 'unknown',
  note:
    'Not supplied. §6.7 assigns these to the Client/accounting function, and no values ' +
    'have been provided. Coins are prepaid access to in-app functionality, so an IKPU ' +
    'class and a VAT treatment both have to be chosen by somebody who can be accountable ' +
    'for the choice. Until then no fiscal receipt is sent to either provider.',
};

/**
 * The fiscal block to attach to a provider transaction, or null while it is unknown.
 *
 * Deliberately the only way to read these values, so there is no path by which a placeholder
 * reaches a provider: a caller cannot forget to check `provenance`, because it is checked
 * here.
 */
export function fiscalDetail(
  attributes: FiscalAttributes = FISCAL_ATTRIBUTES,
): {
  productCode: string;
  packageCode: string | null;
  vatPercent: number;
  unitCode: string | null;
} | null {
  if (
    attributes.provenance !== 'client' ||
    attributes.productCode === null ||
    attributes.vatPercent === null
  ) {
    return null;
  }

  return {
    productCode: attributes.productCode,
    packageCode: attributes.packageCode,
    vatPercent: attributes.vatPercent,
    unitCode: attributes.unitCode,
  };
}
