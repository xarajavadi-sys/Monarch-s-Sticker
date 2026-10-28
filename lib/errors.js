// خطاهای مشترک و متن‌های خطا
import { LIMITS } from './config.js';
import { T, num } from './texts.js';

const CODES = new Set(['too_large', 'unsupported', 'tgs', 'too_long', 'too_big_out', 'failed', 'busy']);
// متن خطا به زبان کاربر
export const errText = (lang, code) => (code === 'too_long' ? T(lang, 'too_long', num(lang, LIMITS.videoMaxInputSec)) : T(lang, CODES.has(code) ? code : 'failed'));

export class Fail extends Error {
  constructor(code, status = 200) { super(code); this.code = code; this.status = status; }
}

export class TgErr extends Error {
  constructor(msg, permanent) { super(msg); this.permanent = permanent; }
}

export class BuildFail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
