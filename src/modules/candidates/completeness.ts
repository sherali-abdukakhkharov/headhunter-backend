import type { CompletenessEntry } from '@modules/schemas/schema-resolver';

/**
 * §5.3's completeness percentage and BR-02's gate.
 *
 * Pure, and deliberately two separate answers from one pass:
 *
 * - **`percent`** is measured over every entry the category's form has - engine
 *   fields plus experience and education. It is what the client shows and what
 *   §7.1 filters on ("minimum completeness"), so it has to move in small steps: a
 *   percentage computed over only the four mandatory fields would jump 25 points
 *   at a time and tell an employer nothing about how filled-in a profile is.
 * - **`isComplete`** is *only* about the required entries. It is BR-02's gate, so
 *   it must not be a threshold on the percentage - "80% complete" would otherwise
 *   let a profile with no occupation become searchable.
 *
 * `missing` carries both, flagged, because §5.3 asks for missing mandatory fields
 * with direct edit links while the client also wants to prompt for the optional
 * gaps. One list with a `required` flag serves both without a second endpoint.
 */
export interface MissingEntry {
  code: string;
  section: string;
  required: boolean;
}

export interface Completeness {
  percent: number;
  isComplete: boolean;
  missing: MissingEntry[];
}

export function computeCompleteness(
  entries: CompletenessEntry[],
  filled: ReadonlySet<string>,
): Completeness {
  const missing = entries.filter((entry) => !filled.has(entry.code));
  const total = entries.length;

  return {
    // A category with no entries cannot exist (every category has the core
    // sections), but 100% is the right answer to "nothing is missing" rather than
    // a division by zero.
    percent:
      total === 0 ? 100 : Math.round(((total - missing.length) / total) * 100),
    isComplete: !missing.some((entry) => entry.required),
    missing: missing.map((entry) => ({
      code: entry.code,
      section: entry.section,
      required: entry.required,
    })),
  };
}
