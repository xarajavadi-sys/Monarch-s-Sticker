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

const LIMITS = {
  staticInputBytes: 20 * 1024 * 1024,   // سقف دانلود تلگرام برای ربات
  videoInputBytes: 5 * 1024 * 1024,     // طبق قوانین پک: ورودی ویدیو حداکثر ۵ مگابایت
  staticOutBytes: 512 * 1024,           // سقف تلگرام برای استیکر ثابت
  videoOutBytes: 254 * 1024,            // سقف تلگرام ۲۵۶KB؛ کمی کمتر برای اطمینان
  videoMaxInputSec: 4,                  // بیشتر از این رد می‌شه
  videoOutSec: 3,                       // سقف تلگرام برای استیکر ویدیویی
  ffmpegTimeoutMs: 90_000,
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
async function makeVideo(input, dir, m, p) {
  const d = m.duration;
  if (d > LIMITS.videoMaxInputSec + 0.05) throw new Fail('too_long');

  const needsTrim = d > LIMITS.videoOutSec;
  const speedUp = d > 3.1;                       // ۳.۱ تا ۴
  const pixFmt = p.pad || m.isWebm || m.codec === 'gif' ? 'yuva420p' : 'yuv420p';
  const out = join(dir, 'out.webm');

  const outSec = Math.min(d, LIMITS.videoOutSec) || 1;
  // ۹۰٪ سقف حجم (جا برای container و نوسان VBR) تقسیم بر مدت = بیت‌ریت هدف
  const budgetBps = Math.floor((p.outBytes * 8 * 0.9) / outSec);

  for (const step of VIDEO_STEPS) {
    const bps = Math.max(40_000, Math.floor(budgetBps * step.br));
    const filters = [];
    if (speedUp) filters.push(`setpts=PTS*${(LIMITS.videoOutSec / d).toFixed(6)}`);
    const fps = Math.min(m.fps, step.fps, 30);
    if (fps < m.fps - 0.01) filters.push(`fps=${fps}`);
    filters.push(scaleFilter(p), `format=${pixFmt}`);

    const args = [
      '-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file',
      ...decoderArgs(m), '-i', input,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', filters.join(','),
      ...(needsTrim ? ['-t', String(LIMITS.videoOutSec)] : []),
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

// ───────── کش و هم‌پوشانی کارها ─────────
// ربات سرورلس مهلت کوتاهی داره و ممکنه وسط انتظار قطع بشه؛ بعداً همون فایل رو دوباره می‌فرسته.
// پس نتیجه‌ی هر فایل (بر اساس هش محتوا) چند دقیقه نگه داشته می‌شه و درخواست تکراری به همون کار وصل می‌شه.
const JOB_TTL_MS = 30 * 60_000;
const JOB_MAX = 150;
const jobs = new Map();   // key → { promise, result, at }
async function convertDeduped(bytes, kind) {
  const key = createHash('sha256').update(kind).update(bytes).digest('hex');
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
  job.promise = schedule(() => convert(bytes, kind)).then(
    (r) => { job.result = r; job.at = Date.now(); return r; },
    (e) => { jobs.delete(key); throw e; },     // busy و خطاهای گذرا کش نمی‌شن
  );
  jobs.set(key, job);
  return job.promise;
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
      return json(res, 200, { ok: true, service: 'monarch-media', active, queued: waiting.length, cached: jobs.size });
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

    json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    if (e instanceof Fail) return fail(res, e.code, e.status);
    console.error('unexpected', e);
    if (!res.headersSent) fail(res, 'failed', 500);
  }
});

if (!API_KEY) console.warn('⚠️ MEDIA_KEY تنظیم نشده؛ همه‌ی درخواست‌های /convert رد می‌شن.');
server.listen(PORT, '0.0.0.0', () => console.log(`media service on :${PORT}`));
