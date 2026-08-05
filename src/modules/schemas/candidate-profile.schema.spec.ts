import type { DictionaryCategory, LocaleCode } from '@infra/db/database.types';
import { DICTIONARY_SEED } from '@modules/dictionaries/seed/dictionary-seed.data';

import { CANDIDATE_PROFILE_SCHEMA } from './candidate-profile.schema';
import { isSupportedKind } from './field-validator';
import {
  attachmentsFor,
  completenessEntriesFor,
  fieldsFor,
  isRequiredIn,
  requiredForSearchable,
  sectionsFor,
} from './schema-resolver';

/**
 * Contract tests over the field-schema declaration.
 *
 * These assert the promises `docs/API_CONTRACTS.md` §4 makes to the client, in every
 * category at once. Each of them is a mistake that is easy to make in a 500-line
 * content file and impossible to notice from a single response: a required code with
 * no field to focus, a dictionary type that does not exist, a missing Russian label.
 */

const CATEGORIES: DictionaryCategory[] = [
  'professional',
  'service_operations',
  'physical_industrial',
  'seasonal_agricultural',
  'temporary_shift',
];

const LOCALES: LocaleCode[] = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'];

const SEEDED_TYPES = new Set(DICTIONARY_SEED.map((type) => type.code));

/** Extensions `FilesService` accepts. Kept in step by the test below. */
const ACCEPTED_EXTENSIONS = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'];

