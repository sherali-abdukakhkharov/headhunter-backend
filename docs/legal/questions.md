# JobBridge maxfiylik hujjatlari: nashrdan oldingi savollar

**Holat:** yurist va operator tasdig‘i kerak.  
**Tayyorlangan sana:** 2026-09-10

Bu savollar siyosat matnida taxmin bilan yopilmagan. Har bir bandda tavsiya
berilgan; tasdiqlangan javobdan keyin uch tildagi policy va account-deletion
sahifalaridagi qavsli joylar yangilanishi kerak.

## 1. O‘zbekistondan tashqarida saqlash va uzatish

**Savol.** Telegram’da barcha fayllar, jumladan shaxsni tasdiqlovchi hujjatlar,
Firebase’da push tokenlari va matnlari, Cloudflare global tarmog‘ida esa trafik
qayta ishlanishi qonuniymi?

**Muhim yangilanish.** Briefdagi “O‘zbekiston fuqarolarining barcha shaxsga doir
ma’lumoti O‘zbekistonda saqlanishi shart” degan talqin 2021-yilgi tahrirga
tayangan. O‘RQ-547 qonunining 2026-yil 26-martdagi O‘RQ-1125 bilan o‘zgargan
amaldagi 27¹-moddasi majburiy lokal saqlashni biometrik, genetik va O‘zbekistonda
faoliyat yurituvchi telekommunikatsiya operatorlari foydalanuvchilari
ma’lumotlariga nisbatan aniq belgilaydi. Boshqa ma’lumotlar teng himoya qiluvchi
davlat, tasdiqlangan standart shartlar/korporativ qoidalar yoki tasdiqlangan
xalqaro standartlardan biri asosida chet elda saqlanishi mumkin. 15-modda
transchegaraviy uzatish talablarini alohida saqlab qoladi. Manba:
<https://lex.uz/docs/4396419>.

**Tavsiya.** O‘zbekiston yuristi quyidagilarni yozma tasdiqlasin:

1. ID hujjati va undagi foto 27¹-modda uchun biometrik ma’lumot hisoblanadimi;
2. Telegram, Google va Cloudflare joylashgan davlatlar “teng himoya” ro‘yxatida
   bormi;
3. bo‘lmasa, qaysi standart shart yoki xalqaro standartga tayansa bo‘ladi;
4. alohida, qayd qilinadigan transchegaraviy rozilik kerakmi.

Eng xavfsiz texnik yechim — shaxsni tasdiqlovchi hujjatlar va boshqa fayllarni
Telegram’dan O‘zbekistondagi, kirishi cheklangan obyekt saqlash tizimiga ko‘chirish.
Bu masala hal bo‘lmaguncha public launchni to‘xtatish tavsiya etiladi.

## 2. Shaxsga doir ma’lumotlar bazasini davlat reyestrida ro‘yxatdan o‘tkazish

**Savol.** 2026-yilgi o‘zgarishdan keyin JobBridge bazasi davlat reyestrida
ro‘yxatdan o‘tishi shartmi? Amaldagi 20-modda 27¹-moddaning ikkinchi qismiga
muvofiq O‘zbekistonda saqlanishi majburiy bazalarni ro‘yxatdan o‘tkazishni
ko‘rsatadi; JobBridge’ning ayrim hujjatlari biometrik toifaga kirishi mumkin.

**Tavsiya.** Vakolatli organ yoki mahalliy yuristdan yozma javob oling va zarur
bo‘lsa launchdan oldin ro‘yxatdan o‘tkazing. Ro‘yxat raqami policy’da yozilishi
shartmi, alohida tasdiqlansin.

## 3. Ma’lumotlar operatori va Google Play publisher’i

**Savol.** “ELITE BRIDGE GROUP” MCHJ xizmat maqsadini va usullarini amalda
belgilaydigan to‘g‘ri operator/controller ekanini tasdiqlaydimi? Ilova hozir
dasturchining shaxsiy Play hisobidan e’lon qilinishi bu maqomga ta’sir qiladimi?

