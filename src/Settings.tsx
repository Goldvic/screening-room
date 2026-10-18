import { ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { EQ_PRESETS } from './audio';
import {
  ACCENTS, APP_NAME, ASPECTS, Icon, LANGS, MAX_VOLS, Prog, QUALITIES, SAVER, SettingsCtx,
  api, bridge, bytes, mbps, post, rate, speedTest, turboOk, useUpdates, moveDownloads } from './lib';

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="field"><div><b>{label}</b>{hint && <small>{hint}</small>}</div><div className="field-c">{children}</div></div>
);
export const Toggle = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
  <button className="toggle" role="switch" aria-checked={on} aria-label={label} onClick={onClick}><i className={on ? 'sw on' : 'sw'} /></button>
);

function Updates() {
  const u = useUpdates();
  const [feed, setFeed] = useState('');
  const seeded = useRef(false);
  useEffect(() => { if (u && !seeded.current) { seeded.current = true; setFeed(u.feed); } }, [u]);
  if (!u || !bridge) return null;
  const busy = u.state === 'checking' || u.state === 'downloading';
  const status = !u.packaged ? 'Updates work in the installed app, not when running from the source code.'
    : u.state === 'checking' ? 'Checking…'
    : u.state === 'none' ? 'You have the newest version.'
    : u.state === 'available' ? `Version ${u.version} is available.`
    : u.state === 'downloading' ? `Downloading version ${u.version || ''}… ${u.percent}%`
    : u.state === 'ready' ? `Version ${u.version} is ready. It installs when you restart Cinema.`
    : u.state === 'error' ? u.error : u.feed ? 'Not checked yet.' : 'Enter the update address to turn updates on.';
  return (
    <section>
      <h4>Updates</h4>
      <Field label="Installed version"><span>{u.current}</span></Field>
      <Field label="Update address" hint="The web folder where you put the installer and latest.yml (for example on your VPS)">
        <input value={feed} placeholder="https://example.com/cinema/" autoComplete="off" onChange={(e) => setFeed(e.target.value)} onBlur={() => bridge!.updateConfig({ feed })} />
      </Field>
      <Field label="Check automatically" hint="A few seconds after start, then every 6 hours. Nothing is installed without you"><Toggle on={u.auto} label="Check automatically" onClick={() => bridge!.updateConfig({ auto: !u.auto })} /></Field>
      <p className={u.state === 'error' ? 'err-t' : 'muted small'} role="status">{status}</p>
      {u.state === 'downloading' && <i className="bar"><i style={{ width: `${u.percent}%` }} /></i>}
      <div className="dlg-actions spread">
        <span className="inline">
          <button className="btn ghost" disabled={busy || !u.packaged} onClick={async () => { await bridge!.updateConfig({ feed }); bridge!.updateCheck(); }}>Check now</button>
          {u.state === 'available' && <button className="btn" onClick={() => bridge!.updateDownload()}><Icon n="down" s={15} /> Download {u.version}</button>}
          {u.state === 'ready' && <button className="btn" onClick={() => bridge!.updateInstall()}>Restart and install</button>}
        </span>
      </div>
    </section>
  );
}

type Srv = {
  downloadDir: string; maxParallel: number; limitKBps: number; schedule: { on: boolean; from: string; to: string };
  budgetGB: number; autoDeleteDays: number; quotaGB: number; tmdbKey: string; osKey: string; osUser: string; hasOsPass: boolean;
};
type Tab = 'look' | 'play' | 'subs' | 'data' | 'offline' | 'app';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'look', label: 'Appearance', icon: 'eye' }, { id: 'play', label: 'Playback & sound', icon: 'play' },
  { id: 'subs', label: 'Subtitles', icon: 'cc' }, { id: 'data', label: 'Data & speed', icon: 'bolt' },
  { id: 'offline', label: 'Offline & downloads', icon: 'save' }, { id: 'app', label: 'App & servers', icon: 'server' },
];
const LIMITS = [0, 250, 500, 1000, 2000, 5000, 10000];

