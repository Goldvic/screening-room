import { CSSProperties, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Player from './Player';
import Setup from './Setup';
import SettingsDialog from './Settings';
import { AddToCollection, CollectionsPage, Collection, HomeCustomize, HomeRow, RuleDialog, Tidy, Tour, ItemMeta } from './Extras';
import { Hero, MagSide, Playlists, Rail, SavedFile, Tile, Today, Welcome, progPct, savedSub } from './Home';
import { DownloadDialog, DownloadsPanel, StoragePanel } from './Downloads';
import { Discover } from './Discover';
import { Library } from './pages/Library';
import { Art } from './components/Art';
import { Details } from './components/Details';
import { Confirm, Ask } from './components/Confirm';
import { NameDialog, NameAsk } from './components/NameDialog';
import { Palette, Sheet } from './components/Palette';
import { DataPanel, NetMini } from './components/DataPanel';
import { Tray, DL } from './components/Tray';
import {
  ACCENTS, APP_NAME, Caps, SavedList, dayKey, DEFAULTS, Entry, Icon, OFFLINE_ID, OPENED_ID, Prefs, PrefsCtx, Prog, Root, SAVER, SettingsCtx, VIDEO, VIDEO_EXTS,
  api, bridge, bytes, clock, hue, join, loadSettings, mbps, parseTitle, pct, post, qs, rate, turboDownload, turboOk, useNet, useUpdates, Settings,
} from './lib';

type RootsRes = { host: string; mode: string; error: string; hasServer: boolean; roots: Root[] };
type Target = { root: number; paths: string[]; names: string[]; sizes: number };
type Card = { k: string; p?: Prog; rid: number; dir: string; name: string };

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [prefs, setPrefs] = useState<Prefs>({});
  const timers = useRef<Record<string, number>>({});
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
      <PrefsCtx.Provider value={{ prefs, setPref }}><Shell /></PrefsCtx.Provider>
    </SettingsCtx.Provider>
  );
}

