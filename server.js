// سرویس تبدیل مدیا برای Monarch Stickerbot
//   POST /convert?kind=static|video|thumb_static|thumb_video   (بدنه: بایت‌های خام فایل، هدر x-api-key)
//   GET  /health
// بدون هیچ وابستگی npm؛ فقط Node 18+ و ffmpeg/ffprobe.
//
// خروجی موفق:  { ok:true, kind, mime, width, height, duration, size, data:"<base64>" }
// خروجی خطا:   { ok:false, error:"<code>", message:"<متن فارسی>" }

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';

// ───────── تنظیمات ─────────
const PORT = Number(process.env.PORT || 10000);   // Render خودش PORT رو می‌ده
const API_KEY = process.env.MEDIA_KEY || '';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const MAX_QUEUE = 60;

// تنظیمات انکودر VP9 (با متغیر محیطی Render عوض می‌شه، بدون تغییر کد)
//   VP9_DEADLINE = good | realtime        (پیش‌فرض good: کندتر ولی فشرده‌سازی بهتر)
//   VP9_CPU_USED = 0..5 برای good، 0..8 برای realtime   (پیش‌فرض 3)
//   MAX_FPS      = سقف فریم‌ریت خروجی ویدیو (پیش‌فرض 30 = سقف رسمی تلگرام)
const VP9_DEADLINE = process.env.VP9_DEADLINE === 'realtime' ? 'realtime' : 'good';
const VP9_CPU_USED = String(Number(process.env.VP9_CPU_USED ?? 3));
const MAX_FPS = Math.min(60, Math.max(24, Number(process.env.MAX_FPS ?? 30)));

const LIMITS = {
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
const STATIC_QUALITIES = [92, 85, 75, 65, 55, 45, 35, 25, 15];
// br = ضریبی از «بودجه‌ی بیت‌ریت» که از سقف حجم محاسبه می‌شه (کنترل حجم در همون پاس اول)
const VIDEO_STEPS = [
  { fps: 30, br: 1.0 },
  { fps: 30, br: 0.85 },
  { fps: 30, br: 0.7 },
  { fps: 24, br: 0.55 },            // فریم‌ریت از ۲۴ پایین‌تر نمی‌ره (پرش نداشته باشه)
  { fps: 24, br: 0.42 },
  { fps: 24, br: 0.3 },
];

// فرمت‌های ورودی مجاز (ffprobe format_name). جلوی خوندن playlist/concat و ... رو می‌گیره.
const ALLOWED_FORMATS = new Set([
  'png_pipe', 'jpeg_pipe', 'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'gif', 'apng',
  'image2', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'flv',
]);

const toFa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

const E = {
  too_large:   'حجم فایل بیشتر از حد مجازه.',
  unsupported: 'این نوع فایل پشتیبانی نمی‌شه.',
  tgs:         'استیکرهای انیمیشنی (.tgs) پشتیبانی نمی‌شن.',
  too_long:    `مدت ویدیو بیشتر از ${toFa(LIMITS.videoMaxInputSec)} ثانیه‌ست.`,
  too_big_out: 'نتونستم این فایل رو به اندازه‌ی مجاز فشرده کنم. یه فایل ساده‌تر یا کوتاه‌تر امتحان کن.',
  failed:      'تبدیل فایل ناموفق بود. یه فایل دیگه امتحان کن.',
  busy:        'سرور الان شلوغه، چند لحظه‌ی دیگه دوباره بفرست.',
};

// ───────── ابزارها ─────────
function run(cmd, args, timeoutMs = LIMITS.ffmpegTimeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const cap = (s, d) => (s.length > 200_000 ? s : s + d);
    p.stdout.on('data', (d) => { out = cap(out, d); });
    p.stderr.on('data', (d) => { err = cap(err, d); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
  });
}

class Fail extends Error {
  constructor(code, status = 200) { super(code); this.code = code; this.status = status; }
}

async function probe(file) {
  const r = await run('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file',
    '-print_format', 'json', '-show_format', '-show_streams', file,
  ], 20_000);
  if (r.code !== 0) throw new Fail('unsupported');
  try { return JSON.parse(r.out); } catch { throw new Fail('unsupported'); }
}

function parseRate(s) {
  if (!s || typeof s !== 'string') return 0;
  const [a, b] = s.split('/').map(Number);
  if (!a) return 0;
  return b ? a / b : a;
}

