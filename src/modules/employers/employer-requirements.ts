import type { EmployerType } from '@infra/db/database.types';
import type { Labels } from '@modules/schemas/schema-types';

/**
 * What each employer type must provide (§6.1), as data.
 *
 * Two lists per type: the profile fields BR-03 requires before a vacancy may be
 * submitted or an invitation sent, and the evidence a verification submission must
 * carry.
 *
 * **The evidence list was the open client decision, and it is closed.** §6.1 says
 * "verification documents if required" for a company and "identity verification data
 * if required by policy" for an individual, and no policy existed. Rather than block
 * the milestone, the requirement was declared here with a conventional default and a
 * provenance tag, exactly as the dictionary seed does - and on 2026-08-20 the client
 * confirmed both defaults as written, which cost one word per row and no migration,
 * no endpoint and no client release. That is the whole argument for the pattern: the
 * answer was cheaper than the question. The `file_purpose` rows it names are seeded
 * regardless, so the upload slots always rendered.
 *
 * Why a declaration rather than a `required` flag on the file purpose itself: the
 * same document is mandatory for one employer type and irrelevant to the other, and
 * a dictionary row cannot say that.
 */

/**
 * Where a requirement comes from - the same distinction the dictionary seed draws.
 *
 * `client` means somebody who owns the policy said so, and it is what `default` was waiting
 * to become. The distinction is kept after the answer rather than collapsed into it, because
 * the two rows the client actually ruled on are not the only rows here.
 */
export type RequirementProvenance = 'spec' | 'client' | 'default';

export interface EvidenceRequirement {
  /** `file_purpose` code. Seeded, so the slot renders whatever this says. */
  purposeCode: string;
  required: boolean;
  provenance: RequirementProvenance;
  /** Why it is what it is, kept next to the value rather than in a commit message. */
  note: string;
}

export interface ProfileFieldRequirement {
  /** Response field name, so a missing-field list points at something the client shows. */
  field: string;
  labels: Labels;
}

export interface EmployerRequirements {
  fields: ProfileFieldRequirement[];
  evidence: EvidenceRequirement[];
}

const COMMON_FIELDS: ProfileFieldRequirement[] = [
  {
    field: 'contactPhone',
    labels: {
      'uz-Latn': 'Aloqa telefoni',
      'uz-Cyrl': 'Алоқа телефони',
      ru: 'Контактный телефон',
      en: 'Contact phone',
    },
  },
  {
    field: 'regionId',
    labels: {
      'uz-Latn': 'Viloyat',
      'uz-Cyrl': 'Вилоят',
      ru: 'Регион',
      en: 'Region',
    },
  },
];

export const EMPLOYER_REQUIREMENTS: Record<EmployerType, EmployerRequirements> =
  {
    company: {
      // §6.1: "Legal or public name, industry, description, region/address, contact
      // person, phone". The address is not required - a region is enough to publish a
      // vacancy against, and many employers will not want a street address public.
      fields: [
        ...COMMON_FIELDS,
        {
          field: 'legalName',
          labels: {
            'uz-Latn': 'Yuridik nom',
            'uz-Cyrl': 'Юридик ном',
            ru: 'Юридическое название',
            en: 'Legal name',
          },
        },
        {
          field: 'publicName',
          labels: {
            'uz-Latn': 'Ommaviy nom',
            'uz-Cyrl': 'Оммавий ном',
            ru: 'Публичное название',
            en: 'Public name',
          },
        },
        {
          field: 'industryId',
          labels: {
            'uz-Latn': 'Tarmoq',
            'uz-Cyrl': 'Тармоқ',
            ru: 'Отрасль',
            en: 'Industry',
          },
        },
        {
          field: 'contactPersonName',
          labels: {
            'uz-Latn': 'Masul shaxs',
            'uz-Cyrl': 'Масъул шахс',
            ru: 'Контактное лицо',
            en: 'Contact person',
          },
        },
        {
          field: 'description',
          labels: {
            'uz-Latn': 'Kompaniya haqida',
            'uz-Cyrl': 'Компания ҳақида',
            ru: 'О компании',
            en: 'About the company',
          },
        },
      ],
      evidence: [
        {
          purposeCode: 'company_registration',
          required: true,
          provenance: 'client',
          note:
            'A company claiming to hire on the platform should be a registered one, ' +
            'and this is the document that shows it. Required because the alternative - ' +
            'verifying nothing - makes the verified badge meaningless. Confirmed by the ' +
            'client 2026-08-20, which is what turned this from a default into policy.',
        },
        {
          purposeCode: 'evidence',
          required: false,
          provenance: 'default',
          note:
            'Anything else the administrator asked for after a changes_required ' +
            'decision. Optional by definition: it exists so a correction has ' +
            'somewhere to go.',
        },
      ],
    },

    individual: {
      // §6.1: "Full name, phone, region, short description of the requested work".
      fields: [
        ...COMMON_FIELDS,
        {
          field: 'fullName',
          labels: {
            'uz-Latn': 'Toliq ism',
            'uz-Cyrl': 'Тўлиқ исм',
            ru: 'Полное имя',
            en: 'Full name',
          },
        },
        {
          field: 'description',
          labels: {
            'uz-Latn': 'Qanday ish taklif qilinadi',
            'uz-Cyrl': 'Қандай иш таклиф қилинади',
            ru: 'Какая работа предлагается',
            en: 'What work is offered',
          },
        },
      ],
      evidence: [
        {
          purposeCode: 'id_document',
          required: false,
          provenance: 'client',
          note:
            'This was the open decision (§6.1, "if required by policy") and the client ' +
            'closed it on 2026-08-20: OPTIONAL, deliberately the opposite way round ' +
            'from a company. An individual hiring two seasonal workers is the case the ' +
            'product exists to serve, and demanding an identity document up front is ' +
            'the surest way to lose them - while collecting and storing scans of ' +
            'identity documents is itself a data-protection liability nobody should ' +
            'take on without a policy that says to. Flipping `required` to true is ' +
            'still one edit if that judgement changes; nothing else moves.',
        },
      ],
    },
  };

/** The evidence a submission must carry, for the guard that checks it. */
export function requiredEvidence(type: EmployerType): string[] {
  return EMPLOYER_REQUIREMENTS[type].evidence
    .filter((item) => item.required)
    .map((item) => item.purposeCode);
}