function Shell() {
  const { s, set } = useContext(SettingsCtx);
  const { prefs, setPref } = useContext(PrefsCtx);
  const [host, setHost] = useState('');
  const [hasServer, setHasServer] = useState(true);
  const [rootsErr, setRootsErr] = useState('');
  const [roots, setRoots] = useState<Root[]>([]);
  
  const [root, setRoot] = useState<number | null>(null);
  const [dir, setDir] = useState('');
  const [lastLoc, setLastLoc] = useState<{ root: number; dir: string } | null>(null);
  const activeLoc = lastLoc || { root: root ?? -1, dir };

  const [items, setItems] = useState<Entry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');
  const [play, setPlay] = useState<string | null>(null);
  const [playLoc, setPlayLoc] = useState<{ root: number; dir: string } | null>(null);
  const [playVideos, setPlayVideos] = useState<string[] | null>(null);
  const beginPlay = (name: string, r: number, d: string) => { setPlayLoc({ root: r, dir: d }); setPlayVideos(null); setPlay(name); };
  
  const [ask, setAsk] = useState<Ask | null>(null);
  const [toast, setToast] = useState('');
  const [prog, setProg] = useState<Record<string, Prog>>({});
  const [panel, setPanel] = useState<null | 'settings' | 'servers' | 'downloads' | 'storage' | 'tidy'>(null);
  const [dls, setDls] = useState<DL[]>([]);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [budget, setBudget] = useState(0);
  const [queueInfo, setQueueInfo] = useState({ active: 0, waiting: 0, speed: 0 });
  const [skipSetup, setSkipSetup] = useState(() => { try { return localStorage.getItem('cinema.skipSetup') === '1'; } catch { return false; } });
  const pre = useRef(new Set<string>());
  const net = useNet(null, 30000);
  const upd = useUpdates();
  const [dragging, setDragging] = useState(false);
  const [palette, setPalette] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [addTo, setAddTo] = useState<string[] | null>(null);
  const [ruleFor, setRuleFor] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [heroI, setHeroI] = useState(0);
  const [because, setBecause] = useState<{ title: string; items: Entry[]; root: number; dir: string } | null>(null);
  const sinceRef = useRef<number>(prefs.lastVisit ?? Date.now());
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const popQ = useMemo(() => new URLSearchParams(location.search), []);
  const isPop = popQ.get('pop') === '1';
  const [help, setHelp] = useState(false);
  const [onBattery, setOnBattery] = useState(false);
  const [floating, setFloating] = useState(false);
  const [view, setView] = useState<'home' | 'library' | 'playlists' | 'collections' | 'insights' | 'discover'>('home');
  const [savedFiles, setSavedFiles] = useState<SavedFile[]>([]);
  const [nameAsk, setNameAsk] = useState<NameAsk | null>(null);
  const [playlist, setPlaylist] = useState<string[] | null>(null);

  const rootOf = (id: number | null) => roots.find((r) => r.id === id);
  const cur = rootOf(root);
  const offline = !!cur?.offline;
  const opened = !!cur?.opened;
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
      if (dir && /not found/i.test(e.message)) { setDir(dir.split('/').slice(0, -1).join('/')); return; }
      setErr(e.message); setStatus('error');
    }
  }, [root, dir]);

  useEffect(() => { loadRoots(); loadProg(); loadSrv(); loadCaps(); }, [loadRoots, loadProg, loadSrv, loadCaps]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.hidden) return; api<{ active: number; waiting: number; speed: number }>('dl').then((j) => setQueueInfo((o) => (o.active === j.active && o.waiting === j.waiting ? o : j))).catch(() => {}); }, 2500);
    return () => clearInterval(t);
  }, []);

  const refreshAll = () => Promise.all([load(), loadRoots(), loadProg()]);
  const refreshRef = useRef(refreshAll); refreshRef.current = refreshAll;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) { e.preventDefault(); refreshRef.current(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const openLocal = async (files: string[]) => {
    const list = files.filter((f) => f && VIDEO.test(f));
    if (!list.length) { flash('That is not a video file Cinema can play'); return; }
    try {
      let first = '';
      for (const f of list) { const r = await post<{ name: string }>('opened', { path: f }); if (!first) first = r.name; }
      setRoots((rs) => (rs.some((x) => x.id === OPENED_ID) ? rs : [...rs, { id: OPENED_ID, name: 'Opened', dir: '', free: 0, total: 0, offline: true, opened: true } as Root]));
      setPanel(null); setRoot(OPENED_ID); setDir(''); beginPlay(first, OPENED_ID, '');
      loadRoots();
    } catch (e: any) { flash(e.message); }
  };
  const openRef = useRef(openLocal);
  openRef.current = openLocal;
  const pickFile = async () => {
    const f = await bridge?.selectFiles([{ name: 'Videos', extensions: VIDEO_EXTS }]);
    if (f?.length) openLocal(f);
  };

  // Global Zoom handling (Ctrl + / Ctrl - / Ctrl 0)
  useEffect(() => {
    if (!bridge) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      
      // Catch '=', '+', 'Add' (numpad)
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        bridge!.zoomIn();
      } 
      // Catch '-', '_', 'Subtract' (numpad)
      else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        bridge!.zoomOut();
      } 
      // Catch '0' to reset
      else if (e.key === '0') {
        e.preventDefault();
        bridge!.zoomReset();
      }
    };
    
    // Use capture phase so it intercepts the key before the player does
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (play) return;
      const t = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && k === 'k') { e.preventDefault(); setHelp(false); setPalette((x) => !x); return; }
      if (palette || help) { if (e.key === 'Escape') { setPalette(false); setHelp(false); } return; }
      if (mod && k === 'f') { e.preventDefault(); setView('library'); return; }
      if (mod && ['1', '2', '3'].includes(k)) { e.preventDefault(); setView((['home', 'library', 'playlists'] as const)[Number(k) - 1]); return; }
      if (mod && k === '4') { e.preventDefault(); setPanel('downloads'); return; }
      if (mod && k === ',') { e.preventDefault(); setPanel('settings'); return; }
      if (mod && k === 'd') { e.preventDefault(); setPanel('downloads'); return; }
      if (typing || mod) return;
      if (e.key === 'Escape') { if (panel) setPanel(null); return; }
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
    { t: s.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme', k: '', run: () => set({ theme: s.theme === 'dark' ? 'light' : 'dark' }) },
    { t: s.eco === 'on' ? 'Turn power saving off' : 'Turn power saving on', k: '', run: () => set({ eco: s.eco === 'on' ? 'off' : 'on' }) },
    { t: 'Keyboard shortcuts', k: '?', run: () => setHelp(true) },
    ...(bridge ? [{ t: 'Open a video from this computer', k: 'Ctrl O', run: () => pickFile() }] : []),
  ];
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (!bridge) return;
    const paths = [...e.dataTransfer.files].map((f) => bridge!.pathForFile(f)).filter(Boolean);
    if (paths.length) openLocal(paths); else flash('Drop video files from your computer');
  };

  const serversChanged = async () => { setDir(''); setRoot(null); await Promise.all([loadRoots(), loadCaps()]); };

  const remove = async (names: string[], r: number, d: string) => {
    for (const n of names) await api('item', { root: r, path: join(d, n) }, 'DELETE');
    flash('Deleted');
    await Promise.all([loadRoots(), loadProg()]);
  };
  const confirmDelete = (names: string[], what: string) => {
    const isOffline = names.length && typeof what === 'string' && /laptop/i.test(what);
    setAsk({
      title: `Delete ${what}?`,
      body: isOffline
        ? 'This removes the downloaded copy from this laptop. The original on your server is not touched.'
        : 'This removes it from your server permanently. It cannot be undone.',
      label: isOffline ? 'Delete from laptop' : 'Delete from server',
      go: () => remove(names, activeLoc.root, activeLoc.dir),
    });
  };
  const setWatched = async (name: string, watched: boolean) => {
    const p = prog[pkey(name, activeLoc.dir, activeLoc.root)];
    await post('progress', { key: pkey(name, activeLoc.dir, activeLoc.root), pos: watched ? p?.pos ?? 0 : 0, dur: p?.dur ?? 0, watched });
    loadProg();
  };
  const toggleFav = (name: string) => {
    const k = pkey(name, activeLoc.dir, activeLoc.root), f = prefs.favs ?? [];
    setPref('favs', f.includes(k) ? f.filter((x) => x !== k) : [...f, k]);
  };
  const playOffline = (destRel: string) => {
    setFloating(false);
    const parts = destRel.split('/');
    setPanel(null); setRoot(OFFLINE_ID); setDir(parts.slice(0, -1).join('/')); beginPlay(parts[parts.length - 1], OFFLINE_ID, parts.slice(0, -1).join('/'));
  };

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
  const metaOf = (name: string): ItemMeta => metaMap[pkey(name, activeLoc.dir, activeLoc.root)] ?? {};
  const setMetaFor = (name: string, patch: Partial<ItemMeta>) => setPref('meta', { ...metaMap, [pkey(name, activeLoc.dir, activeLoc.root)]: { ...metaOf(name), ...patch } });
  const allTags = [...new Set(Object.values(metaMap).flatMap((m) => m.t ?? []))].sort();
  const baseName = (p: string) => p.split('/').pop() ?? p;
  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
  const addWatch = (sec: number) => {
    const c = prefsRef.current.daylog ?? {};
    const k = dayKey();
    const keep = Object.fromEntries(Object.entries(c).filter(([d]) => d >= dayKey(new Date(Date.now() - 120 * 86400_000))));
    setPref('daylog', { ...keep, [k]: (c[k] ?? 0) + sec });
  };
  useEffect(() => { setPref('lastVisit', Date.now()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const isNew = (it: Entry) => !it.dir && (it.mtime < 1e11 ? it.mtime * 1000 : it.mtime) > sinceRef.current && !prog[pkey(it.name)];
  useEffect(() => {
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
  useEffect(() => {
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
  useEffect(() => {
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
  const playList = (l: SavedList) => {
    const r = roots.find((x) => x.name === l.root);
    if (!r) { flash('That storage is not connected right now'); return; }
    setPanel(null); setPlaylist(l.items); startPlay(l.items[0], r.id, l.dir, true);
  };
  const startPlay = async (name: string, r: number = activeLoc.root, d: string = activeLoc.dir, keepList = false) => {
    setFloating(false);
    if (!keepList) setPlaylist(null);
    const rt = roots.find((x) => x.id === r);
    if (rt && !rt.offline && !keepList) {
      try {
        const j = await api<{ state: string; dest?: string }>('saved', { root: r, path: join(d, name) });
        if (j.state === 'done' && j.dest) { flash('Playing the saved copy from this laptop'); playOffline(j.dest); return; }
      } catch { /* server unreachable: fall through */ }
    }
    beginPlay(name, r, d);
  };

  const download = (it: Entry) => {
    const url = `/api/download?${qs({ root: activeLoc.root, path: join(activeLoc.dir, it.name) })}`;
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
  const saveOffline = (names: string[], sizes: number, r: number = activeLoc.root, d: string = activeLoc.dir) => setTarget({ root: r, paths: names.map((n) => join(d, n)), names, sizes });

  const videos = useMemo(() => items.filter((i) => !i.dir && VIDEO.test(i.name)).map((i) => i.name), [items]);
  const pRoot = playLoc?.root ?? activeLoc.root, pDir = playLoc?.dir ?? activeLoc.dir;
  const pCur = rootOf(pRoot);
  const sameLoc = pRoot === activeLoc.root && pDir === activeLoc.dir;
  useEffect(() => { if (play && sameLoc && status === 'ready') setPlayVideos(videos); }, [videos, sameLoc, play, status]); // eslint-disable-line react-hooks/exhaustive-deps
  const seen = videos.filter((n) => prog[pkey(n)]?.watched);
  const favs = prefs.favs ?? [];

  const cardOf = (k: string, p?: Prog): Card | null => {
    const i = k.indexOf(':'), parts = k.slice(i + 1).split('/');
    const r = roots.find((x) => x.name === k.slice(0, i));
    return r ? { k, p, rid: r.id, dir: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] } : null;
  };
  const resumable = useMemo(() => {
    const seenNames = new Set<string>();
    return Object.entries(prog)
      .filter(([, p]) => !p.watched && p.pos > 30 && p.dur > 0 && p.pos / p.dur < 0.9)
      .sort((a, b) => b[1].updated - a[1].updated)
      .map(([k, p]) => cardOf(k, p)).filter((x): x is Card => !!x)
      .filter((x) => { const n = x.name.toLowerCase(); if (seenNames.has(n)) return false; seenNames.add(n); return true; })
      .slice(0, 10);
  }, [prog, roots]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const crumbs = dir ? dir.split('/') : [];
  const floor = s.saverAuto && budget > 0 && net.month >= budget * 0.8e9 ? 2 : 0;
  const saver = Math.max(s.saver, floor);

  const onStarted = (name: string) => {
    if (!s.predownload || pCur?.offline) return;
    const list = playlist ?? playVideos ?? videos;
    const nx = list[list.indexOf(name) + 1];
    if (!nx || pre.current.has(pkey(nx, pDir, pRoot))) return;
    pre.current.add(pkey(nx, pDir, pRoot));
    post('dl/add', { root: pRoot, paths: [join(pDir, nx)], profile: s.dlProfile, opts: { loud: s.dlLoud, dialogue: s.dlDialogue } })
      .then((r: any) => r.queued && flash(`Saving “${nx.replace(/\.[^.]+$/, '')}” for offline`)).catch(() => {});
  };

  if (!hasServer && !skipSetup && !play && roots.length > 0 && !roots.some((r) => !r.offline || r.opened) && panel !== 'servers') {
    return <Setup firstRun onClose={() => {}} onChanged={serversChanged} onOffline={() => { try { localStorage.setItem('cinema.skipSetup', '1'); } catch { /* ignore */ } setSkipSetup(true); }} />;
  }

  return (
    <div className="shell"
      onDragOver={(e) => { if (bridge && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}>
      {dragging && <div className="dropzone" aria-hidden="true"><Icon n="play" s={42} /><strong>Drop to play</strong><span>The videos are played where they are. Nothing is copied.</span></div>}

      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-top">
          <button className="sidebar-brand" title={APP_NAME} onClick={() => setView('home')}>
            <span className="lamp" />
            <span className="sidebar-label">{APP_NAME}</span>
          </button>
          <button className="sidebar-search" onClick={() => setPalette(true)} title="Search and commands (Ctrl+K)">
            <Icon n="search" s={17} />
            <span className="sidebar-label">Search</span>
            <kbd className="sidebar-label">Ctrl K</kbd>
          </button>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-group">
            <span className="sidebar-group-label">Browse</span>
            {([['home', 'Home', 'home'], ['discover', 'Discover', 'bolt'], ['library', 'Library', 'film']] as const).map(([id, label, ic]) => (
              <button key={id} className={view === id ? 'sidebar-link on' : 'sidebar-link'} onClick={() => setView(id)} title={label} aria-current={view === id ? 'page' : undefined}>
                <Icon n={ic} s={18} />
                <span className="sidebar-label">{label}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-group">
            <span className="sidebar-group-label">Your Stuff</span>
            {([['playlists', 'Playlists', 'list'], ['collections', 'Collections', 'folder'], ['insights', 'Insights', 'gauge']] as const).map(([id, label, ic]) => (
              <button key={id} className={view === id ? 'sidebar-link on' : 'sidebar-link'} onClick={() => setView(id)} title={label} aria-current={view === id ? 'page' : undefined}>
                <Icon n={ic} s={18} />
                <span className="sidebar-label">{label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="sidebar-foot">
          {upd && (upd.state === 'available' || upd.state === 'downloading' || upd.state === 'ready') && (
            <button className="sidebar-link sidebar-update" title="Update available" onClick={() => (upd.state === 'available' ? bridge?.updateDownload() : upd.state === 'ready' ? bridge?.updateInstall() : undefined)}>
              <Icon n="cloud" s={18} />
              <span className="sidebar-label">{upd.state === 'ready' ? 'Restart to update' : upd.state === 'downloading' ? `Updating ${upd.percent}%` : 'Update'}</span>
            </button>
          )}
          {bridge && (
            <button className="sidebar-link sidebar-open" onClick={() => pickFile()} title="Open file (Ctrl O)">
              <Icon n="folder" s={18} />
              <span className="sidebar-label">Open file</span>
            </button>
          )}
          <button className="sidebar-link" onClick={() => setPanel('servers')} title="Servers">
            <Icon n="server" s={18} />
            <span className="sidebar-label">Servers</span>
          </button>
          <button className="sidebar-link" onClick={() => setPanel('downloads')} title="Downloads" aria-label="Downloads">
            <Icon n="down" s={18} />
            <span className="sidebar-label">Downloads</span>
            {queueInfo.active + queueInfo.waiting > 0 && <em className="sidebar-badge">{queueInfo.active + queueInfo.waiting}</em>}
          </button>
          <button className="sidebar-link" onClick={() => setPanel('settings')} title="Settings" aria-label="Settings">
            <Icon n="sliders" s={18} />
            <span className="sidebar-label">Settings</span>
          </button>

          <div className="sidebar-data">
            <NetMini onClick={() => setDataOpen((x) => !x)} />
            {dataOpen && (
              <DataPanel
                budget={budget} saver={saver} queued={queueInfo.active + queueInfo.waiting}
                onBudget={(g) => { post('settings', { budgetGB: g }).then(() => loadSrv()).catch(() => {}); }}
                onClose={() => setDataOpen(false)}
                onDownloads={() => { setDataOpen(false); setPanel('downloads'); }}
                onInsights={() => { setDataOpen(false); setView('insights'); }}
                onSettings={() => { setDataOpen(false); setPanel('settings'); }}
              />
            )}
          </div>
        </div>
      </aside>

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
          const sides = resumable.filter((x) => !hero || x.k !== hero.k).slice(0, 4);
          const onTop = new Set([hero?.k, ...sides.map((x) => x.k)]);
          const moreResumable = resumable.filter((x) => !onTop.has(x.k));
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
            continue: moreResumable.length > 0 ? (
              <Rail key="continue" title="Continue watching">
                {moreResumable.map((x) => <Tile key={x.k} name={x.name} sub={x.p ? `${clock(x.p.pos)} of ${clock(x.p.dur)}` : ''} progress={progPct(x.p)} art={cardArt(x)} onClick={() => startPlay(x.name, x.rid, x.dir)} />)}
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
            <div className="home mag-home">
              <div className="home-head">
                <span className="home-greet">{hello}</span>
                <button className="btn ghost sm" onClick={() => setCustomize(true)}><Icon n="sliders" s={14} /> Customise</button>
              </div>

              {hero && t ? (
                <div className={'mag' + (sides.length ? '' : ' mag-alone')}>
                  <Hero key={hero.k} eyebrow="Continue watching"
                    title={t.title + (t.season ? ` · S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}` : '')}
                    line={hero.p ? `${clock(hero.p.pos)} watched of ${clock(hero.p.dur)}` : ''} left={hero.p && hero.p.dur > hero.p.pos ? `${clock(hero.p.dur - hero.p.pos)} left` : ''}
                    progress={progPct(hero.p)} label="Resume" art={cardArt(hero)}
                    onPlay={() => startPlay(hero.name, hero.rid, hero.dir)} onMore={() => { setRoot(hero.rid); setDir(hero.dir); setDetail(hero.name); }} />
                  {sides.length > 0 && <div className="mag-sides">{sides.map((x) => {
                    const pt = parseTitle(x.name, x.dir);
                    const sub = x.p ? `${pt.season ? `S${String(pt.season).padStart(2, '0')}E${String(pt.episode).padStart(2, '0')} · ` : ''}${clock(Math.max(0, (x.p.dur || 0) - (x.p.pos || 0)))} left` : pt.season ? `S${String(pt.season).padStart(2, '0')}E${String(pt.episode).padStart(2, '0')}` : undefined;
                    return (
                      <MagSide key={x.k} title={pt.title} sub={sub} progress={progPct(x.p)} art={cardArt(x)}
                        onClick={() => startPlay(x.name, x.rid, x.dir)} />
                    );
                  })}</div>}
                </div>
              ) : first && t ? (
                <div className="mag mag-solo">
                  <Hero eyebrow="Saved on this laptop" title={t.title} line={savedSub(first)} label="Play"
                    art={<Art root={OFFLINE_ID} path={first.rel} v={first.mtime} name={first.name} />} onPlay={() => playOffline(first.rel)} />
                </div>
              ) : (
                <Welcome onLibrary={() => setView('library')} onOpen={bridge ? pickFile : undefined} />
              )}

              <Today minutes={todayMin} goal={goal}
                onGoal={() => setNameAsk({ title: 'Daily goal (minutes)', value: String(goal), label: 'Save', go: (v) => setPref('goal', Math.max(5, parseInt(v, 10) || 30)) })}
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
          const watchedSecs = (p: Prog) => {
            const dur = Number(p?.dur) || 0;
            const pos = Number(p?.pos) || 0;
            if (p?.watched) return Math.max(0, dur);
            return Math.max(0, Math.min(pos, dur || pos));
          };
          const finished = all.filter(([, p]) => p.watched);
          const inProg = all.filter(([, p]) => !p.watched && (Number(p.pos) || 0) > 0);
          const watchedSec = all.reduce((a, [, p]) => a + watchedSecs(p), 0);
          const weekCut = Date.now() / 1000 - 7 * 86400;
          const week = all.filter(([, p]) => {
            const u = Number(p.updated) || 0;
            return u > weekCut || u > weekCut * 1000;
          });
          const weekSec = week.reduce((a, [, p]) => a + watchedSecs(p), 0);
          const savedBytes = savedFiles.reduce((a, f) => a + (Number(f.size) || 0), 0);
          const byTitle = new Map<string, number>();
          for (const [k, p] of all) {
            try {
              const path = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k;
              const segs = path.split('/').filter(Boolean);
              const fileName = segs[segs.length - 1] || path;
              const folder = segs.slice(0, -1).join('/');
              const { title } = parseTitle(fileName, folder);
              const label = (title || fileName.replace(/\.[^.]+$/, '')).trim() || 'Unknown';
              byTitle.set(label, (byTitle.get(label) ?? 0) + watchedSecs(p));
            } catch {
              byTitle.set('Unknown', (byTitle.get('Unknown') ?? 0) + watchedSecs(p));
            }
          }
          const top = [...byTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
          const max = Math.max(1, ...top.map((x) => x[1]), 1);
          const hrs = (x: number) => {
            const sec = Math.max(0, Math.floor(Number(x) || 0));
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            if (h <= 0) return `${m} min`;
            return m > 0 ? `${h} h ${m} min` : `${h} h`;
          };
          const log = prefs.daylog ?? {};
          const todayMin = Math.floor((Number(log[dayKey()]) || 0) / 60);
          const goal = Math.max(5, Number(prefs.goal) || 30);
          const goalPct = Math.min(100, Math.round((todayMin / goal) * 100));
          const ringC = 2 * Math.PI * 30;
          let streak = 0;
          for (let i = (Number(log[dayKey()]) || 0) >= 600 ? 0 : 1; i < 120; i++) {
            if ((Number(log[dayKey(new Date(Date.now() - i * 86400_000))]) || 0) >= 600) streak++;
            else break;
          }
          const started = finished.length + inProg.length;
          const finishRate = started ? Math.round((finished.length / started) * 100) : 0;
          return (
            <div className="home insights-page">
              <header className="ins-head">
                <div>
                  <h1 className="page-h">Insights</h1>
                  <p className="ins-sub muted">Your watching habits and offline library</p>
                </div>
              </header>

              <div className="ins-hero">
                <div className="ins-hero-main">
                  <small>Watched in total</small>
                  <b>{hrs(watchedSec)}</b>
                  <span className="muted">{finished.length} finished · {inProg.length} in progress · {all.length} tracked</span>
                </div>
                <div className="ins-hero-side">
                  <div className="ins-pill">
                    <span className="ins-pill-val">{hrs(weekSec)}</span>
                    <span className="ins-pill-lbl">Last 7 days</span>
                    <span className="muted small">{week.length} videos touched</span>
                  </div>
                  <div className="ins-pill">
                    <span className="ins-pill-val">{streak}</span>
                    <span className="ins-pill-lbl">Day streak</span>
                    <span className="muted small">{streak > 0 ? 'Keep it going' : 'Watch 10+ min today'}</span>
                  </div>
                  <div className="ins-pill">
                    <span className="ins-pill-val">{finishRate}%</span>
                    <span className="ins-pill-lbl">Finish rate</span>
                    <span className="muted small">{finished.length} of {started} started</span>
                  </div>
                </div>
              </div>

              <div className="ins-grid">
                <section className="ins-card ins-card-wide">
                  <div className="ins-card-h">
                    <h2>Most watched</h2>
                    <span className="muted small">By title</span>
                  </div>
                  {top.length ? (
                    <div className="ins-bars">
                      {top.map(([n, v], i) => (
                        <div key={n} className="ins-barrow">
                          <span className="ins-rank">{i + 1}</span>
                          <span className="ins-bar-name" title={n}>{n}</span>
                          <i className="ins-bar-track"><b style={{ width: `${Math.min(100, (v / max) * 100)}%` }} /></i>
                          <em className="ins-bar-time">{hrs(v)}</em>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="ins-empty muted">Watch something and titles will rank here by time spent.</p>
                  )}
                </section>

                <div className="ins-side">
                <section className="ins-card">
                  <div className="ins-card-h">
                    <h2>Today</h2>
                    <span className="muted small">Daily goal</span>
                  </div>
                  <div className="ins-goal">
                    <div className="ins-goal-ring">
                      <svg viewBox="0 0 72 72" width="72" height="72">
                        <circle cx="36" cy="36" r="30" className="ins-ring-bg" />
                        <circle cx="36" cy="36" r="30" className="ins-ring-fg" strokeDasharray={ringC} strokeDashoffset={ringC * (1 - goalPct / 100)} transform="rotate(-90 36 36)" />
                      </svg>
                      <span className="ins-goal-pct">{goalPct}%</span>
                    </div>
                    <div className="ins-goal-meta">
                      <b>{todayMin} <span className="muted">/ {goal} min</span></b>
                      <span className="muted small">{todayMin >= goal ? 'Goal reached' : `${Math.max(0, goal - todayMin)} min to go`}</span>
                    </div>
                  </div>
                </section>

                <section className="ins-card">
                  <div className="ins-card-h">
                    <h2>On this laptop</h2>
                    <span className="muted small">Offline</span>
                  </div>
                  <div className="ins-metric">
                    <b>{bytes(savedBytes)}</b>
                    <span className="muted">{savedFiles.length} video{savedFiles.length === 1 ? '' : 's'} saved</span>
                  </div>
                  <p className="ins-note muted small">Plays with no internet. Manage copies from Downloads.</p>
                </section>
                </div>
              </div>
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
          <Library
            roots={roots}
            host={host}
            hasServer={hasServer}
            rootsErr={rootsErr}
            root={root}
            dir={dir}
            setRoot={(r) => { setRoot(r); setLastLoc({ root: r, dir: '' }); }}
            setDir={(d) => { setDir(d); setLastLoc({ root: root ?? -1, dir: d }); }}
            items={items}
            status={status}
            err={err}
            prog={prog}
            load={load}
            pkey={(name, d = activeLoc.dir, r = activeLoc.root) => pkey(name, d, r)}
            metaOf={(name) => metaOf(name)}
            allTags={allTags}
            onMetaFor={setMetaFor}
            onOpenPlayer={(name, r, d) => { setLastLoc({ root: r, dir: d }); startPlay(name, r, d); }}
            onPlaySelection={(list, r, d) => { setLastLoc({ root: r, dir: d }); setPlaylist(list); beginPlay(list[0], r, d); }}
            onSaveOffline={(names, sizes, r, d) => setTarget({ root: r, paths: names.map((n) => join(d, n)), names, sizes })}
            onOpenDetails={(name) => setDetail(name)}
            onConfirmDelete={confirmDelete}
            onOpenRule={() => setRuleFor(true)}
            onAskName={setNameAsk}
            onFlash={flash}
            onAddTo={setAddTo}
            onSetWatched={setWatched}
            onToggleFav={toggleFav}
          />
        )}

        {view === 'discover' && <Discover />}
      </main>

      {play && pRoot !== -1 && (
        <Player
          key={`${pRoot}:${join(pDir, play)}`} root={pRoot} dir={pDir} name={play} videos={playlist ?? playVideos ?? videos} playlist={!!playlist} floating={floating} onFloat={setFloating}
          pkey={pkey(play, pDir, pRoot)} saved={prog[pkey(play, pDir, pRoot)]} offline={!!pCur?.offline} opened={!!pCur?.opened} saver={eco ? Math.max(saver, 1) : s.saver} caps={caps}
          onClose={() => { if (isPop) { window.close(); return; } setPlay(null); setPlayLoc(null); setPlayVideos(null); setPlaylist(null); setFloating(false); setTimeout(loadProg, 500); }}
          onNext={setPlay} onStarted={onStarted} onTick={addWatch}
          onDownload={(n) => setTarget({ root: pRoot, paths: [join(pDir, n)], names: [n], sizes: 0 })}
          onDelete={(n) => confirmDelete([n], `“${n}”`)}
        />
      )}
      {panel === 'settings' && <SettingsDialog mode={net.mode} prog={prog} onClose={() => setPanel(null)} onStorage={() => setPanel('storage')} onServers={() => setPanel('servers')} onTidy={() => setPanel('tidy')} onSaved={loadSrv} />}
      {panel === 'servers' && <Setup firstRun={false} onClose={() => setPanel(null)} onChanged={serversChanged} onOffline={() => setPanel(null)} />}
      {panel === 'downloads' && <DownloadsPanel onClose={() => setPanel(null)} onPlay={playOffline} onStorage={() => setPanel('storage')} />}
      {panel === 'storage' && <StoragePanel onClose={() => setPanel(null)} onPlay={playOffline} onChanged={() => { loadRoots(); loadProg(); }} />}
      {target && (
        <DownloadDialog {...target} caps={caps} onClose={() => setTarget(null)}
          onScheduled={(t) => { setTarget(null); flash(t); setPanel('downloads'); }}
          onQueued={(n) => { setTarget(null); flash(n ? `Added ${n} to Downloads` : 'Already saved or queued'); if (n) setPanel('downloads'); }} />
      )}
      {detail && <Details name={detail} folder={activeLoc.dir} size={items.find((i) => i.name === detail)?.size} prog={prog[pkey(detail)]} meta={metaOf(detail)} allTags={allTags} onMeta={(p) => setMetaFor(detail, p)} remote={!cur?.offline} onClose={() => setDetail(null)} onPlay={() => { startPlay(detail); setDetail(null); }} onSave={() => { const n = detail; setDetail(null); saveOffline([n], items.find((i) => i.name === n)?.size ?? 0); }} />}
      {addTo && <AddToCollection cols={cols} count={addTo.length} onClose={() => setAddTo(null)} onPick={(id, name) => {
        const rn = cur?.name ?? '';
        const ents = addTo.map((n) => ({ root: rn, path: join(activeLoc.dir, n) }));
        if (id === 'new') setCols([...cols, { id: `${Date.now()}`, name: name ?? 'Collection', items: ents }]);
        else setCols(cols.map((c) => (c.id === id ? { ...c, items: [...c.items, ...ents.filter((e) => !c.items.some((x) => x.root === e.root && x.path === e.path))] } : c)));
        setAddTo(null); flash('Added to the collection');
      }} />}
      {ruleFor && cur && <RuleDialog root={activeLoc.root} dir={activeLoc.dir} label={activeLoc.dir.split('/').pop() ?? cur.name} onClose={() => setRuleFor(false)} onDone={(m) => { setRuleFor(false); flash(m); }} />}
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