import type { SeedItem, SeedType } from '../seed-types';

/**
 * Skills (§6.3 "Required skills", §7.1 Skills filter).
 *
 * Grouped by `item_group` so a client can offer a relevant subset next to a chosen
 * occupation instead of one flat list of hundreds. The group is a hint for the UI,
 * not a constraint: §7.1's skills filter is "one or more skills, match all or match
 * any" with no mention of occupation, and a welder who also writes SQL must be able
 * to say so.
 *
 * Proper nouns stay in Latin script in every variant. "PostgreSQL" is not
 * transliterated into Cyrillic by anyone in this market, and a picker that showed
 * "ПостгреСКЛ" would look broken - so those rows deliberately repeat the same
 * string, which the script assertions in `dictionaries.int.spec.ts` allow only when
 * the Latin and Cyrillic labels are identical.
 *
 * Starting set; the client owns the final list (§13.2). Skills are also the one
 * dictionary designed to be merged (§10.3) - duplicates arriving from real usage
 * are expected, and `merged_into_id` is how they are cleaned up without breaking
 * the profiles that reference them.
 */

/** Labels in the order **uz-Latn, uz-Cyrl, ru, en**; see locations.data.ts. */
function skill(
  itemGroup: string,
  code: string,
  uzLatn: string,
  uzCyrl: string,
  ru: string,
  en: string,
): SeedItem {
  return {
    code,
    group: itemGroup,
    labels: { 'uz-Latn': uzLatn, 'uz-Cyrl': uzCyrl, ru, en },
  };
}

/** A name that is the same in all four variants: a product, brand or standard. */
function proper(itemGroup: string, code: string, name: string): SeedItem {
  return {
    code,
    group: itemGroup,
    labels: { 'uz-Latn': name, 'uz-Cyrl': name, ru: name, en: name },
  };
}

function group(
  itemGroup: string,
  rows: [string, string, string, string, string][],
): SeedItem[] {
  return rows.map(([code, uzLatn, uzCyrl, ru, en]) =>
    skill(itemGroup, code, uzLatn, uzCyrl, ru, en),
  );
}

function properGroup(itemGroup: string, rows: [string, string][]): SeedItem[] {
  return rows.map(([code, name]) => proper(itemGroup, code, name));
}

