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
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add to collection">
        <h3>Add {count} video{count > 1 ? 's' : ''} to a collection</h3>
        <div className="pickl">{cols.map((c) => <button key={c.id} className="opt" onClick={() => onPick(c.id)}><span><b>{c.name}</b><small>{c.items.length} videos</small></span></button>)}</div>
        <div className="msec">Or make a new one</div>
        <span className="inline"><input autoFocus value={name} placeholder="Collection name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onPick('new', name.trim())} />
          <button className="btn" disabled={!name.trim()} onClick={() => onPick('new', name.trim())}>Create</button></span>
        <div className="dlg-actions"><button className="btn ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}

/* ---------------- home layout ---------------- */
export type HomeRow = { id: string; label: string; on: boolean };
export function HomeCustomize({ rows, onChange, onClose }: { rows: HomeRow[]; onChange: (r: HomeRow[]) => void; onClose: () => void }) {
  const move = (i: number, d: -1 | 1) => { const r = [...rows]; [r[i], r[i + d]] = [r[i + d], r[i]]; onChange(r); };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Customise Home">
        <h3>Customise Home</h3>
        <p className="muted small">Choose which rows show and in what order.</p>
        <ol className="rowlist">
          {rows.map((r, i) => (
            <li key={r.id}>
              <label><input type="checkbox" checked={r.on} onChange={() => onChange(rows.map((x) => (x.id === r.id ? { ...x, on: !x.on } : x)))} /> {r.label}</label>
              <span className="inline">
                <button className="icon sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon n="back" s={14} /></button>
                <button className="icon sm flipv" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon n="back" s={14} /></button>
              </span>
            </li>
          ))}
        </ol>
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
      <div className="dialog tour" role="dialog" aria-label="Welcome tour">
        <span className="tour-ic"><Icon n={st.i} s={30} /></span>
        <h3>{st.t}</h3><p className="muted">{st.d}</p>
        <div className="tour-dots">{STEPS.map((_, i) => <i key={i} className={i === n ? 'on' : ''} />)}</div>
        <div className="dlg-actions"><button className="btn ghost" onClick={onDone}>Skip</button>
          <button className="btn" onClick={() => (n === STEPS.length - 1 ? onDone() : setN(n + 1))}>{n === STEPS.length - 1 ? 'Start' : 'Next'}</button></div>
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
      <li key={f.rel}>
        <span className="pl-n" title={f.rel}>{f.name}</span><span className="muted small">{bytes(f.size)}</span>
        <span className="inline">
          {c && c !== 'busy' && <span className={'kstat ' + (c.ok ? 'ok' : 'bad')} title={c.note}>{c.ok ? '✓ OK' : '✕ Problem'}</span>}
          <button className="btn ghost sm" disabled={c === 'busy'} onClick={() => check(f)}>{c === 'busy' ? '…' : 'Check'}</button>
          <button className="btn ghost sm danger" onClick={() => del(f)}>Delete</button>
        </span>
      </li>
    );
  };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Tidy saved videos">
        <div className="dlg-head"><h3>Tidy saved videos</h3><button className="icon" onClick={onClose} aria-label="Close"><Icon n="close" /></button></div>
        {!items ? <p className="muted">Looking…</p> : (
          <>
            <div className="msec">Possible duplicates</div>
            {dups.length ? dups.map((g, i) => <ul key={i} className="dupg">{g.sort((a, b) => b.size - a.size).map(row)}</ul>) : <p className="muted small">No video is saved twice.</p>}
            <div className="msec">Health check <button className="btn ghost sm" onClick={checkAll}>Check all</button></div>
            <p className="muted small">Checks that each saved copy matches the server’s size and plays to the end.</p>
            <ul className="dupg">{items.map(row)}</ul>
            {!items.length && <p className="muted small">Nothing is saved on this laptop yet.</p>}
          </>
        )}
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
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Auto-save">
        <h3>Auto-save “{label}”</h3>
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