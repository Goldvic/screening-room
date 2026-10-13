import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import os from 'node:os';
import path, { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data');
const HOST = env.VPS_HOST ?? '139.162.182.113';
const USER = env.VPS_USER ?? 'root';
const KEY = (env.VPS_KEY ?? '~/.ssh/Traqor.pem').replace(/^~/, os.homedir());
const PORT = Number(env.PORT ?? 3001);
const BIND = env.BIND ?? '127.0.0.1';
const CONTAINER = env.BOT_CONTAINER ?? 'media-downloader-bot';

// Speed knobs (all optional). SFTP only matters when the app is NOT running on the VPS itself.
const CHUNK = Math.max(32, Number(env.SFTP_CHUNK_KB ?? 128)) * 1024; // bytes per SFTP read request
const WINDOW = Math.max(4, Number(env.SFTP_WINDOW ?? 48));           // read requests kept in flight
const PRESET = /^[a-z]+$/.test(env.FFMPEG_PRESET ?? '') ? env.FFMPEG_PRESET! : 'veryfast';

type Root = { name: string; dir: string };
let ROOTS: Root[] = (env.MEDIA_ROOTS ?? '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [name, ...rest] = s.split('=');
    return { name: name.trim(), dir: posix.normalize(rest.join('=').trim()).replace(/\/+$/, '') };
  });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// =====================================================================================
//  Storage backend: LOCAL (app runs on the VPS: direct disk, fastest) or SSH (remote)
// =====================================================================================
type FileStat = { size: number; mtime: number; isDir: boolean };
type Entry = { name: string; dir: boolean; size: number; mtime: number };
type Proc = { out: Readable; err: Readable; kill: () => void; closed: Promise<number> };
interface Backend {
  mode: 'local' | 'ssh';
  stat(p: string): Promise<FileStat>;
  list(p: string): Promise<Entry[]>;
  read(p: string, start: number, end: number): Readable;
  exec(cmd: string): Promise<Proc>;
}

function runsOnTheVps() {
  if (['localhost', '127.0.0.1', '::1'].includes(HOST)) return true;
  return Object.values(os.networkInterfaces()).flat().some((i) => i?.address === HOST);
}
const MODE = (env.MODE ?? 'auto').toLowerCase();
const useLocal = MODE === 'local' || (MODE === 'auto' && runsOnTheVps());

const localBackend: Backend = {
  mode: 'local',
  async stat(p) {
    const s = await fs.promises.stat(p);
    return { size: s.size, mtime: Math.floor(s.mtimeMs / 1000), isDir: s.isDirectory() };
  },
  async list(p) {
    const names = await fs.promises.readdir(p);
    const out = await Promise.all(names.map(async (name) => {
      try {
        const s = await fs.promises.stat(posix.join(p, name));
        return { name, dir: s.isDirectory(), size: s.size, mtime: Math.floor(s.mtimeMs / 1000) };
      } catch { return null; }
    }));
    return out.filter((x): x is Entry => !!x);
  },
  read: (p, start, end) => fs.createReadStream(p, { start, end, highWaterMark: 4 << 20 }),
  async exec(cmd) {
    const c = spawn('sh', ['-c', cmd], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      out: c.stdout, err: c.stderr,
      kill: () => { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* already gone */ } },
      closed: new Promise<number>((ok) => { c.on('close', (code) => ok(code ?? -1)); c.on('error', () => ok(-1)); }),
    };
  },
};

let conn: Promise<Client> | null = null;
let sftpP: Promise<SFTPWrapper> | null = null;
const reset = () => { conn = null; sftpP = null; };

