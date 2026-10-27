import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Secrets (passwords, pasted keys) are encrypted with the operating system's keychain when the
// desktop app provides one. Without it (plain browser/dev mode) they are only obscured, so keep
// that mode on a machine you trust.
export type Crypt = { encrypt(s: string): string; decrypt(s: string): string };
export const plainCrypt: Crypt = {
  encrypt: (s) => 'plain:' + Buffer.from(s, 'utf8').toString('base64'),
  decrypt: (s) => (s.startsWith('plain:') ? Buffer.from(s.slice(6), 'base64').toString('utf8') : s),
};

export type Root = { name: string; dir: string };
export type Server = {
  id: string; name: string; host: string; port: number; user: string;
  auth: 'key' | 'password';
  keyPath?: string; keySecret?: string; passSecret?: string; phraseSecret?: string;
  container?: string; roots?: Root[];
};
export type ServerInput = Omit<Server, 'id' | 'keySecret' | 'passSecret' | 'phraseSecret'> & {
  id?: string; keyText?: string; password?: string; passphrase?: string;
};
export type PublicServer = Omit<Server, 'keySecret' | 'passSecret' | 'phraseSecret'> & { hasKeyText: boolean; hasPassword: boolean };

export type Settings = {
  downloadDir: string; maxParallel: number; limitKBps: number;
  schedule: { on: boolean; from: string; to: string };
  budgetGB: number; autoDeleteDays: number; quotaGB: number;
  encodeWhere: 'auto' | 'laptop' | 'server'; encodeSpeed: 'fast' | 'balanced' | 'small';
  pauseOnBattery: boolean; pauseOnMetered: boolean; limitWin: { on: boolean; from: string; to: string; kbps: number };
  tmdbKey: string; osKey: string; osUser: string; osPassSecret?: string;
};

type Db = { active: string; servers: Server[]; settings: Partial<Settings> };

