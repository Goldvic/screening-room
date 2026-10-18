import { createContext, useEffect, useRef, useState } from 'react';

// ---------- types ----------
export type Entry = { name: string; dir: boolean; size: number; mtime: number };
export type Root = { id: number; name: string; dir: string; free: number; total: number; offline?: boolean; opened?: boolean };
export type Prog = { pos: number; dur: number; watched: boolean; updated: number };
export type Track = { i: number; label: string; lang: string; channels?: number };
export type Ext = { name: string; label: string; lang: string };
export type Chapter = { start: number; end: number; title: string };
export type Info = {
  duration: number; width?: number; height?: number; codec?: string; bitrate?: number; fps?: number; channels?: number;
  audio?: Track[]; subs?: Track[]; external?: Ext[]; ai?: boolean; chapters?: Chapter[]; size?: number; origin?: { rootName: string; rel: string };
};
export type Caps = {
  local: { ffmpeg: boolean; ffprobe: boolean };
  remote: { ffmpeg: boolean; h264: boolean; hevc: boolean; av1: boolean };
  platform: string; embedded: boolean; hasServer: boolean;
};

export const APP_NAME = 'Cinema';
export const OFFLINE_ID = 1000;
export const OPENED_ID = 1001;  // "Opened files": videos opened from Explorer, drag and drop or Open file

export type UpdateState = {
  state: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error';
  version: string; percent: number; error: string; current: string; feed: string; auto: boolean; packaged: boolean;
};
export const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'];

// The desktop app (Electron) exposes a small bridge; in a normal browser it is undefined.
export type Bridge = {
  selectFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  selectFiles(filters?: { name: string; extensions: string[] }[]): Promise<string[]>;
  selectFolder(): Promise<string | null>;
  powerSave(on: boolean): Promise<void>;
  miniPlayer(on: boolean): Promise<void>;
  openExternal(file: string, player?: string): Promise<string>;
  openStream(apiPath: string, player?: string): Promise<string>;
  reveal(file: string): Promise<void>;
  pathForFile(file: File): string;
  takePendingOpen(): Promise<string | null>;
  onOpenFile(cb: (file: string) => void): () => void;
  updateGet(): Promise<UpdateState>;
  updateConfig(cfg: { feed?: string; auto?: boolean }): Promise<UpdateState>;
  updateCheck(): Promise<void>;
  updateDownload(): Promise<void>;
  updateInstall(): Promise<void>;
  onUpdate(cb: (s: UpdateState) => void): () => void;
  openFolder(dir: string): Promise<void>;
  version: string;
};
export const bridge: Bridge | undefined = typeof window !== 'undefined' ? (window as any).cinema : undefined;

