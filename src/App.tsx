import { CSSProperties, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Player from './Player';
import {
  ACCENTS, ASPECTS, Entry, Icon, LANGS, Net, Prog, QUALITIES, Root, SettingsCtx, VIDEO,
  api, bytes, clock, hue, join, loadSettings, mbps, pct, qs, rate, speedTest, turboDownload, turboOk, useNet, Settings,
} from './lib';

type Ask = { title: string; body: string; label: string; go: () => Promise<void> };
type DL = { id: string; name: string; done: number; total: number; speed: number; state: 'run' | 'done' | 'error' | 'cancel'; error?: string; ctl: AbortController };

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const set = useCallback((p: Partial<Settings>) => setSettings((o) => {
    const n = { ...o, ...p };
    try { localStorage.setItem('sr.settings', JSON.stringify(n)); } catch { /* private mode */ }
    return n;
  }), []);
  useEffect(() => { document.documentElement.style.setProperty('--lamp', ACCENTS[settings.accent] ?? ACCENTS.Amber); }, [settings.accent]);
  return <SettingsCtx.Provider value={{ s: settings, set }}><Library /></SettingsCtx.Provider>;
}

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

function NetCard({ net }: { net: Net }) {
  const peak = Math.max(1, ...net.hist);
  return (
    <section className="netcard" aria-label="Network status">
      <div className="net-top">
        <strong>Network</strong>
        <span className={net.active ? 'live on' : 'live'}>{!net.ok ? 'offline' : net.active ? `${net.active} streaming` : 'idle'}</span>
      </div>
      <div className="net-big"><b>{rate(net.speed)}</b><small>{mbps(net.speed)}</small></div>
      <svg className="spark" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">
        <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={net.hist.map((v, i) => `${(i / 59) * 120},${29 - (v / peak) * 27}`).join(' ')} />
      </svg>
      <dl>
        <dt>Sent today</dt><dd>{bytes(net.today)}</dd>
        <dt>Sent in total</dt><dd>{bytes(net.lifetime)}</dd>
      </dl>
      <p className="muted small">{net.mode === 'local' ? 'Reading straight from the server disk' : net.mode ? 'Reading over SSH' : ''}</p>
    </section>
  );
}

