import type { FieldSchemaDefinition } from './schema-types';

/**
 * The candidate profile form (§5.1, §5.2), as one declaration.
 *
 * This is the whole form: core sections and category sections together, which is
 * what lets every `requiredForSearchable` code resolve to something the client
 * can focus (API_CONTRACTS.md §4.1). It is also what the write path routes
 * against and what completeness counts, so a field cannot exist in the form and
 * be unknown to the server.
 *
 * Four things are deliberately **not** fields here:
 *
 * - **Phone and interface language.** §5.1 lists them under personal information,
 *   but they live on `users` and are written by the auth and locale routes. A
 *   second way to set a phone number is a second way for the verified one to
 *   disagree with itself (BR-01).
 * - **Privacy / visibility.** It is an enum, and §4.2's `kind` union has no `enum`
 *   member on purpose. It is also the one write that must *not* refresh
 *   `last_meaningful_update_at` (§5.3), so `PATCH /candidates/me/visibility` owns
 *   it and the form engine never touches it.
 * - **The CV, certificates and the profile photo.** §4.5 keeps every upload out of
 *   the field union; they are the `attachments` block at the bottom.
 * - **Experience and education.** Repeating sections with their own editors and
 *   their own sub-resources (§4.1 `editor: "bespoke"`). A consequence worth
 *   knowing: a bespoke section has no fields, so it can never appear in
 *   `requiredForSearchable`, which means BR-02 never blocks on having entered a
 *   job. That is the contract's shape, not an oversight - and completeness still
 *   counts them, so an empty history is visible as a percentage rather than as a
 *   locked profile.
 *
 * Labels are written positionally in all four variants, as in the dictionary
 * seed: the value is content to be reviewed in a column, not code to be read.
 */
