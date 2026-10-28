// ابزارهای HTTP: خواندن بدنه، پاسخ JSON، بررسی کلید
import { timingSafeEqual, createHash } from 'node:crypto';
import { API_KEY } from './config.js';
import { errText, Fail } from './errors.js';

export async function readJson(req, max = 1_000_000) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Fail('too_large', 413); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw new Fail('unsupported', 400); }
}


export const sha = (s) => createHash('sha256').update(s).digest();
export function keyOk(given) {
  if (!API_KEY || !given) return false;
  return timingSafeEqual(sha(String(given)), sha(API_KEY));
}

export const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};
export const fail = (res, code, status = 200, lang = 'fa') => json(res, status, { ok: false, error: code, message: errText(lang, code) });

// بدنه رو می‌خونه؛ اگه از سقف بیشتر بود بقیه رو دور می‌ریزه (تا پاسخ JSON تمیز برگرده، نه قطع اتصال)
export function readBody(req, max) {
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