export const SKILL_SEED: SeedType = {
  code: 'skill',
  provenance: 'default',
  note:
    'Starting set, grouped by `item_group` for picker convenience. The client ' +
    'approves the final list; merging duplicates is supported (§10.3).',
  items: [
    // --- Software and IT ---------------------------------------------------
    ...properGroup('it', [
      ['javascript', 'JavaScript'],
      ['typescript', 'TypeScript'],
      ['python', 'Python'],
      ['java', 'Java'],
      ['csharp', 'C#'],
      ['php', 'PHP'],
      ['golang', 'Go'],
      ['kotlin', 'Kotlin'],
      ['swift', 'Swift'],
      ['dart_flutter', 'Flutter'],
      ['react', 'React'],
      ['vue', 'Vue.js'],
      ['angular', 'Angular'],
      ['nodejs', 'Node.js'],
      ['nestjs', 'NestJS'],
      ['laravel', 'Laravel'],
      ['django', 'Django'],
      ['spring', 'Spring'],
      ['dotnet', '.NET'],
      ['postgresql', 'PostgreSQL'],
      ['mysql', 'MySQL'],
      ['mongodb', 'MongoDB'],
      ['redis', 'Redis'],
      ['docker', 'Docker'],
      ['kubernetes', 'Kubernetes'],
      ['git', 'Git'],
      ['linux', 'Linux'],
      ['nginx', 'Nginx'],
      ['aws', 'AWS'],
      ['figma', 'Figma'],
      ['photoshop', 'Adobe Photoshop'],
      ['illustrator', 'Adobe Illustrator'],
      ['autocad', 'AutoCAD'],
      ['solidworks', 'SolidWorks'],
      ['revit', 'Revit'],
      ['sap', 'SAP'],
      ['power_bi', 'Power BI'],
      ['excel', 'Microsoft Excel'],
      ['word', 'Microsoft Word'],
      ['onec', '1C'],
    ]),
    ...group('it', [
      ['sql', 'SQL soʻrovlari', 'SQL сўровлари', 'SQL-запросы', 'SQL Queries'],
      [
        'rest_api',
        'REST API bilan ishlash',
        'REST API билан ишлаш',
        'Работа с REST API',
        'REST API Development',
      ],
      ['html_css', 'HTML va CSS', 'HTML ва CSS', 'HTML и CSS', 'HTML and CSS'],
      [
        'testing',
        'Dasturiy taʼminotni testlash',
        'Дастурий таъминотни тестлаш',
        'Тестирование ПО',
        'Software Testing',
      ],
      [
        'seo',
        'SEO optimallashtirish',
        'SEO оптималлаштириш',
        'SEO-оптимизация',
        'SEO Optimisation',
      ],
      [
        'data_analysis',
        'Maʼlumotlar tahlili',
        'Маълумотлар таҳлили',
        'Анализ данных',
        'Data Analysis',
      ],
      [
        'computer_literacy',
        'Kompyuter savodxonligi',
        'Компьютер саводхонлиги',
        'Компьютерная грамотность',
        'Computer Literacy',
      ],
      [
        'typing_speed',
        'Tez matn kiritish',
        'Тез матн киритиш',
        'Быстрый набор текста',
        'Fast Typing',
      ],
    ]),

    // --- Finance and administration ---------------------------------------
    ...group('finance', [
      [
        'bookkeeping',
        'Buxgalteriya hisobi',
        'Бухгалтерия ҳисоби',
        'Бухгалтерский учёт',
        'Bookkeeping',
      ],
      [
        'tax_reporting',
        'Soliq hisoboti',
        'Солиқ ҳисоботи',
        'Налоговая отчётность',
        'Tax Reporting',
      ],
      [
        'payroll',
        'Ish haqi hisoblash',
        'Иш ҳақи ҳисоблаш',
        'Расчёт заработной платы',
        'Payroll Calculation',
      ],
      [
        'financial_reporting',
        'Moliyaviy hisobot',
        'Молиявий ҳисобот',
        'Финансовая отчётность',
        'Financial Reporting',
      ],
      [
        'budgeting',
        'Budjetlashtirish',
        'Бюджетлаштириш',
        'Бюджетирование',
        'Budgeting',
      ],
      [
        'cash_handling',
        'Kassa bilan ishlash',
        'Касса билан ишлаш',
        'Работа с кассой',
        'Cash Handling',
      ],
      [
        'document_management',
        'Hujjat aylanishi',
        'Ҳужжат айланиши',
        'Документооборот',
        'Document Management',
      ],
      [
        'contract_drafting',
        'Shartnoma tuzish',
        'Шартнома тузиш',
        'Составление договоров',
        'Contract Drafting',
      ],
      [
        'procurement',
        'Xaridlarni tashkil etish',
        'Харидларни ташкил этиш',
        'Организация закупок',
        'Procurement',
      ],
      [
        'inventory_management',
        'Ombor hisobi',
        'Омбор ҳисоби',
        'Складской учёт',
        'Inventory Management',
      ],
    ]),

    // --- Sales, service and communication ---------------------------------
    ...group('sales_service', [
      [
        'sales_technique',
        'Sotuv texnikasi',
        'Сотув техникаси',
        'Техника продаж',
        'Sales Technique',
      ],
      [
        'negotiation',
        'Muzokara olib borish',
        'Музокара олиб бориш',
        'Ведение переговоров',
        'Negotiation',
      ],
      [
        'customer_service',
        'Mijozlar bilan ishlash',
        'Мижозлар билан ишлаш',
        'Работа с клиентами',
        'Customer Service',
      ],
      [
        'cold_calling',
        'Sovuq qoʻngʻiroqlar',
        'Совуқ қўнғироқлар',
        'Холодные звонки',
        'Cold Calling',
      ],
      [
        'crm_work',
        'CRM tizimlari bilan ishlash',
        'CRM тизимлари билан ишлаш',
        'Работа с CRM-системами',
        'CRM Systems',
      ],
      [
        'cash_register',
        'Kassa apparati bilan ishlash',
        'Касса аппарати билан ишлаш',
        'Работа с кассовым аппаратом',
        'Cash Register Operation',
      ],
      [
        'merchandising',
        'Tovarlarni joylashtirish',
        'Товарларни жойлаштириш',
        'Выкладка товара',
        'Merchandising',
      ],
      [
        'complaint_handling',
        'Eʼtirozlar bilan ishlash',
        'Эътирозлар билан ишлаш',
        'Работа с возражениями',
        'Complaint Handling',
      ],
      [
        'public_speaking',
        'Ommaviy nutq',
        'Оммавий нутқ',
        'Публичные выступления',
        'Public Speaking',
      ],
      [
        'teamwork',
        'Jamoada ishlash',
        'Жамоада ишлаш',
        'Работа в команде',
        'Teamwork',
      ],
      [
        'time_management',
        'Vaqtni boshqarish',
        'Вақтни бошқариш',
        'Управление временем',
        'Time Management',
      ],
      [
        'team_leadership',
        'Jamoani boshqarish',
        'Жамоани бошқариш',
        'Руководство командой',
        'Team Leadership',
      ],
    ]),

    // --- Trades and construction ------------------------------------------
    ...group('trades', [
      [
        'welding_arc',
        'Elektr yoyi bilan payvandlash',
        'Электр ёйи билан пайвандлаш',
        'Электродуговая сварка',
        'Arc Welding',
      ],
      [
        'welding_gas',
        'Gaz payvandlash',
        'Газ пайвандлаш',
        'Газовая сварка',
        'Gas Welding',
      ],
      ['masonry', 'Gʻisht terish', 'Ғишт териш', 'Кладка кирпича', 'Masonry'],
      [
        'plastering',
        'Suvoq ishlari',
        'Сувоқ ишлари',
        'Штукатурные работы',
        'Plastering',
      ],
      [
        'painting',
        'Boʻyash ishlari',
        'Бўяш ишлари',
        'Малярные работы',
        'Painting',
      ],
      [
        'tiling',
        'Kafel yotqizish',
        'Кафел ётқизиш',
        'Укладка плитки',
        'Tiling',
      ],
      [
        'drywall',
        'Gipsokarton ishlari',
        'Гипсокартон ишлари',
        'Работы с гипсокартоном',
        'Drywall Installation',
      ],
      [
        'carpentry',
        'Duradgorlik',
        'Дурадгорлик',
        'Столярные работы',
        'Carpentry',
      ],
      [
        'electrical_wiring',
        'Elektr montaj ishlari',
        'Электр монтаж ишлари',
        'Электромонтажные работы',
        'Electrical Wiring',
      ],
      [
        'plumbing_work',
        'Santexnika ishlari',
        'Сантехника ишлари',
        'Сантехнические работы',
        'Plumbing',
      ],
      [
        'blueprint_reading',
        'Chizmalarni oʻqish',
        'Чизмаларни ўқиш',
        'Чтение чертежей',
        'Blueprint Reading',
      ],
      [
        'power_tool_use',
        'Elektr asboblar bilan ishlash',
        'Электр асбоблар билан ишлаш',
        'Работа с электроинструментом',
        'Power Tool Operation',
      ],
      [
        'machine_tool_operation',
        'Dastgohda ishlash',
        'Дастгоҳда ишлаш',
        'Работа на станке',
        'Machine Tool Operation',
      ],
      [
        'forklift_operation',
        'Pogruzchikda ishlash',
        'Погрузчикда ишлаш',
        'Управление погрузчиком',
        'Forklift Operation',
      ],
      [
        'auto_repair',
        'Avtomobil taʼmiri',
        'Автомобил таъмири',
        'Ремонт автомобилей',
        'Auto Repair',
      ],
      ['sewing', 'Tikuvchilik', 'Тикувчилик', 'Швейное дело', 'Sewing'],
      [
        'equipment_maintenance',
        'Uskunalarga texnik xizmat',
        'Ускуналарга техник хизмат',
        'Техобслуживание оборудования',
        'Equipment Maintenance',
      ],
      [
        'safety_rules',
        'Mehnat xavfsizligi qoidalari',
        'Меҳнат хавфсизлиги қоидалари',
        'Правила охраны труда',
        'Occupational Safety Rules',
      ],
    ]),

    // --- Driving and logistics --------------------------------------------
    ...group('logistics', [
      [
        'city_driving',
        'Shahar sharoitida haydash',
        'Шаҳар шароитида ҳайдаш',
        'Вождение в городе',
        'City Driving',
      ],
      [
        'long_distance_driving',
        'Uzoq masofaga haydash',
        'Узоқ масофага ҳайдаш',
        'Междугородние перевозки',
        'Long-Distance Driving',
      ],
      [
        'route_navigation',
        'Marshrutni bilish',
        'Маршрутни билиш',
        'Знание маршрутов',
        'Route Navigation',
      ],
      [
        'cargo_loading',
        'Yuk ortish va tushirish',
        'Юк ортиш ва тушириш',
        'Погрузка и разгрузка',
        'Cargo Loading',
      ],
      [
        'waybill_handling',
        'Yoʻl hujjatlari bilan ishlash',
        'Йўл ҳужжатлари билан ишлаш',
        'Работа с путевыми документами',
        'Waybill Handling',
      ],
      [
        'warehouse_operations',
        'Ombor operatsiyalari',
        'Омбор операциялари',
        'Складские операции',
        'Warehouse Operations',
      ],
    ]),

    // --- Food service and hospitality -------------------------------------
    ...group('hospitality', [
      [
        'national_cuisine',
        'Milliy taomlar tayyorlash',
        'Миллий таомлар тайёрлаш',
        'Приготовление национальных блюд',
        'National Cuisine',
      ],
      [
        'european_cuisine',
        'Yevropa taomlari',
        'Европа таомлари',
        'Европейская кухня',
        'European Cuisine',
      ],
      [
        'grill_cooking',
        'Grill va kabob tayyorlash',
        'Грилл ва кабоб тайёрлаш',
        'Приготовление на гриле',
        'Grill Cooking',
      ],
      [
        'baking',
        'Non va pishiriq tayyorlash',
        'Нон ва пиширик тайёрлаш',
        'Хлебопечение и выпечка',
        'Baking',
      ],
      [
        'coffee_making',
        'Qahva tayyorlash',
        'Қаҳва тайёрлаш',
        'Приготовление кофе',
        'Coffee Making',
      ],
      [
        'table_service',
        'Stolga xizmat koʻrsatish',
        'Столга хизмат кўрсатиш',
        'Обслуживание столов',
        'Table Service',
      ],
      [
        'food_hygiene',
        'Oziq-ovqat gigiyenasi',
        'Озиқ-овқат гигиенаси',
        'Пищевая гигиена',
        'Food Hygiene',
      ],
      [
        'room_cleaning',
        'Xonalarni tozalash',
        'Хоналарни тозалаш',
        'Уборка помещений',
        'Room Cleaning',
      ],
    ]),

    // --- Agriculture -------------------------------------------------------
    ...group('agriculture', [
      [
        'crop_planting',
        'Ekin ekish',
        'Экин экиш',
        'Посадка культур',
        'Crop Planting',
      ],
      [
        'harvesting',
        'Hosil yigʻish',
        'Ҳосил йиғиш',
        'Сбор урожая',
        'Harvesting',
      ],
      ['irrigation', 'Sugʻorish', 'Суғориш', 'Полив', 'Irrigation'],
      ['pruning', 'Butash', 'Буташ', 'Обрезка растений', 'Pruning'],
      [
        'greenhouse_care',
        'Issiqxonaga qarash',
        'Иссиқхонага қараш',
        'Уход за теплицей',
        'Greenhouse Care',
      ],
      [
        'tractor_operation',
        'Traktorda ishlash',
        'Тракторда ишлаш',
        'Управление трактором',
        'Tractor Operation',
      ],
      [
        'animal_care',
        'Hayvonlarga qarash',
        'Ҳайвонларга қараш',
        'Уход за животными',
        'Animal Care',
      ],
      ['milking', 'Sogʻish', 'Соғиш', 'Доение', 'Milking'],
      [
        'pesticide_handling',
        'Oʻgʻit va dorilar bilan ishlash',
        'Ўғит ва дорилар билан ишлаш',
        'Работа с удобрениями и препаратами',
        'Fertiliser and Pesticide Handling',
      ],
      [
        'produce_sorting',
        'Mahsulotni saralash',
        'Маҳсулотни саралаш',
        'Сортировка продукции',
        'Produce Sorting',
      ],
    ]),

    // --- Care, education and health ---------------------------------------
    ...group('care_education', [
      [
        'first_aid',
        'Birinchi yordam',
        'Биринчи ёрдам',
        'Первая помощь',
        'First Aid',
      ],
      [
        'patient_care',
        'Bemorlarga qarash',
        'Беморларга қараш',
        'Уход за больными',
        'Patient Care',
      ],
      [
        'child_care',
        'Bolalarga qarash',
        'Болаларга қараш',
        'Уход за детьми',
        'Child Care',
      ],
      [
        'elderly_care',
        'Keksalarga qarash',
        'Кексаларга қараш',
        'Уход за престарелыми',
        'Elderly Care',
      ],
      [
        'lesson_planning',
        'Dars rejalashtirish',
        'Дарс режалаштириш',
        'Планирование уроков',
        'Lesson Planning',
      ],
      [
        'injections',
        'Inʼeksiya qilish',
        'Инъекция қилиш',
        'Постановка инъекций',
        'Administering Injections',
      ],
    ]),
  ],
};