// اطلاعات لازم از خروجی ffprobe + اعتبارسنجی فرمت
function inspect(info) {
  const names = String(info?.format?.format_name || '').split(',').map((s) => s.trim());
  if (!names.length || !names.every((n) => ALLOWED_FORMATS.has(n))) throw new Fail('unsupported');
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  if (!v || !v.width || !v.height) throw new Fail('unsupported');
  const duration = Number(info.format?.duration ?? v.duration ?? 0) || 0;
  return {
    codec: v.codec_name,
    width: v.width,
    height: v.height,
    duration,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30,
    isWebm: names.includes('webm') || names.includes('matroska'),
    // آلفای واقعی: webm با alpha_mode، پیکسل‌فرمت آلفادار، یا گیف/apng (شفافیت دارن)
    alpha: v.tags?.alpha_mode === '1' || /yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16|pal8/.test(String(v.pix_fmt || '')) || v.codec_name === 'gif' || v.codec_name === 'apng',
  };
}

// ویدیوی webm با آلفا (استیکر ویدیویی تلگرام) فقط با دیکودر libvpx آلفا رو نگه می‌داره
const decoderArgs = (m) =>
  m.isWebm && m.codec === 'vp9' ? ['-c:v', 'libvpx-vp9']
  : m.isWebm && m.codec === 'vp8' ? ['-c:v', 'libvpx']
  : [];

// پروفایل خروجی هر kind
//   thumb_*: آیکون پک؛ تلگرام اندازه‌ی دقیقاً ۱۰۰×۱۰۰ می‌خواد (با حاشیه‌ی شفاف)
const PROFILES = {
  static:       { size: 512, pad: false, video: false, outBytes: LIMITS.staticOutBytes },
  video:        { size: 512, pad: false, video: true,  outBytes: LIMITS.videoOutBytes },
  thumb_static: { size: 100, pad: true,  video: false, outBytes: 128 * 1024 },
  thumb_video:  { size: 100, pad: true,  video: true,  outBytes: 30 * 1024 },   // سقف تلگرام ۳۲KB
};

const scaleFilter = (p) =>
  `scale=${p.size}:${p.size}:force_original_aspect_ratio=decrease:force_divisible_by=2` +
  (p.pad ? `,format=yuva420p,pad=${p.size}:${p.size}:(ow-iw)/2:(oh-ih)/2:color=black@0` : '');

// ───────── استیکر ثابت ─────────
async function makeStatic(input, dir, m, p) {
  const out = join(dir, 'out.webp');
  let last = 0;
  for (const q of STATIC_QUALITIES) {
    const r = await run('ffmpeg', [
      '-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file',
      ...decoderArgs(m), '-i', input,
      '-map', '0:v:0', '-frames:v', '1', '-an', '-sn',
      '-vf', `${scaleFilter(p)},format=yuva420p`,
      '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6',
      out,
    ]);
    if (r.code !== 0) throw new Fail('failed');
    last = (await stat(out)).size;
    if (last <= p.outBytes) {
      return { file: out, mime: 'image/webp' };
    }
  }
  throw new Fail('too_big_out');
}

