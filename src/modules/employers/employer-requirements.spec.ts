import type { EmployerType, LocaleCode } from '@infra/db/database.types';
import { DICTIONARY_SEED } from '@modules/dictionaries/seed/dictionary-seed.data';

import {
  EMPLOYER_REQUIREMENTS,
  requiredEvidence,
} from './employer-requirements';

/**
 * Contract tests over the employer requirement declaration.
 *
 * This file is where §6.1's open question ("identity verification data if required by
 * policy") is answered as data, so these tests hold the properties that make it safe
 * to answer it by editing one file: every purpose it names must exist, every field it
 * requires must be a real response field, and every value must state its provenance.
 */

const TYPES: EmployerType[] = ['company', 'individual'];
const LOCALES: LocaleCode[] = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'];

const FILE_PURPOSES = new Set(
  DICTIONARY_SEED.find((type) => type.code === 'file_purpose')?.items.map(
    (item) => item.code,
  ),
);

/** Fields the employer profile response actually carries. */
const RESPONSE_FIELDS = new Set([
  'contactPhone',
  'regionId',
  'districtId',
  'address',
  'description',
  'fullName',
  'legalName',
  'publicName',
  'industryId',
  'contactPersonName',
  'logoFileId',
]);

describe('employer requirements', () => {
  describe.each(TYPES)('for %s', (type) => {
    const requirements = EMPLOYER_REQUIREMENTS[type];

    it('requires at least one field, so BR-03 is a real gate', () => {
      expect(requirements.fields.length).toBeGreaterThan(0);
    });

    it('names only fields the profile response carries', () => {
      for (const field of requirements.fields) {
        // A required field with no counterpart in the response is one the client
        // cannot focus and the user cannot fill.
        expect(RESPONSE_FIELDS.has(field.field)).toBe(true);
      }
    });

    it('labels every required field in all four variants', () => {
      for (const field of requirements.fields) {
        for (const locale of LOCALES) {
          expect(field.labels[locale]?.trim()).toBeTruthy();
        }
      }
    });

    it('names only seeded file purposes', () => {
      for (const evidence of requirements.evidence) {
        // The upload slot is rendered from the dictionary, so a purpose that is not
        // seeded is a slot the employer can never fill.
        expect(FILE_PURPOSES.has(evidence.purposeCode)).toBe(true);
      }
    });

    it('states provenance and a reason for every evidence rule', () => {
      for (const evidence of requirements.evidence) {
        // The distinction decides who may change the value - the same rule the
        // dictionary seed follows.
        expect(['spec', 'default']).toContain(evidence.provenance);
        expect(evidence.note.length).toBeGreaterThan(20);
      }
    });

    it('declares no duplicate field or purpose', () => {
      const fields = requirements.fields.map((field) => field.field);
      const purposes = requirements.evidence.map((item) => item.purposeCode);

      expect(new Set(fields).size).toBe(fields.length);
      expect(new Set(purposes).size).toBe(purposes.length);
    });
  });

  it('asks a company for its registration and an individual for nothing mandatory', () => {
    // The current answer to the open §6.1 decision, pinned so that changing it is
    // deliberate. The asymmetry is the point: an individual hiring two seasonal
    // workers is the case the product exists to serve, and storing scans of identity
    // documents is a liability to take on only when a policy says to.
    expect(requiredEvidence('company')).toEqual(['company_registration']);
    expect(requiredEvidence('individual')).toEqual([]);
  });

  it('asks an individual for less than a company', () => {
    expect(EMPLOYER_REQUIREMENTS.individual.fields.length).toBeLessThan(
      EMPLOYER_REQUIREMENTS.company.fields.length,
    );
  });

  it('requires a contact phone and a region of both types', () => {
    for (const type of TYPES) {
      const fields = EMPLOYER_REQUIREMENTS[type].fields.map((f) => f.field);

      // §6.1 lists both for either type, and §7.1 filters candidates by region -
      // an employer with no region cannot be matched against anyone.
      expect(fields).toContain('contactPhone');
      expect(fields).toContain('regionId');
    }
  });
});
