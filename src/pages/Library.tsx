import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Collection, ItemMeta } from '../Extras';
import { Prefs, PrefsCtx, Prog, Settings, SettingsCtx, VIDEO, api, bridge, bytes, clock, hue, join, pct, Icon } from '../lib';
import { useContext } from 'react';
import { Art, Thumb, folderPosterUrl } from '../components/Art';

export type LibraryProps = {
  roots: { id: number; name: string; dir: string; free: number; total: number; offline?: boolean; opened?: boolean }[];
  host: string;
  hasServer: boolean;
  rootsErr: string;
  root: number | null;
  dir: string;
  setRoot: (id: number) => void;
  setDir: (d: string) => void;
  items: { name: string; dir: boolean; size: number; mtime: number }[];
  status: 'loading' | 'ready' | 'error';
  err: string;
  prog: Record<string, Prog>;
  load: () => void;
  pkey: (name: string, d?: string, r?: number | null) => string;
  metaOf: (name: string) => ItemMeta;
  allTags: string[];
  onMetaFor: (name: string, patch: Partial<ItemMeta>) => void;
  onOpenPlayer: (name: string, r: number, d: string) => void;
  onPlaySelection: (list: string[], r: number, d: string) => void;
  onSaveOffline: (names: string[], sizes: number, r: number, d: string) => void;
  onOpenDetails: (name: string) => void;
  onConfirmDelete: (names: string[], what: string) => void;
  onOpenRule: () => void;
  onAskName: (v: { title: string; value: string; label: string; go: (v: string) => void } | null) => void;
  onFlash: (m: string) => void;
  onAddTo: (names: string[]) => void;
  onSetWatched: (name: string, watched: boolean) => void;
  onToggleFav: (name: string) => void;
};