// ───────── استیکر ویدیویی ─────────
//  ≤ ۳ ثانیه          : دست‌نخورده
//  ۳ تا ۳.۱ ثانیه     : فقط ته ویدیو بریده می‌شه
//  ۳.۱ تا ۴ ثانیه     : سریع‌تر پخش می‌شه تا دقیقاً ۳ ثانیه بشه
//  > ۴ ثانیه          : رد می‌شه
async function makeVideo(input, dir, m, p, opts = {}) {
  const d = m.duration;
  if (d > LIMITS.videoMaxInputSec + 0.05) throw new Fail('too_long');

  const target = LIMITS.videoTargetSec;               // ۲٫۹۵ ثانیه
  const needsTrim = d > target && d <= 3.1;           // ۲٫۹۵ تا ۳٫۱: فقط ته ویدیو بریده می‌شه
  const speedUp = d > 3.1;                            // ۳٫۱ تا ۴: سریع‌تر پخش می‌شه (هیچ فریمی دور ریخته نمی‌شه)
  const alpha = p.pad || m.alpha;
  const pixFmt = alpha ? 'yuva420p' : 'yuv420p';
  const out = join(dir, 'out.webm');

  const outSec = Math.min(d, target) || 1;
  // ۹۳٪ سقف حجم (جا برای container و نوسان) تقسیم بر مدت = بیت‌ریت هدف
  const budgetBps = Math.floor((p.outBytes * 8 * 0.93) / outSec);

  // فریم‌ریت واقعی بعد از تند کردن (مثلاً ۱۰۴ فریم توی ۲٫۹۵ ثانیه ≈ ۳۵٫۲)
  const effFps = (m.fps || 30) * (speedUp ? d / target : 1);
  const fpsCap = Math.min(opts.fpsCap ?? MAX_FPS, 60);
  let usedFps = effFps;

  for (const step of VIDEO_STEPS) {
    const bps = Math.max(40_000, Math.floor(budgetBps * step.br));
    const filters = [];
    if (speedUp) filters.push(`setpts=PTS*${(target / d).toFixed(6)}`);
    const cap = Math.min(fpsCap, step.fps === 30 ? fpsCap : step.fps);
    usedFps = Math.min(effFps, cap);
    if (effFps > cap + 0.01) filters.push(`fps=${cap}`);           // فقط وقتی از سقف بیشتر باشه
    filters.push(scaleFilter(p), `format=${pixFmt}`);

    const args = [
      '-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file',
      ...decoderArgs(m), '-i', input,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', filters.join(','),
      '-fps_mode', 'passthrough',                                  // زمان‌بندی فریم‌ها دست‌نخورده؛ هیچ فریمی حذف/تکرار نمی‌شه
      ...(needsTrim || speedUp ? ['-t', String(target)] : []),
      '-c:v', 'libvpx-vp9', '-b:v', String(bps), '-maxrate', String(bps),   // بدون -crf: کیفیت با بیت‌ریت تعیین می‌شه
      '-pix_fmt', pixFmt,
      ...(alpha ? ['-auto-alt-ref', '0'] : []),                    // فقط برای شفافیت لازمه؛ بدون آلفا فشرده‌سازی بهتره
      '-row-mt', '1', '-deadline', VP9_DEADLINE, '-cpu-used', VP9_CPU_USED, '-threads', '2',
      '-f', 'webm', out,
    ];
    const r = await run('ffmpeg', args);
    if (r.code !== 0) throw new Fail('failed');
    const size = (await stat(out)).size;
    if (size <= p.outBytes) return { file: out, mime: 'video/webm', fps: Number(usedFps.toFixed(2)) };
  }
  throw new Fail('too_big_out');
}

// ابعاد/مدت فایل خروجی (فقط برای گزارش؛ خطا نباید کار رو خراب کنه)
async function outputInfo(file) {
  try {
    const info = await probe(file);
    const v = (info.streams || []).find((s) => s.codec_type === 'video');
    return {
      width: v?.width ?? null,
      height: v?.height ?? null,
      duration: Number(info.format?.duration ?? v?.duration ?? 0) || 0,
    };
  } catch {
    return {};
  }
}