export const CANDIDATE_PROFILE_SCHEMA: FieldSchemaDefinition = {
  target: 'candidate_profile',
  version: 2,
  sections: [
    // --- personal (§5.1) ---------------------------------------------------
    {
      code: 'personal',
      source: 'core',
      labels: {
        'uz-Latn': 'Shaxsiy maʼlumotlar',
        'uz-Cyrl': 'Шахсий маълумотлар',
        ru: 'Личные данные',
        en: 'Personal information',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'full_name',
          kind: 'text',
          labels: {
            'uz-Latn': 'Toʻliq ism',
            'uz-Cyrl': 'Тўлиқ исм',
            ru: 'Полное имя',
            en: 'Full name',
          },
          storage: { kind: 'column', column: 'full_name' },
          requiredIn: 'all',
          validation: { minLength: 3, maxLength: 120 },
        },
        {
          code: 'date_of_birth',
          kind: 'date',
          labels: {
            'uz-Latn': 'Tugʻilgan sana',
            'uz-Cyrl': 'Туғилган сана',
            ru: 'Дата рождения',
            en: 'Date of birth',
          },
          storage: { kind: 'column', column: 'date_of_birth' },
          requiredIn: 'all',
          // 14 is the lower bound the platform will consider, and the column
          // carries the same rule as a CHECK. Validated here so an under-age
          // registration gets a field-level message rather than a failed write.
          validation: { notAfter: 'today', minAgeYears: 14 },
        },
        {
          code: 'gender_id',
          kind: 'dictionary_single',
          labels: {
            'uz-Latn': 'Jinsi',
            'uz-Cyrl': 'Жинси',
            ru: 'Пол',
            en: 'Gender',
          },
          storage: { kind: 'column', column: 'gender_id' },
          dictionaryType: 'gender',
        },
      ],
    },

    // --- location (§5.1) ---------------------------------------------------
    {
      code: 'location',
      source: 'core',
      labels: {
        'uz-Latn': 'Manzil',
        'uz-Cyrl': 'Манзил',
        ru: 'Местоположение',
        en: 'Location',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'region_id',
          kind: 'dictionary_single',
          labels: {
            'uz-Latn': 'Viloyat',
            'uz-Cyrl': 'Вилоят',
            ru: 'Регион',
            en: 'Region',
          },
          storage: { kind: 'column', column: 'region_id' },
          dictionaryType: 'region',
          requiredIn: 'all',
        },
        {
          code: 'district_id',
          kind: 'dictionary_single',
          labels: {
            'uz-Latn': 'Tuman yoki shahar',
            'uz-Cyrl': 'Туман ёки шаҳар',
            ru: 'Район или город',
            en: 'District or city',
          },
          storage: { kind: 'column', column: 'district_id' },
          dictionaryType: 'region',
          // Districts are the children of a region in the same type, so the
          // picker needs to know which selection restricts it.
          parentFieldCode: 'region_id',
          requiredIn: 'all',
        },
        {
          code: 'settlement',
          kind: 'text',
          labels: {
            'uz-Latn': 'Mahalla yoki qishloq',
            'uz-Cyrl': 'Маҳалла ёки қишлоқ',
            ru: 'Населённый пункт',
            en: 'Settlement',
          },
          storage: { kind: 'column', column: 'settlement' },
          validation: { maxLength: 120 },
        },
        {
          code: 'willing_to_relocate',
          kind: 'bool',
          labels: {
            'uz-Latn': 'Koʻchib ishlashga tayyorman',
            'uz-Cyrl': 'Кўчиб ишлашга тайёрман',
            ru: 'Готов к переезду',
            en: 'Willing to relocate',
          },
          storage: { kind: 'column', column: 'willing_to_relocate' },
        },
        {
          code: 'willing_to_travel',
          kind: 'bool',
          labels: {
            'uz-Latn': 'Xizmat safarlariga tayyorman',
            'uz-Cyrl': 'Хизмат сафарларига тайёрман',
            ru: 'Готов к поездкам',
            en: 'Willing to travel',
          },
          storage: { kind: 'column', column: 'willing_to_travel' },
        },
      ],
    },

    // --- target work (§5.1) ------------------------------------------------
    {
      code: 'target_work',
      source: 'core',
      labels: {
        'uz-Latn': 'Qidirilayotgan ish',
        'uz-Cyrl': 'Қидирилаётган иш',
        ru: 'Желаемая работа',
        en: 'Target work',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'primary_occupation_id',
          kind: 'dictionary_single',
          labels: {
            'uz-Latn': 'Asosiy kasb yoki ish turi',
            'uz-Cyrl': 'Асосий касб ёки иш тури',
            ru: 'Основная профессия или вид работы',
            en: 'Primary occupation or work type',
          },
          storage: { kind: 'occupation_primary' },
          dictionaryType: 'occupation',
          requiredIn: 'all',
        },
        {
          code: 'occupation_level_id',
          kind: 'dictionary_single',
          labels: {
            'uz-Latn': 'Kasbiy darajasi',
            'uz-Cyrl': 'Касбий даражаси',
            ru: 'Профессиональный уровень',
            en: 'Professional level',
          },
          storage: { kind: 'occupation_level' },
          dictionaryType: 'skill_level',
        },
        {
          code: 'additional_occupation_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Qoʻshimcha kasblar',
            'uz-Cyrl': 'Қўшимча касблар',
            ru: 'Дополнительные профессии',
            en: 'Additional occupations',
          },
          storage: { kind: 'occupation_additional' },
          dictionaryType: 'occupation',
          validation: { maxItems: 4 },
        },
        {
          code: 'industry_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Tarmoqlar',
            'uz-Cyrl': 'Тармоқлар',
            ru: 'Отрасли',
            en: 'Industries',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'industry',
          validation: { maxItems: 5 },
        },
      ],
    },

    // --- skills (§5.1) -----------------------------------------------------
    {
      code: 'skills',
      source: 'core',
      labels: {
        'uz-Latn': 'Koʻnikmalar',
        'uz-Cyrl': 'Кўникмалар',
        ru: 'Навыки',
        en: 'Skills',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'skills',
          kind: 'dictionary_leveled',
          labels: {
            'uz-Latn': 'Koʻnikmalar va daraja',
            'uz-Cyrl': 'Кўникмалар ва даража',
            ru: 'Навыки и уровень',
            en: 'Skills and level',
          },
          storage: { kind: 'skills' },
          dictionaryType: 'skill',
          levelDictionaryType: 'skill_level',
          validation: { maxItems: 30 },
        },
      ],
    },

    // --- languages (§5.1) --------------------------------------------------
    {
      code: 'languages',
      source: 'core',
      labels: {
        'uz-Latn': 'Tillar',
        'uz-Cyrl': 'Тиллар',
        ru: 'Языки',
        en: 'Languages',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'languages',
          kind: 'dictionary_leveled',
          labels: {
            'uz-Latn': 'Tillar va daraja',
            'uz-Cyrl': 'Тиллар ва даража',
            ru: 'Языки и уровень',
            en: 'Languages and level',
          },
          storage: { kind: 'languages' },
          dictionaryType: 'language',
          levelDictionaryType: 'language_level',
          // §5.1 "certificate details optional" - the reason §4.4 has extras at
          // all, on the candidate side.
          extras: [
            {
              code: 'has_certificate',
              kind: 'bool',
              labels: {
                'uz-Latn': 'Sertifikat bor',
                'uz-Cyrl': 'Сертификат бор',
                ru: 'Есть сертификат',
                en: 'Has a certificate',
              },
            },
            {
              code: 'certificate_note',
              kind: 'text',
              labels: {
                'uz-Latn': 'Sertifikat haqida',
                'uz-Cyrl': 'Сертификат ҳақида',
                ru: 'О сертификате',
                en: 'Certificate details',
              },
              validation: { maxLength: 200 },
            },
          ],
          validation: { maxItems: 10 },
        },
      ],
    },

    // --- experience and education: repeating, bespoke (§4.1) ----------------
    {
      code: 'experience',
      source: 'core',
      labels: {
        'uz-Latn': 'Ish tajribasi',
        'uz-Cyrl': 'Иш тажрибаси',
        ru: 'Опыт работы',
        en: 'Work experience',
      },
      repeating: true,
      editor: 'bespoke',
      endpoint: '/candidates/me/experience',
      fields: [],
    },
    {
      code: 'education',
      source: 'core',
      labels: {
        'uz-Latn': 'Taʼlim',
        'uz-Cyrl': 'Таълим',
        ru: 'Образование',
        en: 'Education',
      },
      repeating: true,
      editor: 'bespoke',
      endpoint: '/candidates/me/education',
      fields: [],
    },

    // --- job preferences (§5.1) --------------------------------------------
    {
      code: 'preferences',
      source: 'core',
      labels: {
        'uz-Latn': 'Ish shartlari',
        'uz-Cyrl': 'Иш шартлари',
        ru: 'Предпочтения по работе',
        en: 'Job preferences',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'employment_type_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Bandlik turi',
            'uz-Cyrl': 'Бандлик тури',
            ru: 'Тип занятости',
            en: 'Employment type',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'employment_type',
          validation: { maxItems: 6 },
        },
        {
          code: 'work_format_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Ish formati',
            'uz-Cyrl': 'Иш формати',
            ru: 'Формат работы',
            en: 'Work format',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'work_format',
          validation: { maxItems: 4 },
        },
        {
          code: 'shift_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Smena',
            'uz-Cyrl': 'Смена',
            ru: 'Смена',
            en: 'Shift',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'shift',
          validation: { maxItems: 4 },
        },
        {
          code: 'salary',
          kind: 'money_range',
          labels: {
            'uz-Latn': 'Kutilayotgan maosh',
            'uz-Cyrl': 'Кутилаётган маош',
            ru: 'Ожидаемая оплата',
            en: 'Expected pay',
          },
          storage: { kind: 'money' },
          currency: 'UZS',
          periodDictionaryType: 'payment_period',
          allowNegotiable: true,
          validation: { min: 0, max: 500_000_000, requireFromLteTo: true },
        },
        {
          code: 'available_from',
          kind: 'date',
          labels: {
            'uz-Latn': 'Qachondan ishlay olaman',
            'uz-Cyrl': 'Қачондан ишлай оламан',
            ru: 'Готов работать с',
            en: 'Available from',
          },
          storage: { kind: 'column', column: 'available_from' },
          // §7.1 Availability is "immediately or from a selected date", and for
          // seasonal and shift work a date the employer can plan against is the
          // whole point - a cotton-planting window cannot be staffed by
          // candidates whose availability is unknown (§7.5).
          requiredIn: ['seasonal_agricultural', 'temporary_shift'],
          // Deliberately no `notBefore`: a date set weeks ago and re-saved
          // unchanged means "available now", and rejecting it would fail a
          // resubmission of a form the candidate did not edit.
        },
      ],
    },

    // --- category fields (§5.2) --------------------------------------------
    {
      code: 'professional_details',
      source: 'category',
      labels: {
        'uz-Latn': 'Kasbiy maʼlumotlar',
        'uz-Cyrl': 'Касбий маълумотлар',
        ru: 'Профессиональные данные',
        en: 'Professional details',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'specialization',
          // Ids, not text, since M7. §7.1 filters on specialization, and a text filter
          // cannot behave identically in four interface variants (§3.3, BR-13) - a
          // candidate's `Информатика` would never meet an employer's `Informatika`.
          // Multi rather than single because a second degree is ordinary.
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Mutaxassislik',
            'uz-Cyrl': 'Мутахассислик',
            ru: 'Специализация',
            en: 'Specialization',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'specialization',
          // The dictionary carries vocational fields as well as degrees, so offering
          // this to the service and physical categories is a one-line change if the
          // client wants it. Left as it was until they say so.
          categories: ['professional'],
          validation: { maxItems: 3 },
        },
        {
          code: 'portfolio_url',
          kind: 'url',
          labels: {
            'uz-Latn': 'Portfolio havolasi',
            'uz-Cyrl': 'Портфолио ҳаволаси',
            ru: 'Ссылка на портфолио',
            en: 'Portfolio link',
          },
          storage: { kind: 'attribute' },
          categories: ['professional'],
          validation: { maxLength: 300 },
        },
      ],
    },
    {
      code: 'work_attributes',
      source: 'category',
      labels: {
        'uz-Latn': 'Ish sharoitlari va imkoniyatlar',
        'uz-Cyrl': 'Иш шароитлари ва имкониятлар',
        ru: 'Условия и возможности работы',
        en: 'Work conditions and capabilities',
      },
      repeating: false,
      editor: 'engine',
      // Per-field categories rather than one section per category: §7.1's
      // physical/seasonal filter group is a single set of attributes, and a
      // courier doing service work needs a licence and a vehicle just as much as
      // a driver doing industrial work. Declaring each field's categories keeps
      // one definition per attribute instead of the same code in four sections.
      fields: [
        {
          code: 'licence_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Haydovchilik guvohnomasi',
            'uz-Cyrl': 'Ҳайдовчилик гувоҳномаси',
            ru: 'Водительские права',
            en: 'Driving licence',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'attribute',
          group: 'licence',
          categories: [
            'physical_industrial',
            'seasonal_agricultural',
            'service_operations',
          ],
          validation: { maxItems: 6 },
        },
        {
          code: 'transport_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Shaxsiy transport',
            'uz-Cyrl': 'Шахсий транспорт',
            ru: 'Личный транспорт',
            en: 'Own transport',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'attribute',
          group: 'transport',
          categories: [
            'physical_industrial',
            'seasonal_agricultural',
            'service_operations',
            'temporary_shift',
          ],
          validation: { maxItems: 4 },
        },
        {
          code: 'tool_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Asboblar va jihozlar',
            'uz-Cyrl': 'Асбоблар ва жиҳозлар',
            ru: 'Инструменты и оснащение',
            en: 'Tools and equipment',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'attribute',
          group: 'tools',
          categories: ['physical_industrial', 'seasonal_agricultural'],
          validation: { maxItems: 10 },
        },
        {
          code: 'readiness_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Ishga tayyorlik',
            'uz-Cyrl': 'Ишга тайёрлик',
            ru: 'Готовность к работе',
            en: 'Work readiness',
          },
          storage: { kind: 'attribute' },
          dictionaryType: 'attribute',
          group: 'readiness',
          categories: [
            'physical_industrial',
            'seasonal_agricultural',
            'service_operations',
            'temporary_shift',
          ],
          validation: { maxItems: 6 },
        },
        {
          code: 'crew_size',
          kind: 'int',
          labels: {
            'uz-Latn': 'Brigada aʼzolari soni',
            'uz-Cyrl': 'Бригада аъзолари сони',
            ru: 'Размер бригады',
            en: 'Crew size',
          },
          storage: { kind: 'attribute' },
          // §7.5 staffs a hectare of cotton with crews, so an employer filters on
          // one; only the two categories that work in crews are asked.
          categories: ['physical_industrial', 'seasonal_agricultural'],
          validation: { min: 1, max: 200 },
        },
      ],
    },
  ],

  // --- attachments (§4.5, §5.4) --------------------------------------------
  attachments: [
    {
      purposeCode: 'cv',
      accept: ['pdf', 'doc', 'docx'],
      // §5.4 is "upload, replace, download and delete a CV" - one document, so a
      // second upload supersedes the first rather than accumulating.
      maxCount: 1,
    },
    {
      purposeCode: 'photo',
      accept: ['jpg', 'jpeg', 'png'],
      maxCount: 1,
    },
    {
      purposeCode: 'certificate',
      accept: ['pdf', 'jpg', 'jpeg', 'png'],
      maxCount: 10,
    },
    {
      purposeCode: 'evidence',
      accept: ['pdf', 'jpg', 'jpeg', 'png'],
      maxCount: 10,
    },
  ],
};