function connect(): Promise<Client> {
  if (!conn) {
    conn = new Promise<Client>((ok, no) => {
      if (!fs.existsSync(KEY)) return no(new Error(`SSH key not found at ${KEY}. Set VPS_KEY, or set MODE=local if this app runs on the VPS itself.`));
      const c = new Client();
      c.on('ready', () => ok(c));
      c.on('error', (e) => { reset(); no(e); });
      c.on('close', reset);
      c.connect({
        host: HOST, port: 22, username: USER,
        privateKey: fs.readFileSync(KEY),
        keepaliveInterval: 15000, readyTimeout: 20000,
        // AES-GCM uses the CPU's AES instructions: the fastest cipher family for bulk transfer.
        algorithms: { cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'chacha20-poly1305@openssh.com', 'aes128-ctr', 'aes256-ctr'] },
      } as any);
    });
    conn.catch(() => { conn = null; });
  }
  return conn;
}
function sftp(): Promise<SFTPWrapper> {
  if (!sftpP) {
    sftpP = connect().then((c) => new Promise<SFTPWrapper>((ok, no) => c.sftp((e, s) => (e ? no(e) : ok(s)))));
    sftpP.catch(() => { sftpP = null; });
  }
  return sftpP;
}

// Pipelined SFTP read: many requests in flight at once, so speed is no longer limited by latency.
async function* sftpRange(p: string, start: number, end: number): AsyncGenerator<Buffer> {
  const s = await sftp();
  const handle = await new Promise<Buffer>((ok, no) => s.open(p, 'r', (e, h) => (e ? no(e) : ok(h))));
  const readAt = (pos: number, len: number) => new Promise<Buffer>((ok, no) => {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    const step = () => s.read(handle, buf, got, len - got, pos + got, (e, n) => {
      if (e) return no(e);
      if (!n) return ok(buf.subarray(0, got)); // EOF
      got += n;
      got < len ? step() : ok(buf);
    });
    step();
  });
  try {
    const q: Promise<Buffer>[] = [];
    let next = start;
    const fill = () => {
      while (q.length < WINDOW && next <= end) {
        const len = Math.min(CHUNK, end - next + 1);
        const pr = readAt(next, len);
        pr.catch(() => {});
        q.push(pr);
        next += len;
      }
    };
    fill();
    while (q.length) {
      const b = await q.shift()!;
      fill();
      if (!b.length) break;
      yield b;
    }
  } finally { s.close(handle, () => {}); }
}

const sshBackend: Backend = {
  mode: 'ssh',
  async stat(p) {
    const s = await sftp();
    return new Promise<FileStat>((ok, no) => s.stat(p, (e, x) => (e ? no(e) : ok({ size: x.size, mtime: x.mtime, isDir: x.isDirectory() }))));
  },
  async list(p) {
    const s = await sftp();
    const l = await new Promise<any[]>((ok, no) => s.readdir(p, (e, r) => (e ? no(e) : ok(r))));
    return l.map((f) => ({ name: f.filename as string, dir: (f.attrs.mode & 0o170000) === 0o040000, size: f.attrs.size as number, mtime: f.attrs.mtime as number }));
  },
  read: (p, start, end) => Readable.from(sftpRange(p, start, end), { objectMode: false }),
  async exec(cmd) {
    const c = await connect();
    const ch = await new Promise<ClientChannel>((ok, no) => c.exec(cmd, (e, s) => (e ? no(e) : ok(s))));
    return {
      out: ch, err: ch.stderr,
      kill: () => { try { ch.signal('KILL'); } catch { /* ignore */ } try { ch.close(); } catch { /* ignore */ } },
      closed: new Promise<number>((ok) => ch.on('close', (code: number | null) => ok(code ?? -1))),
    };
  },
};
const B: Backend = useLocal ? localBackend : sshBackend;

const runBuf = async (cmd: string) => {
  const p = await B.exec(cmd);
  const out: Buffer[] = [];
  let err = '';
  p.out.on('data', (d: Buffer) => out.push(d));
  p.err.on('data', (d: Buffer) => { err = (err + d).slice(-2000); });
  const code = await p.closed;
  if (code !== 0) throw new Error(err.trim() || `exit ${code}`);
  return Buffer.concat(out);
};
const runText = async (cmd: string) => (await runBuf(cmd)).toString();