**Tavsiya.** MCHJ bilan dasturchi/publisher o‘rtasidagi topshiriq va ma’lumotlarga
kirish shartlarini yozma shartnomada belgilang. Play listing’dagi developer nomi,
policy’dagi operator va ommaviy kontaktlar bir-biriga zid ko‘rinmasin. Ilovani
tashkilot Play hisobiga o‘tkazish sanasini belgilang.

## 4. Rozilik qanday olinadi

**Savol.** Telefon raqami va SMS yuborilishidan oldin belgilash katagi kerakmi
yoki policy havolasining o‘zi yetarlimi? Maxsus yoki transchegaraviy ma’lumotlar
uchun alohida rozilik kerakmi?

**Tavsiya.** Oldindan belgilanmagan checkbox qo‘ying va rozilik versiyasi, tili,
vaqti hamda policy versiyasini serverda yozib boring. ID hujjati yuklash va
transchegaraviy uzatish uchun yurist tavsiya qilsa alohida, aniq rozilik oling.

Kirish ekranidagi tavsiya etilgan jumla:

- **Uzbek:** “Davom etish orqali JobBridge Maxfiylik siyosatini o‘qiganimni va
  unda ko‘rsatilgan maqsadlarda shaxsga doir ma’lumotlarimga ishlov berilishiga
  rozilik bildirishimni tasdiqlayman.”
- **Русский:** «Продолжая, я подтверждаю, что прочитал(а) Политику
  конфиденциальности JobBridge и согласен(на) на обработку моих персональных
  данных в указанных в ней целях».
- **English:** “By continuing, I confirm that I have read the JobBridge Privacy
  Policy and consent to the processing of my personal data for the purposes
  described in it.”

Policy havolasi “Maxfiylik siyosati / Политика конфиденциальности / Privacy
Policy” matnining o‘zida bosiladigan bo‘lsin. Rozilikni xizmat ko‘rsatish uchun
zarur bo‘lmagan marketingga birlashtirmang; JobBridge’da marketing hozir yo‘q.

## 5. Saqlash muddatlari va server loglari

**Savol.** Quyidagi muhandis tanlagan muddatlarni yurist va operator
tasdiqlaydimi: 30 kunlik grace period, OTP — 1 kun, seans — 90 kun, rate limit —
2 kun, yuborilmagan fayl va idempotency kaliti — 7 kun, bildirishnoma — 180 kun,
backup — 14 kun, doimiy audit va Coin jurnali? Server loglari uchun muddat
belgilanmagan.

**Tavsiya.** Oddiy server loglari uchun 30 kunlik boshlang‘ich muddatni ko‘rib
chiqing; xavfsizlik hodisasi bo‘yicha ajratilgan log faqat tergov yakunigacha
uzoqroq saqlansin. “Doimiy” audit va moliyaviy yozuvning aniq qonuniy asosini
yurist/soliq maslahatchisi tasdiqlasin. Tasdiqlangan raqamlar
`src/infra/retention/retention-policy.ts`ga kiritilib, `provenance` qiymati
`client_approved`ga o‘zgartirilsin.

## 6. Telegram’dagi fayl o‘chirilishi

**Savol.** JobBridge metadata’sini o‘chirish, lekin Telegram chatida faylni
qoldirish “o‘chirish” hisoblanadimi? Yo‘q: fayl operator chatida ko‘rinadigan
bo‘lsa, u amalda saqlanmoqda.

**Tavsiya.** Public launchdan oldin quyidagilardan birini qiling:

1. fayllarni o‘chirish to‘liq boshqariladigan O‘zbekistondagi storage’ga
   ko‘chiring; yoki
2. har bir account deletion uchun Telegram xabarlarini qo‘lda o‘chiradigan,
   bajarilishi va auditi bor operatsion jarayon yarating va aniq SLA belgilang.

Google Play xizmat ko‘rsatuvchidagi ma’lumotni ham o‘chirishni so‘rashni talab
qiladi. Faqat “ilovadan endi olinmaydi” deyish yetarli emas:
<https://support.google.com/googleplay/android-developer/answer/13327111>.

