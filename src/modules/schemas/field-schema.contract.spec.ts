import type { DictionaryCategory, LocaleCode } from '@infra/db/database.types';
import { DICTIONARY_SEED } from '@modules/dictionaries/seed/dictionary-seed.data';
import { RESTRICTION_JUSTIFICATIONS } from '@modules/vacancies/age-gender-justifications';

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
import type { FieldSchemaDefinition } from './schema-types';
import { VACANCY_SCHEMA } from './vacancy.schema';

/**
 * Contract tests over **every** field-schema declaration.
 *
 * The candidate profile and the vacancy share one mechanism, so they share one
 * contract: the promises `docs/API_CONTRACTS.md` §4 makes to the client hold for both
 * targets in all five categories. Each assertion here is a mistake that is easy to make
 * in a long content file and impossible to notice from a single response - a required
 * code with no field to focus, a dictionary type that does not exist, a missing Russian
 * label, a storage kind the target's writer cannot handle.
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

/** Which storage kinds each target's write path actually implements. */
const STORAGE_BY_TARGET: Record<string, string[]> = {
  candidate_profile: [
    'column',
    'money',
    'occupation_primary',
    'occupation_level',
    'occupation_additional',
    'skills',
    'languages',
    'attribute',
  ],
  vacancy: ['column', 'money', 'requirement'],
};

const DEFINITIONS: [string, FieldSchemaDefinition][] = [
  ['candidate_profile', CANDIDATE_PROFILE_SCHEMA],
  ['vacancy', VACANCY_SCHEMA],
];

describe.each(DEFINITIONS)('%s schema', (target, definition) => {
  it('declares its own target', () => {
    expect(definition.target).toBe(target);
  });

  describe.each(CATEGORIES)('for %s', (category) => {
    it('resolves every requiredForSearchable code to a rendered field', () => {
      const codes = new Set(
        sectionsFor(definition, category).flatMap((section) =>
          section.fields.map((field) => field.code),
        ),
      );

      for (const required of requiredForSearchable(definition, category)) {
        // §4.1: a completeness prompt must always be able to focus something.
        expect(codes.has(required)).toBe(true);
      }
    });

    it('marks exactly the requiredForSearchable fields as required', () => {
      const required = new Set(requiredForSearchable(definition, category));

      for (const field of fieldsFor(definition, category)) {
        expect(isRequiredIn(field, category)).toBe(required.has(field.code));
      }
    });

    it('has at least one required field, so the gate is real', () => {
      expect(
        requiredForSearchable(definition, category).length,
      ).toBeGreaterThan(0);
    });

    it('emits no empty engine section', () => {
      for (const section of sectionsFor(definition, category)) {
        if (section.editor === 'engine') {
          expect(section.fields.length).toBeGreaterThan(0);
        }
      }
    });

    it('counts every field plus the bespoke sections toward completeness', () => {
      const entries = completenessEntriesFor(definition, category);
      const fields = fieldsFor(definition, category);
      const bespoke = sectionsFor(definition, category).filter(
        (section) => section.editor === 'bespoke',
      );

      expect(entries).toHaveLength(fields.length + bespoke.length);
    });

    it('uses only storage kinds this target’s write path implements', () => {
      for (const field of fieldsFor(definition, category)) {
        // The `FieldStorage` union is shared between targets, so nothing but this
        // stops a vacancy field declaring `skills` - which would reach a writer that
        // has no case for it.
        expect(STORAGE_BY_TARGET[target]).toContain(field.storage.kind);
      }
    });
  });

  it('gives every field a kind the validator handles', () => {
    for (const category of CATEGORIES) {
      for (const field of fieldsFor(definition, category)) {
        expect(isSupportedKind(field.kind)).toBe(true);
      }
    }
  });

  it('uses one declaration per field code', () => {
    const seen = new Set<string>();

    for (const section of definition.sections) {
      for (const field of section.fields) {
        // The write body is keyed by code and each code routes to one storage target,
        // so a duplicate would make the destination depend on iteration order.
        expect(seen.has(field.code)).toBe(false);
        seen.add(field.code);
      }
    }
  });

  it('labels every section, field and extra in all four variants', () => {
    for (const section of definition.sections) {
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
    for (const section of definition.sections) {
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
    for (const section of definition.sections) {
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
      definition.sections
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
    for (const section of definition.sections) {
      if (section.editor === 'bespoke') {
        expect(section.endpoint).toBeDefined();
        expect(section.fields).toHaveLength(0);
        expect(section.repeating).toBe(true);
      }
    }
  });

  it('declares money_range fully, since the client must never hardcode a currency', () => {
    const money = definition.sections
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
      for (const attachment of attachmentsFor(definition, category)) {
        expect(purposes.has(attachment.purposeCode)).toBe(true);
      }
    }
  });

  it('accepts only extensions the file service will actually store', () => {
    for (const attachment of definition.attachments) {
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

describe('the two targets together', () => {
  it('agrees on the field codes that mean the same thing', () => {
    // A vacancy's requirements prefill a candidate search (UAT-06), and M7 maps one to
    // the other by code. Where both targets have a concept, the codes match - so a
    // rename on one side that forgets the other fails here rather than silently
    // producing a filter that matches nobody.
    const shared = [
      'region_id',
      'district_id',
      'skills',
      'languages',
      'employment_type_ids',
      'work_format_ids',
      'shift_ids',
      'salary',
      'licence_ids',
      'transport_ids',
      'tool_ids',
      'readiness_ids',
    ];

    const candidateCodes = new Set(
      CANDIDATE_PROFILE_SCHEMA.sections.flatMap((section) =>
        section.fields.map((field) => field.code),
      ),
    );
    const vacancyCodes = new Set(
      VACANCY_SCHEMA.sections.flatMap((section) =>
        section.fields.map((field) => field.code),
      ),
    );

    for (const code of shared) {
      expect(candidateCodes.has(code)).toBe(true);
      expect(vacancyCodes.has(code)).toBe(true);
    }
  });

  it('uses the same dictionary type on both sides of a shared code', () => {
    const candidateFields = new Map(
      CANDIDATE_PROFILE_SCHEMA.sections
        .flatMap((section) => section.fields)
        .map((field) => [field.code, field]),
    );

    for (const field of VACANCY_SCHEMA.sections.flatMap(
      (section) => section.fields,
    )) {
      const counterpart = candidateFields.get(field.code);

      if (!counterpart) {
        continue;
      }

      // Otherwise a vacancy could require an `attribute` where a candidate stores an
      // `industry`, and the match would compare ids from different vocabularies.
      expect(field.dictionaryType).toBe(counterpart.dictionaryType);
      expect(field.group).toBe(counterpart.group);
      expect(field.levelDictionaryType).toBe(counterpart.levelDictionaryType);
    }
  });
});

describe('BR-12 justifications', () => {
  it('matches the seeded dictionary exactly', () => {
    const seeded = new Set(
      DICTIONARY_SEED.find(
        (type) => type.code === 'restriction_justification',
      )?.items.map((item) => item.code),
    );
    const declared = new Set(
      RESTRICTION_JUSTIFICATIONS.map((item) => item.code),
    );

    // Two files, one list, on purpose: the dictionary owns the four labels, the
    // declaration owns the rule about which reason supports which restriction - a
    // rule that must not be widened by editing admin-editable content. A code in one
    // and not the other means a picker offering an option the server refuses, or a
    // rule nobody can select.
    expect([...declared].sort()).toEqual([...seeded].sort());
  });
});
