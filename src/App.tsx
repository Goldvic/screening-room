import { CSSProperties, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Player from './Player';
import Setup from './Setup';
import SettingsDialog from './Settings';
import { Hero, Playlists, Rail, SavedFile, Tile, Welcome, progPct, savedSub } from './Home';
import { DownloadDialog, DownloadsPanel, StoragePanel } from './Downloads';
import {
  ACCENTS, APP_NAME, Caps, SavedList, DEFAULTS, Entry, Icon, Net, OFFLINE_ID, OPENED_ID, Prefs, PrefsCtx, Prog, Root, SettingsCtx, VIDEO, VIDEO_EXTS,
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
      setPrefs({ favs: d.favs, audio: d.audio, bookmarks: d.bookmarks, playlists: d.playlists, intros: d.intros });
    }).catch(() => {}).finally(() => setReady(true));
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  useEffect(() => { document.documentElement.style.setProperty('--lamp', ACCENTS[settings.accent] ?? ACCENTS.Amber); }, [settings.accent]);
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
const getMeta = (name: string): Promise<Meta | null> => {
  const t = parseTitle(name), key = `${t.title}|${t.year}`;
  let p = metaCache.get(key);
  if (!p) { p = gate(() => api<Meta>('meta', { q: t.title, year: t.year })).catch(() => null); metaCache.set(key, p); }
  return p;
};
const posterUrl = (name: string) => { const t = parseTitle(name); return `/api/poster?${qs({ q: t.title, year: t.year })}`; };

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
      getMeta(name).then((m) => setState(m?.poster ? 'ok' : 'none'));
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [s.posters, state, name]);
  return (
    <span className="art" ref={ref}>
      <Thumb root={root} path={path} v={v} icon="film" />
      {s.posters && state === 'ok' && <img className="poster-img on" alt="" loading="lazy" src={posterUrl(name)} onError={() => setState('none')} />}
    </span>
  );
}

