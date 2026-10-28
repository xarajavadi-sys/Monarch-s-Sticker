// ساخت کامل پک سمت سرویس + نوار پیشرفت
import { BuildFail, TgErr } from './errors.js';
import { sleepMs } from './util.js';
import { T, num, normLang } from './texts.js';
import { notify, notifyAdmins, tgJson, tgRetry } from './telegram.js';
import { bg, enqueueBg } from './background.js';

// ───────── ساخت کامل پک سمت سرویس ─────────
// ربات فقط درخواست ساخت می‌فرسته؛ سرویس فایل‌ها رو آماده می‌کنه، پک رو می‌سازه و لینک رو مستقیم برای کاربر می‌فرسته
// (کاربر لازم نیست منتظر بمونه). وضعیت توی حافظه‌ست؛ ربات بعداً با /build/status می‌پرسه و حسابداری رو انجام می‌ده.
export const builds = new Map();          // "userId:name" → وضعیت ساخت
export const BUILD_TTL_MS = 6 * 60 * 60_000;
export const FIRST_STATIC = 20;           // تعداد اولیه‌ی createNewStickerSet
export const FIRST_VIDEO = 5;
export const MAX_PER_PACK = 120;

export function buildKey(userId, name) { return `${Number(userId)}:${String(name).toLowerCase()}`; }

// ───── نوار پیشرفت (یک پیام که سرویس خودش ویرایشش می‌کنه) ─────
export const PREP_WEIGHT = 0.85;                       // سهم آماده‌سازی فایل‌ها از کل کار؛ بقیه افزودن به پک

export function buildPercent(b) {
  const n = Math.max(1, b.items.length);
  const prep = Math.min(1, (b.ready + (b.failedCount ?? 0)) / n);
  const add = b.phase === 'adding' || b.phase === 'done' ? Math.min(1, b.added / Math.max(1, b.addTotal || n)) : 0;
  if (b.phase === 'done') return 100;
  return Math.min(99, Math.round((PREP_WEIGHT * prep + (1 - PREP_WEIGHT) * add) * 100));
}

// جایگاه ساخت در بین ساخت‌های در جریان (به ترتیب شروع)؛ فقط وقتی بیشتر از یک ساخت باشه معنی داره
export function queueInfo(b) {
  const running = [...builds.values()].filter((x) => x.state === 'running').sort((a, c) => a.startedAt - c.startedAt);
  return { queuePos: Math.max(1, running.indexOf(b) + 1), queueTotal: running.length };
}

export function buildEta(b) {
  const p = buildPercent(b) / 100;
  const el = (Date.now() - b.startedAt) / 1000;
  if (p < 0.05 || el < 15) return null;
  return Math.round(el * (1 - p) / p);
}

export const etaText = (sec, lang = 'fa') => {
  if (sec == null) return T(lang, 'eta_calc');
  if (sec < 45) return T(lang, 'eta_lt_min');
  const m = Math.round(sec / 60);
  return m >= 60 ? T(lang, 'eta_hours', num(lang, Math.round(m / 6) / 10)) : T(lang, 'eta_min', num(lang, m));
};

export const bar = (pct, cells = 12) => {
  const full = Math.round((pct / 100) * cells);
  return '▰'.repeat(full) + '▱'.repeat(cells - full);
};

export function progressMessage(b) {
  const L = b.lang;
  const pct = b.state === 'done' ? 100 : buildPercent(b);
  const q = queueInfo(b);
  const queueLine = b.state === 'running' && q.queueTotal > 1 ? T(L, 'queue', num(L, q.queuePos), num(L, q.queueTotal), q.queuePos === 1) : '';
  const phase = b.phase === 'adding' ? T(L, 'ph_adding', num(L, b.added), num(L, b.addTotal || b.items.length))
    : b.phase === 'creating' ? T(L, 'ph_creating')
    : T(L, 'ph_prepare', num(L, b.ready), num(L, b.items.length));
  return T(L, 'progress', b.title, bar(pct), num(L, pct), phase, queueLine, etaText(buildEta(b), L));
}