// ───────── پردازش یک درخواست ─────────
async function convert(bytes, kind, opts = {}) {
  const p = PROFILES[kind];
  if (bytes.length < 16) throw new Fail('unsupported');
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Fail('tgs'); // gzip = tgs

  const limit = p.video ? LIMITS.videoInputBytes : LIMITS.staticInputBytes;
  if (bytes.length > limit) throw new Fail('too_large');

  const dir = await mkdtemp(join(tmpdir(), 'conv-'));
  try {
    const input = join(dir, 'in.bin');
    await writeFile(input, bytes);
    const m = inspect(await probe(input));

    const res = p.video ? await makeVideo(input, dir, m, p, opts) : await makeStatic(input, dir, m, p);

    const buf = await readFile(res.file);
    const info = await outputInfo(res.file);
    return {
      ok: true,
      kind,
      mime: res.mime,
      width: info.width ?? null,
      height: info.height ?? null,
      duration: p.video ? Number((info.duration ?? 0).toFixed(2)) : 0,
      fps: res.fps ?? null,
      size: buf.length,
      data: buf.toString('base64'),
    };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ───────── صف ساده (حداکثر MAX_CONCURRENT کار هم‌زمان) ─────────
let active = 0;
const waiting = [];
async function schedule(fn, { unbounded = false } = {}) {
  if (active >= MAX_CONCURRENT) {
    if (!unbounded && waiting.length >= MAX_QUEUE) throw new Fail('busy', 503);
    await new Promise((res) => waiting.push(res));
  }
  active++;
  try { return await fn(); }
  finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

// ───────── کش و هم‌پوشانی کارها ─────────
// ربات سرورلس مهلت کوتاهی داره و ممکنه وسط انتظار قطع بشه؛ بعداً همون فایل رو دوباره می‌فرسته.
// پس نتیجه‌ی هر فایل (بر اساس هش محتوا) چند دقیقه نگه داشته می‌شه و درخواست تکراری به همون کار وصل می‌شه.
const JOB_TTL_MS = 30 * 60_000;
const JOB_MAX = 150;
const jobs = new Map();   // key → { promise, result, at }
async function convertDeduped(bytes, kind, opts = {}) {
  const key = createHash('sha256').update(`${kind}#${opts.fpsCap ?? ''}`).update(bytes).digest('hex');
  const now = Date.now();
  for (const [k, j] of jobs) if (j.result && now - j.at > JOB_TTL_MS) jobs.delete(k);
  while (jobs.size >= JOB_MAX) {                       // قدیمی‌ترین نتیجه‌ی تمام‌شده حذف می‌شه
    const oldest = [...jobs].find(([, j]) => j.result);
    if (!oldest) break;
    jobs.delete(oldest[0]);
  }
  let job = jobs.get(key);
  if (job) return job.promise;
  job = { at: now, result: null, promise: null };
  job.promise = schedule(() => convert(bytes, kind, opts), { unbounded: opts.unbounded }).then(
    (r) => { job.result = r; job.at = Date.now(); return r; },
    (e) => { jobs.delete(key); throw e; },     // busy و خطاهای گذرا کش نمی‌شن
  );
  jobs.set(key, job);
  return job.promise;
}


// ───────── کارهای پس‌زمینه: دانلود از تلگرام ← تبدیل ← آپلود به‌عنوان فایل استیکر ─────────
// ربات سرورلس فقط «ثبت» می‌کنه (enqueue) و بعداً وضعیت می‌پرسه (status)؛ هیچ‌وقت منتظر تبدیل نمی‌مونه.
// نیازمند BOT_TOKEN (توکن ربات از BotFather) در متغیرهای محیطی رندر.
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TG_API = (process.env.TG_API || 'https://api.telegram.org').replace(/\/+$/, '');
const BG_TTL_MS = 6 * 60 * 60_000;
const BG_MAX = 3000;
const bg = new Map();   // "kind:file_id" → { state, userId, stickerFileId?, error?, message?, at }

class TgErr extends Error {
  constructor(msg, permanent) { super(msg); this.permanent = permanent; }
}

async function tgCall(method, body) {
  let r;
  try {
    r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, { ...(body ? { method: 'POST', body } : {}), signal: AbortSignal.timeout(body ? 60_000 : 20_000) });
  } catch (e) { throw new TgErr(`network: ${e.message}`, false); }
  let j = null;
  try { j = await r.json(); } catch (_) { /* غیر JSON */ }
  if (!j?.ok) {
    const permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
    throw new TgErr(j?.description || `HTTP ${r.status}`, permanent);
  }
  return j.result;
}

async function tgDownload(fileId, maxBytes) {
  const info = await tgCall(`getFile?file_id=${encodeURIComponent(fileId)}`);
  if (info.file_size && info.file_size > maxBytes) throw new Fail('too_large');
  let r;
  try { r = await fetch(`${TG_API}/file/bot${BOT_TOKEN}/${info.file_path}`, { signal: AbortSignal.timeout(45_000) }); }
  catch (e) { throw new TgErr(`network: ${e.message}`, false); }
  if (!r.ok) throw new TgErr(`download HTTP ${r.status}`, r.status < 500);
  let buf;
  try { buf = Buffer.from(await r.arrayBuffer()); } catch (e) { throw new TgErr(`network: ${e.message}`, false); }
  if (buf.length > maxBytes) throw new Fail('too_large');
  return buf;
}

async function tgUploadSticker(userId, kind, bytes, mime) {
  const form = new FormData();
  form.set('user_id', String(userId));
  form.set('sticker_format', kind === 'video' ? 'video' : 'static');
  form.set('sticker', new Blob([bytes], { type: mime }), kind === 'video' ? 'sticker.webm' : 'sticker.webp');
  return tgCall('uploadStickerFile', form);
}

async function runBgJob(key, job, fileId, kind) {
  try {
    const p = PROFILES[kind];
    const max = p.video ? LIMITS.videoInputBytes : LIMITS.staticInputBytes;
    const bytes = await tgDownload(fileId, max);
    let out = await convertDeduped(bytes, kind, { unbounded: true });
    if (!out.ok) { job.state = 'failed'; job.error = out.error; job.message = out.message; return; }
    let up;
    try {
      up = await tgUploadSticker(job.userId, kind, Buffer.from(out.data, 'base64'), out.mime);
    } catch (e) {
      // فریم‌ریت بالای ۳۰ رد شد؟ یک بار با سقف رسمی ۳۰ دوباره می‌سازیم
      if (!(e instanceof TgErr && e.permanent && kind === 'video' && out.fps > 30.01)) throw e;
      console.warn('upload rejected at', out.fps, 'fps → retry at 30:', e.message);
      out = await convertDeduped(bytes, kind, { unbounded: true, fpsCap: 30 });
      if (!out.ok) { job.state = 'failed'; job.error = out.error; job.message = out.message; return; }
      up = await tgUploadSticker(job.userId, kind, Buffer.from(out.data, 'base64'), out.mime);
    }
    job.stickerFileId = up.file_id;
    job.state = 'done';
  } catch (e) {
    if (e instanceof Fail) { job.state = 'failed'; job.error = e.code; job.message = E[e.code] || E.failed; }
    else if (e instanceof TgErr && e.permanent) { job.state = 'failed'; job.error = 'tg_rejected'; job.message = /too big/i.test(e.message) ? 'حجم فایل بیشتر از ۲۰ مگابایته (سقف دانلود تلگرام).' : `تلگرام این فایل رو قبول نکرد: ${e.message}`; }
    else { job.state = 'retry'; job.error = 'transient'; console.warn('bg job transient', key, e?.message); }
  } finally {
    job.at = Date.now();
  }
}

// حداکثر چند کار پس‌زمینه هم‌زمان (هرکدوم ممکنه تا ۵ مگابایت توی حافظه نگه داره)؛ خود تبدیل جداگانه با schedule محدود می‌شه
const BG_CONCURRENT = 4;
let bgActive = 0;
const bgWaiting = [];          // { userId, resolve }
let bgLastUser = null;
// نوبت منصفانه: کاربری که ۱۲۰ فایل فرستاده نذاره بقیه معطل بمونن (به‌ترتیب بین کاربرها می‌چرخه)
function bgPickNext() {
  if (!bgWaiting.length) return null;
  let i = bgWaiting.findIndex((w) => w.userId !== bgLastUser);
  if (i < 0) i = 0;
  const [w] = bgWaiting.splice(i, 1);
  bgLastUser = w.userId;
  return w;
}
async function bgSchedule(userId, fn) {
  if (bgActive >= BG_CONCURRENT) await new Promise((resolve) => bgWaiting.push({ userId, resolve }));
  bgActive++;
  try { return await fn(); }
  finally { bgActive--; bgPickNext()?.resolve(); }
}

function enqueueBg(fileId, kind, userId) {
  const key = `${userId}:${kind}:${fileId}`;          // کلید شامل کاربره: فایل آپلودشده فقط برای صاحبش معتبره
  const now = Date.now();
  for (const [k, j] of bg) if (j.state !== 'queued' && j.state !== 'running' && now - j.at > BG_TTL_MS) bg.delete(k);
  if (bg.size >= BG_MAX) for (const [k, j] of bg) { if (j.state === 'done' || j.state === 'failed') { bg.delete(k); if (bg.size < BG_MAX * 0.9) break; } }
  let job = bg.get(key);
  if (job && job.state === 'running' && now - (job.startedAt ?? now) > 4 * 60_000) job = null;   // گیرکرده؛ از نو
  if (job && (job.state === 'queued' || job.state === 'running' || job.state === 'done' || job.state === 'failed')) {
    return job;
  }
  job = { state: 'queued', userId, at: now };
  bg.set(key, job);
  bgSchedule(userId, async () => { job.state = 'running'; job.startedAt = Date.now(); await runBgJob(key, job, fileId, kind); })
    .catch((e) => { job.state = 'retry'; job.error = String(e?.message || e); });
  return job;
}

function bgCounts() {
  const c = { queued: 0, running: 0, done: 0, failed: 0, retry: 0 };
  for (const j of bg.values()) c[j.state] = (c[j.state] ?? 0) + 1;
  return c;
}

const view = (j) => (j
  ? { state: j.state, ...(j.state === 'done' ? { sticker_file_id: j.stickerFileId } : {}), ...(j.state === 'failed' || j.state === 'retry' ? { error: j.error, message: j.message } : {}) }
  : { state: 'missing' });

async function readJson(req, max = 1_000_000) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Fail('too_large', 413); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw new Fail('unsupported', 400); }
}


