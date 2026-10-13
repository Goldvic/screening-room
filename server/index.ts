import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { Client, ClientChannel, SFTPWrapper, Stats } from 'ssh2';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const HOST = env.VPS_HOST ?? '139.162.182.113';
const USER = env.VPS_USER ?? 'root';
const KEY = (env.VPS_KEY ?? '~/.ssh/Traqor.pem').replace(/^~/, os.homedir());
const PORT = Number(env.PORT ?? 3001);
type Root = { name: string; dir: string };
const BIND = env.BIND ?? '127.0.0.1';
const CONTAINER = env.BOT_CONTAINER ?? 'media-downloader-bot';
let ROOTS: Root[] = (env.MEDIA_ROOTS ?? '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [name, ...rest] = s.split('=');
    return { name: name.trim(), dir: posix.normalize(rest.join('=').trim()).replace(/\/+$/, '') };
  });

// No MEDIA_ROOTS set: ask Docker where the bot's /app/data volume lives on the VPS.
async function ensureRoots() {
  if (ROOTS.length) return;
  const src = (
    await runText(`docker inspect ${sh(CONTAINER)} --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}'`)
  ).trim();
  if (!src) throw new Error('Could not find the bot data folder. Set MEDIA_ROOTS in .env');
  ROOTS = [{ name: 'Downloads', dir: `${src}/downloads` }, { name: 'Exports', dir: `${src}/exports` }];
}

// ---------- watch progress, saved on the server so it follows you to any device ----------
type Prog = { pos: number; dur: number; watched: boolean; updated: number };
const STATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/state.json');
let progress: Record<string, Prog> = {};
try { progress = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* first run */ }
let saveT: NodeJS.Timeout | undefined;
const save = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(progress)); }, 400);
};

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------- SSH connection (kept alive, reconnects on demand) ----------
let conn: Promise<Client> | null = null;
let sftpP: Promise<SFTPWrapper> | null = null;
const reset = () => { conn = null; sftpP = null; };

function connect(): Promise<Client> {
  conn ??= new Promise<Client>((ok, no) => {
    const c = new Client();
    c.on('ready', () => ok(c));
    c.on('error', (e) => { reset(); no(e); });
    c.on('close', reset);
    c.connect({
      host: HOST, port: 22, username: USER,
      privateKey: fs.readFileSync(KEY),
      keepaliveInterval: 15000, readyTimeout: 20000,
    });
  });
  return conn;
}
const sftp = () =>
  (sftpP ??= connect().then((c) => new Promise<SFTPWrapper>((ok, no) => c.sftp((e, s) => (e ? no(e) : ok(s))))));
const run = (cmd: string) =>
  connect().then((c) => new Promise<ClientChannel>((ok, no) => c.exec(cmd, (e, s) => (e ? no(e) : ok(s)))));
const runText = (cmd: string) =>
  run(cmd).then((ch) => new Promise<string>((ok, no) => {
    const out: Buffer[] = [];
    let err = '';
    ch.on('data', (d: Buffer) => out.push(d));
    ch.stderr.on('data', (d: Buffer) => (err += d));
    ch.on('close', (code: number) => (code === 0 ? ok(Buffer.concat(out).toString()) : no(new Error(err.trim() || `exit ${code}`))));
  }));
const stat = (p: string) =>
  sftp().then((s) => new Promise<Stats>((ok, no) => s.stat(p, (e, x) => (e ? no(e) : ok(x)))));

// ---------- path safety: everything must stay inside a configured root ----------
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
    const msg = e?.code === 2 || /No such file/i.test(e?.message) ? 'Not found on the server' : e?.message ?? 'Error';
    res.status(e?.status ?? (msg.startsWith('Not found') ? 404 : 500)).json({ error: msg });
  });

// ---------- file serving with Range support (direct play, any resolution) ----------
async function serveFile(req: Request, res: Response, full: string, download: boolean) {
  const s = await sftp();
  const st = await stat(full);
  if (st.isDirectory()) throw new HttpError(400, 'That is a folder');
  const size = st.size;
  let start = 0, end = size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], size - 1); }
    else start = Math.max(0, size - +m[2]);
    if (start > end) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
    code = 206;
  }
  const name = posix.basename(full);
  res.writeHead(code, {
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': download ? 'application/octet-stream' : MIME[posix.extname(name).toLowerCase()] ?? 'application/octet-stream',
    ...(code === 206 && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
    ...(download && { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }),
  });
  const rs = s.createReadStream(full, { start, end, highWaterMark: 1 << 20 });
  rs.pipe(res);
  res.on('close', () => rs.destroy());
}