// ---------- constants ----------
export const VIDEO = /\.(mp4|mkv|webm|mov|avi|m4v)$/i;
export const QUALITIES: { id: string; label: string; hint: string }[] = [
  { id: 'audio', label: 'Audio only', hint: 'Sound without the picture. Uses almost no data (about 30 MB per hour)' },
  { id: 'auto', label: 'Auto', hint: 'Adapts to your connection (360p up to the source). Instant seeking' },
  { id: 'orig', label: 'Original', hint: 'Direct play. No conversion, lightest on the server' },
  { id: 'remux', label: 'Original + fixed audio', hint: 'Keeps the video untouched, converts audio. Fixes silent MKV files' },
  { id: '2160', label: '4K', hint: 'Locked to this size, converted on the VPS' },
  { id: '1440', label: '1440p', hint: 'Locked to this size, converted on the VPS' },
  { id: '1080', label: '1080p', hint: 'Locked to this size, converted on the VPS' },
  { id: '720', label: '720p', hint: 'Locked, lower data use' },
  { id: '480', label: '480p', hint: 'Locked, low data use' },
  { id: '360', label: '360p', hint: 'Locked, minimum data use' },
];
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
export const ASPECTS: { id: string; label: string; hint: string }[] = [
  { id: 'fit', label: 'Fit', hint: 'Whole picture, black bars if needed' },
  { id: 'fill', label: 'Fill screen', hint: 'Zooms in to remove black bars (crops edges)' },
  { id: 'stretch', label: 'Stretch', hint: 'Fills the screen, picture is distorted' },
  { id: '16:9', label: '16:9', hint: 'Force widescreen' },
  { id: '21:9', label: '21:9', hint: 'Force ultrawide cinema' },
  { id: '4:3', label: '4:3', hint: 'Force classic TV' },
  { id: '1:1', label: '1:1', hint: 'Force square' },
];
export const LANGS: { code: string; name: string; alts: string[] }[] = [
  { code: 'en', name: 'English', alts: ['en', 'eng', 'english'] },
  { code: 'es', name: 'Spanish', alts: ['es', 'spa', 'spanish', 'esp'] },
  { code: 'fr', name: 'French', alts: ['fr', 'fre', 'fra', 'french'] },
  { code: 'de', name: 'German', alts: ['de', 'ger', 'deu', 'german'] },
  { code: 'it', name: 'Italian', alts: ['it', 'ita', 'italian'] },
  { code: 'pt', name: 'Portuguese', alts: ['pt', 'por', 'portuguese', 'pob'] },
  { code: 'ru', name: 'Russian', alts: ['ru', 'rus', 'russian'] },
  { code: 'ar', name: 'Arabic', alts: ['ar', 'ara', 'arabic'] },
  { code: 'tr', name: 'Turkish', alts: ['tr', 'tur', 'turkish'] },
  { code: 'hi', name: 'Hindi', alts: ['hi', 'hin', 'hindi'] },
  { code: 'ur', name: 'Urdu', alts: ['ur', 'urd', 'urdu'] },
  { code: 'fa', name: 'Persian', alts: ['fa', 'per', 'fas', 'persian'] },
  { code: 'ja', name: 'Japanese', alts: ['ja', 'jpn', 'japanese'] },
  { code: 'ko', name: 'Korean', alts: ['ko', 'kor', 'korean'] },
  { code: 'zh', name: 'Chinese', alts: ['zh', 'chi', 'zho', 'chinese', 'cmn'] },
  { code: 'nl', name: 'Dutch', alts: ['nl', 'dut', 'nld', 'dutch'] },
  { code: 'pl', name: 'Polish', alts: ['pl', 'pol', 'polish'] },
  { code: 'sv', name: 'Swedish', alts: ['sv', 'swe', 'swedish'] },
  { code: 'id', name: 'Indonesian', alts: ['id', 'ind', 'indonesian'] },
  { code: 'vi', name: 'Vietnamese', alts: ['vi', 'vie', 'vietnamese'] },
  { code: 'th', name: 'Thai', alts: ['th', 'tha', 'thai'] },
  { code: 'he', name: 'Hebrew', alts: ['he', 'heb', 'hebrew'] },
  { code: 'uk', name: 'Ukrainian', alts: ['uk', 'ukr', 'ukrainian'] },
  { code: 'el', name: 'Greek', alts: ['el', 'gre', 'ell', 'greek'] },
];
export const matchLang = (tag: string, code: string) => {
  const l = LANGS.find((x) => x.code === code);
  if (!l || !tag) return false;
  return tag.toLowerCase().split(/[^a-z]+/).some((t) => l.alts.includes(t));
};
export const SAVER: { id: number; label: string; hint: string }[] = [
  { id: 0, label: 'Off', hint: 'Best quality, normal data use' },
  { id: 1, label: 'Balanced', hint: 'Up to 720p, at most about 850 MB per hour' },
  { id: 2, label: 'Low', hint: 'Up to 480p, at most about 320 MB per hour' },
  { id: 3, label: 'Ultra', hint: 'Up to 360p, at most about 150 MB per hour' },
];
export const MAX_VOLS = [100, 200, 300, 500];
export const ACCENTS: Record<string, string> = {
  Violet: '#8b7bff', Teal: '#2dd4bf', Amber: '#f2b84b', Emerald: '#3fd6a0', Rose: '#ff7a93', Sky: '#4cb8ff',
};

