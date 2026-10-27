// ابزارهای کوچک مشترک
import { spawn } from 'node:child_process';
import { LIMITS } from './config.js';

// ───────── ابزارها ─────────
export function run(cmd, args, timeoutMs = LIMITS.ffmpegTimeoutMs) {
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

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
export const faNum = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
