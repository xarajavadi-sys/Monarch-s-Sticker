// سرویس تبدیل مدیا برای Monarch Stickerbot
//   POST /convert?kind=static|video|thumb_static|thumb_video   (بدنه: بایت‌های خام فایل، هدر x-api-key)
//   POST /split?start=&end=&seg=&cuts=&crop=&cx=&cy=&from=&max=   (ویدیوی بلند ← چند استیکر ویدیویی ۳ثانیه‌ای)
//   POST /split/start  GET /split/status  GET /split/clip  POST /split/end   (همون برش، به‌صورت کار پس‌زمینه برای ربات)
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
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';

// ───────── تنظیمات ─────────
const PORT = Number(process.env.PORT || 10000);   // Render خودش PORT رو می‌ده
const API_KEY = process.env.MEDIA_KEY || '';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const MAX_QUEUE = 20;

const LIMITS = {
  staticInputBytes: 20 * 1024 * 1024,   // سقف دانلود تلگرام برای ربات
  videoInputBytes: 5 * 1024 * 1024,     // طبق قوانین پک: ورودی ویدیو حداکثر ۵ مگابایت
  staticOutBytes: 512 * 1024,           // سقف تلگرام برای استیکر ثابت
  videoOutBytes: 254 * 1024,            // سقف تلگرام ۲۵۶KB؛ کمی کمتر برای اطمینان
  videoMaxInputSec: 4,                  // بیشتر از این رد می‌شه
  videoOutSec: 3,                       // سقف تلگرام برای استیکر ویدیویی
  ffmpegTimeoutMs: 90_000,
  // برش ویدیوی بلند (/split)
  splitInputBytes: 20 * 1024 * 1024,    // سقف دانلود ربات از تلگرام
  splitMaxInputSec: 60 * 60,
  splitMaxPerCall: 8,                   // حداکثر تعداد کلیپ در هر درخواست (CPU ضعیف Render؛ بقیه با from=next)
  splitMinClipSec: 0.5,                 // تکه‌ی کوتاه‌تر از این دور ریخته می‌شه
};