function Details({ name, remote, onClose, onPlay, onSave }: { name: string; remote: boolean; onClose: () => void; onPlay: () => void; onSave: () => void }) {
  const [m, setM] = useState<Meta | null | undefined>(undefined);
  const [err, setErr] = useState('');
  const t = parseTitle(name);
  useEffect(() => {
    api<Meta>('meta', { q: t.title, year: t.year }).then(setM).catch((e) => { setErr(e.message); setM(null); });
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog wide details" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About this video">
        <div className="dlg-head"><h3>{m?.title ?? t.title}{(m?.year ?? t.year) ? ` (${m?.year ?? t.year})` : ''}</h3><button className="icon" onClick={onClose} aria-label="Close"><Icon n="close" /></button></div>
        <div className="det-body">
          {m?.poster && <img className="det-poster" alt="" src={posterUrl(name)} />}
          <div>
            {m === undefined && <p className="muted">Looking it up…</p>}
            {m?.found && (
              <>
                <p className="small muted">{[m.rating ? `★ ${m.rating}` : '', ...(m.genres ?? [])].filter(Boolean).join(' · ')}</p>
                <p>{m.overview || 'No description available.'}</p>
              </>
            )}
            {m && !m.found && <p className="muted">Nothing found for “{t.title}”.</p>}
            {err && <p className="muted">{err}</p>}
            <p className="small muted trunc" title={name}>{name}</p>
          </div>
        </div>
        <div className="dlg-actions">
          {remote && <button className="btn ghost" onClick={onSave}><Icon n="save" s={15} /> Save for offline</button>}
          <button className="btn" onClick={onPlay}><Icon n="play" s={15} /> Play</button>
        </div>
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
  const [panel, setPanel] = useState<null | 'settings' | 'servers' | 'downloads' | 'storage'>(null);
  const [dls, setDls] = useState<DL[]>([]);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [budget, setBudget] = useState(0);
  const [queueInfo, setQueueInfo] = useState({ active: 0, waiting: 0, speed: 0 });
  const [skipSetup, setSkipSetup] = useState(() => { try { return localStorage.getItem('cinema.skipSetup') === '1'; } catch { return false; } });
  const search = useRef<HTMLInputElement>(null);
  const pre = useRef(new Set<string>());
  const net = useNet(null, 2000);
  const upd = useUpdates();
  const [dragging, setDragging] = useState(false);
  const [floating, setFloating] = useState(false);
  const [view, setView] = useState<'home' | 'library' | 'playlists'>('home');
  const [savedFiles, setSavedFiles] = useState<SavedFile[]>([]);
  const [nameAsk, setNameAsk] = useState<{ title: string; value: string; label: string; go: (v: string) => void } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [playlist, setPlaylist] = useState<string[] | null>(null);

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
    const t = setInterval(() => api<{ active: number; waiting: number; speed: number }>('dl').then(setQueueInfo).catch(() => {}), 2500);
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
      return s.filter === 'unwatched' ? !p?.watched : s.filter === 'watched' ? !!p?.watched : favs.includes(pkey(i.name));
    });
    const c = (a: Entry, b: Entry) => sort === 'new' ? b.mtime - a.mtime : sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name, undefined, { numeric: true });
    return [...f.filter((i) => i.dir).sort(c), ...f.filter((i) => !i.dir).sort(c)];
  }, [items, query, sort, s.filter, prog, favs]); // eslint-disable-line react-hooks/exhaustive-deps
  const folders = shown.filter((i) => i.dir);
  const files = shown.filter((i) => !i.dir);
  const posters = s.view === 'grid' ? files.filter((i) => VIDEO.test(i.name)) : [];
  const rows = s.view === 'grid' ? files.filter((i) => !VIDEO.test(i.name)) : files;

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

  const fileActions = (it: Entry, isVid: boolean, p?: Prog) => (
    <>
      {isVid && <button className={favs.includes(pkey(it.name)) ? 'icon on' : 'icon'} title="Favorite" aria-label={`Favorite ${it.name}`} aria-pressed={favs.includes(pkey(it.name))} onClick={() => toggleFav(it.name)}><Icon n="heart" /></button>}
      {isVid && <button className="icon" title="About this video" aria-label={`About ${it.name}`} onClick={() => setDetail(it.name)}><Icon n="info" /></button>}
      {isVid && <button className="icon" title={p?.watched ? 'Mark as unwatched' : 'Mark as watched'} aria-label={p?.watched ? 'Mark as unwatched' : 'Mark as watched'} onClick={() => setWatched(it.name, !p?.watched)}><Icon n="check" /></button>}
      {!offline && <button className="icon" title="Save for offline" aria-label={`Save ${it.name} for offline`} onClick={() => saveOffline([it.name], it.size)}><Icon n="save" /></button>}
      {!offline && !bridge && <button className="icon" title="Download" aria-label={`Download ${it.name}`} onClick={() => download(it)}><Icon n="down" /></button>}
      {offline && bridge && <button className="icon" title="Show in folder" aria-label={`Show ${it.name} in folder`} onClick={() => api<{ path: string }>('localpath', { root: rid, path: join(dir, it.name) }).then((r) => bridge?.reveal(r.path))}><Icon n="folder" /></button>}
      <button className="icon danger" title={offline ? 'Delete from this laptop' : 'Delete from server'} aria-label={`Delete ${it.name}`} onClick={() => confirmDelete([it.name], `“${it.name}”`)}><Icon n="trash" /></button>
    </>
  );

  if (!hasServer && !skipSetup && !play && roots.length > 0 && !roots.some((r) => !r.offline || r.opened) && panel !== 'servers') {
    return <Setup firstRun onClose={() => {}} onChanged={serversChanged} onOffline={() => { try { localStorage.setItem('cinema.skipSetup', '1'); } catch { /* ignore */ } setSkipSetup(true); }} />;
  }

  return (
    <div className="shell"
      onDragOver={(e) => { if (bridge && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}>
      {dragging && <div className="dropzone" aria-hidden="true"><Icon n="play" s={42} /><strong>Drop to play</strong><span>The videos are played where they are. Nothing is copied.</span></div>}
      <aside className="side" aria-label="Main navigation">
        <div className="brand" title={APP_NAME}><span className="lamp" /><span className="brand-t">{APP_NAME}</span></div>
        <nav className="navs">
          <button className={view === 'home' ? 'nav on' : 'nav'} onClick={() => setView('home')} title="Home"><Icon n="home" s={20} /><span>Home</span></button>
          <button className={view === 'library' ? 'nav on' : 'nav'} onClick={() => setView('library')} title="Library"><Icon n="film" s={20} /><span>Library</span></button>
          <button className={view === 'playlists' ? 'nav on' : 'nav'} onClick={() => setView('playlists')} title="Playlists"><Icon n="list" s={20} /><span>Playlists</span></button>
          <button className="nav" onClick={() => setPanel('downloads')} title="Downloads">
            <Icon n="down" s={20} /><span>Downloads</span>
            {queueInfo.active + queueInfo.waiting > 0 && <em className="nav-badge">{queueInfo.active + queueInfo.waiting}</em>}
          </button>
        </nav>
        <span className="grow" />
        {upd && (upd.state === 'available' || upd.state === 'downloading' || upd.state === 'ready') && (
          <button className="nav hot" title="Update available" onClick={() => (upd.state === 'available' ? bridge?.updateDownload() : upd.state === 'ready' ? bridge?.updateInstall() : undefined)}>
            <Icon n="cloud" s={20} /><span>{upd.state === 'ready' ? 'Restart to update' : upd.state === 'downloading' ? `Updating ${upd.percent}%` : 'Update'}</span>
          </button>
        )}
        <button className="netmini" onClick={() => setPanel('settings')} title={`Network: ${net.ok ? rate(net.speed) : 'offline'} · today ${bytes(net.today)}`}>
          <i className={net.active ? 'dot on' : 'dot'} /><span>{net.ok ? rate(net.speed) : 'offline'}</span><small>{bytes(net.today)} today</small>
        </button>
        {bridge && <button className="nav" onClick={pickFile} title="Open a video from your computer (Ctrl+O)"><Icon n="folder" s={20} /><span>Open file</span></button>}
        <button className="nav" onClick={() => setPanel('servers')} title="Servers"><Icon n="server" s={20} /><span>Servers</span></button>
        <button className="nav" onClick={() => setPanel('settings')} title="Settings"><Icon n="sliders" s={20} /><span>Settings</span></button>
      </aside>

      <main className="main">
        {saver > s.saver && <p className="note">Data Saver switched to Low because you used most of this month’s data budget.</p>}
        {rootsErr && (
          <div className="note err">
            <strong>{hasServer ? `Cannot reach your server.` : 'No server yet.'}</strong> {rootsErr}
            <p className="muted">{hasServer ? 'Your downloaded videos still work below.' : 'Add a server to stream, or watch what is already downloaded.'}</p>
            <span className="inline"><button className="btn" onClick={() => loadRoots()}>Try again</button><button className="btn ghost" onClick={() => setPanel('servers')}>Servers</button></span>
          </div>
        )}

        {view === 'home' && (() => {
          const hero = resumable[0];
          const first = savedFiles[0];
          const t = hero ? parseTitle(hero.name) : first ? parseTitle(first.name) : null;
          const recent = [...items].sort((a, b) => b.mtime - a.mtime).slice(0, 14);
          const cardArt = (x: { rid: number; dir: string; name: string }) => <Art root={x.rid} path={join(x.dir, x.name)} v={0} name={x.name} />;
          return (
            <div className="home">
              {hero && t ? (
                <Hero eyebrow="Continue watching" title={t.title + (t.season ? `  ·  S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}` : '')}
                  line={hero.p ? `${clock(hero.p.pos)} watched of ${clock(hero.p.dur)}` : ''} label="Resume" art={cardArt(hero)}
                  onPlay={() => startPlay(hero.name, hero.rid, hero.dir)} onMore={() => { setRoot(hero.rid); setDir(hero.dir); setDetail(hero.name); }} />
              ) : first && t ? (
                <Hero eyebrow="Saved on this laptop" title={t.title} line={savedSub(first)} label="Play"
                  art={<Art root={OFFLINE_ID} path={first.rel} v={first.mtime} name={first.name} />} onPlay={() => playOffline(first.rel)} />
              ) : <Welcome onLibrary={() => setView('library')} onOpen={bridge ? pickFile : undefined} />}
              {resumable.length > 1 && (
                <Rail title="Continue watching">
                  {resumable.slice(1).map((x) => <Tile key={x.k} name={x.name} sub={x.p ? `${clock(x.p.pos)} of ${clock(x.p.dur)}` : ''} progress={progPct(x.p)} art={cardArt(x)} onClick={() => startPlay(x.name, x.rid, x.dir)} />)}
                </Rail>
              )}
              {savedFiles.length > 0 && (
                <Rail title="Saved on this laptop" hint="Plays with no internet">
                  {savedFiles.slice(0, 16).map((f) => (
                    <Tile key={f.rel} name={f.name} sub={savedSub(f)} badge="Offline" progress={progPct(prog[`Offline:${f.rel}`])}
                      art={<Art root={OFFLINE_ID} path={f.rel} v={f.mtime} name={f.name} />} onClick={() => playOffline(f.rel)} />
                  ))}
                </Rail>
              )}
              {favCards.length > 0 && (
                <Rail title="Favorites">
                  {favCards.map((x) => <Tile key={x.k} name={x.name} progress={progPct(x.p)} art={cardArt(x)} onClick={() => startPlay(x.name, x.rid, x.dir)} />)}
                </Rail>
              )}
              {recent.length > 0 && !offline && !opened && (
                <Rail title="Recently added" hint={cur?.name}>
                  {recent.map((it) => it.dir
                    ? <Tile key={it.name} name={it.name} sub="Folder" art={<span className="art"><span className="ph"><Icon n="folder" s={30} /></span></span>} onClick={() => { setView('library'); setDir(it.name); }} />
                    : <Tile key={it.name} name={it.name} sub={bytes(it.size)} art={<Art root={rid} path={join(dir, it.name)} v={it.mtime} name={it.name} />} onClick={() => startPlay(it.name)} />)}
                </Rail>
              )}
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
        <div className="pills">
          {roots.map((r) => (
            <button key={r.id} className={r.id === root ? 'pill on' : 'pill'} onClick={() => { setRoot(r.id); setDir(''); }} title={r.total ? `${bytes(r.free)} free of ${bytes(r.total)}` : r.dir}>
              {r.opened ? <><Icon n="film" s={14} /> Opened files</> : r.offline ? <><Icon n="hdd" s={14} /> On this laptop</> : r.name}
            </button>
          ))}
          <span className="grow" />
          <span className="muted small">{hasServer ? (rootsErr ? `Cannot reach ${host}` : host ? `Connected to ${host}` : 'Connecting…') : 'No server set up'}</span>
        </div>
        {dir && videos.length > 0 && (
          <section className="series-head">
            <span className="series-art"><Art root={rid} path={join(dir, videos[0])} v={0} name={crumbs[crumbs.length - 1]} /></span>
            <div>
              <h1>{crumbs[crumbs.length - 1]}</h1>
              <p className="muted">{videos.length} video{videos.length > 1 ? 's' : ''} · {seen.length} watched{videos.length - seen.length > 0 ? ` · ${videos.length - seen.length} to go` : ''}</p>
              <i className="bar"><b style={{ width: `${(seen.length / videos.length) * 100}%` }} /></i>
            </div>
          </section>
        )}
        <header className="top">
          <div className="crumbs">
            {dir && <button className="icon" onClick={() => setDir(crumbs.slice(0, -1).join('/'))} title="Back" aria-label="Back"><Icon n="back" /></button>}
            <button onClick={() => setDir('')}>{opened ? 'Opened files' : offline ? 'On this laptop' : cur?.name ?? '…'}</button>
            {crumbs.map((c, i) => <span key={i}>/ <button onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
          </div>
          <div className="actions">
            {nextUp && <button className="btn" onClick={() => startPlay(nextUp.name)}><Icon n="play" s={15} /> {nextUp.label}</button>}
            {videos.length > 1 && <button className="btn ghost" onClick={randomPick} title="Pick something for me"><Icon n="random" s={16} /> Surprise me</button>}
            {!offline && dir && <button className="btn ghost" onClick={() => setTarget({ root: rid, paths: [dir], names: [crumbs[crumbs.length - 1]], sizes: 0 })}><Icon n="save" s={16} /> Save folder for offline</button>}
            {seen.length > 0 && (
              <button className="btn ghost" onClick={() => confirmDelete(seen, `${seen.length} watched video${seen.length > 1 ? 's' : ''}`)}>
                <Icon n="trash" s={16} /> Delete {seen.length} watched
              </button>
            )}
            {!offline && !bridge && dir && <a className="btn ghost" href={`/api/download?${qs({ root: rid, path: dir })}`}><Icon n="down" s={16} /> Download folder</a>}
          </div>
        </header>

        {items.length > 0 && (
          <div className="tools">
            <label className="search"><Icon n="search" s={16} /><input ref={search} placeholder="Search this folder  (press /)" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <select value={s.filter} onChange={(e) => set({ filter: e.target.value as Settings['filter'] })} aria-label="Show">
              <option value="all">All</option><option value="unwatched">Not watched</option><option value="watched">Watched</option><option value="fav">Favorites</option>
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort">
              <option value="name">Name</option><option value="new">Newest</option><option value="size">Largest</option>
            </select>
            <button className="btn ghost" onClick={() => { refreshAll().then(() => flash('Refreshed')); }} title="Refresh (F5)"><Icon n="rotate" s={16} /> Refresh</button>
            {videos.length > 1 && <button className={selecting ? 'btn' : 'btn ghost'} onClick={() => (selecting ? endSelect() : setSelecting(true))} title="Pick several videos to play as a playlist"><Icon n="list" s={16} /> {selecting ? 'Done' : 'Select'}</button>}
            <span className="seg" role="group" aria-label="View">
              <button className={s.view === 'grid' ? 'on' : ''} onClick={() => set({ view: 'grid' })} title="Poster view" aria-label="Poster view"><Icon n="grid" s={16} /></button>
              <button className={s.view === 'list' ? 'on' : ''} onClick={() => set({ view: 'list' })} title="List view" aria-label="List view"><Icon n="list" s={16} /></button>
            </span>
          </div>
        )}

        {selecting && (
          <div className="selbar" role="status">
            <strong>{sel.length ? `${sel.length} selected` : 'Tap videos to add them to a playlist'}</strong>
            <span className="inline">
              <button className="btn ghost" onClick={() => setSel(videos)}>Select all</button>
              <button className="btn" disabled={!sel.length} onClick={playSelected}><Icon n="play" s={15} /> Play as playlist</button>
              <button className="btn ghost danger" disabled={!sel.length} onClick={() => { const l = videos.filter((n) => sel.includes(n)); endSelect(); confirmDelete(l, `${l.length} video${l.length > 1 ? 's' : ''}`); }}><Icon n="trash" s={15} /> Delete</button>
              <button className="btn ghost" disabled={!sel.length} onClick={savePlaylist}><Icon n="list" s={15} /> Save playlist</button>
              {!offline && <button className="btn ghost" disabled={!sel.length} onClick={saveSelected}><Icon n="save" s={15} /> Save offline</button>}
              <button className="btn ghost" onClick={endSelect}>Cancel</button>
            </span>
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
                  <Icon n="folder" s={22} />
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
          <ul className={s.posters ? 'posters portrait' : 'posters'}>
            {posters.map((it) => {
              const p = prog[pkey(it.name)];
              const part = p && !p.watched && p.pos > 30;
              return (
                <li key={it.name} className={(p?.watched ? 'poster done' : 'poster') + (sel.includes(it.name) ? ' picked' : '')} style={{ '--h': hue(it.name) } as CSSProperties}>
                  {selecting && <span className={sel.includes(it.name) ? 'selmark on' : 'selmark'} aria-hidden="true"><Icon n="check" s={14} /></span>}
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
                <li key={it.name} className={(p?.watched ? 'row done' : 'row') + (sel.includes(it.name) ? ' picked' : '')}>
                  {selecting && isVid && <span className={sel.includes(it.name) ? 'selmark on inrow' : 'selmark inrow'} aria-hidden="true"><Icon n="check" s={14} /></span>}
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
          pkey={pkey(play)} saved={prog[pkey(play)]} offline={offline} opened={opened} saver={saver} caps={caps}
          onClose={() => { setPlay(null); setPlaylist(null); setFloating(false); setTimeout(loadProg, 500); }}
          onNext={setPlay} onStarted={onStarted}
          onDownload={(n) => saveOffline([n], items.find((i) => i.name === n)?.size ?? 0)}
          onDelete={(n) => { setPlay(null); confirmDelete([n], `“${n}”`); }}
        />
      )}
      {panel === 'settings' && <SettingsDialog mode={net.mode} prog={prog} onClose={() => setPanel(null)} onStorage={() => setPanel('storage')} onServers={() => setPanel('servers')} onSaved={loadSrv} />}
      {panel === 'servers' && <Setup firstRun={false} onClose={() => setPanel(null)} onChanged={serversChanged} onOffline={() => setPanel(null)} />}
      {panel === 'downloads' && <DownloadsPanel onClose={() => setPanel(null)} onPlay={playOffline} onStorage={() => setPanel('storage')} />}
      {panel === 'storage' && <StoragePanel onClose={() => setPanel(null)} onPlay={playOffline} onChanged={() => { loadRoots(); loadProg(); if (offline) load(); }} />}
      {target && (
        <DownloadDialog {...target} caps={caps} onClose={() => setTarget(null)}
          onScheduled={(t) => { setTarget(null); flash(t); setPanel('downloads'); }}
          onQueued={(n) => { setTarget(null); flash(n ? `Added ${n} to Downloads` : 'Already saved or queued'); if (n) setPanel('downloads'); }} />
      )}
      {detail && <Details name={detail} remote={!offline} onClose={() => setDetail(null)} onPlay={() => { startPlay(detail); setDetail(null); }} onSave={() => { const n = detail; setDetail(null); saveOffline([n], items.find((i) => i.name === n)?.size ?? 0); }} />}
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