// ---------- settings (saved in this browser) ----------
export type Settings = {
  accent: string; quality: string; speed: number; aspect: string; autoNext: boolean;
  autoSub: boolean; subSmart: boolean; subLang: string; subSize: number; subColor: string; subBg: number;
  turbo: boolean; conns: number; view: 'grid' | 'list'; thumbs: boolean;
  saver: number; saverAuto: boolean;
  vol: number; maxVol: number; rememberBoost: boolean; eqPreset: string;
  dlProfile: string; dlLoud: boolean; dlDialogue: boolean; predownload: boolean; autoCache: boolean; skipIntro: boolean; theme: 'dark' | 'light';
  posters: boolean; filter: 'all' | 'unwatched' | 'watched' | 'fav'; externalPlayer: string;
};
export const DEFAULTS: Settings = {
  accent: 'Violet', quality: 'orig', speed: 1, aspect: 'fit', autoNext: true,
  autoSub: true, subSmart: true, subLang: 'en', subSize: 28, subColor: '#ffffff', subBg: 55,
  turbo: true, conns: 8, view: 'grid', thumbs: true,
  saver: 0, saverAuto: true,
  vol: 1, maxVol: 500, rememberBoost: false, eqPreset: 'Flat',
  dlProfile: 'orig', dlLoud: false, dlDialogue: false, predownload: false, autoCache: true, skipIntro: true, theme: 'dark',
  posters: false, filter: 'all', externalPlayer: '',
};
export function loadSettings(): Settings {
  try {
    const legacy: Partial<Settings> = {};
    const q = localStorage.getItem('quality'); if (q) legacy.quality = q;
    const sp = Number(localStorage.getItem('speed')); if (sp) legacy.speed = sp;
    return { ...DEFAULTS, ...legacy, ...JSON.parse(localStorage.getItem('sr.settings') ?? '{}') };
  } catch { return DEFAULTS; }
}
export const SettingsCtx = createContext<{ s: Settings; set: (p: Partial<Settings>) => void }>({ s: DEFAULTS, set: () => {} });

// Things kept on the server so they survive restarts (favourites, per-video sound, bookmarks).
export type Fx = { eq: number[]; dialogue: boolean; night: boolean; mono: boolean };
export type Bookmark = { t: number; label: string };
export type SavedList = { id: string; name: string; root: string; dir: string; items: string[] };
export type Prefs = { favs?: string[]; audio?: Record<string, Fx>; bookmarks?: Record<string, Bookmark[]>; playlists?: SavedList[]; intros?: Record<string, { start: number; end: number }> };
export const PrefsCtx = createContext<{ prefs: Prefs; setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }>({ prefs: {}, setPref: () => {} });

// ---------- helpers ----------
export const qs = (o: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
export async function api<T>(p: string, o: Record<string, string | number> = {}, method = 'GET'): Promise<T> {
  const r = await fetch(`/api/${p}?${qs(o)}`, { method });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j as T;
}
export async function post<T>(p: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j as T;
}
export const bytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
export const rate = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 1 : 2)} MB/s` : `${Math.round(b / 1024)} KB/s`);
export const mbps = (b: number) => { const m = (b * 8) / 1e6; return m >= 1000 ? `${(m / 1000).toFixed(2)} Gbps` : `${m.toFixed(m >= 100 ? 0 : 1)} Mbps`; };
export const clock = (s: number) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(x).padStart(2, '0')}`;
};
export const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
export const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
export const pct = (p?: Prog) => (p && p.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0);

// ---------- subtitles: parse SRT / WebVTT in the browser so styling and sync are fully ours ----------
export type Cue = { s: number; e: number; html: string };
const stamp = (x: string) => {
  const p = x.trim().replace(',', '.').split(':').map(parseFloat);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
};
export function parseCues(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const k = lines.findIndex((l) => l.includes('-->'));
    if (k < 0) continue;
    const [a, b] = lines[k].split('-->');
    const s = stamp(a), e = stamp(b.trim().split(/\s+/)[0]);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const raw = lines.slice(k + 1).join('\n').trim();
    if (!raw) continue;
    const html = raw
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
      .replace(/&lt;\/?[a-z][^&]*?&gt;/gi, '')
      .replace(/\n/g, '<br>');
    out.push({ s, e, html });
  }
  return out.sort((x, y) => x.s - y.s);
}