## 7. 30 kun ichida o‘chirishni bekor qilish

**Savol.** O‘chirish so‘ragan foydalanuvchi qayta kirsa nima bo‘ladi? Hozir
in-app cancel endpoint va ekran yo‘q; bazada `cancelled_at` maydoni bor xolos.

**Tavsiya.** Oddiy login o‘z-o‘zidan bekor qilmasin. OTP bilan kirgandan keyin
“Hisob o‘chirilishi rejalashtirilgan” ekrani chiqsin va foydalanuvchi alohida
**Hisobni saqlab qolish** tugmasini bossa bekor qilinsin. Shu endpoint, audit
yozuvi va uch tildagi ekran launchdan oldin qo‘shilsin. Vaqtincha e-mail orqali
shaxsni tekshirib bekor qilish jarayoni yozma belgilanadi.

## 8. Ma’lumot nusxasini olish huquqi

**Savol.** O‘RQ-547 30-moddadagi o‘z ma’lumotlari va ishlov berish tarkibi
haqida axborot olish huquqini qanday bajaramiz? Ilovada eksport yo‘q.

**Tavsiya.** Dastlab [CONTACT EMAIL] orqali qo‘lda bajariladigan, shaxsni
tekshirish, javob muddati, xavfsiz yetkazish va rad sababini qayd etish jarayonini
tasdiqlang. Keyin self-service eksportni rejalashtiring. Policy’dagi “so‘rov
ko‘rib chiqiladi” jumlasi faqat real support jarayoni ishga tushsa qolsin.

## 9. 14 yosh va voyaga yetmaganlar

**Savol.** Mehnatga kirishning ayrim holatlaridagi eng kichik yosh bilan
shaxsga doir ma’lumotlarga mustaqil rozilik berish yoshi bir xil deb olinishi
to‘g‘rimi? 14–17 yoshdagilar uchun qonuniy vakil roziligi, mehnat turi yoki
vaqtiga cheklovlar bormi? Google Play target audience nima bo‘ladi?

**Tavsiya.** Yurist va Play siyosati bo‘yicha mutaxassis bitta qaror chiqarsin;
validator, onboarding, policy va Play deklaratsiyasi aynan shu qarorga mos
bo‘lsin. Qaror bo‘lmaguncha 14+ bilan public launch qilish tavsiya etilmaydi.
Eng ehtiyotkor vaqtinchalik variant — 18+, ammo bu mahsulot talabini o‘zgartiradi
va faqat operator roziligi bilan qilinadi.

## 10. Telegram chati va serverga kim kira oladi

**Savol.** Operator ichida qaysi lavozimlar Telegram storage chatiga, serverga,
backup’ga va FCM/Eskiz sozlamalariga kira oladi?

**Tavsiya.** Policy’da odamlarning ismini emas, rollarni ayting. Alohida xizmat
hisoblari, eng kam huquq, ikki bosqichli himoya, davriy access review va xodim
ketganda kirishni yopish tartibini hujjatlashtiring. ID hujjatlari bor Telegram
chatiga kundalik shaxsiy hisoblar bilan kirishni cheklang.

## 11. Davlat organi yoki sud so‘rovlari

**Savol.** Kim so‘rovning qonuniyligini tekshiradi, qaysi hajm beriladi, foydalanuvchi
xabardor qilinadimi va so‘rov qayd etiladimi?

**Tavsiya.** Faqat yozma va majburiy qonuniy talabga javob berish, so‘rovni
yurist tekshirishi, eng kam zarur ma’lumotni berish, taqiqlanmagan bo‘lsa
foydalanuvchini xabardor qilish va disclosure log yuritish tartibini tasdiqlang.

## 12. Google Play Data safety — “shared” javobi

