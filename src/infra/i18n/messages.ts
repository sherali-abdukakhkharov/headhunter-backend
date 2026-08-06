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
  // Telegram login. One message for every verification failure - bad signature,
  // wrong audience, expired, stale - for the same reason as the OTP message above:
  // the distinctions describe our validation to whoever is probing it, and none of
  // them changes what a legitimate client does next (start the login again).
  'auth.telegram_token_invalid': {
    'uz-Latn': 'Telegram orqali kirish tasdiqlanmadi. Qaytadan urinib koʻring.',
    'uz-Cyrl': 'Телеграм орқали кириш тасдиқланмади. Қайтадан уриниб кўринг.',
    ru: 'Не удалось подтвердить вход через Telegram. Попробуйте снова.',
    en: 'Telegram sign-in could not be verified. Please try again.',
  },
  'auth.telegram_phone_required': {
    'uz-Latn':
      'Davom etish uchun Telegramda telefon raqamingizni ulashishga ruxsat ' +
      'bering. Raqam ish beruvchilarga faqat siz ruxsat berganda koʻrsatiladi.',
    'uz-Cyrl':
      'Давом этиш учун Телеграмда телефон рақамингизни улашишга рухсат ' +
      'беринг. Рақам иш берувчиларга фақат сиз рухсат берганда кўрсатилади.',
    ru:
      'Чтобы продолжить, разрешите Telegram передать ваш номер телефона. Номер ' +
      'будет показан работодателям только с вашего разрешения.',
    en:
      'To continue, allow Telegram to share your phone number. It is shown to ' +
      'employers only with your permission.',
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

  // --- candidate profile (§5) ---------------------------------------------
  // A record that is not there, or belongs to someone else. One message for both:
  // confirming that an id exists but is another candidate's is information we do
  // not owe (§11.1), and the caller's fix is the same either way.
  'candidate.record_not_found': {
    'uz-Latn': 'Yozuv topilmadi.',
    'uz-Cyrl': 'Ёзув топилмади.',
    ru: 'Запись не найдена.',
    en: 'The record was not found.',
  },
  'candidate.profile_not_found': {
    'uz-Latn': 'Nomzod profili topilmadi.',
    'uz-Cyrl': 'Номзод профили топилмади.',
    ru: 'Профиль кандидата не найден.',
    en: 'The candidate profile was not found.',
  },
  'candidate.attachment_purpose_invalid': {
    'uz-Latn': 'Bu turdagi fayl profilga qoʻshilmaydi.',
    'uz-Cyrl': 'Бу турдаги файл профилга қўшилмайди.',
    ru: 'Файл этого типа не добавляется в профиль.',
    en: 'A file of this kind is not part of the profile.',
  },

  // --- employers (§6.1, BR-03) ---------------------------------------------
  'employer.profile_not_found': {
    'uz-Latn': 'Ish beruvchi profili topilmadi.',
    'uz-Cyrl': 'Иш берувчи профили топилмади.',
    ru: 'Профиль работодателя не найден.',
    en: 'The employer profile was not found.',
  },
  // BR-03: the fix is "finish the profile", which is why it is not the same message
  // as "not verified yet" - the two need different actions from the employer.
  'employer.profile_incomplete': {
    'uz-Latn': 'Avval ish beruvchi profilini toʻliq toʻldiring.',
    'uz-Cyrl': 'Аввал иш берувчи профилини тўлиқ тўлдиринг.',
    ru: 'Сначала заполните профиль работодателя полностью.',
    en: 'Complete the employer profile first.',
  },
  'employer.not_verified': {
    'uz-Latn': 'Bu amal uchun profil tasdiqlanishi kerak.',
    'uz-Cyrl': 'Бу амал учун профил тасдиқланиши керак.',
    ru: 'Для этого действия профиль должен быть подтверждён.',
    en: 'This action requires a verified profile.',
  },
  'employer.type_immutable': {
    'uz-Latn': 'Ish beruvchi turini keyinchalik oʻzgartirib boʻlmaydi.',
    'uz-Cyrl': 'Иш берувчи турини кейинчалик ўзгартириб бўлмайди.',
    ru: 'Тип работодателя нельзя изменить позже.',
    en: 'The employer type cannot be changed later.',
  },
  'employer.verification_not_submittable': {
    'uz-Latn': 'Joriy holatda tasdiqlashga yuborib boʻlmaydi.',
    'uz-Cyrl': 'Жорий ҳолатда тасдиқлашга юбориб бўлмайди.',
    ru: 'В текущем состоянии отправка на проверку невозможна.',
    en: 'A submission is not possible in the current state.',
  },
  'employer.verification_evidence_missing': {
    'uz-Latn': 'Talab qilingan hujjatlar toʻliq yuklanmagan.',
    'uz-Cyrl': 'Талаб қилинган ҳужжатлар тўлиқ юкланмаган.',
    ru: 'Загружены не все требуемые документы.',
    en: 'Not all required documents were uploaded.',
  },
  'employer.verification_not_pending': {
    'uz-Latn': 'Bu soʻrov koʻrib chiqilmoqda emas.',
    'uz-Cyrl': 'Бу сўров кўриб чиқилмоқда эмас.',
    ru: 'Эта заявка не находится на рассмотрении.',
    en: 'This submission is not under review.',
  },
  'employer.verification_reason_required': {
    'uz-Latn': 'Rad etish yoki tuzatish uchun sabab koʻrsatilishi shart.',
    'uz-Cyrl': 'Рад этиш ёки тузатиш учун сабаб кўрсатилиши шарт.',
    ru: 'Для отказа или замечаний необходимо указать причину.',
    en: 'A reason is required to reject or request changes.',
  },

  // --- vacancies (§6.3, §6.4, BR-04, BR-11, BR-12) -------------------------
  'vacancy.not_found': {
    'uz-Latn': 'Vakansiya topilmadi.',
    'uz-Cyrl': 'Вакансия топилмади.',
    ru: 'Вакансия не найдена.',
    en: 'The vacancy was not found.',
  },
  'vacancy.not_editable': {
    'uz-Latn': 'Bu vakansiyani tahrirlash mumkin emas.',
    'uz-Cyrl': 'Бу вакансияни таҳрирлаш мумкин эмас.',
    ru: 'Эту вакансию нельзя редактировать.',
    en: 'This vacancy can no longer be edited.',
  },
  // Distinct from the above: the employer's action is to wait, not to give up.
  'vacancy.under_moderation': {
    'uz-Latn': 'Vakansiya koʻrib chiqilmoqda, shu vaqtda tahrirlanmaydi.',
    'uz-Cyrl': 'Вакансия кўриб чиқилмоқда, шу вақтда таҳрирланмайди.',
    ru: 'Вакансия на проверке и пока не редактируется.',
    en: 'The vacancy is under review and cannot be edited yet.',
  },
  'vacancy.not_submittable': {
    'uz-Latn': 'Joriy holatda nashrga yuborib boʻlmaydi.',
    'uz-Cyrl': 'Жорий ҳолатда нашрга юбориб бўлмайди.',
    ru: 'В текущем состоянии публикация невозможна.',
    en: 'It cannot be submitted for publication in its current state.',
  },
  'vacancy.transition_not_allowed': {
    'uz-Latn': 'Bu holatga oʻtish mumkin emas.',
    'uz-Cyrl': 'Бу ҳолатга ўтиш мумкин эмас.',
    ru: 'Такой переход состояния невозможен.',
    en: 'That status change is not allowed.',
  },
  'vacancy.deadline_passed': {
    'uz-Latn': 'Arizalar muddati oʻtgan. Muddatni yangilang.',
    'uz-Cyrl': 'Аризалар муддати ўтган. Муддатни янгиланг.',
    ru: 'Срок приёма заявок истёк. Обновите срок.',
    en: 'The application deadline has passed. Update it first.',
  },
  // BR-12: the reason must be one moderation can actually validate.
  'vacancy.restriction_not_justified': {
    'uz-Latn': 'Yosh yoki jins cheklovi uchun asos toʻgʻri koʻrsatilmagan.',
    'uz-Cyrl': 'Ёш ёки жинс чеклови учун асос тўғри кўрсатилмаган.',
    ru: 'Для ограничения по возрасту или полу не указано допустимое основание.',
    en: 'The age or gender restriction has no permitted justification.',
  },
  'vacancy.not_under_moderation': {
    'uz-Latn': 'Bu vakansiya koʻrib chiqilmoqda emas.',
    'uz-Cyrl': 'Бу вакансия кўриб чиқилмоқда эмас.',
    ru: 'Эта вакансия не находится на проверке.',
    en: 'This vacancy is not under review.',
  },
  'vacancy.moderation_reason_required': {
    'uz-Latn': 'Rad etish uchun sabab koʻrsatilishi shart.',
    'uz-Cyrl': 'Рад этиш учун сабаб кўрсатилиши шарт.',
    ru: 'Для отказа необходимо указать причину.',
    en: 'A reason is required to reject a vacancy.',
  },

  // --- applications (§5.6, §8.1, BR-06, BR-07) -----------------------------
  'application.not_found': {
    'uz-Latn': 'Ariza topilmadi.',
    'uz-Cyrl': 'Ариза топилмади.',
    ru: 'Заявка не найдена.',
    en: 'The application was not found.',
  },
  // BR-07. The candidate's fix is to look at the application they already have.
  'application.already_applied': {
    'uz-Latn': 'Siz bu vakansiyaga allaqachon ariza topshirgansiz.',
    'uz-Cyrl': 'Сиз бу вакансияга аллақачон ариза топширгансиз.',
    ru: 'Вы уже откликнулись на эту вакансию.',
    en: 'You have already applied to this vacancy.',
  },
  // BR-06, and BR-04/BR-11 in the same message: from the candidate's side "closed",
  // "paused" and "deadline passed" are one fact - applications are not being taken.
  'application.vacancy_closed': {
    'uz-Latn': 'Bu vakansiyaga arizalar qabul qilinmayapti.',
    'uz-Cyrl': 'Бу вакансияга аризалар қабул қилинмаяпти.',
    ru: 'Эта вакансия больше не принимает заявки.',
    en: 'This vacancy is no longer accepting applications.',
  },
  'application.final': {
    'uz-Latn': 'Ariza yakunlangan, uni oʻzgartirib boʻlmaydi.',
    'uz-Cyrl': 'Ариза якунланган, уни ўзгартириб бўлмайди.',
    ru: 'Заявка завершена и не может быть изменена.',
    en: 'The application is final and cannot be changed.',
  },
  'application.transition_not_allowed': {
    'uz-Latn': 'Bu bosqichga oʻtish mumkin emas.',
    'uz-Cyrl': 'Бу босқичга ўтиш мумкин эмас.',
    ru: 'Такой переход этапа невозможен.',
    en: 'That stage change is not allowed.',
  },
  // §8.1's second column: each stage names who may set it.
  'application.wrong_actor': {
    'uz-Latn': 'Bu bosqichni siz oʻzgartira olmaysiz.',
    'uz-Cyrl': 'Бу босқични сиз ўзгартира олмайсиз.',
    ru: 'Этот этап меняет не ваша сторона.',
    en: 'This stage is not yours to set.',
  },
  'candidate.profile_required': {
    'uz-Latn': 'Ariza topshirish uchun avval profilni toʻldiring.',
    'uz-Cyrl': 'Ариза топшириш учун аввал профилни тўлдиринг.',
    ru: 'Чтобы откликнуться, сначала заполните профиль.',
    en: 'Fill in your profile before applying.',
  },
  'complaint.already_reported': {
    'uz-Latn': 'Siz bu haqda allaqachon xabar bergansiz.',
    'uz-Cyrl': 'Сиз бу ҳақда аллақачон хабар бергансиз.',
    ru: 'Вы уже пожаловались на это.',
    en: 'You have already reported this.',
  },

  // --- candidate search (§7) ----------------------------------------------
  // BR-12 on the search side: an age or gender filter needs the same justification a
  // vacancy's restriction needs, from the same list, covering the same kinds.
  'search.restriction_not_justified': {
    'uz-Latn':
      'Yosh yoki jins boʻyicha filtr uchun ruxsat etilgan asos koʻrsatilishi shart.',
    'uz-Cyrl':
      'Ёш ёки жинс бўйича филтр учун рухсат этилган асос кўрсатилиши шарт.',
    ru: 'Для фильтра по возрасту или полу нужно указать допустимое обоснование.',
    en: 'An age or gender filter needs a permitted justification.',
  },
  'search.occupation_required': {
    'uz-Latn': 'Kasb boʻyicha tajribani filtrlash uchun kasbni tanlang.',
    'uz-Cyrl': 'Касб бўйича тажрибани филтрлаш учун касбни танланг.',
    ru: 'Чтобы фильтровать по опыту в профессии, выберите профессию.',
    en: 'Choose an occupation to filter by experience in it.',
  },

  // --- invitations (§8.2) --------------------------------------------------
  'invitation.not_found': {
    'uz-Latn': 'Taklif topilmadi.',
    'uz-Cyrl': 'Таклиф топилмади.',
    ru: 'Приглашение не найдено.',
    en: 'The invitation was not found.',
  },
  'invitation.already_invited': {
    'uz-Latn': 'Bu nomzod allaqachon taklif qilingan va javob kutilmoqda.',
    'uz-Cyrl': 'Бу номзод аллақачон таклиф қилинган ва жавоб кутилмоқда.',
    ru: 'Этот кандидат уже приглашён, ответ ещё не получен.',
    en: 'This candidate already has an invitation awaiting a reply.',
  },
  'invitation.final': {
    'uz-Latn': 'Taklifga allaqachon javob berilgan.',
    'uz-Cyrl': 'Таклифга аллақачон жавоб берилган.',
    ru: 'На приглашение уже дан ответ.',
    en: 'This invitation has already been answered.',
  },
  'invitation.response_not_allowed': {
    'uz-Latn': 'Bu javob taklifning joriy holatida mumkin emas.',
    'uz-Cyrl': 'Бу жавоб таклифнинг жорий ҳолатида мумкин эмас.',
    ru: 'Такой ответ невозможен в текущем состоянии приглашения.',
    en: 'That reply is not possible in the invitation’s current state.',
  },
  // Either a vacancy or a general invitation's own details, never both and never neither.
  'invitation.shape_invalid': {
    'uz-Latn':
      'Taklif yoki vakansiyaga, yoki kasb koʻrsatilgan holda yuboriladi.',
    'uz-Cyrl': 'Таклиф ёки вакансияга, ёки касб кўрсатилган ҳолда юборилади.',
    ru: 'Приглашение отправляется либо на вакансию, либо с указанием профессии.',
    en: 'An invitation is either to a vacancy or states an occupation of its own.',
  },
  'invitation.dictionary_item_invalid': {
    'uz-Latn': 'Taklifdagi tanlangan qiymatlardan biri notoʻgʻri.',
    'uz-Cyrl': 'Таклифдаги танланган қийматлардан бири нотўғри.',
    ru: 'Одно из выбранных значений приглашения недопустимо.',
    en: 'One of the values chosen for the invitation is not valid.',
  },
  'invitation.vacancy_not_open': {
    'uz-Latn': 'Bu vakansiyaga taklif yuborib boʻlmaydi: u faol emas.',
    'uz-Cyrl': 'Бу вакансияга таклиф юбориб бўлмайди: у фаол эмас.',
    ru: 'Пригласить на эту вакансию нельзя: она не активна.',
    en: 'You cannot invite anyone to this vacancy: it is not active.',
  },

  // --- idempotency (ARCHITECTURE.md §7) ------------------------------------
  // The client reused a key for a different request, which is its bug: a key means
  // "this one operation", so two operations under it is broken key generation.
  'idempotency.key_reused': {
    'uz-Latn': 'Bu soʻrov kaliti boshqa soʻrov uchun ishlatilgan.',
    'uz-Cyrl': 'Бу сўров калити бошқа сўров учун ишлатилган.',
    ru: 'Этот ключ запроса уже использован для другого запроса.',
    en: 'That request key was already used for a different request.',
  },
  'idempotency.in_progress': {
    'uz-Latn': 'Xuddi shu soʻrov bajarilmoqda. Birozdan soʻng tekshiring.',
    'uz-Cyrl': 'Худди шу сўров бажарилмоқда. Бироздан сўнг текширинг.',
    ru: 'Такой же запрос выполняется. Проверьте результат чуть позже.',
    en: 'The same request is already in progress. Check the result shortly.',
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
  'validation.too_many_items': {
    'uz-Latn': 'Koʻpi bilan {max} ta qiymat tanlash mumkin.',
    'uz-Cyrl': 'Кўпи билан {max} та қиймат танлаш мумкин.',
    ru: 'Можно выбрать не более {max} значений.',
    en: 'At most {max} values may be selected.',
  },
  'validation.date_in_future': {
    'uz-Latn': 'Sana kelajakda boʻlishi mumkin emas.',
    'uz-Cyrl': 'Сана келажакда бўлиши мумкин эмас.',
    ru: 'Дата не может быть в будущем.',
    en: 'The date cannot be in the future.',
  },
  'validation.min_age': {
    'uz-Latn': 'Yoshingiz kamida {min} boʻlishi kerak.',
    'uz-Cyrl': 'Ёшингиз камида {min} бўлиши керак.',
    ru: 'Возраст должен быть не менее {min} лет.',
    en: 'You must be at least {min} years old.',
  },
  'validation.date_order': {
    'uz-Latn': 'Tugash sanasi boshlanish sanasidan oldin boʻlmasligi kerak.',
    'uz-Cyrl': 'Тугаш санаси бошланиш санасидан олдин бўлмаслиги керак.',
    ru: 'Дата окончания не может быть раньше даты начала.',
    en: 'The end date cannot be before the start date.',
  },
  'validation.current_has_no_end': {
    'uz-Latn': 'Hozirgi ish joyi uchun tugash sanasi koʻrsatilmaydi.',
    'uz-Cyrl': 'Ҳозирги иш жойи учун тугаш санаси кўрсатилмайди.',
    ru: 'Для текущего места работы дата окончания не указывается.',
    en: 'A current job cannot have an end date.',
  },
  'validation.must_be_url': {
    'uz-Latn': 'Havola http:// yoki https:// bilan boshlanishi kerak.',
    'uz-Cyrl': 'Ҳавола http:// ёки https:// билан бошланиши керак.',
    ru: 'Ссылка должна начинаться с http:// или https://.',
    en: 'The link must start with http:// or https://.',
  },

  // --- schema-driven writes (docs/API_CONTRACTS.md §4.6) -------------------
  // A selected id that is not an active item of the field's dictionary type.
  // Separate from `must_be_id`, which is about the format: the realistic cause
  // here is a client cache old enough to still offer a deactivated item, and
  // "reload the list" is different advice from "that is not an id".
  'validation.dictionary_item_invalid': {
    'uz-Latn': 'Tanlangan qiymat endi mavjud emas. Roʻyxatni yangilang.',
    'uz-Cyrl': 'Танланган қиймат энди мавжуд эмас. Рўйхатни янгиланг.',
    ru: 'Выбранное значение больше не доступно. Обновите список.',
    en: 'The selected value is no longer available. Refresh the list.',
  },
  'validation.district_not_in_region': {
    'uz-Latn': 'Tuman tanlangan viloyatga tegishli emas.',
    'uz-Cyrl': 'Туман танланган вилоятга тегишли эмас.',
    ru: 'Район не относится к выбранному региону.',
    en: 'The district does not belong to the selected region.',
  },
  'validation.salary_range_order': {
    'uz-Latn': 'Boshlangʻich summa yuqori summadan katta boʻlmasligi kerak.',
    'uz-Cyrl': 'Бошланғич сумма юқори суммадан катта бўлмаслиги керак.',
    ru: 'Начальная сумма не должна превышать конечную.',
    en: 'The lower amount must not exceed the upper one.',
  },
  // §4.3: "Negotiable, 5-8M" is a contradiction the salary filter cannot rank.
  'validation.salary_negotiable_excludes_range': {
    'uz-Latn': 'Kelishilgan holatda summa koʻrsatilmaydi.',
    'uz-Cyrl': 'Келишилган ҳолатда сумма кўрсатилмайди.',
    ru: 'При оплате по договорённости сумма не указывается.',
    en: 'A negotiable rate cannot also state an amount.',
  },
} as const satisfies MessageCatalog;

export type MessageKey = keyof typeof MESSAGES;