// ───────── ساخت کامل پک سمت سرویس ─────────
// ربات فقط درخواست ساخت می‌فرسته؛ سرویس فایل‌ها رو آماده می‌کنه، پک رو می‌سازه و لینک رو مستقیم برای کاربر می‌فرسته
// (کاربر لازم نیست منتظر بمونه). وضعیت توی حافظه‌ست؛ ربات بعداً با /build/status می‌پرسه و حسابداری رو انجام می‌ده.
const builds = new Map();          // "userId:name" → وضعیت ساخت
const BUILD_TTL_MS = 6 * 60 * 60_000;
const FIRST_STATIC = 20;           // تعداد اولیه‌ی createNewStickerSet
const FIRST_VIDEO = 5;
const MAX_PER_PACK = 120;

async function tgJson(method, obj) {
  let r;
  try {
    r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) { throw new TgErr(`network: ${e.message}`, false); }
  let j = null;
  try { j = await r.json(); } catch (_) { /* غیر JSON */ }
  if (!j?.ok) {
    const err = new TgErr(j?.description || `HTTP ${r.status}`, r.status >= 400 && r.status < 500 && r.status !== 429);
    err.code = j?.error_code ?? r.status;
    err.retryAfter = j?.parameters?.retry_after;
    throw err;
  }
  return j.result;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// فراخوانی تلگرام با تلاش مجدد برای ۴۲۹ و خطاهای شبکه
async function tgRetry(method, obj, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await tgJson(method, obj); }
    catch (e) {
      const wait = e.code === 429 ? Math.min(Number(e.retryAfter ?? 5), 60) * 1000 + 300 : (!e.permanent ? 2000 * (i + 1) : 0);
      if (!(e instanceof TgErr) || !wait || i >= tries - 1) throw e;
      await sleepMs(wait);
    }
  }
}

