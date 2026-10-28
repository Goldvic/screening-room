import { RulesBlock } from './Extras';
import { useContext, useEffect, useMemo, useState } from 'react';
import { Caps, Icon, Info, SettingsCtx, api, bridge, bytes, canDecode, clock, moveDownloads, post, rate } from './lib';

// ------------------------------------------------------------------------------------------
//  Choose how to save something for offline watching
// ------------------------------------------------------------------------------------------
type Codec = 'auto' | 'h264' | 'hevc' | 'av1';
const KBPS: Record<string, Record<number, number>> = {
  h264: { 360: 450, 480: 800, 720: 1500, 1080: 3000 },
  hevc: { 360: 270, 480: 480, 720: 900, 1080: 1800 },
  av1: { 360: 225, 480: 400, 720: 750, 1080: 1500 },
};
const estimate = (profile: string, dur: number, size: number) => {
  if (profile === 'orig' || profile === 'fix') return size || 0;
  const [c, h] = profile.split('-');
  const kbps = (KBPS[c]?.[Number(h)] ?? 1000) + (Number(h) <= 480 ? 64 : 96);
  const e = (kbps * 1000 * dur) / 8;
  return size ? Math.min(size, e) : e;
};

// A folder has no single duration, so its estimate is a share of the original size, by size and codec.
const SHARE: Record<number, number> = { 1080: 0.55, 720: 0.3, 480: 0.16, 360: 0.1 };
const CODEC_SHARE: Record<string, number> = { h264: 1, hevc: 0.65, av1: 0.55 };
const estimateTotal = (profile: string, total: number) => {
  if (profile === 'orig') return total;
  if (profile === 'fix') return total * 0.99;
  const [c, h] = profile.split('-');
  return Math.min(total, total * (SHARE[Number(h)] ?? 0.3) * (CODEC_SHARE[c] ?? 1));
};

