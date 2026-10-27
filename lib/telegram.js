// فراخوانی Bot API: دانلود فایل، آپلود استیکر، ارسال پیام، تلاش مجدد برای ۴۲۹
import { ADMIN_IDS, BOT_TOKEN, TG_API } from './config.js';
import { Fail, TgErr } from './errors.js';
import { sleepMs } from './util.js';

export async function tgCall(method, body) {
  let r;
  try {
    r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, { ...(body ? { method: 'POST', body } : {}), signal: AbortSignal.timeout(body ? 60_000 : 20_000) });
  } catch (e) { throw new TgErr(`network: ${e.message}`, false); }
  let j = null;
  try { j = await r.json(); } catch (_) { /* غیر JSON */ }
  if (!j?.ok) {
    const permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
    const err = new TgErr(j?.description || `HTTP ${r.status}`, permanent);
    err.code = j?.error_code ?? r.status;
    err.retryAfter = j?.parameters?.retry_after;
    throw err;
  }
  return j.result;
}

// فراخوانی با صبر برای ۴۲۹ (محدودیت سرعت تلگرام) و تلاش مجدد برای خطای شبکه/۵xx
async function tgCallRetry(method, makeBody, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await tgCall(method, makeBody?.()); }
    catch (e) {
      const wait = e.code === 429 ? Math.min(Number(e.retryAfter ?? 5), 60) * 1000 + 500 : (!e.permanent ? 1500 * (i + 1) : 0);
      if (!(e instanceof TgErr) || !wait || i >= tries - 1) throw e;
      await sleepMs(wait);
    }
  }
}

export async function tgDownload(fileId, maxBytes) {
  const info = await tgCallRetry(`getFile?file_id=${encodeURIComponent(fileId)}`);
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

export async function tgUploadSticker(userId, kind, bytes, mime) {
  return tgCallRetry('uploadStickerFile', () => {
    const form = new FormData();
    form.set('user_id', String(userId));
    form.set('sticker_format', kind === 'video' ? 'video' : 'static');
    form.set('sticker', new Blob([bytes], { type: mime }), kind === 'video' ? 'sticker.webm' : 'sticker.webp');
    return form;
  });
}

export async function tgJson(method, obj) {
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


// فراخوانی تلگرام با تلاش مجدد برای ۴۲۹ و خطاهای شبکه
export async function tgRetry(method, obj, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await tgJson(method, obj); }
    catch (e) {
      const wait = e.code === 429 ? Math.min(Number(e.retryAfter ?? 5), 60) * 1000 + 300 : (!e.permanent ? 2000 * (i + 1) : 0);
      if (!(e instanceof TgErr) || !wait || i >= tries - 1) throw e;
      await sleepMs(wait);
    }
  }
}

// مالک(ها) از متغیر محیطی ADMIN_IDS (آیدی‌های عددی با کاما)؛ اگه تنظیم نشده باشه چیزی فرستاده نمی‌شه
export const notifyAdmins = (text) => Promise.all(ADMIN_IDS.map((id) => tgJson('sendMessage', { chat_id: id, text }).catch(() => null)));

export const notify = (chatId, text, extra = {}) => tgJson('sendMessage', { chat_id: chatId, text, ...extra }).catch((e) => console.warn('notify failed', e?.message));
