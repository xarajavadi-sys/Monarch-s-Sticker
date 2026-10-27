// تنظیمات و ثابت‌های مشترک سرویس (با متغیر محیطی Render قابل تغییر)


// ───────── تنظیمات ─────────
export const PORT = Number(process.env.PORT || 10000);   // Render خودش PORT رو می‌ده
export const API_KEY = process.env.MEDIA_KEY || '';
export const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
export const MAX_QUEUE = 60;

// تنظیمات انکودر VP9 (با متغیر محیطی Render عوض می‌شه، بدون تغییر کد)
//   VP9_DEADLINE = good | realtime        (پیش‌فرض good: کندتر ولی فشرده‌سازی بهتر)
//   VP9_CPU_USED = 0..5 برای good، 0..8 برای realtime   (پیش‌فرض 3)
//   MAX_FPS      = سقف فریم‌ریت خروجی ویدیو (پیش‌فرض 30 = سقف رسمی تلگرام)
export const VP9_DEADLINE = process.env.VP9_DEADLINE === 'realtime' ? 'realtime' : 'good';
export const VP9_CPU_USED = String(Number(process.env.VP9_CPU_USED ?? 3));
export const MAX_FPS = Math.min(60, Math.max(24, Number(process.env.MAX_FPS ?? 30)));

export const LIMITS = {
  staticInputBytes: 20 * 1024 * 1024,   // سقف دانلود تلگرام برای ربات
  videoInputBytes: 5 * 1024 * 1024,     // طبق قوانین پک: ورودی ویدیو حداکثر ۵ مگابایت
  staticOutBytes: 512 * 1024,           // سقف تلگرام برای استیکر ثابت
  videoOutBytes: 254 * 1024,            // سقف تلگرام ۲۵۶KB؛ کمی کمتر برای اطمینان
  videoMaxInputSec: 4,                  // بیشتر از این رد می‌شه
  videoOutSec: 3,                       // سقف تلگرام برای استیکر ویدیویی
  videoTargetSec: 2.95,                 // هدف کمی کمتر از ۳ ثانیه (حاشیه‌ی خطای گرد کردن)
  ffmpegTimeoutMs: 90_000,
};

// تلاش‌های فشرده‌سازی از کیفیت بالا به پایین
export const STATIC_QUALITIES = [92, 85, 75, 65, 55, 45, 35, 25, 15];
// br = ضریبی از «بودجه‌ی بیت‌ریت» که از سقف حجم محاسبه می‌شه (کنترل حجم در همون پاس اول)
export const VIDEO_STEPS = [
  { fps: 30, br: 1.0 },
  { fps: 30, br: 0.85 },
  { fps: 30, br: 0.7 },
  { fps: 24, br: 0.55 },            // فریم‌ریت از ۲۴ پایین‌تر نمی‌ره (پرش نداشته باشه)
  { fps: 24, br: 0.42 },
  { fps: 24, br: 0.3 },
];

// فرمت‌های ورودی مجاز (ffprobe format_name). جلوی خوندن playlist/concat و ... رو می‌گیره.
export const ALLOWED_FORMATS = new Set([
  'png_pipe', 'jpeg_pipe', 'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'gif', 'apng',
  'image2', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'flv',
]);

export const toFa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const TG_API = (process.env.TG_API || 'https://api.telegram.org').replace(/\/+$/, '');
export const ADMIN_IDS = String(process.env.ADMIN_IDS || '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x !== 0);
export const SELF_URL = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