const notify = (chatId, text, extra = {}) => tgJson('sendMessage', { chat_id: chatId, text, ...extra }).catch((e) => console.warn('notify failed', e?.message));

function buildKey(userId, name) { return `${Number(userId)}:${String(name).toLowerCase()}`; }

async function runBuild(b) {
  try {
    // ۱) ثبت همه‌ی فایل‌ها برای تبدیل (فایل‌هایی که قبلاً ثبت شدن دوباره کار نمی‌شن)
    b.phase = 'preparing';
    const keyOf = (it) => `${b.userId}:${it.kind}:${it.file_id}`;
    for (const it of b.items) enqueueBg(it.file_id, it.kind, b.userId);
    const retries = new Map();
    while (true) {
      let pending = 0; let ready = 0;
      for (const it of b.items) {
        const j = bg.get(keyOf(it));
        if (j?.state === 'done') ready++;
        else if (j?.state === 'failed') { /* نهایی */ }
        else if (j?.state === 'retry' || !j) {
          const n = (retries.get(keyOf(it)) ?? 0) + 1; retries.set(keyOf(it), n);
          if (n <= 4) { enqueueBg(it.file_id, it.kind, b.userId); pending++; }
        } else pending++;
      }
      b.ready = ready;
      if (!pending) break;
      await sleepMs(2000);
    }

    const okItems = []; const bad = [];
    for (const it of b.items) {
      const j = bg.get(keyOf(it));
      if (j?.state === 'done') okItems.push({ ...it, sticker: j.stickerFileId });
      else bad.push({ message_id: it.message_id, message: j?.message || 'تبدیل ناموفق بود.' });
    }
    b.failedItems = bad;
    if (!okItems.length) throw new BuildFail('all_failed', 'هیچ‌کدوم از فایل‌ها آماده نشد.');

    // ۲) ساخت پک (دسته‌ی کوچک)، یا ادامه‌ی پک نیمه‌کاره
    b.phase = 'creating';
    const input = (it) => ({ sticker: it.sticker, format: b.kind, emoji_list: b.emoji });
    let next = 0;
    const firstN = b.kind === 'video' ? FIRST_VIDEO : FIRST_STATIC;
    try {
      await tgRetry('createNewStickerSet', { user_id: b.userId, name: b.name, title: b.title, stickers: okItems.slice(0, firstN).map(input) });
      next = Math.min(firstN, okItems.length);
    } catch (e) {
      if (e instanceof TgErr && /occupied|already/i.test(e.message)) {
        if (!b.resume) throw new BuildFail('name_taken', 'این نام همین الان گرفته شد.');
        const set = await tgRetry('getStickerSet', { name: b.name });     // ادامه‌ی پک نیمه‌کاره
        next = Math.max(1, Math.min(set.stickers.length, okItems.length));
      } else throw e;
    }

    // ۳) اضافه کردن بقیه
    b.phase = 'adding';
    b.added = next;
    for (; next < okItems.length && next < MAX_PER_PACK; next++) {
      try {
        await tgRetry('addStickerToSet', { user_id: b.userId, name: b.name, sticker: input(okItems[next]) });
        b.added++;
      } catch (e) {
        if (e instanceof TgErr && /STICKERS_TOO_MUCH|too many/i.test(e.message)) break;
        if (e instanceof TgErr && e.permanent) { bad.push({ message_id: okItems[next].message_id, message: `تلگرام قبولش نکرد: ${e.message}` }); continue; }
        throw e;
      }
      await sleepMs(250);
    }

    // ۴) نتیجه
    const set = await tgRetry('getStickerSet', { name: b.name });
    b.stickerCount = set.stickers.length;
    b.staticCount = b.kind === 'static' ? b.stickerCount : 0;
    b.videoCount = b.kind === 'static' ? 0 : b.stickerCount;
    b.state = 'done'; b.phase = 'done'; b.at = Date.now();

    const link = `https://t.me/addstickers/${b.name}`;
    await notify(b.chatId, `🎉 پک «${b.title}» ساخته شد!\n\n${link}`, {
      reply_markup: { inline_keyboard: [[{ text: '📦 مشاهده و افزودن پک', url: link }]] },
    });
    for (const f of bad.slice(0, 10)) {
      if (!f.message_id) continue;
      await tgJson('setMessageReaction', { chat_id: b.chatId, message_id: f.message_id, reaction: [{ type: 'emoji', emoji: '👎' }] }).catch(() => {});
      await notify(b.chatId, `❌ این فایل توی پک نیومد: ${f.message}`, { reply_parameters: { message_id: f.message_id, allow_sending_without_reply: true } });
    }
    if (bad.length > 10) await notify(b.chatId, `و ${bad.length - 10} فایل دیگه هم اضافه نشد.`);
  } catch (e) {
    b.state = 'failed'; b.phase = 'failed'; b.at = Date.now();
    b.error = e instanceof BuildFail ? e.code : 'error';
    console.warn('build failed', b.userId, b.name, e?.message);
    const why = e instanceof BuildFail ? e.message : `خطای تلگرام: ${e?.message ?? ''}`;
    await notify(b.chatId, `❌ ساخت پک «${b.title}» ناموفق بود: ${why}\n\nاعتبارت برگردونده می‌شه. دوباره از ربات «ساخت پک جدید» رو بزن.`);
  }
}

