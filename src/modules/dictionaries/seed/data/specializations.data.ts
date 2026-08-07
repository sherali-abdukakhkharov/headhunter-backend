import type { SeedItem, SeedType } from '../seed-types';

/**
 * Specializations - fields of study and professional specialisms (§7.1's Education and
 * Occupation filter groups).
 *
 * **Why this is a dictionary at all.** §7.1 lists "education level and specialization
 * where relevant" as a filter, and specialization was free text until M7 tried to filter
 * on it. A text filter cannot work here: a candidate who typed `Информатика` would not
 * match an employer typing `Informatika`, and neither would match `Kompyuter
 * injiniringi` - so the filter would succeed or fail depending on which of the four
 * interface variants each of the two people happened to use. That is precisely what
 * BR-13 and §3.3 forbid, and one stable id with four labels is the answer the rest of
 * this product already uses.
 *
 * Grouped by `item_group` into broad fields, so a picker can offer a relevant slice
 * rather than one list of sixty. The group is a UI hint, not a constraint.
 *
 * **Starting set, tagged `default`: the client owns the final list.** It is compiled
 * from the fields Uzbek higher and vocational education actually awards, biased towards
 * what this platform's employers hire for. Two known gaps to raise with them: the
 * vocational (kasb-hunar) catalogue is far longer than this, and university programme
 * names differ between institutions - which is an argument for keeping this list broad
 * and letting the CV carry the exact programme name.
 */

/** Labels in the order **uz-Latn, uz-Cyrl, ru, en**; see locations.data.ts. */
function field(
  itemGroup: string,
  rows: [string, string, string, string, string][],
): SeedItem[] {
  return rows.map(([code, uzLatn, uzCyrl, ru, en]) => ({
    code,
    group: itemGroup,
    labels: { 'uz-Latn': uzLatn, 'uz-Cyrl': uzCyrl, ru, en },
  }));
}