// ---------- icons ----------
const ICONS: Record<string, string> = {
  home: 'M3 11l9-8 9 8v10h-6v-6H9v6H3z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M16 9h4M4 15h4M16 15h4',
  down: 'M12 4v11m0 0l-4-4m4 4l4-4M5 19h14', trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  check: 'M5 12l5 5 9-10', close: 'M6 6l12 12M18 6L6 18', file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  play: 'M7 4l13 8-13 8z', pause: 'M9 5v14M15 5v14', back: 'M11 6l-6 6 6 6M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  volume: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', exitfs: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  pip: 'M3 5h18v14H3zM12 12h7v5h-7z', cc: 'M3 5h18v14H3zM10.5 10a2 2 0 1 0 0 4M17 10a2 2 0 1 0 0 4',
  aspect: 'M3 6h18v12H3zM7 10v4M7 10h3M17 14v-4M17 14h-3', gauge: 'M4 17a8 8 0 1 1 16 0M12 14l4-5',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  next: 'M5 5l10 7-10 7zM19 5v14', back10: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5', fwd10: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z', sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z', activity: 'M3 12h4l3-8 4 16 3-8h4',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4', upload: 'M12 16V5m0 0l-4 4m4-4l4 4M5 19h14',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  audio: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  more: 'M5 12h.01M12 12h.01M19 12h.01', heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01', plus: 'M12 5v14M5 12h14', pause2: 'M8 5v14M16 5v14',
  rotate: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5', repeat: 'M4 11V9a3 3 0 0 1 3-3h13M17 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H4M7 21l-3-3 3-3',
  bookmark: 'M6 4h12v17l-6-4-6 4z', random: 'M3 6h4l10 12h4M3 18h4l3-3.5M14 9.5L17 6h4M18 3l3 3-3 3M18 15l3 3-3 3',
  hdd: 'M3 14l3-8h12l3 8v5H3zM3 14h18M7 17h.01', skip: 'M5 5l9 7-9 7zM17 5v14', external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  cloud: 'M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18z', save: 'M4 4h13l3 3v13H4zM8 4v5h8V4M8 20v-6h8v6', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
};
export const Icon = ({ n, s = 18 }: { n: string; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICONS[n]} />
  </svg>
);

// ---------- live network meter (server-side byte counting) ----------
export type Net = { speed: number; bytes: number; today: number; month: number; lifetime: number; active: number; hist: number[]; mode: string; ok: boolean };
export function useNet(sid: string | null, ms: number): Net {
  const [n, setN] = useState<Net>({ speed: 0, bytes: 0, today: 0, month: 0, lifetime: 0, active: 0, hist: [], mode: '', ok: true });
  const last = useRef<{ t: number; b: number } | null>(null);
  useEffect(() => {
    last.current = null;
    const tick = async () => {
      try {
        const j = await api<{ total: number; session: number; today: number; month: number; lifetime: number; active: number; mode: string }>('net', sid ? { sid } : {});
        const t = performance.now(), b = sid ? j.session : j.total;
        const prev = last.current;
        last.current = { t, b };
        setN((o) => {
          const inst = prev ? Math.max(0, (b - prev.b) / ((t - prev.t) / 1000)) : 0;
          return { speed: o.speed * 0.35 + inst * 0.65, bytes: b, today: j.today, month: j.month ?? 0, lifetime: j.lifetime, active: j.active, mode: j.mode, ok: true, hist: [...o.hist, inst].slice(-60) };
        });
      } catch { setN((o) => ({ ...o, ok: false })); }
    };
    tick();
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [sid, ms]);
  return n;
}

// ---------- turbo download: many parallel connections written straight to disk ----------
export const turboOk = () => typeof window !== 'undefined' && 'showSaveFilePicker' in window && window.isSecureContext;
export async function turboDownload(
  url: string, name: string, size: number, conns: number,
  onUpdate: (p: { done: number; speed: number }) => void, signal: AbortSignal,
) {
  // Must be the first thing that runs inside the click handler (browser security rule).
  const handle = await (window as any).showSaveFilePicker({ suggestedName: name });
  const w = await handle.createWritable();
  const inner = new AbortController();
  signal.addEventListener('abort', () => inner.abort());
  const CH = 8 * 1024 * 1024;
  const total = Math.ceil(size / CH);
  let next = 0, done = 0;
  const samples: [number, number][] = [];
  const tick = setInterval(() => {
    const now = performance.now();
    samples.push([now, done]);
    while (samples.length > 1 && now - samples[0][0] > 3000) samples.shift();
    const [t0, b0] = samples[0];
    onUpdate({ done, speed: now > t0 ? (done - b0) / ((now - t0) / 1000) : 0 });
  }, 500);
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const s = i * CH, e = Math.min(size - 1, s + CH - 1);
      for (let tries = 0; ; tries++) {
        let got = 0;
        try {
          const r = await fetch(url, { headers: { Range: `bytes=${s}-${e}` }, signal: inner.signal });
          if (r.status !== 206) throw new Error(`Server answered ${r.status}`);
          const rd = r.body!.getReader();
          const parts: Uint8Array[] = [];
          for (;;) {
            const x = await rd.read();
            if (x.done) break;
            parts.push(x.value); got += x.value.length; done += x.value.length;
          }
          if (got !== e - s + 1) throw new Error('Incomplete chunk');
          await w.write({ type: 'write', position: s, data: new Blob(parts as BlobPart[]) });
          break;
        } catch (err) {
          done -= got;
          if (inner.signal.aborted || tries >= 3) throw err;
          await new Promise((ok) => setTimeout(ok, 400 * (tries + 1)));
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(conns, total)) }, worker));
    await w.close();
  } catch (e) {
    inner.abort();
    try { await w.abort(); } catch { /* ignore */ }
    throw e;
  } finally { clearInterval(tick); }
}