// No MEDIA_ROOTS set: ask Docker where the bot's /app/data volume lives on the VPS.
async function ensureRoots() {
  if (ROOTS.length) return;
  const src = (
    await runText(`docker inspect ${sh(CONTAINER)} --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}'`)
  ).trim();
  if (!src) throw new Error('Could not find the bot data folder. Set MEDIA_ROOTS in .env');
  ROOTS = [{ name: 'Downloads', dir: `${src}/downloads` }, { name: 'Exports', dir: `${src}/exports` }];
}

// =====================================================================================
//  Saved state: watch progress + data usage
// =====================================================================================
type Prog = { pos: number; dur: number; watched: boolean; updated: number };
const STATE = path.join(DATA, 'state.json');
let progress: Record<string, Prog> = {};
try { progress = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* first run */ }
let saveT: NodeJS.Timeout | undefined;
const save = () => {
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
setInterval(flushUsage, 5000).unref();
process.on('exit', flushUsage);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { flushUsage(); process.exit(0); });

// ---------- live network metering (bytes actually handed to the browser) ----------
const net = { total: 0, active: 0, sessions: new Map<string, { bytes: number; seen: number }>() };
const todayKey = () => new Date().toISOString().slice(0, 10);
function add(n: number, sid?: string) {
  net.total += n; usage.lifetime += n;
  const d = todayKey();
  if (!(d in usage.days)) {
    usage.days[d] = 0;
    const keys = Object.keys(usage.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete usage.days[k];
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
setInterval(() => {
  const old = Date.now() - 2 * 3600_000;
  for (const [k, v] of net.sessions) if (v.seen < old) net.sessions.delete(k);
}, 600_000).unref();
const sidOf = (req: Request) => String(req.query.sid ?? '').replace(/[^\w-]/g, '').slice(0, 40) || undefined;

// =====================================================================================
//  Helpers
// =====================================================================================
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};
const SUBEXT = /\.(srt|vtt|ass|ssa)$/i;

// Everything must stay inside a configured root.
function resolve(q: Request['query']) {
  const root = ROOTS[Number(q.root)];
  if (!root) throw new HttpError(400, 'Unknown storage');
  const rel = posix.normalize('/' + String(q.path ?? '')).replace(/^\/+/, '');
  const full = rel ? posix.join(root.dir, rel) : root.dir;
  return { root, full, rel, isRoot: full === root.dir };
}

const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, _n: NextFunction) =>
  fn(req, res).catch((e: any) => {
    if (res.headersSent) return res.end();
    const msg = e?.code === 2 || e?.code === 'ENOENT' || /No such file/i.test(e?.message) ? 'Not found on the server' : e?.message ?? 'Error';
    res.status(e?.status ?? (msg.startsWith('Not found') ? 404 : 500)).json({ error: msg });
  });

// File serving with Range support (direct play + resumable downloads).
async function serveFile(req: Request, res: Response, full: string, download: boolean, sid?: string) {
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
  const name = posix.basename(full);
  req.socket.setNoDelay(true);
  res.writeHead(code, {
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': download ? 'application/octet-stream' : MIME[posix.extname(name).toLowerCase()] ?? 'application/octet-stream',
    ...(code === 206 && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
    ...(download && { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }),
  });
  const rs = B.read(full, start, end);
  meter(res, sid);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
  res.on('close', () => rs.destroy());
}

let zipOk: Promise<boolean> | null = null;
const hasZip = () => (zipOk ??= runText('command -v zip').then(() => true, () => false));

// ---------- optional AI subtitles (needs whisper on the VPS) ----------
let whisperP: Promise<string | null> | null = null;
const getWhisper = () =>
  (whisperP ??= env.WHISPER_CMD
    ? Promise.resolve(env.WHISPER_CMD)
    : runText('command -v whisper-ctranslate2 || command -v whisper').then((s) => s.trim().split('\n')[0] || null, () => null));
type Job = { state: 'running' | 'done' | 'error'; started: number; error?: string };
const jobs = new Map<string, Job>();
const aiDir = (key: string) => `/tmp/screening-room-ai/${key}`;
const aiKey = (full: string, st: FileStat) => createHash('sha1').update(`${full}|${st.mtime}|${st.size}`).digest('hex').slice(0, 20);

const subCache = new Map<string, string>();

// ---------- thumbnails (generated once with ffmpeg, cached on this machine) ----------
const THUMBS = path.join(DATA, 'thumbs');
const makeGate = (limit: number) => {
  let busy = 0;
  const waiting: (() => void)[] = [];
  return {
    acquire: async () => { while (busy >= limit) await new Promise<void>((r) => waiting.push(r)); busy++; },
    release: () => { busy--; waiting.shift()?.(); },
    idle: () => busy < limit && waiting.length === 0,
  };
};
const thumbGate = makeGate(2);
const thumbFail = new Set<string>();

// =====================================================================================
//  App
// =====================================================================================
const app = express();
app.disable('x-powered-by');

// Optional login (set APP_PASSWORD). Required if you expose this beyond localhost.
const PASS = env.APP_PASSWORD;
if (PASS) {
  app.use((req, res, next) => {
    const dec = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    const pw = Buffer.from(dec.slice(dec.indexOf(':') + 1));
    const want = Buffer.from(PASS);
    if (pw.length === want.length && timingSafeEqual(pw, want)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Screening Room"').status(401).send('Login required');
  });
}
app.use(express.json());

// --- routes that do not need the media folders ---
app.get('/api/net', (req, res) => {
  const sid = sidOf(req);
  res.set('Cache-Control', 'no-store').json({
    total: net.total,
    session: sid ? net.sessions.get(sid)?.bytes ?? 0 : 0,
    today: usage.days[todayKey()] ?? 0,
    lifetime: usage.lifetime,
    active: Math.max(net.active, [...net.sessions.values()].filter((x) => Date.now() - x.seen < 15000).length),
    mode: B.mode,
  });
});

// Measures real VPS -> browser throughput (the number that decides how fast streaming/downloads can be).
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

app.use('/api', (_req, res, next) => {
  ensureRoots().then(() => next(), (e) => res.status(500).json({ error: e.message }));
});

app.get('/api/roots', h(async (_req, res) => {
  const out = await Promise.all(ROOTS.map(async (r, id) => {
    let free = 0, total = 0;
    try {
      const f = (await runText(`df -P -k ${sh(r.dir)} | tail -1`)).trim().split(/\s+/);
      total = Number(f[1]) * 1024; free = Number(f[3]) * 1024;
    } catch { /* folder may not exist yet */ }
    return { id, name: r.name, dir: r.dir, free, total };
  }));
  res.json({ host: B.mode === 'local' ? 'this server' : HOST, mode: B.mode, roots: out });
}));

app.get('/api/list', h(async (req, res) => {
  const { full } = resolve(req.query);
  const list = await B.list(full);
  const items = list
    .filter((f) => !f.name.startsWith('.'))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  res.json(items);
}));

app.get('/api/info', h(async (req, res) => {
  const { full } = resolve(req.query);
  const out: any = { duration: 0, audio: [], subs: [], external: [], ai: false };
  try {
    const raw = await runText(`ffprobe -v error -show_entries stream=index,codec_type,codec_name,width,height,bit_rate:stream_tags=language,title:format=duration,bit_rate -of json ${sh(full)}`);
    const j = JSON.parse(raw);
    const st: any[] = j.streams ?? [];
    const v = st.find((x) => x.codec_type === 'video');
    const label = (x: any, i: number) => [x.tags?.title, x.tags?.language].filter(Boolean).join(' · ') || `Track ${i + 1}`;
    const TEXT = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'];
    out.audio = st.filter((x) => x.codec_type === 'audio').map((x, i) => ({ i, label: label(x, i), lang: String(x.tags?.language ?? '') }));
    out.subs = st.filter((x) => x.codec_type === 'subtitle').map((x, i) => ({ x, i }))
      .filter(({ x }) => TEXT.includes(x.codec_name)).map(({ x, i }) => ({ i, label: label(x, i), lang: String(x.tags?.language ?? '') }));
    Object.assign(out, { duration: Number(j.format?.duration) || 0, bitrate: Number(j.format?.bit_rate) || 0, width: v?.width, height: v?.height, codec: v?.codec_name });
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
  out.ai = !!(await getWhisper());
  res.json(out);
}));

// Subtitles as WebVTT: embedded track (?s=N), file next to the video (?ext=name.srt) or AI (?s=ai). Always whole-file, cached.
app.get('/api/subs', h(async (req, res) => {
  const { full } = resolve(req.query);
  const st = await B.stat(full);
  const which = String(req.query.s ?? '0');
  const ext = req.query.ext ? String(req.query.ext) : '';
  let id: string;
  let produce: () => Promise<string>;
  if (ext) {
    if (posix.basename(ext) !== ext || !SUBEXT.test(ext)) throw new HttpError(400, 'Bad subtitle file name');
    const sp = posix.join(posix.dirname(full), ext);
    id = sp;
    produce = () => runText(`ffmpeg -hide_banner -loglevel error -i ${sh(sp)} -f webvtt pipe:1`);
  } else if (which === 'ai') {
    const dir = aiDir(aiKey(full, st));
    id = dir;
    produce = () => runText(`cat ${dir}/*.vtt`);
  } else {
    const n = Math.max(0, Math.floor(Number(which)) || 0);
    id = `${full}#${n}`;
    produce = () => runText(`ffmpeg -hide_banner -loglevel error -i ${sh(full)} -map 0:s:${n} -f webvtt pipe:1`);
  }
  const key = `${id}|${st.mtime}`;
  let vtt = subCache.get(key);
  if (vtt === undefined) {
    vtt = await produce();
    subCache.set(key, vtt);
    if (subCache.size > 60) subCache.delete(subCache.keys().next().value!);
  }
  res.type('text/vtt').set('Cache-Control', 'private, max-age=3600').send(vtt);
}));

app.get('/api/autosub', h(async (req, res) => {
  const { full } = resolve(req.query);
  const st = await B.stat(full);
  const key = aiKey(full, st);
  const w = await getWhisper();
  const job = jobs.get(key);
  let state: string = job?.state ?? 'none';
  if (w && state !== 'running' && state !== 'done') {
    const have = await runText(`ls ${aiDir(key)}/*.vtt`).then(() => true, () => false);
    if (have) state = 'done';
  }
  res.json({ available: !!w, state, error: job?.error, elapsed: job?.state === 'running' ? Math.round((Date.now() - job.started) / 1000) : 0 });
}));

app.post('/api/autosub', h(async (req, res) => {
  const { full } = resolve(req.query);
  const w = await getWhisper();
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
  const { full } = resolve(req.query);
  const st = await B.stat(full);
  const key = createHash('sha1').update(`${full}|${st.mtime}|${st.size}`).digest('hex');
  const file = path.join(THUMBS, `${key}.jpg`);
  const send = (b: Buffer) => res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=2592000, immutable' }).send(b);
  if (fs.existsSync(file)) return send(fs.readFileSync(file));
  if (thumbFail.has(key)) throw new HttpError(404, 'No thumbnail');
  await thumbGate.acquire();
  try {
    const f = sh(full);
    const buf = await runBuf(
      `d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 ${f}); ` +
      `t=$(awk -v d="$d" 'BEGIN{printf "%d", (d>0)?d*0.12:0}'); ` +
      `ffmpeg -hide_banner -loglevel error -ss "$t" -i ${f} -frames:v 1 -vf scale=480:-2 -q:v 4 -f mjpeg pipe:1`,
    );
    if (!buf.length) throw new Error('empty');
    fs.mkdirSync(THUMBS, { recursive: true });
    fs.writeFileSync(file, buf);
    send(buf);
  } catch {
    thumbFail.add(key);
    throw new HttpError(404, 'No thumbnail');
  } finally { thumbGate.release(); }
}));

// =====================================================================================
//  Adaptive streaming (HLS): fixed 6 s segments, cut on demand at several qualities
// =====================================================================================
type Probe = { duration: number; width: number; height: number };
const probeCache = new Map<string, Probe>();
async function probe(full: string, st: FileStat): Promise<Probe> {
  const key = `${full}|${st.mtime}|${st.size}`;
  const hit = probeCache.get(key);
  if (hit) return hit;
  const j = JSON.parse(await runText(`ffprobe -v error -show_entries stream=codec_type,width,height:format=duration -of json ${sh(full)}`));
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
  { h: 240, v: 250_000 }, { h: 360, v: 400_000 }, { h: 480, v: 700_000 }, { h: 720, v: 1_600_000 },
  { h: 1080, v: 3_200_000 }, { h: 1440, v: 6_000_000 }, { h: 2160, v: 12_000_000 },
];
const rateFor = (h: number) => (LADDER.find((l) => l.h >= h) ?? LADDER[LADDER.length - 1]).v;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

// Which renditions to offer. "auto" = every level up to the source height; a number = just that one (never upscaled).
function variantsFor(pr: Probe, q: string) {
  let vs = LADDER.filter((l) => l.h <= pr.height * 1.1);
  if (!vs.length) vs = [{ h: even(pr.height), v: LADDER[0].v }];
  const want = Number(q);
  if (Number.isFinite(want) && want > 0) vs = [[...vs].reverse().find((l) => l.h <= want) ?? vs[0]];
  return vs;
}
function masterPlaylist(pr: Probe, q: string, base: string) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const v of variantsFor(pr, q)) {
    const w = even((pr.width * Math.min(v.h, pr.height)) / pr.height);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round((v.v + 128_000) * 1.1)},RESOLUTION=${w}x${Math.min(v.h, even(pr.height))},NAME="${v.h}p"`,
      `/api/hls/level.m3u8?${base}&h=${v.h}`,
    );
  }
  return lines.join('\n') + '\n';
}
function levelPlaylist(pr: Probe, h: number, base: string) {
  const count = Math.ceil(pr.duration / SEG);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < count; i++) lines.push(`#EXTINF:${Math.min(SEG, pr.duration - i * SEG).toFixed(3)},`, `/api/hls/seg.ts?${base}&h=${h}&n=${i}`);
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
function encodeSeg(full: string, h: number, a: number, n: number, dur: number) {
  const start = n * SEG, len = Math.min(SEG, dur - start), v = rateFor(h);
  // -ss before -i cuts at an exact time, and -output_ts_offset keeps original timestamps, so segments join with no gap or overlap.
  return runBuf(
    `ffmpeg -hide_banner -loglevel error -ss ${start} -i ${sh(full)} -t ${len.toFixed(3)} -map 0:v:0 -map '0:a:${a}?' -sn -dn ` +
    `-c:v libx264 -preset ${PRESET} -profile:v high -pix_fmt yuv420p -crf 28 -maxrate ${v} -bufsize ${v * 2} -threads 0 ` +
    `-vf "scale=-2:'min(ih,${h})'" -c:a aac -ac 2 -ar 44100 -b:a 64k ` +
    `-f mpegts -output_ts_offset ${start} -muxdelay 0 -muxpreload 0 pipe:1`,
  );
}
const hlsBase = (req: Request) => {
  const sid = sidOf(req);
  return new URLSearchParams({
    root: String(req.query.root ?? ''), path: String(req.query.path ?? ''),
    a: String(Math.max(0, Math.floor(Number(req.query.a)) || 0)), ...(sid && { sid }),
  }).toString();
};

app.get('/api/hls/master.m3u8', h(async (req, res) => {
  const { full } = resolve(req.query);
  const pr = await probe(full, await B.stat(full));
  res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(masterPlaylist(pr, String(req.query.q ?? 'auto'), hlsBase(req)));
}));
app.get('/api/hls/level.m3u8', h(async (req, res) => {
  const { full } = resolve(req.query);
  const H = Math.floor(Number(req.query.h));
  if (!(H >= 100 && H <= 4320)) throw new HttpError(400, 'Bad quality');
  const pr = await probe(full, await B.stat(full));
  res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(levelPlaylist(pr, H, hlsBase(req)));
}));
app.get('/api/hls/seg.ts', h(async (req, res) => {
  const { full } = resolve(req.query);
  const st = await B.stat(full);
  const pr = await probe(full, st);
  const H = Math.floor(Number(req.query.h));
  const n = Math.floor(Number(req.query.n));
  const a = Math.max(0, Math.floor(Number(req.query.a)) || 0);
  const count = Math.ceil(pr.duration / SEG);
  if (!(H >= 100 && H <= 4320) || !(n >= 0 && n < count)) throw new HttpError(400, 'Bad segment');
  const keyOf = (i: number) => `${full}|${st.mtime}|${H}|${a}|${i}`;
  const buf = await wantSeg(keyOf(n), () => encodeSeg(full, H, a, n, pr.duration), res);
  add(buf.length, sidOf(req));
  res.set({ 'Content-Type': 'video/mp2t', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=600' }).end(buf);
  // Have the next piece ready while this one plays, but only when the CPU has nothing else to do.
  if (n + 1 < count && hlsGate.idle()) wantSeg(keyOf(n + 1), () => encodeSeg(full, H, a, n + 1, pr.duration)).catch(() => {});
}));

// =====================================================================================
//  Seek-bar preview sprites: one JPEG sheet of small frames, built once per video
// =====================================================================================
const SPRITES = path.join(DATA, 'sprites');
const spriteGate = makeGate(1);
const spriteJobs = new Map<string, { state: 'building' | 'error'; error?: string }>();
async function buildSprite(full: string, st: FileStat, key: string) {
  await spriteGate.acquire();
  try {
    const pr = await probe(full, st);
    const interval = Math.max(2, Math.ceil(pr.duration / 100));
    const count = Math.max(1, Math.ceil(pr.duration / interval));
    const cols = Math.min(10, count), rows = Math.ceil(count / cols), W = 160, Hh = 90;
    // Only key frames are decoded, so a whole movie takes seconds instead of minutes.
    const buf = await runBuf(
      `nice -n 10 ffmpeg -hide_banner -loglevel error -skip_frame nokey -i ${sh(full)} -an -sn -dn ` +
      `-vf "fps=1/${interval},scale=${W}:${Hh}:force_original_aspect_ratio=decrease,pad=${W}:${Hh}:(ow-iw)/2:(oh-ih)/2,tile=${cols}x${rows}" ` +
      `-frames:v 1 -q:v 6 -f mjpeg pipe:1`,
    );
    if (!buf.length) throw new Error('No frames could be read');
    fs.mkdirSync(SPRITES, { recursive: true });
    fs.writeFileSync(path.join(SPRITES, `${key}.jpg`), buf);
    fs.writeFileSync(path.join(SPRITES, `${key}.json`), JSON.stringify({ interval, cols, rows, w: W, h: Hh, count }));
  } finally { spriteGate.release(); }
}
app.get('/api/sprite', h(async (req, res) => {
  const { full } = resolve(req.query);
  const st = await B.stat(full);
  const key = createHash('sha1').update(`${full}|${st.mtime}|${st.size}`).digest('hex');
  const img = path.join(SPRITES, `${key}.jpg`), meta = path.join(SPRITES, `${key}.json`);
  const ready = fs.existsSync(img) && fs.existsSync(meta);
  if (req.query.img) {
    if (!ready) throw new HttpError(404, 'No preview yet');
    return res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=2592000, immutable' }).send(fs.readFileSync(img));
  }
  if (ready) return res.json({ state: 'ready', ...JSON.parse(fs.readFileSync(meta, 'utf8')) });
  let job = spriteJobs.get(key);
  if (!job) {
    const j: { state: 'building' | 'error'; error?: string } = { state: 'building' };
    spriteJobs.set(key, j);
    job = j;
    buildSprite(full, st, key).then(() => spriteJobs.delete(key)).catch((e) => { j.state = 'error'; j.error = e.message; });
  }
  res.json({ state: job.state, error: job.error });
}));

app.get('/api/progress', (_req, res) => res.json(progress));
app.post('/api/progress', (req, res) => {
  const { key, pos, dur, watched } = req.body ?? {};
  if (typeof key !== 'string') return res.status(400).json({ error: 'Bad request' });
  const o = progress[key];
  const d = Number(dur) || o?.dur || 0;
  const p = Number(pos) || 0;
  const done = typeof watched === 'boolean' ? watched : (o?.watched ?? false) || (d > 0 && p / d > 0.9);
  progress[key] = { pos: p, dur: d, watched: done, updated: Date.now() };
  save();
  res.json({ ok: true });
});

// Modes: orig = direct file. remux = copy video, fix audio (no re-encode). 360..2160 = H.264 conversion.
app.get('/api/stream', h(async (req, res) => {
  const { full } = resolve(req.query);
  const q = String(req.query.q ?? 'orig');
  const sid = sidOf(req);
  if (q === 'orig') return serveFile(req, res, full, false, sid);
  const t = Math.max(0, Number(req.query.t) || 0);
  const a = Math.max(0, Math.floor(Number(req.query.a)) || 0);
  const input = `${t ? `-ss ${t} ` : ''}-i ${sh(full)} -map 0:v:0 -map '0:a:${a}?' -sn -dn`;
  const tail = `-movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1`;
  let cmd: string;
  if (q === 'remux') {
    cmd = `ffmpeg -hide_banner -loglevel error ${input} -c:v copy -c:a aac -ac 2 -b:a 192k -avoid_negative_ts make_zero ${tail}`;
  } else {
    const H = Number(q);
    if (![240, 360, 480, 720, 1080, 1440, 2160].includes(H)) throw new HttpError(400, 'Bad quality');
    cmd = `ffmpeg -hide_banner -loglevel error ${input} -c:v libx264 -preset ${PRESET} -crf 28 -maxrate ${rateFor(H)} -bufsize ${rateFor(H) * 2} -pix_fmt yuv420p -threads 0 ` +
      `-vf "scale=-2:'min(ih,${H})'" -c:a aac -ac 2 -b:a 64k ${tail}`;
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
  const { full, isRoot } = resolve(req.query);
  const st = await B.stat(full);
  if (!st.isDir) return serveFile(req, res, full, true, sidOf(req));
  const zip = await hasZip();
  const name = `${isRoot ? 'media' : posix.basename(full)}${zip ? '.zip' : '.tar'}`;
  const p = await B.exec(`cd ${sh(full)} && exec ${zip ? 'zip -0 -r -q - .' : 'tar -cf - .'}`);
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
  const { root, rel, full, isRoot } = resolve(req.query);
  if (isRoot) throw new HttpError(400, 'A storage root cannot be deleted');
  await runText(`rm -rf -- ${sh(full)}`);
  const k = `${root.name}:${rel}`;
  for (const key of Object.keys(progress)) if (key === k || key.startsWith(k + '/')) delete progress[key];
  save();
  res.json({ ok: true });
}));

const dist = path.resolve(HERE, '../dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Localhost by default on purpose: this app holds root access to your VPS.
const server = app.listen(PORT, BIND, () =>
  console.log(`Screening Room on http://${BIND}:${PORT} · ${B.mode === 'local' ? 'LOCAL disk mode (fastest)' : `SSH mode → ${USER}@${HOST}`}`));
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;