export const INDUSTRY_SEED: SeedType = {
  code: 'industry',
  provenance: 'default',
  note:
    'Employer sectors, for the §7.1 "industry/category" filter and the employer ' +
    'profile. Broad by design: an industry list this market can recognise, not a ' +
    'statistical classifier.',
  items: [
    ...group('industry', [
      [
        'it_software',
        'IT va dasturiy taʼminot',
        'IT ва дастурий таъминот',
        'ИТ и программное обеспечение',
        'IT and Software',
      ],
      [
        'telecom',
        'Telekommunikatsiya',
        'Телекоммуникация',
        'Телекоммуникации',
        'Telecommunications',
      ],
      [
        'banking_finance',
        'Bank va moliya',
        'Банк ва молия',
        'Банки и финансы',
        'Banking and Finance',
      ],
      ['insurance', 'Sugʻurta', 'Суғурта', 'Страхование', 'Insurance'],
      [
        'retail',
        'Chakana savdo',
        'Чакана савдо',
        'Розничная торговля',
        'Retail',
      ],
      [
        'wholesale',
        'Ulgurji savdo',
        'Улгуржи савдо',
        'Оптовая торговля',
        'Wholesale',
      ],
      [
        'ecommerce',
        'Elektron tijorat',
        'Электрон тижорат',
        'Электронная коммерция',
        'E-commerce',
      ],
      ['construction', 'Qurilish', 'Қурилиш', 'Строительство', 'Construction'],
      [
        'real_estate',
        'Koʻchmas mulk',
        'Кўчмас мулк',
        'Недвижимость',
        'Real Estate',
      ],
      [
        'manufacturing',
        'Ishlab chiqarish',
        'Ишлаб чиқариш',
        'Производство',
        'Manufacturing',
      ],
      [
        'textile_industry',
        'Toʻqimachilik sanoati',
        'Тўқимачилик саноати',
        'Текстильная промышленность',
        'Textile Industry',
      ],
      [
        'food_industry',
        'Oziq-ovqat sanoati',
        'Озиқ-овқат саноати',
        'Пищевая промышленность',
        'Food Industry',
      ],
      [
        'agriculture_sector',
        'Qishloq xoʻjaligi',
        'Қишлоқ хўжалиги',
        'Сельское хозяйство',
        'Agriculture',
      ],
      [
        'mining',
        'Togʻ-kon sanoati',
        'Тоғ-кон саноати',
        'Горнодобывающая промышленность',
        'Mining',
      ],
      ['oil_gas', 'Neft va gaz', 'Нефт ва газ', 'Нефть и газ', 'Oil and Gas'],
      ['energy', 'Energetika', 'Энергетика', 'Энергетика', 'Energy'],
      [
        'chemical_industry',
        'Kimyo sanoati',
        'Кимё саноати',
        'Химическая промышленность',
        'Chemical Industry',
      ],
      [
        'transport_logistics',
        'Transport va logistika',
        'Транспорт ва логистика',
        'Транспорт и логистика',
        'Transport and Logistics',
      ],
      [
        'tourism_hospitality',
        'Turizm va mehmonxona',
        'Туризм ва меҳмонхона',
        'Туризм и гостиничный бизнес',
        'Tourism and Hospitality',
      ],
      [
        'restaurants',
        'Restoran va umumiy ovqatlanish',
        'Ресторан ва умумий овқатланиш',
        'Рестораны и общественное питание',
        'Restaurants and Catering',
      ],
      [
        'healthcare',
        'Sogʻliqni saqlash',
        'Соғлиқни сақлаш',
        'Здравоохранение',
        'Healthcare',
      ],
      [
        'pharmaceuticals',
        'Farmatsevtika',
        'Фармацевтика',
        'Фармацевтика',
        'Pharmaceuticals',
      ],
      ['education_sector', 'Taʼlim', 'Таълим', 'Образование', 'Education'],
      [
        'media_advertising',
        'Media va reklama',
        'Медиа ва реклама',
        'Медиа и реклама',
        'Media and Advertising',
      ],
      [
        'legal_services',
        'Yuridik xizmatlar',
        'Юридик хизматлар',
        'Юридические услуги',
        'Legal Services',
      ],
      ['consulting', 'Konsalting', 'Консалтинг', 'Консалтинг', 'Consulting'],
      [
        'security_services',
        'Xavfsizlik xizmatlari',
        'Хавфсизлик хизматлари',
        'Охранные услуги',
        'Security Services',
      ],
      [
        'cleaning_services',
        'Tozalash xizmatlari',
        'Тозалаш хизматлари',
        'Клининговые услуги',
        'Cleaning Services',
      ],
      [
        'beauty_services',
        'Goʻzallik sohasi',
        'Гўзаллик соҳаси',
        'Индустрия красоты',
        'Beauty Services',
      ],
      [
        'government',
        'Davlat boshqaruvi',
        'Давлат бошқаруви',
        'Государственное управление',
        'Government',
      ],
      [
        'nonprofit',
        'Notijorat tashkilotlar',
        'Нотижорат ташкилотлар',
        'Некоммерческие организации',
        'Non-profit',
      ],
      ['other_industry', 'Boshqa', 'Бошқа', 'Другое', 'Other'],
    ]),
  ],
};