// ---------- speed test: how fast can the VPS really push data to this browser? ----------
export async function speedTest(conns: number, mbEach: number, onSpeed: (bps: number) => void, signal: AbortSignal) {
  let got = 0, peak = 0;
  const t0 = performance.now();
  const samples: [number, number][] = [[t0, 0]];
  const tick = setInterval(() => {
    const now = performance.now();
    samples.push([now, got]);
    while (samples.length > 1 && now - samples[0][0] > 1500) samples.shift();
    const [t, b] = samples[0];
    const v = now > t ? (got - b) / ((now - t) / 1000) : 0;
    peak = Math.max(peak, v);
    onSpeed(v);
  }, 250);
  try {
    await Promise.all(Array.from({ length: conns }, async () => {
      const r = await fetch(`/api/speedtest?mb=${mbEach}&r=${Math.random()}`, { signal, cache: 'no-store' });
      const rd = r.body!.getReader();
      for (;;) { const x = await rd.read(); if (x.done) break; got += x.value.length; }
    }));
  } finally { clearInterval(tick); }
  const secs = (performance.now() - t0) / 1000;
  return { avg: got / secs, peak, bytes: got, secs };
}

export function useUpdates(): UpdateState | null {
  const [u, setU] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    bridge.updateGet().then(setU).catch(() => {});
    return bridge.onUpdate(setU);
  }, []);
  return u;
}

// ---------- turn a messy file name into a searchable title ----------
export function parseTitle(name: string): { title: string; year: number; season: number; episode: number } {
  let t = name.replace(/\.[^.]+$/, '');
  const ep = /[Ss](\d{1,2})[ ._-]*[Ee](\d{1,3})/.exec(t) ?? /(\d{1,2})x(\d{2})/.exec(t);
  const season = ep ? Number(ep[1]) : 0, episode = ep ? Number(ep[2]) : 0;
  if (ep) t = t.slice(0, ep.index);
  const ym = /[ ._(\[-]((?:19|20)\d{2})(?=[ ._)\]-]|$)/.exec(t);
  const year = ym ? Number(ym[1]) : 0;
  if (ym) t = t.slice(0, ym.index);
  t = t.replace(/\b(2160p|1080p|720p|480p|360p|4k|uhd|bluray|brrip|bdrip|webrip|web-dl|webdl|hdrip|dvdrip|hdtv|x264|x265|h264|h265|hevc|av1|aac|ac3|dts|10bit|remux|proper|extended|unrated|yify|rarbg)\b.*$/i, '');
  t = t.replace(/[._]+/g, ' ').replace(/\s*[-\[(]+\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title: t || name.replace(/\.[^.]+$/, ''), year, season, episode };
}

// ---------- can this laptop play a codec? (decides which compressed downloads are offered) ----------
export function canDecode(codec: 'h264' | 'hevc' | 'av1'): boolean {
  const v = document.createElement('video');
  const t = { h264: 'video/mp4; codecs="avc1.640028"', hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"', av1: 'video/mp4; codecs="av01.0.05M.08"' }[codec];
  return v.canPlayType(t) !== '';
}
/** Move all saved videos to another folder or drive. Resolves with an error message, or null when finished. */
export async function moveDownloads(to: string, onProgress: (text: string) => void): Promise<string | null> {
  try { await post('storage/move', { to }); } catch (e: any) { return e?.message ?? 'Could not start moving'; }
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    const m = await api<{ state: string; done: number; total: number; file: string; error?: string }>('storage/move').catch(() => null);
    if (!m) continue;
    if (m.state === 'error') return m.error ?? 'Move failed';
    if (m.state === 'done') return null;
    onProgress(`Moving… ${m.total ? Math.round((m.done / m.total) * 100) : 0}%${m.file ? ` · ${m.file}` : ''}`);
  }
}