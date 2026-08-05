import type { DictionaryCategory, LocaleCode } from '@infra/db/database.types';

/**
 * Shape of the dictionary seed data.
 *
 * Separate from both the data and the seeder so the large content files under
 * `data/` can import these types without importing the index that collects them -
 * which would be a cycle, and would only be harmless for as long as every edge in
 * it stayed a type-only import.
 */

/**
 * Where a type's values come from. This decides who may change them:
 *
 * - `spec` - enumerated in [docs/SPEC.md](../../../../docs/SPEC.md) or frozen in
 *   `docs/API_CONTRACTS.md`. Changing these is a specification change.
 * - `default` - the spec requires the dictionary but does not enumerate its values.
 *   A conventional list is seeded so dependent milestones can be built and tested;
 *   **the client still has to approve it** (TODO.md, "approved dictionary value
 *   lists").
 * - `awaiting` - a list only the client can supply. The type is registered and its
 *   endpoint works, returning an empty set until the list arrives.
 */
export type SeedProvenance = 'spec' | 'default' | 'awaiting';

export interface SeedItem {
  code: string;
  /** All four interface variants. A missing one fails the seed (§3.2). */
  labels: Record<LocaleCode, string>;
  /** Occupations and work types only; drives the §5.2 field sets. */
  category?: DictionaryCategory;
  /** Second grouping - `attribute` groups, and skill families. */
  group?: string;
  /** Ordered scales only, and uniform per type (API_CONTRACTS.md §3.4). */
  rank?: number;
  /**
   * `code` of the parent item **within the same type** - a district's region.
   *
   * A code rather than an id because the data file cannot know a uuid; the seeder
   * resolves it. Parents are seeded before children, which the ordering of each
   * type's `items` array is responsible for.
   */
  parentCode?: string;
}

export interface SeedType {
  code: string;
  provenance: SeedProvenance;
  /** True for the ordered scales, where `>= C1` is a range comparison. */
  hasRank?: boolean;
  /** Why the values are what they are - kept next to them, not in a commit. */
  note?: string;
  items: SeedItem[];
}
