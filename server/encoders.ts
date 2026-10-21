import { spawn } from 'node:child_process';

/** What this laptop can encode with. A graphics chip (NVIDIA, Intel or AMD) is many times faster than a CPU or a small server. */
export type EncInfo = { h264: string | null; hevc: string | null; av1: string | null; hw: boolean; gpu: string };

const run = (ff: string, args: string[], ms = 8000) => new Promise<{ ok: boolean; out: string }>((done) => {
  let out = '';
  const p = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const t = setTimeout(() => { p.kill(); done({ ok: false, out }); }, ms);
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('error', () => { clearTimeout(t); done({ ok: false, out }); });
  p.on('exit', (c) => { clearTimeout(t); done({ ok: c === 0, out }); });
});

const works = async (ff: string, enc: string) =>
  (await run(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=10:d=1', '-frames:v', '5', '-c:v', enc, '-f', 'null', '-'])).ok;

export async function detectEncoders(ff: string): Promise<EncInfo> {
  const list = (await run(ff, ['-hide_banner', '-encoders'], 10000)).out;
  const has = (n: string) => new RegExp(`\\s${n}\\s`).test(list);
  const pick = async (codec: 'h264' | 'hevc' | 'av1', soft: string[]) => {
    for (const hw of ['nvenc', 'qsv', 'amf']) { const n = `${codec}_${hw}`; if (has(n) && (await works(ff, n))) return n; }
    for (const n of soft) if (has(n)) return n;
    return null;
  };
  const h264 = await pick('h264', ['libx264']);
  const hevc = await pick('hevc', ['libx265']);
  const av1 = await pick('av1', ['libsvtav1']);
  const hwName = [h264, hevc].find((x) => x && /_(nvenc|qsv|amf)$/.test(x)) ?? '';
  return { h264, hevc, av1, hw: !!hwName, gpu: hwName.endsWith('nvenc') ? 'NVIDIA' : hwName.endsWith('qsv') ? 'Intel' : hwName.endsWith('amf') ? 'AMD' : '' };
}

export type Speed = 'fast' | 'balanced' | 'small';

/** ffmpeg video arguments for one encoder at the chosen speed. */
export function videoArgs(enc: string, speed: Speed, crf: number): string[] {
  const hevc = enc.startsWith('hevc') || enc === 'libx265';
  const tag = hevc ? ['-tag:v', 'hvc1'] : [];
  if (enc.endsWith('_nvenc')) return ['-c:v', enc, '-preset', { fast: 'p2', balanced: 'p4', small: 'p6' }[speed], '-rc', 'vbr', '-cq', String(crf), '-b:v', '0', '-pix_fmt', 'yuv420p', ...tag];
  if (enc.endsWith('_qsv')) return ['-c:v', enc, '-preset', { fast: 'veryfast', balanced: 'medium', small: 'slow' }[speed], '-global_quality', String(crf), ...tag];
  if (enc.endsWith('_amf')) return ['-c:v', enc, '-quality', { fast: 'speed', balanced: 'balanced', small: 'quality' }[speed], '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-qp_b', String(crf), '-pix_fmt', 'yuv420p', ...tag];
  if (enc === 'libx264') return ['-c:v', enc, '-preset', { fast: 'superfast', balanced: 'veryfast', small: 'medium' }[speed], '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-threads', '0'];
  if (enc === 'libx265') return ['-c:v', enc, '-preset', { fast: 'superfast', balanced: 'veryfast', small: 'medium' }[speed], '-crf', String(crf), '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', ...tag];
  return ['-c:v', enc, '-preset', { fast: '10', balanced: '8', small: '6' }[speed], '-crf', String(crf), '-pix_fmt', 'yuv420p']; // libsvtav1
}