export async function touchProgress(b, force = false) {
  const now = Date.now();
  if (!force && now - (b.progAt ?? 0) < 3500) return;
  const text = progressMessage(b);
  if (text === b.progText) return;
  b.progAt = now;
  if (!b.progId) {
    b.progText = text;
    const m = await tgJson('sendMessage', { chat_id: b.chatId, text }).catch((e) => { console.warn('progress send failed', e?.message); return null; });
    b.progId = m?.message_id ?? null;
    return;
  }
  b.progText = text;
  await tgJson('editMessageText', { chat_id: b.chatId, message_id: b.progId, text })
    .catch((e) => { if (!/not modified/i.test(e?.message ?? '')) console.warn('progress edit failed', e?.message); });
}

export async function endProgress(b, text) {
  if (b.progId) {
    const ok = await tgJson('editMessageText', { chat_id: b.chatId, message_id: b.progId, text }).then(() => true).catch(() => false);
    if (ok) return;
  }
  await notify(b.chatId, text);
}

export const ITEM_KIND = (it) => (it.kind === 'video' ? 'video' : 'static');

// آپلود تازه‌ی یک فایل (کش قبلی رو دور می‌ریزه)
async function refreshItem(b, it) {
  const key = `${b.userId}:${ITEM_KIND(it)}:${it.file_id}`;
  bg.delete(key);
  enqueueBg(it.file_id, ITEM_KIND(it), b.userId, b.lang);
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const j = bg.get(key);
    if (j?.state === 'done') return j.stickerFileId;
    if (j?.state === 'failed') return null;
    if (!j || j.state === 'retry') enqueueBg(it.file_id, ITEM_KIND(it), b.userId, b.lang);
    await sleepMs(1500);
  }
  return null;
}

