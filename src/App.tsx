import { CSSProperties, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Player from './Player';
import Setup from './Setup';
import SettingsDialog, { Toggle } from './Settings';
import { AddToCollection, CollectionsPage, Collection, HomeCustomize, HomeRow, RuleDialog, Stars, TagsEditor, Tidy, Tour, ItemMeta } from './Extras';
import { Hero, Playlists, Rail, SavedFile, Tile, Today, Welcome, progPct, savedSub } from './Home';
import { DownloadDialog, DownloadsPanel, StoragePanel } from './Downloads';
import {
  ACCENTS, APP_NAME, Caps, SavedList, dayKey, DEFAULTS, Entry, Icon, Net, OFFLINE_ID, OPENED_ID, Prefs, PrefsCtx, Prog, Root, SAVER, SettingsCtx, VIDEO, VIDEO_EXTS,
  api, bridge, bytes, clock, hue, join, loadSettings, mbps, parseTitle, pct, post, qs, rate, turboDownload, turboOk, useNet, useUpdates, Settings,
} from './lib';

type Ask = { title: string; body: string; label: string; go: () => Promise<void> };
type DL = { id: string; name: string; done: number; total: number; speed: number; state: 'run' | 'done' | 'error' | 'cancel'; error?: string; ctl: AbortController };
type RootsRes = { host: string; mode: string; error: string; hasServer: boolean; roots: Root[] };
type Meta = { found: boolean; title?: string; year?: number; overview?: string; rating?: number; genres?: string[]; poster?: boolean };
type Target = { root: number; paths: string[]; names: string[]; sizes: number };
type Card = { k: string; p?: Prog; rid: number; dir: string; name: string };

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [prefs, setPrefs] = useState<Prefs>({});
  const timers = useRef<Record<string, number>>({});
  // Saved in the browser right away and on the server a moment later, so settings survive restarts of the desktop app.
  const queue = useCallback((key: string, value: unknown) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = window.setTimeout(() => { post('prefs', { key, value }).catch(() => {}); }, 400);
  }, []);
  const set = useCallback((p: Partial<Settings>) => setSettings((o) => {
    const n = { ...o, ...p };
    try { localStorage.setItem('sr.settings', JSON.stringify(n)); } catch { /* private mode */ }
    queue('settings', n);
    return n;
  }), [queue]);
  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((o) => ({ ...o, [k]: v }));
    queue(k, v);
  }, [queue]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    api<Record<string, any>>('prefs').then((d) => {
      if (d.settings) setSettings((o) => ({ ...DEFAULTS, ...o, ...d.settings }));
      setPrefs(d as Prefs);
    }).catch(() => {}).finally(() => setReady(true));
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  useEffect(() => { document.documentElement.style.setProperty('--lamp', /^#[0-9a-f]{6}$/i.test(settings.accentCustom) ? settings.accentCustom : ACCENTS[settings.accent] ?? ACCENTS.Violet); }, [settings.accent, settings.accentCustom]);
  useEffect(() => { document.documentElement.dataset.preset = settings.themePreset; document.documentElement.dataset.compact = settings.compact ? '1' : '0'; }, [settings.themePreset, settings.compact]);
  if (!ready) return <div className="boot" aria-label="Loading"><span className="lamp big" /></div>;
  return (
    <SettingsCtx.Provider value={{ s: settings, set }}>
      <PrefsCtx.Provider value={{ prefs, setPref }}><Library /></PrefsCtx.Provider>
    </SettingsCtx.Provider>
  );
}

// ---------- posters and descriptions (TMDB), fetched a few at a time ----------
let gateN = 0;
const gateQ: (() => void)[] = [];
const gate = async <T,>(fn: () => Promise<T>): Promise<T> => {
  while (gateN >= 3) await new Promise<void>((r) => gateQ.push(r));
  gateN++;
  try { return await fn(); } finally { gateN--; gateQ.shift()?.(); }
};
const metaCache = new Map<string, Promise<Meta | null>>();
const getMeta = (name: string, folder = ''): Promise<Meta | null> => {
  const t = parseTitle(name, folder), key = `${t.title}|${t.year}`;
  let p = metaCache.get(key);
  if (!p) { p = gate(() => api<Meta>('meta', { q: t.title, year: t.year })).catch(() => null); metaCache.set(key, p); }
  return p;
};
const posterUrl = (name: string, folder = '') => { const t = parseTitle(name, folder); return `/api/poster?${qs({ q: t.title, year: t.year })}`; };

function Thumb({ root, path, v, icon }: { root: number; path: string; v: number; icon: string }) {
  const { s } = useContext(SettingsCtx);
  const [ok, setOk] = useState(true);
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <span className="ph"><Icon n={icon} s={28} /></span>
      {s.thumbs && ok && (
        <img className={loaded ? 'on' : ''} loading="lazy" decoding="async" alt="" src={`/api/thumb?${qs({ root, path, v })}`}
          onLoad={() => setLoaded(true)} onError={() => setOk(false)} />
      )}
    </>
  );
}
function Art({ root, path, v, name }: { root: number; path: string; v: number; name: string }) {
  const { s } = useContext(SettingsCtx);
  const ref = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<'idle' | 'ok' | 'none'>('idle');
  useEffect(() => {
    if (!s.posters || state !== 'idle' || !ref.current) return;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      getMeta(name, path.split('/').slice(0, -1).join('/')).then((m) => setState(m?.poster ? 'ok' : 'none'));
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [s.posters, state, name]);
  return (
    <span className="art" ref={ref}>
      <Thumb root={root} path={path} v={v} icon="film" />
      {s.posters && state === 'ok' && <img className="poster-img on" alt="" loading="lazy" src={posterUrl(name, path.split('/').slice(0, -1).join('/'))} onError={() => setState('none')} />}
    </span>
  );
}

function Details({ name, folder, meta, allTags, onMeta, remote, onClose, onPlay, onSave, size, prog }: { size?: number; prog?: Prog; name: string; folder: string; meta: ItemMeta; allTags: string[]; onMeta: (p: Partial<ItemMeta>) => void; remote: boolean; onClose: () => void; onPlay: () => void; onSave: () => void }) {
  const [m, setM] = useState<Meta | null | undefined>(undefined);
  const [err, setErr] = useState('');
  const t = parseTitle(name, folder);
  const [fix, setFix] = useState(false);
  const [fq, setFq] = useState('');
  const [cands, setCands] = useState<{ id: number; kind: string; title: string; year: number; poster: string; overview: string }[]>([]);
  const [fbusy, setFbusy] = useState(false);
  const search = async () => { setFbusy(true); try { setCands((await api<{ items: typeof cands }>('meta/search', { q: fq || t.title })).items); } catch (e: any) { setErr(e.message); } setFbusy(false); };
  const choose = async (c: (typeof cands)[number]) => {
    setFbusy(true);
    try { const nm = await post<Meta>('meta/choose', { q: t.title, year: t.year, id: c.id, kind: c.kind }); metaCache.delete(`${t.title}|${t.year}`); setM(nm); setFix(false); setErr(''); setPv((x) => x + 1); } catch (e: any) { setErr(e.message); }
    setFbusy(false);
  };
  const [pv, setPv] = useState(0);
  useEffect(() => {
    api<Meta>('meta', { q: t.title, year: t.year }).then(setM).catch((e) => { setErr(e.message); setM(null); });
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = m?.title ?? t.title;
  const yr = m?.year ?? t.year;
  const part = !!prog && !prog.watched && prog.pos > 30;
  const label = part ? 'Resume' : prog?.watched ? 'Watch again' : 'Play';
  return (
    <div className="scrim dt-scrim" onClick={onClose}>
      <div className="dt" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About this video">
        {m?.poster && <div className="dt-bg" aria-hidden="true" style={{ backgroundImage: `url(${posterUrl(name, folder)}&r=${pv})` }} />}
        <button className="dt-close" onClick={onClose} aria-label="Close"><Icon n="close" s={18} /></button>
        <div className="dt-main">
          <div className="dt-poster">{m?.poster ? <img alt="" src={`${posterUrl(name, folder)}&r=${pv}`} /> : <span className="dt-ph"><Icon n="film" s={38} /></span>}</div>
          <div className="dt-info">
            <div className="dt-chips">
              {yr ? <span>{yr}</span> : null}
              {m?.rating ? <span className="dt-star">★ {m.rating}</span> : null}
              {(m?.genres ?? []).slice(0, 3).map((g) => <span key={g}>{g}</span>)}
              {prog?.watched && <span className="dt-ok"><Icon n="check" s={12} /> Watched</span>}
            </div>
            <h2>{title}</h2>
            {m === undefined && <div className="dt-skel"><i /><i /><i /></div>}
            {m?.found && <p className="dt-over">{m.overview || 'No description available.'}</p>}
            {m && !m.found && <p className="muted">Nothing found for “{t.title}”. You can search for it below.</p>}
            {err && <p className="muted small">{err}</p>}
            {part && prog && (
              <div className="dt-prog">
                <i className="bar"><b style={{ width: `${Math.min(100, (prog.pos / Math.max(1, prog.dur)) * 100)}%` }} /></i>
                <span className="small muted">{clock(prog.pos)} watched{prog.dur > prog.pos ? ` · ${clock(prog.dur - prog.pos)} left` : ''}</span>
              </div>
            )}
            <div className="dt-actions">
              <button className="btn big" onClick={onPlay}><Icon n="play" s={16} /> {label}</button>
              {remote && <button className="btn ghost big" onClick={onSave}><Icon n="save" s={16} /> Save offline</button>}
            </div>
          </div>
        </div>
        <div className="dt-grid">
          <section><h4>Your rating</h4><Stars value={meta.r ?? 0} onChange={(n) => onMeta({ r: n })} /></section>
          <section><h4>Tags</h4><TagsEditor tags={meta.t ?? []} all={allTags} onChange={(t) => onMeta({ t })} /></section>
        </div>
        <div className="dt-foot">
          <span className="dt-file" title={name}><Icon n="film" s={14} /> <span>{name}</span>{size ? <em>{bytes(size)}</em> : null}</span>
          <button className="dt-link" onClick={() => { setFix(!fix); setFq(t.title); setCands([]); }}>{m?.found ? 'Wrong match?' : 'Find it manually'}</button>
        </div>
        {fix && (
          <div className="fixbox">
            <span className="inline"><input autoFocus value={fq} onChange={(e) => setFq(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Type the real title" /><button className="btn" disabled={fbusy} onClick={search}>Search</button></span>
            {cands.map((c) => (
              <button key={c.kind + c.id} className="cand" onClick={() => choose(c)}>
                {c.poster ? <img alt="" src={c.poster} /> : <span className="cand-ph"><Icon n="film" s={18} /></span>}
                <span><b>{c.title}{c.year ? ` (${c.year})` : ''}</b><small>{c.kind === 'tv' ? 'Series' : 'Movie'} · {c.overview.slice(0, 90)}{c.overview.length > 90 ? '…' : ''}</small></span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Library() {
  const { s, set } = useContext(SettingsCtx);
  const { prefs, setPref } = useContext(PrefsCtx);
  const [host, setHost] = useState('');
  const [hasServer, setHasServer] = useState(true);
  const [rootsErr, setRootsErr] = useState('');
  const [roots, setRoots] = useState<Root[]>([]);
  const [root, setRoot] = useState<number | null>(null);
  const [dir, setDir] = useState('');
  const [items, setItems] = useState<Entry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');
  const [play, setPlay] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [toast, setToast] = useState('');
  const [prog, setProg] = useState<Record<string, Prog>>({});
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'new' | 'size'>('name');
  const [panel, setPanel] = useState<null | 'settings' | 'servers' | 'downloads' | 'storage' | 'tidy'>(null);
  const [dls, setDls] = useState<DL[]>([]);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [budget, setBudget] = useState(0);
  const [queueInfo, setQueueInfo] = useState({ active: 0, waiting: 0, speed: 0 });
  const [skipSetup, setSkipSetup] = useState(() => { try { return localStorage.getItem('cinema.skipSetup') === '1'; } catch { return false; } });
  const search = useRef<HTMLInputElement>(null);
  const pre = useRef(new Set<string>());
  const net = useNet(null, 30000); // month total and mode only; the live speed lives in <NetMini/>
  const upd = useUpdates();
  const [dragging, setDragging] = useState(false);
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [addTo, setAddTo] = useState<string[] | null>(null);
  const [ruleFor, setRuleFor] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [tagFilter, setTagFilter] = useState('');
  const [heroI, setHeroI] = useState(0);
  const [because, setBecause] = useState<{ title: string; items: Entry[]; root: number; dir: string } | null>(null);
  const [sibs, setSibs] = useState<string[]>([]);
  const sinceRef = useRef<number>(prefs.lastVisit ?? Date.now());
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const popQ = useMemo(() => new URLSearchParams(location.search), []);
  const isPop = popQ.get('pop') === '1';
  const [help, setHelp] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [onBattery, setOnBattery] = useState(false);
  const [floating, setFloating] = useState(false);
  const [view, setView] = useState<'home' | 'library' | 'playlists' | 'collections' | 'insights'>('home');
  const [savedFiles, setSavedFiles] = useState<SavedFile[]>([]);
  const [nameAsk, setNameAsk] = useState<{ title: string; value: string; label: string; go: (v: string) => void } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [playlist, setPlaylist] = useState<string[] | null>(null);
  const [libMenu, setLibMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);

  const rootOf = (id: number | null) => roots.find((r) => r.id === id);
  const cur = rootOf(root);
  const offline = !!cur?.offline;
  const opened = !!cur?.opened; // videos opened from Explorer / drag and drop: played in place, never copied
  const rid = root ?? -1;
  const pkey = (name: string, d = dir, r = root) => `${rootOf(r)?.name}:${join(d, name)}`;
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3600); };
  const loadProg = useCallback(() => api<Record<string, Prog>>('progress').then(setProg).catch(() => {}), []);
  const loadSrv = useCallback(() => api<{ budgetGB: number }>('settings').then((j) => setBudget(j.budgetGB)).catch(() => {}), []);
  const loadCaps = useCallback(() => api<Caps>('caps').then(setCaps).catch(() => {}), []);
  const loadRoots = useCallback(() => api<RootsRes>('roots').then((r) => {
    setHost(r.host); setRoots(r.roots); setRootsErr(r.error); setHasServer(r.hasServer);
    setRoot((c) => (c !== null && r.roots.some((x) => x.id === c) ? c : r.roots[0]?.id ?? null));
    return r;
  }).catch(() => null), []);
  const load = useCallback(async () => {
    if (root === null) return;
    setStatus('loading');
    try { setItems(await api<Entry[]>('list', { root, path: dir })); setStatus('ready'); }
    catch (e: any) {
      // The folder is gone (moved, deleted or a bad link): step back to the nearest folder that exists instead of a dead end.
      if (dir && /not found/i.test(e.message)) { setDir(dir.split('/').slice(0, -1).join('/')); return; }
      setErr(e.message); setStatus('error');
    }
  }, [root, dir]);

  useEffect(() => { loadRoots(); loadProg(); loadSrv(); loadCaps(); }, [loadRoots, loadProg, loadSrv, loadCaps]);
  useEffect(() => { setQuery(''); load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.hidden) return; api<{ active: number; waiting: number; speed: number }>('dl').then((j) => setQueueInfo((o) => (o.active === j.active && o.waiting === j.waiting ? o : j))).catch(() => {}); }, 2500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !play && !panel && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, panel]);

  const refreshAll = () => Promise.all([load(), loadRoots(), loadProg()]);
  const refreshRef = useRef(refreshAll); refreshRef.current = refreshAll;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) { e.preventDefault(); refreshRef.current(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // ----- videos from outside the library: Explorer "Open with", double-click, drag and drop, Open file -----
  const openLocal = async (files: string[]) => {
    const list = files.filter((f) => f && VIDEO.test(f));
    if (!list.length) { flash('That is not a video file Cinema can play'); return; }
    try {
      let first = '';
      for (const f of list) { const r = await post<{ name: string }>('opened', { path: f }); if (!first) first = r.name; }
      // Start playing right away; the storage list refreshes in the background (it can be slow when the server is far away).
      setRoots((rs) => (rs.some((x) => x.id === OPENED_ID) ? rs : [...rs, { id: OPENED_ID, name: 'Opened', dir: '', free: 0, total: 0, offline: true, opened: true } as Root]));
      setPanel(null); setQuery(''); setRoot(OPENED_ID); setDir(''); setPlay(first);
      loadRoots();
    } catch (e: any) { flash(e.message); }
  };
  const openRef = useRef(openLocal);
  openRef.current = openLocal;
  const pickFile = async () => {
    const f = await bridge?.selectFiles([{ name: 'Videos', extensions: VIDEO_EXTS }]);
    if (f?.length) openLocal(f);
  };
  useEffect(() => {
    if (!bridge) return;
    bridge.takePendingOpen().then((f) => { if (f) openRef.current([f]); }).catch(() => {});
    return bridge.onOpenFile((f) => openRef.current([f]));
  }, []);
  useEffect(() => {
    if (!bridge) return;
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pickFile(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Keyboard layer for the library (the player has its own keys). Ctrl+K opens the command palette, ? shows every shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (play) return;
      const t = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && k === 'k') { e.preventDefault(); setHelp(false); setPalette((x) => !x); return; }
      if (palette || help) { if (e.key === 'Escape') { setPalette(false); setHelp(false); } return; }
      if (mod && k === 'f') { e.preventDefault(); setView('library'); setTimeout(() => search.current?.focus(), 60); return; }
      if (mod && k === 'a' && view === 'library' && !typing) { e.preventDefault(); setSelecting(true); setSel(videos); return; }
      if (mod && ['1', '2', '3'].includes(k)) { e.preventDefault(); setView((['home', 'library', 'playlists'] as const)[Number(k) - 1]); return; }
      if (mod && k === '4') { e.preventDefault(); setPanel('downloads'); return; }
      if (mod && k === ',') { e.preventDefault(); setPanel('settings'); return; }
      if (mod && k === 'd') { e.preventDefault(); setPanel('downloads'); return; }
      if (typing || mod) return;
      if (e.key === 'Escape') { if (menuFor) setMenuFor(null); else if (selecting) endSelect(); else if (panel) setPanel(null); return; }
      if (e.key === 'Delete' && selecting && sel.length) { e.preventDefault(); const l = videos.filter((n) => sel.includes(n)); endSelect(); confirmDelete(l, `${l.length} video${l.length > 1 ? 's' : ''}`); return; }
      if (e.key === '?') { e.preventDefault(); setHelp(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const palCmds = [
    { t: 'Go to Home', k: 'Ctrl 1', run: () => setView('home') },
    { t: 'Go to Library', k: 'Ctrl 2', run: () => setView('library') },
    { t: 'Go to Playlists', k: 'Ctrl 3', run: () => setView('playlists') },
    { t: 'Open Downloads', k: 'Ctrl D', run: () => setPanel('downloads') },
    { t: 'Open Settings', k: 'Ctrl ,', run: () => setPanel('settings') },
    { t: 'Open Servers', k: '', run: () => setPanel('servers') },
    { t: 'Refresh', k: 'F5', run: () => { refreshAll().then(() => flash('Refreshed')); } },
    { t: 'Select videos', k: 'Ctrl A', run: () => { setView('library'); setSelecting(true); } },
    { t: s.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme', k: '', run: () => set({ theme: s.theme === 'dark' ? 'light' : 'dark' }) },
    { t: s.eco === 'on' ? 'Turn power saving off' : 'Turn power saving on', k: '', run: () => set({ eco: s.eco === 'on' ? 'off' : 'on' }) },
    { t: 'Keyboard shortcuts', k: '?', run: () => setHelp(true) },
    ...(bridge ? [{ t: 'Open a video from this computer', k: 'Ctrl O', run: () => pickFile() }] : []),
    ...items.map((it) => it.dir
      ? { t: `Open folder: ${it.name}`, k: '', run: () => { setView('library'); setDir(join(dir, it.name)); } }
      : { t: `Play: ${it.name.replace(/\.[^.]+$/, '')}`, k: '', run: () => startPlay(it.name) }),
  ];
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (!bridge) return;
    const paths = [...e.dataTransfer.files].map((f) => bridge!.pathForFile(f)).filter(Boolean);
    if (paths.length) openLocal(paths); else flash('Drop video files from your computer');
  };

  const serversChanged = async () => { setDir(''); setRoot(null); await Promise.all([loadRoots(), loadCaps()]); };

  const remove = async (names: string[]) => {
    for (const n of names) await api('item', { root: rid, path: join(dir, n) }, 'DELETE');
    flash(opened ? 'Removed from the list' : offline ? (names.length === 1 ? 'Deleted from this laptop' : `${names.length} items deleted from this laptop`) : (names.length === 1 ? 'Deleted from the server' : `${names.length} items deleted from the server`));
    await refreshAll();
  };
  const confirmDelete = (names: string[], what: string) =>
    setAsk({
      title: opened ? `Remove ${what}?` : `Delete ${what}?`,
      body: opened ? 'This only removes it from this list. The video file stays where it is on your computer.'
        : offline ? 'This removes the downloaded copy from this laptop. The original on your server is not touched.' : 'This removes it from your server permanently. It cannot be undone.',
      label: opened ? 'Remove from list' : offline ? 'Delete from laptop' : 'Delete from server', go: () => remove(names),
    });
  const setWatched = async (name: string, watched: boolean) => {
    const p = prog[pkey(name)];
    await post('progress', { key: pkey(name), pos: watched ? p?.pos ?? 0 : 0, dur: p?.dur ?? 0, watched });
    loadProg();
  };
  const toggleFav = (name: string) => {
    const k = pkey(name), f = prefs.favs ?? [];
    setPref('favs', f.includes(k) ? f.filter((x) => x !== k) : [...f, k]);
  };
  const playOffline = (destRel: string) => {
    setFloating(false);
    const parts = destRel.split('/');
    setPanel(null); setRoot(OFFLINE_ID); setDir(parts.slice(0, -1).join('/')); setPlay(parts[parts.length - 1]);
  };

  // Play a video. If a full copy is already saved on this laptop, play that one (works with no internet and uses no data).
  useEffect(() => {
    if (view !== 'home' || panel) return;
    api<{ items: SavedFile[] }>('storage').then((d) => setSavedFiles([...d.items].sort((a, b) => b.mtime - a.mtime))).catch(() => {});
  }, [view, panel, play]);
  useEffect(() => {
    const nav = navigator as any;
    if (!nav.getBattery) return;
    let b: any, dead = false;
    const upd = () => setOnBattery(!!b && !b.charging);
    nav.getBattery().then((x: any) => { if (dead) return; b = x; upd(); x.addEventListener('chargingchange', upd); });
    return () => { dead = true; b?.removeEventListener('chargingchange', upd); };
  }, []);
  const eco = s.eco === 'on' || (s.eco === 'battery' && onBattery);
  useEffect(() => { document.documentElement.dataset.eco = eco ? '1' : '0'; }, [eco]);
  const cols: Collection[] = prefs.collections ?? [];
  const setCols = (c: Collection[]) => setPref('collections', c);
  const metaMap = prefs.meta ?? {};
  const metaOf = (name: string): ItemMeta => metaMap[pkey(name)] ?? {};
  const setMetaFor = (name: string, patch: Partial<ItemMeta>) => setPref('meta', { ...metaMap, [pkey(name)]: { ...metaOf(name), ...patch } });
  const allTags = [...new Set(Object.values(metaMap).flatMap((m) => m.t ?? []))].sort();
  const baseName = (p: string) => p.split('/').pop() ?? p;
  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
  const addWatch = (sec: number) => {
    const cur = prefsRef.current.daylog ?? {};
    const k = dayKey();
    const keep = Object.fromEntries(Object.entries(cur).filter(([d]) => d >= dayKey(new Date(Date.now() - 120 * 86400_000))));
    setPref('daylog', { ...keep, [k]: (cur[k] ?? 0) + sec });
  };
  useEffect(() => { setPref('lastVisit', Date.now()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const isNew = (it: Entry) => !it.dir && (it.mtime < 1e11 ? it.mtime * 1000 : it.mtime) > sinceRef.current && !prog[pkey(it.name)];
  useEffect(() => { // "Because you watched": unwatched videos next to the last one you finished
    if (view !== 'home') return;
    const last = Object.entries(prog).filter(([, p]) => p.watched).sort((a, b) => b[1].updated - a[1].updated)[0];
    if (!last) { setBecause(null); return; }
    const [rootName, ...rest] = last[0].split(':');
    const path = rest.join(':');
    const r = roots.find((x) => x.name === rootName && !x.offline && !x.opened);
    if (!r || !path.includes('/')) { setBecause(null); return; }
    const d = dirOf(path);
    let dead = false;
    api<Entry[]>('list', { root: r.id, path: d }).then((list) => {
      if (dead) return;
      const next = list.filter((e) => !e.dir && VIDEO.test(e.name) && !prog[`${rootName}:${join(d, e.name)}`]?.watched).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, 12);
      setBecause(next.length ? { title: parseTitle(baseName(path), d).title, items: next, root: r.id, dir: d } : null);
    }).catch(() => setBecause(null));
    return () => { dead = true; };
  }, [view, roots.length, Object.keys(prog).length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // season tabs: sibling folders when you are inside "Season 02"
    const last = dir.split('/').pop() ?? '';
    if (!dir || !/^(season|series|s)\s*\d+/i.test(last) || root === null) { setSibs([]); return; }
    let dead = false;
    api<Entry[]>('list', { root, path: dirOf(dir) }).then((l) => { if (!dead) setSibs(l.filter((e) => e.dir && /^(season|series|s)\s*\d+/i.test(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))); }).catch(() => setSibs([]));
    return () => { dead = true; };
  }, [dir, root]);
  useEffect(() => { // phone remote: commands arrive here and are handed to the player
    const t = setInterval(async () => {
      if (document.hidden) return;
      try {
        const j = await api<{ on: boolean; cmds: { cmd: string; value?: number }[] }>('remote/poll');
        (window as any).__remoteOn = j.on;
        for (const c of j.cmds) window.dispatchEvent(new CustomEvent('cinema-remote', { detail: c }));
      } catch { /* server busy */ }
    }, play ? 900 : 4000);
    return () => clearInterval(t);
  }, [play]);
  useEffect(() => { // pop-out window: play what the main window sent
    if (!isPop) return;
    document.documentElement.classList.add('pop');
    const r = Number(popQ.get('root')), n = popQ.get('name');
    if (n && roots.some((x) => x.id === r)) startPlay(n, r, popQ.get('dir') ?? '', true);
  }, [roots.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const playFromCollection = (it: { root: string; path: string }, all: { root: string; path: string }[]) => {
    const r = roots.find((x) => x.name === it.root);
    if (!r) { flash('That storage is not connected right now'); return; }
    const d = dirOf(it.path);
    const same = all.filter((x) => x.root === it.root && dirOf(x.path) === d).map((x) => baseName(x.path));
    setPlaylist(same.length > 1 ? same : null);
    startPlay(baseName(it.path), r.id, d, true);
  };
  const lists: SavedList[] = prefs.playlists ?? [];
  const setLists = (l: SavedList[]) => setPref('playlists', l);
  const savePlaylist = () => {
    const names = videos.filter((n) => sel.includes(n));
    if (!names.length || !cur) return;
    setNameAsk({ title: 'Save playlist', value: `${crumbs[crumbs.length - 1] || cur.name} playlist`, label: 'Save playlist', go: (v) => {
      setLists([...lists, { id: `${Date.now()}`, name: v.trim() || 'My playlist', root: cur.name, dir, items: names }]);
      endSelect(); flash('Playlist saved. Find it under Playlists');
    } });
  };
  const playList = (l: SavedList) => {
    const r = roots.find((x) => x.name === l.root);
    if (!r) { flash('That storage is not connected right now'); return; }
    setPanel(null); setPlaylist(l.items); startPlay(l.items[0], r.id, l.dir, true);
  };
  const startPlay = async (name: string, r: number = rid, d: string = dir, keepList = false) => {
    setFloating(false);
    if (!keepList) setPlaylist(null);
    const rt = roots.find((x) => x.id === r);
    if (rt && !rt.offline && !keepList) {
      try {
        const j = await api<{ state: string; dest?: string }>('saved', { root: r, path: join(d, name) });
        if (j.state === 'done' && j.dest) { flash('Playing the saved copy from this laptop'); playOffline(j.dest); return; }
      } catch { /* server unreachable: fall through */ }
    }
    setRoot(r); setDir(d); setPlay(name);
  };
  const toggleSel = (name: string) => setSel((x) => (x.includes(name) ? x.filter((n) => n !== name) : [...x, name]));
  const endSelect = () => { setSelecting(false); setSel([]); };
  const playSelected = () => {
    const list = videos.filter((n) => sel.includes(n));
    if (!list.length) return;
    endSelect(); setPlaylist(list); setPlay(list[0]);
  };
  const saveSelected = () => {
    const list = videos.filter((n) => sel.includes(n));
    if (!list.length) return;
    saveOffline(list, items.filter((i) => list.includes(i.name)).reduce((a, i) => a + i.size, 0)); endSelect();
  };

  // Browser-only turbo download (the desktop app uses "Save for offline" instead).
  const download = (it: Entry) => {
    const url = `/api/download?${qs({ root: rid, path: join(dir, it.name) })}`;
    if (s.turbo && turboOk() && it.size > 24 * 1024 * 1024) {
      const id = `${Date.now()}${Math.random()}`;
      const ctl = new AbortController();
      const upd = (patch: Partial<DL>) => setDls((d) => d.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      setDls((d) => [...d, { id, name: it.name, done: 0, total: it.size, speed: 0, state: 'run', ctl }]);
      turboDownload(url, it.name, it.size, s.conns, (p) => upd(p), ctl.signal)
        .then(() => upd({ state: 'done', done: it.size, speed: 0 }))
        .catch((e: any) => {
          if (e?.name === 'AbortError' && !ctl.signal.aborted) setDls((d) => d.filter((x) => x.id !== id));
          else upd({ state: ctl.signal.aborted ? 'cancel' : 'error', error: e?.message, speed: 0 });
        });
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = it.name;
      document.body.appendChild(a); a.click(); a.remove();
    }
  };
  const saveOffline = (names: string[], sizes: number) => setTarget({ root: rid, paths: names.map((n) => join(dir, n)), names, sizes });

  const videos = useMemo(() => items.filter((i) => !i.dir && VIDEO.test(i.name)).map((i) => i.name), [items]);
  const seen = videos.filter((n) => prog[pkey(n)]?.watched);
  const favs = prefs.favs ?? [];
  const shown = useMemo(() => {
    const f = items.filter((i) => {
      if (!i.name.toLowerCase().includes(query.toLowerCase())) return false;
      if (i.dir || s.filter === 'all') return true;
      const p = prog[pkey(i.name)];
      if (tagFilter && !(metaOf(i.name).t ?? []).includes(tagFilter)) return false;
      return s.filter === 'rated' ? (metaOf(i.name).r ?? 0) >= 4 : s.filter === 'progress' ? !!p && !p.watched && p.pos > 20 : s.filter === 'unwatched' ? !p?.watched : s.filter === 'watched' ? !!p?.watched : favs.includes(pkey(i.name));
    });
    const c = (a: Entry, b: Entry) => sort === 'new' ? b.mtime - a.mtime : sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name, undefined, { numeric: true });
    return [...f.filter((i) => i.dir).sort(c), ...f.filter((i) => !i.dir).sort(c)];
  }, [items, query, sort, s.filter, tagFilter, prog, favs]); // eslint-disable-line react-hooks/exhaustive-deps
  const folders = shown.filter((i) => i.dir);
  const files = shown.filter((i) => !i.dir);
  const posters = s.view !== 'list' ? files.filter((i) => VIDEO.test(i.name)) : [];
  const rows = s.view !== 'list' ? files.filter((i) => !VIDEO.test(i.name)) : files;

  const cardOf = (k: string, p?: Prog): Card | null => {
    const i = k.indexOf(':'), parts = k.slice(i + 1).split('/');
    const r = roots.find((x) => x.name === k.slice(0, i));
    return r ? { k, p, rid: r.id, dir: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] } : null;
  };
  const resumable = useMemo(() =>
    Object.entries(prog)
      .filter(([, p]) => !p.watched && p.pos > 30 && p.dur > 0 && p.pos / p.dur < 0.9)
      .sort((a, b) => b[1].updated - a[1].updated).slice(0, 10)
      .map(([k, p]) => cardOf(k, p)).filter((x): x is Card => !!x), [prog, roots]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view !== 'home' || resumable.length < 2) return;
    const t = setInterval(() => setHeroI((i) => i + 1), 9000);
    return () => clearInterval(t);
  }, [view, resumable.length]);
  const favCards = useMemo(() => favs.map((k) => cardOf(k, prog[k])).filter((x): x is Card => !!x).slice(0, 12), [favs, prog, roots]); // eslint-disable-line react-hooks/exhaustive-deps

  const nextUp = (() => {
    if (!videos.length) return null;
    const part = videos.filter((n) => { const p = prog[pkey(n)]; return p && !p.watched && p.pos > 30; })
      .sort((a, b) => prog[pkey(b)].updated - prog[pkey(a)].updated)[0];
    if (part) return { name: part, label: 'Resume' };
    const fresh = videos.find((n) => !prog[pkey(n)]?.watched);
    return { name: fresh ?? videos[0], label: fresh && seen.length ? 'Play next' : 'Play' };
  })();
  const randomPick = () => {
    const pool = videos.filter((n) => !prog[pkey(n)]?.watched);
    const list = pool.length ? pool : videos;
    if (list.length) startPlay(list[Math.floor(Math.random() * list.length)]);
  };

  const crumbs = dir ? dir.split('/') : [];
  const floor = s.saverAuto && budget > 0 && net.month >= budget * 0.8e9 ? 2 : 0;
  const saver = Math.max(s.saver, floor);

  const onStarted = (name: string) => {
    if (!s.predownload || offline) return;
    const nx = videos[videos.indexOf(name) + 1];
    if (!nx || pre.current.has(pkey(nx))) return;
    pre.current.add(pkey(nx));
    post('dl/add', { root: rid, paths: [join(dir, nx)], profile: s.dlProfile, opts: { loud: s.dlLoud, dialogue: s.dlDialogue } })
      .then((r: any) => r.queued && flash(`Saving “${nx.replace(/\.[^.]+$/, '')}” for offline`)).catch(() => {});
  };

  const fileActions = (it: Entry, isVid: boolean, p?: Prog) => {
    const done = (fn: () => void) => () => { setMenuFor(null); fn(); };
    const open = menuFor === it.name;
    return (
      <>
        {isVid && <button className={favs.includes(pkey(it.name)) ? 'icon on' : 'icon'} title="Favorite" aria-label={`Favorite ${it.name}`} aria-pressed={favs.includes(pkey(it.name))} onClick={() => toggleFav(it.name)}><Icon n="heart" s={17} /></button>}
        {!offline && <button className="icon" title="Save for offline" aria-label={`Save ${it.name} for offline`} onClick={() => saveOffline([it.name], it.size)}><Icon n="save" s={17} /></button>}
        <button className={open ? 'icon on-m' : 'icon'} title="More" aria-label={`More actions for ${it.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setMenuFor(open ? null : it.name)}><Icon n="more" s={17} /></button>
        {open && (
          <>
            <div className="amenu-bg" onClick={() => setMenuFor(null)} />
            <div className="amenu" role="menu">
              {isVid && <button role="menuitem" onClick={done(() => setAddTo([it.name]))}><Icon n="folder" s={15} /> Add to collection…</button>}
              {isVid && <button role="menuitem" onClick={done(() => setDetail(it.name))}><Icon n="info" s={15} /> Details</button>}
              {isVid && <button role="menuitem" onClick={done(() => setWatched(it.name, !p?.watched))}><Icon n="check" s={15} /> {p?.watched ? 'Mark as unwatched' : 'Mark as watched'}</button>}
              {!offline && !bridge && <button role="menuitem" onClick={done(() => download(it))}><Icon n="down" s={15} /> Download</button>}
              {offline && bridge && <button role="menuitem" onClick={done(() => { api<{ path: string }>('localpath', { root: rid, path: join(dir, it.name) }).then((r) => bridge?.reveal(r.path)); })}><Icon n="folder" s={15} /> Show in folder</button>}
              <i className="amenu-sep" />
              <button role="menuitem" className="del" onClick={done(() => confirmDelete([it.name], `“${it.name}”`))}><Icon n="trash" s={15} /> {offline ? 'Delete from this laptop' : 'Delete from server'}</button>
            </div>
          </>
        )}
      </>
    );
  };

  if (!hasServer && !skipSetup && !play && roots.length > 0 && !roots.some((r) => !r.offline || r.opened) && panel !== 'servers') {
    return <Setup firstRun onClose={() => {}} onChanged={serversChanged} onOffline={() => { try { localStorage.setItem('cinema.skipSetup', '1'); } catch { /* ignore */ } setSkipSetup(true); }} />;
  }

  return (
    <div className="shell tn"
      onDragOver={(e) => { if (bridge && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}>
      {dragging && <div className="dropzone" aria-hidden="true"><Icon n="play" s={42} /><strong>Drop to play</strong><span>The videos are played where they are. Nothing is copied.</span></div>}
      <header className="topnav" aria-label="Main navigation">
        <div className="tn-brand" title={APP_NAME} onClick={() => setView('home')}><span className="lamp" /><span>{APP_NAME}</span></div>
        <nav className="tn-tabs">
          {([['home', 'Home', 'home'], ['library', 'Library', 'film'], ['playlists', 'Playlists', 'list'], ['collections', 'Collections', 'folder']] as const).map(([id, label, ic]) => (
            <button key={id} className={view === id ? 'tn-tab on' : 'tn-tab'} onClick={() => setView(id)} title={label}><Icon n={ic} s={17} /><span>{label}</span></button>
          ))}
        </nav>
        <button className="tn-search" onClick={() => setPalette(true)} title="Search and commands (Ctrl+K)"><Icon n="search" s={16} /><span>Search or jump to…</span><kbd>Ctrl K</kbd></button>
        <div className="tn-right">
          {upd && (upd.state === 'available' || upd.state === 'downloading' || upd.state === 'ready') && (
            <button className="tn-pill" title="Update available" onClick={() => (upd.state === 'available' ? bridge?.updateDownload() : upd.state === 'ready' ? bridge?.updateInstall() : undefined)}>
              <Icon n="cloud" s={15} /><span>{upd.state === 'ready' ? 'Restart to update' : upd.state === 'downloading' ? `Updating ${upd.percent}%` : 'Update'}</span>
            </button>
          )}
          <div className="tn-more">
            <NetMini onClick={() => { setMore(false); setDataOpen((x) => !x); }} />
            {dataOpen && <DataPanel budget={budget} saver={saver} queued={queueInfo.active + queueInfo.waiting}
              onBudget={(g) => { post('settings', { budgetGB: g }).then(() => loadSrv()).catch(() => {}); }}
              onClose={() => setDataOpen(false)}
              onDownloads={() => { setDataOpen(false); setPanel('downloads'); }}
              onInsights={() => { setDataOpen(false); setView('insights'); }}
              onSettings={() => { setDataOpen(false); setPanel('settings'); }} />}
          </div>
          <button className="tn-ic" onClick={() => setPanel('downloads')} title="Downloads" aria-label="Downloads">
            <Icon n="down" s={19} />
            {queueInfo.active + queueInfo.waiting > 0 && <em className="nav-badge">{queueInfo.active + queueInfo.waiting}</em>}
          </button>
          <button className="tn-ic" onClick={() => setPanel('settings')} title="Settings" aria-label="Settings"><Icon n="sliders" s={19} /></button>
          <div className="tn-more">
            <button className={more ? 'tn-ic on' : 'tn-ic'} onClick={() => { setDataOpen(false); setMore((x) => !x); }} title="More" aria-label="More" aria-expanded={more}><Icon n="grid" s={19} /></button>
            {more && <>
              <div className="tn-back" onClick={() => setMore(false)} />
              <div className="tn-menu" role="menu">
                <button role="menuitem" onClick={() => { setMore(false); setView('insights'); }}><Icon n="gauge" s={16} /> Insights</button>
                {bridge && <button role="menuitem" onClick={() => { setMore(false); pickFile(); }}><Icon n="folder" s={16} /> Open file <kbd>Ctrl O</kbd></button>}
                <button role="menuitem" onClick={() => { setMore(false); setPanel('servers'); }}><Icon n="server" s={16} /> Servers</button>
              </div>
            </>}
          </div>
        </div>
      </header>

      <main className="main" style={{ ['--pw' as string]: `${s.density}px` }}>
        {saver > s.saver && <p className="note">Data Saver switched to Low because you used most of this month’s data budget.</p>}
        {rootsErr && (
          <div className="note err">
            <strong>{hasServer ? `Cannot reach your server.` : 'No server yet.'}</strong> {rootsErr}
            <p className="muted">{hasServer ? 'Your downloaded videos still work below.' : 'Add a server to stream, or watch what is already downloaded.'}</p>
            <span className="inline"><button className="btn" onClick={() => loadRoots()}>Try again</button><button className="btn ghost" onClick={() => setPanel('servers')}>Servers</button></span>
          </div>
        )}

        {view === 'home' && (() => {
          const pool = resumable.slice(0, 4);
          const hero = pool.length ? pool[heroI % pool.length] : undefined;
          const first = savedFiles[0];
          const t = hero ? parseTitle(hero.name, hero.dir) : first ? parseTitle(first.name) : null;
          const recent = [...items].sort((a, b) => b.mtime - a.mtime).slice(0, 14);
          const cardArt = (x: { rid: number; dir: string; name: string }) => <Art root={x.rid} path={join(x.dir, x.name)} v={0} name={x.name} />;
          const goal = prefs.goal ?? 30;
          const hh = new Date().getHours();
          const hello = hh < 5 ? 'Late night' : hh < 12 ? 'Good morning' : hh < 18 ? 'Good afternoon' : 'Good evening';
          const log = prefs.daylog ?? {};
          const todayMin = Math.floor((log[dayKey()] ?? 0) / 60);
          let streak = 0;
          for (let i = (log[dayKey()] ?? 0) >= 600 ? 0 : 1; i < 120; i++) { if ((log[dayKey(new Date(Date.now() - i * 86400_000))] ?? 0) >= 600) streak++; else break; }
          const DEFAULT_ROWS: HomeRow[] = [
            { id: 'continue', label: 'Continue watching', on: true }, { id: 'because', label: 'Because you watched…', on: true }, { id: 'saved', label: 'Saved on this laptop', on: true },
            { id: 'favorites', label: 'Favorites', on: true }, { id: 'collections', label: 'Collections', on: true }, { id: 'recent', label: 'Recently added', on: true },
          ];
          const saved = prefs.homeRows ?? [];
          const order: HomeRow[] = [...saved.filter((x) => DEFAULT_ROWS.some((d) => d.id === x.id)).map((x) => ({ ...DEFAULT_ROWS.find((d) => d.id === x.id)!, on: x.on })), ...DEFAULT_ROWS.filter((d) => !saved.some((x) => x.id === d.id))];
          const rowsJsx: Record<string, React.ReactNode> = {
            continue: resumable.length > 1 ? (
              <Rail key="continue" title="Continue watching">
                {resumable.slice(1).map((x) => <Tile key={x.k} name={x.name} sub={x.p ? `${clock(x.p.pos)} of ${clock(x.p.dur)}` : ''} progress={progPct(x.p)} art={cardArt(x)} onClick={() => startPlay(x.name, x.rid, x.dir)} />)}
              </Rail>
            ) : null,
            because: because ? (
              <Rail key="because" title={`Because you watched ${because.title}`} hint="Next in the same folder">
                {because.items.map((e) => <Tile key={e.name} name={e.name} sub={bytes(e.size)} art={<Art root={because.root} path={join(because.dir, e.name)} v={e.mtime} name={e.name} />} onClick={() => startPlay(e.name, because.root, because.dir)} />)}
              </Rail>
            ) : null,
            saved: savedFiles.length > 0 ? (
              <Rail key="saved" title="Saved on this laptop" hint="Plays with no internet">
                {savedFiles.slice(0, 16).map((f) => (
                  <Tile key={f.rel} name={f.name} sub={savedSub(f)} badge="Offline" progress={progPct(prog[`Offline:${f.rel}`])}
                    art={<Art root={OFFLINE_ID} path={f.rel} v={f.mtime} name={f.name} />} onClick={() => playOffline(f.rel)} />
                ))}
              </Rail>
            ) : null,
            favorites: favCards.length > 0 ? (
              <Rail key="favorites" title="Favorites">
                {favCards.map((x) => <Tile key={x.k} name={x.name} progress={progPct(x.p)} art={cardArt(x)} onClick={() => startPlay(x.name, x.rid, x.dir)} />)}
              </Rail>
            ) : null,
            collections: cols.filter((c) => c.items.length).slice(0, 3).map((c) => (
              <Rail key={'col' + c.id} title={c.name} hint="Collection">
                {c.items.slice(0, 14).map((it, i) => {
                  const rr = roots.find((x) => x.name === it.root);
                  return <Tile key={it.path + i} name={baseName(it.path)} art={rr ? <Art root={rr.id} path={it.path} v={0} name={baseName(it.path)} /> : <span className="art"><span className="ph"><Icon n="film" s={26} /></span></span>} onClick={() => playFromCollection(it, c.items)} />;
                })}
              </Rail>
            )),
            recent: recent.length > 0 && !offline && !opened ? (
              <Rail key="recent" title="Recently added" hint={cur?.name}>
                {recent.map((it) => it.dir
                  ? <Tile key={it.name} name={it.name} sub="Folder" art={<span className="art"><span className="ph"><Icon n="folder" s={30} /></span></span>} onClick={() => { setView('library'); setDir(it.name); }} />
                  : <Tile key={it.name} name={it.name} sub={bytes(it.size)} badge={isNew(it) ? 'New' : undefined} art={<Art root={rid} path={join(dir, it.name)} v={it.mtime} name={it.name} />} onClick={() => startPlay(it.name)} />)}
              </Rail>
            ) : null,
          };
          return (
            <div className="home">
              {hero && t ? (
                <Hero key={hero.k} eyebrow="Continue watching" greeting={hello} onCustomize={() => setCustomize(true)}
                  title={t.title + (t.season ? `  ·  S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}` : '')}
                  line={hero.p ? `${clock(hero.p.pos)} watched of ${clock(hero.p.dur)}` : ''} left={hero.p && hero.p.dur > hero.p.pos ? `${clock(hero.p.dur - hero.p.pos)} left` : ''}
                  progress={progPct(hero.p)} label="Resume" art={cardArt(hero)}
                  pool={pool.map((x) => ({ k: x.k, title: parseTitle(x.name, x.dir).title, art: cardArt(x) }))} activeKey={hero.k} onPick={(k) => setHeroI(Math.max(0, pool.findIndex((x) => x.k === k)))}
                  onPlay={() => startPlay(hero.name, hero.rid, hero.dir)} onMore={() => { setRoot(hero.rid); setDir(hero.dir); setDetail(hero.name); }} />
              ) : first && t ? (
                <Hero eyebrow="Saved on this laptop" greeting={hello} onCustomize={() => setCustomize(true)} title={t.title} line={savedSub(first)} label="Play"
                  art={<Art root={OFFLINE_ID} path={first.rel} v={first.mtime} name={first.name} />} onPlay={() => playOffline(first.rel)} />
              ) : (
                <>
                  <div className="greet-top"><h1 className="page-h">{hello}</h1><button className="btn ghost sm" onClick={() => setCustomize(true)}><Icon n="sliders" s={14} /> Customise</button></div>
                  <Welcome onLibrary={() => setView('library')} onOpen={bridge ? pickFile : undefined} />
                </>
              )}
              <Today minutes={todayMin} goal={goal}
                onGoal={() => setNameAsk({ title: 'Daily goal (minutes)', value: String(goal), label: 'Save', go: (v) => setPref('goal', Math.max(5, Math.min(600, parseInt(v, 10) || 30))) })}
                facts={[
                  ...(streak > 0 ? [{ label: 'day streak', value: streak }] : []),
                  ...(resumable.length > 0 ? [{ label: 'in progress', value: resumable.length }] : []),
                  ...(savedFiles.length > 0 ? [{ label: 'saved offline', value: savedFiles.length }] : []),
                  ...(queueInfo.active + queueInfo.waiting > 0 ? [{ label: 'downloading', value: queueInfo.active + queueInfo.waiting, onClick: () => setPanel('downloads') }] : []),
                  ...(lists.length > 0 ? [{ label: lists.length > 1 ? 'playlists' : 'playlist', value: lists.length, onClick: () => setView('playlists') }] : []),
                ]} />
              {order.filter((r) => r.on).map((r) => rowsJsx[r.id])}
            </div>
          );
        })()}

        {view === 'collections' && (
          <div className="home">
            <h1 className="page-h">Collections</h1>
            <CollectionsPage cols={cols}
              art={(it) => { const rr = roots.find((x) => x.name === it.root); return rr ? <Art root={rr.id} path={it.path} v={0} name={baseName(it.path)} /> : <span className="art"><span className="ph"><Icon n="film" s={26} /></span></span>; }}
              onPlay={playFromCollection}
              onRename={(c) => setNameAsk({ title: 'Rename collection', value: c.name, label: 'Rename', go: (v) => setCols(cols.map((x) => (x.id === c.id ? { ...x, name: v.trim() || c.name } : x))) })}
              onDelete={(c) => setAsk({ title: `Delete “${c.name}”?`, body: 'Only the collection is removed. The videos are not touched.', label: 'Delete collection', go: async () => setCols(cols.filter((x) => x.id !== c.id)) })}
              onRemove={(c, i) => setCols(cols.map((x) => (x.id === c.id ? { ...x, items: x.items.filter((_, k) => k !== i) } : x)))} />
          </div>
        )}

        {view === 'insights' && (() => {
          const all = Object.entries(prog);
          const watchedSec = all.reduce((a, [, p]) => a + (p.watched ? p.dur : Math.min(p.pos, p.dur)), 0);
          const week = all.filter(([, p]) => p.updated > Date.now() / 1000 - 7 * 86400 || p.updated > Date.now() - 7 * 86400_000);
          const weekSec = week.reduce((a, [, p]) => a + (p.watched ? p.dur : Math.min(p.pos, p.dur)), 0);
          const savedBytes = savedFiles.reduce((a, f) => a + f.size, 0);
          const byFolder = new Map<string, number>();
          for (const [k, p] of all) { const parts = k.split(':').slice(1).join(':').split('/'); const f = parts.length > 1 ? parts[parts.length - 2] : parts[0]; byFolder.set(f, (byFolder.get(f) ?? 0) + (p.watched ? p.dur : Math.min(p.pos, p.dur))); }
          const top = [...byFolder.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
          const max = Math.max(1, ...top.map((x) => x[1]));
          const hrs = (x: number) => `${Math.floor(x / 3600)} h ${Math.floor((x % 3600) / 60)} min`;
          return (
            <div className="home">
              <h1 className="page-h">Insights</h1>
              <div className="stat-grid">
                <div className="stat"><small>Watched in total</small><b>{hrs(watchedSec)}</b><span className="muted small">{all.filter(([, p]) => p.watched).length} finished videos</span></div>
                <div className="stat"><small>Last 7 days</small><b>{hrs(weekSec)}</b><span className="muted small">{week.length} videos touched</span></div>
                <div className="stat"><small>Saved on this laptop</small><b>{bytes(savedBytes)}</b><span className="muted small">{savedFiles.length} videos, plays offline</span></div>
                <div className="stat"><small>Data used this month</small><b>{bytes(net.month)}</b><span className="muted small">{bytes(net.today)} today</span></div>
              </div>
              <section className="rail">
                <div className="rail-h"><h2>Most watched</h2></div>
                {top.length ? <div className="bars">{top.map(([n, v]) => <div key={n} className="barrow"><span title={n}>{n.replace(/\.[^.]+$/, '')}</span><i><b style={{ width: `${(v / max) * 100}%` }} /></i><em>{hrs(v)}</em></div>)}</div> : <p className="muted">Watch something and it shows up here.</p>}
              </section>
            </div>
          );
        })()}

        {view === 'playlists' && (
          <div className="home">
            <h1 className="page-h">Playlists</h1>
            <Playlists lists={lists}
              durOf={(l) => l.items.reduce((a, n) => a + (prog[`${l.root}:${join(l.dir, n)}`]?.dur ?? 0), 0)}
              onPlay={playList}
              onDelete={(l) => setAsk({ title: `Delete “${l.name}”?`, body: 'Only the playlist is removed. The videos are not touched.', label: 'Delete playlist', go: async () => setLists(lists.filter((x) => x.id !== l.id)) })}
              onMove={(l, i, d) => { const it = [...l.items]; [it[i], it[i + d]] = [it[i + d], it[i]]; setLists(lists.map((x) => (x.id === l.id ? { ...x, items: it } : x))); }}
              onRename={(l) => setNameAsk({ title: 'Rename playlist', value: l.name, label: 'Rename', go: (v) => setLists(lists.map((x) => (x.id === l.id ? { ...x, name: v.trim() || l.name } : x))) })} />
          </div>
        )}

        {view === 'library' && (
          <>
        <div className="lib-head">
          <div className="lib-src" role="tablist" aria-label="Storage">
            {roots.map((r) => (
              <button key={r.id} role="tab" aria-selected={r.id === root} className={r.id === root ? 'lib-src-b on' : 'lib-src-b'} onClick={() => { setRoot(r.id); setDir(''); }} title={r.total ? `${bytes(r.free)} free of ${bytes(r.total)}` : r.dir}>
                {r.opened ? <><Icon n="film" s={14} /> Opened files</> : r.offline ? <><Icon n="hdd" s={14} /> On this laptop</> : <><Icon n="server" s={14} /> {r.name}</>}
              </button>
            ))}
            <span className="grow" />
            <span className={rootsErr ? 'lib-status bad' : hasServer && host ? 'lib-status ok' : 'lib-status'}><i />{hasServer ? (rootsErr ? `Cannot reach ${host}` : host ? host : 'Connecting…') : 'No server set up'}</span>
          </div>
          <nav className="lib-crumbs" aria-label="Folder path">
            {dir && <button className="lib-back" onClick={() => setDir(crumbs.slice(0, -1).join('/'))} title="Back" aria-label="Back"><Icon n="back" s={16} /></button>}
            <button className={dir ? 'lib-crumb' : 'lib-crumb here'} onClick={() => setDir('')}>{opened ? 'Opened files' : offline ? 'On this laptop' : cur?.name ?? '…'}</button>
            {crumbs.map((c, i) => <span key={i} className="lib-crumb-w"><em>›</em><button className={i === crumbs.length - 1 ? 'lib-crumb here' : 'lib-crumb'} onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
          </nav>
        </div>
        {sibs.length > 1 && <div className="season-tabs" role="tablist">{sibs.map((n) => <button key={n} role="tab" aria-selected={n === dir.split('/').pop()} className={n === dir.split('/').pop() ? 'on' : ''} onClick={() => setDir(join(dirOf(dir), n))}>{n}</button>)}</div>}
        {items.length > 0 && (
          <div className="lib-bar c2">
            <div className="lib-c2-title">
              {dir && <button className="lib-back" onClick={() => setDir(crumbs.slice(0, -1).join('/'))} title="Back" aria-label="Back"><Icon n="back" s={16} /></button>}
              <div className="lib-c2-text">
                <h1 className="lib-c2-h">{dir ? (crumbs[crumbs.length - 1] || 'Library') : (opened ? 'Opened files' : offline ? 'On this laptop' : cur?.name ?? 'Library')}</h1>
                <p className="lib-c2-sub">
                  {dir && crumbs.length > 1 ? `${crumbs.slice(0, -1).join(' · ')} · ` : ''}
                  {shown.length === items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : `${shown.length} of ${items.length}`}
                </p>
              </div>
              <div className="lib-quiet" role="toolbar" aria-label="Library tools">
                <div className="lib-sort-wrap">
                  <button type="button" className={sortMenu ? 'lib-quiet-b on' : 'lib-quiet-b'} onClick={() => { setSortMenu((x) => !x); setLibMenu(false); }} aria-haspopup="menu" aria-expanded={sortMenu}>
                    Sort · {sort === 'name' ? 'Name' : sort === 'new' ? 'Newest' : 'Largest'} ▾
                  </button>
                  {sortMenu && (
                    <>
                      <div className="tn-back" onClick={() => setSortMenu(false)} />
                      <div className="lib-sort-menu" role="menu">
                        <div className="lib-menu-lab">Sort by</div>
                        {([['name', 'Name'], ['new', 'Newest'], ['size', 'Largest']] as const).map(([id, label]) => (
                          <button key={id} role="menuitem" className={sort === id ? 'on' : ''} onClick={() => { setSort(id); setSortMenu(false); }}>{label}{sort === id ? ' ✓' : ''}</button>
                        ))}
                        {s.view !== 'list' && (
                          <>
                            <div className="lib-menu-lab">Poster size</div>
                            <div className="lib-dens-row">
                              <input className="dens" type="range" min={110} max={230} step={10} value={s.density} onChange={(e) => set({ density: +e.target.value })} title="Poster size" aria-label="Poster size" />
                            </div>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <button type="button" className={s.view === 'grid' ? 'lib-quiet-b on' : 'lib-quiet-b'} onClick={() => set({ view: 'grid' })}>Grid</button>
                <button type="button" className={s.view === 'list' ? 'lib-quiet-b on' : 'lib-quiet-b'} onClick={() => set({ view: 'list' })}>List</button>
                <button type="button" className={s.view === 'wall' ? 'lib-quiet-b on' : 'lib-quiet-b'} onClick={() => set({ view: 'wall' })}>Wall</button>
                {videos.length > 1 && (
                  <button type="button" className={selecting ? 'lib-quiet-b on' : 'lib-quiet-b'} onClick={() => (selecting ? endSelect() : setSelecting(true))}>{selecting ? 'Done' : 'Select'}</button>
                )}
                {nextUp && !(dir && videos.length > 0) && <button className="btn sm" onClick={() => startPlay(nextUp.name)}><Icon n="play" s={14} /> {nextUp.label}</button>}
                <div className="lib-more">
                  <button type="button" className={libMenu ? 'lib-quiet-b on' : 'lib-quiet-b'} onClick={() => { setLibMenu((x) => !x); setSortMenu(false); }} aria-haspopup="menu" aria-expanded={libMenu} title="More"><Icon n="more" s={16} /></button>
                  {libMenu && (
                    <>
                      <div className="tn-back" onClick={() => setLibMenu(false)} />
                      <div className="lib-menu" role="menu">
                        <button role="menuitem" onClick={() => { setLibMenu(false); refreshAll().then(() => flash('Refreshed')); }}><Icon n="rotate" s={15} /> Refresh<kbd>F5</kbd></button>
                        {videos.length > 1 && <button role="menuitem" onClick={() => { setLibMenu(false); randomPick(); }}><Icon n="bolt" s={15} /> Surprise me</button>}
                        {!offline && dir && <button role="menuitem" onClick={() => { setLibMenu(false); setTarget({ root: rid, paths: [dir], names: [crumbs[crumbs.length - 1]], sizes: 0 }); }}><Icon n="save" s={15} /> Save folder for offline</button>}
                        {!offline && !bridge && dir && <a role="menuitem" href={`/api/download?${qs({ root: rid, path: dir })}`} onClick={() => setLibMenu(false)}><Icon n="down" s={15} /> Download folder</a>}
                        {seen.length > 0 && <><i className="amenu-sep" /><button role="menuitem" className="del" onClick={() => { setLibMenu(false); confirmDelete(seen, `${seen.length} watched video${seen.length > 1 ? 's' : ''}`); }}><Icon n="trash" s={15} /> Delete {seen.length} watched</button></>}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <label className="lib-search c2">
              <Icon n="search" s={16} />
              <input ref={search} placeholder="Search this folder" value={query} onChange={(e) => setQuery(e.target.value)} />
              {query ? <button className="lib-x" onClick={() => setQuery('')} aria-label="Clear search">×</button> : <kbd>/</kbd>}
            </label>


        {dir && videos.length > 0 && (
          <section className="series-head">
            <span className="series-bg" aria-hidden="true"><Art root={rid} path={join(dir, videos[0])} v={0} name={crumbs[crumbs.length - 1]} /></span>
            <span className="series-art"><Art root={rid} path={join(dir, videos[0])} v={0} name={crumbs[crumbs.length - 1]} /></span>
            <div className="series-info">
              <h1>{crumbs[crumbs.length - 1]}</h1>
              <p className="muted">{videos.length} video{videos.length > 1 ? 's' : ''} · {seen.length} watched{videos.length - seen.length > 0 ? ` · ${videos.length - seen.length} to go` : ''}</p>
              <i className="bar"><b style={{ width: `${(seen.length / videos.length) * 100}%` }} /></i>
              <span className="inline sh-act">
                {nextUp && <button className="btn big" onClick={() => startPlay(nextUp.name)}><Icon n="play" s={15} /> {seen.length ? 'Next episode' : 'Start'}</button>}
                {!offline && !opened && <button className="btn ghost big" onClick={() => setRuleFor(true)} title="Keep new or upcoming episodes saved on this laptop"><Icon n="save" s={15} /> Auto-save…</button>}
              </span>
            </div>
          </section>
        )}

            <div className="lib-row lib-chips">
              <div className="chips" role="group" aria-label="Show">
                {([['all', 'All'], ['unwatched', 'Not watched'], ['progress', 'In progress'], ['fav', 'Favorites'], ['rated', 'Rated 4+'], ['watched', 'Watched']] as const).map(([id, label]) => (
                  <button key={id} className={s.filter === id ? 'chipf on' : 'chipf'} aria-pressed={s.filter === id} onClick={() => set({ filter: id as Settings['filter'] })}>{label}</button>
                ))}
              </div>
              {allTags.length > 0 && (
                <select className="lib-sel quiet" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Tag">
                  <option value="">All tags</option>
                  {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
            </div>
          </div>
        )}

        {selecting && (
          <div className="seldock" role="status">
            <strong className="sd-n"><b>{sel.length}</b> selected</strong>
            <button className="btn" disabled={!sel.length} onClick={playSelected}><Icon n="play" s={15} /> Play</button>
            <button className="sd-b" onClick={() => setSel(sel.length === videos.length ? [] : videos)}>{sel.length === videos.length ? 'Clear' : 'Select all'}</button>
            <i className="sd-sep" />
            <button className="sd-b" disabled={!sel.length} onClick={() => setAddTo(videos.filter((n) => sel.includes(n)))}><Icon n="folder" s={15} /> Collection</button>
            <button className="sd-b" disabled={!sel.length} onClick={savePlaylist}><Icon n="list" s={15} /> Playlist</button>
            {!offline && <button className="sd-b" disabled={!sel.length} onClick={saveSelected}><Icon n="save" s={15} /> Offline</button>}
            <button className="sd-b danger" disabled={!sel.length} onClick={() => { const l = videos.filter((n) => sel.includes(n)); endSelect(); confirmDelete(l, `${l.length} video${l.length > 1 ? 's' : ''}`); }}><Icon n="trash" s={15} /> Delete</button>
            <i className="sd-sep" />
            <button className="sd-b" onClick={endSelect} aria-label="Cancel selection">Cancel</button>
          </div>
        )}
        {status === 'loading' && root !== null && <div className="skeletons" aria-label="Loading">{Array.from({ length: 10 }, (_, k) => <i key={k} />)}</div>}
        {status === 'error' && !rootsErr && (
          <div className="note err">
            <strong>Could not read this folder.</strong> {err}
            <p className="muted">Check that the server is reachable and the media folder is right (Servers).</p>
            <button className="btn" onClick={load}>Try again</button>
          </div>
        )}
        {status === 'ready' && items.length === 0 && <p className="note">{opened ? 'No opened videos. Drop a video here, press Ctrl+O, or right-click a video in Explorer and choose Open with Cinema.' : offline ? 'Nothing downloaded yet. Use the save icon on a movie, or “Save for offline” inside the player.' : 'This folder is empty. Downloads from the bot will show up here.'}</p>}
        {status === 'ready' && items.length > 0 && shown.length === 0 && <p className="note">Nothing matches{query ? ` “${query}”` : ' this filter'}.</p>}

        {folders.length > 0 && (
          <div className="tiles">
            {folders.map((f) => (
              <div key={f.name} className="tile" style={{ '--h': hue(f.name) } as CSSProperties}>
                <button className="tile-open" onClick={() => setDir(join(dir, f.name))}>
                  <span className="tile-ic"><Icon n="folder" s={20} /></span>
                  <strong>{f.name}</strong>
                </button>
                <span className="tile-act">
                  {!offline && <button className="icon" title="Save folder for offline" aria-label={`Save folder ${f.name} for offline`} onClick={() => saveOffline([f.name], 0)}><Icon n="save" s={16} /></button>}
                  {!offline && !bridge && <a className="icon" title="Download folder" aria-label={`Download folder ${f.name}`} href={`/api/download?${qs({ root: rid, path: join(dir, f.name) })}`}><Icon n="down" s={16} /></a>}
                  <button className="icon danger" title="Delete" aria-label={`Delete folder ${f.name}`} onClick={() => confirmDelete([f.name], `“${f.name}”`)}><Icon n="trash" s={16} /></button>
                </span>
              </div>
            ))}
          </div>
        )}

        {posters.length > 0 && (
          <ul className={(s.posters ? 'posters portrait' : 'posters') + (s.view === 'wall' ? ' wall' : '')}>
            {posters.map((it) => {
              const p = prog[pkey(it.name)];
              const part = p && !p.watched && p.pos > 30;
              return (
                <li key={it.name} className={(p?.watched ? 'poster done' : 'poster') + (sel.includes(it.name) ? ' picked' : '') + (menuFor === it.name ? ' menu-open' : '')} style={{ '--h': hue(it.name) } as CSSProperties}>
                  {selecting && <span className={sel.includes(it.name) ? 'selmark on' : 'selmark'} aria-hidden="true"><Icon n="check" s={14} /></span>}
                  {isNew(it) && <span className="new-b">NEW</span>}
                  <button className="poster-open" onClick={() => (selecting ? toggleSel(it.name) : startPlay(it.name))}>
                    <span className="frame">
                      <Art root={rid} path={join(dir, it.name)} v={it.mtime} name={it.name} />
                      <span className="go"><Icon n="play" s={18} /></span>
                      {p?.watched && <span className="tag"><Icon n="check" s={12} /> Watched</span>}
                      {favs.includes(pkey(it.name)) && <span className="fav-dot" aria-label="Favorite"><Icon n="heart" s={13} /></span>}
                      {part && <i className="prog"><b style={{ width: `${pct(p)}%` }} /></i>}
                    </span>
                    <span className="p-name" title={it.name}>{it.name.replace(/\.[^.]+$/, '')}</span>
                    <span className="small muted">{bytes(it.size)}{part ? `, stopped at ${clock(p.pos)}` : ''}</span>
                  </button>
                  <span className="p-act">{fileActions(it, true, p)}</span>
                </li>
              );
            })}
          </ul>
        )}

        {rows.length > 0 && (
          <ul className="rows">
            {rows.map((it) => {
              const isVid = VIDEO.test(it.name);
              const p = prog[pkey(it.name)];
              const part = p && !p.watched && p.pos > 30;
              return (
                <li key={it.name} className={(p?.watched ? 'row done' : 'row') + (sel.includes(it.name) ? ' picked' : '') + (menuFor === it.name ? ' menu-open' : '')}>
                  {selecting && isVid && <span className={sel.includes(it.name) ? 'selmark on inrow' : 'selmark inrow'} aria-hidden="true"><Icon n="check" s={14} /></span>}
                  {isNew(it) && <span className="new-b inrow">NEW</span>}
                  <button className="open" onClick={() => isVid && (selecting ? toggleSel(it.name) : startPlay(it.name))}>
                    <span className="ico">{isVid && s.thumbs ? <Thumb root={rid} path={join(dir, it.name)} v={it.mtime} icon="film" /> : <Icon n={isVid ? 'film' : 'file'} />}</span>
                    <span className="info">
                      <span className="name">{it.name}</span>
                      <span className="meta muted small">{bytes(it.size)}, {new Date(it.mtime * 1000).toLocaleDateString()}{part ? `, stopped at ${clock(p.pos)}` : ''}</span>
                      {part && <i className="prog"><b style={{ width: `${pct(p)}%` }} /></i>}
                    </span>
                    {p?.watched && <span className="tag"><Icon n="check" s={13} /> Watched</span>}
                  </button>
                  <span className="r-act">{fileActions(it, isVid, p)}</span>
                </li>
              );
            })}
          </ul>
        )}
          </>
        )}
      </main>

      {play && root !== null && (
        <Player
          key={`${root}:${join(dir, play)}`} root={root} dir={dir} name={play} videos={playlist ?? videos} playlist={!!playlist} floating={floating} onFloat={setFloating}
          pkey={pkey(play)} saved={prog[pkey(play)]} offline={offline} opened={opened} saver={eco ? Math.max(saver, 1) : saver} caps={caps}
          onClose={() => { if (isPop) { window.close(); return; } setPlay(null); setPlaylist(null); setFloating(false); setTimeout(loadProg, 500); }}
          onNext={setPlay} onStarted={onStarted} onTick={addWatch}
          onDownload={(n) => saveOffline([n], items.find((i) => i.name === n)?.size ?? 0)}
          onDelete={(n) => { setPlay(null); confirmDelete([n], `“${n}”`); }}
        />
      )}
      {panel === 'settings' && <SettingsDialog mode={net.mode} prog={prog} onClose={() => setPanel(null)} onStorage={() => setPanel('storage')} onServers={() => setPanel('servers')} onTidy={() => setPanel('tidy')} onSaved={loadSrv} />}
      {panel === 'servers' && <Setup firstRun={false} onClose={() => setPanel(null)} onChanged={serversChanged} onOffline={() => setPanel(null)} />}
      {panel === 'downloads' && <DownloadsPanel onClose={() => setPanel(null)} onPlay={playOffline} onStorage={() => setPanel('storage')} />}
      {panel === 'storage' && <StoragePanel onClose={() => setPanel(null)} onPlay={playOffline} onChanged={() => { loadRoots(); loadProg(); if (offline) load(); }} />}
      {target && (
        <DownloadDialog {...target} caps={caps} onClose={() => setTarget(null)}
          onScheduled={(t) => { setTarget(null); flash(t); setPanel('downloads'); }}
          onQueued={(n) => { setTarget(null); flash(n ? `Added ${n} to Downloads` : 'Already saved or queued'); if (n) setPanel('downloads'); }} />
      )}
      {detail && <Details name={detail} folder={dir} size={items.find((i) => i.name === detail)?.size} prog={prog[pkey(detail)]} meta={metaOf(detail)} allTags={allTags} onMeta={(p) => setMetaFor(detail, p)} remote={!offline} onClose={() => setDetail(null)} onPlay={() => { startPlay(detail); setDetail(null); }} onSave={() => { const n = detail; setDetail(null); saveOffline([n], items.find((i) => i.name === n)?.size ?? 0); }} />}
      {addTo && <AddToCollection cols={cols} count={addTo.length} onClose={() => setAddTo(null)} onPick={(id, name) => {
        const rn = cur?.name ?? '';
        const ents = addTo.map((n) => ({ root: rn, path: join(dir, n) }));
        if (id === 'new') setCols([...cols, { id: `${Date.now()}`, name: name ?? 'Collection', items: ents }]);
        else setCols(cols.map((c) => (c.id === id ? { ...c, items: [...c.items, ...ents.filter((e) => !c.items.some((x) => x.root === e.root && x.path === e.path))] } : c)));
        setAddTo(null); endSelect(); flash('Added to the collection');
      }} />}
      {ruleFor && cur && <RuleDialog root={rid} dir={dir} label={dir.split('/').pop() ?? cur.name} onClose={() => setRuleFor(false)} onDone={(m) => { setRuleFor(false); flash(m); }} />}
      {customize && (() => {
        const DEF = [['continue', 'Continue watching'], ['because', 'Because you watched…'], ['saved', 'Saved on this laptop'], ['favorites', 'Favorites'], ['collections', 'Collections'], ['recent', 'Recently added']];
        const cfg = prefs.homeRows ?? [];
        const rows: HomeRow[] = [...cfg.filter((x) => DEF.some((d) => d[0] === x.id)).map((x) => ({ id: x.id, on: x.on, label: DEF.find((d) => d[0] === x.id)![1] })), ...DEF.filter((d) => !cfg.some((x) => x.id === d[0])).map((d) => ({ id: d[0], label: d[1], on: true }))];
        return <HomeCustomize rows={rows} onChange={(r) => setPref('homeRows', r.map((x) => ({ id: x.id, on: x.on })))} onClose={() => setCustomize(false)} />;
      })()}
      {!prefs.tourDone && view === 'home' && !isPop && <Tour onDone={() => setPref('tourDone', true)} />}
      {panel === 'tidy' && <Tidy onClose={() => setPanel(null)} onChanged={() => { refreshAll(); }} />}
      {palette && <Palette cmds={palCmds} onClose={() => setPalette(false)} />}
      {help && <Sheet onClose={() => setHelp(false)} />}
      {nameAsk && <NameDialog ask={nameAsk} onClose={() => setNameAsk(null)} />}
      {ask && <Confirm ask={ask} onClose={() => setAsk(null)} onError={flash} />}
      {dls.length > 0 && <Tray dls={dls} onDismiss={(id) => setDls((d) => d.filter((x) => x.id !== id))} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Tray({ dls, onDismiss }: { dls: DL[]; onDismiss: (id: string) => void }) {
  return (
    <aside className="tray" aria-label="Browser downloads">
      {dls.map((d) => (
        <div key={d.id} className="dl">
          <div className="dl-top">
            <strong title={d.name}>{d.name}</strong>
            {d.state === 'run'
              ? <button className="icon sm" onClick={() => d.ctl.abort()} title="Cancel" aria-label="Cancel download"><Icon n="close" s={15} /></button>
              : <button className="icon sm" onClick={() => onDismiss(d.id)} title="Dismiss" aria-label="Dismiss"><Icon n="close" s={15} /></button>}
          </div>
          <i className="prog"><b style={{ width: `${Math.min(100, (d.done / d.total) * 100)}%` }} /></i>
          <span className="small muted">
            {d.state === 'run' && `${bytes(d.done)} of ${bytes(d.total)}, ${rate(d.speed)} (${mbps(d.speed)})${d.speed > 0 ? `, ${clock((d.total - d.done) / d.speed)} left` : ''}`}
            {d.state === 'done' && `Saved, ${bytes(d.total)}`}
            {d.state === 'cancel' && 'Cancelled'}
            {d.state === 'error' && `Failed: ${d.error ?? 'unknown error'}`}
          </span>
        </div>
      ))}
    </aside>
  );
}

function Confirm({ ask, onClose, onError }: { ask: Ask; onClose: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <h3>{ask.title}</h3>
        <p className="muted">{ask.body}</p>
        <div className="dlg-actions">
          <button className="btn ghost" onClick={onClose}>Keep it</button>
          <button className="btn danger" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await ask.go(); } catch (e: any) { onError(e.message); }
            onClose();
          }}>{busy ? 'Deleting…' : ask.label}</button>
        </div>
      </div>
    </div>
  );
}

function NameDialog({ ask, onClose }: { ask: { title: string; value: string; label: string; go: (v: string) => void }; onClose: () => void }) {
  const [v, setV] = useState(ask.value);
  const done = () => { ask.go(v); onClose(); };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={ask.title}>
        <h3>{ask.title}</h3>
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') onClose(); }} />
        <div className="dlg-actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={done}>{ask.label}</button></div>
      </div>
    </div>
  );
}


function Palette({ cmds, onClose }: { cmds: { t: string; k: string; run: () => void }[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = cmds.filter((c) => q.split(/\s+/).every((w) => c.t.toLowerCase().includes(w.toLowerCase()))).slice(0, 12);
  const go = (c?: { run: () => void }) => { if (!c) return; onClose(); c.run(); };
  return (
    <div className="scrim top" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input autoFocus placeholder="Type a command or the name of a video…" value={q}
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
            else if (e.key === 'Enter') go(list[i]);
            else if (e.key === 'Escape') onClose();
          }} />
        <div className="pal-list" role="listbox">
          {list.map((c, n) => <button key={c.t + n} role="option" aria-selected={n === i} className={n === i ? 'on' : ''} onMouseEnter={() => setI(n)} onClick={() => go(c)}><span>{c.t}</span>{c.k && <kbd>{c.k}</kbd>}</button>)}
          {!list.length && <p className="muted small">Nothing matches “{q}”.</p>}
        </div>
      </div>
    </div>
  );
}

function Sheet({ onClose }: { onClose: () => void }) {
  const rows = [['Ctrl + K', 'Command palette'], ['Ctrl + 1 / 2 / 3', 'Home, Library, Playlists'], ['Ctrl + 4 or Ctrl + D', 'Downloads'], ['Ctrl + ,', 'Settings'], ['Ctrl + F or /', 'Search this folder'], ['Ctrl + A', 'Select every video'],
    ['Delete', 'Delete the selected videos'], ['F5 or Ctrl + R', 'Refresh'], ['Ctrl + O', 'Open a video from this computer'], ['Esc', 'Close or clear selection'], ['?', 'This sheet'], ['In the player', 'Press H for the player shortcuts']];
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <h3>Keyboard shortcuts</h3>
        <div className="sheet-grid">{rows.map(([k, d]) => <p key={k}><kbd>{k}</kbd><span>{d}</span></p>)}</div>
      </div>
    </div>
  );
}


// Data popover: opens from the network meter in the top bar. Live speed, usage, budget and Data Saver in one place.
function DataPanel({ budget, saver, queued, onBudget, onClose, onDownloads, onSettings, onInsights }: {
  budget: number; saver: number; queued: number; onBudget: (gb: number) => void; onClose: () => void; onDownloads: () => void; onSettings: () => void; onInsights: () => void;
}) {
  const { s, set } = useContext(SettingsCtx);
  const net = useNet(null, 1500);
  const hist = net.hist.length > 1 ? net.hist : [0, 0];
  const peak = Math.max(1, ...hist);
  const pts = hist.map((v, i) => `${(i / (hist.length - 1)) * 300},${58 - (v / peak) * 52}`);
  const line = `M${pts.join(' L')}`;
  const used = budget > 0 ? Math.min(100, (net.month / (budget * 1e9)) * 100) : 0;
  const left = budget > 0 ? Math.max(0, budget * 1e9 - net.month) : 0;
  const now = new Date();
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
  return (
    <>
      <div className="tn-back" onClick={onClose} />
      <section className="dpanel" role="dialog" aria-label="Data usage">
        <div className="dp-live">
          <div>
            <small>{net.active ? 'Transferring now' : 'Idle'}</small>
            <b>{net.ok ? rate(net.speed) : 'Offline'}</b>
          </div>
          <span className={net.active ? 'dp-tag on' : 'dp-tag'}>{net.ok ? (net.mode || 'connected') : 'no connection'}</span>
        </div>
        <svg className="dp-spark" viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true">
          <path d={`${line} L300,60 L0,60 Z`} className="dp-fill" />
          <path d={line} className="dp-line" />
        </svg>

        <div className="dp-stats">
          <div><small>Today</small><b>{bytes(net.today)}</b></div>
          <div><small>This month</small><b>{bytes(net.month)}</b></div>
          <div><small>All time</small><b>{bytes(net.lifetime)}</b></div>
        </div>

        <div className="dp-block">
          <div className="dp-h"><strong>Monthly budget</strong><span className="muted small">{budget > 0 ? `${bytes(left)} left · ${daysLeft} day${daysLeft > 1 ? 's' : ''} to go` : 'No limit set'}</span></div>
          {budget > 0 && <div className={used >= 80 ? 'dp-bar warn' : 'dp-bar'}><i style={{ width: `${used}%` }} /></div>}
          <div className="dp-chips">
            {[0, 5, 10, 20, 50, 100].map((g) => <button key={g} className={budget === g ? 'on' : ''} onClick={() => onBudget(g)}>{g === 0 ? 'No limit' : `${g} GB`}</button>)}
          </div>
        </div>

        <div className="dp-block">
          <div className="dp-h"><strong>Data Saver</strong><span className="muted small">{saver > s.saver ? 'Raised automatically by your budget' : SAVER[saver]?.hint}</span></div>
          <div className="dp-seg" role="group" aria-label="Data Saver">
            {SAVER.map((o) => <button key={o.id} className={saver === o.id ? 'on' : ''} onClick={() => set({ saver: o.id })}>{o.label}</button>)}
          </div>
          <label className="dp-row"><span>Switch to Low at 80% of the budget</span><Toggle on={s.saverAuto} label="Auto Data Saver" onClick={() => set({ saverAuto: !s.saverAuto })} /></label>
        </div>

        <div className="dp-foot">
          <button onClick={onDownloads}><Icon n="down" s={15} /> {queued > 0 ? `${queued} downloading` : 'Downloads'}</button>
          <button onClick={onInsights}><Icon n="gauge" s={15} /> Insights</button>
          <button onClick={onSettings}><Icon n="sliders" s={15} /> All data settings</button>
        </div>
      </section>
    </>
  );
}

// Live network speed. It has its own timer, so the library is not redrawn every couple of seconds while videos download.
function NetMini({ onClick }: { onClick: () => void }) {
  const net = useNet(null, 2500);
  return (
    <button className="netmini" onClick={onClick} title={`Network: ${net.ok ? rate(net.speed) : 'offline'} · today ${bytes(net.today)}`}>
      <i className={net.active ? 'dot on' : 'dot'} /><span>{net.ok ? rate(net.speed) : 'offline'}</span><small>{bytes(net.today)} today</small>
    </button>
  );
}