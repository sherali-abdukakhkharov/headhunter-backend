import type { FieldSchemaDefinition } from './schema-types';

/**
 * The vacancy form (§6.3), as one declaration.
 *
 * The second schema target, and it works exactly as the candidate profile's does: the
 * same field kinds, the same resolver, the same validator, the same
 * `requiredForSearchable` guarantee - here read as "required before the vacancy may be
 * submitted for publication". Sharing the mechanism is the point: the client's form
 * engine renders both, and a rule fixed for one is fixed for both.
 *
 * What is deliberately **not** a field here:
 *
 * - **Status.** §6.4's machine is driven by explicit transitions with audit rows
 *   (BR-08), not by writing a value into a form.
 * - **The employer.** It is the authenticated caller; a vacancy that could name its
 *   own owner would be an authorization hole.
 * - **`category`.** Derived from the occupation, as on a candidate profile, so a
 *   vacancy cannot claim a category its occupation contradicts.
 * - **`hired_count`.** Maintained by M6's application stage moves (§6.5), never
 *   entered.
 *
 * The requirement sections are what make §7's search possible: every filter group in
 * §7.1 has a counterpart here, because UAT-06 opens candidate search *from a vacancy*
 * with its requirements prefilled. A requirement with no matching candidate field
 * would be a filter that can never match.
 */