export function DownloadDialog(p: {
  root: number; paths: string[]; names: string[]; sizes: number; caps: Caps | null;
  onClose: () => void; onQueued: (n: number) => void; onScheduled?: (text: string) => void;
}) {
  const { s, set } = useContext(SettingsCtx);
  const [info, setInfo] = useState<Info | null>(null);
  const [codec, setCodec] = useState<Codec>('auto');
  const [profile, setProfile] = useState(s.dlProfile);
  const [loud, setLoud] = useState(s.dlLoud);
  const [dialogue, setDialogue] = useState(s.dlDialogue);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [when, setWhen] = useState<'now' | 'tonight' | 'custom'>('now');
  const tonight = () => { const d = new Date(); d.setHours(1, 0, 0, 0); if (d.getTime() < Date.now() + 60_000) d.setDate(d.getDate() + 1); return d; };
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [at, setAt] = useState(local(tonight()));
  const single = p.paths.length === 1 && /\.[a-z0-9]{2,4}$/i.test(p.paths[0]);
  const remote = p.caps?.remote;
  const lap = p.caps?.local.enc;
  const canEnc = !!remote?.ffmpeg || !!p.caps?.local.ffmpeg; // this laptop can compress when the server cannot
  const [tot, setTot] = useState<{ files: number; bytes: number } | null>(null);

  useEffect(() => {
    if (single) api<Info>('info', { root: p.root, path: p.paths[0] }).then(setInfo).catch(() => {});
    else post<{ files: number; bytes: number }>('dl/estimate', { root: p.root, paths: p.paths }).then(setTot).catch(() => {});
  }, [single, p.root, p.paths]);

  const ok = {
    h264: (!!remote?.h264 || !!lap?.h264 || (!lap && !!p.caps?.local.ffmpeg)) && canDecode('h264'),
    hevc: (!!remote?.hevc || !!lap?.hevc) && canDecode('hevc'),
    av1: (!!remote?.av1 || !!lap?.av1) && canDecode('av1'),
  };
  const best = ok.hevc ? 'hevc' : ok.h264 ? 'h264' : ok.av1 ? 'av1' : 'h264';
  const use = codec === 'auto' ? best : codec;
  const src = info?.height ?? 0;
  const dur = info?.duration ?? 0;
  const size = single ? info?.size ?? p.sizes : tot?.bytes ?? p.sizes;
  const files = single ? 1 : tot?.files ?? p.names.length;
  const estFor = (id: string) => (single ? estimate(id, dur, size) : size ? estimateTotal(id, size) : 0);
  const engine = lap?.hw ? `${lap.gpu} graphics on this laptop (fast)` : p.caps?.local.ffmpeg ? 'this laptop' : 'the server';

  const rows = useMemo(() => {
    const r: { id: string; label: string; hint: string }[] = [
      { id: 'orig', label: 'Original', hint: 'Exactly the file on the server. Biggest, but nothing is changed.' },
    ];
    if (canEnc) {
      r.push({ id: 'fix', label: 'Original, fixed audio', hint: 'Same picture, audio converted to AAC so it always has sound. Fast.' });
      const levels: [number, string, string][] = [[1080, 'Full HD, smaller file', 'Same sharpness, much smaller'], [720, 'Balanced (720p)', 'Great on a laptop screen'], [480, 'Small (480p)', 'Good for travel and small screens'], [360, 'Tiny (360p)', 'Smallest possible']];
      for (const [h, label, hint] of levels) if (!src || h <= src * 1.1) r.push({ id: `${use}-${h}`, label, hint });
    }
    return r;
  }, [canEnc, src, use]);

  // keep the chosen row valid when the codec changes
  useEffect(() => {
    if (/^(h264|hevc|av1)-/.test(profile)) {
      const h = profile.split('-')[1];
      if (!rows.some((x) => x.id === profile) && rows.some((x) => x.id === `${use}-${h}`)) setProfile(`${use}-${h}`);
    }
    if (!canEnc && profile !== 'orig') setProfile('orig');
  }, [use, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    setBusy(true); setErr('');
    const prof = profile === 'orig' && (loud || dialogue) ? 'fix' : profile;
    try {
      set({ dlProfile: profile, dlLoud: loud, dlDialogue: dialogue });
      if (when !== 'now') {
        const t = when === 'tonight' ? tonight() : new Date(at);
        await post('dl/schedule', { root: p.root, paths: p.paths, profile: prof, opts: { loud, dialogue }, at: t.getTime(), label: p.names.length === 1 ? p.names[0] : `${p.names.length} videos` });
        p.onScheduled?.(`Scheduled for ${t.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Keep the app running.`);
        return;
      }
      const r = await post<{ queued: number }>('dl/add', { root: p.root, paths: p.paths, profile: prof, opts: { loud, dialogue } });
      p.onQueued(r.queued);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="scrim" onClick={p.onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Save for offline">
        <div className="dlg-head"><h3>Save for offline</h3><button className="icon" onClick={p.onClose} aria-label="Close"><Icon n="close" /></button></div>
        <p className="muted small trunc">{p.names.length === 1 ? p.names[0] : files > p.names.length ? `${p.names.length} folder${p.names.length > 1 ? 's' : ''}, ${files} videos` : `${p.names.length} items`}{size ? ` · ${bytes(size)} original` : !single && !tot ? ' · counting…' : ''}{dur ? ` · ${clock(dur)}` : ''}{src ? ` · ${src}p` : ''}</p>
        {!canEnc && <p className="note">Neither the server nor this laptop has ffmpeg, so only the original file can be saved.</p>}
        {canEnc && profile !== 'orig' && <p className="muted small">Compressing on {engine}.</p>}
        <div className="plist" role="radiogroup" aria-label="Quality">
          {rows.map((o) => {
            const e = estFor(o.id);
            return (
              <button key={o.id} role="radio" aria-checked={profile === o.id} className={profile === o.id ? 'opt on' : 'opt'} onClick={() => setProfile(o.id)}>
                <span><b>{o.label}</b><small>{o.hint}</small></span>
                <span className="est">{e ? `${single ? 'about ' : 'about ' }${bytes(e)}` : ''}{profile === o.id && <Icon n="check" s={16} />}</span>
              </button>
            );
          })}
        </div>
        {size > 0 && <p className="sumline">Total: <b>{bytes(estFor(profile))}</b>{profile !== 'orig' && <span className="muted"> instead of {bytes(size)}</span>}{files > 1 ? <span className="muted"> · {files} videos</span> : null}</p>}
        {canEnc && (
          <>
            <div className="msec">Sound</div>
            <label className="chk"><input type="checkbox" checked={dialogue} onChange={(e) => setDialogue(e.target.checked)} /><span><b>Louder, clearer voices</b><small>Mixes 5.1 down to stereo with the dialogue lifted</small></span></label>
            <label className="chk"><input type="checkbox" checked={loud} onChange={(e) => setLoud(e.target.checked)} /><span><b>Even, louder sound</b><small>Evens out quiet and loud parts so the whole movie plays at a comfortable level</small></span></label>
            {(loud || dialogue) && profile === 'orig' && <p className="mnote">Sound options need the audio re-made, so this saves “Original, fixed audio”.</p>}
            <div className="msec">Format</div>
            <div className="seg-m" role="group" aria-label="Video format">
              {(['auto', 'h264', 'hevc', 'av1'] as Codec[]).map((c) => (
                <button key={c} className={codec === c ? 'on' : ''} disabled={c !== 'auto' && !ok[c]} onClick={() => setCodec(c)}
                  title={c !== 'auto' && !ok[c] ? (remote?.[c] ? 'This laptop cannot play it' : 'The server cannot make it') : ''}>
                  {c === 'auto' ? 'Best' : c === 'h264' ? 'H.264' : c === 'hevc' ? 'HEVC' : 'AV1'}
                </button>
              ))}
            </div>
            <p className="mnote">
              {use === 'hevc' ? 'HEVC makes files about 40% smaller than H.264.' : use === 'av1' ? 'AV1 makes the smallest files but takes the server longest.' : 'H.264 plays everywhere.'}
              {' '}Compressing happens once on your server, then only the small file is downloaded. A full movie can take from several minutes to an hour depending on the server.
            </p>
          </>
        )}
        <div className="msec">When</div>
        <div className="seg-m" role="group" aria-label="When to download">
          <button className={when === 'now' ? 'on' : ''} onClick={() => setWhen('now')}>Now</button>
          <button className={when === 'tonight' ? 'on' : ''} onClick={() => setWhen('tonight')}>Tonight 01:00</button>
          <button className={when === 'custom' ? 'on' : ''} onClick={() => setWhen('custom')}>Pick a time</button>
        </div>
        {when === 'custom' && <input type="datetime-local" value={at} min={local(new Date())} onChange={(e) => setAt(e.target.value)} />}
        {when !== 'now' && <p className="mnote">Screening Room starts these by itself at that time. It only needs to be running (it can sit minimized).</p>}
        {err && <p className="err-t">{err}</p>}
        {/ffmpeg/i.test(err) && profile !== 'orig' && <button className="btn ghost" onClick={() => { setProfile('orig'); setErr(''); }}>Download the original instead</button>}
        <div className="dlg-actions"><button className="btn ghost" onClick={p.onClose}>Cancel</button>
          <button className="btn" onClick={go} disabled={busy}><Icon n="down" s={15} /> {busy ? 'Adding…' : when !== 'now' ? 'Schedule' : p.names.length === 1 && single ? 'Download' : 'Download all'}</button></div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
//  The download queue
// ------------------------------------------------------------------------------------------
type Item = {
  id: string; name: string; dest: string; size: number; done: number; speed: number; eta: number;
  state: 'queued' | 'encoding' | 'downloading' | 'finalizing' | 'paused' | 'done' | 'error' | 'cancelled';
  error?: string; reason?: string; profile: string; encPct: number;
};
type Queue = { items: Item[]; speed: number; active: number; waiting: number; month: number; budgetGB: number };
const eta = (s: number) => (!s || !isFinite(s) ? '' : s > 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left` : s > 60 ? `${Math.round(s / 60)} min left` : `${Math.ceil(s)} s left`);

export function DownloadsPanel({ onClose, onPlay, onStorage }: { onClose: () => void; onPlay: (destRel: string) => void; onStorage: () => void }) {
  const [q, setQ] = useState<Queue | null>(null);
  const [sched, setSched] = useState<{ id: string; at: number; label: string; count: number }[]>([]);
  const loadSched = () => api<{ items: { id: string; at: number; label: string; count: number }[] }>('dl/schedules').then((d) => setSched(d.items)).catch(() => {});
  useEffect(() => { loadSched(); const t = setInterval(loadSched, 15000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let dead = false;
    const tick = () => api<Queue>('dl').then((j) => { if (!dead) setQ(j); }).catch(() => {});
    tick();
    const t = setInterval(() => { if (!document.hidden) tick(); }, 1500);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => { dead = true; clearInterval(t); window.removeEventListener('keydown', k); };
  }, [onClose]);
  const act = (a: string, id: string) => post(`dl/${a}`, { id }).catch(() => {});
  const all = (a: string) => post('dl/all', { action: a }).catch(() => {});

  const items = q?.items ?? [];
  const live = items.filter((i) => ['encoding', 'downloading', 'finalizing'].includes(i.state));
  const wait = items.filter((i) => ['queued', 'paused', 'error'].includes(i.state));
  const fin = items.filter((i) => ['done', 'cancelled'].includes(i.state)).reverse();
  const status = (i: Item) => {
    if (i.state === 'encoding') return `Compressing on the server… ${Math.round(i.encPct)}%`;
    if (i.state === 'downloading') return `${bytes(i.done)} of ${bytes(i.size)} · ${rate(i.speed)} · ${eta(i.eta)}`;
    if (i.state === 'finalizing') return 'Saving thumbnails and subtitles…';
    if (i.state === 'queued') return i.reason ?? 'Waiting for a free slot';
    if (i.state === 'paused') return `Paused at ${bytes(i.done)}`;
    if (i.state === 'error') return i.error ?? 'Failed';
    if (i.state === 'cancelled') return 'Cancelled';
    return `${i.reason ?? 'Saved'} · ${bytes(i.size)}`;
  };
  const pct = (i: Item) => (i.state === 'encoding' ? i.encPct : i.size ? (i.done / i.size) * 100 : 0);
  const Row = ({ i }: { i: Item }) => (
    <div className={'dl-row ' + i.state}>
      <div className="dl-main">
        <strong title={i.dest}>{i.dest.split('/').pop()}</strong>
        <span className={'small ' + (i.state === 'error' ? 'err-t' : 'muted')}>{status(i)}</span>
        {['encoding', 'downloading', 'finalizing', 'paused', 'queued'].includes(i.state) && <i className="bar"><i style={{ width: `${pct(i)}%` }} className={i.state === 'encoding' ? 'enc' : ''} /></i>}
      </div>
      <div className="dl-act">
        {i.state === 'done' && <button className="btn" onClick={() => onPlay(i.dest)}><Icon n="play" s={14} /> Play</button>}
        {['encoding', 'downloading'].includes(i.state) && <button className="icon" onClick={() => act('pause', i.id)} aria-label="Pause"><Icon n="pause2" s={18} /></button>}
        {['paused', 'error', 'cancelled'].includes(i.state) && <button className="icon" onClick={() => act('resume', i.id)} aria-label={i.state === 'error' ? 'Retry' : 'Resume'}><Icon n="play" s={18} /></button>}
        {i.state === 'queued' && i.reason && <button className="btn ghost" onClick={() => act('start', i.id)}>Start now</button>}
        {['queued', 'encoding', 'downloading', 'paused'].includes(i.state) && <button className="icon" onClick={() => act('cancel', i.id)} aria-label="Cancel"><Icon n="close" s={18} /></button>}
        {['done', 'cancelled', 'error'].includes(i.state) && <button className="icon" onClick={() => act('remove', i.id)} aria-label="Remove from list"><Icon n="trash" s={16} /></button>}
      </div>
    </div>
  );

  return (
    <div className="scrim side" onClick={onClose}>
      <aside className="drawer de-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Downloads">
        <div className="drawer-accent" aria-hidden="true" />
        <div className="dlg-head">
          <div>
            <h3>Downloads</h3>
            <span className="dlg-sub">Queue, scheduled and finished</span>
          </div>
          <button className="icon set-close" onClick={onClose} aria-label="Close"><Icon n="close" /></button>
        </div>
        <RulesBlock />
        {sched.length > 0 && (
          <div className="sched">
            <div className="msec">Scheduled</div>
            {sched.map((x) => (
              <div key={x.id} className="sched-row">
                <span><b>{x.label || `${x.count} videos`}</b><small>{new Date(x.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></span>
                <button className="btn ghost" onClick={async () => { await api('dl/schedule', { id: x.id }, 'DELETE').catch(() => {}); loadSched(); }}>Cancel</button>
              </div>
            ))}
          </div>
        )}
        <div className="dl-top">
          <span><b>{rate(q?.speed ?? 0)}</b> <small className="muted">{live.length} active · {q?.waiting ?? 0} waiting</small></span>
          <span className="inline">
            <button className="btn ghost" onClick={() => all('pause')}>Pause all</button>
            <button className="btn ghost" onClick={() => all('resume')}>Resume all</button>
            <button className="btn ghost" onClick={() => all('clear')}>Clear finished</button>
          </span>
        </div>
        {q && q.budgetGB > 0 && (
          <div className="budget"><span className="small">Data this month: {bytes(q.month)} of {q.budgetGB} GB</span>
            <i className="bar"><i style={{ width: `${Math.min(100, (q.month / (q.budgetGB * 1e9)) * 100)}%` }} className={q.month > q.budgetGB * 0.8e9 ? 'enc' : ''} /></i></div>
        )}
        {!items.length && <p className="muted pad">Nothing here yet. Use “Save for offline” on a movie or folder.</p>}
        {live.map((i) => <Row key={i.id} i={i} />)}
        {wait.map((i) => <Row key={i.id} i={i} />)}
        {fin.map((i) => <Row key={i.id} i={i} />)}
        <div className="dlg-actions"><button className="btn ghost" onClick={onStorage}><Icon n="hdd" s={15} /> Storage</button></div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
//  Storage manager
// ------------------------------------------------------------------------------------------
type Store = {
  dir: string; used: number; free: number; total: number;
  items: { rel: string; name: string; size: number; watched: boolean; pos: number; dur: number }[];
  caches: { thumbs: number; sprites: number; posters: number; meta: number };
};

export function StoragePanel({ onClose, onPlay, onChanged }: { onClose: () => void; onPlay: (rel: string) => void; onChanged: () => void }) {
  const [d, setD] = useState<Store | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<Store>('storage').then(setD).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const del = async (rel: string) => {
    if (!window.confirm(`Delete “${rel.split('/').pop()}” from this laptop? The copy on your server is not touched.`)) return;
    await api('item', { root: 1000, path: rel }, 'DELETE').catch((e) => setErr(e.message));
    await load(); onChanged();
  };
  const clear = async (what: string) => {
    const r = await post<{ removed?: number }>('storage/clear', { what }).catch((e) => { setErr(e.message); return null; });
    if (r) setMsg(what === 'watched' ? `Removed ${r.removed ?? 0} watched ${r.removed === 1 ? 'video' : 'videos'}` : 'Cleared');
    await load(); onChanged();
  };
  const move = async () => {
    const f = await bridge?.selectFolder();
    if (!f) return;
    setMsg('Moving…');
    const e = await moveDownloads(f, setMsg);
    if (e) { setErr(e); setMsg(''); } else setMsg('Done. Your saved videos moved to the new folder and still play offline.');
    await load(); onChanged();
  };
  const watched = d?.items.filter((i) => i.watched) ?? [];
  const cache = d ? d.caches.thumbs + d.caches.sprites + d.caches.posters : 0;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog wide de-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Storage">
        <div className="set-accent" aria-hidden="true" />
        <div className="dlg-head">
          <div>
            <h3>Storage</h3>
            <span className="dlg-sub">Saved copies on this laptop</span>
          </div>
          <button className="icon set-close" onClick={onClose} aria-label="Close"><Icon n="close" /></button>
        </div>
        {err && <p className="err-t">{err}</p>}
        {d && (
          <>
            <p className="small muted trunc" title={d.dir}>{d.dir}</p>
            <i className="bar big"><i style={{ width: `${d.total ? Math.min(100, (d.used / d.total) * 100) : 0}%` }} /></i>
            <p className="small"><b>{bytes(d.used)}</b> used by downloads · {bytes(d.free)} free of {bytes(d.total)}</p>
            <div className="dlg-actions spread">
              <span className="inline">
                {bridge && <button className="btn ghost" onClick={() => bridge?.openFolder(d.dir)}>Open folder</button>}
                {bridge && <button className="btn ghost" onClick={move}>Change folder…</button>}
              </span>
              <button className="btn ghost" disabled={!watched.length} onClick={() => window.confirm(`Delete ${watched.length} watched video(s) from this laptop?`) && clear('watched')}>
                Delete all watched ({bytes(watched.reduce((s, i) => s + i.size, 0))})
              </button>
            </div>
            {msg && <p className="note good">{msg}</p>}
            <div className="msec">Downloads, largest first</div>
            <div className="st-list">
              {!d.items.length && <p className="muted pad">No downloads yet.</p>}
              {d.items.map((i) => (
                <div key={i.rel} className="st-row">
                  <div className="dl-main"><strong title={i.rel}>{i.name}</strong>
                    <span className="small muted">{bytes(i.size)}{i.watched ? ' · watched' : i.pos > 30 && i.dur ? ` · ${Math.round((i.pos / i.dur) * 100)}% watched` : ''}</span></div>
                  <button className="icon" onClick={() => onPlay(i.rel)} aria-label={`Play ${i.name}`}><Icon n="play" s={16} /></button>
                  <button className="icon danger" onClick={() => del(i.rel)} aria-label={`Delete ${i.name}`}><Icon n="trash" s={16} /></button>
                </div>
              ))}
            </div>
            <div className="msec">Temporary data</div>
            <div className="dlg-actions spread">
              <span className="small muted">Thumbnails, previews and posters: {bytes(cache)}. They are rebuilt when needed.</span>
              <button className="btn ghost" disabled={!cache} onClick={() => clear('all')}>Clear</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}