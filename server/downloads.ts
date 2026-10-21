import fs from 'node:fs';
import path from 'node:path';
import { posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Backend, runText, sh } from './backend';
import { EncInfo, Speed, videoArgs } from './encoders';

export const VIDEO = /\.(mp4|mkv|webm|mov|avi|m4v)$/i;

export type Opts = { loud?: boolean; dialogue?: boolean };
export type DlState = 'queued' | 'encoding' | 'downloading' | 'finalizing' | 'paused' | 'done' | 'error' | 'cancelled';
export type DlItem = {
  id: string; serverId: string; rootName: string; rel: string; remote: string; dest: string;
  name: string; size: number; done: number; speed: number; eta: number;
  state: DlState; error?: string; reason?: string; force?: boolean;
  profile: string; opts: Opts; encPct: number; created: number; finished?: number;
  rootId?: number | string; where?: 'laptop' | 'server';
};

export interface DlCtx {
  dataDir: string;
  settings(): { downloadDir: string; maxParallel: number; limitKBps: number; schedule: { on: boolean; from: string; to: string }; budgetGB: number; encodeWhere: 'auto' | 'laptop' | 'server'; encodeSpeed: Speed };
  /** Compression on this laptop: ffmpeg/ffprobe paths, what it can encode, and a URL that streams the original from the server. */
  localEnc(): { ffmpeg: string; ffprobe: string; enc: EncInfo } | null;
  loopback(job: DlItem): string;
  remoteHasFfmpeg(serverId: string): Promise<boolean>;
  backendFor(serverId: string): Promise<Backend>;
  addBytes(n: number): void;
  monthBytes(): number;
  /** Which profile an existing offline file was saved with (null = no such file). */
  profileOf(destRel: string): string | null;
  /** Saves thumbnail, preview sheet, subtitles and info next to the downloaded file. */
  pack(job: DlItem, B: Backend, original: string, final: string, destFull: string): Promise<void>;
}

// ---------- compression profiles ----------
const RES = [360, 480, 720, 1080];
const CRF: Record<string, Record<number, number>> = {
  h264: { 360: 28, 480: 27, 720: 26, 1080: 24 },
  hevc: { 360: 31, 480: 30, 720: 28, 1080: 26 },
  av1: { 360: 40, 480: 38, 720: 36, 1080: 34 },
};
export function parseProfile(p: string): { kind: 'orig' | 'fix' | 'enc'; codec?: string; h?: number } {
  if (p === 'orig') return { kind: 'orig' };
  if (p === 'fix') return { kind: 'fix' };
  const m = /^(h264|hevc|av1)-(\d+)$/.exec(p);
  if (m && RES.includes(Number(m[2]))) return { kind: 'enc', codec: m[1], h: Number(m[2]) };
  throw new Error('Unknown download profile');
}

