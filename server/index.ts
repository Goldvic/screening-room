import { fingerprint, matchIntro, pcm } from './intro';
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path, { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Backend, FileStat, HttpError, makeGate, makeLocalBackend, makeSshBackend, runBuf, runText, sh,
} from './backend';
import { Crypt, Root, Server, ServerInput, Store, plainCrypt } from './store';
import { Downloads, DlItem, VIDEO } from './downloads';
import { Online } from './online';
import * as local from './local';

const env = process.env;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export type StartOpts = {
  dataDir?: string;          // where settings, caches and the queue live
  staticDir?: string;        // the built web app
  defaultDownloadDir?: string;
  port?: number; bind?: string; fallbackPort?: boolean;
  token?: string;            // desktop app: required on every request (cookie "cinema" or ?tk=)
  crypt?: Crypt;             // desktop app: OS keychain encryption for saved passwords/keys
  ffmpeg?: string; ffprobe?: string;
  embedded?: boolean;
};

const OFFLINE_ID = 1000; // fixed id of the "Offline" storage so it never shifts when servers change
const OPENED_ID = 1001;  // fixed id of "Opened files": videos opened from Explorer, drag and drop or Open file

type Prog = { pos: number; dur: number; watched: boolean; updated: number };
type RootX = Root & { offline?: boolean; opened?: boolean };

