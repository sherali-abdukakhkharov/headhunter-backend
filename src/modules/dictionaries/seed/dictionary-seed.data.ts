import type { DictionaryCategory, LocaleCode } from '@infra/db/database.types';

/**
 * Initial dictionary content (§13.2 "Initial dictionaries", BR-13).
 *
 * **Every item carries all four labels.** The database refuses to activate one
 * that does not (§3.2), so an entry with a missing locale fails the seed rather
 * than reaching a picker as a technical key.
 *
 * Each type below is tagged with where its values come from, because that
 * distinction decides who may change them:
 *
 * - `spec` - enumerated in [docs/SPEC.md](../../../../docs/SPEC.md) or frozen in
 *   `docs/API_CONTRACTS.md`. Changing these is a specification change.
 * - `default` - the spec requires the dictionary but does not enumerate its
 *   values. A conventional scale is seeded so the dependent milestones can be
 *   built and tested; **the client still has to approve the list** (TODO.md, open
 *   decision "approved dictionary value lists").
 * - `awaiting` - a large content list only the client can supply. The type is
 *   registered and its endpoint works, returning an empty set until the list
 *   arrives. This is the project's largest content dependency, not a coding task.
 */

export type SeedProvenance = 'spec' | 'default' | 'awaiting';

export interface SeedItem {
  code: string;
  labels: Record<LocaleCode, string>;
  category?: DictionaryCategory;
  group?: string;
  /** Ordered scales only, and uniform per type (API_CONTRACTS.md §3.4). */
  rank?: number;
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

/** The 14 frozen types of docs/API_CONTRACTS.md §3.1, in that order. */
export const DICTIONARY_SEED: SeedType[] = [
  {
    code: 'occupation',
    provenance: 'awaiting',
    note:
      'Occupations and work types across all five §2.1 categories, each with ' +
      'a category. The single largest content item in the project.',
    items: [],
  },
  {
    code: 'skill',
    provenance: 'awaiting',
    note: 'Skill list per occupation family; merging is supported (§10.3).',
    items: [],
  },
  {
    code: 'industry',
    provenance: 'awaiting',
    note: 'Industry / company sector list (§7.1 "industry/category").',
    items: [],
  },
  {
    code: 'region',
    provenance: 'spec',
    note:
      'The twelve regions, Karakalpakstan and Tashkent city. Districts and ' +
      'cities hang off these by parent_id and are still awaited - roughly 200 ' +
      'rows the client must confirm against the official register.',
    items: [
      {
        code: 'tashkent_city',
        labels: {
          'uz-Latn': 'Toshkent shahri',
          'uz-Cyrl': 'Тошкент шаҳри',
          ru: 'город Ташкент',
          en: 'Tashkent City',
        },
      },
      {
        code: 'tashkent_region',
        labels: {
          'uz-Latn': 'Toshkent viloyati',
          'uz-Cyrl': 'Тошкент вилояти',
          ru: 'Ташкентская область',
          en: 'Tashkent Region',
        },
      },
      {
        code: 'andijan',
        labels: {
          'uz-Latn': 'Andijon viloyati',
          'uz-Cyrl': 'Андижон вилояти',
          ru: 'Андижанская область',
          en: 'Andijan Region',
        },
      },
      {
        code: 'bukhara',
        labels: {
          'uz-Latn': 'Buxoro viloyati',
          'uz-Cyrl': 'Бухоро вилояти',
          ru: 'Бухарская область',
          en: 'Bukhara Region',
        },
      },
      {
        code: 'fergana',
        labels: {
          'uz-Latn': 'Farg‘ona viloyati',
          'uz-Cyrl': 'Фарғона вилояти',
          ru: 'Ферганская область',
          en: 'Fergana Region',
        },
      },
      {
        code: 'jizzakh',
        labels: {
          'uz-Latn': 'Jizzax viloyati',
          'uz-Cyrl': 'Жиззах вилояти',
          ru: 'Джизакская область',
          en: 'Jizzakh Region',
        },
      },
      {
        code: 'kashkadarya',
        labels: {
          'uz-Latn': 'Qashqadaryo viloyati',
          'uz-Cyrl': 'Қашқадарё вилояти',
          ru: 'Кашкадарьинская область',
          en: 'Kashkadarya Region',
        },
      },
      {
        code: 'navoiy',
        labels: {
          'uz-Latn': 'Navoiy viloyati',
          'uz-Cyrl': 'Навоий вилояти',
          ru: 'Навоийская область',
          en: 'Navoiy Region',
        },
      },
      {
        code: 'namangan',
        labels: {
          'uz-Latn': 'Namangan viloyati',
          'uz-Cyrl': 'Наманган вилояти',
          ru: 'Наманганская область',
          en: 'Namangan Region',
        },
      },
      {
        code: 'samarkand',
        labels: {
          'uz-Latn': 'Samarqand viloyati',
          'uz-Cyrl': 'Самарқанд вилояти',
          ru: 'Самаркандская область',
          en: 'Samarkand Region',
        },
      },
      {
        code: 'syrdarya',
        labels: {
          'uz-Latn': 'Sirdaryo viloyati',
          'uz-Cyrl': 'Сирдарё вилояти',
          ru: 'Сырдарьинская область',
          en: 'Syrdarya Region',
        },
      },
      {
        code: 'surkhandarya',
        labels: {
          'uz-Latn': 'Surxondaryo viloyati',
          'uz-Cyrl': 'Сурхондарё вилояти',
          ru: 'Сурхандарьинская область',
          en: 'Surkhandarya Region',
        },
      },
      {
        code: 'khorezm',
        labels: {
          'uz-Latn': 'Xorazm viloyati',
          'uz-Cyrl': 'Хоразм вилояти',
          ru: 'Хорезмская область',
          en: 'Khorezm Region',
        },
      },
      {
        code: 'karakalpakstan',
        labels: {
          'uz-Latn': 'Qoraqalpog‘iston Respublikasi',
          'uz-Cyrl': 'Қорақалпоғистон Республикаси',
          ru: 'Республика Каракалпакстан',
          en: 'Republic of Karakalpakstan',
        },
      },
    ],
  },
  {
    code: 'language',
    provenance: 'default',
    note:
      'The languages actually used in Uzbek hiring. Long enough to be useful ' +
      'in M3, short enough to review - the client should confirm and extend it.',
    items: [
      {
        code: 'uzbek',
        labels: {
          'uz-Latn': 'O‘zbek tili',
          'uz-Cyrl': 'Ўзбек тили',
          ru: 'Узбекский',
          en: 'Uzbek',
        },
      },
      {
        code: 'russian',
        labels: {
          'uz-Latn': 'Rus tili',
          'uz-Cyrl': 'Рус тили',
          ru: 'Русский',
          en: 'Russian',
        },
      },
      {
        code: 'english',
        labels: {
          'uz-Latn': 'Ingliz tili',
          'uz-Cyrl': 'Инглиз тили',
          ru: 'Английский',
          en: 'English',
        },
      },
      {
        code: 'karakalpak',
        labels: {
          'uz-Latn': 'Qoraqalpoq tili',
          'uz-Cyrl': 'Қорақалпоқ тили',
          ru: 'Каракалпакский',
          en: 'Karakalpak',
        },
      },
      {
        code: 'tajik',
        labels: {
          'uz-Latn': 'Tojik tili',
          'uz-Cyrl': 'Тожик тили',
          ru: 'Таджикский',
          en: 'Tajik',
        },
      },
      {
        code: 'kazakh',
        labels: {
          'uz-Latn': 'Qozoq tili',
          'uz-Cyrl': 'Қозоқ тили',
          ru: 'Казахский',
          en: 'Kazakh',
        },
      },
      {
        code: 'kyrgyz',
        labels: {
          'uz-Latn': 'Qirg‘iz tili',
          'uz-Cyrl': 'Қирғиз тили',
          ru: 'Киргизский',
          en: 'Kyrgyz',
        },
      },
      {
        code: 'turkish',
        labels: {
          'uz-Latn': 'Turk tili',
          'uz-Cyrl': 'Турк тили',
          ru: 'Турецкий',
          en: 'Turkish',
        },
      },
      {
        code: 'korean',
        labels: {
          'uz-Latn': 'Koreys tili',
          'uz-Cyrl': 'Корейс тили',
          ru: 'Корейский',
          en: 'Korean',
        },
      },
      {
        code: 'chinese',
        labels: {
          'uz-Latn': 'Xitoy tili',
          'uz-Cyrl': 'Хитой тили',
          ru: 'Китайский',
          en: 'Chinese',
        },
      },
      {
        code: 'arabic',
        labels: {
          'uz-Latn': 'Arab tili',
          'uz-Cyrl': 'Араб тили',
          ru: 'Арабский',
          en: 'Arabic',
        },
      },
      {
        code: 'german',
        labels: {
          'uz-Latn': 'Nemis tili',
          'uz-Cyrl': 'Немис тили',
          ru: 'Немецкий',
          en: 'German',
        },
      },
    ],
  },
  {
    code: 'language_level',
    provenance: 'spec',
    hasRank: true,
    note:
      '§7.1 "A1–C2/native". The rank is what a "≥ C1" filter compares (§7.4), ' +
      'which is why this is a scale and not a set.',
    items: [
      {
        code: 'a1',
        rank: 1,
        labels: {
          'uz-Latn': 'A1 – Boshlang‘ich',
          'uz-Cyrl': 'A1 – Бошланғич',
          ru: 'A1 – Начальный',
          en: 'A1 – Beginner',
        },
      },
      {
        code: 'a2',
        rank: 2,
        labels: {
          'uz-Latn': 'A2 – Elementar',
          'uz-Cyrl': 'A2 – Элементар',
          ru: 'A2 – Элементарный',
          en: 'A2 – Elementary',
        },
      },
      {
        code: 'b1',
        rank: 3,
        labels: {
          'uz-Latn': 'B1 – O‘rta',
          'uz-Cyrl': 'B1 – Ўрта',
          ru: 'B1 – Средний',
          en: 'B1 – Intermediate',
        },
      },
      {
        code: 'b2',
        rank: 4,
        labels: {
          'uz-Latn': 'B2 – O‘rtadan yuqori',
          'uz-Cyrl': 'B2 – Ўртадан юқори',
          ru: 'B2 – Выше среднего',
          en: 'B2 – Upper-intermediate',
        },
      },
      {
        code: 'c1',
        rank: 5,
        labels: {
          'uz-Latn': 'C1 – Ilg‘or',
          'uz-Cyrl': 'C1 – Илғор',
          ru: 'C1 – Продвинутый',
          en: 'C1 – Advanced',
        },
      },
      {
        code: 'c2',
        rank: 6,
        labels: {
          'uz-Latn': 'C2 – Mukammal',
          'uz-Cyrl': 'C2 – Мукаммал',
          ru: 'C2 – В совершенстве',
          en: 'C2 – Proficient',
        },
      },
      {
        code: 'native',
        rank: 7,
        labels: {
          'uz-Latn': 'Ona tili',
          'uz-Cyrl': 'Она тили',
          ru: 'Родной язык',
          en: 'Native',
        },
      },
    ],
  },
  {
    code: 'skill_level',
    provenance: 'default',
    hasRank: true,
    note:
      '§6.3 and §7.1 require a skill proficiency without enumerating one. A ' +
      'four-step scale is seeded so vacancy requirements and search can be ' +
      'built; the wording needs client approval.',
    items: [
      {
        code: 'basic',
        rank: 1,
        labels: {
          'uz-Latn': 'Boshlang‘ich',
          'uz-Cyrl': 'Бошланғич',
          ru: 'Базовый',
          en: 'Basic',
        },
      },
      {
        code: 'intermediate',
        rank: 2,
        labels: {
          'uz-Latn': 'O‘rta',
          'uz-Cyrl': 'Ўрта',
          ru: 'Средний',
          en: 'Intermediate',
        },
      },
      {
        code: 'advanced',
        rank: 3,
        labels: {
          'uz-Latn': 'Ilg‘or',
          'uz-Cyrl': 'Илғор',
          ru: 'Продвинутый',
          en: 'Advanced',
        },
      },
      {
        code: 'expert',
        rank: 4,
        labels: {
          'uz-Latn': 'Ekspert',
          'uz-Cyrl': 'Эксперт',
          ru: 'Эксперт',
          en: 'Expert',
        },
      },
    ],
  },
  {
    code: 'employment_type',
    provenance: 'spec',
    note: '§6.3 Schedule: "Full-time, part-time, shift, temporary, seasonal".',
    items: [
      {
        code: 'full_time',
        labels: {
          'uz-Latn': 'To‘liq bandlik',
          'uz-Cyrl': 'Тўлиқ бандлик',
          ru: 'Полная занятость',
          en: 'Full-time',
        },
      },
      {
        code: 'part_time',
        labels: {
          'uz-Latn': 'Qismiy bandlik',
          'uz-Cyrl': 'Қисмий бандлик',
          ru: 'Частичная занятость',
          en: 'Part-time',
        },
      },
      {
        code: 'shift',
        labels: {
          'uz-Latn': 'Smenali ish',
          'uz-Cyrl': 'Сменали иш',
          ru: 'Сменная работа',
          en: 'Shift work',
        },
      },
      {
        code: 'temporary',
        labels: {
          'uz-Latn': 'Vaqtinchalik ish',
          'uz-Cyrl': 'Вақтинчалик иш',
          ru: 'Временная работа',
          en: 'Temporary',
        },
      },
      {
        code: 'seasonal',
        labels: {
          'uz-Latn': 'Mavsumiy ish',
          'uz-Cyrl': 'Мавсумий иш',
          ru: 'Сезонная работа',
          en: 'Seasonal',
        },
      },
    ],
  },
  {
    code: 'work_format',
    provenance: 'spec',
    note: '§6.3 "on-site/remote/hybrid", plus field work for §2.1 seasonal.',
    items: [
      {
        code: 'on_site',
        labels: {
          'uz-Latn': 'Ish joyida',
          'uz-Cyrl': 'Иш жойида',
          ru: 'На месте',
          en: 'On-site',
        },
      },
      {
        code: 'remote',
        labels: {
          'uz-Latn': 'Masofadan',
          'uz-Cyrl': 'Масофадан',
          ru: 'Удалённо',
          en: 'Remote',
        },
      },
      {
        code: 'hybrid',
        labels: {
          'uz-Latn': 'Gibrid',
          'uz-Cyrl': 'Гибрид',
          ru: 'Гибридный',
          en: 'Hybrid',
        },
      },
      {
        code: 'field',
        labels: {
          'uz-Latn': 'Dala ishi',
          'uz-Cyrl': 'Дала иши',
          ru: 'Выездная работа',
          en: 'Field work',
        },
      },
    ],
  },
  {
    code: 'shift',
    provenance: 'default',
    note:
      '§5.5 and §7.1 filter on shift without enumerating the values. Seeded ' +
      'with the common patterns; needs client approval.',
    items: [
      {
        code: 'day',
        labels: {
          'uz-Latn': 'Kunduzgi smena',
          'uz-Cyrl': 'Кундузги смена',
          ru: 'Дневная смена',
          en: 'Day shift',
        },
      },
      {
        code: 'night',
        labels: {
          'uz-Latn': 'Tungi smena',
          'uz-Cyrl': 'Тунги смена',
          ru: 'Ночная смена',
          en: 'Night shift',
        },
      },
      {
        code: 'rotating',
        labels: {
          'uz-Latn': 'Almashinuvchi smena',
          'uz-Cyrl': 'Алмашинувчи смена',
          ru: 'Скользящая смена',
          en: 'Rotating shift',
        },
      },
      {
        code: 'flexible',
        labels: {
          'uz-Latn': 'Erkin jadval',
          'uz-Cyrl': 'Эркин жадвал',
          ru: 'Гибкий график',
          en: 'Flexible schedule',
        },
      },
    ],
  },
  {
    code: 'payment_period',
    provenance: 'spec',
    note: '§6.3 Salary: "Range, daily/monthly/per-task, or negotiable".',
    items: [
      {
        code: 'monthly',
        labels: {
          'uz-Latn': 'Oylik',
          'uz-Cyrl': 'Ойлик',
          ru: 'В месяц',
          en: 'Per month',
        },
      },
      {
        code: 'daily',
        labels: {
          'uz-Latn': 'Kunlik',
          'uz-Cyrl': 'Кунлик',
          ru: 'В день',
          en: 'Per day',
        },
      },
      {
        code: 'per_task',
        labels: {
          'uz-Latn': 'Ish hajmiga qarab',
          'uz-Cyrl': 'Иш ҳажмига қараб',
          ru: 'За объём работы',
          en: 'Per task',
        },
      },
    ],
  },
  {
    code: 'education_level',
    provenance: 'default',
    note:
      '§7.1 filters on education level without enumerating it. Seeded with the ' +
      'Uzbek ladder; needs client approval.',
    items: [
      {
        code: 'none',
        labels: {
          'uz-Latn': 'Talab qilinmaydi',
          'uz-Cyrl': 'Талаб қилинмайди',
          ru: 'Не требуется',
          en: 'Not required',
        },
      },
      {
        code: 'secondary',
        labels: {
          'uz-Latn': 'O‘rta ta’lim',
          'uz-Cyrl': 'Ўрта таълим',
          ru: 'Среднее образование',
          en: 'Secondary education',
        },
      },
      {
        code: 'secondary_special',
        labels: {
          'uz-Latn': 'O‘rta maxsus ta’lim',
          'uz-Cyrl': 'Ўрта махсус таълим',
          ru: 'Среднее специальное',
          en: 'Vocational education',
        },
      },
      {
        code: 'bachelor',
        labels: {
          'uz-Latn': 'Bakalavr',
          'uz-Cyrl': 'Бакалавр',
          ru: 'Бакалавр',
          en: "Bachelor's degree",
        },
      },
      {
        code: 'master',
        labels: {
          'uz-Latn': 'Magistr',
          'uz-Cyrl': 'Магистр',
          ru: 'Магистр',
          en: "Master's degree",
        },
      },
      {
        code: 'doctorate',
        labels: {
          'uz-Latn': 'Doktorantura (PhD, DSc)',
          'uz-Cyrl': 'Докторантура (PhD, DSc)',
          ru: 'Докторантура (PhD, DSc)',
          en: 'Doctorate (PhD, DSc)',
        },
      },
    ],
  },
  {
    code: 'file_purpose',
    provenance: 'spec',
    note:
      'docs/API_CONTRACTS.md §4.5: the attachments block is driven by this ' +
      'dictionary, so a new evidence type is a row here rather than a client ' +
      'release.',
    items: [
      {
        code: 'cv',
        labels: {
          'uz-Latn': 'Rezyume',
          'uz-Cyrl': 'Резюме',
          ru: 'Резюме',
          en: 'CV',
        },
      },
      {
        code: 'certificate',
        labels: {
          'uz-Latn': 'Sertifikat',
          'uz-Cyrl': 'Сертификат',
          ru: 'Сертификат',
          en: 'Certificate',
        },
      },
      {
        code: 'evidence',
        labels: {
          'uz-Latn': 'Tasdiqlovchi hujjat',
          'uz-Cyrl': 'Тасдиқловчи ҳужжат',
          ru: 'Подтверждающий документ',
          en: 'Supporting document',
        },
      },
    ],
  },
  {
    code: 'attribute',
    provenance: 'spec',
    note:
      '§6.3 "driving licence, vehicle, tools, field travel, physical readiness, ' +
      'crew requirement" and the §7.1 physical/seasonal filter group. Grouped ' +
      'by `item_group` so a schema field can request just one group.',
    items: [
      {
        code: 'licence_a',
        group: 'licence',
        labels: {
          'uz-Latn': 'A toifa haydovchilik guvohnomasi',
          'uz-Cyrl': 'A тоифа ҳайдовчилик гувоҳномаси',
          ru: 'Водительские права категории A',
          en: 'Driving licence, category A',
        },
      },
      {
        code: 'licence_b',
        group: 'licence',
        labels: {
          'uz-Latn': 'B toifa haydovchilik guvohnomasi',
          'uz-Cyrl': 'B тоифа ҳайдовчилик гувоҳномаси',
          ru: 'Водительские права категории B',
          en: 'Driving licence, category B',
        },
      },
      {
        code: 'licence_c',
        group: 'licence',
        labels: {
          'uz-Latn': 'C toifa haydovchilik guvohnomasi',
          'uz-Cyrl': 'C тоифа ҳайдовчилик гувоҳномаси',
          ru: 'Водительские права категории C',
          en: 'Driving licence, category C',
        },
      },
      {
        code: 'licence_d',
        group: 'licence',
        labels: {
          'uz-Latn': 'D toifa haydovchilik guvohnomasi',
          'uz-Cyrl': 'D тоифа ҳайдовчилик гувоҳномаси',
          ru: 'Водительские права категории D',
          en: 'Driving licence, category D',
        },
      },
      {
        code: 'own_car',
        group: 'transport',
        labels: {
          'uz-Latn': 'Shaxsiy avtomobil',
          'uz-Cyrl': 'Шахсий автомобил',
          ru: 'Личный автомобиль',
          en: 'Own car',
        },
      },
      {
        code: 'own_motorcycle',
        group: 'transport',
        labels: {
          'uz-Latn': 'Shaxsiy mototsikl',
          'uz-Cyrl': 'Шахсий мотоцикл',
          ru: 'Личный мотоцикл',
          en: 'Own motorcycle',
        },
      },
      {
        code: 'own_truck',
        group: 'transport',
        labels: {
          'uz-Latn': 'Shaxsiy yuk mashinasi',
          'uz-Cyrl': 'Шахсий юк машинаси',
          ru: 'Личный грузовой автомобиль',
          en: 'Own truck',
        },
      },
      {
        code: 'hand_tools',
        group: 'tools',
        labels: {
          'uz-Latn': 'Qo‘l asboblari',
          'uz-Cyrl': 'Қўл асбоблари',
          ru: 'Ручной инструмент',
          en: 'Hand tools',
        },
      },
      {
        code: 'power_tools',
        group: 'tools',
        labels: {
          'uz-Latn': 'Elektr asboblari',
          'uz-Cyrl': 'Электр асбоблари',
          ru: 'Электроинструмент',
          en: 'Power tools',
        },
      },
      {
        code: 'safety_equipment',
        group: 'tools',
        labels: {
          'uz-Latn': 'Himoya vositalari',
          'uz-Cyrl': 'Ҳимоя воситалари',
          ru: 'Средства защиты',
          en: 'Safety equipment',
        },
      },
      {
        code: 'field_travel',
        group: 'readiness',
        labels: {
          'uz-Latn': 'Dalaga chiqishga tayyor',
          'uz-Cyrl': 'Далага чиқишга тайёр',
          ru: 'Готовность к выездам',
          en: 'Ready for field travel',
        },
      },
      {
        code: 'physical_work',
        group: 'readiness',
        labels: {
          'uz-Latn': 'Jismoniy ishga tayyor',
          'uz-Cyrl': 'Жисмоний ишга тайёр',
          ru: 'Готовность к физическому труду',
          en: 'Ready for physical work',
        },
      },
      {
        code: 'crew_work',
        group: 'readiness',
        labels: {
          'uz-Latn': 'Brigadada ishlashga tayyor',
          'uz-Cyrl': 'Бригадада ишлашга тайёр',
          ru: 'Готовность работать в бригаде',
          en: 'Ready for crew work',
        },
      },
      {
        code: 'daily_work',
        group: 'readiness',
        labels: {
          'uz-Latn': 'Kunlik ishga tayyor',
          'uz-Cyrl': 'Кунлик ишга тайёр',
          ru: 'Готовность к дневной подработке',
          en: 'Ready for daily work',
        },
      },
      {
        code: 'relocation',
        group: 'readiness',
        labels: {
          'uz-Latn': 'Ko‘chib o‘tishga tayyor',
          'uz-Cyrl': 'Кўчиб ўтишга тайёр',
          ru: 'Готовность к переезду',
          en: 'Ready to relocate',
        },
      },
    ],
  },
];