class BuildFail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function startBuild(req) {
  const key = buildKey(req.user_id, req.name);
  for (const [k, b] of builds) if (b.state !== 'running' && Date.now() - (b.at ?? 0) > BUILD_TTL_MS) builds.delete(k);
  const old = builds.get(key);
  if (old && (old.state === 'running' || old.state === 'done')) return old;     // تکراری؛ همون کار قبلی
  const b = {
    state: 'running', phase: 'queued', userId: Number(req.user_id), chatId: Number(req.chat_id), name: String(req.name),
    title: String(req.title), emoji: req.emoji, kind: req.kind === 'video' ? 'video' : 'static', resume: Boolean(req.resume),
    items: req.items, ready: 0, added: 0, failedItems: [], at: Date.now(),
  };
  builds.set(key, b);
  runBuild(b).catch((e) => console.error('runBuild crashed', e));
  return b;
}

const buildView = (b) => (b
  ? { state: b.state, phase: b.phase, ready: b.ready, total: b.items.length, added: b.added, failed: b.failedItems.length, error: b.error,
      ...(b.state === 'done' ? { stickerCount: b.stickerCount, staticCount: b.staticCount, videoCount: b.videoCount } : {}) }
  : { state: 'missing' });

// ───────── نگه داشتن سرویس بیدار تا کار تموم بشه + پیام قبل از ری‌استارت ─────────
const SELF_URL = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const anyBusy = () => active > 0 || waiting.length > 0 || bgActive > 0 || bgWaiting.length > 0 || [...builds.values()].some((b) => b.state === 'running');
if (SELF_URL) {
  // Render رایگان بعد از ۱۵ دقیقه بدون درخواست ورودی می‌خوابه؛ تا وقتی کار داریم خودمون رو صدا می‌زنیم
  setInterval(() => { if (anyBusy()) fetch(`${SELF_URL}/health`).catch(() => {}); }, 8 * 60_000).unref();
}

let shuttingDown = false;
async function onShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const running = [...builds.values()].filter((b) => b.state === 'running');
  await Promise.allSettled(running.map((b) => notify(b.chatId,
    `⚠️ سرویس ساخت پک ری‌استارت شد و ساخت «${b.title}» نصفه موند.\nدکمه‌ی زیر رو بزن تا از همون‌جا ادامه بدم (چیزی که ساخته شده از بین نمی‌ره).`,
    { reply_markup: { inline_keyboard: [[{ text: '▶️ ادامه‌ی ساخت', callback_data: `build:resume:${b.name}` }]] } })));
  process.exit(0);
}
process.on('SIGTERM', onShutdown);
process.on('SIGINT', onShutdown);

