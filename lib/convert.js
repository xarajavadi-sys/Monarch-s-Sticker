// تبدیل مدیا: ffprobe/ffmpeg، پروفایل‌های خروجی، صف و کش کارها
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { ALLOWED_FORMATS, LIMITS, MAX_CONCURRENT, MAX_FPS, MAX_QUEUE, STATIC_QUALITIES, VIDEO_STEPS, VP9_CPU_USED, VP9_DEADLINE } from './config.js';
import { Fail } from './errors.js';
import { run } from './util.js';

export async function probe(file) {
  const r = await run('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file',
    '-print_format', 'json', '-show_format', '-show_streams', file,
  ], 20_000);
  if (r.code !== 0) throw new Fail('unsupported');
  try { return JSON.parse(r.out); } catch { throw new Fail('unsupported'); }
}

export function parseRate(s) {
  if (!s || typeof s !== 'string') return 0;
  const [a, b] = s.split('/').map(Number);
  if (!a) return 0;
  return b ? a / b : a;
}

// اطلاعات لازم از خروجی ffprobe + اعتبارسنجی فرمت
export function inspect(info) {
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
export const decoderArgs = (m) =>
  m.isWebm && m.codec === 'vp9' ? ['-c:v', 'libvpx-vp9']
  : m.isWebm && m.codec === 'vp8' ? ['-c:v', 'libvpx']
  : [];

// پروفایل خروجی هر kind
//   thumb_*: آیکون پک؛ تلگرام اندازه‌ی دقیقاً ۱۰۰×۱۰۰ می‌خواد (با حاشیه‌ی شفاف)
export const PROFILES = {
  static:       { size: 512, pad: false, video: false, outBytes: LIMITS.staticOutBytes },
  video:        { size: 512, pad: false, video: true,  outBytes: LIMITS.videoOutBytes },
  thumb_static: { size: 100, pad: true,  video: false, outBytes: 128 * 1024 },
  thumb_video:  { size: 100, pad: true,  video: true,  outBytes: 30 * 1024 },   // سقف تلگرام ۳۲KB
};

export const scaleFilter = (p) =>
  `scale=${p.size}:${p.size}:force_original_aspect_ratio=decrease:force_divisible_by=2` +
  (p.pad ? `,format=yuva420p,pad=${p.size}:${p.size}:(ow-iw)/2:(oh-ih)/2:color=black@0` : '');

// ───────── استیکر ثابت ─────────
export async function makeStatic(input, dir, m, p) {
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
export async function makeVideo(input, dir, m, p, opts = {}) {
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
export async function outputInfo(file) {
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
export async function convert(bytes, kind, opts = {}) {
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
export let active = 0;
export const waiting = [];
export async function schedule(fn, { unbounded = false } = {}) {
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
export const JOB_TTL_MS = 30 * 60_000;
export const JOB_MAX = 150;
export const jobs = new Map();   // key → { promise, result, at }
export async function convertDeduped(bytes, kind, opts = {}) {
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