export const SPECIALIZATION_SEED: SeedType = {
  code: 'specialization',
  provenance: 'default',
  note:
    'Fields of study and professional specialisms, grouped by broad field. Replaced a ' +
    'free-text field in M7: a text filter cannot behave identically in four interface ' +
    'variants (§3.3, BR-13). The client approves the final list (§13.2).',
  items: [
    // --- Information technology ---------------------------------------------
    ...field('it', [
      [
        'software_engineering',
        'Dasturiy injiniring',
        'Дастурий инжиниринг',
        'Программная инженерия',
        'Software engineering',
      ],
      [
        'computer_science',
        'Kompyuter ilmlari',
        'Компьютер илмлари',
        'Компьютерные науки',
        'Computer science',
      ],
      [
        'information_systems',
        'Axborot tizimlari',
        'Ахборот тизимлари',
        'Информационные системы',
        'Information systems',
      ],
      [
        'cybersecurity',
        'Axborot xavfsizligi',
        'Ахборот хавфсизлиги',
        'Информационная безопасность',
        'Information security',
      ],
      [
        'data_science',
        'Maʼlumotlar tahlili',
        'Маълумотлар таҳлили',
        'Анализ данных',
        'Data science',
      ],
      [
        'telecommunications',
        'Telekommunikatsiya',
        'Телекоммуникация',
        'Телекоммуникации',
        'Telecommunications',
      ],
    ]),

    // --- Engineering and construction ---------------------------------------
    ...field('engineering', [
      [
        'civil_engineering',
        'Qurilish muhandisligi',
        'Қурилиш муҳандислиги',
        'Строительная инженерия',
        'Civil engineering',
      ],
      [
        'architecture',
        'Arxitektura',
        'Архитектура',
        'Архитектура',
        'Architecture',
      ],
      [
        'mechanical_engineering',
        'Mashinasozlik',
        'Машинасозлик',
        'Машиностроение',
        'Mechanical engineering',
      ],
      [
        'electrical_engineering',
        'Elektr energetikasi',
        'Электр энергетикаси',
        'Электроэнергетика',
        'Electrical engineering',
      ],
      [
        'chemical_engineering',
        'Kimyo texnologiyasi',
        'Кимё технологияси',
        'Химическая технология',
        'Chemical engineering',
      ],
      [
        'oil_and_gas',
        'Neft va gaz ishi',
        'Нефт ва газ иши',
        'Нефтегазовое дело',
        'Oil and gas',
      ],
      [
        'geodesy',
        'Geodeziya va kartografiya',
        'Геодезия ва картография',
        'Геодезия и картография',
        'Geodesy and cartography',
      ],
      [
        'transport_logistics_eng',
        'Transport tizimlari',
        'Транспорт тизимлари',
        'Транспортные системы',
        'Transport systems',
      ],
    ]),

    // --- Economics, business and law ----------------------------------------
    ...field('business', [
      ['economics', 'Iqtisodiyot', 'Иқтисодиёт', 'Экономика', 'Economics'],
      [
        'accounting_audit',
        'Buxgalteriya hisobi va audit',
        'Бухгалтерия ҳисоби ва аудит',
        'Бухгалтерский учёт и аудит',
        'Accounting and audit',
      ],
      [
        'finance_banking',
        'Moliya va bank ishi',
        'Молия ва банк иши',
        'Финансы и банковское дело',
        'Finance and banking',
      ],
      ['management', 'Menejment', 'Менежмент', 'Менеджмент', 'Management'],
      ['marketing', 'Marketing', 'Маркетинг', 'Маркетинг', 'Marketing'],
      ['logistics_supply', 'Logistika', 'Логистика', 'Логистика', 'Logistics'],
      [
        'human_resources',
        'Kadrlar boshqaruvi',
        'Кадрлар бошқаруви',
        'Управление персоналом',
        'Human resources',
      ],
      ['law', 'Yurisprudensiya', 'Юриспруденция', 'Юриспруденция', 'Law'],
      [
        'international_relations',
        'Xalqaro munosabatlar',
        'Халқаро муносабатлар',
        'Международные отношения',
        'International relations',
      ],
    ]),

    // --- Healthcare ----------------------------------------------------------
    ...field('healthcare', [
      [
        'general_medicine',
        'Davolash ishi',
        'Даволаш иши',
        'Лечебное дело',
        'General medicine',
      ],
      [
        'nursing',
        'Hamshiralik ishi',
        'Ҳамширалик иши',
        'Сестринское дело',
        'Nursing',
      ],
      [
        'dentistry',
        'Stomatologiya',
        'Стоматология',
        'Стоматология',
        'Dentistry',
      ],
      ['pharmacy', 'Farmatsiya', 'Фармация', 'Фармация', 'Pharmacy'],
      ['paediatrics', 'Pediatriya', 'Педиатрия', 'Педиатрия', 'Paediatrics'],
      [
        'public_health',
        'Jamoat salomatligi',
        'Жамоат саломатлиги',
        'Общественное здравоохранение',
        'Public health',
      ],
    ]),

    // --- Education and humanities -------------------------------------------
    ...field('education_humanities', [
      [
        'primary_education',
        'Boshlangʻich taʼlim',
        'Бошланғич таълим',
        'Начальное образование',
        'Primary education',
      ],
      [
        'preschool_education',
        'Maktabgacha taʼlim',
        'Мактабгача таълим',
        'Дошкольное образование',
        'Preschool education',
      ],
      [
        'philology_uzbek',
        'Oʻzbek tili va adabiyoti',
        'Ўзбек тили ва адабиёти',
        'Узбекский язык и литература',
        'Uzbek language and literature',
      ],
      [
        'philology_russian',
        'Rus tili va adabiyoti',
        'Рус тили ва адабиёти',
        'Русский язык и литература',
        'Russian language and literature',
      ],
      [
        'philology_english',
        'Ingliz tili va adabiyoti',
        'Инглиз тили ва адабиёти',
        'Английский язык и литература',
        'English language and literature',
      ],
      [
        'translation_studies',
        'Tarjimashunoslik',
        'Таржимашунослик',
        'Переводоведение',
        'Translation studies',
      ],
      ['history', 'Tarix', 'Тарих', 'История', 'History'],
      ['psychology', 'Psixologiya', 'Психология', 'Психология', 'Psychology'],
      [
        'journalism',
        'Jurnalistika',
        'Журналистика',
        'Журналистика',
        'Journalism',
      ],
    ]),

    // --- Natural and exact sciences -----------------------------------------
    ...field('sciences', [
      ['mathematics', 'Matematika', 'Математика', 'Математика', 'Mathematics'],
      ['physics', 'Fizika', 'Физика', 'Физика', 'Physics'],
      ['chemistry', 'Kimyo', 'Кимё', 'Химия', 'Chemistry'],
      ['biology', 'Biologiya', 'Биология', 'Биология', 'Biology'],
      ['ecology', 'Ekologiya', 'Экология', 'Экология', 'Ecology'],
    ]),

    // --- Agriculture ---------------------------------------------------------
    ...field('agriculture', [
      ['agronomy', 'Agronomiya', 'Агрономия', 'Агрономия', 'Agronomy'],
      [
        'veterinary',
        'Veterinariya',
        'Ветеринария',
        'Ветеринария',
        'Veterinary medicine',
      ],
      [
        'horticulture',
        'Bogʻdorchilik',
        'Боғдорчилик',
        'Садоводство',
        'Horticulture',
      ],
      [
        'livestock',
        'Chorvachilik',
        'Чорвачилик',
        'Животноводство',
        'Livestock farming',
      ],
      [
        'water_management',
        'Suv xoʻjaligi',
        'Сув хўжалиги',
        'Водное хозяйство',
        'Water management',
      ],
      [
        'food_technology',
        'Oziq-ovqat texnologiyasi',
        'Озиқ-овқат технологияси',
        'Пищевая технология',
        'Food technology',
      ],
    ]),

    // --- Service, trade and crafts ------------------------------------------
    // The vocational side of the list. §2.1's service, physical and seasonal
    // categories hire from here far more than from the university fields above, and a
    // dictionary that only covered degrees would be useless to most of this platform.
    ...field('service_crafts', [
      [
        'tourism_hospitality',
        'Turizm va mehmondoʻstlik',
        'Туризм ва меҳмондўстлик',
        'Туризм и гостеприимство',
        'Tourism and hospitality',
      ],
      [
        'culinary',
        'Pazandachilik',
        'Пазандачилик',
        'Кулинария',
        'Culinary arts',
      ],
      [
        'trade_commerce',
        'Savdo ishi',
        'Савдо иши',
        'Торговое дело',
        'Trade and commerce',
      ],
      [
        'hairdressing_beauty',
        'Sartaroshlik va goʻzallik',
        'Сартарошлик ва гўзаллик',
        'Парикмахерское дело и красота',
        'Hairdressing and beauty',
      ],
      [
        'sewing_textile',
        'Tikuvchilik va toʻqimachilik',
        'Тикувчилик ва тўқимачилик',
        'Швейное и текстильное дело',
        'Sewing and textiles',
      ],
      [
        'welding',
        'Payvandlash ishi',
        'Пайвандлаш иши',
        'Сварочное дело',
        'Welding',
      ],
      [
        'electrical_fitting',
        'Elektromontaj',
        'Электромонтаж',
        'Электромонтаж',
        'Electrical fitting',
      ],
      [
        'plumbing_hvac',
        'Santexnika va isitish tizimlari',
        'Сантехника ва иситиш тизимлари',
        'Сантехника и системы отопления',
        'Plumbing and heating',
      ],
      [
        'auto_mechanics',
        'Avtomobil mexanikasi',
        'Автомобил механикаси',
        'Автомеханика',
        'Auto mechanics',
      ],
      [
        'driving_transport',
        'Haydovchilik',
        'Ҳайдовчилик',
        'Вождение',
        'Driving',
      ],
      ['design_graphics', 'Dizayn', 'Дизайн', 'Дизайн', 'Design'],
    ]),
  ],
};
