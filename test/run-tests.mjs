// اجرا:  MEDIA_KEY=test node server.js &   سپس   node test/run-tests.mjs <samplesDir>
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const BASE = process.env.BASE || 'http://127.0.0.1:17860';
const KEY = process.env.MEDIA_KEY || 'test';
const dir = process.argv[2];

async function call(file, kind, key = KEY) {
  const bytes = await readFile(`${dir}/${file}`);
  const t = Date.now();
  const r = await fetch(`${BASE}/convert?kind=${kind}`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/octet-stream' }, body: bytes });
  const j = await r.json();
  return { status: r.status, j, ms: Date.now() - t };
}
function verify(j, ext) {
  const f = `/tmp/_out.${ext}`;
  return writeFile(f, Buffer.from(j.data, 'base64')).then(() => {
    const p = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f], { encoding: 'utf8' });
    const o = JSON.parse(p.stdout);
    const v = o.streams.find((s) => s.codec_type === 'video');
    return { codec: v.codec_name, w: v.width, h: v.height, audio: o.streams.some((s) => s.codec_type === 'audio'), dur: Number(o.format.duration || 0), pix: v.pix_fmt, alphaTag: v.tags?.alpha_mode ?? v.tags?.ALPHA_MODE };
  });
}
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('   ✗', m); } };

const cases = [
  ['big.png', 'static', 'ok'], ['small.jpg', 'static', 'ok'], ['alpha.png', 'static', 'ok'], ['noise.png', 'static', 'ok'],
  ['v_2.mp4', 'static', 'ok'], ['alpha.webm', 'static', 'ok'], ['g.gif', 'static', 'ok'],
  ['v_2.mp4', 'video', 'ok'], ['v_3.mp4', 'video', 'ok'], ['v_3.05.mp4', 'video', 'ok'], ['v_3.5.mp4', 'video', 'ok'], ['v_4.mp4', 'video', 'ok'],
  ['v_5.mp4', 'video', 'too_long'], ['v_60fps.mp4', 'video', 'ok'], ['g.gif', 'video', 'ok'], ['alpha.webm', 'video', 'ok'],
  ['big.png', 'thumb_static', 'ok'], ['alpha.png', 'thumb_static', 'ok'], ['v_3.mp4', 'thumb_video', 'ok'], ['g.gif', 'thumb_video', 'ok'], ['v_5.mp4', 'thumb_video', 'too_long'],
  ['v_noise.mp4', 'video', 'too_large'], ['v_noise_small.mp4', 'video', 'too_big_out'],
  ['garbage.bin', 'static', 'unsupported'], ['evil.m3u8', 'static', 'unsupported'], ['fake.tgs', 'static', 'tgs'],
];
for (const [file, kind, expect] of cases) {
  const { j, ms } = await call(file, kind);
  const res = j.ok ? 'ok' : j.error;
  let line = `${file.padEnd(14)} ${kind.padEnd(6)} → ${res.padEnd(11)} ${String(ms).padStart(5)}ms`;
  ok(res === expect, `expected ${expect} got ${res}`);
  if (j.ok) {
    const info = await verify(j, kind.endsWith('video') ? 'webm' : 'webp');
    line += `  ${info.codec} ${info.w}x${info.h} ${(j.size / 1024).toFixed(1)}KB dur=${info.dur.toFixed(2)} ${info.pix}${info.alphaTag ? ' alpha' : ''}`;
    if (kind.startsWith('thumb')) {
      ok(info.w === 100 && info.h === 100, `thumb must be 100x100 (${info.w}x${info.h})`);
      ok(j.size <= (kind === 'thumb_video' ? 32 : 128) * 1024, 'thumb size');
      if (kind === 'thumb_video') { ok(info.codec === 'vp9' && !info.audio && info.dur <= 3.001, 'thumb video spec'); }
    } else if (kind === 'static') {
      ok(Math.max(info.w, info.h) === 512 && info.w <= 512 && info.h <= 512, 'static must have max side 512');
      ok(j.size <= 512 * 1024, 'static ≤512KB');
    } else {
      ok(info.codec === 'vp9', 'vp9'); ok(!info.audio, 'no audio');
      ok(info.dur <= 3.001, `duration ≤3 (${info.dur})`);
      ok(Math.max(info.w, info.h) === 512, 'video max side 512');
      ok(j.size <= 254 * 1024, 'video ≤254KB');
    }
  } else if (res !== expect) line += ` ${j.message}`;
  console.log(line);
}
// امنیت
const bad = await call('big.png', 'static', 'wrong');
console.log('wrong key →', bad.status); ok(bad.status === 401, '401');
const nokey = await fetch(`${BASE}/convert`, { method: 'POST', body: 'x' }); ok(nokey.status === 401, 'no key 401');
console.log('health →', (await (await fetch(`${BASE}/health`)).json()).ok);
console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
process.exit(fails ? 1 : 0);
