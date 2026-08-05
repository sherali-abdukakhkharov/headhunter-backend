/**
 * A field value after validation, in the shape the write path stores.
 *
 * The validator produces these so the service that writes them never re-parses
 * client input: by the time a value reaches a query it has a type, its dictionary
 * ids are known to exist, and its level ranks are resolved.
 */

/** money_range, API_CONTRACTS.md §4.3. */
export interface ParsedMoney {
  from: number | null;
  to: number | null;
  periodId: string | null;
  isNegotiable: boolean;
}

/** One row of a `dictionary_leveled` field (§4.4). */
export interface ParsedLeveledRow {
  itemId: string;
  levelId: string;
  /** Copied from the level item, so a `>= C1` filter is a range test. */
  levelRank: number;
  /** Declared extras only - `bool` and `text`, depth 1. */
  extras: Record<string, string | boolean | null>;
}

export type ParsedValue =
  | { type: 'scalar'; value: string | number | boolean | null }
  | { type: 'money'; value: ParsedMoney }
  | { type: 'ids'; value: string[] }
  | { type: 'leveled'; value: ParsedLeveledRow[] };

/**
 * Field codes mapped to their validated values.
 *
 * A key present with a `null`/empty value means "clear this field", which is a
 * legitimate write: requiredness gates *searchability* (BR-02), never the save.
 * A candidate must be able to remove something they entered by mistake, and the
 * profile then simply stops being complete.
 */
export type ParsedFields = Map<string, ParsedValue>;
