// خطاهای مشترک و متن‌های خطا
import { LIMITS, toFa } from './config.js';

export const E = {
  too_large:   'حجم فایل بیشتر از حد مجازه.',
  unsupported: 'این نوع فایل پشتیبانی نمی‌شه.',
  tgs:         'استیکرهای انیمیشنی (.tgs) پشتیبانی نمی‌شن.',
  too_long:    `مدت ویدیو بیشتر از ${toFa(LIMITS.videoMaxInputSec)} ثانیه‌ست.`,
  too_big_out: 'نتونستم این فایل رو به اندازه‌ی مجاز فشرده کنم. یه فایل ساده‌تر یا کوتاه‌تر امتحان کن.',
  failed:      'تبدیل فایل ناموفق بود. یه فایل دیگه امتحان کن.',
  busy:        'سرور الان شلوغه، چند لحظه‌ی دیگه دوباره بفرست.',
};

export class Fail extends Error {
  constructor(code, status = 200) { super(code); this.code = code; this.status = status; }
}

export class TgErr extends Error {
  constructor(msg, permanent) { super(msg); this.permanent = permanent; }
}

export class BuildFail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