export async function runBuild(b) {
  try {
    // ادامه‌ی ساختی که قبلاً کامل شده (سرویس خوابیده بود و حافظه‌ش پاک شده): بدون تبدیل دوباره، همین‌جا تموم
    if (b.resume) {
      const set = await tgJson('getStickerSet', { name: b.name }).catch(() => null);
      if (set && set.stickers.length >= Math.min(b.items.length, MAX_PER_PACK)) {
        b.stickerCount = set.stickers.length;
        b.videoCount = set.stickers.filter((x) => x.is_video).length;
        b.staticCount = b.stickerCount - b.videoCount;
        b.phase = 'done'; b.state = 'done'; b.noop = true; b.at = Date.now();
        return;
      }
    }
    // حالت direct (بازسازی پک): فایل‌ها از قبل استیکر آماده‌ی تلگرامن؛ تبدیل/آپلودی لازم نیست
    const direct = b.items.every((it) => it.direct);
    let okItems = []; let bad = [];
    if (direct) {
      b.ready = b.items.length;
      okItems = b.items.map((it) => ({ ...it, kind: ITEM_KIND(it), sticker: it.file_id }));
      b.failedItems = bad;
      b.addTotal = okItems.length;
    } else {
    // ۱) ثبت همه‌ی فایل‌ها برای تبدیل (فایل‌هایی که قبلاً ثبت شدن دوباره کار نمی‌شن)
    b.phase = 'preparing';
    await touchProgress(b, true);
    const keyOf = (it) => `${b.userId}:${ITEM_KIND(it)}:${it.file_id}`;
    for (const it of b.items) enqueueBg(it.file_id, ITEM_KIND(it), b.userId, b.lang);
    const retries = new Map(); const lastErrs = new Map();
    while (true) {
      if (b.cancelled) throw new BuildFail('cancelled', T(b.lang, 'cancelled'));
      let pending = 0; let ready = 0; let failedN = 0;
      for (const it of b.items) {
        const j = bg.get(keyOf(it));
        if (j?.state === 'done') ready++;
        else if (j?.state === 'failed') failedN++;
        else if (j?.state === 'retry' || !j) {
          const n = (retries.get(keyOf(it)) ?? 0) + 1; retries.set(keyOf(it), n);
          if (n <= 4) { if (n > 1) await sleepMs(1500 * n); enqueueBg(it.file_id, ITEM_KIND(it), b.userId, b.lang); pending++; } else { failedN++; if (j?.lastError) lastErrs.set(keyOf(it), j.lastError); }
        } else pending++;
      }
      b.ready = ready; b.failedCount = failedN;
      await touchProgress(b);
      if (!pending) break;
      await sleepMs(2000);
    }

    okItems = []; bad = [];
    for (const it of b.items) {
      const j = bg.get(keyOf(it));
      if (j?.state === 'done') okItems.push({ ...it, kind: ITEM_KIND(it), sticker: j.stickerFileId });
      else bad.push({ message_id: it.message_id, message: j?.message || T(b.lang, 'convert_failed', j?.lastError || lastErrs.get(keyOf(it))) });
    }
    b.failedItems = bad;
    if (!okItems.length) throw new BuildFail('all_failed', T(b.lang, 'all_failed'));
    b.addTotal = okItems.length;

    }

    // ۲) ساخت پک (دسته‌ی کوچک)، یا ادامه‌ی پک نیمه‌کاره
    b.phase = 'creating';
    await touchProgress(b, true);
    const input = (it) => ({ sticker: it.sticker, format: it.kind, emoji_list: (Array.isArray(it.emoji) && it.emoji.length ? it.emoji : b.emoji) });
    let next = 0;
    const firstN = okItems.slice(0, FIRST_STATIC).some((it) => it.kind === 'video') ? FIRST_VIDEO : FIRST_STATIC;
    let existed = false;
    try {
      await tgRetry('createNewStickerSet', { user_id: b.userId, name: b.name, title: b.title, stickers: okItems.slice(0, firstN).map(input) });
      next = Math.min(firstN, okItems.length);
    } catch (e) {
      if (e instanceof TgErr && /occupied|occupy|already|NAME_INVALID.*taken/i.test(e.message)) {
        if (!b.resume) throw new BuildFail('name_taken', T(b.lang, 'name_taken'));
        const set = await tgRetry('getStickerSet', { name: b.name });     // ادامه‌ی پک نیمه‌کاره
        next = Math.max(1, Math.min(set.stickers.length, okItems.length));
        existed = true;
      } else if (e instanceof TgErr && e.permanent && !direct) {
        // احتمالاً فایل کش‌شده‌ی قبلی مصرف/منقضی شده: همه‌ی دسته‌ی اول رو تازه آپلود و یک بار دوباره امتحان
        for (const it of okItems.slice(0, firstN)) { const f = await refreshItem(b, it).catch(() => null); if (f) it.sticker = f; it.refreshed = true; }
        await tgRetry('createNewStickerSet', { user_id: b.userId, name: b.name, title: b.title, stickers: okItems.slice(0, firstN).map(input) });
        next = Math.min(firstN, okItems.length);
      } else throw e;
    }
    const startNext = next;

    // ۳) اضافه کردن بقیه
    b.phase = 'adding';
    b.added = next;
    await touchProgress(b, true);
    for (; next < okItems.length && next < MAX_PER_PACK; next++) {
      if (b.cancelled) throw new BuildFail('cancelled', T(b.lang, 'cancelled'));
      try {
        await tgRetry('addStickerToSet', { user_id: b.userId, name: b.name, sticker: input(okItems[next]) });
        b.added++;
      } catch (e) {
        if (e instanceof TgErr && /STICKERS_TOO_MUCH|too many/i.test(e.message)) break;
        if (e instanceof TgErr && e.permanent) {
          // شاید فایل استیکرِ کش‌شده‌ی قبلی منقضی/مصرف شده؛ یک بار دوباره تبدیل و آپلود تازه می‌کنیم
          const it = okItems[next];
          if (!it.direct && !it.refreshed) {
            it.refreshed = true;
            const fresh = await refreshItem(b, it).catch(() => null);
            if (fresh) {
              try {
                await tgRetry('addStickerToSet', { user_id: b.userId, name: b.name, sticker: input({ ...it, sticker: fresh }) });
                b.added++;
                await touchProgress(b); await sleepMs(250);
                continue;
              } catch (e2) { e = e2; }
            }
          }
          bad.push({ message_id: it.message_id, message: T(b.lang, 'tg_rejected', e.message) });
          continue;
        }
        throw e;
      }
      await touchProgress(b);
      await sleepMs(250);
    }

    // ۴) نتیجه
    const set = await tgRetry('getStickerSet', { name: b.name });
    b.stickerCount = set.stickers.length;
    b.videoCount = set.stickers.filter((s) => s.is_video).length;
    b.staticCount = b.stickerCount - b.videoCount;
    b.phase = 'done'; b.state = 'done'; b.at = Date.now();
    if (!direct) for (const it of b.items) bg.delete(`${b.userId}:${ITEM_KIND(it)}:${it.file_id}`);   // فایل آپلودشده یک‌بارمصرفه؛ دفعه‌ی بعد تازه ساخته بشه
    b.noop = Boolean(b.resume && existed && (startNext >= okItems.length || b.added === startNext));     // قبلاً کامل شده بود؛ دوباره پیام نمی‌دیم

    if (!b.noop) {
      const link = `https://t.me/addstickers/${b.name}`;
      await endProgress(b, T(b.lang, 'done_progress', b.title));
      await notify(b.chatId, T(b.lang, 'done_msg', b.title, link), {
        reply_markup: { inline_keyboard: [[{ text: T(b.lang, 'open_btn'), url: link }]] },
      });
      for (const f of bad.slice(0, 10)) {
        if (!f.message_id) continue;
        await tgJson('setMessageReaction', { chat_id: b.chatId, message_id: f.message_id, reaction: [{ type: 'emoji', emoji: '👎' }] }).catch(() => {});
        await notify(b.chatId, T(b.lang, 'file_skipped', f.message), { reply_parameters: { message_id: f.message_id, allow_sending_without_reply: true } });
      }
      if (bad.length > 10) await notify(b.chatId, T(b.lang, 'more_skipped', num(b.lang, bad.length - 10)));
    } else if (b.progId) {
      await tgJson('deleteMessage', { chat_id: b.chatId, message_id: b.progId }).catch(() => {});
    }
  } catch (e) {
    b.state = 'failed'; b.phase = 'failed'; b.at = Date.now();
    b.error = e instanceof BuildFail ? e.code : 'error';
    console.warn('build failed', b.userId, b.name, e?.message);
    if (b.error === 'cancelled') { await endProgress(b, T(b.lang, 'cancelled_progress', b.title)); return; }
    const why = e instanceof BuildFail ? e.message : T(b.lang, 'tg_error', e?.message ?? '');
    b.errorMessage = why;
    await notifyAdmins(`❌ ساخت ناموفق\n«${b.title}» — کاربر ${b.userId}\nدلیل: ${why}`);
    await endProgress(b, T(b.lang, 'build_failed', b.title, why));
  }
}