**Savol.** Telegram, Firebase, Eskiz va Cloudflare haqiqatan ham operator
topshirig‘i bilan ishlaydigan “service provider”larmi? Ayniqsa Telegram Bot API
shartlari operatorga kerakli processor majburiyatlari, o‘chirish va transchegaraviy
kafolatlarni beradimi? Shaxsiy developer account publisher, MCHJ esa controller
bo‘lsa, Google’ning “first party” ta’rifi qanday qo‘llanadi?

**Tavsiya.** Har bir provayder shartnomasini yurist ko‘rib chiqmaguncha “Shared:
No” javobini tasdiqlamang. Google service-provider istisnosiga faqat ma’lumotni
developer nomidan va uning ko‘rsatmasi bo‘yicha ishlovchi tashkilot kiradi:
<https://support.google.com/googleplay/android-developer/answer/10787469>.

## 13. Google Play Data safety — yetishmayotgan yoki bahsli turlar

**Savol.** Brief jadvali quyidagilarni yetarli aks ettiradimi?

- IP manzil va qurilma fingerprint’i “Device or other IDs” va ayrim talqinlarda
  taxminiy joylashuv sifatida ko‘rsatilishi mumkin;
- Coin ledger, Candidate Unlock va kelajak tranzaksiya tarixi Google’ning
  “Purchase history”/moliyaviy ma’lumot turiga tushishi mumkin, garchi karta
  ma’lumoti olinmasa ham;
- shaxsni tasdiqlovchi hujjatlar oddiy “Files and documents”dan tashqari boshqa
  shaxsiy identifikator toifasini talab qilishi mumkin;
- push token “push uchun required” deyilgani bilan push ruxsati foydalanuvchi
  tanlovidir; optional javobi qayta tekshirilsin;
- notification sarlavha/matni Google’ga yuboriladi va unda nom yoki ish jarayoni
  haqidagi ma’lumot bo‘lishi mumkin.

**Tavsiya.** Play Console’ning joriy formasi ochiq turgan paytda har bir data
type va purpose’ni haqiqiy tarmoq payloadlari bilan satrma-satr solishtiring.
“Financial info: Not yet” javobini Coin ledger sabab avtomatik qabul qilmang.

## 14. FCM payload tasdig‘i

**Savol.** Engineering tekshiruvi bo‘yicha hozir FCM’ga aynan nima ketadi?

**Tekshiruv natijasi.** Server kodi `notification.title`, `notification.body`
va `data` ichida `notificationId`, `event`, zarur bo‘lsa `targetType` va
`targetId` yuboradi. Hujjat yoki chat attachment yubormaydi. Bu
`src/modules/notifications/push/push-dispatcher.service.ts` va
`fcm-push.sender.ts`da ko‘rildi.

**Tavsiya.** Release buildda real test notification’ni proxy/log orqali bir marta
tasdiqlang. Notification matn shablonlarida telefon, ID hujjati, to‘liq xabar
matni yoki boshqa ortiqcha ma’lumot paydo bo‘lmasin.

## 15. Kontakt, server joyi va hujjatlarni tasdiqlash

**Savol.** Public [CONTACT EMAIL], serverning jismoniy manzili/mamlakati,
siyosatning kuchga kirish sanasi va yakuniy approver kim?

**Tavsiya.** Operator nazoratidagi maxsus privacy/support manzilidan foydalaning,
server O‘zbekistonda ekanini hosting hujjati bilan tekshiring va uch tildagi
fayllarga bir xil sanani kiriting. Tasdiqlangan nusxani versiyalang; sign-in
roziligi aynan shu versiyaga bog‘lansin.

## Nashrga qo‘yiladigan minimum gate

Quyidagilar yopilmaguncha hujjatlarni public URL’ga joylamaslik tavsiya etiladi:

1. Telegram/ID hujjatlari bo‘yicha qonuniylik va real o‘chirish;
2. operator/controller va public kontakt;
3. 14–17 yosh bo‘yicha qaror;
4. server log muddati va barcha retention tasdig‘i;
5. o‘chirishni bekor qilish va e-mail orqali request jarayoni;
6. Google Play Data safety’ning “shared”, IP va moliyaviy turlarini qayta
   tekshirish.

