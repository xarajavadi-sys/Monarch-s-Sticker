// متن‌های سرویس برای کاربر، به ۴ زبان (fa | en | ru | hi). زبان از ربات می‌آد (فیلد lang)؛ پیش‌فرض: فارسی.
//   T(lang, 'id', ...args)   num(lang, n)
export const LANGS = ['fa', 'en', 'ru', 'hi'];
export const normLang = (l) => (LANGS.includes(l) ? l : 'fa');

const DIGITS = { fa: '۰۱۲۳۴۵۶۷۸۹', hi: '०१२३४५६७८९' };
// ارقام: فارسی با ارقام فارسی؛ بقیه لاتین (هندی هم لاتین، مثل بقیه‌ی ربات)
export const num = (lang, n) => (lang === 'fa' ? String(n).replace(/\d/g, (d) => DIGITS.fa[d]) : String(n));

const D = {
  too_large:   { fa: () => 'حجم فایل بیشتر از حد مجازه.', en: () => 'The file is too large.', ru: () => 'Файл слишком большой.', hi: () => 'फ़ाइल बहुत बड़ी है।' },
  unsupported: { fa: () => 'این نوع فایل پشتیبانی نمی‌شه.', en: () => 'This file type is not supported.', ru: () => 'Этот тип файла не поддерживается.', hi: () => 'यह फ़ाइल प्रकार समर्थित नहीं है।' },
  tgs:         { fa: () => 'استیکرهای انیمیشنی (.tgs) پشتیبانی نمی‌شن.', en: () => 'Animated stickers (.tgs) are not supported.', ru: () => 'Анимированные стикеры (.tgs) не поддерживаются.', hi: () => 'एनिमेटेड स्टिकर (.tgs) समर्थित नहीं हैं।' },
  too_long:    {
    fa: (n) => `مدت ویدیو بیشتر از ${n} ثانیه‌ست.`, en: (n) => `The video is longer than ${n} seconds.`,
    ru: (n) => `Видео длиннее ${n} сек.`, hi: (n) => `वीडियो ${n} सेकंड से लंबा है।`,
  },
  too_big_out: {
    fa: () => 'نتونستم این فایل رو به اندازه‌ی مجاز فشرده کنم. یه فایل ساده‌تر یا کوتاه‌تر امتحان کن.',
    en: () => "I couldn't compress this file to the allowed size. Try a simpler or shorter file.",
    ru: () => 'Не удалось сжать файл до допустимого размера. Попробуй более простой или короткий файл.',
    hi: () => 'मैं इस फ़ाइल को अनुमत आकार तक संपीड़ित नहीं कर सका। कोई सरल या छोटी फ़ाइल आज़माएँ।',
  },
  failed:      {
    fa: () => 'تبدیل فایل ناموفق بود. یه فایل دیگه امتحان کن.', en: () => 'File conversion failed. Try another file.',
    ru: () => 'Не удалось преобразовать файл. Попробуй другой файл.', hi: () => 'फ़ाइल रूपांतरण विफल रहा। कोई दूसरी फ़ाइल आज़माएँ।',
  },
  busy:        {
    fa: () => 'سرور الان شلوغه، چند لحظه‌ی دیگه دوباره بفرست.', en: () => 'The server is busy right now. Please send it again in a moment.',
    ru: () => 'Сервер сейчас занят. Отправь ещё раз через несколько секунд.', hi: () => 'सर्वर अभी व्यस्त है। कुछ क्षण बाद फिर से भेजें।',
  },
  tg_too_big:  {
    fa: () => 'حجم فایل بیشتر از ۲۰ مگابایته (سقف دانلود تلگرام).', en: () => 'The file is larger than 20 MB (Telegram download limit).',
    ru: () => 'Файл больше 20 МБ (лимит загрузки Telegram).', hi: () => 'फ़ाइल 20 MB से बड़ी है (टेलीग्राम डाउनलोड सीमा)।',
  },
  tg_rejected: {
    fa: (m) => `تلگرام این فایل رو قبول نکرد: ${m}`, en: (m) => `Telegram didn't accept this file: ${m}`,
    ru: (m) => `Telegram не принял этот файл: ${m}`, hi: (m) => `टेलीग्राम ने यह फ़ाइल स्वीकार नहीं की: ${m}`,
  },
  convert_failed: {
    fa: (r) => `تبدیل فایل ناموفق بود${r ? ` (${r})` : ''}. چند لحظه بعد دوباره امتحانش کن.`,
    en: (r) => `File conversion failed${r ? ` (${r})` : ''}. Please try again in a moment.`,
    ru: (r) => `Не удалось преобразовать файл${r ? ` (${r})` : ''}. Попробуй ещё раз чуть позже.`,
    hi: (r) => `फ़ाइल रूपांतरण विफल रहा${r ? ` (${r})` : ''}। कुछ देर बाद फिर कोशिश करें।`,
  },
  cancelled:   { fa: () => 'ساخت لغو شد.', en: () => 'The build was cancelled.', ru: () => 'Создание отменено.', hi: () => 'निर्माण रद्द कर दिया गया।' },
  all_failed:  {
    fa: () => 'هیچ‌کدوم از فایل‌ها آماده نشد.', en: () => 'None of the files could be prepared.',
    ru: () => 'Ни один файл не удалось подготовить.', hi: () => 'कोई भी फ़ाइल तैयार नहीं हो सकी।',
  },
  name_taken:  {
    fa: () => 'این نام همین الان گرفته شد.', en: () => 'This name was just taken.',
    ru: () => 'Это имя только что заняли.', hi: () => 'यह नाम अभी-अभी ले लिया गया।',
  },
  eta_calc:    { fa: () => 'در حال محاسبه…', en: () => 'calculating…', ru: () => 'считаю…', hi: () => 'गणना हो रही है…' },
  eta_lt_min:  { fa: () => 'کمتر از یک دقیقه', en: () => 'less than a minute', ru: () => 'меньше минуты', hi: () => 'एक मिनट से कम' },
  eta_hours:   { fa: (n) => `حدود ${n} ساعت`, en: (n) => `about ${n} h`, ru: (n) => `около ${n} ч`, hi: (n) => `लगभग ${n} घंटे` },
  eta_min:     { fa: (n) => `حدود ${n} دقیقه`, en: (n) => `about ${n} min`, ru: (n) => `около ${n} мин`, hi: (n) => `लगभग ${n} मिनट` },
  queue:       {
    fa: (p, t, first) => `\n🔢 جایگاه تو در صف: ${p} از ${t}${first ? ' (نوبت توئه)' : ''}`,
    en: (p, t, first) => `\n🔢 Your place in the queue: ${p} of ${t}${first ? ' (your turn)' : ''}`,
    ru: (p, t, first) => `\n🔢 Твоё место в очереди: ${p} из ${t}${first ? ' (твоя очередь)' : ''}`,
    hi: (p, t, first) => `\n🔢 कतार में आपकी जगह: ${p} में से ${t}${first ? ' (आपकी बारी)' : ''}`,
  },
  ph_adding:   {
    fa: (a, b) => `افزودن استیکرها: ${a} از ${b}`, en: (a, b) => `Adding stickers: ${a} of ${b}`,
    ru: (a, b) => `Добавление стикеров: ${a} из ${b}`, hi: (a, b) => `स्टिकर जोड़े जा रहे हैं: ${b} में से ${a}`,
  },
  ph_creating: { fa: () => 'ساخت پک روی تلگرام', en: () => 'Creating the pack on Telegram', ru: () => 'Создание набора в Telegram', hi: () => 'टेलीग्राम पर पैक बनाया जा रहा है' },
  ph_prepare:  {
    fa: (a, b) => `آماده‌سازی فایل‌ها: ${a} از ${b}`, en: (a, b) => `Preparing files: ${a} of ${b}`,
    ru: (a, b) => `Подготовка файлов: ${a} из ${b}`, hi: (a, b) => `फ़ाइलें तैयार हो रही हैं: ${b} में से ${a}`,
  },
  progress:    {
    fa: (title, bar, pct, phase, q, eta) => `⏳ در حال ساخت «${title}»\n\n${bar}  ${pct}٪\n${phase}${q}\n⏱ زمان باقی‌مونده: ${eta}\n\nلازم نیست منتظر بمونی؛ لینک پک خودکار می‌آد.`,
    en: (title, bar, pct, phase, q, eta) => `⏳ Building “${title}”\n\n${bar}  ${pct}%\n${phase}${q}\n⏱ Time left: ${eta}\n\nNo need to wait here — the pack link will arrive automatically.`,
    ru: (title, bar, pct, phase, q, eta) => `⏳ Создаю «${title}»\n\n${bar}  ${pct}%\n${phase}${q}\n⏱ Осталось: ${eta}\n\nЖдать не нужно — ссылка на набор придёт сама.`,
    hi: (title, bar, pct, phase, q, eta) => `⏳ “${title}” बनाया जा रहा है\n\n${bar}  ${pct}%\n${phase}${q}\n⏱ बचा समय: ${eta}\n\nइंतज़ार करने की ज़रूरत नहीं — पैक का लिंक अपने-आप आ जाएगा।`,
  },
  done_progress: {
    fa: (t) => `✅ ساخت «${t}» تموم شد (۱۰۰٪)`, en: (t) => `✅ “${t}” is ready (100%)`,
    ru: (t) => `✅ «${t}» готов (100%)`, hi: (t) => `✅ “${t}” तैयार है (100%)`,
  },
  done_msg:    {
    fa: (t, link) => `🎉 پک «${t}» ساخته شد!\n\n${link}`, en: (t, link) => `🎉 Your pack “${t}” is ready!\n\n${link}`,
    ru: (t, link) => `🎉 Набор «${t}» создан!\n\n${link}`, hi: (t, link) => `🎉 आपका पैक “${t}” बन गया!\n\n${link}`,
  },
  open_btn:    { fa: () => '✨ مشاهده و افزودن پک', en: () => '✨ View & add the pack', ru: () => '✨ Открыть и добавить набор', hi: () => '✨ पैक देखें और जोड़ें' },
  file_skipped: {
    fa: (m) => `❌ این فایل توی پک نیومد: ${m}`, en: (m) => `❌ This file didn't make it into the pack: ${m}`,
    ru: (m) => `❌ Этот файл не попал в набор: ${m}`, hi: (m) => `❌ यह फ़ाइल पैक में नहीं आई: ${m}`,
  },
  more_skipped: {
    fa: (n) => `و ${n} فایل دیگه هم اضافه نشد.`, en: (n) => `And ${n} more files weren't added.`,
    ru: (n) => `И ещё ${n} файл(ов) не добавлено.`, hi: (n) => `और ${n} फ़ाइलें भी नहीं जुड़ीं।`,
  },
  cancelled_progress: {
    fa: (t) => `🛑 ساخت «${t}» لغو شد.`, en: (t) => `🛑 Building “${t}” was cancelled.`,
    ru: (t) => `🛑 Создание «${t}» отменено.`, hi: (t) => `🛑 “${t}” का निर्माण रद्द कर दिया गया।`,
  },
  tg_error:    { fa: (m) => `خطای تلگرام: ${m}`, en: (m) => `Telegram error: ${m}`, ru: (m) => `Ошибка Telegram: ${m}`, hi: (m) => `टेलीग्राम त्रुटि: ${m}` },
  build_failed: {
    fa: (t, why) => `❌ ساخت پک «${t}» ناموفق بود: ${why}\n\nاعتبارت برگردونده می‌شه. دوباره از ربات «ساخت پک جدید» رو بزن.`,
    en: (t, why) => `❌ Building “${t}” failed: ${why}\n\nYour credit will be refunded. Please start “New pack” again in the bot.`,
    ru: (t, why) => `❌ Не удалось создать «${t}»: ${why}\n\nКредит будет возвращён. Начни «Новый набор» в боте заново.`,
    hi: (t, why) => `❌ “${t}” बनाना विफल रहा: ${why}\n\nआपका क्रेडिट वापस कर दिया जाएगा। बॉट में फिर से “नया पैक” चुनें।`,
  },
  restarted:   {
    fa: (t) => `⚠️ سرویس ساخت پک ری‌استارت شد و ساخت «${t}» نصفه موند.\nدکمه‌ی زیر رو بزن تا از همون‌جا ادامه بدم (چیزی که ساخته شده از بین نمی‌ره).`,
    en: (t) => `⚠️ The build service restarted and building “${t}” was interrupted.\nTap the button below and I'll continue from where it stopped (nothing already built is lost).`,
    ru: (t) => `⚠️ Сервис создания перезапустился, и создание «${t}» прервалось.\nНажми кнопку ниже — я продолжу с того же места (уже созданное не пропадёт).`,
    hi: (t) => `⚠️ बिल्ड सेवा रीस्टार्ट हो गई और “${t}” का निर्माण बीच में रुक गया।\nनीचे का बटन दबाएँ, मैं वहीं से जारी रखूँगा (जो बन चुका है वह नहीं जाएगा)।`,
  },
  resume_btn:  { fa: () => '▶️ ادامه‌ی ساخت', en: () => '▶️ Continue building', ru: () => '▶️ Продолжить', hi: () => '▶️ निर्माण जारी रखें' },
  no_token:    {
    fa: () => 'BOT_TOKEN روی سرویس تنظیم نشده.', en: () => 'BOT_TOKEN is not set on the service.',
    ru: () => 'BOT_TOKEN не настроен на сервисе.', hi: () => 'सेवा पर BOT_TOKEN सेट नहीं है।',
  },
  bad_request: { fa: () => 'درخواست نامعتبر.', en: () => 'Invalid request.', ru: () => 'Некорректный запрос.', hi: () => 'अमान्य अनुरोध।' },
};

export const T = (lang, id, ...args) => (D[id]?.[normLang(lang)] ?? D[id]?.fa)(...args);
