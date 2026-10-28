import { ReactNode, useEffect, useState } from 'react';
import { Icon, api, bytes, parseTitle, post } from './lib';

export type Collection = { id: string; name: string; items: { root: string; path: string }[] };
export type ItemMeta = { r?: number; t?: string[] };

const base = (p: string) => p.split('/').pop() ?? p;

/* ---------------- ratings and tags ---------------- */
export function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span className="stars" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} role="radio" aria-checked={value === n} className={n <= value ? 'on' : ''} onClick={() => onChange(value === n ? 0 : n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}>★</button>
      ))}
    </span>
  );
}

export function TagsEditor({ tags, all, onChange }: { tags: string[]; all: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState('');
  const add = (t: string) => { const x = t.trim().toLowerCase().slice(0, 24); if (x && !tags.includes(x)) onChange([...tags, x]); setV(''); };
  const sugg = all.filter((t) => !tags.includes(t) && t.startsWith(v.toLowerCase())).slice(0, 5);
  return (
    <div className="tagbox">
      <span className="taglist">{tags.map((t) => <button key={t} className="tag" onClick={() => onChange(tags.filter((x) => x !== t))} title="Remove">{t} ×</button>)}</span>
      <input value={v} placeholder="Add a tag and press Enter" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(v); } }} />
      {v && sugg.length > 0 && <span className="taglist">{sugg.map((t) => <button key={t} className="tag ghost" onClick={() => add(t)}>{t}</button>)}</span>}
    </div>
  );
}

