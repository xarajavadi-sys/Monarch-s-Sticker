// کارهای پس‌زمینه: دانلود از تلگرام ← تبدیل ← آپلود به‌عنوان فایل استیکر (با نوبت‌دهی عادلانه بین کاربرها)
import { LIMITS } from './config.js';
import { E, Fail, TgErr } from './errors.js';
import { PROFILES, convertDeduped } from './convert.js';
import { tgDownload, tgUploadSticker } from './telegram.js';

export const BG_TTL_MS = 6 * 60 * 60_000;
export const BG_MAX = 3000;
export const bg = new Map();   // "kind:file_id" → { state, userId, stickerFileId?, error?, message?, at }

export async function runBgJob(key, job, fileId, kind) {
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
    else { job.state = 'retry'; job.error = 'transient'; job.lastError = String(e?.message || e).slice(0, 120); console.warn('bg job transient', key, e?.message); }
  } finally {
    job.at = Date.now();
  }
}

// حداکثر چند کار پس‌زمینه هم‌زمان (هرکدوم ممکنه تا ۵ مگابایت توی حافظه نگه داره)؛ خود تبدیل جداگانه با schedule محدود می‌شه
export const BG_CONCURRENT = 4;
export let bgActive = 0;
export const bgWaiting = [];          // { userId, resolve }
export let bgLastUser = null;
// نوبت منصفانه: کاربری که ۱۲۰ فایل فرستاده نذاره بقیه معطل بمونن (به‌ترتیب بین کاربرها می‌چرخه)
export function bgPickNext() {
  if (!bgWaiting.length) return null;
  let i = bgWaiting.findIndex((w) => w.userId !== bgLastUser);
  if (i < 0) i = 0;
  const [w] = bgWaiting.splice(i, 1);
  bgLastUser = w.userId;
  return w;
}
export async function bgSchedule(userId, fn) {
  if (bgActive >= BG_CONCURRENT) await new Promise((resolve) => bgWaiting.push({ userId, resolve }));
  bgActive++;
  try { return await fn(); }
  finally { bgActive--; bgPickNext()?.resolve(); }
}

export function enqueueBg(fileId, kind, userId) {
  const key = `${userId}:${kind}:${fileId}`;          // کلید شامل کاربره: فایل آپلودشده فقط برای صاحبش معتبره
  const now = Date.now();
  for (const [k, j] of bg) if (j.state !== 'queued' && j.state !== 'running' && now - j.at > BG_TTL_MS) bg.delete(k);
  if (bg.size >= BG_MAX) for (const [k, j] of bg) { if (j.state === 'done' || j.state === 'failed') { bg.delete(k); if (bg.size < BG_MAX * 0.9) break; } }
  let job = bg.get(key);
  if (job && job.state === 'running' && now - (job.startedAt ?? now) > 4 * 60_000) job = null;   // گیرکرده؛ از نو
  if (job && (job.state === 'queued' || job.state === 'running' || job.state === 'done' || job.state === 'failed')) {
    return job;
  }
  job = { state: 'queued', userId, at: now, ...(job?.lastError ? { lastError: job.lastError } : {}) };
  bg.set(key, job);
  bgSchedule(userId, async () => { job.state = 'running'; job.startedAt = Date.now(); await runBgJob(key, job, fileId, kind); })
    .catch((e) => { job.state = 'retry'; job.error = String(e?.message || e); });
  return job;
}

export function bgCounts() {
  const c = { queued: 0, running: 0, done: 0, failed: 0, retry: 0 };
  for (const j of bg.values()) c[j.state] = (c[j.state] ?? 0) + 1;
  return c;
}

export const view = (j) => (j
  ? { state: j.state, ...(j.state === 'done' ? { sticker_file_id: j.stickerFileId } : {}), ...(j.state === 'failed' || j.state === 'retry' ? { error: j.error, message: j.message } : {}) }
  : { state: 'missing' });
