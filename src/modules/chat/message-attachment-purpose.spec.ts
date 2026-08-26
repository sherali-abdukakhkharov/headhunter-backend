import { DICTIONARY_SEED } from '@modules/dictionaries/seed/dictionary-seed.data';

import { MESSAGE_ATTACHMENT_PURPOSE } from './chat.service';

/**
 * The chat module names a `file_purpose` code in TypeScript; the row it names lives in
 * the dictionary seed. Nothing in the type system connects them.
 *
 * A drift between the two fails at the point the purpose is resolved — inside
 * `FilesService.store`, on every upload, with `dictionary.item_not_found` — which is a
 * long way from where the code was typed and gives no hint that a seed row is the fix.
 * So the two are compared here, with no database, in the same shape
 * `employer-requirements.spec.ts` uses for BR-12's justification codes.
 */
const purposes =
  DICTIONARY_SEED.find((type) => type.code === 'file_purpose')?.items.map(
    (item) => item.code,
  ) ?? [];

describe('the message attachment purpose', () => {
  it('names a code the dictionary seed actually declares', () => {
    expect(purposes).toContain(MESSAGE_ATTACHMENT_PURPOSE);
  });

  it('is its own purpose, not one of the profile ones', () => {
    // Purpose is what authorizes a read: a profile attachment is readable by an
    // employer who has unlocked the candidate, a message attachment by the other
    // participant in one conversation. Reusing `evidence` would put two rules on one
    // code, and the second one written would be the one nobody could state.
    for (const profilePurpose of ['cv', 'photo', 'certificate', 'evidence']) {
      expect(MESSAGE_ATTACHMENT_PURPOSE).not.toBe(profilePurpose);
    }
  });

  it('is a code the seed declares exactly once', () => {
    // Two rows with one code is a unique-constraint failure at seed time rather than
    // here, but the seed is the file being edited and this is where an editor looks.
    const matches = purposes.filter(
      (code) => code === MESSAGE_ATTACHMENT_PURPOSE,
    );

    expect(matches).toHaveLength(1);
  });
});