function readJson<T>(file: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return fallback; }
}
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class Store {
  private db: Db;
  private prefs: Record<string, unknown>;
  private prefsT?: NodeJS.Timeout;
  private readonly dbFile: string;
  private prefsFile: string;
  private dataDirPath: string;

  constructor(private dataDir: string, private crypt: Crypt = plainCrypt, private defaultDownloadDir: string) {
    this.dbFile = path.join(dataDir, 'servers.json');
    this.dataDirPath = dataDir;
    this.prefsFile = path.join(dataDir, 'prefs.json');
    this.db = readJson<Db>(this.dbFile, { active: '', servers: [], settings: {} });
    this.prefs = readJson<Record<string, unknown>>(this.prefsFile, {});
  }
  private save() { writeJson(this.dbFile, this.db); }

  // ---------- servers ----------
  list(): Server[] { return this.db.servers; }
  get(id: string) { return this.db.servers.find((s) => s.id === id); }
  activeId() { return this.db.servers.some((s) => s.id === this.db.active) ? this.db.active : this.db.servers[0]?.id ?? ''; }
  active() { return this.get(this.activeId()); }
  setActive(id: string) { if (this.get(id)) { this.db.active = id; this.save(); } }

  pub(s: Server): PublicServer {
    const { keySecret, passSecret, phraseSecret, ...rest } = s;
    return { ...rest, hasKeyText: !!keySecret, hasPassword: !!passSecret };
  }

  /** Builds a server record from form input without saving it (used by "Test connection"). */
  draft(i: ServerInput): Server {
    const old = i.id ? this.get(i.id) : undefined;
    const s: Server = {
      id: old?.id ?? randomBytes(6).toString('hex'),
      name: (i.name || i.host).trim(),
      host: i.host.trim(), port: Number(i.port) || 22, user: (i.user || 'root').trim(),
      auth: i.auth === 'password' ? 'password' : 'key',
      keyPath: i.keyPath?.trim() || undefined,
      container: i.container?.trim() || undefined,
      roots: i.roots?.length ? i.roots : undefined,
      // keep the old secret unless the user typed a new one
      keySecret: i.keyText?.trim() ? this.crypt.encrypt(i.keyText.trim() + '\n') : old?.keySecret,
      passSecret: i.password ? this.crypt.encrypt(i.password) : old?.passSecret,
      phraseSecret: i.passphrase ? this.crypt.encrypt(i.passphrase) : old?.phraseSecret,
    };
    if (s.auth === 'password') { s.keySecret = undefined; s.keyPath = undefined; s.phraseSecret = undefined; }
    else s.passSecret = undefined;
    return s;
  }
  upsert(i: ServerInput): Server {
    const s = this.draft(i);
    const old = this.get(s.id);
    if (old) this.db.servers = this.db.servers.map((x) => (x.id === s.id ? s : x));
    else this.db.servers.push(s);
    if (!this.db.active) this.db.active = s.id;
    this.save();
    return s;
  }
  remove(id: string) {
    this.db.servers = this.db.servers.filter((s) => s.id !== id);
    if (this.db.active === id) this.db.active = this.db.servers[0]?.id ?? '';
    this.save();
  }
  secrets(s: Server) {
    const d = (x?: string) => (x ? this.crypt.decrypt(x) : undefined);
    let privateKey = d(s.keySecret);
    if (!privateKey && s.auth === 'key' && s.keyPath) {
      const p = s.keyPath.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
      if (!fs.existsSync(p)) throw new Error(`SSH key file not found: ${s.keyPath}`);
      privateKey = fs.readFileSync(p, 'utf8');
    }
    return { privateKey, password: d(s.passSecret), passphrase: d(s.phraseSecret) };
  }

  // ---------- server-side settings ----------
  settings(): Settings {
    const o = this.db.settings;
    return {
      downloadDir: o.downloadDir || this.defaultDownloadDir,
      maxParallel: Math.min(6, Math.max(1, o.maxParallel ?? 2)),
      limitKBps: Math.max(0, o.limitKBps ?? 0),
      schedule: { on: false, from: '01:00', to: '07:00', ...(o.schedule ?? {}) },
      budgetGB: Math.max(0, o.budgetGB ?? 0),
      autoDeleteDays: Math.max(0, o.autoDeleteDays ?? 0),
      quotaGB: Math.max(0, o.quotaGB ?? 0),
      pauseOnBattery: !!o.pauseOnBattery,
      pauseOnMetered: !!o.pauseOnMetered,
      limitWin: { on: !!o.limitWin?.on, from: o.limitWin?.from ?? '18:00', to: o.limitWin?.to ?? '23:00', kbps: Math.max(0, Number(o.limitWin?.kbps) || 0) },
      encodeWhere: (['auto', 'laptop', 'server'] as const).includes(o.encodeWhere as any) ? o.encodeWhere! : 'auto',
      encodeSpeed: (['fast', 'balanced', 'small'] as const).includes(o.encodeSpeed as any) ? o.encodeSpeed! : 'fast',
      tmdbKey: o.tmdbKey ?? '', osKey: o.osKey ?? '', osUser: o.osUser ?? '', osPassSecret: o.osPassSecret,
    };
  }
  publicSettings() {
    const { osPassSecret, ...rest } = this.settings();
    return { ...rest, hasOsPass: !!osPassSecret };
  }
  patchSettings(p: Partial<Settings> & { osPass?: string }) {
    const { osPass, ...rest } = p;
    const next: Partial<Settings> = { ...this.db.settings };
    for (const k of Object.keys(rest) as (keyof Settings)[]) if (rest[k] !== undefined) (next as any)[k] = rest[k];
    if (osPass !== undefined) next.osPassSecret = osPass ? this.crypt.encrypt(osPass) : undefined;
    this.db.settings = next;
    this.save();
  }
  osPassword() { const s = this.settings().osPassSecret; return s ? this.crypt.decrypt(s) : ''; }

  // ---------- UI preferences (settings, favourites, per-video sound, bookmarks) ----------
  allPrefs() { return this.prefs; }
  setPref(key: string, value: unknown) {
    if (!/^[\w.-]{1,40}$/.test(key)) return;
    this.prefs[key] = value;
    clearTimeout(this.prefsT);
    this.prefsT = setTimeout(() => { try { writeJson(this.prefsFile, this.prefs); } catch { /* ignore */ } }, 300);
  }
  /** Switch to another profile's preferences (favourites, playlists, collections ...). */
  switchProfile(id: string) {
    this.flush();
    this.prefsFile = path.join(this.dataDirPath, id === 'default' ? 'prefs.json' : `prefs.${id}.json`);
    const keep: Record<string, unknown> = {};
    for (const k of ['dlsched', 'dlrules', 'introfp']) if (k in this.prefs) keep[k] = this.prefs[k];
    this.prefs = { ...readJson<Record<string, unknown>>(this.prefsFile, {}), ...keep };
  }
  flush() { clearTimeout(this.prefsT); try { writeJson(this.prefsFile, this.prefs); } catch { /* ignore */ } }
}