export default function SettingsDialog({ onClose, mode, prog, onStorage, onServers, onSaved }: {
  onClose: () => void; mode: string; prog: Record<string, Prog>; onStorage: () => void; onServers: () => void; onSaved: () => void;
}) {
  const { s, set } = useContext(SettingsCtx);
  const [tab, setTab] = useState<Tab>('look');
  const [moveMsg, setMoveMsg] = useState('');
  const [srv, setSrv] = useState<Srv | null>(null);
  const [osPass, setOsPass] = useState('');
  const [t, setT] = useState<{ running: boolean; live: number; res?: { avg: number; peak: number; bytes: number }; err?: string }>({ running: false, live: 0 });
  const ctl = useRef<AbortController>();
  useEffect(() => {
    api<Srv>('settings').then(setSrv).catch(() => {});
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); ctl.current?.abort(); };
  }, [onClose]);

  const patch = async (p: Record<string, unknown>) => {
    try { setSrv(await post<Srv>('settings', p)); onSaved(); } catch { /* shown by next load */ }
  };
  const local = (p: Partial<Srv>) => setSrv((x) => (x ? { ...x, ...p } : x));
  const run = async () => {
    ctl.current = new AbortController();
    setT({ running: true, live: 0 });
    try {
      const r = await speedTest(4, 128, (v) => setT((x) => ({ ...x, live: v })), ctl.current.signal);
      setT({ running: false, live: 0, res: r });
    } catch (e: any) { setT({ running: false, live: 0, err: e?.name === 'AbortError' ? 'Stopped' : e?.message }); }
  };
  const browse = async (what: 'player' | 'folder') => {
    if (!bridge) return;
    if (what === 'player') { const f = await bridge.selectFile(); if (f) set({ externalPlayer: f }); }
    else {
      const f = await bridge.selectFolder();
      if (f) { setMoveMsg('Moving…'); const e = await moveDownloads(f, setMoveMsg); setMoveMsg(e ?? 'Done. Your saved videos are in the new folder and still play offline.'); patch({}); }
    }
  };

  const seen = Object.values(prog);
  const hours = seen.reduce((a, p) => a + (p.watched && p.dur ? p.dur : p.pos), 0) / 3600;
  const finished = seen.filter((p) => p.watched).length;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog wide settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="dlg-head"><h3>Settings</h3><button className="icon" onClick={onClose} aria-label="Close settings"><Icon n="close" /></button></div>
        <div className="set-layout">
        <nav className="set-nav" aria-label="Settings sections">
          {TABS.map((x) => <button key={x.id} className={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}><Icon n={x.icon} s={16} /> {x.label}</button>)}
        </nav>
        <div className="set-body">

        {tab === 'look' && (
        <section>
          <h4>Look</h4>
          <Field label="Accent color">
            <span className="swatches">{Object.entries(ACCENTS).map(([name, c]) => (
              <button key={name} className={s.accent === name ? 'sw-c on' : 'sw-c'} style={{ background: c }} title={name} aria-label={name} onClick={() => set({ accent: name })} />
            ))}</span>
          </Field>
          <Field label="Theme">
            <span className="seg" role="group" aria-label="Theme">
              <button className={s.theme === 'dark' ? 'on' : ''} onClick={() => set({ theme: 'dark' })}>Dark</button>
              <button className={s.theme === 'light' ? 'on' : ''} onClick={() => set({ theme: 'light' })}>Light</button>
            </span>
          </Field>
          <Field label="Video thumbnails" hint="Made once on the server, then cached"><Toggle on={s.thumbs} label="Video thumbnails" onClick={() => set({ thumbs: !s.thumbs })} /></Field>
        </section>
        )}

        {tab === 'data' && (
        <section>
          <h4>Data Saver</h4>
          <p className="muted small">Lowers how much data streaming uses. It caps the quality that Auto may choose and squeezes the bitrate. It does not change Original playback or downloads.</p>
          <div className="seg-m" role="group" aria-label="Data Saver level">
            {SAVER.map((o) => <button key={o.id} className={s.saver === o.id ? 'on' : ''} onClick={() => set({ saver: o.id })}>{o.label}</button>)}
          </div>
          <p className="mnote">{SAVER[s.saver].hint}</p>
          <Field label="Monthly data budget" hint="0 means no limit. Counts streaming and downloads">
            <span className="inline"><input type="number" min={0} className="num" value={srv?.budgetGB ?? 0} onChange={(e) => local({ budgetGB: +e.target.value })} onBlur={() => patch({ budgetGB: srv?.budgetGB ?? 0 })} /> GB</span>
          </Field>
          <Field label="Switch to Low at 80% of the budget" hint="Automatically, until the month ends"><Toggle on={s.saverAuto} label="Auto Data Saver" onClick={() => set({ saverAuto: !s.saverAuto })} /></Field>
        </section>
        )}

        {tab === 'play' && (
        <section>
          <h4>Playback</h4>
          <Field label="Default quality">
            <select value={s.quality} onChange={(e) => set({ quality: e.target.value })}>{QUALITIES.filter((q) => q.id !== 'audio').map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select>
          </Field>
          <Field label="Default screen shape">
            <select value={s.aspect} onChange={(e) => set({ aspect: e.target.value })}>{ASPECTS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select>
          </Field>
          <Field label="Show “Skip intro”" hint="Only on episodes whose file has an intro or recap chapter"><Toggle on={s.skipIntro} label="Skip intro button" onClick={() => set({ skipIntro: !s.skipIntro })} /></Field>
          <Field label="Play next episode automatically"><Toggle on={s.autoNext} label="Autoplay next" onClick={() => set({ autoNext: !s.autoNext })} /></Field>
          <Field label="Download the next episode while I watch" hint="Saves it for offline in the background"><Toggle on={s.predownload} label="Pre-download next" onClick={() => set({ predownload: !s.predownload })} /></Field>
        </section>
        )}

        {tab === 'play' && (
        <section>
          <h4>Sound</h4>
          <Field label="Maximum volume" hint="How far the volume slider can go. Above 100% a limiter keeps it clean">
            <select value={s.maxVol} onChange={(e) => set({ maxVol: +e.target.value })}>{MAX_VOLS.map((v) => <option key={v} value={v}>{v}%</option>)}</select>
          </Field>
          <Field label="Remember boost above 100%" hint="Off: every time the app starts, volume goes back to 100% or lower to protect your ears">
            <Toggle on={s.rememberBoost} label="Remember boost" onClick={() => set({ rememberBoost: !s.rememberBoost })} />
          </Field>
          <Field label="Default equalizer">
            <select value={s.eqPreset} onChange={(e) => set({ eqPreset: e.target.value })}>{Object.keys(EQ_PRESETS).map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
        </section>
        )}

        {tab === 'subs' && (
        <section>
          <h4>Subtitles</h4>
          <Field label="Turn on subtitles automatically" hint="Picks a track in your language, inside the video or next to it">
            <Toggle on={s.autoSub} label="Auto subtitles" onClick={() => set({ autoSub: !s.autoSub })} />
          </Field>
          <Field label="Your language">
            <select value={s.subLang} onChange={(e) => set({ subLang: e.target.value })}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select>
          </Field>
          <Field label="Skip if the audio is already in that language"><Toggle on={s.subSmart} label="Skip when audio matches" onClick={() => set({ subSmart: !s.subSmart })} /></Field>
          <Field label="OpenSubtitles API key" hint="Free at opensubtitles.com. Lets you search subtitles inside the player">
            <input value={srv?.osKey ?? ''} onChange={(e) => local({ osKey: e.target.value })} onBlur={() => patch({ osKey: srv?.osKey ?? '' })} placeholder="API key" autoComplete="off" />
          </Field>
          <Field label="OpenSubtitles account" hint="Needed to download. Stored encrypted">
            <span className="stack">
              <input value={srv?.osUser ?? ''} onChange={(e) => local({ osUser: e.target.value })} onBlur={() => patch({ osUser: srv?.osUser ?? '' })} placeholder="Username" autoComplete="off" />
              <input type="password" value={osPass} onChange={(e) => setOsPass(e.target.value)} onBlur={() => { if (osPass) { patch({ osPass }); setOsPass(''); } }} placeholder={srv?.hasOsPass ? 'Password saved' : 'Password'} autoComplete="off" />
            </span>
          </Field>
        </section>
        )}

        {tab === 'look' && (
        <section>
          <h4>Library</h4>
          <Field label="TMDB key" hint="Free at themoviedb.org. Adds posters, ratings and descriptions">
            <input value={srv?.tmdbKey ?? ''} onChange={(e) => local({ tmdbKey: e.target.value })} onBlur={() => patch({ tmdbKey: srv?.tmdbKey ?? '' })} placeholder="API key or read token" autoComplete="off" />
          </Field>
          <Field label="Show posters instead of thumbnails" hint="Needs the TMDB key"><Toggle on={s.posters} label="Posters" onClick={() => set({ posters: !s.posters })} /></Field>
          <Field label="Watching so far"><span>{hours.toFixed(1)} hours · {finished} finished</span></Field>
        </section>
        )}

        {tab === 'offline' && (
        <section>
          <h4>Downloads and offline</h4>
          <Field label="Save downloads to" hint={moveMsg || `${srv?.downloadDir ?? ''}. Pick a folder on another drive to keep videos off your system drive; saved videos move with it.`}>
            <span className="inline">{bridge && <button className="btn ghost" onClick={() => browse('folder')}>Change…</button>}
              <button className="btn ghost" onClick={async () => { setMoveMsg('Moving…'); const e = await moveDownloads('vault', setMoveMsg); setMoveMsg(e ?? 'Done. Saved videos now live in a hidden folder inside the app’s own data, not in your Videos or Downloads.'); patch({}); }} title="Hidden, app-private folder">Private storage</button><button className="btn ghost" onClick={onStorage}><Icon n="hdd" s={15} /> Storage</button></span>
          </Field>
          <Field label="Save while I watch" hint="Keeps a full-quality copy on this laptop in the background, so next time it plays offline and uses no data">
            <Toggle on={s.autoCache} label="Save while watching" onClick={() => set({ autoCache: !s.autoCache })} />
          </Field>
          <Field label="Files at the same time">
            <select value={srv?.maxParallel ?? 2} onChange={(e) => patch({ maxParallel: +e.target.value })}>{[1, 2, 3, 4, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
          <Field label="Speed limit" hint="Keeps some bandwidth for other things">
            <select value={srv?.limitKBps ?? 0} onChange={(e) => patch({ limitKBps: +e.target.value })}>
              {LIMITS.map((n) => <option key={n} value={n}>{n ? rate(n * 1024) : 'No limit'}</option>)}
            </select>
          </Field>
          <Field label="Only download at night" hint="Downloads wait until the time window opens">
            <Toggle on={!!srv?.schedule.on} label="Schedule" onClick={() => patch({ schedule: { ...srv!.schedule, on: !srv?.schedule.on } })} />
          </Field>
          {srv?.schedule.on && (
            <Field label="Between">
              <span className="inline">
                <input type="time" value={srv.schedule.from} onChange={(e) => patch({ schedule: { ...srv.schedule, from: e.target.value } })} />
                and <input type="time" value={srv.schedule.to} onChange={(e) => patch({ schedule: { ...srv.schedule, to: e.target.value } })} />
              </span>
            </Field>
          )}
          <Field label="Space limit for saved videos" hint="When it is full, watched videos are removed first, then the oldest. Your copies on the server stay">
            <select value={srv?.quotaGB ?? 0} onChange={(e) => patch({ quotaGB: +e.target.value })}>
              <option value={0}>No limit</option>{[2, 5, 10, 20, 50].map((n) => <option key={n} value={n}>{n} GB</option>)}
            </select>
          </Field>
          <Field label="Delete watched downloads after" hint="Frees space automatically. Your copy on the server stays">
            <select value={srv?.autoDeleteDays ?? 0} onChange={(e) => patch({ autoDeleteDays: +e.target.value })}>
              <option value={0}>Never</option>{[1, 3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} day{n > 1 ? 's' : ''}</option>)}
            </select>
          </Field>
          {!bridge && (
            <>
              <Field label="Turbo browser download" hint={turboOk() ? 'Splits big files across several connections' : 'Needs Chrome, Edge or Opera over HTTPS (or localhost)'}>
                <Toggle on={s.turbo} label="Turbo download" onClick={() => set({ turbo: !s.turbo })} />
              </Field>
              <Field label="Connections per file"><select value={s.conns} onChange={(e) => set({ conns: +e.target.value })}>{[2, 4, 8, 12, 16].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
            </>
          )}
        </section>
        )}

        {bridge && tab === 'play' && (
          <section>
            <h4>Other players</h4>
            <Field label="Open in another player" hint="For example VLC. Leave empty to use your computer’s default player">
              <span className="inline"><input value={s.externalPlayer} onChange={(e) => set({ externalPlayer: e.target.value })} placeholder="C:\Program Files\VideoLAN\VLC\vlc.exe" /><button className="btn ghost" onClick={() => browse('player')}>Browse…</button></span>
            </Field>
          </section>
        )}

        {tab === 'app' && <Updates />}

        {tab === 'app' && (
        <section>
          <h4>Servers</h4>
          <Field label="Where your movies are stored"><button className="btn ghost" onClick={onServers}><Icon n="server" s={15} /> Manage servers</button></Field>
        </section>
        )}

        {tab === 'data' && (
        <section>
          <h4>Speed test</h4>
          <p className="muted small">Measures how fast your server can send data to this laptop. That number is the real limit for streaming and downloads. Server disk path: {mode === 'local' ? 'direct (fastest)' : mode && mode !== 'none' ? 'through SSH' : 'unknown'}.</p>
          <div className="test">
            <button className="btn" disabled={t.running} onClick={run}><Icon n="bolt" s={15} /> {t.running ? 'Testing…' : 'Run speed test'}</button>
            {t.running && <button className="btn ghost" onClick={() => ctl.current?.abort()}>Stop</button>}
            {t.running && <strong className="live-n">{rate(t.live)} <small>{mbps(t.live)}</small></strong>}
          </div>
          {t.res && <p>Average <b>{rate(t.res.avg)}</b> ({mbps(t.res.avg)}), peak <b>{mbps(t.res.peak)}</b>, {bytes(t.res.bytes)} transferred.</p>}
          {t.err && <p className="err-t">{t.err}</p>}
        </section>
        )}

        {tab === 'app' && <p className="muted small">{APP_NAME}{bridge ? ` ${bridge.version}` : ''}</p>}
        </div>
        </div>
      </div>
    </div>
  );
}