export async function start(opts: StartOpts = {}) {
  const DATA = path.resolve(opts.dataDir ?? env.CINEMA_DATA ?? path.join(HERE, '../data'));
  const defaultDl = opts.defaultDownloadDir ?? env.CINEMA_DOWNLOADS ?? path.join(DATA, 'downloads');
  const store = new Store(DATA, opts.crypt ?? plainCrypt, defaultDl);
  await local.findBins({ ffmpeg: opts.ffmpeg, ffprobe: opts.ffprobe });

  // Speed knobs (all optional). SFTP only matters when the app is NOT running on the VPS itself.
  const TUNE = { chunkKb: Number(env.SFTP_CHUNK_KB ?? 128), window: Number(env.SFTP_WINDOW ?? 48) };
  const PRESET = /^[a-z]+$/.test(env.FFMPEG_PRESET ?? '') ? env.FFMPEG_PRESET! : 'veryfast';

  // First start from an old-style .env file: turn it into a saved server so nothing has to be re-entered.
  if (!store.list().length && (env.VPS_HOST || env.MODE === 'local')) {
    store.upsert({
      name: env.VPS_HOST ?? 'This server', host: env.VPS_HOST ?? 'localhost', port: 22, user: env.VPS_USER ?? 'root',
      auth: 'key', keyPath: env.VPS_KEY, container: env.BOT_CONTAINER ?? 'media-downloader-bot',
      roots: (env.MEDIA_ROOTS ?? '').split(',').filter(Boolean).map((s) => {
        const [name, ...rest] = s.split('=');
        return { name: name.trim(), dir: posix.normalize(rest.join('=').trim()).replace(/\/+$/, '') };
      }),
    });
  }

  // =====================================================================================
  //  Servers, backends and media roots
  // =====================================================================================
  const MODE = (env.MODE ?? 'auto').toLowerCase();
  const runsOnTheVps = (host: string) =>
    ['localhost', '127.0.0.1', '::1'].includes(host) ||
    Object.values(os.networkInterfaces()).flat().some((i) => i?.address === host);

  const backends = new Map<string, Backend>();
  const rootsCache = new Map<string, Root[]>();
  const offlineB = makeLocalBackend({ shell: false });

  function createBackend(s: Server): Backend {
    const useLocal = MODE === 'local' || (MODE === 'auto' && opts.embedded !== true && runsOnTheVps(s.host));
    if (useLocal) return makeLocalBackend({ shell: true });
    const sec = store.secrets(s);
    if (!sec.privateKey && !sec.password) throw new HttpError(400, 'This server has no SSH key or password saved. Edit it and add one.');
    return makeSshBackend({ host: s.host, port: s.port, user: s.user, ...sec }, TUNE);
  }
  function backendOf(s: Server): Backend {
    let b = backends.get(s.id);
    if (!b) { b = createBackend(s); backends.set(s.id, b); }
    return b;
  }
  const remoteCaps = new Map<string, { at: number; v: { ffmpeg: boolean; h264: boolean; hevc: boolean; av1: boolean } }>();
  const dropBackend = (id: string) => { backends.get(id)?.close(); backends.delete(id); rootsCache.delete(id); remoteCaps.delete(id); };

  async function detectRoots(s: Server, B: Backend): Promise<Root[]> {
    // Only the Downloads folder is ever read. Any "exports" folder (zip packages made by the bot) is ignored.
    if (s.roots?.length) {
      const keep = s.roots.filter((r) => !/(^|[\\/])exports?$/i.test(r.dir.replace(/\/+$/, '')) && !/^exports?$/i.test(r.name.trim()));
      if (keep.length) return keep;
    }
    if (!s.container) throw new HttpError(400, 'No media folders set for this server. Edit the server and add one.');
    const src = (await runText(B, `docker inspect ${sh(s.container)} --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}'`)).trim();
    if (!src) throw new HttpError(400, `Could not find the data folder of container "${s.container}". Add the media folders by hand in the server settings.`);
    return [{ name: 'Downloads', dir: `${src}/downloads` }];
  }
  async function rootsOf(s: Server): Promise<Root[]> {
    const hit = rootsCache.get(s.id);
    if (hit) return hit;
    const roots = await detectRoots(s, backendOf(s));
    rootsCache.set(s.id, roots);
    return roots;
  }
  const activeServer = () => store.active();
  async function remoteRoots(): Promise<Root[]> {
    const s = activeServer();
    return s ? rootsOf(s) : [];
  }
  const offlineRoot = (): RootX => ({ name: 'Offline', dir: store.settings().downloadDir, offline: true });
  const metaDir = () => path.join(store.settings().downloadDir, '.meta');
  const metaKey = (destRel: string) => createHash('sha1').update(destRel).digest('hex').slice(0, 20);

  // =====================================================================================
  //  Saved state: watch progress + data usage
  // =====================================================================================
  const STATE = path.join(DATA, 'state.json');
  let progress: Record<string, Prog> = {};
  try { progress = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* first run */ }
  let saveT: NodeJS.Timeout | undefined;
  const saveProgress = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(progress)); }, 400);
  };

  const USAGE = path.join(DATA, 'usage.json');
  let usage: { lifetime: number; days: Record<string, number> } = { lifetime: 0, days: {} };
  try { usage = { ...usage, ...JSON.parse(fs.readFileSync(USAGE, 'utf8')) }; } catch { /* first run */ }
  let usageDirty = false;
  const flushUsage = () => {
    if (!usageDirty) return;
    usageDirty = false;
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(USAGE, JSON.stringify(usage)); } catch { /* ignore */ }
  };
  const usageTimer = setInterval(flushUsage, 5000); usageTimer.unref();

  const net = { total: 0, active: 0, sessions: new Map<string, { bytes: number; seen: number }>() };
  const todayKey = () => new Date().toISOString().slice(0, 10);
  const monthBytes = () => {
    const m = todayKey().slice(0, 7);
    return Object.entries(usage.days).filter(([d]) => d.startsWith(m)).reduce((s, [, v]) => s + v, 0);
  };
  function add(n: number, sid?: string) {
    net.total += n; usage.lifetime += n;
    const d = todayKey();
    if (!(d in usage.days)) {
      usage.days[d] = 0;
      const keys = Object.keys(usage.days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete usage.days[k];
    }
    usage.days[d] += n; usageDirty = true;
    if (sid) {
      const s = net.sessions.get(sid) ?? { bytes: 0, seen: 0 };
      s.bytes += n; s.seen = Date.now();
      net.sessions.set(sid, s);
    }
  }
  function meter(res: Response, sid?: string) {
    net.active++;
    const write = res.write.bind(res) as any;
    (res as any).write = (chunk: any, ...rest: any[]) => {
      add(typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.length ?? 0, sid);
      return write(chunk, ...rest);
    };
    res.once('close', () => { net.active--; });
  }
  const sessTimer = setInterval(() => {
    const old = Date.now() - 2 * 3600_000;
    for (const [k, v] of net.sessions) if (v.seen < old) net.sessions.delete(k);
  }, 600_000);
  sessTimer.unref();
  const sidOf = (req: Request) => String(req.query.sid ?? '').replace(/[^\w-]/g, '').slice(0, 40) || undefined;

  // =====================================================================================
  //  Helpers
  // =====================================================================================
  const MIME: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
    '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  };
  const SUBEXT = /\.(srt|vtt|ass|ssa)$/i;

  // ---------- "Opened files": any video on this computer, played in place (never copied or moved) ----------
  const OPENED = path.join(DATA, 'opened.json');
  let opened: Record<string, { abs: string; added: number }> = {};
  try { opened = JSON.parse(fs.readFileSync(OPENED, 'utf8')); } catch { /* none yet */ }
  const saveOpened = () => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(OPENED, JSON.stringify(opened)); } catch { /* ignore */ } };
  const pruneOpened = () => {
    let changed = false;
    for (const [k, v] of Object.entries(opened)) if (!fs.existsSync(v.abs)) { delete opened[k]; changed = true; }
    if (changed) saveOpened();
  };
  const absHash = (abs: string) => createHash('sha1').update(abs).digest('hex').slice(0, 16);
  function registerOpened(abs: string): string {
    if (typeof abs !== 'string' || !path.isAbsolute(abs)) throw new HttpError(400, 'That is not a full file path');
    if (!VIDEO.test(abs)) throw new HttpError(400, 'That is not a video file');
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { throw new HttpError(404, 'That file does not exist any more'); }
    if (!st.isFile()) throw new HttpError(400, 'That is not a file');
    for (const [k, v] of Object.entries(opened)) if (v.abs === abs) { v.added = Date.now(); saveOpened(); return k; }
    const ext = path.extname(abs), base = path.basename(abs, ext);
    let key = base + ext, n = 2;
    while (opened[key]) key = `${base} (${n++})${ext}`; // two different files with the same name
    opened[key] = { abs, added: Date.now() };
    const keys = Object.keys(opened).sort((a, b) => opened[b].added - opened[a].added);
    for (const k of keys.slice(300)) delete opened[k];
    saveOpened();
    return key;
  }
  const sidecars = (abs: string) => {
    try {
      const base = path.basename(abs, path.extname(abs)).toLowerCase();
      return fs.readdirSync(path.dirname(abs))
        .filter((f) => SUBEXT.test(f) && f.toLowerCase().startsWith(base + '.'))
        .map((f) => { const mid = f.slice(base.length).replace(SUBEXT, '').replace(/^[._\-\s]+/, ''); return { name: f, label: mid ? `File · ${mid}` : 'Subtitle file', lang: mid.toLowerCase() }; });
    } catch { return []; }
  };

  type R = { root: RootX; full: string; rel: string; isRoot: boolean; B: Backend; offline: boolean; key?: string };
  // Everything must stay inside a configured root.
  async function resolve(q: Request['query']): Promise<R> {
    const rel = posix.normalize('/' + String(q.path ?? '')).replace(/^\/+/, '');
    if (Number(q.root) === OPENED_ID) {
      const base: RootX = { name: 'Opened', dir: '', offline: true, opened: true };
      if (!rel) return { root: base, full: '', rel: '', isRoot: true, B: offlineB, offline: true };
      const ent = opened[rel];
      if (!ent) throw new HttpError(404, 'That file is no longer in the list');
      return { root: { ...base, dir: path.dirname(ent.abs) }, full: ent.abs, rel: `opened/${absHash(ent.abs)}`, isRoot: false, B: offlineB, offline: true, key: rel };
    }
    if (Number(q.root) === OFFLINE_ID) {
      const root = offlineRoot();
      fs.mkdirSync(root.dir, { recursive: true });
      const full = rel ? path.join(root.dir, ...rel.split('/')) : root.dir;
      if (path.relative(root.dir, full).startsWith('..')) throw new HttpError(400, 'Bad path');
      return { root, full, rel, isRoot: full === root.dir, B: offlineB, offline: true };
    }
    const s = activeServer();
    if (!s) throw new HttpError(400, 'No server set up yet');
    const roots = await rootsOf(s);
    const root = roots[Number(q.root)];
    if (!root) throw new HttpError(400, 'Unknown storage');
    const full = rel ? posix.join(root.dir, rel) : root.dir;
    return { root, full, rel, isRoot: full === root.dir, B: backendOf(s), offline: false };
  }

  const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, _n: NextFunction) =>
    fn(req, res).catch((e: any) => {
      if (res.headersSent) return res.end();
      const msg = e?.code === 2 || e?.code === 'ENOENT' || /No such file/i.test(e?.message) ? 'Not found on the server' : e?.message ?? 'Error';
      res.status(e?.status ?? (msg.startsWith('Not found') ? 404 : 500)).json({ error: msg });
    });

  // File serving with Range support (direct play + resumable downloads).
  async function serveFile(req: Request, res: Response, B: Backend, full: string, download: boolean, sid?: string, count = true) {
    const st = await B.stat(full);
    if (st.isDir) throw new HttpError(400, 'That is a folder');
    const size = st.size;
    let start = 0, end = size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], size - 1); }
      else start = Math.max(0, size - +m[2]);
      if (start > end || start >= size) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      code = 206;
    }
    const name = path.basename(full);
    req.socket.setNoDelay(true);
    res.writeHead(code, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': download ? 'application/octet-stream' : MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
      ...(code === 206 && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
      ...(download && { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }),
    });
    const rs = B.read(full, start, end);
    if (count) meter(res, sid);
    rs.on('error', () => res.destroy());
    rs.pipe(res);
    res.on('close', () => rs.destroy());
  }

  const zipOk = new Map<Backend, Promise<boolean>>();
  const hasZip = (B: Backend) => {
    let p = zipOk.get(B);
    if (!p) { p = runText(B, 'command -v zip').then(() => true, () => false); zipOk.set(B, p); }
    return p;
  };

  // ---------- optional AI subtitles (needs whisper on the VPS) ----------
  const whisperP = new Map<Backend, Promise<string | null>>();
  const getWhisper = (B: Backend) => {
    let p = whisperP.get(B);
    if (!p) {
      p = env.WHISPER_CMD
        ? Promise.resolve(env.WHISPER_CMD)
        : runText(B, 'command -v whisper-ctranslate2 || command -v whisper').then((s) => s.trim().split('\n')[0] || null, () => null);
      whisperP.set(B, p);
    }
    return p;
  };
  type Job = { state: 'running' | 'done' | 'error'; started: number; error?: string };
  const jobs = new Map<string, Job>();
  const aiDir = (key: string) => `/tmp/screening-room-ai/${key}`;
  const idKey = (full: string, st: FileStat) => createHash('sha1').update(`${full}|${st.mtime}|${st.size}`).digest('hex');
  const aiKey = (full: string, st: FileStat) => idKey(full, st).slice(0, 20);
  const subCache = new Map<string, string>();

  const THUMBS = path.join(DATA, 'thumbs');
  const SPRITES = path.join(DATA, 'sprites');
  const POSTERS = path.join(DATA, 'posters');
  const thumbGate = makeGate(2);
  const thumbFail = new Set<string>();

  async function thumbBuf(B: Backend, full: string) {
    const f = sh(full);
    return runBuf(B,
      `d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 ${f}); ` +
      `t=$(awk -v d="$d" 'BEGIN{printf "%d", (d>0)?d*0.12:0}'); ` +
      `ffmpeg -hide_banner -loglevel error -ss "$t" -i ${f} -frames:v 1 -vf scale=480:-2 -q:v 4 -f mjpeg pipe:1`);
  }

  // ---------- media info ----------
  type Info = {
    duration: number; bitrate?: number; width?: number; height?: number; codec?: string; fps?: number; channels?: number;
    audio: { i: number; label: string; lang: string; channels: number }[];
    subs: { i: number; label: string; lang: string }[];
    imageSubs?: { i: number; label: string; lang: string; codec: string }[];
    external: { name: string; label: string; lang: string }[];
    chapters: { start: number; end: number; title: string }[];
    ai: boolean;
  };
  const TEXT_SUBS = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'ttml', 'microdvd', 'sami', 'subviewer', 'subviewer1', 'realtext', 'jacosub', 'stl', 'mpl2', 'pjs', 'vplayer'];
  const IMAGE_SUBS = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];
  function parseProbe(j: any): Info {
    const st: any[] = j.streams ?? [];
    const v = st.find((x) => x.codec_type === 'video' && x.height) ?? st.find((x) => x.codec_type === 'video');
    const label = (x: any, i: number) => [x.tags?.title, x.tags?.language].filter(Boolean).join(' · ') || `Track ${i + 1}`;
    const audio = st.filter((x) => x.codec_type === 'audio').map((x, i) => ({ i, label: label(x, i), lang: String(x.tags?.language ?? ''), channels: Number(x.channels) || 2 }));
    const subs = st.filter((x) => x.codec_type === 'subtitle').map((x, i) => ({ x, i }))
      .filter(({ x }) => TEXT_SUBS.includes(x.codec_name)).map(({ x, i }) => ({ i, label: label(x, i), lang: String(x.tags?.language ?? '') }));
    const [fa, fb] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number);
    const chapters = (j.chapters ?? []).map((c: any) => ({ start: Number(c.start_time) || 0, end: Number(c.end_time) || 0, title: String(c.tags?.title ?? '') }))
      .filter((c: any) => c.end > c.start);
    return {
      duration: Number(j.format?.duration) || 0, bitrate: Number(j.format?.bit_rate) || 0,
      width: v?.width, height: v?.height, codec: v?.codec_name,
      fps: fb ? Math.round((fa / fb) * 100) / 100 : 0, channels: audio[0]?.channels ?? 2,
      audio, subs, imageSubs: st.filter((x) => x.codec_type === 'subtitle').map((x, i) => ({ x, i })).filter(({ x }) => IMAGE_SUBS.includes(x.codec_name)).map(({ x, i }) => ({ i, label: label(x, i), lang: String(x.tags?.language ?? ''), codec: String(x.codec_name) })), external: [], chapters, ai: false,
    };
  }
  async function remoteInfo(B: Backend, full: string): Promise<Info> {
    let out: Info = { duration: 0, audio: [], subs: [], external: [], chapters: [], ai: false };
    try {
      const raw = await runText(B, `ffprobe -v error -show_entries stream=index,codec_type,codec_name,width,height,bit_rate,channels,avg_frame_rate:stream_tags=language,title:format=duration,bit_rate:chapter=start_time,end_time:chapter_tags=title -of json ${sh(full)}`);
      out = parseProbe(JSON.parse(raw));
    } catch { /* ffprobe missing or unreadable file: the player still works */ }
    try {
      const base = posix.basename(full).replace(/\.[^.]+$/, '').toLowerCase();
      const sib = await B.list(posix.dirname(full));
      out.external = sib
        .filter((f) => !f.dir && SUBEXT.test(f.name) && f.name.toLowerCase().startsWith(base + '.'))
        .map((f) => {
          const mid = f.name.slice(base.length).replace(SUBEXT, '').replace(/^[._\-\s]+/, '');
          return { name: f.name, label: mid ? `File · ${mid}` : 'Subtitle file', lang: mid.toLowerCase() };
        });
    } catch { /* ignore */ }
    out.ai = !!(await getWhisper(B));
    return out;
  }
  const readMeta = (destRel: string): any | null => {
    try { return JSON.parse(fs.readFileSync(path.join(metaDir(), `${metaKey(destRel)}.json`), 'utf8')); } catch { return null; }
  };

  // =====================================================================================
  //  Adaptive streaming (HLS): fixed 6 s segments, cut on demand at several qualities
  // =====================================================================================
  type Probe = { duration: number; width: number; height: number };
  const probeCache = new Map<string, Probe>();
  async function probe(B: Backend, full: string, st: FileStat): Promise<Probe> {
    const key = `${full}|${st.mtime}|${st.size}`;
    const hit = probeCache.get(key);
    if (hit) return hit;
    const j = JSON.parse(await runText(B, `ffprobe -v error -show_entries stream=codec_type,width,height:format=duration -of json ${sh(full)}`));
    const v = (j.streams ?? []).find((x: any) => x.codec_type === 'video' && x.height);
    const duration = Number(j.format?.duration) || 0;
    if (!v) throw new HttpError(400, 'This file has no video track');
    if (!duration) throw new HttpError(500, 'Could not read the video length');
    const pr = { duration, width: Number(v.width), height: Number(v.height) };
    probeCache.set(key, pr);
    if (probeCache.size > 200) probeCache.delete(probeCache.keys().next().value!);
    return pr;
  }

  const SEG = 6;
  const LADDER = [
    { h: 360, v: 700_000 }, { h: 480, v: 1_300_000 }, { h: 720, v: 2_800_000 },
    { h: 1080, v: 5_000_000 }, { h: 1440, v: 9_000_000 }, { h: 2160, v: 16_000_000 },
  ];
  // Data Saver levels: 0 = off. Higher levels cap the quality "Auto" may pick and squeeze the bitrate, so far fewer MB are used.
  const SAVER = [
    { cap: 99999, mul: 1, crf: 23, abr: 128 },
    { cap: 720, mul: 0.65, crf: 26, abr: 96 },
    { cap: 480, mul: 0.5, crf: 28, abr: 64 },
    { cap: 360, mul: 0.4, crf: 31, abr: 48 },
  ];
  const dsOf = (v: unknown) => Math.min(3, Math.max(0, Math.floor(Number(v)) || 0));
  const rateFor = (hh: number, ds: number) => Math.round((LADDER.find((l) => l.h >= hh) ?? LADDER[LADDER.length - 1]).v * SAVER[ds].mul);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

  // Which renditions to offer. "auto" = every level up to the source height (and the Data Saver cap); a number = just that one.
  function variantsFor(pr: Probe, q: string, ds: number) {
    let vs = LADDER.filter((l) => l.h <= pr.height * 1.1);
    if (q === 'all') return vs; // every size, so the player can change size without throwing away what it has buffered
    const want = Number(q);
    const explicit = Number.isFinite(want) && want > 0;
    if (!explicit) { const capped = vs.filter((l) => l.h <= SAVER[ds].cap); vs = capped.length ? capped : vs.slice(0, 1); }
    if (!vs.length) vs = [{ h: even(pr.height), v: LADDER[0].v }];
    if (explicit) vs = [[...vs].reverse().find((l) => l.h <= want) ?? vs[0]];
    return vs;
  }
  function masterPlaylist(pr: Probe, q: string, base: string, ds: number) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const v of variantsFor(pr, q, ds)) {
      const w = even((pr.width * Math.min(v.h, pr.height)) / pr.height);
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round((rateFor(v.h, ds) + SAVER[ds].abr * 1000) * 1.1)},RESOLUTION=${w}x${Math.min(v.h, even(pr.height))},NAME="${v.h}p"`,
        `/api/hls/level.m3u8?${base}&h=${v.h}`,
      );
    }
    return lines.join('\n') + '\n';
  }
  function levelPlaylist(pr: Probe, hh: number, base: string) {
    const count = Math.ceil(pr.duration / SEG);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    for (let i = 0; i < count; i++) lines.push(`#EXTINF:${Math.min(SEG, pr.duration - i * SEG).toFixed(3)},`, `/api/hls/seg.ts?${base}&h=${hh}&n=${i}`);
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  // Segment cache (in memory), shared encodes, and a limit on simultaneous ffmpeg jobs.
  const hlsGate = makeGate(Math.max(1, Number(env.HLS_JOBS ?? 2)));
  const SEG_MAX = Math.max(32, Number(env.HLS_CACHE_MB ?? 256)) * 1048576;
  const segCache = new Map<string, Buffer>();
  let segBytes = 0;
  const segFlight = new Map<string, { p: Promise<Buffer>; want: number }>();
  function wantSeg(key: string, make: () => Promise<Buffer>, res?: Response): Promise<Buffer> {
    const hit = segCache.get(key);
    if (hit) { segCache.delete(key); segCache.set(key, hit); return Promise.resolve(hit); }
    let fl = segFlight.get(key);
    if (!fl) {
      const e = { p: null as unknown as Promise<Buffer>, want: 0 };
      e.p = (async () => {
        await hlsGate.acquire();
        try {
          // The viewer already seeked elsewhere while this waited in the queue: skip the work.
          if (e.want <= 0) throw new Error('cancelled');
          const b = await make();
          segCache.set(key, b); segBytes += b.length;
          while (segBytes > SEG_MAX && segCache.size > 1) {
            const [k, v] = segCache.entries().next().value!;
            segCache.delete(k); segBytes -= v.length;
          }
          return b;
        } finally { hlsGate.release(); segFlight.delete(key); }
      })();
      e.p.catch(() => {});
      segFlight.set(key, e);
      fl = e;
    }
    fl.want++;
    const f = fl;
    if (res) res.once('close', () => { f.want--; });
    return fl.p;
  }
  function encodeSeg(B: Backend, full: string, hh: number, a: number, n: number, dur: number, ds: number) {
    const start = n * SEG, len = Math.min(SEG, dur - start), v = rateFor(hh, ds), S = SAVER[ds];
    // -ss before -i cuts at an exact time, and -output_ts_offset keeps original timestamps, so segments join with no gap or overlap.
    return runBuf(B,
      `ffmpeg -hide_banner -loglevel error -ss ${start} -i ${sh(full)} -t ${len.toFixed(3)} -map 0:v:0 -map '0:a:${a}?' -sn -dn ` +
      `-c:v libx264 -preset ${PRESET} -profile:v high -pix_fmt yuv420p -crf ${S.crf} -maxrate ${v} -bufsize ${v * 2} -threads 0 ` +
      `-vf "scale=-2:'min(ih,${hh})'" -c:a aac -ac 2 -ar 48000 -b:a ${S.abr}k ` +
      `-f mpegts -output_ts_offset ${start} -muxdelay 0 -muxpreload 0 pipe:1`);
  }
  const hlsBase = (req: Request) => {
    const sid = sidOf(req);
    const ds = dsOf(req.query.ds);
    return new URLSearchParams({
      root: String(req.query.root ?? ''), path: String(req.query.path ?? ''),
      a: String(Math.max(0, Math.floor(Number(req.query.a)) || 0)), ds: String(ds), ...(sid && { sid }),
    }).toString();
  };
  const noOffline = (r: R, what: string) => { if (r.offline) throw new HttpError(400, `${what} is only available while connected to your server.`); };

  // =====================================================================================
  //  Seek-bar preview sprites: one JPEG sheet of small frames, built once per video
  // =====================================================================================
  const spriteGate = makeGate(1);
  const spriteJobs = new Map<string, { state: 'building' | 'error'; error?: string }>();
  async function buildSprite(B: Backend, full: string, st: FileStat, key: string) {
    await spriteGate.acquire();
    try {
      const pr = await probe(B, full, st);
      const interval = Math.max(2, Math.ceil(pr.duration / 100));
      const count = Math.max(1, Math.ceil(pr.duration / interval));
      const cols = Math.min(10, count), rows = Math.ceil(count / cols), W = 160, Hh = 90;
      // Only key frames are decoded, so a whole movie takes seconds instead of minutes.
      const buf = await runBuf(B,
        `nice -n 10 ffmpeg -hide_banner -loglevel error -skip_frame nokey -i ${sh(full)} -an -sn -dn ` +
        `-vf "fps=1/${interval},scale=${W}:${Hh}:force_original_aspect_ratio=decrease,pad=${W}:${Hh}:(ow-iw)/2:(oh-ih)/2,tile=${cols}x${rows}" ` +
        `-frames:v 1 -q:v 6 -f mjpeg pipe:1`);
      if (!buf.length) throw new Error('No frames could be read');
      fs.mkdirSync(SPRITES, { recursive: true });
      fs.writeFileSync(path.join(SPRITES, `${key}.jpg`), buf);
      fs.writeFileSync(path.join(SPRITES, `${key}.json`), JSON.stringify({ interval, cols, rows, w: W, h: Hh, count }));
    } finally { spriteGate.release(); }
  }

  // =====================================================================================
  //  Offline downloads: queue + "pack" (thumbnail, preview sheet, subtitles, info saved beside the file)
  // =====================================================================================
  async function pack(job: DlItem, B: Backend, original: string, final: string, _destFull: string) {
    const dir = metaDir();
    fs.mkdirSync(dir, { recursive: true });
    const key = metaKey(job.dest);
    const ost = await B.stat(original);
    const infoFinal = await remoteInfo(B, final);
    const infoOrig = final === original ? infoFinal : await remoteInfo(B, original);

    try { const b = await thumbBuf(B, original); if (b.length) fs.writeFileSync(path.join(dir, `${key}.jpg`), b); } catch { /* optional */ }
    try {
      const sk = idKey(original, ost);
      const img = path.join(SPRITES, `${sk}.jpg`), js = path.join(SPRITES, `${sk}.json`);
      if (!(fs.existsSync(img) && fs.existsSync(js))) await buildSprite(B, original, ost, sk);
      fs.copyFileSync(img, path.join(dir, `${key}.sprite.jpg`));
      fs.copyFileSync(js, path.join(dir, `${key}.sprite.json`));
    } catch { /* optional */ }

    const subs: Info['subs'] = [];
    for (const s of infoOrig.subs) {
      try {
        const vtt = await runText(B, `ffmpeg -hide_banner -loglevel error -i ${sh(original)} -map 0:s:${s.i} -f webvtt pipe:1`);
        if (vtt.trim()) { fs.writeFileSync(path.join(dir, `${key}.s.${s.i}.vtt`), vtt); subs.push(s); }
      } catch { /* skip this track */ }
    }
    const external: (Info['external'][number] & { j: number })[] = [];
    for (const [j, e] of infoOrig.external.entries()) {
      try {
        const vtt = await runText(B, `ffmpeg -hide_banner -loglevel error -i ${sh(posix.join(posix.dirname(original), e.name))} -f webvtt pipe:1`);
        if (vtt.trim()) { fs.writeFileSync(path.join(dir, `${key}.x.${j}.vtt`), vtt); external.push({ ...e, j }); }
      } catch { /* skip this file */ }
    }
    let ai = false;
    try {
      const vtt = await runText(B, `cat ${aiDir(aiKey(original, ost))}/*.vtt`);
      if (vtt.trim()) { fs.writeFileSync(path.join(dir, `${key}.ai.vtt`), vtt); ai = true; }
    } catch { /* none generated */ }

    const meta = {
      ...infoFinal, subs, external, ai, chapters: infoOrig.chapters,
      origin: { serverId: job.serverId, rootName: job.rootName, rel: job.rel }, profile: job.profile, savedAt: Date.now(), size: job.size,
    };
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(meta));
  }

  const dl = new Downloads({
    dataDir: DATA,
    settings: () => store.settings(),
    backendFor: async (id) => { const s = store.get(id); if (!s) throw new Error('That server was removed'); return backendOf(s); },
    addBytes: (n) => add(n),
    monthBytes,
    profileOf: (rel) => {
      const m = readMeta(rel);
      if (m) return String(m.profile ?? 'orig');
      return fs.existsSync(path.join(store.settings().downloadDir, ...rel.split('/'))) ? 'orig' : null;
    },
    pack,
  });

  // ---------- offline library helpers ----------
  type OffFile = { rel: string; name: string; size: number; mtime: number };
  const walkCache = new Map<string, { t: number; v: OffFile[] }>();
  function walkOffline(dir: string): OffFile[] { // scanned at most once every 5 seconds: it reads the disk synchronously
    const c = walkCache.get(dir);
    if (c && Date.now() - c.t < 5000) return c.v;
    const v = walkOfflineRaw(dir);
    walkCache.set(dir, { t: Date.now(), v });
    return v;
  }
  function walkOfflineRaw(dir: string, rel = '', out: OffFile[] = []): OffFile[] {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walkOfflineRaw(p, r, out);
      else if (!e.name.endsWith('.part')) {
        try { const st = fs.statSync(p); out.push({ rel: r, name: e.name, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }); } catch { /* vanished */ }
      }
    }
    return out;
  }
  const dirSize = (dir: string): number => {
    let n = 0;
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } } catch { /* missing */ }
    return n;
  };
  function removeMetaFor(rel: string) {
    const key = metaKey(rel), d = metaDir();
    try { for (const f of fs.readdirSync(d)) if (f.startsWith(key + '.')) fs.rmSync(path.join(d, f), { force: true }); } catch { /* none */ }
  }
  function removeOffline(rel: string) {
    walkCache.clear();
    const base = store.settings().downloadDir;
    const full = path.join(base, ...rel.split('/'));
    if (path.relative(base, full).startsWith('..') || full === base) throw new HttpError(400, 'Bad path');
    const st = fs.statSync(full);
    if (st.isDirectory()) for (const f of walkOfflineRaw(full, rel)) removeMetaFor(f.rel);
    else removeMetaFor(rel);
    fs.rmSync(full, { recursive: true, force: true });
    for (const k of Object.keys(progress)) if (k === `Offline:${rel}` || k.startsWith(`Offline:${rel}/`)) delete progress[k];
    saveProgress();
    // tidy up empty parent folders
    let p = path.dirname(full);
    while (path.relative(base, p) && !path.relative(base, p).startsWith('..')) {
      try { if (fs.readdirSync(p).length) break; fs.rmdirSync(p); } catch { break; }
      p = path.dirname(p);
    }
  }
  function autoDelete() {
    const days = store.settings().autoDeleteDays;
    if (!days) return;
    const cutoff = Date.now() - days * 86400_000;
    for (const f of walkOffline(store.settings().downloadDir)) {
      const pg = progress[`Offline:${f.rel}`];
      if (pg?.watched && pg.updated < cutoff) { try { removeOffline(f.rel); } catch { /* ignore */ } }
    }
  }
  // Space limit: keep saved videos under N GB by removing the oldest watched ones first, then the oldest saved. The newest file and anything played in the last 30 minutes are kept.
  function enforceQuota() {
    const gb = store.settings().quotaGB;
    if (!gb) return;
    const cap = gb * 1024 ** 3;
    const files = walkOffline(store.settings().downloadDir);
    let total = files.reduce((a, f) => a + f.size, 0);
    if (total <= cap) return;
    const newest = files.reduce((a, f) => (f.mtime > (a?.mtime ?? 0) ? f : a), undefined as OffFile | undefined);
    const recent = Date.now() - 30 * 60_000;
    const order = files
      .filter((f) => f !== newest && !((progress[`Offline:${f.rel}`]?.updated ?? 0) > recent))
      .sort((a, b) => Number(!!progress[`Offline:${b.rel}`]?.watched) - Number(!!progress[`Offline:${a.rel}`]?.watched) || a.mtime - b.mtime);
    for (const f of order) {
      if (total <= cap) break;
      try { removeOffline(f.rel); total -= f.size; } catch { /* in use */ }
    }
  }
  const quotaTimer = setInterval(enforceQuota, 120_000); quotaTimer.unref();
  setTimeout(enforceQuota, 20_000).unref();
  const cleanTimer = setInterval(autoDelete, 3600_000); cleanTimer.unref();
  setTimeout(autoDelete, 15_000).unref();

  const online = new Online(POSTERS, () => {
    const s = store.settings();
    return { tmdbKey: s.tmdbKey, osKey: s.osKey, osUser: s.osUser, osPass: store.osPassword() };
  });
  const statfs = async (dir: string) => {
    try { const s = await (fs.promises as any).statfs(dir); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; } catch { return { free: 0, total: 0 }; }
  };
  async function getRemoteCaps(s: Server) {
    const hit = remoteCaps.get(s.id);
    if (hit && Date.now() - hit.at < 600_000) return hit.v;
    let v = { ffmpeg: false, h264: false, hevc: false, av1: false };
    try {
      const out = await runText(backendOf(s), 'ffmpeg -hide_banner -encoders 2>/dev/null');
      v = { ffmpeg: true, h264: /libx264/.test(out), hevc: /libx265/.test(out), av1: /libsvtav1/.test(out) };
    } catch { /* ffmpeg missing or server unreachable */ }
    remoteCaps.set(s.id, { at: Date.now(), v });
    return v;
  }

  // =====================================================================================
  //  App
  // =====================================================================================
  const app = express();
  app.disable('x-powered-by');

  const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  if (opts.token) {
    // Desktop app: only this app's window (which holds the secret) may talk to the server.
    app.use((req, res, next) => {
      const ck = /(?:^|;\s*)cinema=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
      if (safeEq(ck, opts.token!) || safeEq(String(req.query.tk ?? ''), opts.token!)) return next();
      res.status(401).send('Unauthorized');
    });
  }
  // Optional login (set APP_PASSWORD). Required if you expose this beyond localhost.
  const PASS = env.APP_PASSWORD;
  if (PASS) {
    app.use((req, res, next) => {
      const dec = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      if (safeEq(dec.slice(dec.indexOf(':') + 1), PASS)) return next();
      res.set('WWW-Authenticate', 'Basic realm="Cinema"').status(401).send('Login required');
    });
  }
  app.use(express.json({ limit: '2mb' }));

  // ---------- usage, speed test, preferences ----------
  app.get('/api/net', (req, res) => {
    const sid = sidOf(req);
    const s = activeServer();
    res.set('Cache-Control', 'no-store').json({
      total: net.total,
      session: sid ? net.sessions.get(sid)?.bytes ?? 0 : 0,
      today: usage.days[todayKey()] ?? 0,
      month: monthBytes(),
      lifetime: usage.lifetime,
      days: usage.days,
      active: Math.max(net.active, [...net.sessions.values()].filter((x) => Date.now() - x.seen < 15000).length),
      mode: s ? backends.get(s.id)?.mode ?? 'ssh' : 'none',
    });
  });

  // Measures real VPS -> laptop throughput (the number that decides how fast streaming/downloads can be).
  app.get('/api/speedtest', (req, res) => {
    const mb = Math.min(2048, Math.max(1, Number(req.query.mb) || 64));
    const chunk = randomBytes(1 << 20);
    req.socket.setNoDelay(true);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': mb * chunk.length, 'Cache-Control': 'no-store' });
    meter(res);
    let sent = 0;
    res.on('close', () => { sent = mb; });
    const pump = () => {
      while (sent < mb) {
        sent++;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
  });

  app.get('/api/prefs', (_req, res) => res.set('Cache-Control', 'no-store').json(store.allPrefs()));
  app.post('/api/prefs', (req, res) => {
    const { key, value } = req.body ?? {};
    if (typeof key !== 'string') return res.status(400).json({ error: 'Bad request' });
    store.setPref(key, value);
    res.json({ ok: true });
  });

  // ---------- servers (the "Add server" screen) ----------
  const serverList = () => ({ active: store.activeId(), servers: store.list().map((s) => store.pub(s)) });
  const parseRoots = (txt: unknown): Root[] =>
    String(txt ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      const name = i > 0 ? l.slice(0, i).trim() : posix.basename(l) || l;
      const dir = posix.normalize((i > 0 ? l.slice(i + 1) : l).trim()).replace(/(.)\/+$/, '$1');
      return { name, dir };
    });
  const toInput = (b: any): ServerInput => ({
    id: typeof b.id === 'string' ? b.id : undefined,
    name: String(b.name ?? ''), host: String(b.host ?? ''), port: Number(b.port) || 22, user: String(b.user ?? 'root'),
    auth: b.auth === 'password' ? 'password' : 'key',
    keyPath: b.keyPath ? String(b.keyPath) : undefined, keyText: b.keyText ? String(b.keyText) : undefined,
    password: b.password ? String(b.password) : undefined, passphrase: b.passphrase ? String(b.passphrase) : undefined,
    container: b.container ? String(b.container) : undefined, roots: parseRoots(b.rootsText),
  });

  app.get('/api/servers', (_req, res) => res.json(serverList()));
  app.post('/api/servers', h(async (req, res) => {
    const inp = toInput(req.body ?? {});
    if (!inp.host.trim()) throw new HttpError(400, 'Enter the server address');
    const s = store.upsert(inp);
    dropBackend(s.id);
    res.json({ ...serverList(), saved: s.id });
  }));
  app.post('/api/servers/test', h(async (req, res) => {
    const inp = toInput(req.body ?? {});
    if (!inp.host.trim()) throw new HttpError(400, 'Enter the server address');
    let B: Backend | null = null;
    try {
      const s = store.draft(inp);
      B = createBackend(s);
      const out = await Promise.race([
        runText(B, 'echo ok; command -v ffmpeg >/dev/null 2>&1 && echo ffmpeg; command -v docker >/dev/null 2>&1 && echo docker; true'),
        new Promise<string>((_, no) => setTimeout(() => no(new Error('The server did not answer within 25 seconds')), 25000)),
      ]);
      if (!out.includes('ok')) throw new Error('Unexpected reply from the server');
      let roots: Root[] = [], rootsError = '';
      try { roots = await detectRoots(s, B); } catch (e: any) { rootsError = e.message; }
      res.json({ ok: true, ffmpeg: out.includes('ffmpeg'), docker: out.includes('docker'), roots, rootsError });
    } catch (e: any) {
      const m = String(e?.message ?? e);
      const hint = /authentication/i.test(m) ? 'Login failed: wrong user, key or password.'
        : /ENOTFOUND|EAI_AGAIN/i.test(m) ? 'That address could not be found.'
        : /ECONNREFUSED/i.test(m) ? 'The server refused the connection (is SSH running on that port?).'
        : /timed out|did not answer/i.test(m) ? 'The server did not answer in time.' : m;
      res.json({ ok: false, error: hint });
    } finally { B?.close(); }
  }));
  app.post('/api/servers/active', h(async (req, res) => {
    const id = String(req.body?.id ?? '');
    if (!store.get(id)) throw new HttpError(404, 'Unknown server');
    store.setActive(id);
    segCache.clear(); segBytes = 0; subCache.clear(); probeCache.clear();
    res.json(serverList());
  }));
  app.delete('/api/servers', h(async (req, res) => {
    const id = String(req.query.id ?? '');
    store.remove(id);
    dropBackend(id);
    res.json(serverList());
  }));

  // ---------- settings (downloads, budget, integrations) ----------
  app.get('/api/settings', (_req, res) => res.json(store.publicSettings()));
  // Check a saved key or account against the real service, so you can see that it works.
  app.get('/api/online/test', h(async (req, res) => {
    const s = store.settings();
    const kind = String(req.query.kind);
    const ua = { 'User-Agent': 'ScreeningRoom v1' };
    try {
      if (kind === 'tmdb') {
        const key = s.tmdbKey.trim();
        if (!key) return res.json({ ok: false, text: 'Paste your key first.' });
        const bearer = key.length > 40;
        const r = await fetch(bearer ? 'https://api.themoviedb.org/3/configuration' : `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`, { headers: bearer ? { Authorization: `Bearer ${key}` } : {} });
        return res.json(r.ok ? { ok: true, text: 'Connected to TMDB. Posters and descriptions will load.' } : { ok: false, text: r.status === 401 ? 'TMDB rejected this key. Check that you copied all of it.' : `TMDB answered with error ${r.status}.` });
      }
      const key = s.osKey.trim();
      if (!key) return res.json({ ok: false, text: 'Paste your API key first.' });
      const k = await fetch('https://api.opensubtitles.com/api/v1/infos/formats', { headers: { 'Api-Key': key, ...ua } });
      if (!k.ok) return res.json({ ok: false, text: k.status === 401 || k.status === 403 ? 'OpenSubtitles rejected this API key.' : `OpenSubtitles answered with error ${k.status}.` });
      const pass = store.osPassword();
      if (!s.osUser || !pass) return res.json({ ok: true, text: 'The key works. Add your username and password to download subtitles.' });
      const l = await fetch('https://api.opensubtitles.com/api/v1/login', { method: 'POST', headers: { 'Api-Key': key, 'Content-Type': 'application/json', ...ua }, body: JSON.stringify({ username: s.osUser, password: pass }) });
      return res.json(l.ok ? { ok: true, text: 'Key and account both work.' } : { ok: false, text: 'The key works, but the username or password was rejected.' });
    } catch { return res.json({ ok: false, text: 'Could not reach the service. Check your internet connection.' }); }
  }));
  app.post('/api/settings', h(async (req, res) => {
    const b = req.body ?? {};
    const patch: any = {};
    if (typeof b.downloadDir === 'string' && b.downloadDir.trim()) {
      const dir = path.resolve(b.downloadDir.trim());
      fs.mkdirSync(dir, { recursive: true });
      patch.downloadDir = dir;
    }
    for (const k of ['maxParallel', 'limitKBps', 'budgetGB', 'autoDeleteDays', 'quotaGB'] as const) if (b[k] !== undefined) patch[k] = Math.max(0, Number(b[k]) || 0);
    if (b.schedule) patch.schedule = { on: !!b.schedule.on, from: String(b.schedule.from ?? '01:00'), to: String(b.schedule.to ?? '07:00') };
    for (const k of ['tmdbKey', 'osKey', 'osUser', 'osPass'] as const) if (typeof b[k] === 'string') patch[k] = b[k].trim();
    store.patchSettings(patch);
    res.json(store.publicSettings());
  }));

  // What this machine and the server can do (used to show only options that will work).
  app.get('/api/caps', h(async (req, res) => {
    const s = activeServer();
    if (req.query.refresh && s) remoteCaps.delete(s.id);
    const remote = s ? await getRemoteCaps(s) : { ffmpeg: false, h264: false, hevc: false, av1: false };
    res.json({
      local: { ffmpeg: !!local.bins.ffmpeg, ffprobe: !!local.bins.ffprobe },
      remote, platform: process.platform, embedded: !!opts.embedded, hasServer: !!s,
    });
  }));

  app.get('/api/roots', h(async (_req, res) => {
    const s = activeServer();
    let remote: Root[] = [], error = '', mode = 'none', host = '';
    if (s) {
      host = s.name || s.host;
      try { remote = await rootsOf(s); mode = backendOf(s).mode; } catch (e: any) { error = e.message; }
    }
    const roots: any[] = await Promise.all(remote.map(async (r, id) => {
      let free = 0, total = 0;
      try {
        const f = (await Promise.race([
          runText(backendOf(s!), `df -P -k ${sh(r.dir)} | tail -1`),
          new Promise<string>((_, no) => setTimeout(() => no(new Error('slow')), 4000)),
        ])).trim().split(/\s+/);
        total = Number(f[1]) * 1024; free = Number(f[3]) * 1024;
      } catch { /* folder may not exist yet */ }
      return { id, name: r.name, dir: r.dir, free, total };
    }));
    const off = offlineRoot();
    fs.mkdirSync(off.dir, { recursive: true });
    const sp = await statfs(off.dir);
    roots.push({ id: OFFLINE_ID, name: 'Offline', dir: off.dir, ...sp, offline: true });
    pruneOpened();
    if (Object.keys(opened).length) roots.push({ id: OPENED_ID, name: 'Opened', dir: '', free: 0, total: 0, offline: true, opened: true });
    res.json({ host, mode, error, hasServer: !!s, roots });
  }));

  app.get('/api/list', h(async (req, res) => {
    const r = await resolve(req.query);
    if (r.root.opened) {
      pruneOpened();
      return res.json(Object.entries(opened).sort((a, b) => b[1].added - a[1].added).map(([name, v]) => {
        const st = fs.statSync(v.abs);
        return { name, dir: false, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
      }));
    }
    const list = await r.B.list(r.full);
    const items = list
      .filter((f) => !f.name.startsWith('.') && !f.name.endsWith('.part'))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json(items);
  }));

  app.get('/api/info', h(async (req, res) => {
    const r = await resolve(req.query);
    if (r.offline) {
      const m = readMeta(r.rel);
      if (m) return res.json(m);
      let info: Info = { duration: 0, audio: [], subs: [], external: [], chapters: [], ai: false };
      try { info = parseProbe(await local.probeJson(r.full)); } catch { /* no local ffprobe */ }
      if (r.root.opened) info.external = sidecars(r.full);
      return res.json(info);
    }
    res.json(await remoteInfo(r.B, r.full));
  }));

  // Subtitles as WebVTT: embedded track (?s=N), file next to the video (?ext=name.srt) or AI (?s=ai). Always whole-file, cached.
  // ---------- intro detection: find the theme music that repeats across episodes ----------
  const introKey = (r: any) => { if (r.offline) { const o = readMeta(r.rel)?.origin; return o ? `${o.rootName}:${o.rel}` : `Offline:${r.rel}`; } return `${r.root.name}:${r.rel}`; };
  const introStore = (): Record<string, [number, number] | 0> => ((store.allPrefs() as any).introfp as Record<string, [number, number] | 0>) ?? {};
  const putIntro = (k: string, v: [number, number] | 0) => store.setPref('introfp', { ...introStore(), [k]: v });
  let introQueue: Promise<unknown> = Promise.resolve();
  const VIDEO_RE = /\.(mkv|mp4|m4v|avi|mov|webm|ts|wmv|flv|mpg|mpeg)$/i;
  app.get('/api/intro', h(async (req, res) => {
    const r = await resolve(req.query);
    if (r.root.opened) return res.json({ state: 'none' });
    const key = introKey(r);
    const hit = introStore()[key];
    if (Array.isArray(hit)) return res.json({ state: 'found', start: hit[0], end: hit[1] });
    if (req.query.cached) return res.json({ state: hit === 0 ? 'none' : 'unknown' });
    const ff = local.bins.ffmpeg;
    if (!ff) throw new HttpError(400, 'Intro detection needs ffmpeg on this laptop.');
    const port = req.socket.localPort;
    const tk = opts.token ? `&tk=${encodeURIComponent(opts.token)}` : '';
    const rel = String(req.query.path ?? '');
    const dirRel = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
    const selfName = posix.basename(rel);
    let names: string[]; let inputOf: (n: string) => string; let keyOf: (n: string) => string;
    if (r.offline) {
      const base = store.settings().downloadDir;
      const d = posix.dirname(r.rel) === '.' ? '' : posix.dirname(r.rel);
      names = walkOffline(base).filter((f) => (posix.dirname(f.rel) === '.' ? '' : posix.dirname(f.rel)) === d).map((f) => posix.basename(f.rel));
      inputOf = (n) => path.join(base, ...posix.join(d, n).split('/'));
      keyOf = (n) => introKey({ offline: true, rel: posix.join(d, n), root: r.root });
    } else {
      names = (await r.B.list(posix.dirname(r.full))).filter((f) => !f.dir).map((f) => f.name);
      inputOf = (n) => `http://127.0.0.1:${port}/api/stream?root=${encodeURIComponent(String(req.query.root))}&path=${encodeURIComponent(posix.join(dirRel, n))}&q=orig${tk}`;
      keyOf = (n) => `${r.root.name}:${posix.join(dirRel, n)}`;
    }
    const own = r.offline ? posix.basename(r.rel) : selfName;
    const sorted = names.filter((n) => VIDEO_RE.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const at = sorted.indexOf(own);
    const neigh = [sorted[at + 1], sorted[at - 1], sorted[at + 2], sorted[at - 2]].filter((x): x is string => !!x).slice(0, 2);
    if (!neigh.length) { putIntro(key, 0); return res.json({ state: 'none', reason: 'No other episode in this folder to compare with.' }); }
    const run = async () => {
      const again = introStore()[key];
      if (Array.isArray(again)) return again;
      const fa = fingerprint(await pcm(ff, r.offline ? r.full : inputOf(own), 420));
      let found: [number, number] | null = null;
      for (const n of neigh) {
        const m = matchIntro(fa, fingerprint(await pcm(ff, inputOf(n), 420)));
        if (m) { found = m.a; putIntro(keyOf(n), m.b); break; }
      }
      putIntro(key, found ?? 0);
      return found;
    };
    const job = introQueue.then(run, run);
    introQueue = job.catch(() => {});
    const f = (await job) as [number, number] | null;
    res.json(f ? { state: 'found', start: f[0], end: f[1] } : { state: 'none', reason: 'No repeating intro music was found.' });
  }));

  app.get('/api/subs', h(async (req, res) => {
    const r = await resolve(req.query);
    const which = String(req.query.s ?? '0');
    const ext = req.query.ext ? String(req.query.ext) : '';
    const send = (vtt: string) => res.type('text/vtt').set('Cache-Control', 'private, max-age=3600').send(vtt);
    if (r.root.opened && ext) {
      if (path.basename(ext) !== ext || !SUBEXT.test(ext)) throw new HttpError(400, 'Bad subtitle file name');
      const f = path.join(path.dirname(r.full), ext);
      return send(/\.(srt|vtt)$/i.test(ext) ? fs.readFileSync(f, 'utf8') : await local.convertSub(f));
    }
    if (r.offline) {
      const m = readMeta(r.rel), key = metaKey(r.rel), d = metaDir();
      const read = (f: string) => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch { return null; } };
      let vtt: string | null = null;
      if (ext) { const e = m?.external?.find((x: any) => x.name === ext); if (e) vtt = read(`${key}.x.${e.j}.vtt`); }
      else if (which === 'ai') vtt = read(`${key}.ai.vtt`);
      else { const n = Math.max(0, Math.floor(Number(which)) || 0); vtt = read(`${key}.s.${n}.vtt`); if (vtt === null && local.bins.ffmpeg) vtt = await local.subsVtt(r.full, n).catch(() => null); }
      if (vtt === null) throw new HttpError(404, 'Subtitle not available offline');
      return send(vtt);
    }
    const { B, full } = r;
    const st = await B.stat(full);
    let id: string;
    let produce: () => Promise<string>;
    if (ext) {
      if (posix.basename(ext) !== ext || !SUBEXT.test(ext)) throw new HttpError(400, 'Bad subtitle file name');
      const sp = posix.join(posix.dirname(full), ext);
      id = sp;
      produce = () => runText(B, `ffmpeg -hide_banner -loglevel error -i ${sh(sp)} -f webvtt pipe:1`);
    } else if (which === 'ai') {
      const dir = aiDir(aiKey(full, st));
      id = dir;
      produce = () => runText(B, `cat ${dir}/*.vtt`);
    } else {
      const n = Math.max(0, Math.floor(Number(which)) || 0);
      id = `${full}#${n}`;
      produce = () => runText(B, `ffmpeg -hide_banner -loglevel error -i ${sh(full)} -map 0:s:${n} -f webvtt pipe:1`);
    }
    const key = `${id}|${st.mtime}`;
    let vtt = subCache.get(key);
    if (vtt === undefined) {
      vtt = await produce();
      subCache.set(key, vtt);
      if (subCache.size > 60) subCache.delete(subCache.keys().next().value!);
    }
    send(vtt);
  }));

  app.get('/api/autosub', h(async (req, res) => {
    const r = await resolve(req.query);
    if (r.offline) {
      const has = fs.existsSync(path.join(metaDir(), `${metaKey(r.rel)}.ai.vtt`));
      return res.json({ available: has, state: has ? 'done' : 'none', elapsed: 0 });
    }
    const { B, full } = r;
    const st = await B.stat(full);
    const key = aiKey(full, st);
    const w = await getWhisper(B);
    const job = jobs.get(key);
    let state: string = job?.state ?? 'none';
    if (w && state !== 'running' && state !== 'done') {
      const have = await runText(B, `ls ${aiDir(key)}/*.vtt`).then(() => true, () => false);
      if (have) state = 'done';
    }
    res.json({ available: !!w, state, error: job?.error, elapsed: job?.state === 'running' ? Math.round((Date.now() - job.started) / 1000) : 0 });
  }));

  app.post('/api/autosub', h(async (req, res) => {
    const r = await resolve(req.query);
    noOffline(r, 'Making AI subtitles');
    const { B, full } = r;
    const w = await getWhisper(B);
    if (!w) throw new HttpError(400, 'Whisper is not installed on the VPS (pip install whisper-ctranslate2).');
    if ([...jobs.values()].some((j) => j.state === 'running')) throw new HttpError(409, 'Another subtitle job is already running.');
    const st = await B.stat(full);
    const key = aiKey(full, st);
    const dir = aiDir(key);
    const lang = String(req.query.lang ?? '').replace(/[^a-z]/gi, '').slice(0, 12);
    const model = (env.WHISPER_MODEL ?? 'base').replace(/[^\w.-]/g, '');
    const cmd = `mkdir -p ${dir} && nice -n 10 ${w} ${sh(full)} --model ${model} --output_format vtt --output_dir ${dir}${lang ? ` --language ${lang}` : ''}`;
    const job: Job = { state: 'running', started: Date.now() };
    jobs.set(key, job);
    B.exec(cmd).then(async (p) => {
      let err = '';
      p.out.resume();
      p.err.on('data', (d: Buffer) => { err = (err + d).slice(-600); });
      const code = await p.closed;
      subCache.delete(`${dir}|${st.mtime}`);
      if (code === 0) job.state = 'done'; else { job.state = 'error'; job.error = err.trim().split('\n').pop() || `whisper exited with ${code}`; }
    }).catch((e) => { job.state = 'error'; job.error = e.message; });
    res.json({ ok: true });
  }));

  app.get('/api/thumb', h(async (req, res) => {
    const r = await resolve(req.query);
    const send = (b: Buffer) => res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' }).send(b);
    if (r.offline) {
      const f = path.join(metaDir(), `${metaKey(r.rel)}.jpg`);
      if (fs.existsSync(f)) return send(fs.readFileSync(f));
      if (local.bins.ffmpeg && !thumbFail.has(f)) {
        try {
          const b = await local.thumbJpg(r.full, readMeta(r.rel)?.duration ? readMeta(r.rel).duration * 0.12 : 20);
          if (b.length) { fs.mkdirSync(metaDir(), { recursive: true }); fs.writeFileSync(f, b); return send(b); }
        } catch { thumbFail.add(f); }
      }
      throw new HttpError(404, 'No thumbnail');
    }
    const { B, full } = r;
    const st = await B.stat(full);
    const key = idKey(full, st);
    const file = path.join(THUMBS, `${key}.jpg`);
    if (fs.existsSync(file)) return send(fs.readFileSync(file));
    if (thumbFail.has(key)) throw new HttpError(404, 'No thumbnail');
    await thumbGate.acquire();
    try {
      const buf = await thumbBuf(B, full);
      if (!buf.length) throw new Error('empty');
      fs.mkdirSync(THUMBS, { recursive: true });
      fs.writeFileSync(file, buf);
      send(buf);
    } catch {
      thumbFail.add(key);
      throw new HttpError(404, 'No thumbnail');
    } finally { thumbGate.release(); }
  }));

  app.get('/api/hls/master.m3u8', h(async (req, res) => {
    const r = await resolve(req.query);
    noOffline(r, 'Adaptive streaming');
    const pr = await probe(r.B, r.full, await r.B.stat(r.full));
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(masterPlaylist(pr, String(req.query.q ?? 'auto'), hlsBase(req), dsOf(req.query.ds)));
  }));
  app.get('/api/hls/level.m3u8', h(async (req, res) => {
    const r = await resolve(req.query);
    noOffline(r, 'Adaptive streaming');
    const H = Math.floor(Number(req.query.h));
    if (!(H >= 100 && H <= 4320)) throw new HttpError(400, 'Bad quality');
    const pr = await probe(r.B, r.full, await r.B.stat(r.full));
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(levelPlaylist(pr, H, hlsBase(req)));
  }));
  app.get('/api/hls/seg.ts', h(async (req, res) => {
    const r = await resolve(req.query);
    noOffline(r, 'Adaptive streaming');
    const { B, full } = r;
    const st = await B.stat(full);
    const pr = await probe(B, full, st);
    const H = Math.floor(Number(req.query.h));
    const n = Math.floor(Number(req.query.n));
    const a = Math.max(0, Math.floor(Number(req.query.a)) || 0);
    const ds = dsOf(req.query.ds);
    const count = Math.ceil(pr.duration / SEG);
    if (!(H >= 100 && H <= 4320) || !(n >= 0 && n < count)) throw new HttpError(400, 'Bad segment');
    const keyOf = (i: number) => `${full}|${st.mtime}|${H}|${a}|${ds}|${i}`;
    const buf = await wantSeg(keyOf(n), () => encodeSeg(B, full, H, a, n, pr.duration, ds), res);
    add(buf.length, sidOf(req));
    res.set({ 'Content-Type': 'video/mp2t', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=600' }).end(buf);
    // Have the next piece ready while this one plays, but only when the CPU has nothing else to do.
    if (n + 1 < count && hlsGate.idle()) wantSeg(keyOf(n + 1), () => encodeSeg(B, full, H, a, n + 1, pr.duration, ds)).catch(() => {});
  }));

  app.get('/api/sprite', h(async (req, res) => {
    const r = await resolve(req.query);
    const send = (f: string) => res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=2592000, immutable' }).send(fs.readFileSync(f));
    if (r.offline) {
      const key = metaKey(r.rel), d = metaDir();
      const img = path.join(d, `${key}.sprite.jpg`), js = path.join(d, `${key}.sprite.json`);
      const ready = fs.existsSync(img) && fs.existsSync(js);
      if (req.query.img) { if (!ready) throw new HttpError(404, 'No preview'); return send(img); }
      if (ready) return res.json({ state: 'ready', ...JSON.parse(fs.readFileSync(js, 'utf8')) });
      if (!local.bins.ffmpeg) return res.json({ state: 'error', error: 'No preview saved for this video' });
      // no saved preview: make one here with the laptop's ffmpeg
      const jk = `off:${key}`;
      let job = spriteJobs.get(jk);
      if (!job) {
        const j: { state: 'building' | 'error'; error?: string } = { state: 'building' };
        spriteJobs.set(jk, j); job = j;
        (async () => {
          await spriteGate.acquire();
          try {
            const dur = Number((await local.probeJson(r.full)).format?.duration) || 0;
            if (!dur) throw new Error('Unknown length');
            const interval = Math.max(2, Math.ceil(dur / 100)), count = Math.max(1, Math.ceil(dur / interval));
            const cols = Math.min(10, count), rows = Math.ceil(count / cols);
            const buf = await local.spriteJpg(r.full, interval, cols, rows, 160, 90);
            if (!buf.length) throw new Error('No frames');
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(img, buf);
            fs.writeFileSync(js, JSON.stringify({ interval, cols, rows, w: 160, h: 90, count }));
            spriteJobs.delete(jk);
          } finally { spriteGate.release(); }
        })().catch((e) => { j.state = 'error'; j.error = e.message; });
      }
      return res.json({ state: job.state, error: job.error });
    }
    const { B, full } = r;
    const st = await B.stat(full);
    const key = idKey(full, st);
    const img = path.join(SPRITES, `${key}.jpg`), meta = path.join(SPRITES, `${key}.json`);
    const ready = fs.existsSync(img) && fs.existsSync(meta);
    if (req.query.img) {
      if (!ready) throw new HttpError(404, 'No preview yet');
      return send(img);
    }
    if (ready) return res.json({ state: 'ready', ...JSON.parse(fs.readFileSync(meta, 'utf8')) });
    let job = spriteJobs.get(key);
    if (!job) {
      const j: { state: 'building' | 'error'; error?: string } = { state: 'building' };
      spriteJobs.set(key, j);
      job = j;
      buildSprite(B, full, st, key).then(() => spriteJobs.delete(key)).catch((e) => { j.state = 'error'; j.error = e.message; });
    }
    res.json({ state: job.state, error: job.error });
  }));

  app.get('/api/progress', (_req, res) => res.json(progress));
  app.post('/api/progress', (req, res) => {
    const { key, pos, dur, watched } = req.body ?? {};
    if (typeof key !== 'string') return res.status(400).json({ error: 'Bad request' });
    const set = (k: string) => {
      const o = progress[k];
      const d = Number(dur) || o?.dur || 0;
      const p = Number(pos) || 0;
      const done = typeof watched === 'boolean' ? watched : (o?.watched ?? false) || (d > 0 && p / d > 0.9);
      progress[k] = { pos: p, dur: d, watched: done, updated: Date.now() };
    };
    set(key);
    // Watching a downloaded copy also counts for the original on the server.
    if (key.startsWith('Offline:')) {
      const o = readMeta(key.slice(8))?.origin;
      if (o) set(`${o.rootName}:${o.rel}`);
    }
    saveProgress();
    res.json({ ok: true });
  });

  // Modes: orig = direct file. remux = copy video, fix audio (no re-encode). audio = sound only (tiny).
  // 360..2160 = H.264 conversion.
  app.get('/api/stream', h(async (req, res) => {
    const r = await resolve(req.query);
    const q = String(req.query.q ?? 'orig');
    const sid = sidOf(req);
    if (q === 'orig' && !r.offline) {
      // Same file already saved (or being saved) on this laptop: play it from here instead of pulling the bytes from the server again.
      const it = dl.list().find((i) => i.rootName === r.root.name && i.rel === r.rel && i.profile === 'orig');
      if (it) {
        const dest = path.join(store.settings().downloadDir, ...it.dest.split('/'));
        if (it.state === 'done' && fs.existsSync(dest)) return serveFile(req, res, offlineB, dest, false, sid, false);
        const part = dest + '.part';
        if (['downloading', 'paused', 'queued', 'finalizing'].includes(it.state) && it.size > 0 && fs.existsSync(part)) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
          const start = m && m[1] ? +m[1] : 0;
          const want = m && m[2] ? +m[2] : it.size - 1;
          const end = Math.min(want, it.done - 1);
          if (!(m && !m[1] && m[2]) && end >= start && (end - start >= 65535 || end === want)) {
            req.socket.setNoDelay(true);
            res.writeHead(206, {
              'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${it.size}`,
              'Content-Type': MIME[path.extname(dest).toLowerCase()] ?? 'application/octet-stream',
            });
            const rs = fs.createReadStream(part, { start, end });
            rs.on('error', () => res.destroy());
            rs.pipe(res);
            res.on('close', () => rs.destroy());
            return;
          }
        }
      }
    }
    if (q === 'orig') return serveFile(req, res, r.B, r.full, false, sid, !r.offline);
    const t = Math.max(0, Number(req.query.t) || 0);
    const a = Math.max(0, Math.floor(Number(req.query.a)) || 0);
    if (r.offline) {
      if (q !== 'remux' && q !== 'audio') throw new HttpError(400, 'Only the original file, fixed audio and audio-only are available offline.');
      if (!local.bins.ffmpeg) throw new HttpError(400, 'Fixing audio offline needs ffmpeg on this laptop (it is bundled with the installer).');
      const c = local.streamProc(r.full, q, t, a);
      req.socket.setNoDelay(true);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
      c.stderr?.on('data', () => {});
      c.stdout?.on('error', () => res.destroy());
      c.stdout?.pipe(res);
      res.on('close', () => c.kill('SIGKILL'));
      return;
    }
    const { B, full } = r;
    const tail = `-movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1`;
    const seek = `${t ? `-ss ${t} ` : ''}-i ${sh(full)}`;
    let cmd: string;
    if (q === 'audio') {
      cmd = `ffmpeg -hide_banner -loglevel error ${seek} -vn -map '0:a:${a}?' -sn -dn -c:a aac -ac 2 -b:a 64k ${tail}`;
    } else if (q === 'remux') {
      cmd = `ffmpeg -hide_banner -loglevel error ${seek} -map 0:v:0 -map '0:a:${a}?' -sn -dn -c:v copy -c:a aac -ac 2 -b:a 192k -avoid_negative_ts make_zero ${tail}`;
    } else {
      const H = Number(q);
      if (![360, 480, 720, 1080, 1440, 2160].includes(H)) throw new HttpError(400, 'Bad quality');
      cmd = `ffmpeg -hide_banner -loglevel error ${seek} -map 0:v:0 -map '0:a:${a}?' -sn -dn -c:v libx264 -preset ${PRESET} -crf 20 -pix_fmt yuv420p -threads 0 ` +
        `-vf "scale=-2:'min(ih,${H})'" -c:a aac -ac 2 -b:a 192k ${tail}`;
    }
    const p = await B.exec(cmd);
    req.socket.setNoDelay(true);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    meter(res, sid);
    p.err.on('data', () => {});
    p.out.on('error', () => res.destroy());
    p.out.pipe(res);
    res.on('close', () => p.kill());
  }));

  app.get('/api/download', h(async (req, res) => {
    const r = await resolve(req.query);
    const st = await r.B.stat(r.full);
    if (!st.isDir) return serveFile(req, res, r.B, r.full, true, sidOf(req), !r.offline);
    noOffline({ ...r, offline: r.offline }, 'Zipping a folder');
    const zip = await hasZip(r.B);
    const name = `${r.isRoot ? 'media' : posix.basename(r.full)}${zip ? '.zip' : '.tar'}`;
    const p = await r.B.exec(`cd ${sh(r.full)} && exec ${zip ? 'zip -0 -r -q - .' : 'tar -cf - .'}`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    meter(res);
    p.err.on('data', () => {});
    p.out.on('error', () => res.destroy());
    p.out.pipe(res);
    res.on('close', () => p.kill());
  }));

  app.delete('/api/item', h(async (req, res) => {
    const r = await resolve(req.query);
    if (r.root.opened && r.key) {
      delete opened[r.key]; saveOpened();
      removeMetaFor(r.rel);
      delete progress[`Opened:${r.key}`]; saveProgress();
      return res.json({ ok: true }); // the video itself stays where it is
    }
    if (r.isRoot) throw new HttpError(400, 'A storage root cannot be deleted');
    if (r.offline) { removeOffline(r.rel); return res.json({ ok: true }); }
    await runText(r.B, `rm -rf -- ${sh(r.full)}`);
    const k = `${r.root.name}:${r.rel}`;
    for (const key of Object.keys(progress)) if (key === k || key.startsWith(k + '/')) delete progress[key];
    saveProgress();
    res.json({ ok: true });
  }));

  // A video the person opened from Explorer / drag and drop / the Open file button.
  app.post('/api/opened', h(async (req, res) => {
    const name = registerOpened(String(req.body?.path ?? ''));
    res.json({ root: OPENED_ID, name });
  }));

  // Absolute path of an offline file (so the desktop app can open it in another player or show it in its folder).
  app.get('/api/localpath', h(async (req, res) => {
    const r = await resolve(req.query);
    if (!r.offline) throw new HttpError(400, 'Only downloaded files are on this laptop');
    res.json({ path: r.full });
  }));

  // ---------- offline downloads ----------
  app.get('/api/dl', (_req, res) => {
    const items = dl.list();
    const live = items.filter((i) => ['encoding', 'downloading', 'finalizing'].includes(i.state));
    res.set('Cache-Control', 'no-store').json({
      items, speed: live.reduce((s, i) => s + i.speed, 0), active: live.length,
      waiting: items.filter((i) => i.state === 'queued').length,
      month: monthBytes(), budgetGB: store.settings().budgetGB,
    });
  });
  async function enqueue(body: any): Promise<number> {
    const s = activeServer();
    if (!s) throw new HttpError(400, 'No server set up yet');
    const r = await resolve({ root: body?.root, path: '' } as any);
    if (r.offline) throw new HttpError(400, 'These files are already on this laptop');
    const rels = (Array.isArray(body?.paths) ? body.paths : []).map((p: unknown) => posix.normalize('/' + String(p)).replace(/^\/+/, ''));
    if (!rels.length) throw new HttpError(400, 'Nothing selected');
    const profile = String(body?.profile ?? 'orig');
    const caps = await getRemoteCaps(s);
    if (profile !== 'orig' && !caps.ffmpeg) throw new HttpError(400, 'ffmpeg is not installed on the server, so files cannot be compressed. Download the original instead.');
    if (/^hevc/.test(profile) && !caps.hevc) throw new HttpError(400, 'The server cannot encode HEVC. Pick H.264 instead.');
    if (/^av1/.test(profile) && !caps.av1) throw new HttpError(400, 'The server cannot encode AV1. Pick H.264 or HEVC instead.');
    return dl.add({
      serverId: s.id, B: r.B, rootName: r.root.name, rootDir: r.root.dir, rels, profile,
      opts: { loud: !!body?.opts?.loud, dialogue: !!body?.opts?.dialogue },
    });
  }
  app.post('/api/dl/add', h(async (req, res) => { res.json({ queued: await enqueue(req.body) }); }));

  // Scheduled downloads: saved on disk, started by the app at the chosen time (the app has to be running then).
  type Sched = { id: string; at: number; label: string; body: any };
  const scheds = (): Sched[] => (Array.isArray(store.allPrefs().dlsched) ? (store.allPrefs().dlsched as Sched[]) : []);
  const saveScheds = (l: Sched[]) => store.setPref('dlsched', l);
  app.get('/api/dl/schedules', h(async (_req, res) => {
    res.json({ items: scheds().map((x) => ({ id: x.id, at: x.at, label: x.label, count: x.body.paths.length })) });
  }));
  app.post('/api/dl/schedule', h(async (req, res) => {
    const at = Number(req.body?.at);
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String) : [];
    if (!isFinite(at) || at < Date.now() - 60_000) throw new HttpError(400, 'Pick a time in the future');
    if (!paths.length) throw new HttpError(400, 'Nothing selected');
    saveScheds([...scheds(), {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at, label: String(req.body?.label ?? '').slice(0, 140),
      body: { root: req.body?.root, paths, profile: String(req.body?.profile ?? 'orig'), opts: req.body?.opts ?? {} },
    }]);
    res.json({ ok: true });
  }));
  app.delete('/api/dl/schedule', h(async (req, res) => { saveScheds(scheds().filter((x) => x.id !== String(req.query.id))); res.json({ ok: true }); }));
  setInterval(() => {
    const now = Date.now();
    const due = scheds().filter((x) => x.at <= now);
    if (!due.length) return;
    saveScheds(scheds().filter((x) => x.at > now));
    for (const d of due) enqueue(d.body).catch(() => saveScheds([...scheds(), { ...d, at: Date.now() + 10 * 60_000 }])); // server unreachable: try again in 10 minutes
  }, 20_000).unref?.();

  // Move every saved video (and its saved info) to another folder or drive, so nothing is lost when the save folder changes.
  type MoveSt = { state: 'idle' | 'moving' | 'done' | 'error'; done: number; total: number; file: string; error?: string };
  let mv: MoveSt = { state: 'idle', done: 0, total: 0, file: '' };
  const walkAll = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAll(path.join(d, e.name)) : [path.join(d, e.name)]));
  const copyCount = (a: string, b: string) => new Promise<void>((ok, no) => {
    const rs = fs.createReadStream(a), ws = fs.createWriteStream(b);
    rs.on('data', (c) => { mv.done += c.length; });
    rs.on('error', no); ws.on('error', no); ws.on('close', () => ok());
    rs.pipe(ws);
  });
  app.get('/api/storage/move', (_req, res) => res.json(mv));
  app.post('/api/storage/move', h(async (req, res) => {
    if (mv.state === 'moving') throw new HttpError(409, 'Already moving');
    const from = path.resolve(store.settings().downloadDir);
    const vault = String(req.body?.to ?? '') === 'vault';
    const to = vault ? path.join(DATA, 'vault') : path.resolve(String(req.body?.to ?? '').trim());
    if (!String(req.body?.to ?? '').trim()) throw new HttpError(400, 'Pick a folder');
    if (from.toLowerCase() === to.toLowerCase()) throw new HttpError(400, 'That is already the save folder');
    if (to.toLowerCase().startsWith(from.toLowerCase() + path.sep)) throw new HttpError(400, 'Pick a folder outside the current one');
    if (dl.list().some((i) => ['queued', 'encoding', 'downloading', 'finalizing'].includes(i.state))) throw new HttpError(409, 'Downloads are running. Pause or finish them, then move your videos.');
    fs.mkdirSync(to, { recursive: true });
    if (vault && process.platform === 'win32') { try { (await import('node:child_process')).execFile('attrib', ['+h', to], () => {}); } catch { /* cosmetic */ } }
    const files = fs.existsSync(from) ? walkAll(from) : [];
    const total = files.reduce((a, f) => a + fs.statSync(f).size, 0);
    try { const st = fs.statfsSync(to); if (Number(st.bavail) * Number(st.bsize) < total * 1.02) throw new HttpError(400, 'There is not enough free space in that folder for your saved videos.'); } catch (e) { if (e instanceof HttpError) throw e; }
    mv = { state: 'moving', done: 0, total, file: '' };
    res.json(mv);
    (async () => {
      try {
        for (const f of files) {
          const dest = path.join(to, path.relative(from, f));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          mv.file = path.basename(f);
          const size = fs.statSync(f).size;
          await copyCount(f, dest);
          if (fs.statSync(dest).size !== size) throw new Error(`Copy of ${path.basename(f)} is incomplete`);
          fs.rmSync(f, { force: true });
        }
        store.patchSettings({ downloadDir: to });
        const dirs = fs.existsSync(from) ? [...new Set(files.map((f) => path.dirname(f)))].sort((a, b) => b.length - a.length) : [];
        for (const d of dirs) { try { fs.rmdirSync(d); } catch { /* not empty */ } }
        mv = { ...mv, state: 'done', done: total, file: '' };
      } catch (e: any) { mv = { ...mv, state: 'error', error: e?.message ?? 'Move failed' }; }
    })();
  }));
  app.post('/api/dl/all', h(async (req, res) => {
    const a = String(req.body?.action ?? '');
    if (a === 'pause') dl.pauseAll(); else if (a === 'resume') dl.resumeAll(); else if (a === 'clear') dl.clearFinished();
    else throw new HttpError(400, 'Unknown action');
    res.json({ ok: true });
  }));
  app.post('/api/dl/:action', h(async (req, res) => {
    const id = String(req.body?.id ?? '');
    const a = req.params.action;
    if (a === 'pause') dl.pause(id); else if (a === 'resume') dl.resume(id); else if (a === 'cancel') dl.cancel(id);
    else if (a === 'remove') dl.remove(id); else if (a === 'start') dl.startNow(id);
    else throw new HttpError(400, 'Unknown action');
    res.json({ ok: true });
  }));

  // Is this server video already (fully or partly) saved on the laptop? Used for "save while watching" and to prefer the saved copy.
  app.get('/api/saved', h(async (req, res) => {
    const r = await resolve(req.query);
    if (r.offline) return res.json({ state: 'none' });
    const item = dl.list().filter((i) => i.rootName === r.root.name && i.rel === r.rel).sort((a, b) => b.created - a.created)[0];
    const exists = (rel: string) => { try { return fs.statSync(path.join(store.settings().downloadDir, ...rel.split('/'))).isFile(); } catch { return false; } };
    if (item) {
      if (item.state === 'done' && exists(item.dest)) return res.json({ state: 'done', dest: item.dest, done: item.size, size: item.size });
      if (item.state !== 'cancelled' && item.state !== 'error') return res.json({ state: item.state, done: item.done, size: item.size, speed: item.speed });
    }
    // The queue entry may have been cleared: the saved file still knows where it came from.
    for (const f of walkOffline(store.settings().downloadDir)) {
      const o = readMeta(f.rel)?.origin;
      if (o && o.rootName === r.root.name && o.rel === r.rel) return res.json({ state: 'done', dest: f.rel, done: f.size, size: f.size });
    }
    res.json({ state: 'none' });
  }));

  // ---------- storage manager ----------
  app.get('/api/storage', h(async (_req, res) => {
    const dir = store.settings().downloadDir;
    fs.mkdirSync(dir, { recursive: true });
    const files = walkOffline(dir);
    const items = files.map((f) => {
      const pg = progress[`Offline:${f.rel}`];
      return { ...f, watched: !!pg?.watched, pos: pg?.pos ?? 0, dur: pg?.dur ?? 0, lastWatched: pg?.updated ?? 0 };
    }).sort((a, b) => b.size - a.size);
    const sp = await statfs(dir);
    res.json({
      dir, used: files.reduce((s, f) => s + f.size, 0), ...sp, items,
      caches: { thumbs: dirSize(THUMBS), sprites: dirSize(SPRITES), posters: dirSize(POSTERS), meta: dirSize(metaDir()) },
    });
  }));
  app.post('/api/storage/clear', h(async (req, res) => {
    const what = String(req.body?.what ?? '');
    if (what === 'watched') {
      let n = 0;
      for (const f of walkOffline(store.settings().downloadDir)) if (progress[`Offline:${f.rel}`]?.watched) { try { removeOffline(f.rel); n++; } catch { /* ignore */ } }
      return res.json({ removed: n });
    }
    const dirs: Record<string, string[]> = { thumbs: [THUMBS], sprites: [SPRITES], posters: [POSTERS], all: [THUMBS, SPRITES, POSTERS] };
    if (!dirs[what]) throw new HttpError(400, 'Unknown cache');
    for (const d of dirs[what]) fs.rmSync(d, { recursive: true, force: true });
    thumbFail.clear(); spriteJobs.clear();
    fs.mkdirSync(POSTERS, { recursive: true });
    res.json({ ok: true });
  }));

  // ---------- posters / descriptions / online subtitles ----------
  app.get('/api/meta', h(async (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 200);
    if (!q) throw new HttpError(400, 'Missing title');
    res.set('Cache-Control', 'private, max-age=3600').json(await online.meta(q, Number(req.query.year) || 0));
  }));
  app.get('/api/meta/search', h(async (req, res) => { res.json({ items: await online.candidates(String(req.query.q ?? '').slice(0, 200)) }); }));
  app.post('/api/meta/choose', h(async (req, res) => {
    const b = req.body ?? {};
    res.json(await online.choose(String(b.q ?? '').slice(0, 200), Number(b.year) || 0, Number(b.id), String(b.kind)));
  }));
  app.get('/api/poster', h(async (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 200), y = Number(req.query.year) || 0;
    const f = online.posterFile(q, y);
    if (!fs.existsSync(f)) throw new HttpError(404, 'No poster');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=2592000, immutable' }).send(fs.readFileSync(f));
  }));
  app.get('/api/os/search', h(async (req, res) => {
    res.json(await online.osSearch(String(req.query.q ?? ''), String(req.query.lang ?? 'en'), Number(req.query.year) || 0, Number(req.query.season) || 0, Number(req.query.episode) || 0));
  }));
  app.get('/api/os/get', h(async (req, res) => {
    const id = Number(req.query.id);
    if (!id) throw new HttpError(400, 'Bad subtitle');
    res.type('text/plain').send(await online.osGet(id));
  }));

  const dist = path.resolve(opts.staticDir ?? path.join(HERE, '../dist'));
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // Localhost by default on purpose: this app holds access to your VPS.
  const server = http.createServer(app);
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;
  const bind = opts.bind ?? env.BIND ?? '127.0.0.1';
  const want = opts.port ?? Number(env.PORT ?? 3001);
  const port = await new Promise<number>((ok, no) => {
    const listen = (p: number) => {
      const onErr = (e: any) => { if (e.code === 'EADDRINUSE' && opts.fallbackPort && p !== 0) listen(0); else no(e); };
      server.once('error', onErr);
      server.listen(p, bind, () => { server.off('error', onErr); ok((server.address() as any).port); });
    };
    listen(want);
  });

  const close = () => {
    flushUsage(); store.flush(); dl.pauseAll(); dl.flush();
    try { fs.writeFileSync(STATE, JSON.stringify(progress)); } catch { /* ignore */ }
    clearInterval(usageTimer); clearInterval(sessTimer); clearInterval(cleanTimer);
    for (const b of backends.values()) b.close();
    server.close();
    (server as any).closeAllConnections?.();
  };
  return { port, bind, close, mode: () => { const s = activeServer(); return s ? backends.get(s.id)?.mode ?? 'ssh' : 'none'; } };
}

// Started directly (npm start / npm run dev): behave like the original web app. The desktop app starts it itself.
if (!process.env.CINEMA_EMBEDDED) {
  start({}).then(({ port, bind, mode }) => {
    console.log(`Cinema on http://${bind}:${port} · ${mode() === 'local' ? 'LOCAL disk mode (fastest)' : 'SSH mode'}`);
    const stop = () => process.exit(0);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch((e) => { console.error(e); process.exit(1); });
}