import { spawn, ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

// ffmpeg on THIS machine (the laptop). Used only for offline files: probing, fixing audio, extracting subtitles.
export const bins = { ffmpeg: '', ffprobe: '' };

const unpacked = (p: string) => p.replace('app.asar' + (p.includes('\\') ? '\\' : '/'), 'app.asar.unpacked' + (p.includes('\\') ? '\\' : '/'));

export async function findBins(given?: { ffmpeg?: string; ffprobe?: string }) {
  const req = createRequire(import.meta.url);
  const tryPkg = (name: string, pick: (m: any) => string | undefined) => { try { const v = pick(req(name)); return v ? unpacked(v) : ''; } catch { return ''; } };
  const cands = {
    ffmpeg: [given?.ffmpeg, process.env.CINEMA_FFMPEG, tryPkg('ffmpeg-static', (m) => m), 'ffmpeg'],
    ffprobe: [given?.ffprobe, process.env.CINEMA_FFPROBE, tryPkg('ffprobe-static', (m) => m?.path), 'ffprobe'],
  };
  for (const k of ['ffmpeg', 'ffprobe'] as const) {
    bins[k] = '';
    for (const c of cands[k]) {
      if (c && (await works(c))) { bins[k] = c; break; }
    }
  }
}
const works = (bin: string) => new Promise<boolean>((ok) => {
  try {
    const c = spawn(bin, ['-version'], { stdio: 'ignore' });
    c.on('error', () => ok(false));
    c.on('close', (code) => ok(code === 0));
  } catch { ok(false); }
});

function run(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((ok, no) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    c.stdout.on('data', (d: Buffer) => out.push(d));
    c.stderr.on('data', (d: Buffer) => { err = (err + d).slice(-1500); });
    c.on('error', no);
    c.on('close', (code) => (code === 0 ? ok(Buffer.concat(out)) : no(new Error(err.trim() || `exit ${code}`))));
  });
}

export async function probeJson(file: string): Promise<any> {
  if (!bins.ffprobe) throw new Error('No local ffprobe');
  const raw = await run(bins.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', file]);
  return JSON.parse(raw.toString());
}

// Piped fragmented MP4: 'remux' keeps the video and converts the audio to AAC; 'audio' is audio only.
export function streamProc(file: string, mode: 'remux' | 'audio', t: number, a: number): ChildProcess {
  if (!bins.ffmpeg) throw new Error('No local ffmpeg');
  const args = ['-hide_banner', '-loglevel', 'error', ...(t ? ['-ss', String(t)] : []), '-i', file];
  if (mode === 'remux') args.push('-map', '0:v:0', '-map', `0:a:${a}?`, '-sn', '-dn', '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-avoid_negative_ts', 'make_zero');
  else args.push('-vn', '-map', `0:a:${a}?`, '-sn', '-dn', '-c:a', 'aac', '-ac', '2', '-b:a', '64k');
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return spawn(bins.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function subsVtt(file: string, n: number): Promise<string> {
  if (!bins.ffmpeg) throw new Error('No local ffmpeg');
  return (await run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:s:${n}`, '-f', 'webvtt', 'pipe:1'])).toString();
}

export async function thumbJpg(file: string, at: number): Promise<Buffer> {
  if (!bins.ffmpeg) throw new Error('No local ffmpeg');
  return run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, at)), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-f', 'mjpeg', 'pipe:1']);
}

// Subtitle file next to a video (.ass/.ssa/.srt/.vtt) as WebVTT.
export async function convertSub(file: string): Promise<string> {
  if (!bins.ffmpeg) throw new Error('No local ffmpeg');
  return (await run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'webvtt', 'pipe:1'])).toString();
}

// One JPEG sheet of small frames for the seek bar (key frames only, so it is quick).
export async function spriteJpg(file: string, interval: number, cols: number, rows: number, w: number, h: number): Promise<Buffer> {
  if (!bins.ffmpeg) throw new Error('No local ffmpeg');
  return run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-skip_frame', 'nokey', '-i', file, '-an', '-sn', '-dn',
    '-vf', `fps=1/${interval},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,tile=${cols}x${rows}`,
    '-frames:v', '1', '-q:v', '6', '-f', 'mjpeg', 'pipe:1']);
}