// ───────── HTTP ─────────
const sha = (s) => createHash('sha256').update(s).digest();
function keyOk(given) {
  if (!API_KEY || !given) return false;
  return timingSafeEqual(sha(String(given)), sha(API_KEY));
}

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};
const fail = (res, code, status = 200) => json(res, status, { ok: false, error: code, message: E[code] || E.failed });

// بدنه رو می‌خونه؛ اگه از سقف بیشتر بود بقیه رو دور می‌ریزه (تا پاسخ JSON تمیز برگرده، نه قطع اتصال)
function readBody(req, max) {
  const HARD_CAP = 60 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > HARD_CAP) { req.destroy(); return; }
      if (over) return;
      if (n > max) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(new Fail('too_large', 413)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new Fail('too_large', 413)); });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(res, 200, { ok: true, service: 'monarch-media', active, queued: waiting.length, cached: jobs.size, tg: Boolean(BOT_TOKEN), bg: bgCounts(), builds: [...builds.values()].filter((b) => b.state === 'running').length, vp9: `${VP9_DEADLINE}/${VP9_CPU_USED}`, maxFps: MAX_FPS });
    }

    if (req.method === 'POST' && url.pathname === '/convert') {
      if (!keyOk(req.headers['x-api-key'])) return json(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' });

      const q = url.searchParams.get('kind');
      const kind = q in PROFILES ? q : 'static';
      const max = PROFILES[kind].video ? LIMITS.videoInputBytes : LIMITS.staticInputBytes;
      const bytes = await readBody(req, max);

      const result = await convertDeduped(bytes, kind);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && (url.pathname === '/enqueue' || url.pathname === '/status')) {
      if (!keyOk(req.headers['x-api-key'])) return json(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' });
      if (!BOT_TOKEN) return json(res, 200, { ok: false, error: 'no_token', message: 'BOT_TOKEN روی سرویس تنظیم نشده.' });
      const body = await readJson(req);
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const valid = (it) => it && typeof it.file_id === 'string' && it.file_id.length < 300 && (it.kind === 'static' || it.kind === 'video');
      if (url.pathname === '/enqueue') {
        const out = items.map((it) => (valid(it) ? view(enqueueBg(it.file_id, it.kind, Number(it.user_id))) : { state: 'failed', error: 'unsupported' }));
        return json(res, 200, { ok: true, items: out });
      }
      return json(res, 200, { ok: true, items: items.map((it) => (valid(it) ? view(bg.get(`${Number(it.user_id)}:${it.kind}:${it.file_id}`)) : { state: 'missing' })) });
    }

    if (req.method === 'POST' && (url.pathname === '/build' || url.pathname === '/build/status')) {
      if (!keyOk(req.headers['x-api-key'])) return json(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' });
      if (!BOT_TOKEN) return json(res, 200, { ok: false, error: 'no_token', message: 'BOT_TOKEN روی سرویس تنظیم نشده.' });
      const body = await readJson(req, 2_000_000);
      if (url.pathname === '/build/status') return json(res, 200, { ok: true, ...buildView(builds.get(buildKey(body.user_id, body.name))) });
      const items = Array.isArray(body.items) ? body.items.slice(0, MAX_PER_PACK) : [];
      const valid = Number.isInteger(Number(body.user_id)) && Number.isInteger(Number(body.chat_id)) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(body.name || ''))
        && body.title && Array.isArray(body.emoji) && body.emoji.length && items.length
        && items.every((it) => typeof it.file_id === 'string' && (it.kind === 'static' || it.kind === 'video'));
      if (!valid) return json(res, 200, { ok: false, error: 'bad_request', message: 'درخواست نامعتبر.' });
      return json(res, 200, { ok: true, ...buildView(startBuild({ ...body, items, kind: items[0].kind })) });
    }

    json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    if (e instanceof Fail) return fail(res, e.code, e.status);
    console.error('unexpected', e);
    if (!res.headersSent) fail(res, 'failed', 500);
  }
});

if (!API_KEY) console.warn('⚠️ MEDIA_KEY تنظیم نشده؛ همه‌ی درخواست‌های /convert رد می‌شن.');
server.listen(PORT, '0.0.0.0', () => console.log(`media service on :${PORT}`));
