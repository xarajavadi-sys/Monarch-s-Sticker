// سرویس تبدیل مدیا برای Monarch Stickerbot
//   POST /convert?kind=static|video|thumb_static|thumb_video   (بدنه: بایت‌های خام فایل، هدر x-api-key)
//   GET  /health
// بدون هیچ وابستگی npm؛ فقط Node 18+ و ffmpeg/ffprobe.
//
// خروجی موفق:  { ok:true, kind, mime, width, height, duration, size, data:"<base64>" }
// خروجی خطا:   { ok:false, error:"<code>", message:"<متن فارسی>" }

//
// ساختار (هر بخش یک فایل در lib/):
//   config.js      تنظیمات و ثابت‌ها        errors.js   خطاها و متن‌هاشون    util.js  ابزارهای کوچک
//   convert.js     ffmpeg، پروفایل‌ها، صف و کش     telegram.js  فراخوانی Bot API
//   background.js  کارهای پس‌زمینه (دانلود ← تبدیل ← آپلود)     builds.js  ساخت کامل پک + نوار پیشرفت
//   http.js        بدنه/پاسخ/کلید            server.js (این فایل)  مسیرها، بیدار نگه داشتن، خاموشی

import http from 'node:http';
import { API_KEY, BOT_TOKEN, LIMITS, MAX_FPS, PORT, SELF_URL, VP9_CPU_USED, VP9_DEADLINE } from './lib/config.js';
import { Fail } from './lib/errors.js';
import { run } from './lib/util.js';
import { PROFILES, active, convert, convertDeduped, jobs, waiting } from './lib/convert.js';
import { notify } from './lib/telegram.js';
import { T, normLang } from './lib/texts.js';
import { bg, bgActive, bgCounts, bgWaiting, enqueueBg, view } from './lib/background.js';
import { fail, json, keyOk, readBody, readJson } from './lib/http.js';
import { MAX_PER_PACK, buildKey, buildView, builds, startBuild } from './lib/builds.js';

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
  await Promise.allSettled(running.map((b) => notify(b.chatId, T(b.lang, 'restarted', b.title),
    { reply_markup: { inline_keyboard: [[{ text: T(b.lang, 'resume_btn'), callback_data: `build:resume:${b.name}` }]] } })));
  process.exit(0);
}
process.on('SIGTERM', onShutdown);
process.on('SIGINT', onShutdown);

const server = http.createServer(async (req, res) => {
  let url = null;
  try {
    url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/') {
      const run = [...builds.values()].filter((b) => b.state === 'running');
      const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monarch Media</title>` +
        `<body style="font-family:system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.7">` +
        `<h2>🟢 Monarch Media</h2><p>ساخت‌های در جریان: <b>${run.length}</b><br>تبدیل فعال: <b>${active}</b> · صف: <b>${waiting.length}</b><br>` +
        `کارهای پس‌زمینه: <b>${bgActive}</b> فعال · <b>${bgWaiting.length}</b> در صف<br>BOT_TOKEN: <b>${BOT_TOKEN ? 'تنظیم شده' : 'تنظیم نشده ⚠️'}</b></p>` +
        `<p style="color:#888;font-size:.85rem">این صفحه فقط خلاصه‌ی وضعیت رو نشون می‌ده؛ جزئیات هر ساخت داخل ربات (پروفایل من) دیده می‌شه.</p></body>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'monarch-media', active, queued: waiting.length, cached: jobs.size, tg: Boolean(BOT_TOKEN), bg: bgCounts(), builds: [...builds.values()].filter((b) => b.state === 'running').length, vp9: `${VP9_DEADLINE}/${VP9_CPU_USED}`, maxFps: MAX_FPS });
    }

    if (req.method === 'POST' && url.pathname === '/convert') {
      if (!keyOk(req.headers['x-api-key'])) return json(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' });

      const q = url.searchParams.get('kind');
      const kind = q in PROFILES ? q : 'static';
      const max = PROFILES[kind].video ? LIMITS.videoInputBytes : LIMITS.staticInputBytes;
      const bytes = await readBody(req, max);

      const result = await convertDeduped(bytes, kind);   // خطاها با fail(res, code, status, lang) و زبان ?lang=
      return json(res, 200, result);
    }

    if (req.method === 'POST' && (url.pathname === '/enqueue' || url.pathname === '/status')) {
      if (!keyOk(req.headers['x-api-key'])) return json(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' });
      if (!BOT_TOKEN) return json(res, 200, { ok: false, error: 'no_token', message: T(normLang(url.searchParams.get('lang')), 'no_token') });
      const body = await readJson(req);
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const valid = (it) => it && typeof it.file_id === 'string' && it.file_id.length < 300 && (it.kind === 'static' || it.kind === 'video');
      if (url.pathname === '/enqueue') {
        const out = items.map((it) => (valid(it) ? view(enqueueBg(it.file_id, it.kind, Number(it.user_id), it.lang)) : { state: 'failed', error: 'unsupported' }));
        return json(res, 200, { ok: true, items: out });
      }
      return json(res, 200, { ok: true, items: items.map((it) => (valid(it) ? view(bg.get(`${Number(it.user_id)}:${it.kind}:${it.file_id}`)) : { state: 'missing' })) });
    }

    if (req.method === 'POST' && ['/build', '/build/status', '/build/cancel'].includes(url.pathname)) {
      if (!keyOk(req.headers['x-api-key'])) return json(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' });
      if (!BOT_TOKEN) return json(res, 200, { ok: false, error: 'no_token', message: T(normLang(url.searchParams.get('lang')), 'no_token') });
      const body = await readJson(req, 2_000_000);
      if (url.pathname === '/build/status') return json(res, 200, { ok: true, ...buildView(builds.get(buildKey(body.user_id, body.name))) });
      if (url.pathname === '/build/cancel') {
        const b = builds.get(buildKey(body.user_id, body.name));
        if (b && b.state === 'running') b.cancelled = true;
        return json(res, 200, { ok: true, cancelled: Boolean(b && b.state === 'running') });
      }
      const items = (Array.isArray(body.items) ? body.items.slice(0, MAX_PER_PACK) : []).map((it) => ({
        file_id: it?.file_id, kind: it?.kind, message_id: Number.isInteger(it?.message_id) ? it.message_id : undefined,
        direct: it?.direct === true,
        emoji: Array.isArray(it?.emoji) ? it.emoji.filter((e) => typeof e === 'string').slice(0, 20) : undefined,
      }));
      const valid = Number.isInteger(Number(body.user_id)) && Number.isInteger(Number(body.chat_id)) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(body.name || ''))
        && body.title && Array.isArray(body.emoji) && body.emoji.length && items.length
        && items.every((it) => typeof it.file_id === 'string' && (it.kind === 'static' || it.kind === 'video'));
      if (!valid) return json(res, 200, { ok: false, error: 'bad_request', message: T(normLang(body.lang), 'bad_request') });
      const kinds = new Set(items.map((it) => it.kind));
      return json(res, 200, { ok: true, ...buildView(startBuild({ ...body, items, kind: kinds.size > 1 ? 'mixed' : items[0].kind })) });
    }

    json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    if (e instanceof Fail) return fail(res, e.code, e.status, normLang(url?.searchParams?.get('lang')));
    console.error('unexpected', e);
    if (!res.headersSent) fail(res, 'failed', 500);
  }
});

if (!API_KEY) console.warn('⚠️ MEDIA_KEY تنظیم نشده؛ همه‌ی درخواست‌های /convert رد می‌شن.');
server.listen(PORT, '0.0.0.0', () => console.log(`media service on :${PORT}`));