let zipOk: Promise<boolean> | null = null;
const hasZip = () => (zipOk ??= runText('command -v zip').then(() => true, () => false));

const app = express();

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
  res.json({ host: HOST, roots: out });
}));

app.get('/api/list', h(async (req, res) => {
  const { full } = resolve(req.query);
  const s = await sftp();
  const list = await new Promise<any[]>((ok, no) => s.readdir(full, (e, l) => (e ? no(e) : ok(l))));
  const items = list
    .filter((f) => !f.filename.startsWith('.'))
    .map((f) => ({ name: f.filename as string, dir: (f.attrs.mode & 0o170000) === 0o040000, size: f.attrs.size as number, mtime: f.attrs.mtime as number }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  res.json(items);
}));

app.get('/api/info', h(async (req, res) => {
  const { full } = resolve(req.query);
  try {
    const out = await runText(`ffprobe -v error -show_entries stream=index,codec_type,codec_name,width,height:stream_tags=language,title:format=duration -of json ${sh(full)}`);
    const j = JSON.parse(out);
    const st: any[] = j.streams ?? [];
    const v = st.find((x) => x.codec_type === 'video');
    const label = (x: any, i: number) => [x.tags?.title, x.tags?.language].filter(Boolean).join(' · ') || `Track ${i + 1}`;
    const TEXT = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'];
    const audio = st.filter((x) => x.codec_type === 'audio').map((x, i) => ({ i, label: label(x, i) }));
    const subs = st.filter((x) => x.codec_type === 'subtitle').map((x, i) => ({ x, i }))
      .filter(({ x }) => TEXT.includes(x.codec_name)).map(({ x, i }) => ({ i, label: label(x, i) }));
    res.json({ duration: Number(j.format?.duration) || 0, width: v?.width, height: v?.height, codec: v?.codec_name, audio, subs });
  } catch { res.json({ duration: 0, audio: [], subs: [] }); }
}));

app.get('/api/subs', h(async (req, res) => {
  const { full } = resolve(req.query);
  const n = Math.max(0, Number(req.query.s) || 0);
  const t = Math.max(0, Number(req.query.t) || 0);
  const vtt = await runText(`ffmpeg -hide_banner -loglevel error -ss ${t} -i ${sh(full)} -map 0:s:${n} -f webvtt pipe:1`);
  res.type('text/vtt').send(vtt);
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

app.get('/api/stream', h(async (req, res) => {
  const { full } = resolve(req.query);
  const q = String(req.query.q ?? 'orig');
  if (q === 'orig') return serveFile(req, res, full, false);
  const H = Number(q);
  if (![480, 720, 1080, 1440, 2160].includes(H)) throw new HttpError(400, 'Bad quality');
  const t = Math.max(0, Number(req.query.t) || 0);
  const cmd =
    `ffmpeg -hide_banner -loglevel error -ss ${t} -i ${sh(full)} -map 0:v:0 -map '0:a:${Math.max(0, Number(req.query.a) || 0)}?' ` +
    `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -vf "scale=-2:'min(ih,${H})'" ` +
    `-c:a aac -ac 2 -b:a 192k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1`;
  const ch = await run(cmd);
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
  ch.stderr.on('data', () => {});
  ch.pipe(res);
  res.on('close', () => ch.close());
}));

app.get('/api/download', h(async (req, res) => {
  const { full, isRoot } = resolve(req.query);
  const st = await stat(full);
  if (!st.isDirectory()) return serveFile(req, res, full, true);
  const zip = await hasZip();
  const name = `${isRoot ? 'media' : posix.basename(full)}${zip ? '.zip' : '.tar'}`;
  const ch = await run(`cd ${sh(full)} && ${zip ? 'zip -0 -r -q - .' : 'tar -cf - .'}`);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  ch.stderr.on('data', () => {});
  ch.pipe(res);
  res.on('close', () => ch.close());
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

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Localhost by default on purpose: this app holds root access to your VPS.
app.listen(PORT, BIND, () => console.log(`Screening Room on http://${BIND}:${PORT} · ${USER}@${HOST}`));