import { INDUSTRY_SEED, SKILL_SEED } from './data/skills.data';
import { OCCUPATION_SEED } from './data/occupations.data';
import { REGION_SEED } from './data/locations.data';
import { SPECIALIZATION_SEED } from './data/specializations.data';
import type { SeedType } from './seed-types';

export type { SeedItem, SeedProvenance, SeedType } from './seed-types';

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
 *   arrives.
 *
 * The four largest lists live in their own files under `data/`, because a dictionary
 * of 175 districts or 160 occupations is content to be reviewed rather than code to
 * be read, and mixing it in here buries the small scales that everything else
 * depends on.
 */

/**
 * The frozen types of docs/API_CONTRACTS.md §3.1, in that order, plus `gender`
 * added for M3 - see its entry below.
 */
export const DICTIONARY_SEED: SeedType[] = [
  // Large content lists, in data/. See each file's header for provenance.
  OCCUPATION_SEED,
  SKILL_SEED,
  INDUSTRY_SEED,
  REGION_SEED,
  // Added in M7: §7.1's specialization filter needs ids, not the free text the field
  // used to carry - see the file header.
  SPECIALIZATION_SEED,
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
      // §5.1 "profile photo optional" and §7.3's candidate card. A file purpose
      // rather than a schema field, because §4.5 keeps every upload out of the
      // field union - a photo needs the same progress, retry and authorization
      // lifecycle as a CV.
      {
        code: 'photo',
        labels: {
          'uz-Latn': 'Profil surati',
          'uz-Cyrl': 'Профил сурати',
          ru: 'Фото профиля',
          en: 'Profile photo',
        },
      },
      // --- employer verification (§6.1) ---
      // "verification documents if required" for a company and "identity
      // verification data if required by policy" for an individual. Which of these
      // is actually mandatory is an open client decision, so the requirement lives
      // in `employer-requirements.ts` as data and these purposes exist either way.
      {
        code: 'company_registration',
        labels: {
          'uz-Latn': 'Davlat royxatidan otganlik guvohnomasi',
          'uz-Cyrl': 'Давлат рўйхатидан ўтганлик гувоҳномаси',
          ru: 'Свидетельство о регистрации',
          en: 'Certificate of registration',
        },
      },
      {
        code: 'id_document',
        labels: {
          'uz-Latn': 'Shaxsni tasdiqlovchi hujjat',
          'uz-Cyrl': 'Шахсни тасдиқловчи ҳужжат',
          ru: 'Документ, удостоверяющий личность',
          en: 'Identity document',
        },
      },
      {
        code: 'logo',
        labels: {
          'uz-Latn': 'Kompaniya logotipi',
          'uz-Cyrl': 'Компания логотипи',
          ru: 'Логотип компании',
          en: 'Company logo',
        },
      },
    ],
  },
  {
    code: 'restriction_justification',
    provenance: 'default',
    note:
      'BR-12: an age or gender restriction needs "an objective reason" that ' +
      'moderation can validate, so the reasons are enumerated rather than typed. ' +
      'These are the four labels for the employer’s picker; the *rule* about which ' +
      'reason supports which restriction lives in ' +
      'modules/vacancies/age-gender-justifications.ts, deliberately in code - a ' +
      'dictionary row is admin-editable and widening BR-12 must not be a content ' +
      'edit. A test asserts the codes here and there match. Needs legal review by ' +
      'the client. Added 2026-08-05 with M5.',
    items: [
      {
        code: 'statutory_minimum_age',
        labels: {
          'uz-Latn': 'Qonun bilan belgilangan eng kichik yosh',
          'uz-Cyrl': 'Қонун билан белгиланган энг кичик ёш',
          ru: 'Установленный законом минимальный возраст',
          en: 'Statutory minimum age for the work',
        },
      },
      {
        code: 'night_work_restriction',
        labels: {
          'uz-Latn': 'Tungi ishga qonuniy cheklov',
          'uz-Cyrl': 'Тунги ишга қонуний чеклов',
          ru: 'Законодательное ограничение на ночной труд',
          en: 'Legal restriction on night work',
        },
      },
      {
        code: 'hazardous_conditions',
        labels: {
          'uz-Latn': 'Zararli yoki xavfli mehnat sharoitlari',
          'uz-Cyrl': 'Зарарли ёки хавфли меҳнат шароитлари',
          ru: 'Вредные или опасные условия труда',
          en: 'Hazardous or harmful working conditions',
        },
      },
      {
        code: 'heavy_lifting_limits',
        labels: {
          'uz-Latn': 'Yuk ko‘tarish me’yorlari',
          'uz-Cyrl': 'Юк кўтариш меъёрлари',
          ru: 'Нормы подъёма тяжестей',
          en: 'Statutory manual-handling limits',
        },
      },
      {
        code: 'single_sex_facility',
        labels: {
          'uz-Latn': 'Bir jinsli muhit talab qilinadigan ish',
          'uz-Cyrl': 'Бир жинсли муҳит талаб қилинадиган иш',
          ru: 'Работа в среде одного пола',
          en: 'Work in a single-sex setting',
        },
      },
    ],
  },
  {
    code: 'gender',
    provenance: 'spec',
    note:
      '§5.1 personal information asks for gender, and §7.1 / BR-12 let a ' +
      'moderated vacancy restrict on it. A dictionary rather than an enum ' +
      'because the field schema has no `enum` kind (API_CONTRACTS.md §4.2), the ' +
      'four labels have to come from somewhere, and a vacancy restriction and a ' +
      'profile must reference the same id. Added 2026-08-05 with M3.',
    items: [
      {
        code: 'male',
        labels: {
          'uz-Latn': 'Erkak',
          'uz-Cyrl': 'Эркак',
          ru: 'Мужской',
          en: 'Male',
        },
      },
      {
        code: 'female',
        labels: {
          'uz-Latn': 'Ayol',
          'uz-Cyrl': 'Аёл',
          ru: 'Женский',
          en: 'Female',
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