// تلاش‌های فشرده‌سازی از کیفیت بالا به پایین
const STATIC_QUALITIES = [92, 85, 75, 65, 55, 45, 35, 25, 15];
// br = ضریبی از «بودجه‌ی بیت‌ریت» که از سقف حجم محاسبه می‌شه (کنترل حجم در همون پاس اول)
const VIDEO_STEPS = [
  { crf: 30, fps: 30, br: 1.0 },
  { crf: 36, fps: 30, br: 0.8 },
  { crf: 42, fps: 24, br: 0.6 },
  { crf: 48, fps: 20, br: 0.45 },
  { crf: 52, fps: 15, br: 0.35 },
  { crf: 58, fps: 12, br: 0.25 },
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
  bad_range:   'بازه‌ی زمانی نامعتبره (شروع/پایان/مدت هر تکه رو چک کن).',
  no_clips:    'توی این بازه تکه‌ای برای برش پیدا نشد.',
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
//  seg (اختیاری، برای /split): { start, dur, crop } ← فقط همین تکه از ویدیو برش می‌خوره
//    (دقیق: -ss بعد از -i)، و crop (فیلتر ffmpeg) قبل از scale اعمال می‌شه
async function makeVideo(input, dir, m, p, seg = null) {
  const d = seg ? seg.dur : m.duration;
  if (!seg && d > LIMITS.videoMaxInputSec + 0.05) throw new Fail('too_long');

  const needsTrim = d > LIMITS.videoOutSec;
  const speedUp = !seg && d > 3.1;               // ۳.۱ تا ۴
  const pixFmt = p.pad || m.isWebm || m.codec === 'gif' ? 'yuva420p' : 'yuv420p';
  const out = join(dir, seg ? `out_${seg.index}.webm` : 'out.webm');

  const outSec = Math.min(d, LIMITS.videoOutSec) || 1;
  // ۹۰٪ سقف حجم (جا برای container و نوسان VBR) تقسیم بر مدت = بیت‌ریت هدف
  const budgetBps = Math.floor((p.outBytes * 8 * 0.9) / outSec);

  for (const step of VIDEO_STEPS) {
    const bps = Math.max(40_000, Math.floor(budgetBps * step.br));
    const filters = [];
    if (seg?.crop) filters.push(seg.crop);
    if (speedUp) filters.push(`setpts=PTS*${(LIMITS.videoOutSec / d).toFixed(6)}`);
    const fps = Math.min(m.fps, step.fps, 30);
    if (fps < m.fps - 0.01) filters.push(`fps=${fps}`);
    filters.push(scaleFilter(p), `format=${pixFmt}`);

    const args = [
      '-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file',
      ...decoderArgs(m), '-i', input,
      ...(seg ? ['-ss', String(seg.start), '-t', String(seg.dur)] : []),
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', filters.join(','),
      ...(!seg && needsTrim ? ['-t', String(LIMITS.videoOutSec)] : []),
      '-c:v', 'libvpx-vp9', '-b:v', String(bps), '-maxrate', String(bps), '-crf', String(step.crf),
      '-pix_fmt', pixFmt, '-auto-alt-ref', '0',
      '-row-mt', '1', '-deadline', 'good', '-cpu-used', '5', '-threads', '2',
      '-f', 'webm', out,
    ];
    const r = await run('ffmpeg', args);
    if (r.code !== 0) throw new Fail('failed');
    const size = (await stat(out)).size;
    if (size <= p.outBytes) return { file: out, mime: 'video/webm' };
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
async function convert(bytes, kind) {
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

    const res = p.video ? await makeVideo(input, dir, m, p) : await makeStatic(input, dir, m, p);

    const buf = await readFile(res.file);
    const info = await outputInfo(res.file);
    return {
      ok: true,
      kind,
      mime: res.mime,
      width: info.width ?? null,
      height: info.height ?? null,
      duration: p.video ? Number((info.duration ?? 0).toFixed(2)) : 0,
      size: buf.length,
      data: buf.toString('base64'),
    };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ───────── برش ویدیوی بلند به تکه‌های استیکری (/split) ─────────
//  پارامترها (query):
//    start=0        شروع بازه (ثانیه یا mm:ss یا hh:mm:ss)
//    end=<آخر>      پایان بازه
//    seg=3          مدت هر تکه (ثانیه؛ حداکثر ۳)
//    cuts=0,3,7.5   نقطه‌های برش دلخواه (جایگزین seg؛ هر تکه > ۳ ثانیه به چند تکه‌ی seg شکسته می‌شه)
//    crop=center|left|right|top|bottom   ۱:۱ کردن؛ یا cx=0..1&cy=0..1 برای نقطه‌ی دلخواه
//                   (بدون crop و cx/cy → بدون برش تصویر، نسبت اصلی حفظ می‌شه)
//    from=0         از کدوم تکه شروع کن (برای صفحه‌بندی؛ پاسخ next می‌ده)
//    max=8          حداکثر تکه در این درخواست
//    limit=120      سقف کل تکه‌های برنامه (ربات: سقف هر پک)
function parseTime(v) {
  if (v == null || v === '') return null;
  const parts = String(v).trim().split(':').map(Number);
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) throw new Fail('bad_range');
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const CROP_PRESETS = { center: [0.5, 0.5], left: [0, 0.5], right: [1, 0.5], top: [0.5, 0], bottom: [0.5, 1] };

// فیلتر ffmpeg برای مربع کردن؛ ضلع = ضلع کوچک‌تر، موقعیت با ضریب 0..1 روی بُعدِ اضافه
function squareCrop(opts) {
  let fx = null, fy = null;
  if (opts.crop) {
    const pre = CROP_PRESETS[opts.crop];
    if (!pre) throw new Fail('bad_range');
    [fx, fy] = pre;
  }
  if (opts.cx != null || opts.cy != null) { fx = opts.cx ?? 0.5; fy = opts.cy ?? 0.5; }
  if (fx == null) return null;
  const c = (n) => Math.min(1, Math.max(0, n));
  return `crop=w=min(iw\\,ih):h=min(iw\\,ih):x=(iw-ow)*${c(fx).toFixed(4)}:y=(ih-oh)*${c(fy).toFixed(4)}`;
}

// لیست تکه‌ها [{start, dur}] از روی start/end و seg یا cuts
function planClips(total, o) {
  const A = Math.max(0, o.start ?? 0);
  const B = Math.min(total, o.end ?? total);
  if (!(B - A >= LIMITS.splitMinClipSec)) throw new Fail('bad_range');
  const seg = Math.min(LIMITS.videoOutSec, o.seg ?? LIMITS.videoOutSec);
  if (!(seg >= LIMITS.splitMinClipSec)) throw new Fail('bad_range');

  let spans;                                       // بازه‌های خام [from,to]
  if (o.cuts?.length) {
    const pts = [...new Set([A, ...o.cuts.filter((t) => t > A && t < B), B])].sort((a, b) => a - b);
    spans = pts.slice(0, -1).map((t, i) => [t, pts[i + 1]]);
  } else {
    spans = [[A, B]];
  }
  const clips = [];
  for (const [from, to] of spans) {
    for (let t = from; t < to - 1e-6; t += seg) {
      const dur = Math.min(seg, to - t);
      if (dur >= LIMITS.splitMinClipSec) clips.push({ start: Number(t.toFixed(3)), dur: Number(dur.toFixed(3)) });
    }
  }
  if (!clips.length) throw new Fail('no_clips');
  return o.limit > 0 ? clips.slice(0, o.limit) : clips;
}

// ورودی رو روی دیسک می‌ذاره، probe و برنامه‌ی برش رو حساب می‌کنه. dir تا cleanup دست‌نخورده می‌مونه.
async function prepareSplit(bytes, o) {
  if (bytes.length < 16) throw new Fail('unsupported');
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Fail('tgs');
  if (bytes.length > LIMITS.splitInputBytes) throw new Fail('too_large');

  const dir = await mkdtemp(join(tmpdir(), 'split-'));
  try {
    const input = join(dir, 'in.bin');
    await writeFile(input, bytes);
    const m = inspect(await probe(input));
    if (!m.duration || m.duration > LIMITS.splitMaxInputSec) throw new Fail('too_long');
    const crop = squareCrop(o);
    const plan = planClips(m.duration, o);
    return { dir, input, m, crop, plan };
  } catch (e) {
    rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function renderClip(ctx, idx) {
  const c = ctx.plan[idx];
  const res = await makeVideo(ctx.input, ctx.dir, ctx.m, PROFILES.video, { index: idx, start: c.start, dur: c.dur, crop: ctx.crop });
  const info = await outputInfo(res.file);
  return { file: res.file, start: c.start, end: Number((c.start + c.dur).toFixed(3)), width: info.width ?? null, height: info.height ?? null, duration: Number((info.duration ?? 0).toFixed(2)) };
}

const clipJson = async (idx, r) => {
  const buf = await readFile(r.file);
  return { index: idx, start: r.start, end: r.end, mime: 'video/webm', width: r.width, height: r.height, duration: r.duration, size: buf.length, data: buf.toString('base64') };
};

// نسخه‌ی هم‌زمان (برای تست و تکه‌های کم): from/max برای صفحه‌بندی
async function splitVideo(bytes, o) {
  const ctx = await prepareSplit(bytes, o);
  try {
    const from = Math.max(0, o.from ?? 0);
    const max = Math.min(LIMITS.splitMaxPerCall, Math.max(1, o.max ?? LIMITS.splitMaxPerCall));
    const idxs = ctx.plan.map((_, i) => i).slice(from, from + max);
    if (!idxs.length) throw new Fail('no_clips');
    const clips = [];
    for (const i of idxs) clips.push(await clipJson(i, await renderClip(ctx, i)));
    const next = from + idxs.length;
    return { ok: true, total: ctx.plan.length, from, next: next < ctx.plan.length ? next : null, source: { duration: Number(ctx.m.duration.toFixed(2)), width: ctx.m.width, height: ctx.m.height }, clips };
  } finally {
    rm(ctx.dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ───────── کار پس‌زمینه‌ی برش (برای ربات: هندلر سرورلس نمی‌تونه منتظر بمونه) ─────────
//  POST /split/start?...        ← بدنه: ویدیو. فوراً { job, total } می‌ده و تکه‌ها یکی‌یکی ساخته می‌شن
//  GET  /split/status?job=ID    ← { state: running|done|failed, total, ready, failed:[{index,message}] }
//  GET  /split/clip?job=ID&i=N  ← همون ساختار clips[] ( فقط تکه‌ی ready )
//  POST /split/end?job=ID       ← پاک‌سازی
//  حافظه: کار بعد از ۳۰ دقیقه بی‌استفاده پاک می‌شه. حداکثر MAX_JOBS کار هم‌زمان.
const JOBS = new Map();
const MAX_JOBS = 3;
const JOB_TTL_MS = 30 * 60 * 1000;

function dropJob(id) {
  const j = JOBS.get(id);
  if (!j) return;
  JOBS.delete(id);
  j.cancelled = true;
  rm(j.ctx.dir, { recursive: true, force: true }).catch(() => {});
}
setInterval(() => { for (const [id, j] of JOBS) if (Date.now() - j.touched > JOB_TTL_MS) dropJob(id); }, 60_000).unref();

async function startSplitJob(bytes, o) {
  if (JOBS.size >= MAX_JOBS) throw new Fail('busy', 503);
  const ctx = await prepareSplit(bytes, o);
  const id = randomBytes(12).toString('hex');
  const job = { ctx, results: [], failed: [], state: 'running', touched: Date.now(), cancelled: false };
  JOBS.set(id, job);

  (async () => {
    for (let i = 0; i < ctx.plan.length && !job.cancelled; i++) {
      try {
        job.results[i] = await schedule(() => renderClip(ctx, i));
      } catch (e) {
        job.results[i] = null;
        job.failed.push({ index: i, error: e instanceof Fail ? e.code : 'failed', message: E[e instanceof Fail ? e.code : 'failed'] ?? E.failed });
        if (!(e instanceof Fail)) console.error('split clip failed', e);
      }
    }
    if (!job.cancelled) job.state = 'done';
  })().catch((e) => { console.error('split job crashed', e); job.state = 'failed'; });

  return { ok: true, job: id, total: ctx.plan.length, source: { duration: Number(ctx.m.duration.toFixed(2)), width: ctx.m.width, height: ctx.m.height } };
}

function jobStatus(id) {
  const j = JOBS.get(id);
  if (!j) return { ok: false, error: 'missing', message: 'کار برش پیدا نشد (منقضی یا سرویس ری‌استارت شده).' };
  j.touched = Date.now();
  const doneIdx = j.results.map((r, i) => (r === undefined ? null : i)).filter((i) => i !== null);
  return { ok: true, state: j.state, total: j.ctx.plan.length, processed: doneIdx.length, ready: j.results.map((r, i) => (r ? i : null)).filter((i) => i !== null), failed: j.failed };
}

async function jobClip(id, i) {
  const j = JOBS.get(id);
  if (!j) return { ok: false, error: 'missing', message: 'کار برش پیدا نشد.' };
  j.touched = Date.now();
  const r = j.results[i];
  if (!r) return { ok: false, error: 'not_ready', message: 'این تکه هنوز آماده نیست.' };
  return { ok: true, clip: await clipJson(i, r) };
}

// ───────── صف ساده (حداکثر MAX_CONCURRENT کار هم‌زمان) ─────────
let active = 0;
const waiting = [];
async function schedule(fn) {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUE) throw new Fail('busy', 503);
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
      return json(res, 200, { ok: true, service: 'monarch-media', active, queued: waiting.length });
    }

    if (req.method === 'POST' && url.pathname === '/convert') {
      if (!keyOk(req.headers['x-api-key'])) return json(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' });

      const q = url.searchParams.get('kind');
      const kind = q in PROFILES ? q : 'static';
      const max = PROFILES[kind].video ? LIMITS.videoInputBytes : LIMITS.staticInputBytes;
      const bytes = await readBody(req, max);

      const result = await schedule(() => convert(bytes, kind));
      return json(res, 200, result);
    }

    if (url.pathname.startsWith('/split')) {
      if (!keyOk(req.headers['x-api-key'])) return json(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' });
      const g = (k) => url.searchParams.get(k);
      const num = (k) => { const v = g(k); if (v == null || v === '') return null; const n = Number(v); if (!Number.isFinite(n)) throw new Fail('bad_range'); return n; };
      const opts = () => ({
        start: parseTime(g('start')), end: parseTime(g('end')), seg: parseTime(g('seg')),
        cuts: g('cuts') ? g('cuts').split(',').map(parseTime) : null,
        crop: g('crop'), cx: num('cx'), cy: num('cy'), from: num('from'), max: num('max'), limit: num('limit'),
      });

      if (req.method === 'POST' && url.pathname === '/split') {
        const o = opts();
        const bytes = await readBody(req, LIMITS.splitInputBytes);
        return json(res, 200, await schedule(() => splitVideo(bytes, o)));
      }
      if (req.method === 'POST' && url.pathname === '/split/start') {
        const o = opts();
        const bytes = await readBody(req, LIMITS.splitInputBytes);
        return json(res, 200, await startSplitJob(bytes, o));
      }
      if (req.method === 'GET' && url.pathname === '/split/status') return json(res, 200, jobStatus(g('job')));
      if (req.method === 'GET' && url.pathname === '/split/clip') return json(res, 200, await jobClip(g('job'), Number(g('i'))));
      if (req.method === 'POST' && url.pathname === '/split/end') { dropJob(g('job')); return json(res, 200, { ok: true }); }
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
