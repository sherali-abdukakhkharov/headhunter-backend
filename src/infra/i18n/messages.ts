import type { LocaleCode } from '@infra/db/database.types';

/**
 * Localized user-facing messages (§3.2).
 *
 * §3.2 requires validation messages, statuses and system labels to exist in all
 * four interface variants. A message the client cannot show in the user's
 * language is a defect, not a rough edge - so this catalog is the only place a
 * user-facing string is written, and every entry carries all four labels. The
 * type makes a missing locale a compile error.
 *
 * Three languages, four variants: Uzbek ships in Latin and Cyrillic script.
 *
 * The keys are also the machine-readable `code` in the error body, so a client
 * can branch on the cause without parsing prose. Renaming a key is therefore a
 * client-visible change.
 *
 * `{placeholders}` are substituted by `translate()`. Keep them identical across
 * the four variants: a placeholder that exists in one language and not another
 * renders as literal braces to that user.
 */

export type MessageCatalog = Record<string, Record<LocaleCode, string>>;

/** Values substituted into a message's `{placeholders}`. */
export type MessageParams = Record<string, string | number>;

/**
 * Errors and validation messages.
 *
 * Grouped by area, with the same order in every group, so a reviewer comparing
 * languages can read down a column.
 */
export const MESSAGES = {
  // --- generic, by HTTP status --------------------------------------------
  // Reached only for framework-generated failures (an unmatched route,
  // malformed JSON). Everything we throw ourselves has a specific key.
  'error.bad_request': {
    'uz-Latn': 'Soʻrov notoʻgʻri.',
    'uz-Cyrl': 'Сўров нотўғри.',
    ru: 'Некорректный запрос.',
    en: 'The request is invalid.',
  },
  'error.unauthorized': {
    'uz-Latn': 'Bu amal uchun tizimga kirish talab qilinadi.',
    'uz-Cyrl': 'Бу амал учун тизимга кириш талаб қилинади.',
    ru: 'Для этого действия требуется вход в систему.',
    en: 'You need to sign in to do this.',
  },
  'error.forbidden': {
    'uz-Latn': 'Bu amalni bajarishga ruxsatingiz yoʻq.',
    'uz-Cyrl': 'Бу амални бажаришга рухсатингиз йўқ.',
    ru: 'У вас нет прав на это действие.',
    en: 'You do not have permission to do this.',
  },
  'error.not_found': {
    'uz-Latn': 'Soʻralgan maʼlumot topilmadi.',
    'uz-Cyrl': 'Сўралган маълумот топилмади.',
    ru: 'Запрашиваемые данные не найдены.',
    en: 'The requested data was not found.',
  },
  'error.conflict': {
    'uz-Latn': 'Bu amal joriy holat bilan toʻqnashadi.',
    'uz-Cyrl': 'Бу амал жорий ҳолат билан тўқнашади.',
    ru: 'Действие конфликтует с текущим состоянием.',
    en: 'The action conflicts with the current state.',
  },
  'error.payload_too_large': {
    'uz-Latn': 'Yuborilgan maʼlumot hajmi juda katta.',
    'uz-Cyrl': 'Юборилган маълумот ҳажми жуда катта.',
    ru: 'Размер отправленных данных слишком велик.',
    en: 'The submitted data is too large.',
  },
  'error.too_many_requests': {
    'uz-Latn': 'Soʻrovlar juda koʻp. Keyinroq urinib koʻring.',
    'uz-Cyrl': 'Сўровлар жуда кўп. Кейинроқ уриниб кўринг.',
    ru: 'Слишком много запросов. Попробуйте позже.',
    en: 'Too many requests. Try again later.',
  },
  'error.internal': {
    'uz-Latn': 'Kutilmagan xatolik yuz berdi. Keyinroq urinib koʻring.',
    'uz-Cyrl': 'Кутилмаган хатолик юз берди. Кейинроқ уриниб кўринг.',
    ru: 'Произошла непредвиденная ошибка. Попробуйте позже.',
    en: 'Something went wrong. Please try again later.',
  },
  'error.service_unavailable': {
    'uz-Latn': 'Xizmat vaqtincha ishlamayapti. Keyinroq urinib koʻring.',
    'uz-Cyrl': 'Хизмат вақтинча ишламаяпти. Кейинроқ уриниб кўринг.',
    ru: 'Сервис временно недоступен. Попробуйте позже.',
    en: 'The service is temporarily unavailable. Try again later.',
  },

  // --- authentication (§4) ------------------------------------------------
  'auth.phone_invalid': {
    'uz-Latn':
      'Telefon raqami 9 dan 15 tagacha raqamdan iborat boʻlishi kerak.',
    'uz-Cyrl': 'Телефон рақами 9 дан 15 тагача рақамдан иборат бўлиши керак.',
    ru: 'Номер телефона должен содержать от 9 до 15 цифр.',
    en: 'The phone number must contain 9 to 15 digits.',
  },
  // One message for "no code", "expired" and "wrong code" in all four
  // languages: distinguishing them tells an attacker which numbers have a
  // pending code, and that must not leak through a translation either.
  'auth.otp_invalid': {
    'uz-Latn': 'Kod notoʻgʻri yoki muddati tugagan.',
    'uz-Cyrl': 'Код нотўғри ёки муддати тугаган.',
    ru: 'Код неверен или срок его действия истёк.',
    en: 'The code is invalid or has expired.',
  },
  'auth.otp_too_many_attempts': {
    'uz-Latn': 'Notoʻgʻri urinishlar koʻp boʻldi. Yangi kod soʻrang.',
    'uz-Cyrl': 'Нотўғри уринишлар кўп бўлди. Янги код сўранг.',
    ru: 'Слишком много неверных попыток. Запросите новый код.',
    en: 'Too many incorrect attempts. Request a new code.',
  },
  'auth.otp_resend_too_soon': {
    'uz-Latn': 'Kod allaqachon yuborilgan. Yangisini soʻrashdan oldin kuting.',
    'uz-Cyrl': 'Код аллақачон юборилган. Янгисини сўрашдан олдин кутинг.',
    ru: 'Код уже отправлен. Подождите, прежде чем запросить новый.',
    en: 'A code was already sent. Wait before requesting another.',
  },
  'auth.token_required': {
    'uz-Latn': 'Avtorizatsiya tokeni talab qilinadi.',
    'uz-Cyrl': 'Авторизация токени талаб қилинади.',
    ru: 'Требуется токен авторизации.',
    en: 'An authorization token is required.',
  },
  'auth.token_invalid': {
    'uz-Latn': 'Token notoʻgʻri yoki muddati tugagan.',
    'uz-Cyrl': 'Токен нотўғри ёки муддати тугаган.',
    ru: 'Токен недействителен или истёк.',
    en: 'The token is invalid or has expired.',
  },
  'auth.session_revoked': {
    'uz-Latn': 'Sessiya bekor qilingan. Qaytadan kiring.',
    'uz-Cyrl': 'Сессия бекор қилинган. Қайтадан киринг.',
    ru: 'Сессия отозвана. Войдите снова.',
    en: 'The session has been revoked. Sign in again.',
  },
  'auth.session_not_found': {
    'uz-Latn': 'Sessiya topilmadi.',
    'uz-Cyrl': 'Сессия топилмади.',
    ru: 'Сессия не найдена.',
    en: 'Session not found.',
  },
  'auth.refresh_invalid': {
    'uz-Latn': 'Yangilash tokeni notoʻgʻri.',
    'uz-Cyrl': 'Янгилаш токени нотўғри.',
    ru: 'Недействительный токен обновления.',
    en: 'Invalid refresh token.',
  },
  'auth.refresh_expired': {
    'uz-Latn': 'Yangilash tokeni muddati tugagan. Qaytadan kiring.',
    'uz-Cyrl': 'Янгилаш токени муддати тугаган. Қайтадан киринг.',
    ru: 'Срок действия токена обновления истёк. Войдите снова.',
    en: 'The refresh token has expired. Sign in again.',
  },
  'auth.refresh_reused': {
    'uz-Latn':
      'Bu yangilash tokeni allaqachon ishlatilgan. Xavfsizlik uchun barcha ' +
      'sessiyalar yopildi. Qaytadan kiring.',
    'uz-Cyrl':
      'Бу янгилаш токени аллақачон ишлатилган. Хавфсизлик учун барча ' +
      'сессиялар ёпилди. Қайтадан киринг.',
    ru:
      'Этот токен обновления уже использован. В целях безопасности все сеансы ' +
      'закрыты. Войдите снова.',
    en:
      'This refresh token has already been used. All sessions were closed for ' +
      'security. Sign in again.',
  },

  // --- roles (§2.3) -------------------------------------------------------
  'role.at_least_one_required': {
    'uz-Latn': 'Kamida bitta rol tanlanishi kerak.',
    'uz-Cyrl': 'Камида битта рол танланиши керак.',
    ru: 'Необходимо выбрать хотя бы одну роль.',
    en: 'At least one role is required.',
  },
  'role.admin_not_self_assignable': {
    'uz-Latn': 'Administrator rolini oʻzingizga tayinlay olmaysiz.',
    'uz-Cyrl': 'Администратор ролини ўзингизга тайинлай олмайсиз.',
    ru: 'Роль администратора нельзя назначить себе.',
    en: 'The admin role cannot be self-assigned.',
  },
  'role.not_granted': {
    'uz-Latn': 'Bu rol hisobingizga berilmagan.',
    'uz-Cyrl': 'Бу рол ҳисобингизга берилмаган.',
    ru: 'Эта роль не назначена вашей учётной записи.',
    en: 'That role is not granted to this account.',
  },
  'role.none_active': {
    'uz-Latn': 'Faol rol tanlanmagan. Avval rolni tanlang.',
    'uz-Cyrl': 'Фаол рол танланмаган. Аввал ролни танланг.',
    ru: 'Активная роль не выбрана. Сначала выберите роль.',
    en: 'No active role is selected. Choose a role first.',
  },
  'role.not_allowed': {
    'uz-Latn': 'Bu amal uchun boshqa rol talab qilinadi: {roles}.',
    'uz-Cyrl': 'Бу амал учун бошқа рол талаб қилинади: {roles}.',
    ru: 'Для этого действия требуется другая роль: {roles}.',
    en: 'This action requires one of these roles: {roles}.',
  },

  // --- account status (BR-10, §10.2) --------------------------------------
  'account.blocked': {
    'uz-Latn': 'Hisobingiz bloklangan.',
    'uz-Cyrl': 'Ҳисобингиз блокланган.',
    ru: 'Ваша учётная запись заблокирована.',
    en: 'This account is blocked.',
  },
  'account.blocked_action': {
    'uz-Latn': 'Hisobingiz bloklangan, bu amalni bajara olmaysiz.',
    'uz-Cyrl': 'Ҳисобингиз блокланган, бу амални бажара олмайсиз.',
    ru: 'Учётная запись заблокирована, действие невозможно.',
    en: 'This account is blocked and cannot perform this action.',
  },
  'account.restricted_action': {
    'uz-Latn': 'Hisobingiz cheklangan, bu amalni bajara olmaysiz.',
    'uz-Cyrl': 'Ҳисобингиз чекланган, бу амални бажара олмайсиз.',
    ru: 'Учётная запись ограничена, действие невозможно.',
    en: 'This account is restricted and cannot perform this action.',
  },
  'account.not_found': {
    'uz-Latn': 'Foydalanuvchi topilmadi.',
    'uz-Cyrl': 'Фойдаланувчи топилмади.',
    ru: 'Пользователь не найден.',
    en: 'User not found.',
  },
  'account.gone': {
    'uz-Latn': 'Hisob mavjud emas.',
    'uz-Cyrl': 'Ҳисоб мавжуд эмас.',
    ru: 'Учётная запись больше не существует.',
    en: 'This account no longer exists.',
  },

  // --- dictionaries (§3.2) -----------------------------------------------
  'dictionary.unknown_type': {
    'uz-Latn': 'Nomaʼlum lugʻat turi: {type}.',
    'uz-Cyrl': 'Номаълум луғат тури: {type}.',
    ru: 'Неизвестный тип справочника: {type}.',
    en: 'Unknown dictionary type: {type}.',
  },

  // --- files (§5.4, §12.5) -----------------------------------------------
  'file.too_large': {
    'uz-Latn':
      'Fayl hajmi juda katta. Ruxsat etilgan eng katta hajm: {maxMb} MB.',
    'uz-Cyrl':
      'Файл ҳажми жуда катта. Рухсат этилган энг катта ҳажм: {maxMb} MB.',
    ru: 'Файл слишком большой. Максимальный размер: {maxMb} МБ.',
    en: 'The file is too large. The maximum size is {maxMb} MB.',
  },
  'file.empty': {
    'uz-Latn': 'Fayl boʻsh.',
    'uz-Cyrl': 'Файл бўш.',
    ru: 'Файл пустой.',
    en: 'The file is empty.',
  },
  'file.missing': {
    'uz-Latn': 'Fayl yuborilmadi.',
    'uz-Cyrl': 'Файл юборилмади.',
    ru: 'Файл не был отправлен.',
    en: 'No file was submitted.',
  },
  'file.type_not_allowed': {
    'uz-Latn':
      'Bu fayl turi qabul qilinmaydi. Ruxsat etilgan turlar: {allowed}.',
    'uz-Cyrl':
      'Бу файл тури қабул қилинмайди. Рухсат этилган турлар: {allowed}.',
    ru: 'Этот тип файла не поддерживается. Разрешённые типы: {allowed}.',
    en: 'That file type is not accepted. Allowed types: {allowed}.',
  },
  'file.purpose_invalid': {
    'uz-Latn': 'Fayl maqsadi notoʻgʻri.',
    'uz-Cyrl': 'Файл мақсади нотўғри.',
    ru: 'Некорректное назначение файла.',
    en: 'The file purpose is invalid.',
  },
  'file.not_found': {
    'uz-Latn': 'Fayl topilmadi.',
    'uz-Cyrl': 'Файл топилмади.',
    ru: 'Файл не найден.',
    en: 'File not found.',
  },
  'file.upload_failed': {
    'uz-Latn': 'Faylni saqlab boʻlmadi. Qaytadan urinib koʻring.',
    'uz-Cyrl': 'Файлни сақлаб бўлмади. Қайтадан уриниб кўринг.',
    ru: 'Не удалось сохранить файл. Попробуйте снова.',
    en: 'The file could not be stored. Please try again.',
  },
  'file.download_failed': {
    'uz-Latn': 'Faylni yuklab boʻlmadi. Qaytadan urinib koʻring.',
    'uz-Cyrl': 'Файлни юклаб бўлмади. Қайтадан уриниб кўринг.',
    ru: 'Не удалось скачать файл. Попробуйте снова.',
    en: 'The file could not be downloaded. Please try again.',
  },

  // --- validation (§3.2 "validation messages shall be localized") --------
  'validation.failed': {
    'uz-Latn': 'Kiritilgan maʼlumotlarni tekshirib chiqing.',
    'uz-Cyrl': 'Киритилган маълумотларни текшириб чиқинг.',
    ru: 'Проверьте введённые данные.',
    en: 'Please check the submitted data.',
  },
  'validation.required': {
    'uz-Latn': 'Bu maydonni toʻldirish shart.',
    'uz-Cyrl': 'Бу майдонни тўлдириш шарт.',
    ru: 'Это поле обязательно.',
    en: 'This field is required.',
  },
  'validation.unknown_field': {
    'uz-Latn': 'Bu maydon qabul qilinmaydi.',
    'uz-Cyrl': 'Бу майдон қабул қилинмайди.',
    ru: 'Это поле не принимается.',
    en: 'This field is not accepted.',
  },
  'validation.must_be_text': {
    'uz-Latn': 'Matn kiritilishi kerak.',
    'uz-Cyrl': 'Матн киритилиши керак.',
    ru: 'Необходимо ввести текст.',
    en: 'A text value is required.',
  },
  'validation.must_be_number': {
    'uz-Latn': 'Raqam kiritilishi kerak.',
    'uz-Cyrl': 'Рақам киритилиши керак.',
    ru: 'Необходимо ввести число.',
    en: 'A number is required.',
  },
  'validation.must_be_integer': {
    'uz-Latn': 'Butun son kiritilishi kerak.',
    'uz-Cyrl': 'Бутун сон киритилиши керак.',
    ru: 'Необходимо ввести целое число.',
    en: 'A whole number is required.',
  },
  'validation.must_be_boolean': {
    'uz-Latn': 'Faqat "ha" yoki "yoʻq" qiymati qabul qilinadi.',
    'uz-Cyrl': 'Фақат "ҳа" ёки "йўқ" қиймати қабул қилинади.',
    ru: 'Допускается только значение «да» или «нет».',
    en: 'Only a yes or no value is accepted.',
  },
  'validation.must_be_date': {
    'uz-Latn': 'Sana notoʻgʻri kiritilgan.',
    'uz-Cyrl': 'Сана нотўғри киритилган.',
    ru: 'Дата указана неверно.',
    en: 'The date is not valid.',
  },
  'validation.must_be_list': {
    'uz-Latn': 'Roʻyxat kutilgan edi.',
    'uz-Cyrl': 'Рўйхат кутилган эди.',
    ru: 'Ожидался список значений.',
    en: 'A list of values was expected.',
  },
  'validation.must_be_id': {
    'uz-Latn': 'Identifikator notoʻgʻri.',
    'uz-Cyrl': 'Идентификатор нотўғри.',
    ru: 'Некорректный идентификатор.',
    en: 'The identifier is not valid.',
  },
  'validation.not_allowed_value': {
    'uz-Latn': 'Bu qiymat ruxsat etilmagan.',
    'uz-Cyrl': 'Бу қиймат рухсат этилмаган.',
    ru: 'Это значение недопустимо.',
    en: 'That value is not allowed.',
  },
  'validation.too_short': {
    'uz-Latn': 'Juda qisqa. Kamida {min} belgi kerak.',
    'uz-Cyrl': 'Жуда қисқа. Камида {min} белги керак.',
    ru: 'Слишком коротко. Минимум {min} символов.',
    en: 'Too short. At least {min} characters are required.',
  },
  'validation.too_long': {
    'uz-Latn': 'Juda uzun. Koʻpi bilan {max} belgi.',
    'uz-Cyrl': 'Жуда узун. Кўпи билан {max} белги.',
    ru: 'Слишком длинно. Не более {max} символов.',
    en: 'Too long. At most {max} characters.',
  },
  'validation.too_small': {
    'uz-Latn': 'Qiymat {min} dan kichik boʻlmasligi kerak.',
    'uz-Cyrl': 'Қиймат {min} дан кичик бўлмаслиги керак.',
    ru: 'Значение не должно быть меньше {min}.',
    en: 'The value must not be less than {min}.',
  },
  'validation.too_big': {
    'uz-Latn': 'Qiymat {max} dan katta boʻlmasligi kerak.',
    'uz-Cyrl': 'Қиймат {max} дан катта бўлмаслиги керак.',
    ru: 'Значение не должно быть больше {max}.',
    en: 'The value must not be greater than {max}.',
  },
  'validation.list_empty': {
    'uz-Latn': 'Kamida bitta qiymat tanlanishi kerak.',
    'uz-Cyrl': 'Камида битта қиймат танланиши керак.',
    ru: 'Необходимо выбрать хотя бы одно значение.',
    en: 'At least one value must be selected.',
  },
} as const satisfies MessageCatalog;

export type MessageKey = keyof typeof MESSAGES;
