import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import path from 'node:path';
import { getCiphers } from 'node:crypto';

export type FileStat = { size: number; mtime: number; isDir: boolean };
export type Entry = { name: string; dir: boolean; size: number; mtime: number };
export type Proc = { out: Readable; err: Readable; kill: () => void; closed: Promise<number> };

export interface Backend {
  mode: 'local' | 'ssh';
  stat(p: string): Promise<FileStat>;
  list(p: string): Promise<Entry[]>;
  read(p: string, start: number, end: number): Readable;
  exec(cmd: string): Promise<Proc>;
  close(): void;
}

export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------- local disk (the laptop's own files, or the VPS when the app runs there) ----------
export function makeLocalBackend(opts: { shell?: boolean } = {}): Backend {
  const shell = opts.shell ?? process.platform !== 'win32';
  return {
    mode: 'local',
    async stat(p) {
      const s = await fs.promises.stat(p);
      return { size: s.size, mtime: Math.floor(s.mtimeMs / 1000), isDir: s.isDirectory() };
    },
    async list(p) {
      const names = await fs.promises.readdir(p);
      const out = await Promise.all(names.map(async (name) => {
        try {
          const full = path.join(p, name);
          const l = await fs.promises.lstat(full);
          // A symlinked folder is the usual cause of endless "Season 03/Season 03/Season 03" nesting
          // (a link that points back into itself), so linked folders are never listed or followed.
          if (l.isSymbolicLink()) {
            const s = await fs.promises.stat(full);
            if (s.isDirectory()) return null;
            return { name, dir: false, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) };
          }
          return { name, dir: l.isDirectory(), size: l.size, mtime: Math.floor(l.mtimeMs / 1000) };
        } catch { return null; }
      }));
      return out.filter((x): x is Entry => !!x);
    },
    read: (p, start, end) => fs.createReadStream(p, { start, end, highWaterMark: 4 << 20 }),
    async exec(cmd) {
      if (!shell) throw new Error('Running shell commands is not available for this storage');
      const c = spawn('sh', ['-c', cmd], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      return {
        out: c.stdout, err: c.stderr,
        kill: () => { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* already gone */ } },
        closed: new Promise<number>((ok) => { c.on('close', (code) => ok(code ?? -1)); c.on('error', () => ok(-1)); }),
      };
    },
    close() { /* nothing to close */ },
  };
}

// ---------- SSH / SFTP ----------
export type SshCfg = {
  host: string; port: number; user: string;
  privateKey?: string; passphrase?: string; password?: string;
};
export type SshTune = { chunkKb: number; window: number };

// Fastest first. Electron's crypto library lacks some ciphers that plain Node has, and ssh2 refuses to connect
// if we name one the runtime cannot do, so only offer what this runtime supports.
const CIPHERS: [string, string][] = [
  ['aes128-gcm@openssh.com', 'aes-128-gcm'], ['aes256-gcm@openssh.com', 'aes-256-gcm'],
  ['chacha20-poly1305@openssh.com', 'chacha20-poly1305'], ['aes128-ctr', 'aes-128-ctr'], ['aes256-ctr', 'aes-256-ctr'],
];
function cipherList(): string[] {
  const have = new Set(getCiphers());
  const ok = CIPHERS.filter(([, n]) => have.has(n)).map(([s]) => s);
  return ok.length ? ok : CIPHERS.slice(3).map(([s]) => s);
}

export function makeSshBackend(cfg: SshCfg, tune: SshTune): Backend {
  const CHUNK = Math.max(32, tune.chunkKb) * 1024;
  const WINDOW = Math.max(4, tune.window);
  let conn: Promise<Client> | null = null;
  let sftpP: Promise<SFTPWrapper> | null = null;
  let client: Client | null = null;
  const reset = () => { conn = null; sftpP = null; client = null; };

  function connect(): Promise<Client> {
    if (!conn) {
      conn = new Promise<Client>((ok, no) => {
        const c = new Client();
        c.on('ready', () => { client = c; ok(c); });
        c.on('error', (e) => { reset(); no(e); });
        c.on('close', reset);
        c.connect({
          host: cfg.host, port: cfg.port, username: cfg.user,
          ...(cfg.privateKey ? { privateKey: cfg.privateKey, passphrase: cfg.passphrase } : {}),
          ...(cfg.password ? { password: cfg.password } : {}),
          keepaliveInterval: 15000, readyTimeout: 20000,
          // AES-GCM uses the CPU's AES instructions: the fastest cipher family for bulk transfer.
          algorithms: { cipher: cipherList() },
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

  return {
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
    close() { try { client?.end(); } catch { /* ignore */ } reset(); },
  };
}

export async function runBuf(B: Backend, cmd: string): Promise<Buffer> {
  const p = await B.exec(cmd);
  const out: Buffer[] = [];
  let err = '';
  p.out.on('data', (d: Buffer) => out.push(d));
  p.err.on('data', (d: Buffer) => { err = (err + d).slice(-2000); });
  const code = await p.closed;
  if (code !== 0) throw new Error(err.trim() || `exit ${code}`);
  return Buffer.concat(out); 
}
export const runText = async (B: Backend, cmd: string) => (await runBuf(B, cmd)).toString();

export const makeGate = (limit: number) => {
  let busy = 0;
  const waiting: (() => void)[] = [];
  return {
    acquire: async () => { while (busy >= limit) await new Promise<void>((r) => waiting.push(r)); busy++; },
    release: () => { busy--; waiting.shift()?.(); },
    idle: () => busy < limit && waiting.length === 0,
  };
};