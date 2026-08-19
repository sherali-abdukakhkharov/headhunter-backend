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
 * *Half answered on 2026-08-20:* the client is not VAT-registered, so `vatPercent` is a
 * confirmed zero rather than an unknown. The IKPU classifier code is still outstanding, and
 * one missing value is enough to withhold the whole receipt - a receipt with a correct VAT
 * rate and a guessed product code is no safer than one with two guesses.
 *
 * The corresponding question, and what to ask for, is in docs/PAYMENTS.md.
 */

/**
 * Where a value came from. `client` is the only one that may reach a provider.
 *
 * `partial` exists because the client answered one of the two questions. It is not a
 * courtesy state: "we asked, were told the VAT treatment, and are still missing the
 * classifier code" is a different position from "nobody has told us anything", and only the
 * first one tells the next reader what is left to chase.
 */
export type FiscalProvenance = 'client' | 'partial' | 'unknown';

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
 * Today's answer: the VAT treatment is the client's, the classifier code is still nobody's.
 *
 * Written out rather than left as an empty object, because "we asked and have been told half"
 * is a different state from "nobody thought about it", and only the first one is honest.
 */
export const FISCAL_ATTRIBUTES: FiscalAttributes = {
  productCode: null,
  packageCode: null,
  // Zero, not null: the client is not VAT-registered, so zero is the *established* rate
  // rather than an unknown one. The two are deliberately distinguishable here.
  vatPercent: 0,
  unitCode: null,
  provenance: 'partial',
  note:
    'VAT: 0, client-confirmed 2026-08-20 - the company is not VAT-registered, so zero is ' +
    'the established rate and not a placeholder. IKPU/MXIK classifier code: still not ' +
    'supplied. §6.7 assigns it to the Client/accounting function, and Coins are prepaid ' +
    'access to a digital service, so which information-services class applies has to be ' +
    'chosen by somebody who can be accountable for the choice. No fiscal receipt is sent ' +
    'to either provider until it arrives.',
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