export const VACANCY_SCHEMA: FieldSchemaDefinition = {
  target: 'vacancy',
  version: 2,
  sections: [
    // --- what and how many (§6.3) -------------------------------------------
    {
      code: 'basics',
      source: 'core',
      labels: {
        'uz-Latn': 'Vakansiya haqida',
        'uz-Cyrl': 'Вакансия ҳақида',
        ru: 'О вакансии',
        en: 'About the vacancy',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'occupation_id',
          kind: 'dictionary_single',
          labels: {
            'uz-Latn': 'Kasb yoki ish turi',
            'uz-Cyrl': 'Касб ёки иш тури',
            ru: 'Профессия или вид работы',
            en: 'Occupation or work type',
          },
          storage: { kind: 'column', column: 'occupation_id' },
          dictionaryType: 'occupation',
          requiredIn: 'all',
        },
        {
          code: 'title',
          kind: 'text',
          labels: {
            'uz-Latn': 'Sarlavha',
            'uz-Cyrl': 'Сарлавҳа',
            ru: 'Заголовок',
            en: 'Title',
          },
          storage: { kind: 'column', column: 'title' },
          requiredIn: 'all',
          validation: { minLength: 5, maxLength: 160 },
        },
        {
          code: 'description',
          kind: 'long_text',
          labels: {
            'uz-Latn': 'Vazifalar va shartlar',
            'uz-Cyrl': 'Вазифалар ва шартлар',
            ru: 'Обязанности и условия',
            en: 'Duties and conditions',
          },
          storage: { kind: 'column', column: 'description' },
          requiredIn: 'all',
          validation: { minLength: 20, maxLength: 5000 },
        },
        {
          code: 'worker_count',
          kind: 'int',
          labels: {
            'uz-Latn': 'Kerakli ishchilar soni',
            'uz-Cyrl': 'Керакли ишчилар сони',
            ru: 'Количество работников',
            en: 'Number of workers',
          },
          storage: { kind: 'column', column: 'worker_count' },
          requiredIn: 'all',
          // BR-05's lower bound, mirrored by a CHECK on the column. §7.4 staffs 20
          // operators and §7.5 a hectare of cotton, so the ceiling is generous.
          validation: { min: 1, max: 10_000 },
        },
      ],
    },

    // --- where (§6.3) --------------------------------------------------------
    {
      code: 'location',
      source: 'core',
      labels: {
        'uz-Latn': 'Ish joyi',
        'uz-Cyrl': 'Иш жойи',
        ru: 'Место работы',
        en: 'Work location',
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
          parentFieldCode: 'region_id',
          requiredIn: 'all',
        },
        {
          code: 'address',
          kind: 'text',
          labels: {
            'uz-Latn': 'Manzil',
            'uz-Cyrl': 'Манзил',
            ru: 'Адрес',
            en: 'Address',
          },
          storage: { kind: 'column', column: 'address' },
          validation: { maxLength: 300 },
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
          storage: { kind: 'requirement' },
          dictionaryType: 'work_format',
          validation: { maxItems: 4 },
        },
      ],
    },

    // --- schedule and pay (§6.3) ---------------------------------------------
    {
      code: 'schedule',
      source: 'core',
      labels: {
        'uz-Latn': 'Jadval va toʻlov',
        'uz-Cyrl': 'Жадвал ва тўлов',
        ru: 'График и оплата',
        en: 'Schedule and pay',
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
          storage: { kind: 'requirement' },
          dictionaryType: 'employment_type',
          requiredIn: 'all',
          validation: { maxItems: 6 },
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
          storage: { kind: 'requirement' },
          dictionaryType: 'shift',
          // Required where the whole point of the vacancy is when the work happens.
          requiredIn: ['temporary_shift'],
          validation: { maxItems: 4 },
        },
        {
          code: 'hours_per_day',
          kind: 'int',
          labels: {
            'uz-Latn': 'Kunlik ish soati',
            'uz-Cyrl': 'Кунлик иш соати',
            ru: 'Часов в день',
            en: 'Hours per day',
          },
          storage: { kind: 'requirement' },
          // §7.5's controlled example specifies working hours, and a seasonal or
          // shift worker cannot judge an offer without them.
          requiredIn: ['seasonal_agricultural', 'temporary_shift'],
          validation: { min: 1, max: 24 },
        },
        {
          code: 'salary',
          kind: 'money_range',
          labels: {
            'uz-Latn': 'Toʻlov',
            'uz-Cyrl': 'Тўлов',
            ru: 'Оплата',
            en: 'Payment',
          },
          storage: { kind: 'money' },
          currency: 'UZS',
          periodDictionaryType: 'payment_period',
          allowNegotiable: true,
          requiredIn: 'all',
          validation: { min: 0, max: 500_000_000, requireFromLteTo: true },
        },
      ],
    },

    // --- dates (§6.3) --------------------------------------------------------
    {
      code: 'dates',
      source: 'core',
      labels: {
        'uz-Latn': 'Muddatlar',
        'uz-Cyrl': 'Муддатлар',
        ru: 'Сроки',
        en: 'Dates',
      },
      repeating: false,
      editor: 'engine',
      fields: [
        {
          code: 'starts_on',
          kind: 'date',
          labels: {
            'uz-Latn': 'Ish boshlanish sanasi',
            'uz-Cyrl': 'Иш бошланиш санаси',
            ru: 'Дата начала работы',
            en: 'Start date',
          },
          storage: { kind: 'column', column: 'starts_on' },
          // Empty means "immediately" (§6.3). Required for seasonal work, where the
          // window is the job: a cotton-planting vacancy with no date cannot be
          // staffed (§7.5).
          requiredIn: ['seasonal_agricultural'],
        },
        {
          code: 'ends_on',
          kind: 'date',
          labels: {
            'uz-Latn': 'Ish tugash sanasi',
            'uz-Cyrl': 'Иш тугаш санаси',
            ru: 'Дата окончания работы',
            en: 'End date',
          },
          storage: { kind: 'column', column: 'ends_on' },
          requiredIn: ['seasonal_agricultural', 'temporary_shift'],
        },
        {
          code: 'deadline_on',
          kind: 'date',
          labels: {
            'uz-Latn': 'Arizalarni qabul qilish muddati',
            'uz-Cyrl': 'Аризаларни қабул қилиш муддати',
            ru: 'Срок приёма заявок',
            en: 'Application deadline',
          },
          storage: { kind: 'column', column: 'deadline_on' },
          // BR-06 enforces it on every application. Not required: an open-ended
          // vacancy is legitimate, and closing it is the employer's action.
        },
      ],
    },

    // --- requirements (§6.3) -------------------------------------------------
    {
      code: 'requirements',
      source: 'core',
      labels: {
        'uz-Latn': 'Talablar',
        'uz-Cyrl': 'Талаблар',
        ru: 'Требования',
        en: 'Requirements',
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
          storage: { kind: 'requirement' },
          dictionaryType: 'skill',
          levelDictionaryType: 'skill_level',
          // §6.3's mandatory/preferred flag. On a skill as well as a language,
          // because M7's match score needs to know which misses disqualify.
          extras: [
            {
              code: 'is_mandatory',
              kind: 'bool',
              labels: {
                'uz-Latn': 'Majburiy',
                'uz-Cyrl': 'Мажбурий',
                ru: 'Обязательно',
                en: 'Mandatory',
              },
            },
          ],
          validation: { maxItems: 20 },
        },
        {
          code: 'languages',
          kind: 'dictionary_leveled',
          labels: {
            'uz-Latn': 'Tillar va daraja',
            'uz-Cyrl': 'Тиллар ва даража',
            ru: 'Языки и уровень',
            en: 'Languages and level',
          },
          storage: { kind: 'requirement' },
          dictionaryType: 'language',
          levelDictionaryType: 'language_level',
          extras: [
            {
              code: 'is_mandatory',
              kind: 'bool',
              labels: {
                'uz-Latn': 'Majburiy',
                'uz-Cyrl': 'Мажбурий',
                ru: 'Обязательно',
                en: 'Mandatory',
              },
            },
          ],
          validation: { maxItems: 10 },
        },
        {
          code: 'experience_years_min',
          kind: 'int',
          labels: {
            'uz-Latn': 'Eng kam ish tajribasi (yil)',
            'uz-Cyrl': 'Энг кам иш тажрибаси (йил)',
            ru: 'Минимальный опыт (лет)',
            en: 'Minimum experience (years)',
          },
          storage: { kind: 'requirement' },
          validation: { min: 0, max: 50 },
        },
        {
          code: 'education_level_id',
          kind: 'dictionary_single',
          labels: {
            'uz-Latn': 'Eng kam taʼlim darajasi',
            'uz-Cyrl': 'Энг кам таълим даражаси',
            ru: 'Минимальное образование',
            en: 'Minimum education',
          },
          storage: { kind: 'requirement' },
          dictionaryType: 'education_level',
        },
      ],
    },

    // --- category-specific requirements (§6.3 "additional structured") --------
    {
      code: 'work_attributes',
      source: 'category',
      labels: {
        'uz-Latn': 'Qoʻshimcha talablar',
        'uz-Cyrl': 'Қўшимча талаблар',
        ru: 'Дополнительные требования',
        en: 'Additional requirements',
      },
      repeating: false,
      editor: 'engine',
      // The same attribute groups the candidate profile offers, so a filter built
      // from these has something to match (§7.1's physical/seasonal group).
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
          storage: { kind: 'requirement' },
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
            'uz-Latn': 'Transport talabi',
            'uz-Cyrl': 'Транспорт талаби',
            ru: 'Требования к транспорту',
            en: 'Transport requirement',
          },
          storage: { kind: 'requirement' },
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
            'uz-Latn': 'Asboblar talabi',
            'uz-Cyrl': 'Асбоблар талаби',
            ru: 'Требования к инструментам',
            en: 'Tools requirement',
          },
          storage: { kind: 'requirement' },
          dictionaryType: 'attribute',
          group: 'tools',
          categories: ['physical_industrial', 'seasonal_agricultural'],
          validation: { maxItems: 10 },
        },
        {
          code: 'readiness_ids',
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Ishga tayyorlik talablari',
            'uz-Cyrl': 'Ишга тайёрлик талаблари',
            ru: 'Требования к готовности',
            en: 'Readiness requirements',
          },
          storage: { kind: 'requirement' },
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
          code: 'crew_required',
          kind: 'bool',
          labels: {
            'uz-Latn': 'Brigada bilan ishlash',
            'uz-Cyrl': 'Бригада билан ишлаш',
            ru: 'Работа бригадой',
            en: 'Crew work',
          },
          storage: { kind: 'requirement' },
          // §7.5 chooses between individual workers and crews.
          categories: ['physical_industrial', 'seasonal_agricultural'],
        },
        {
          code: 'specialization',
          // Ids since M7, in step with the candidate field of the same code - the
          // contract test pins that a shared code means the same thing on both sides,
          // and UAT-06's prefill maps this straight onto the search filter.
          kind: 'dictionary_multi',
          labels: {
            'uz-Latn': 'Mutaxassislik',
            'uz-Cyrl': 'Мутахассислик',
            ru: 'Специализация',
            en: 'Specialization',
          },
          storage: { kind: 'requirement' },
          dictionaryType: 'specialization',
          categories: ['professional'],
          validation: { maxItems: 5 },
        },
      ],
    },

    // --- BR-12 conditional restrictions --------------------------------------
    {
      code: 'restrictions',
      source: 'core',
      labels: {
        'uz-Latn': 'Qonuniy cheklovlar',
        'uz-Cyrl': 'Қонуний чекловлар',
        ru: 'Законные ограничения',
        en: 'Legal restrictions',
      },
      repeating: false,
      editor: 'engine',
      // Every field here is optional, and using any of them forces moderation and
      // requires a justification (BR-12) - **even when MODERATION_ENABLED is off**.
      // See VacanciesService: the flag exists so ordinary vacancies are not stranded
      // without a moderator, not so a restriction can skip the review the
      // specification requires for it.
      fields: [
        {
          code: 'age_min',
          kind: 'int',
          labels: {
            'uz-Latn': 'Eng kichik yosh',
            'uz-Cyrl': 'Энг кичик ёш',
            ru: 'Минимальный возраст',
            en: 'Minimum age',
          },
          storage: { kind: 'column', column: 'age_min' },
          validation: { min: 14, max: 100 },
        },
        {
          code: 'age_max',
          kind: 'int',
          labels: {
            'uz-Latn': 'Eng katta yosh',
            'uz-Cyrl': 'Энг катта ёш',
            ru: 'Максимальный возраст',
            en: 'Maximum age',
          },
          storage: { kind: 'column', column: 'age_max' },
          validation: { min: 14, max: 100 },
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
        {
          code: 'restriction_justification_id',
          kind: 'dictionary_single',
          labels: {
            'uz-Latn': 'Cheklov asosi',
            'uz-Cyrl': 'Чеклов асоси',
            ru: 'Основание ограничения',
            en: 'Grounds for the restriction',
          },
          storage: { kind: 'column', column: 'restriction_justification_id' },
          // An enumerated list, because BR-12 requires moderation to validate the
          // reason and prose cannot be validated.
          dictionaryType: 'restriction_justification',
        },
        {
          code: 'restriction_justification_note',
          kind: 'long_text',
          labels: {
            'uz-Latn': 'Cheklov izohi',
            'uz-Cyrl': 'Чеклов изоҳи',
            ru: 'Пояснение к ограничению',
            en: 'Explanation of the restriction',
          },
          storage: {
            kind: 'column',
            column: 'restriction_justification_note',
          },
          validation: { maxLength: 1000 },
        },
      ],
    },
  ],

  // §4.5: uploads are never schema fields. A vacancy has none of its own - the
  // employer's logo belongs to the employer profile.
  attachments: [],
};