function Library() {
  const { s, set } = useContext(SettingsCtx);
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
  const [prefs, setPrefs] = useState(false);
  const [dls, setDls] = useState<DL[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const net = useNet(null, 2000);

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !play && !prefs && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, prefs]);

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

  // Files over 24 MB use several parallel connections when the browser allows it; otherwise a normal download.
  const download = (it: Entry) => {
    const url = `/api/download?${qs({ root, path: join(dir, it.name) })}`;
    if (s.turbo && turboOk() && it.size > 24 * 1024 * 1024) {
      const id = `${Date.now()}${Math.random()}`;
      const ctl = new AbortController();
      const upd = (patch: Partial<DL>) => setDls((d) => d.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      setDls((d) => [...d, { id, name: it.name, done: 0, total: it.size, speed: 0, state: 'run', ctl }]);
      turboDownload(url, it.name, it.size, s.conns, (p) => upd(p), ctl.signal)
        .then(() => upd({ state: 'done', done: it.size, speed: 0 }))
        .catch((e: any) => {
          if (e?.name === 'AbortError' && !ctl.signal.aborted) setDls((d) => d.filter((x) => x.id !== id)); // save dialog dismissed
          else upd({ state: ctl.signal.aborted ? 'cancel' : 'error', error: e?.message, speed: 0 });
        });
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = it.name;
      document.body.appendChild(a); a.click(); a.remove();
    }
  };

  const videos = useMemo(() => items.filter((i) => !i.dir && VIDEO.test(i.name)).map((i) => i.name), [items]);
  const seen = videos.filter((n) => prog[pkey(n)]?.watched);
  const shown = useMemo(() => {
    const f = items.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()));
    const c = (a: Entry, b: Entry) => sort === 'new' ? b.mtime - a.mtime : sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name, undefined, { numeric: true });
    return [...f.filter((i) => i.dir).sort(c), ...f.filter((i) => !i.dir).sort(c)];
  }, [items, query, sort]);
  const folders = shown.filter((i) => i.dir);
  const files = shown.filter((i) => !i.dir);
  const posters = s.view === 'grid' ? files.filter((i) => VIDEO.test(i.name)) : [];
  const rows = s.view === 'grid' ? files.filter((i) => !VIDEO.test(i.name)) : files;

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

  const fileActions = (it: Entry, isVid: boolean, p?: Prog) => (
    <>
      {isVid && <button className="icon" title={p?.watched ? 'Mark as unwatched' : 'Mark as watched'} aria-label={p?.watched ? 'Mark as unwatched' : 'Mark as watched'} onClick={() => setWatched(it.name, !p?.watched)}><Icon n="check" /></button>}
      <button className="icon" title="Download" aria-label={`Download ${it.name}`} onClick={() => download(it)}><Icon n="down" /></button>
      <button className="icon danger" title="Delete from server" aria-label={`Delete ${it.name}`} onClick={() => confirmDelete([it.name], `“${it.name}”`)}><Icon n="trash" /></button>
    </>
  );

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="lamp" />Screening Room</div>
        <p className="muted small host">{host ? `Connected to ${host}` : 'Connecting to your VPS…'}</p>
        <nav className="shelves" aria-label="Storage">
          {roots.map((r) => (
            <button key={r.id} className={r.id === root ? 'shelf on' : 'shelf'} onClick={() => { setRoot(r.id); setDir(''); }}>
              <strong>{r.name}</strong>
              <span className="muted small">{r.total ? `${bytes(r.free)} free of ${bytes(r.total)}` : r.dir}</span>
              {r.total > 0 && <i className="bar"><b style={{ width: `${100 - (r.free / r.total) * 100}%` }} /></i>}
            </button>
          ))}
        </nav>
        <NetCard net={net} />
        <button className="btn ghost wide" onClick={() => setPrefs(true)}><Icon n="sliders" s={16} /> Settings</button>
      </aside>

      <main className="main">
        {!dir && resumable.length > 0 && (
          <section className="resume">
            <h2>Continue watching</h2>
            <div className="cards">
              {resumable.map((x) => (
                <button key={x.k} className="card" style={{ '--h': hue(x.dir || x.name) } as CSSProperties}
                  onClick={() => { setRoot(x.rid); setDir(x.dir); setPlay(x.name); }}>
                  <span className="shot"><Thumb root={x.rid} path={join(x.dir, x.name)} v={0} icon="film" /></span>
                  <span className="go"><Icon n="play" s={18} /></span>
                  <span className="card-t">
                    <strong>{x.name.replace(/\.[^.]+$/, '')}</strong>
                    <span className="small">{clock(x.p.pos)} of {clock(x.p.dur)}</span>
                  </span>
                  <i className="prog"><b style={{ width: `${pct(x.p)}%` }} /></i>
                </button>
              ))}
            </div>
          </section>
        )}

        <header className="top">
          <div className="crumbs">
            {dir && <button className="icon" onClick={() => setDir(crumbs.slice(0, -1).join('/'))} title="Back" aria-label="Back"><Icon n="back" /></button>}
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

        {items.length > 0 && (
          <div className="tools">
            <label className="search"><Icon n="search" s={16} /><input ref={search} placeholder="Search this folder  (press /)" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort">
              <option value="name">Name</option><option value="new">Newest</option><option value="size">Largest</option>
            </select>
            <span className="seg" role="group" aria-label="View">
              <button className={s.view === 'grid' ? 'on' : ''} onClick={() => set({ view: 'grid' })} title="Poster view" aria-label="Poster view"><Icon n="grid" s={16} /></button>
              <button className={s.view === 'list' ? 'on' : ''} onClick={() => set({ view: 'list' })} title="List view" aria-label="List view"><Icon n="list" s={16} /></button>
            </span>
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
              <div key={f.name} className="tile" style={{ '--h': hue(f.name) } as CSSProperties}>
                <button className="tile-open" onClick={() => setDir(join(dir, f.name))}>
                  <Icon n="folder" s={22} />
                  <strong>{f.name}</strong>
                </button>
                <span className="tile-act">
                  <a className="icon" title="Download folder" aria-label={`Download folder ${f.name}`} href={`/api/download?${qs({ root, path: join(dir, f.name) })}`}><Icon n="down" s={16} /></a>
                  <button className="icon danger" title="Delete from server" aria-label={`Delete folder ${f.name}`} onClick={() => confirmDelete([f.name], `“${f.name}”`)}><Icon n="trash" s={16} /></button>
                </span>
              </div>
            ))}
          </div>
        )}

        {posters.length > 0 && (
          <ul className="posters">
            {posters.map((it) => {
              const p = prog[pkey(it.name)];
              const part = p && !p.watched && p.pos > 30;
              return (
                <li key={it.name} className={p?.watched ? 'poster done' : 'poster'} style={{ '--h': hue(it.name) } as CSSProperties}>
                  <button className="poster-open" onClick={() => setPlay(it.name)}>
                    <span className="frame">
                      <Thumb root={root} path={join(dir, it.name)} v={it.mtime} icon="film" />
                      <span className="go"><Icon n="play" s={18} /></span>
                      {p?.watched && <span className="tag"><Icon n="check" s={12} /> Watched</span>}
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
                <li key={it.name} className={p?.watched ? 'row done' : 'row'}>
                  <button className="open" onClick={() => isVid && setPlay(it.name)}>
                    <span className="ico">{isVid && s.thumbs ? <Thumb root={root} path={join(dir, it.name)} v={it.mtime} icon="film" /> : <Icon n={isVid ? 'film' : 'file'} />}</span>
                    <span className="info">
                      <span className="name">{it.name}</span>
                      <span className="meta muted small">{bytes(it.size)}, {new Date(it.mtime * 1000).toLocaleDateString()}{part ? `, stopped at ${clock(p.pos)}` : ''}</span>
                      {part && <i className="prog"><b style={{ width: `${pct(p)}%` }} /></i>}
                    </span>
                    {p?.watched && <span className="tag"><Icon n="check" s={13} /> Watched</span>}
                  </button>
                  {fileActions(it, isVid, p)}
                </li>
              );
            })}
          </ul>
        )}
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
      {prefs && <SettingsDialog mode={net.mode} onClose={() => setPrefs(false)} />}
      {ask && <Confirm ask={ask} onClose={() => setAsk(null)} onError={flash} />}
      {dls.length > 0 && <Tray dls={dls} onDismiss={(id) => setDls((d) => d.filter((x) => x.id !== id))} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Tray({ dls, onDismiss }: { dls: DL[]; onDismiss: (id: string) => void }) {
  return (
    <aside className="tray" aria-label="Downloads">
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

const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="field"><div><b>{label}</b>{hint && <small>{hint}</small>}</div><div className="field-c">{children}</div></div>
);
const Toggle = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
  <button className="toggle" role="switch" aria-checked={on} aria-label={label} onClick={onClick}><i className={on ? 'sw on' : 'sw'} /></button>
);

function SettingsDialog({ onClose, mode }: { onClose: () => void; mode: string }) {
  const { s, set } = useContext(SettingsCtx);
  const [t, setT] = useState<{ running: boolean; live: number; res?: { avg: number; peak: number; bytes: number }; err?: string }>({ running: false, live: 0 });
  const ctl = useRef<AbortController>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); ctl.current?.abort(); };
  }, [onClose]);

  const run = async () => {
    ctl.current = new AbortController();
    setT({ running: true, live: 0 });
    try {
      const r = await speedTest(4, 128, (v) => setT((x) => ({ ...x, live: v })), ctl.current.signal);
      setT({ running: false, live: 0, res: r });
    } catch (e: any) { setT({ running: false, live: 0, err: e?.name === 'AbortError' ? 'Stopped' : e?.message }); }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="dlg-head"><h3>Settings</h3><button className="icon" onClick={onClose} aria-label="Close settings"><Icon n="close" /></button></div>

        <section>
          <h4>Look</h4>
          <Field label="Accent color">
            <span className="swatches">{Object.entries(ACCENTS).map(([name, c]) => (
              <button key={name} className={s.accent === name ? 'sw-c on' : 'sw-c'} style={{ background: c }} title={name} aria-label={name} onClick={() => set({ accent: name })} />
            ))}</span>
          </Field>
          <Field label="Video thumbnails" hint="Made once on the server, then cached"><Toggle on={s.thumbs} label="Video thumbnails" onClick={() => set({ thumbs: !s.thumbs })} /></Field>
        </section>

        <section>
          <h4>Playback</h4>
          <Field label="Default quality">
            <select value={s.quality} onChange={(e) => set({ quality: e.target.value })}>{QUALITIES.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select>
          </Field>
          <Field label="Default screen shape">
            <select value={s.aspect} onChange={(e) => set({ aspect: e.target.value })}>{ASPECTS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select>
          </Field>
          <Field label="Play next episode automatically"><Toggle on={s.autoNext} label="Autoplay next" onClick={() => set({ autoNext: !s.autoNext })} /></Field>
        </section>

        <section>
          <h4>Subtitles</h4>
          <Field label="Turn on subtitles automatically" hint="Picks a track in your language, inside the video or next to it">
            <Toggle on={s.autoSub} label="Auto subtitles" onClick={() => set({ autoSub: !s.autoSub })} />
          </Field>
          <Field label="Your language">
            <select value={s.subLang} onChange={(e) => set({ subLang: e.target.value })}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select>
          </Field>
          <Field label="Skip if the audio is already in that language">
            <Toggle on={s.subSmart} label="Skip when audio matches" onClick={() => set({ subSmart: !s.subSmart })} />
          </Field>
        </section>

        <section>
          <h4>Downloads</h4>
          <Field label="Turbo download" hint={turboOk() ? 'Splits big files across several connections and saves straight to disk' : 'Needs Chrome, Edge or Opera over HTTPS (or localhost). Other browsers use a normal download.'}>
            <Toggle on={s.turbo} label="Turbo download" onClick={() => set({ turbo: !s.turbo })} />
          </Field>
          <Field label="Connections per file" hint="More is faster until your line or the VPS is full">
            <select value={s.conns} onChange={(e) => set({ conns: +e.target.value })}>{[2, 4, 8, 12, 16].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
        </section>

        <section>
          <h4>Speed test</h4>
          <p className="muted small">Measures how fast your VPS can send data to this browser. That number is the real limit for streaming and downloads. Server disk path: {mode === 'local' ? 'direct (fastest)' : mode ? 'through SSH' : 'unknown'}.</p>
          <div className="test">
            <button className="btn" disabled={t.running} onClick={run}><Icon n="bolt" s={15} /> {t.running ? 'Testing…' : 'Run speed test'}</button>
            {t.running && <button className="btn ghost" onClick={() => ctl.current?.abort()}>Stop</button>}
            {t.running && <strong className="live-n">{rate(t.live)} <small>{mbps(t.live)}</small></strong>}
          </div>
          {t.res && <p>Average <b>{rate(t.res.avg)}</b> ({mbps(t.res.avg)}), peak <b>{mbps(t.res.peak)}</b>, {bytes(t.res.bytes)} transferred.</p>}
          {t.err && <p className="err-t">{t.err}</p>}
        </section>
      </div>
    </div>
  );
}