export function startBuild(req) {
  const key = buildKey(req.user_id, req.name);
  for (const [k, b] of builds) if (b.state !== 'running' && Date.now() - (b.at ?? 0) > BUILD_TTL_MS) builds.delete(k);
  const old = builds.get(key);
  if (old && (old.state === 'running' || (old.state === 'done' && req.resume))) return old;   // تکراری؛ همون کار قبلی
  if (old && old.state === 'done') builds.delete(key);                                        // پک جدید با همین نام (قبلی تموم شده)
  const b = {
    state: 'running', phase: 'queued', userId: Number(req.user_id), chatId: Number(req.chat_id), name: String(req.name),
    lang: normLang(req.lang), title: String(req.title), emoji: req.emoji, kind: ['video', 'mixed'].includes(req.kind) ? req.kind : 'static', resume: Boolean(req.resume),
    items: req.items, ready: 0, added: 0, addTotal: 0, failedItems: [], failedCount: 0, at: Date.now(), startedAt: Date.now(), cancelled: false,
  };
  builds.set(key, b);
  runBuild(b).catch((e) => console.error('runBuild crashed', e));
  return b;
}

export const buildView = (b) => (b
  ? { state: b.state, phase: b.phase, ready: b.ready, total: b.items.length, added: b.added, failed: b.failedItems.length, error: b.error,
      percent: b.state === 'done' ? 100 : buildPercent(b), eta: b.state === 'running' ? buildEta(b) : null, noop: Boolean(b.noop),
      ...(b.state === 'running' ? queueInfo(b) : {}), ...(b.state === 'failed' ? { message: b.errorMessage } : {}),
      ...(b.state === 'done' ? { stickerCount: b.stickerCount, staticCount: b.staticCount, videoCount: b.videoCount } : {}) }
  : { state: 'missing' });