describe('candidate profile schema', () => {
  describe.each(CATEGORIES)('for %s', (category) => {
    it('resolves every requiredForSearchable code to a rendered field', () => {
      const codes = new Set(
        sectionsFor(CANDIDATE_PROFILE_SCHEMA, category).flatMap((section) =>
          section.fields.map((field) => field.code),
        ),
      );

      for (const required of requiredForSearchable(
        CANDIDATE_PROFILE_SCHEMA,
        category,
      )) {
        // §4.1: a completeness prompt must always be able to focus something.
        expect(codes.has(required)).toBe(true);
      }
    });

    it('marks exactly the requiredForSearchable fields as required', () => {
      const required = new Set(
        requiredForSearchable(CANDIDATE_PROFILE_SCHEMA, category),
      );

      for (const field of fieldsFor(CANDIDATE_PROFILE_SCHEMA, category)) {
        expect(isRequiredIn(field, category)).toBe(required.has(field.code));
      }
    });

    it('has at least one required field, so BR-02 is a real gate', () => {
      expect(
        requiredForSearchable(CANDIDATE_PROFILE_SCHEMA, category).length,
      ).toBeGreaterThan(0);
    });

    it('emits no empty engine section', () => {
      for (const section of sectionsFor(CANDIDATE_PROFILE_SCHEMA, category)) {
        if (section.editor === 'engine') {
          expect(section.fields.length).toBeGreaterThan(0);
        }
      }
    });

    it('counts every field plus the bespoke sections toward completeness', () => {
      const entries = completenessEntriesFor(
        CANDIDATE_PROFILE_SCHEMA,
        category,
      );
      const fields = fieldsFor(CANDIDATE_PROFILE_SCHEMA, category);
      const bespoke = sectionsFor(CANDIDATE_PROFILE_SCHEMA, category).filter(
        (section) => section.editor === 'bespoke',
      );

      expect(entries).toHaveLength(fields.length + bespoke.length);
    });
  });

  it('gives every field a kind this target’s validator handles', () => {
    // A field the write path cannot parse would render in the form and then throw
    // on save - so an unsupported kind fails the build rather than a request.
    for (const category of CATEGORIES) {
      for (const field of fieldsFor(CANDIDATE_PROFILE_SCHEMA, category)) {
        expect(isSupportedKind(field.kind)).toBe(true);
      }
    }
  });

  it('uses one declaration per field code', () => {
    const seen = new Map<string, string>();

    for (const section of CANDIDATE_PROFILE_SCHEMA.sections) {
      for (const field of section.fields) {
        // The write body is keyed by code and each code routes to one storage
        // target, so a duplicate would make the destination depend on iteration
        // order.
        expect(seen.has(field.code)).toBe(false);
        seen.set(field.code, section.code);
      }
    }
  });

  it('labels every section, field and extra in all four variants', () => {
    for (const section of CANDIDATE_PROFILE_SCHEMA.sections) {
      for (const locale of LOCALES) {
        expect(section.labels[locale]?.trim()).toBeTruthy();
      }

      for (const field of section.fields) {
        for (const locale of LOCALES) {
          expect(field.labels[locale]?.trim()).toBeTruthy();
        }

        for (const extra of field.extras ?? []) {
          for (const locale of LOCALES) {
            expect(extra.labels[locale]?.trim()).toBeTruthy();
          }
        }
      }
    }
  });

  it('names only dictionary types that exist', () => {
    for (const section of CANDIDATE_PROFILE_SCHEMA.sections) {
      for (const field of section.fields) {
        for (const type of [
          field.dictionaryType,
          field.levelDictionaryType,
          field.periodDictionaryType,
        ]) {
          if (type !== undefined) {
            // A type the seed does not have means an empty picker, which the client
            // cannot distinguish from "no options yet".
            expect(SEEDED_TYPES.has(type)).toBe(true);
          }
        }
      }
    }
  });

  it('declares a dictionary type for every dictionary field, and a scale for leveled ones', () => {
    for (const section of CANDIDATE_PROFILE_SCHEMA.sections) {
      for (const field of section.fields) {
        if (field.kind.startsWith('dictionary_')) {
          expect(field.dictionaryType).toBeDefined();
        }

        if (field.kind === 'dictionary_leveled') {
          expect(field.levelDictionaryType).toBeDefined();
        }
      }
    }
  });

  it('points every parentFieldCode at a field of the same dictionary type', () => {
    const byCode = new Map(
      CANDIDATE_PROFILE_SCHEMA.sections
        .flatMap((section) => section.fields)
        .map((field) => [field.code, field]),
    );

    for (const field of byCode.values()) {
      if (field.parentFieldCode === undefined) {
        continue;
      }

      const parent = byCode.get(field.parentFieldCode);

      expect(parent).toBeDefined();
      // The hierarchy is inside one dictionary type - a district is a child region.
      expect(parent?.dictionaryType).toBe(field.dictionaryType);
    }
  });

  it('gives every bespoke section an endpoint and no fields', () => {
    for (const section of CANDIDATE_PROFILE_SCHEMA.sections) {
      if (section.editor === 'bespoke') {
        expect(section.endpoint).toBeDefined();
        expect(section.fields).toHaveLength(0);
        expect(section.repeating).toBe(true);
      }
    }
  });

  it('declares money_range fully, since the client must never hardcode a currency', () => {
    const money = CANDIDATE_PROFILE_SCHEMA.sections
      .flatMap((section) => section.fields)
      .filter((field) => field.kind === 'money_range');

    expect(money.length).toBeGreaterThan(0);

    for (const field of money) {
      expect(field.currency).toBeTruthy();
      expect(field.periodDictionaryType).toBeTruthy();
    }
  });

  it('offers only attachment purposes the file_purpose dictionary has', () => {
    const purposes = new Set(
      DICTIONARY_SEED.find((type) => type.code === 'file_purpose')?.items.map(
        (item) => item.code,
      ),
    );

    for (const category of CATEGORIES) {
      for (const attachment of attachmentsFor(
        CANDIDATE_PROFILE_SCHEMA,
        category,
      )) {
        expect(purposes.has(attachment.purposeCode)).toBe(true);
      }
    }
  });

  it('accepts only extensions the file service will actually store', () => {
    for (const attachment of CANDIDATE_PROFILE_SCHEMA.attachments) {
      expect(attachment.accept.length).toBeGreaterThan(0);
      expect(attachment.maxCount).toBeGreaterThan(0);

      for (const extension of attachment.accept) {
        // Advertising an extension the server refuses is a failed upload the client
        // was told to expect (§4.5).
        expect(ACCEPTED_EXTENSIONS).toContain(extension);
      }
    }
  });
});