function ffmpegArgs(profile: string, opts: Opts, src: string, out: string, channels: number, speed: Speed = 'fast'): string {
  const pr = parseProfile(profile);
  const af: string[] = [];
  const single = !!(opts.dialogue || opts.loud) && channels >= 2; // one audio track so the filter chain fits it
  if (opts.dialogue && channels >= 8) af.push('pan=stereo|c0=c0+1.4*c2+0.5*c4+0.5*c6|c1=c1+1.4*c2+0.5*c5+0.5*c7');
  else if (opts.dialogue && channels >= 6) af.push('pan=stereo|c0=c0+1.4*c2+0.6*c4|c1=c1+1.4*c2+0.6*c5');
  if (opts.loud) af.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  if (opts.dialogue || opts.loud) af.push('alimiter=limit=0.95');
  const audio = pr.kind === 'enc' && pr.h! <= 480 ? '64k' : pr.kind === 'enc' ? '96k' : '192k';
  const a = `-map ${single ? "'0:a:0?'" : "'0:a?'"} -c:a aac -ac 2 -b:a ${audio}${af.length ? ` -af ${sh(af.join(','))}` : ''}`;
  let v = '-c:v copy';
  if (pr.kind === 'enc') {
    const crf = CRF[pr.codec!][pr.h!];
    const scale = `-vf ${sh(`scale=-2:'min(ih,${pr.h})'`)}`;
    if (pr.codec === 'h264') v = `-c:v libx264 -preset ${speed === 'small' ? 'veryfast' : 'superfast'} -crf ${crf} -pix_fmt yuv420p -profile:v high ${scale} -threads 0`;
    else if (pr.codec === 'hevc') v = `-c:v libx265 -preset ${speed === 'small' ? 'veryfast' : 'superfast'} -crf ${crf} -pix_fmt yuv420p -tag:v hvc1 -x265-params log-level=error ${scale}`;
    else v = `-c:v libsvtav1 -preset 8 -crf ${crf} -pix_fmt yuv420p ${scale}`;
  }
  return `nice -n 5 ffmpeg -hide_banner -loglevel error -nostats -progress pipe:1 -y -i ${sh(src)} -map 0:v:0 ${v} ${a} -sn -dn -movflags +faststart -f mp4 ${sh(out)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\.\.+/g, '.').trim();

function inWindow(from: string, to: string) {
  const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const d = new Date(), now = d.getHours() * 60 + d.getMinutes(), a = mins(from), b = mins(to);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

type Live = { stop: (why: 'pause' | 'cancel' | 'hold') => void; why?: 'pause' | 'cancel' | 'hold' };

export class Downloads {
  private items: DlItem[] = [];
  private live = new Map<string, Live>();
  private file: string;
  private saveT?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;

  constructor(private ctx: DlCtx) {
    this.file = path.join(ctx.dataDir, 'queue.json');
    try {
      this.items = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const i of this.items) if (['encoding', 'downloading', 'finalizing'].includes(i.state)) { i.state = 'queued'; i.speed = 0; }
    } catch { /* first run */ }
    this.timer = setInterval(() => this.tick(), 1500);
    this.timer.unref();
  }

  list(): DlItem[] { return this.items; }
  private save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      try {
        const keep = this.items.filter((i) => i.state !== 'done' || Date.now() - (i.finished ?? 0) < 7 * 86400_000).slice(-300);
        this.items = keep;
        fs.mkdirSync(this.ctx.dataDir, { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(keep));
      } catch { /* ignore */ }
    }, 600);
  }
  flush() { clearTimeout(this.saveT); try { fs.writeFileSync(this.file, JSON.stringify(this.items)); } catch { /* ignore */ } }

  /** Adds files (folders are expanded). Returns how many were queued. */
  /** Every video under these paths (folders are opened), with sizes. */
  async expand(B: Backend, rootDir: string, rels: string[]): Promise<{ rel: string; size: number }[]> {
    const out: { rel: string; size: number }[] = [];
    const walk = async (rel: string, depth: number) => {
      const full = rel ? posix.join(rootDir, rel) : rootDir;
      const st = await B.stat(full);
      if (!st.isDir) { out.push({ rel, size: st.size }); return; }
      if (depth > 6) return;
      const list = (await B.list(full)).filter((f) => !f.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const f of list) {
        const r = rel ? `${rel}/${f.name}` : f.name;
        if (f.dir) await walk(r, depth + 1);
        else if (VIDEO.test(f.name)) out.push({ rel: r, size: f.size });
      }
    };
    for (const r of rels) await walk(r, 0);
    return out;
  }

  async add(o: { serverId: string; B: Backend; rootName: string; rootDir: string; rootId?: number | string; rels: string[]; profile: string; opts: Opts }): Promise<number> {
    parseProfile(o.profile);
    const out = await this.expand(o.B, o.rootDir, o.rels);

    const dl = this.ctx.settings().downloadDir;
    let n = 0;
    for (const f of out) {
      const profile = VIDEO.test(f.rel) ? o.profile : 'orig';
      let destRel = `${safe(o.rootName)}/${f.rel.split('/').map(safe).join('/')}`;
      if (profile !== 'orig') destRel = destRel.replace(/\.[^./]+$/, '') + '.mp4';
      const pl = profile === 'orig' ? 'original' : profile === 'fix' ? 'fixed audio' : `${profile.split('-')[1]}p ${profile.split('-')[0]}`;
      const sameFile = (rel: string) => {
        const full = path.join(dl, ...rel.split('/'));
        if (!fs.existsSync(full)) return false;
        return this.ctx.profileOf(rel) === profile && (profile !== 'orig' || fs.statSync(full).size === f.size);
      };
      // A different version of the same movie already sits at that name: keep both, tag the new one.
      if (fs.existsSync(path.join(dl, ...destRel.split('/'))) && !sameFile(destRel)) destRel = destRel.replace(/(\.[^./]+)$/, ` (${pl})$1`);
      if (this.items.some((i) => i.dest === destRel && !['done', 'error', 'cancelled'].includes(i.state))) continue; // already queued
      const already = sameFile(destRel);
      const item: DlItem = {
        id: randomBytes(6).toString('hex'), serverId: o.serverId, rootName: o.rootName, rel: f.rel,
        remote: posix.join(o.rootDir, f.rel), dest: destRel, name: posix.basename(f.rel),
        size: f.size, done: already ? f.size : 0, speed: 0, eta: 0, state: already ? 'done' : 'queued',
        profile, opts: o.opts, encPct: 0, created: Date.now(), rootId: o.rootId, finished: already ? Date.now() : undefined,
        reason: already ? 'Already on this laptop' : undefined,
      };
      this.items.push(item);
      n++;
    }
    this.save();
    this.tick();
    return n;
  }

  private get(id: string) { const i = this.items.find((x) => x.id === id); if (!i) throw new Error('Download not found'); return i; }
  pause(id: string) { const i = this.get(id); if (this.live.has(id)) this.live.get(id)!.stop('pause'); else if (i.state === 'queued') i.state = 'paused'; this.save(); }
  resume(id: string) { const i = this.get(id); if (['paused', 'error', 'cancelled'].includes(i.state)) { i.state = 'queued'; i.error = undefined; i.reason = undefined; this.save(); this.tick(); } }
  startNow(id: string) { const i = this.get(id); i.force = true; if (['paused', 'error', 'cancelled'].includes(i.state)) { i.state = 'queued'; i.error = undefined; } this.save(); this.tick(); }
  cancel(id: string) {
    const i = this.get(id);
    if (this.live.has(id)) this.live.get(id)!.stop('cancel');
    else { i.state = 'cancelled'; this.dropPart(i); }
    this.save();
  }
  remove(id: string) { try { this.cancel(id); } catch { /* ignore */ } this.items = this.items.filter((i) => i.id !== id); this.save(); }
  clearFinished() { this.items = this.items.filter((i) => !['done', 'cancelled', 'error'].includes(i.state)); this.save(); }
  pauseAll() { for (const i of this.items) if (['queued', 'encoding', 'downloading'].includes(i.state)) { try { this.pause(i.id); } catch { /* ignore */ } } }
  resumeAll() { for (const i of this.items) if (i.state === 'paused') i.state = 'queued'; this.save(); this.tick(); }
  private dropPart(i: DlItem) { try { fs.rmSync(path.join(this.ctx.settings().downloadDir, ...i.dest.split('/')) + '.part', { force: true }); } catch { /* ignore */ } }

  // ---------- scheduler ----------
  private holdReason(i: DlItem): string | null {
    if (i.force) return null;
    const s = this.ctx.settings();
    if (s.schedule.on && !inWindow(s.schedule.from, s.schedule.to)) return `Waiting for ${s.schedule.from}`;
    if (s.budgetGB > 0 && this.ctx.monthBytes() >= s.budgetGB * 1e9) return 'Monthly data budget reached';
    return null;
  }
  private tick() {
    const max = this.ctx.settings().maxParallel;
    for (const [id, l] of this.live) {
      const it = this.items.find((x) => x.id === id);
      if (it && this.holdReason(it)) l.stop('hold');
    }
    for (const i of this.items) {
      if (this.live.size >= max) break;
      if (i.state !== 'queued' || this.live.has(i.id)) continue;
      const hold = this.holdReason(i);
      i.reason = hold ?? undefined;
      if (hold) continue;
      this.run(i);
    }
  }

  private async run(job: DlItem) {
    let aborted = false;
    let killRemote: (() => void) | null = null;
    let readStream: { destroy: () => void } | null = null;
    const live: Live = {
      stop: (why) => { live.why = why; aborted = true; killRemote?.(); readStream?.destroy(); },
    };
    this.live.set(job.id, live);
    job.error = undefined; job.speed = 0;
    const settings = () => this.ctx.settings();
    const destFull = path.join(settings().downloadDir, ...job.dest.split('/'));
    const part = destFull + '.part';
    const tmpRemote = `/tmp/cinema-pack/${job.id}.mp4`;
    let B: Backend | null = null;
    let src = job.remote;
    try {
      B = await this.ctx.backendFor(job.serverId);
      fs.mkdirSync(path.dirname(destFull), { recursive: true });

      // ----- 1. compress or fix audio on the VPS (once), then download the smaller file -----
      const pr = parseProfile(job.profile);
      let localDone = false;
      if (pr.kind !== 'orig') {
        job.state = 'encoding'; job.encPct = 0; job.done = 0;
        // Where to compress: this laptop (graphics chip or CPU) is usually much faster than a small server, and works when the server has no ffmpeg.
        const le = this.ctx.localEnc();
        const where = settings().encodeWhere;
        const remoteOk = await this.ctx.remoteHasFfmpeg(job.serverId).catch(() => false);
        const wantCodec = pr.kind === 'enc' ? (le?.enc as any)?.[pr.codec!] : 'copy';
        const laptop = !!le && !!wantCodec && (where === 'laptop' || !remoteOk || (where === 'auto' && le.enc.hw));
        if (!laptop && !remoteOk) throw new Error('This video cannot be compressed: the server has no ffmpeg and this laptop cannot encode that format. Pick H.264, or download the original.');
        if (laptop) {
          job.where = 'laptop';
          fs.rmSync(part, { force: true });
          const url = this.ctx.loopback(job);
          const probeOut = await new Promise<string>((ok) => { let o = ''; const q = spawn(le!.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,channels', '-of', 'json', url], { stdio: ['ignore', 'pipe', 'ignore'] }); q.stdout.on('data', (d) => { o += d; }); q.on('close', () => ok(o)); q.on('error', () => ok('')); });
          let dur = 0, ch = 2;
          try { const j = JSON.parse(probeOut); dur = Number(j.format?.duration) || 0; ch = Number((j.streams ?? []).find((x: any) => x.codec_type === 'audio')?.channels) || 2; } catch { /* progress will be indeterminate */ }
          const speed = settings().encodeSpeed;
          const af: string[] = [];
          const single = !!(job.opts.dialogue || job.opts.loud) && ch >= 2;
          if (job.opts.dialogue && ch >= 8) af.push('pan=stereo|c0=c0+1.4*c2+0.5*c4+0.5*c6|c1=c1+1.4*c2+0.5*c5+0.5*c7');
          else if (job.opts.dialogue && ch >= 6) af.push('pan=stereo|c0=c0+1.4*c2+0.6*c4|c1=c1+1.4*c2+0.6*c5');
          if (job.opts.loud) af.push('loudnorm=I=-16:TP=-1.5:LRA=11');
          if (job.opts.dialogue || job.opts.loud) af.push('alimiter=limit=0.95');
          const ab = pr.kind === 'enc' && pr.h! <= 480 ? '64k' : pr.kind === 'enc' ? '96k' : '192k';
          const vid = pr.kind === 'enc'
            ? [...videoArgs(wantCodec, speed, CRF[pr.codec!][pr.h!]), '-vf', `scale=-2:'min(ih,${pr.h})'${wantCodec.endsWith('_qsv') ? ',format=nv12' : ''}`]
            : ['-c:v', 'copy'];
          const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', ...(pr.kind === 'enc' ? ['-hwaccel', 'auto'] : []), '-i', url,
            '-map', '0:v:0', ...vid, '-map', single ? '0:a:0?' : '0:a?', '-c:a', 'aac', '-ac', '2', '-b:a', ab, ...(af.length ? ['-af', af.join(',')] : []),
            '-sn', '-dn', '-movflags', '+faststart', '-f', 'mp4', part];
          const p = spawn(le!.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          killRemote = () => p.kill();
          let err = '', buf = '';
          p.stderr.on('data', (d: Buffer) => { err = (err + d).slice(-1500); });
          p.stdout.on('data', (d: Buffer) => {
            buf += d.toString();
            const lines = buf.split('\n'); buf = lines.pop() ?? '';
            for (const l of lines) {
              const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
              if (m && dur) job.encPct = Math.min(99, (Number(m[1]) / 1e6 / dur) * 100);
              const sp = /^speed=\s*([\d.]+)x/.exec(l);
              if (sp) job.eta = dur && Number(sp[1]) > 0 ? (dur * (1 - job.encPct / 100)) / Number(sp[1]) : 0;
            }
          });
          const code: number = await new Promise((ok) => { p.on('close', (c) => ok(c ?? 1)); p.on('error', () => ok(1)); });
          killRemote = null;
          if (aborted) { fs.rmSync(part, { force: true }); throw new Error('__stopped'); }
          if (code !== 0) { fs.rmSync(part, { force: true }); throw new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`); }
          job.encPct = 100; job.size = fs.statSync(part).size; job.done = job.size; job.eta = 0;
          localDone = true;
        }
      }
      if (pr.kind !== 'orig' && !localDone) {
        job.where = 'server';
        const probe = JSON.parse(await runText(B, `ffprobe -v error -show_entries format=duration:stream=codec_type,channels -of json ${sh(job.remote)}`));
        const dur = Number(probe.format?.duration) || 0;
        const ch = Number((probe.streams ?? []).find((s: any) => s.codec_type === 'audio')?.channels) || 2;
        await runText(B, `mkdir -p /tmp/cinema-pack && rm -f ${sh(tmpRemote)}`);
        const p = await B.exec(ffmpegArgs(job.profile, job.opts, job.remote, tmpRemote, ch, settings().encodeSpeed));
        killRemote = () => p.kill();
        let err = '', buf = '';
        p.err.on('data', (d: Buffer) => { err = (err + d).slice(-1500); });
        p.out.on('data', (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split('\n'); buf = lines.pop() ?? '';
          for (const l of lines) {
            const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
            if (m && dur) job.encPct = Math.min(99, (Number(m[1]) / 1e6 / dur) * 100);
          }
        });
        const code = await p.closed;
        killRemote = null;
        if (aborted) throw new Error('__stopped');
        if (code !== 0) throw new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`);
        job.encPct = 100;
        src = tmpRemote;
        job.size = (await B.stat(tmpRemote)).size;
      }

      // ----- 2. download (resumable) -----
      if (!localDone) job.state = 'downloading';
      let have = 0;
      try { have = fs.statSync(part).size; } catch { /* fresh start */ }
      if (have > job.size) { fs.rmSync(part, { force: true }); have = 0; }
      job.done = have;
      if (!localDone && have < job.size) {
        const fh = await fs.promises.open(part, 'a');
        try {
          const rs = B.read(src, have, job.size - 1);
          readStream = rs;
          const t0 = Date.now(); let sinceT = Date.now(), since = 0; const win: [number, number][] = [];
          let lim0 = Date.now(), limBytes = 0;
          for await (const chunk of rs as AsyncIterable<Buffer>) {
            if (aborted) break;
            await fh.write(chunk);
            job.done += chunk.length; since += chunk.length; limBytes += chunk.length;
            this.ctx.addBytes(chunk.length);
            const now = Date.now();
            if (now - sinceT >= 500) {
              win.push([now, job.done]);
              while (win.length > 1 && now - win[0][0] > 3000) win.shift();
              const [t, b] = win[0];
              job.speed = now > t ? ((job.done - b) / (now - t)) * 1000 : 0;
              job.eta = job.speed > 0 ? (job.size - job.done) / job.speed : 0;
              sinceT = now; since = 0;
            }
            const lim = (settings().limitKBps * 1024) / Math.max(1, this.live.size);
            if (lim > 0) {
              const wait = (limBytes / lim) * 1000 - (Date.now() - lim0);
              if (wait > 5) await sleep(Math.min(wait, 2000));
              if (Date.now() - lim0 > 4000) { lim0 = Date.now(); limBytes = 0; }
            }
          }
          void t0; void since;
        } finally { await fh.close(); readStream = null; }
        if (aborted) throw new Error('__stopped');
        if (job.done !== job.size) throw new Error('The connection dropped before the file was complete. Resume to continue.');
      }

      // ----- 3. finish: move into place, save thumbnail/subtitles/info -----
      job.state = 'finalizing'; job.speed = 0;
      fs.renameSync(part, destFull);
      try { await this.ctx.pack(job, B, job.remote, src, destFull); } catch { /* extras are optional */ }
      if (src === tmpRemote) { try { await runText(B, `rm -f ${sh(tmpRemote)}`); } catch { /* ignore */ } }
      job.state = 'done'; job.done = job.size; job.finished = Date.now(); job.reason = undefined;
    } catch (e: any) {
      const why = live.why;
      if (B && src === tmpRemote) { try { await runText(B, `rm -f ${sh(tmpRemote)}`); } catch { /* ignore */ } }
      if (why === 'cancel') { job.state = 'cancelled'; this.dropPart(job); }
      else if (why === 'pause') job.state = 'paused';
      else if (why === 'hold') { job.state = 'queued'; }
      else { job.state = 'error'; job.error = e?.message === '__stopped' ? 'Stopped' : e?.message ?? 'Failed'; }
      job.speed = 0;
    } finally {
      this.live.delete(job.id);
      this.save();
      setTimeout(() => this.tick(), 200);
    }
  }
}