/* ---------------- collections ---------------- */
export function CollectionsPage({ cols, art, onPlay, onRename, onDelete, onRemove }: {
  cols: Collection[]; art: (c: Collection['items'][number]) => ReactNode;
  onPlay: (it: Collection['items'][number], all: Collection['items']) => void; onRename: (c: Collection) => void; onDelete: (c: Collection) => void; onRemove: (c: Collection, i: number) => void;
}) {
  if (!cols.length) return (
    <section className="empty"><Icon n="folder" s={34} /><h2>No collections yet</h2>
      <p className="muted">A collection is a shelf you name yourself, such as “Weekend movies”, and it can mix videos from different folders. Use the “⋯” menu on any video, or Select several, then “Add to collection”.</p></section>
  );
  return (
    <div className="home">
      {cols.map((c) => (
        <section key={c.id} className="rail">
          <div className="rail-h">
            <h2>{c.name} <span className="muted small">{c.items.length} video{c.items.length === 1 ? '' : 's'}</span></h2>
            <span className="inline">
              {c.items.length > 0 && <button className="btn ghost sm" onClick={() => onPlay(c.items[0], c.items)}><Icon n="play" s={14} /> Play all</button>}
              <button className="btn ghost sm" onClick={() => onRename(c)}>Rename</button>
              <button className="btn ghost sm danger" onClick={() => onDelete(c)}>Delete</button>
            </span>
          </div>
          <div className="rail-row">
            {c.items.map((it, i) => (
              <span key={it.path + i} className="tilewrap">
                <button className="tilecard" onClick={() => onPlay(it, c.items)}>
                  <span className="tilecard-art">{art(it)}<span className="go"><Icon n="play" s={18} /></span></span>
                  <span className="tilecard-t" title={base(it.path)}>{base(it.path).replace(/\.[^.]+$/, '')}</span>
                </button>
                <button className="tile-x" onClick={() => onRemove(c, i)} aria-label="Remove from collection" title="Remove from this collection">×</button>
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function AddToCollection({ cols, count, onPick, onClose }: { cols: Collection[]; count: number; onPick: (id: string | 'new', name?: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const create = () => { if (name.trim()) onPick('new', name.trim()); };
  return (
    <div className="scrim" onClick={onClose}>
      <div className={`dialog atc-dialog${cols.length ? ' has-cols' : ' is-empty'}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add to collection">
        <div className="atc-accent" aria-hidden="true" />
        <header className="atc-head">
          <div>
            <h3>Add to collection</h3>
            <p>{count} video{count > 1 ? 's' : ''} selected</p>
          </div>
          <button type="button" className="atc-x" onClick={onClose} aria-label="Close"><Icon n="close" s={16} /></button>
        </header>

        {cols.length > 0 && (
          <div className="atc-list" role="list">
            {cols.map((c) => (
              <button key={c.id} type="button" className="atc-item" role="listitem" onClick={() => onPick(c.id)}>
                <span className="atc-item-icon"><Icon n="folder" s={16} /></span>
                <span className="atc-item-text">
                  <b>{c.name}</b>
                  <small>{c.items.length} video{c.items.length === 1 ? '' : 's'}</small>
                </span>
                <span className="atc-item-go">Add</span>
              </button>
            ))}
          </div>
        )}

        <div className="atc-create">
          <span className="atc-label">{cols.length > 0 ? 'Or create a new collection' : 'Name your first collection'}</span>
          <div className="atc-row">
            <input
              autoFocus
              value={name}
              placeholder="e.g. Weekend movies"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <button type="button" className="btn" disabled={!name.trim()} onClick={create}>Create</button>
          </div>
        </div>

        <footer className="atc-foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}

/* ---------------- home layout ---------------- */
export type HomeRow = { id: string; label: string; on: boolean };
export function HomeCustomize({ rows, onChange, onClose }: { rows: HomeRow[]; onChange: (r: HomeRow[]) => void; onClose: () => void }) {
  const visible = rows.filter((r) => r.on);
  const hidden  = rows.filter((r) => !r.on);

  const toggle = (id: string) => {
    onChange(rows.map((x) => (x.id === id ? { ...x, on: !x.on } : x)));
  };

  // Reorder only within the visible set (preserves relative order of hidden items)
  const moveVisible = (id: string, dir: -1 | 1) => {
    const vis = rows.filter((r) => r.on);
    const i = vis.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= vis.length) return;
    const a = vis[i].id;
    const b = vis[j].id;
    const next = [...rows];
    const ia = next.findIndex((r) => r.id === a);
    const ib = next.findIndex((r) => r.id === b);
    [next[ia], next[ib]] = [next[ib], next[ia]];
    onChange(next);
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog de-settings hc-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Customise Home">
        <div className="set-accent" aria-hidden="true" />
        <div className="dlg-head">
          <div>
            <h3>Customise Home</h3>
            <span className="dlg-sub">Move rows between columns</span>
          </div>
          <button className="icon set-close" onClick={onClose} aria-label="Close"><Icon n="close" /></button>
        </div>

        <div className="hc-cols">
          <div className="hc-col">
            <div className="hc-col-h">Visible</div>
            <ul className="hc-list">
              {visible.map((r, i) => (
                <li key={r.id}>
                  <label>
                    <input type="checkbox" checked onChange={() => toggle(r.id)} />
                    <span>{r.label}</span>
                  </label>
                  <span className="hc-order">
                    <button className="icon sm" disabled={i === 0} onClick={() => moveVisible(r.id, -1)} aria-label="Move up"><Icon n="back" s={13} /></button>
                    <button className="icon sm flipv" disabled={i === visible.length - 1} onClick={() => moveVisible(r.id, 1)} aria-label="Move down"><Icon n="back" s={13} /></button>
                  </span>
                </li>
              ))}
              {!visible.length && <li className="hc-empty">Nothing on Home yet</li>}
            </ul>
          </div>

          <div className="hc-col">
            <div className="hc-col-h">Hidden</div>
            <ul className="hc-list">
              {hidden.map((r) => (
                <li key={r.id}>
                  <label>
                    <input type="checkbox" checked={false} onChange={() => toggle(r.id)} />
                    <span>{r.label}</span>
                  </label>
                </li>
              ))}
              {!hidden.length && <li className="hc-empty">Nothing hidden</li>}
            </ul>
          </div>
        </div>

        <div className="dlg-actions"><button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

/* ---------------- welcome tour ---------------- */
const STEPS = [
  { t: 'Welcome to Cinema', d: 'A quick look at the main parts. It takes ten seconds.', i: 'film' },
  { t: 'Your library', d: 'Open Library to browse your server. Press Ctrl+K anywhere to search and run commands.', i: 'folder' },
  { t: 'Watch offline', d: 'Press Select, tick videos, then Save offline. Pick a quality and a time, and they download by themselves.', i: 'save' },
  { t: 'Make it yours', d: 'Collections, playlists, ratings and tags are all in the “⋯” menu. Customise Home from its top right.', i: 'list' },
  { t: 'Settings and keys', d: 'Press ? for every keyboard shortcut. Settings has a search box that finds any option.', i: 'sliders' },
];
export function Tour({ onDone }: { onDone: () => void }) {
  const [n, setN] = useState(0);
  const st = STEPS[n];
  return (
    <div className="scrim">
      <div className="dialog tour de-tour" role="dialog" aria-label="Welcome tour">
        <div className="set-accent" aria-hidden="true" />
        <span className="tour-ic"><Icon n={st.i} s={28} /></span>
        <h3>{st.t}</h3>
        <p className="muted">{st.d}</p>
        <div className="tour-dots">{STEPS.map((_, i) => <i key={i} className={i === n ? 'on' : ''} />)}</div>
        <div className="dlg-actions">
          <button className="btn ghost" onClick={onDone}>Skip</button>
          <button className="btn" onClick={() => (n === STEPS.length - 1 ? onDone() : setN(n + 1))}>{n === STEPS.length - 1 ? 'Start' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- tidy saved videos: duplicates and health check ---------------- */
type SavedItem = { rel: string; name: string; size: number; mtime: number };
export function Tidy({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<SavedItem[] | null>(null);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; note: string } | 'busy'>>({});
  const load = () => api<{ items: SavedItem[] }>('storage').then((d) => setItems(d.items)).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  const groups = new Map<string, SavedItem[]>();
  for (const f of items ?? []) { const t = parseTitle(f.name); const k = `${t.title.toLowerCase()}|${t.season}|${t.episode}|${t.year}`; groups.set(k, [...(groups.get(k) ?? []), f]); }
  const dups = [...groups.values()].filter((g) => g.length > 1);
  const del = async (f: SavedItem) => { await api('item', { root: 1000, path: f.rel }, 'DELETE').catch(() => {}); onChanged(); load(); };
  const check = async (f: SavedItem) => {
    setChecks((c) => ({ ...c, [f.rel]: 'busy' }));
    const r = await api<{ ok: boolean; note: string }>('storage/verify', { rel: f.rel }).catch((e) => ({ ok: false, note: e.message }));
    setChecks((c) => ({ ...c, [f.rel]: r }));
  };
  const checkAll = async () => { for (const f of items ?? []) await check(f); };
  const row = (f: SavedItem) => {
    const c = checks[f.rel];
    return (
      <div key={f.rel} className="tidy-row">
        <div className="tidy-row-main">
          <strong title={f.rel}>{f.name}</strong>
          <span className="muted">{bytes(f.size)}</span>
        </div>
        <div className="tidy-row-acts">
          {c && c !== 'busy' && <span className={'tidy-badge ' + (c.ok ? 'ok' : 'bad')} title={c.note}>{c.ok ? 'OK' : 'Issue'}</span>}
          <button type="button" className="btn ghost sm" disabled={c === 'busy'} onClick={() => check(f)}>{c === 'busy' ? '…' : 'Check'}</button>
          <button type="button" className="btn ghost sm danger" onClick={() => del(f)}>Delete</button>
        </div>
      </div>
    );
  };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog tidy-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Tidy saved videos">
        <div className="st-accent" aria-hidden="true" />
        <header className="st-head">
          <div>
            <h3>Tidy saved videos</h3>
            <p>Duplicates and health checks</p>
          </div>
          <button type="button" className="st-x" onClick={onClose} aria-label="Close"><Icon n="close" s={16} /></button>
        </header>
        <div className="tidy-body">
          {!items ? (
            <p className="muted">Looking…</p>
          ) : (
            <>
              <section className="look-block">
                <div className="look-block-h">
                  <h4>Possible duplicates</h4>
                  <p className="muted small">Same title saved more than once</p>
                </div>
                {dups.length ? dups.map((g, i) => (
                  <div key={i} className="tidy-group">{g.sort((a, b) => b.size - a.size).map(row)}</div>
                )) : (
                  <p className="st-empty">No video is saved twice.</p>
                )}
              </section>
              <section className="look-block">
                <div className="look-block-h tidy-health-h">
                  <div>
                    <h4>Health check</h4>
                    <p className="muted small">Matches server size and plays to the end</p>
                  </div>
                  {!!items.length && <button type="button" className="btn" onClick={checkAll}>Check all</button>}
                </div>
                {!items.length ? (
                  <p className="st-empty">Nothing is saved on this laptop yet.</p>
                ) : (
                  <div className="tidy-list">{items.map(row)}</div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- auto-save rules ---------------- */
type Rule = { id: string; rootName: string; dir: string; mode: 'new' | 'next3'; profile: string; on: boolean; label: string };
export function RulesBlock() {
  const [rules, setRules] = useState<Rule[]>([]);
  const load = () => api<{ items: Rule[] }>('dl/rules').then((d) => setRules(d.items)).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!rules.length) return null;
  return (
    <div className="sched">
      <div className="msec">Auto-save rules</div>
      {rules.map((r) => (
        <div key={r.id} className="sched-row">
          <span><b>{r.label || r.dir || r.rootName}</b><small>{r.mode === 'next3' ? 'Keeps the next 3 unwatched episodes' : 'Saves new episodes'} · {r.profile === 'orig' ? 'Original' : r.profile}{r.on ? '' : ' · paused'}</small></span>
          <span className="inline">
            <button className="btn ghost sm" onClick={async () => setRules((await post<{ items: Rule[] }>('dl/rules/toggle', { id: r.id })).items)}>{r.on ? 'Pause' : 'Resume'}</button>
            <button className="btn ghost sm danger" onClick={async () => { await api('dl/rules', { id: r.id }, 'DELETE'); load(); }}>Remove</button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function RuleDialog({ root, dir, label, onClose, onDone }: { root: number; dir: string; label: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [mode, setMode] = useState<'next3' | 'new'>('next3');
  const [profile, setProfile] = useState('orig');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true);
    try { await post('dl/rules', { root, dir, mode, profile, label }); onDone('Auto-save is on. Cinema checks every 15 minutes while it is running.'); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog de-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Auto-save">
        <div className="set-accent" aria-hidden="true" />
        <div className="dlg-head">
          <div>
            <h3>Auto-save</h3>
            <span className="dlg-sub">{label}</span>
          </div>
          <button className="icon set-close" onClick={onClose} aria-label="Close"><Icon n="close" /></button>
        </div>
        <button className={mode === 'next3' ? 'opt on' : 'opt'} onClick={() => setMode('next3')}><span><b>Keep the next 3 unwatched episodes</b><small>As you watch, the following episodes are saved to this laptop</small></span></button>
        <button className={mode === 'new' ? 'opt on' : 'opt'} onClick={() => setMode('new')}><span><b>Save new episodes</b><small>Anything added to this folder from now on</small></span></button>
        <div className="msec">Quality</div>
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          <option value="orig">Original</option><option value="h264-1080">1080p, H.264</option><option value="h264-720">720p, H.264</option><option value="h264-480">480p, H.264</option>
        </select>
        <p className="muted small">Runs while Cinema is open, or in the tray if “Start with Windows” is on.</p>
        {err && <p className="err-t">{err}</p>}
        <div className="dlg-actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy} onClick={go}>{busy ? 'Saving…' : 'Turn on'}</button></div>
      </div>
    </div>
  );
}

/* ---------------- Settings blocks ---------------- */
type RemoteInfo = { on: boolean; port: number; pin: string; running: boolean; urls: string[]; error: string };
export function RemoteBlock() {
  const [r, setR] = useState<RemoteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<RemoteInfo>('remote/info').then(setR).catch(() => {}); }, []);
  const cfg = async (b: object) => { setBusy(true); try { setR(await post<RemoteInfo>('remote/config', b)); } catch { /* shown by state */ } setBusy(false); };
  if (!r) return null;
  return (
    <div className="keybox">
      <span className="inline"><button className="btn" disabled={busy} onClick={() => cfg({ on: !r.running })}>{r.running ? 'Turn off' : 'Turn on'}</button>
        {r.running && <button className="btn ghost" disabled={busy} onClick={() => cfg({ newPin: true })}>New PIN</button>}</span>
      {r.error && <span className="kstat bad">✕ {r.error}</span>}
      {r.running && (
        <>
          <span className="kstat ok">✓ On. Open one of these on your phone, on the same Wi-Fi:</span>
          {r.urls.map((u) => <code key={u}>{u}</code>)}
          <span className="muted small">PIN: <code>{r.pin}</code>. Anyone on your network who knows the PIN can control playback and watch the current video. It is not encrypted, so use it only on a network you trust.</span>
        </>
      )}
    </div>
  );
}

export function ProfilesBlock() {
  const [p, setP] = useState<{ active: string; list: { id: string; name: string }[] } | null>(null);
  const [name, setName] = useState('');
  const load = () => api<typeof p>('profiles').then(setP).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!p) return null;
  const sw = async (id: string) => { await post('profiles/switch', { id }); location.reload(); };
  return (
    <div className="keybox">
      {p.list.map((x) => (
        <span key={x.id} className="inline spread">
          <span><b>{x.name}</b>{x.id === p.active ? <span className="kstat ok"> ✓ in use</span> : null}</span>
          <span className="inline">
            {x.id !== p.active && <button className="btn ghost sm" onClick={() => sw(x.id)}>Switch</button>}
            {x.id !== p.active && x.id !== 'default' && <button className="btn ghost sm danger" onClick={async () => { await api('profiles', { id: x.id }, 'DELETE'); load(); }}>Delete</button>}
          </span>
        </span>
      ))}
      <span className="inline"><input value={name} placeholder="New profile name" onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()} onClick={async () => { await post('profiles', { name }); setName(''); load(); }}>Add</button></span>
      <span className="muted small">Each profile keeps its own watch progress, favourites, playlists and collections. Servers and downloads are shared.</span>
    </div>
  );
}

export function BackupBlock({ clientSettings, restoreClient }: { clientSettings: object; restoreClient: (s: any) => void }) {
  const [msg, setMsg] = useState('');
  const exp = async () => {
    const b = await api<object>('backup');
    const blob = new Blob([JSON.stringify({ ...b, client: clientSettings }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `cinema-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); setMsg('Backup saved to your Downloads folder.');
  };
  const imp = async (f?: File) => {
    if (!f) return;
    try { const j = JSON.parse(await f.text()); await post('restore', j); if (j.client) restoreClient(j.client); setMsg('Restored. Reloading…'); setTimeout(() => location.reload(), 900); }
    catch (e: any) { setMsg(e.message || 'That file could not be read.'); }
  };
  return (
    <div className="keybox">
      <span className="inline"><button className="btn" onClick={exp}>Save a backup</button>
        <label className="btn ghost filebtn">Restore from file<input type="file" accept="application/json,.json" hidden onChange={(e) => imp(e.target.files?.[0])} /></label></span>
      {msg && <span className="kstat idle">{msg}</span>}
      <span className="muted small">Includes watch progress, favourites, playlists, collections, ratings, tags and your settings. API keys and server passwords are left out on purpose.</span>
    </div>
  );
}

/* ---------------- cast to a TV ---------------- */
type CastDev = { id: string; name: string; kind: 'cast' | 'dlna'; host: string; port: number; control?: string; render?: string };
type CastSt = { state: string; pos: number; dur: number; device: string; error?: string };
export function CastDialog({ title, stream, getPos, onStart, onClose }: { title: string; stream: string; getPos: () => number; onStart: () => void; onClose: () => void }) {
  const [devs, setDevs] = useState<CastDev[] | null>(null);
  const [st, setSt] = useState<CastSt | null | undefined>(undefined);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [vol, setVol] = useState(50);
  const scan = () => { setDevs(null); setErr(''); api<{ items: CastDev[] }>('cast/devices').then((d) => setDevs(d.items)).catch((e) => { setErr(e.message); setDevs([]); }); };
  useEffect(() => { api<{ status: CastSt | null }>('cast/status').then((d) => { setSt(d.status); if (!d.status) scan(); }).catch(() => { setSt(null); scan(); }); }, []);
  useEffect(() => {
    if (!st) return;
    const t = setInterval(() => api<{ status: CastSt | null }>('cast/status').then((d) => setSt(d.status)).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [!!st]); // eslint-disable-line react-hooks/exhaustive-deps
  const play = async (d: CastDev) => {
    setBusy(d.id); setErr('');
    try { await post('cast/play', { device: d, stream, title, start: getPos() }); onStart(); setSt({ state: 'loading', pos: 0, dur: 0, device: d.name }); }
    catch (e: any) { setErr(e.message); }
    setBusy('');
  };
  const ctl = (action: string, value?: number) => post('cast/control', { action, value }).catch((e) => setErr(e.message));
  const fmt = (x: number) => { x = Math.max(0, Math.floor(x)); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
  return (
    <div className="castbox de-cast" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Cast to a TV">
      <div className="castbox-h">
        <div>
          <b><Icon n="cast" s={16} /> Cast to a TV</b>
          <span className="dlg-sub">Same Wi‑Fi as this laptop</span>
        </div>
        <button className="cbtn sm" onClick={onClose} aria-label="Close"><Icon n="close" s={16} /></button>
      </div>
      {st ? (
        <div className="castctl">
          <span className="muted small">Playing on</span><b>{st.device}</b>
          <span className={'kstat ' + (st.state === 'error' ? 'bad' : 'ok')}>{st.state === 'loading' ? 'Starting…' : st.state === 'playing' ? 'Playing' : st.state === 'paused' ? 'Paused' : st.state === 'error' ? 'Problem' : 'Stopped'}</span>
          {st.error && <span className="kstat bad">{st.error}</span>}
          <input type="range" min={0} max={Math.max(1, Math.floor(st.dur))} value={Math.floor(st.pos)} onChange={(e) => ctl('seek', +e.target.value)} aria-label="Position" />
          <span className="muted small">{fmt(st.pos)} / {fmt(st.dur)}</span>
          <span className="inline"><button className="btn ghost" onClick={() => ctl('seek', Math.max(0, st.pos - 10))}>−10</button>
            <button className="btn" onClick={() => ctl(st.state === 'playing' ? 'pause' : 'play')}>{st.state === 'playing' ? 'Pause' : 'Play'}</button>
            <button className="btn ghost" onClick={() => ctl('seek', st.pos + 10)}>+10</button></span>
          <label className="small muted">TV volume <input type="range" min={0} max={100} value={vol} onChange={(e) => { setVol(+e.target.value); ctl('volume', +e.target.value); }} /></label>
          <span className="inline"><button className="btn ghost danger" onClick={async () => { await post('cast/stop', {}).catch(() => {}); setSt(null); scan(); }}>Stop casting</button></span>
        </div>
      ) : (
        <div className="castlist">
          {devs === null ? <p className="muted">Looking for TVs on your Wi-Fi…</p> : devs.length === 0 ? <p className="muted small">No TV found. Turn the TV on, put it on the same Wi-Fi as this laptop, and try again.</p> : devs.map((d) => (
            <button key={d.id} className="opt" disabled={!!busy} onClick={() => play(d)}><span><b>{busy === d.id ? 'Connecting…' : d.name}</b><small>{d.kind === 'cast' ? 'Chromecast / Google TV' : 'Smart TV (DLNA)'} · {d.host}</small></span></button>
          ))}
          {err && <span className="kstat bad">{err}</span>}
          <span className="inline"><button className="btn ghost" onClick={scan}>Scan again</button></span>
          <p className="muted small">The TV plays the file itself, so it must support the format. MP4 with H.264 works best. Windows may ask to allow Cinema through the firewall: say yes for private networks.</p>
        </div>
      )}
    </div>
  );
}