import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Entry = { name: string; dir: boolean; size: number; mtime: number };
type Root = { id: number; name: string; dir: string; free: number; total: number };
type Prog = { pos: number; dur: number; watched: boolean; updated: number };
type Track = { i: number; label: string };
type Info = { duration: number; width?: number; height?: number; codec?: string; audio?: Track[]; subs?: Track[] };
type Ask = { title: string; body: string; label: string; go: () => Promise<void> };

const VIDEO = /\.(mp4|mkv|webm|mov|avi|m4v)$/i;
const QUALITIES: [string, string][] = [
  ['orig', 'Original (direct, full quality)'], ['2160', '4K (2160p)'], ['1440', '1440p'],
  ['1080', '1080p'], ['720', '720p'], ['480', '480p'],
];
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

const qs = (o: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
async function api<T>(p: string, o: Record<string, string | number> = {}, method = 'GET'): Promise<T> {
  const r = await fetch(`/api/${p}?${qs(o)}`, { method });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j as T;
}
const bytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
const clock = (s: number) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(x).padStart(2, '0')}`;
};
const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const pct = (p?: Prog) => (p && p.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0);

const ICONS: Record<string, string> = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M16 9h4M4 15h4M16 15h4',
  down: 'M12 4v11m0 0l-4-4m4 4l4-4M5 19h14', trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  check: 'M5 12l5 5 9-10', close: 'M6 6l12 12M18 6L6 18', file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  play: 'M7 4l13 8-13 8z', back: 'M11 6l-6 6 6 6M5 12h14', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
};
const Icon = ({ n, s = 18 }: { n: string; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={ICONS[n]} />
  </svg>
);

export default function App() {
  const [host, setHost] = useState('');
  const [roots, setRoots] = useState<Root[]>([]);
  const [root, setRoot] = useState(0);
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

  const pkey = (name: string, d = dir, r = root) => `${roots[r]?.name}:${join(d, name)}`;
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3200); };
  const loadProg = useCallback(() => api<Record<string, Prog>>('progress').then(setProg).catch(() => {}), []);
  const loadRoots = useCallback(() => api<{ host: string; roots: Root[] }>('roots').then((r) => { setHost(r.host); setRoots(r.roots); }).catch(() => {}), []);
  const load = useCallback(async () => {
    setStatus('loading');
    try { setItems(await api<Entry[]>('list', { root, path: dir })); setStatus('ready'); }
    catch (e: any) { setErr(e.message); setStatus('error'); }
  }, [root, dir]);

  useEffect(() => { loadRoots(); loadProg(); }, [loadRoots, loadProg]);
  useEffect(() => { setQuery(''); load(); }, [load]);

  const remove = async (names: string[]) => {
    for (const n of names) await api('item', { root, path: join(dir, n) }, 'DELETE');
    flash(names.length === 1 ? 'Deleted from the server' : `${names.length} items deleted from the server`);
    await Promise.all([load(), loadRoots(), loadProg()]);
  };
  const confirmDelete = (names: string[], what: string) =>
    setAsk({ title: `Delete ${what}?`, body: 'This removes it from your VPS permanently. It cannot be undone.', label: 'Delete from server', go: () => remove(names) });
  const setWatched = async (name: string, watched: boolean) => {
    const p = prog[pkey(name)];
    await fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: pkey(name), pos: watched ? p?.pos ?? 0 : 0, dur: p?.dur ?? 0, watched }) });
    loadProg();
  };

  const videos = useMemo(() => items.filter((i) => !i.dir && VIDEO.test(i.name)).map((i) => i.name), [items]);
  const seen = videos.filter((n) => prog[pkey(n)]?.watched);
  const shown = useMemo(() => {
    const f = items.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()));
    const c = (a: Entry, b: Entry) => sort === 'new' ? b.mtime - a.mtime : sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name, undefined, { numeric: true });
    return [...f.filter((i) => i.dir).sort(c), ...f.filter((i) => !i.dir).sort(c)];
  }, [items, query, sort]);
  const folders = shown.filter((i) => i.dir), files = shown.filter((i) => !i.dir);

  const resumable = useMemo(() =>
    Object.entries(prog)
      .filter(([, p]) => !p.watched && p.pos > 30 && p.dur > 0 && p.pos / p.dur < 0.9)
      .sort((a, b) => b[1].updated - a[1].updated).slice(0, 10)
      .map(([k, p]) => {
        const i = k.indexOf(':'), parts = k.slice(i + 1).split('/');
        return { k, p, rid: roots.findIndex((r) => r.name === k.slice(0, i)), dir: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
      }).filter((x) => x.rid >= 0), [prog, roots]);

  const nextUp = (() => {
    if (!videos.length) return null;
    const part = videos.filter((n) => { const p = prog[pkey(n)]; return p && !p.watched && p.pos > 30; })
      .sort((a, b) => prog[pkey(b)].updated - prog[pkey(a)].updated)[0];
    if (part) return { name: part, label: 'Resume' };
    const fresh = videos.find((n) => !prog[pkey(n)]?.watched);
    return { name: fresh ?? videos[0], label: fresh && seen.length ? 'Play next' : 'Play' };
  })();

  const crumbs = dir ? dir.split('/') : [];
  const cur = roots[root];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="lamp" />Screening Room</div>
        <p className="muted small host">{host ? `Connected to ${host}` : 'Connecting to your VPS…'}</p>
        <nav className="shelves">
          {roots.map((r) => (
            <button key={r.id} className={r.id === root ? 'shelf on' : 'shelf'} onClick={() => { setRoot(r.id); setDir(''); }}>
              <strong>{r.name}</strong>
              <span className="muted small">{r.total ? `${bytes(r.free)} free of ${bytes(r.total)}` : r.dir}</span>
              {r.total > 0 && <i className="bar"><b style={{ width: `${100 - (r.free / r.total) * 100}%` }} /></i>}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        {!dir && resumable.length > 0 && (
          <section className="resume">
            <h2>Continue watching</h2>
            <div className="cards">
              {resumable.map((x) => (
                <button key={x.k} className="card" style={{ '--h': hue(x.dir || x.name) } as React.CSSProperties}
                  onClick={() => { setRoot(x.rid); setDir(x.dir); setPlay(x.name); }}>
                  <span className="go"><Icon n="play" s={20} /></span>
                  <strong>{x.name.replace(/\.[^.]+$/, '')}</strong>
                  <span className="small muted">{x.dir || roots[x.rid]?.name}</span>
                  <span className="small">{clock(x.p.pos)} of {clock(x.p.dur)}</span>
                  <i className="prog"><b style={{ width: `${pct(x.p)}%` }} /></i>
                </button>
              ))}
            </div>
          </section>
        )}

        <header className="top">
          <div className="crumbs">
            {dir && <button className="icon" onClick={() => setDir(crumbs.slice(0, -1).join('/'))} title="Back"><Icon n="back" /></button>}
            <button onClick={() => setDir('')}>{cur?.name ?? '…'}</button>
            {crumbs.map((c, i) => <span key={i}>/ <button onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
          </div>
          <div className="actions">
            {nextUp && <button className="btn" onClick={() => setPlay(nextUp.name)}><Icon n="play" s={15} /> {nextUp.label}</button>}
            {seen.length > 0 && (
              <button className="btn ghost" onClick={() => confirmDelete(seen, `${seen.length} watched video${seen.length > 1 ? 's' : ''}`)}>
                <Icon n="trash" s={16} /> Delete {seen.length} watched
              </button>
            )}
            {dir && <a className="btn ghost" href={`/api/download?${qs({ root, path: dir })}`}><Icon n="down" s={16} /> Download folder</a>}
          </div>
        </header>

        {items.length > 4 && (
          <div className="tools">
            <label className="search"><Icon n="search" s={16} /><input placeholder="Search this folder" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort">
              <option value="name">Name</option><option value="new">Newest</option><option value="size">Largest</option>
            </select>
          </div>
        )}

        {status === 'loading' && <p className="note">Loading…</p>}
        {status === 'error' && (
          <div className="note err">
            <strong>Could not read this folder.</strong> {err}
            <p className="muted">Check that the bot container is running and your .env settings are right.</p>
            <button className="btn" onClick={load}>Try again</button>
          </div>
        )}
        {status === 'ready' && items.length === 0 && <p className="note">This folder is empty. Downloads from the bot will show up here.</p>}
        {status === 'ready' && items.length > 0 && shown.length === 0 && <p className="note">Nothing matches “{query}”.</p>}

        {folders.length > 0 && (
          <div className="tiles">
            {folders.map((f) => (
              <div key={f.name} className="tile" style={{ '--h': hue(f.name) } as React.CSSProperties}>
                <button className="tile-open" onClick={() => setDir(join(dir, f.name))}>
                  <Icon n="folder" s={22} />
                  <strong>{f.name}</strong>
                </button>
                <span className="tile-act">
                  <a className="icon" title="Download folder" href={`/api/download?${qs({ root, path: join(dir, f.name) })}`}><Icon n="down" s={16} /></a>
                  <button className="icon danger" title="Delete from server" onClick={() => confirmDelete([f.name], `“${f.name}”`)}><Icon n="trash" s={16} /></button>
                </span>
              </div>
            ))}
          </div>
        )}

        <ul className="rows">
          {files.map((it) => {
            const isVid = VIDEO.test(it.name);
            const p = prog[pkey(it.name)];
            const part = p && !p.watched && p.pos > 30;
            return (
              <li key={it.name} className={p?.watched ? 'row done' : 'row'}>
                <button className="open" onClick={() => isVid && setPlay(it.name)}>
                  <span className="ico"><Icon n={isVid ? 'film' : 'file'} /></span>
                  <span className="info">
                    <span className="name">{it.name}</span>
                    <span className="meta muted small">{bytes(it.size)} · {new Date(it.mtime * 1000).toLocaleDateString()}{part ? ` · stopped at ${clock(p.pos)}` : ''}</span>
                    {part && <i className="prog"><b style={{ width: `${pct(p)}%` }} /></i>}
                  </span>
                  {p?.watched && <span className="tag"><Icon n="check" s={13} /> Watched</span>}
                </button>
                {isVid && <button className="icon" title={p?.watched ? 'Mark as unwatched' : 'Mark as watched'} onClick={() => setWatched(it.name, !p?.watched)}><Icon n="check" /></button>}
                <a className="icon" title="Download" href={`/api/download?${qs({ root, path: join(dir, it.name) })}`}><Icon n="down" /></a>
                <button className="icon danger" title="Delete from server" onClick={() => confirmDelete([it.name], `“${it.name}”`)}><Icon n="trash" /></button>
              </li>
            );
          })}
        </ul>
      </main>

      {play && (
        <Player
          key={`${root}:${join(dir, play)}`} root={root} dir={dir} name={play} videos={videos}
          pkey={pkey(play)} saved={prog[pkey(play)]}
          onClose={() => { setPlay(null); setTimeout(loadProg, 500); }}
          onNext={setPlay}
          onDelete={(n) => { setPlay(null); confirmDelete([n], `“${n}”`); }}
        />
      )}
      {ask && <Confirm ask={ask} onClose={() => setAsk(null)} onError={flash} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
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

function Player(p: {
  root: number; dir: string; name: string; videos: string[]; pkey: string; saved?: Prog;
  onClose: () => void; onNext: (n: string) => void; onDelete: (n: string) => void;
}) {
  const path = join(p.dir, p.name);
  const box = useRef<HTMLDivElement>(null);
  const vref = useRef<HTMLVideoElement>(null);
  const last = useRef({ pos: 0, dur: 0 });
  const [start] = useState(() => (p.saved && !p.saved.watched && p.saved.pos > 10 ? Math.max(0, p.saved.pos - 3) : 0));
  const [q, setQ] = useState(localStorage.getItem('quality') || 'orig');
  const [speed, setSpeed] = useState(Number(localStorage.getItem('speed')) || 1);
  const [offset, setOffset] = useState(q !== 'orig' ? Math.floor(start) : 0);
  const resume = useRef(q === 'orig' ? start : 0);
  const [pos, setPos] = useState(start);
  const [a, setA] = useState(0);
  const [sub, setSub] = useState(-1);
  const [info, setInfo] = useState<Info>({ duration: 0 });
  const [failed, setFailed] = useState(false);
  const transcoding = q !== 'orig';
  const total = info.duration || (Number.isFinite(vref.current?.duration) ? vref.current!.duration : 0);
  const idx = p.videos.indexOf(p.name);
  const next = idx >= 0 ? p.videos[idx + 1] : undefined;

  const post = (watched?: boolean) => {
    if (!last.current.pos && watched === undefined) return;
    fetch('/api/progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: p.pkey, pos: last.current.pos, dur: last.current.dur, watched }) }).catch(() => {});
  };

  useEffect(() => { api<Info>('info', { root: p.root, path }).then(setInfo).catch(() => {}); }, [path, p.root]);
  useEffect(() => {
    const t = setInterval(() => post(), 10000);
    return () => { clearInterval(t); post(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const seekTo = (t: number) => {
    t = Math.max(0, Math.min(t, total || t));
    if (transcoding) { setOffset(Math.floor(t)); setPos(t); } else if (vref.current) vref.current.currentTime = t;
  };
  const reload = (o: { q?: string; a?: number; sub?: number }) => {
    const t = offset + (vref.current?.currentTime ?? 0), nq = o.q ?? q;
    resume.current = nq === 'orig' ? t : 0;
    setOffset(nq === 'orig' ? 0 : Math.floor(t));
    if (o.q !== undefined) { localStorage.setItem('quality', nq); setQ(nq); }
    if (o.a !== undefined) setA(o.a);
    if (o.sub !== undefined) setSub(o.sub);
    setFailed(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'SELECT') return;
      const v = vref.current; if (!v) return;
      const now = offset + v.currentTime;
      if (e.key === 'Escape') p.onClose();
      else if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else if (e.key === 'ArrowRight') seekTo(now + 10);
      else if (e.key === 'ArrowLeft') seekTo(now - 10);
      else if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : box.current?.requestFullscreen();
      else if (e.key === 'm') v.muted = !v.muted;
      else if (e.key === 'n' && next) p.onNext(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const src = `/api/stream?${qs({ root: p.root, path, q, t: offset, a })}`;
  const subSrc = `/api/subs?${qs({ root: p.root, path, s: sub, t: offset })}`;

  return (
    <div className="theatre" ref={box}>
      <div className="bar-top">
        <div>
          <strong className="title">{p.name}</strong>
          <span className="muted small">{info.width ? `${info.width}×${info.height} source${info.codec ? ', ' + info.codec : ''}` : 'Streaming from your VPS'}</span>
        </div>
        <button className="icon" onClick={p.onClose} title="Close (Esc)"><Icon n="close" /></button>
      </div>

      <video
        key={`${src}|${sub}`} ref={vref} src={src} controls autoPlay playsInline crossOrigin="use-credentials"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          v.playbackRate = speed;
          if (resume.current) { v.currentTime = resume.current; resume.current = 0; }
          if (v.textTracks[0]) v.textTracks[0].mode = 'showing';
        }}
        onTimeUpdate={(e) => {
          const t = offset + e.currentTarget.currentTime;
          setPos(t);
          last.current = { pos: t, dur: total };
        }}
        onEnded={() => { post(true); if (next) p.onNext(next); }}
        onError={() => setFailed(true)}
      >
        {sub >= 0 && <track kind="subtitles" src={subSrc} label="Subtitles" default />}
      </video>

      {failed && (
        <div className="fail">
          <p>{transcoding ? 'The server could not convert this file. Is ffmpeg installed on the VPS?' : 'Your browser cannot play this format directly (common with MKV/HEVC).'}</p>
          {!transcoding && <button className="btn" onClick={() => reload({ q: '1080' })}>Play a compatible 1080p version</button>}
        </div>
      )}

      <div className="bar-bottom">
        {transcoding && total > 0 && (
          <label className="seek">
            <span className="small muted">{clock(pos)}</span>
            <input type="range" min={0} max={Math.floor(total)} value={Math.floor(pos)}
              onChange={(e) => setPos(+e.target.value)}
              onPointerUp={(e) => seekTo(+(e.target as HTMLInputElement).value)}
              onKeyUp={(e) => seekTo(+(e.target as HTMLInputElement).value)} />
            <span className="small muted">{clock(total)}</span>
          </label>
        )}
        <div className="controls">
          <label>Quality
            <select value={q} onChange={(e) => reload({ q: e.target.value })}>
              {QUALITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>Speed
            <select value={speed} onChange={(e) => { const s = +e.target.value; setSpeed(s); localStorage.setItem('speed', String(s)); if (vref.current) vref.current.playbackRate = s; }}>
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
          {(info.subs?.length ?? 0) > 0 && (
            <label>Subtitles
              <select value={sub} onChange={(e) => reload({ sub: +e.target.value })}>
                <option value={-1}>Off</option>
                {info.subs!.map((t) => <option key={t.i} value={t.i}>{t.label}</option>)}
              </select>
            </label>
          )}
          {transcoding && (info.audio?.length ?? 0) > 1 && (
            <label>Audio
              <select value={a} onChange={(e) => reload({ a: +e.target.value })}>
                {info.audio!.map((t) => <option key={t.i} value={t.i}>{t.label}</option>)}
              </select>
            </label>
          )}
          <span className="grow" />
          {next && <button className="btn ghost" onClick={() => p.onNext(next)}>Next episode</button>}
          <a className="btn ghost" href={`/api/download?${qs({ root: p.root, path })}`}><Icon n="down" s={16} /> Download</a>
          <button className="btn danger" onClick={() => p.onDelete(p.name)}><Icon n="trash" s={16} /> Delete</button>
        </div>
        <p className="keys small muted">Space play/pause · ←/→ skip 10s · F fullscreen · N next episode · M mute</p>
      </div>
    </div>
  );
}