export function Library(p: LibraryProps) {
  const { s, set } = useContext(SettingsCtx);
  const { prefs, setPref } = useContext(PrefsCtx);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'new' | 'size'>('name');
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [libMenu, setLibMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [sibs, setSibs] = useState<string[]>([]);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => { setQuery(''); setSelecting(false); setSel([]); }, [p.dir, p.root]);

  useEffect(() => {
    const last = p.dir.split('/').pop() ?? '';
    if (!p.dir || !/^(season|series|s)\s*\d+/i.test(last) || p.root === null) { setSibs([]); return; }
    let dead = false;
    const dirOf = (v: string) => v.split('/').slice(0, -1).join('/');
    api<{ name: string; dir: boolean; size: number; mtime: number }[]>('list', { root: p.root, path: dirOf(p.dir) })
      .then((l) => { if (!dead) setSibs(l.filter((e) => e.dir && /^(season|series|s)\s*\d+/i.test(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))); })
      .catch(() => setSibs([]));
    return () => { dead = true; };
  }, [p.dir, p.root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cur = p.roots.find((r) => r.id === p.root);
  const offline = !!cur?.offline;
  const opened = !!cur?.opened;
  const rid = p.root ?? -1;
  const crumbs = p.dir ? p.dir.split('/') : [];
  const dirOf = (v: string) => v.split('/').slice(0, -1).join('/');
  const baseName = (v: string) => v.split('/').pop() ?? v;
  const favs = prefs.favs ?? [];

  const videos = useMemo(() => p.items.filter((i) => !i.dir && VIDEO.test(i.name)).map((i) => i.name), [p.items]);
  const seen = videos.filter((n) => p.prog[p.pkey(n)]?.watched);

  // FIXED: Removed the old `s.filter` logic so hidden filters don't break the view
  const shown = useMemo(() => {
    const f = p.items.filter((i) => {
      if (!i.name.toLowerCase().includes(query.toLowerCase())) return false;
      return true; 
    });
    const c = (a: typeof p.items[number], b: typeof p.items[number]) =>
      sort === 'new' ? b.mtime - a.mtime : sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name, undefined, { numeric: true });
    return [...f.filter((i) => i.dir).sort(c), ...f.filter((i) => !i.dir).sort(c)];
  }, [p.items, query, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const folders = shown.filter((i) => i.dir);
  const files = shown.filter((i) => !i.dir);
  const posters = s.view !== 'list' ? files.filter((i) => VIDEO.test(i.name)) : [];
  const rows = s.view !== 'list' ? files.filter((i) => !VIDEO.test(i.name)) : files;

  const nextUp = (() => {
    if (!videos.length) return null;
    const part = videos.filter((n) => { const pr = p.prog[p.pkey(n)]; return pr && !pr.watched && pr.pos > 30; })
      .sort((a, b) => p.prog[p.pkey(b)].updated - p.prog[p.pkey(a)].updated)[0];
    if (part) return { name: part, label: 'Resume' };
    const fresh = videos.find((n) => !p.prog[p.pkey(n)]?.watched);
    return { name: fresh ?? videos[0], label: fresh && seen.length ? 'Play next' : 'Play' };
  })();

  const endSelect = () => { setSelecting(false); setSel([]); };
  const toggleSel = (name: string) => setSel((x) => (x.includes(name) ? x.filter((n) => n !== name) : [...x, name]));
  const open = (name: string) => p.onOpenPlayer(name, rid, p.dir);

  const playSelected = () => {
    const list = videos.filter((n) => sel.includes(n));
    if (!list.length) return;
    endSelect();
    p.onPlaySelection(list, rid, p.dir);
  };
  const saveSelected = () => {
    const list = videos.filter((n) => sel.includes(n));
    if (!list.length) return;
    p.onSaveOffline(list, p.items.filter((i) => list.includes(i.name)).reduce((a, i) => a + i.size, 0), rid, p.dir);
    endSelect();
  };
  const savePlaylist = () => {
    const names = videos.filter((n) => sel.includes(n));
    if (!names.length || !cur) return;
    p.onAskName({
      title: 'Save playlist',
      value: `${crumbs[crumbs.length - 1] || cur.name} playlist`,
      label: 'Save playlist',
      go: (v) => {
        const lists = prefs.playlists ?? [];
        setPref('playlists', [...lists, { id: `${Date.now()}`, name: v.trim() || 'My playlist', root: cur.name, dir: p.dir, items: names }]);
        endSelect();
        p.onFlash('Playlist saved. Find it under Playlists');
      },
    });
  };

  const fileActions = (it: typeof p.items[number], isVid: boolean, pr?: Prog) => {
    const done = (fn: () => void) => () => { setMenuFor(null); fn(); };
    const openMenu = menuFor === it.name;
    return (
      <>
        {isVid && <button className={favs.includes(p.pkey(it.name)) ? 'icon on' : 'icon'} title="Favorite" aria-label={`Favorite ${it.name}`} aria-pressed={favs.includes(p.pkey(it.name))} onClick={() => p.onToggleFav(it.name)}><Icon n="heart" s={17} /></button>}
        {!offline && <button className="icon" title="Save for offline" aria-label={`Save ${it.name} for offline`} onClick={() => p.onSaveOffline([it.name], it.size, rid, p.dir)}><Icon n="save" s={17} /></button>}
        <button className={openMenu ? 'icon on-m' : 'icon'} title="More" aria-label={`More actions for ${it.name}`} aria-haspopup="menu" aria-expanded={openMenu} onClick={() => setMenuFor(openMenu ? null : it.name)}><Icon n="more" s={17} /></button>
        {openMenu && (
          <>
            <div className="amenu-bg" onClick={() => setMenuFor(null)} />
            <div className="amenu" role="menu">
              {isVid && <button role="menuitem" onClick={done(() => p.onAddTo([it.name]))}><Icon n="folder" s={15} /> Add to collection…</button>}
              {isVid && <button role="menuitem" onClick={done(() => p.onOpenDetails(it.name))}><Icon n="info" s={15} /> Details</button>}
              {isVid && <button role="menuitem" onClick={done(() => p.onSetWatched(it.name, !pr?.watched))}><Icon n="check" s={15} /> {pr?.watched ? 'Mark as unwatched' : 'Mark as watched'}</button>}
              <i className="amenu-sep" />
              <button role="menuitem" className="del" onClick={done(() => p.onConfirmDelete([it.name], `“${it.name}”`))}><Icon n="trash" s={15} /> {offline ? 'Delete from this laptop' : 'Delete from server'}</button>
            </div>
          </>
        )}
      </>
    );
  };

  return (
    <>
      <div className="lib-head">
        <div className="lib-src" role="tablist" aria-label="Storage">
          {p.roots.map((r) => (
            <button key={r.id} role="tab" aria-selected={r.id === p.root} className={r.id === p.root ? 'lib-src-b on' : 'lib-src-b'} onClick={() => { p.setRoot(r.id); p.setDir(''); }} title={r.total ? `${bytes(r.free)} free of ${bytes(r.total)}` : r.dir}>
              {r.opened ? <><Icon n="film" s={14} /> Opened files</> : r.offline ? <><Icon n="hdd" s={14} /> On this laptop</> : <><Icon n="server" s={14} /> {r.name}</>}
            </button>
          ))}
          <span className="grow" />
          <span className={p.rootsErr ? 'lib-status bad' : p.hasServer && p.host ? 'lib-status ok' : 'lib-status'}><i />{p.hasServer ? (p.rootsErr ? `Cannot reach ${p.host}` : p.host ? p.host : 'Connecting…') : 'No server set up'}</span>
        </div>

        <nav className="lib-crumbs" aria-label="Folder path">
          {p.dir && <button className="lib-back" onClick={() => p.setDir(crumbs.slice(0, -1).join('/'))} title="Back" aria-label="Back"><Icon n="back" s={16} /></button>}
          <button className={p.dir ? 'lib-crumb' : 'lib-crumb here'} onClick={() => p.setDir('')}>{opened ? 'Opened files' : offline ? 'On this laptop' : cur?.name ?? 'Library'}</button>
          {crumbs.map((c, i) => <span key={i} className="lib-crumb-w"><em>›</em><button className={i === crumbs.length - 1 ? 'lib-crumb here' : 'lib-crumb'} onClick={() => p.setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
        </nav>
      </div>

      {sibs.length > 1 && (
        <div className="season-tabs" role="tablist">
          {sibs.map((n) => <button key={n} role="tab" aria-selected={n === p.dir.split('/').pop()} className={n === p.dir.split('/').pop() ? 'on' : ''} onClick={() => p.setDir(join(dirOf(p.dir), n))}>{n}</button>)}
        </div>
      )}

      {p.items.length > 0 && (
        <div className="lib-bar c2">
          <div className="lib-c2-title">
            <div className="lib-quiet" role="toolbar" aria-label="Library tools">
              <div className="lib-sort-wrap">
                <button type="button" className={sortMenu ? 'lib-quiet-b on' : 'lib-quiet-b'} onClick={() => { setSortMenu((x) => !x); setLibMenu(false); }} aria-haspopup="menu" aria-expanded={sortMenu}>
                  Sort · {sort === 'name' ? 'Name' : sort === 'new' ? 'Newest' : 'Largest'} ▾
                </button>
                {sortMenu && (
                  <>
                    <div className="lib-menu-back" onClick={() => setSortMenu(false)} />
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
              {nextUp && !(p.dir && videos.length > 0) && <button className="btn sm" onClick={() => open(nextUp.name)}><Icon n="play" s={14} /> {nextUp.label}</button>}
              <div className="lib-more">
                <button type="button" className={libMenu ? 'lib-quiet-b on' : 'lib-quiet-b'} onClick={() => { setLibMenu((x) => !x); setSortMenu(false); }} aria-haspopup="menu" aria-expanded={libMenu} title="More"><Icon n="more" s={16} /></button>
                {libMenu && (
                  <>
                    <div className="lib-menu-back" onClick={() => setLibMenu(false)} />
                    <div className="lib-menu" role="menu">
                      <button role="menuitem" onClick={() => { setLibMenu(false); p.load(); }}><Icon n="rotate" s={15} /> Refresh</button>
                      {videos.length > 1 && <button role="menuitem" onClick={() => { setLibMenu(false); const pool = videos.filter((n) => !p.prog[p.pkey(n)]?.watched); const list = pool.length ? pool : videos; open(list[Math.floor(Math.random() * list.length)]); }}><Icon n="bolt" s={15} /> Surprise me</button>}
                      {!offline && p.dir && <button role="menuitem" onClick={() => { setLibMenu(false); p.onSaveOffline([crumbs[crumbs.length - 1]], 0, rid, p.dir); }}><Icon n="save" s={15} /> Save folder for offline</button>}
                      {!offline && !bridge && p.dir && <a role="menuitem" href={`/api/download?root=${rid}&path=${encodeURIComponent(p.dir)}`} onClick={() => setLibMenu(false)}><Icon n="down" s={15} /> Download folder</a>}
                      {seen.length > 0 && <><i className="amenu-sep" /><button role="menuitem" className="del" onClick={() => { setLibMenu(false); p.onConfirmDelete(seen, `${seen.length} watched video${seen.length > 1 ? 's' : ''}`); }}><Icon n="trash" s={15} /> Delete {seen.length} watched</button></>}
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
        </div>
      )}

      {p.dir && videos.length > 0 && (
        <section className="series-head">
          <span className="series-bg" aria-hidden="true"><Art root={rid} path={join(p.dir, videos[0])} v={0} name={crumbs[crumbs.length - 1]} /></span>
          <span className="series-art"><Art root={rid} path={join(p.dir, videos[0])} v={0} name={crumbs[crumbs.length - 1]} /></span>
          <div className="series-info">
            <h1>{crumbs[crumbs.length - 1]}</h1>
            <p className="muted">{videos.length} video{videos.length > 1 ? 's' : ''} · {seen.length} watched{videos.length - seen.length > 0 ? ` · ${videos.length - seen.length} to go` : ''}</p>
            <i className="bar"><b style={{ width: `${(seen.length / videos.length) * 100}%` }} /></i>
            <span className="inline sh-act">
              {nextUp && <button className="btn big" onClick={() => open(nextUp.name)}><Icon n="play" s={15} /> {seen.length ? 'Next episode' : 'Start'}</button>}
              {!offline && !opened && <button className="btn ghost big" onClick={p.onOpenRule} title="Keep new or upcoming episodes saved on this laptop"><Icon n="save" s={15} /> Auto-save…</button>}
            </span>
          </div>
        </section>
      )}

      {selecting && (
        <div className="seldock" role="status">
          <strong className="sd-n"><b>{sel.length}</b> selected</strong>
          <button className="btn" disabled={!sel.length} onClick={playSelected}><Icon n="play" s={15} /> Play</button>
          <button className="sd-b" onClick={() => setSel(sel.length === videos.length ? [] : videos)}>{sel.length === videos.length ? 'Clear' : 'Select all'}</button>
          <i className="sd-sep" />
          <button className="sd-b" disabled={!sel.length} onClick={() => p.onAddTo(videos.filter((n) => sel.includes(n)))}><Icon n="folder" s={15} /> Collection</button>
          <button className="sd-b" disabled={!sel.length} onClick={savePlaylist}><Icon n="list" s={15} /> Playlist</button>
          {!offline && <button className="sd-b" disabled={!sel.length} onClick={saveSelected}><Icon n="save" s={15} /> Offline</button>}
          <button className="sd-b danger" disabled={!sel.length} onClick={() => { const l = videos.filter((n) => sel.includes(n)); endSelect(); p.onConfirmDelete(l, `${l.length} video${l.length > 1 ? 's' : ''}`); }}><Icon n="trash" s={15} /> Delete</button>
          <i className="sd-sep" />
          <button className="sd-b" onClick={endSelect} aria-label="Cancel selection">Cancel</button>
        </div>
      )}
      {p.status === 'loading' && p.root !== null && <div className="skeletons" aria-label="Loading">{Array.from({ length: 10 }, (_, k) => <i key={k} />)}</div>}
      {p.status === 'error' && !p.rootsErr && (
        <div className="note err">
          <strong>Could not read this folder.</strong> {p.err}
          <p className="muted">Check that the server is reachable and the media folder is right (Servers).</p>
          <button className="btn" onClick={p.load}>Try again</button>
        </div>
      )}
      {p.status === 'ready' && p.items.length === 0 && <p className="note">{opened ? 'No opened videos. Drop a video here, press Ctrl+O, or right-click a video in Explorer and choose Open with Cinema.' : offline ? 'Nothing downloaded yet. Use the save icon on a movie, or “Save for offline” inside the player.' : 'This folder is empty. Downloads from the bot will show up here.'}</p>}
      {p.status === 'ready' && p.items.length > 0 && shown.length === 0 && <p className="note">Nothing matches{query ? ` “${query}”` : ''}.</p>}

      {folders.length > 0 && (
        <div className="tiles">
          {folders.map((f) => (
            <div key={f.name} className="tile" style={{ '--h': hue(f.name) } as CSSProperties}>
              <button className="tile-open" onClick={() => p.setDir(join(p.dir, f.name))}>
                <span className="tile-ic">
                  {s.posters && <img className="tile-poster" alt="" loading="lazy" src={folderPosterUrl(rid, join(p.dir, f.name))} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                  <Icon n="folder" s={20} />
                </span>
                <strong>{f.name}</strong>
              </button>
              <span className="tile-act">
                {!offline && <button className="icon" title="Save folder for offline" aria-label={`Save folder ${f.name} for offline`} onClick={() => p.onSaveOffline([f.name], 0, rid, p.dir)}><Icon n="save" s={16} /></button>}
                <button className="icon danger" title="Delete" aria-label={`Delete folder ${f.name}`} onClick={() => p.onConfirmDelete([f.name], `“${f.name}”`)}><Icon n="trash" s={16} /></button>
              </span>
            </div>
          ))}
        </div>
      )}

      {posters.length > 0 && (
        <ul className={(s.posters ? 'posters portrait' : 'posters') + (s.view === 'wall' ? ' wall' : '')}>
          {posters.map((it) => {
            const pr = p.prog[p.pkey(it.name)];
            const part = pr && !pr.watched && pr.pos > 30;
            return (
              <li key={it.name} className={(pr?.watched ? 'poster done' : 'poster') + (sel.includes(it.name) ? ' picked' : '') + (menuFor === it.name ? ' menu-open' : '')} style={{ '--h': hue(it.name) } as CSSProperties}>
                {selecting && <span className={sel.includes(it.name) ? 'selmark on' : 'selmark'} aria-hidden="true"><Icon n="check" s={14} /></span>}
                <button className="poster-open" onClick={() => (selecting ? toggleSel(it.name) : open(it.name))}>
                  <span className="frame">
                    <Art root={rid} path={join(p.dir, it.name)} v={it.mtime} name={it.name} />
                    <span className="go"><Icon n="play" s={18} /></span>
                    {pr?.watched && <span className="tag"><Icon n="check" s={12} /> Watched</span>}
                    {favs.includes(p.pkey(it.name)) && <span className="fav-dot" aria-label="Favorite"><Icon n="heart" s={13} /></span>}
                    {part && <i className="prog"><b style={{ width: `${pct(pr)}%` }} /></i>}
                  </span>
                  <span className="p-name" title={it.name}>{it.name.replace(/\.[^.]+$/, '')}</span>
                  <span className="small muted">{bytes(it.size)}{part ? `, stopped at ${clock(pr.pos)}` : ''}</span>
                </button>
                <span className="p-act">{fileActions(it, true, pr)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > 0 && (
        <ul className="rows">
          {rows.map((it) => {
            const isVid = VIDEO.test(it.name);
            const pr = p.prog[p.pkey(it.name)];
            const part = pr && !pr.watched && pr.pos > 30;
            return (
              <li key={it.name} className={(pr?.watched ? 'row done' : 'row') + (sel.includes(it.name) ? ' picked' : '') + (menuFor === it.name ? ' menu-open' : '')}>
                {selecting && isVid && <span className={sel.includes(it.name) ? 'selmark on inrow' : 'selmark inrow'} aria-hidden="true"><Icon n="check" s={14} /></span>}
                <button className="open" onClick={() => isVid && (selecting ? toggleSel(it.name) : open(it.name))}>
                  <span className="ico">{isVid && s.thumbs ? <Thumb root={rid} path={join(p.dir, it.name)} v={it.mtime} icon="film" /> : <Icon n={isVid ? 'film' : 'file'} />}</span>
                  <span className="info">
                    <span className="name">{it.name}</span>
                    <span className="meta muted small">{bytes(it.size)}, {new Date(it.mtime * 1000).toLocaleDateString()}{part ? `, stopped at ${clock(pr.pos)}` : ''}</span>
                    {part && <i className="prog"><b style={{ width: `${pct(pr)}%` }} /></i>}
                  </span>
                  {pr?.watched && <span className="tag"><Icon n="check" s={13} /> Watched</span>}
                </button>
                <span className="r-act">{fileActions(it, isVid, pr)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}