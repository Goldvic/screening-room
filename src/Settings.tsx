import { ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { EQ_PRESETS } from './audio';
import { BackupBlock, ProfilesBlock, RemoteBlock } from './Extras';
import {
  Caps, ACCENTS, APP_NAME, ASPECTS, Icon, LANGS, MAX_VOLS, Prog, QUALITIES, SAVER, SettingsCtx,
  api, bridge, bytes, mbps, post, rate, speedTest, turboOk, useUpdates, moveDownloads } from './lib';

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="field"><div><b>{label}</b>{hint && <small>{hint}</small>}</div><div className="field-c">{children}</div></div>
);
export const Toggle = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
  <button className="toggle" role="switch" aria-checked={on} aria-label={label} onClick={onClick}><i className={on ? 'sw on' : 'sw'} /></button>
);

function ServerTools() {
  const [c, setC] = useState<Caps | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => { setBusy(true); api<Caps>('caps', refresh ? { refresh: 1 } : {}).then(setC).catch(() => {}).finally(() => setBusy(false)); };
  useEffect(() => { load(); }, []);
  if (!c || !c.hasServer) return null;
  const ok = c.remote.ffmpeg;
  return (
    <section>
      <h4>Server tools</h4>
      <Field label="ffmpeg on the server" hint={ok ? 'Found. Compressed downloads and the quality menu can work.' : 'Not found. Compressed downloads and the quality menu need it. Original downloads still work.'}>
        <span className={'kstat ' + (ok ? 'ok' : 'bad')}>{ok ? '✓ Installed' : '✕ Missing'}</span>
      </Field>
      {!ok && <p className="mnote">Run this on your server over SSH, then press Check again:<br /><code>sudo apt update &amp;&amp; sudo apt install -y ffmpeg</code></p>}
      <Field label="ffmpeg on this laptop"><span className={'kstat ' + (c.local.ffmpeg ? 'ok' : 'bad')}>{c.local.ffmpeg ? '✓ Built in' : '✕ Missing'}</span></Field>
      <div className="dlg-actions"><button className="btn ghost" disabled={busy} onClick={() => load(true)}>{busy ? 'Checking…' : 'Check again'}</button></div>
    </section>
  );
}

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
      <Field label="Update address" hint="Paste your GitHub repository link (it must be public). A web folder with latest.yml also works">
        <input value={feed} placeholder="https://github.com/you/screening-room" autoComplete="off" onChange={(e) => setFeed(e.target.value)} onBlur={() => bridge!.updateConfig({ feed })} />
      </Field>
      <Field label="Check automatically" hint="Checks every few hours and downloads new versions quietly in the background. They install when you close Cinema"><Toggle on={u.auto} label="Check automatically" onClick={() => bridge!.updateConfig({ auto: !u.auto })} /></Field>
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
  budgetGB: number; autoDeleteDays: number; quotaGB: number; pauseOnBattery: boolean; pauseOnMetered: boolean; limitWin: { on: boolean; from: string; to: string; kbps: number }; encodeWhere: 'auto' | 'laptop' | 'server'; encodeSpeed: 'fast' | 'balanced' | 'small'; tmdbKey: string; osKey: string; osUser: string; hasOsPass: boolean;
};
const PRESETS = [
  { id: 'default', name: 'Graphite', c: '#131318' }, { id: 'midnight', name: 'Midnight', c: '#0f1a33' }, { id: 'oled', name: 'OLED black', c: '#000000' },
  { id: 'warm', name: 'Warm', c: '#2a1d14' }, { id: 'forest', name: 'Forest', c: '#0f2219' }, { id: 'paper', name: 'Paper (light)', c: '#f1f1f5' },
];
type Tab = 'look' | 'play' | 'subs' | 'data' | 'offline' | 'app';
const TABS: { id: Tab; label: string; icon: string; hint: string }[] = [
  { id: 'look', label: 'Appearance', icon: 'eye', hint: 'Accent, theme, compact mode, thumbnails' },
  { id: 'play', label: 'Playback & sound', icon: 'play', hint: 'Quality, volume, skip keys, autoplay' },
  { id: 'subs', label: 'Subtitles', icon: 'cc', hint: 'Size, colour, background' },
  { id: 'data', label: 'Data & speed', icon: 'bolt', hint: 'Budget, Data Saver, network test' },
  { id: 'offline', label: 'Offline & downloads', icon: 'save', hint: 'Profiles, auto-save, folder' },
  { id: 'app', label: 'App & servers', icon: 'server', hint: 'Servers, TMDB, profiles, about' },
];
const LIMITS = [0, 250, 500, 1000, 2000, 5000, 10000];


const SEARCH_INDEX: { tab: Tab; label: string; hint: string }[] = [
{
"tab": "look",
"label": "Accent color",
"hint": ""
},
{
"tab": "look",
"label": "Theme",
"hint": ""
},
{
"tab": "look",
"label": "Colour style",
"hint": ""
},
{
"tab": "look",
"label": "Custom accent colour",
"hint": "Overrides the accent colour above"
},
{
"tab": "look",
"label": "Compact mode",
"hint": "Tighter spacing, good for small screens"
},
{
"tab": "look",
"label": "Video thumbnails",
"hint": "Made once on the server, then cached"
},
{
"tab": "data",
"label": "Monthly data budget",
"hint": "0 means no limit. Counts streaming and downloads"
},
{
"tab": "data",
"label": "Switch to Low at 80% of the budget",
"hint": "Automatically, until the month ends"
},
{
"tab": "play",
"label": "Default quality",
"hint": ""
},
{
"tab": "play",
"label": "Default screen shape",
"hint": ""
},
{
"tab": "play",
"label": "Power saving",
"hint": "Lowers the video quality cap and turns off blur and animations to save battery"
},
{
"tab": "play",
"label": "Detect intros automatically",
"hint": "Finds the opening music by comparing episodes. Reads about 7 minutes of 3 videos once per episode, so it uses some data on a server"
},
{
"tab": "play",
"label": "Show \u201cSkip intro",
"hint": "Only on episodes whose file has an intro or recap chapter"
},
{
"tab": "play",
"label": "Play next episode automatically",
"hint": ""
},
{
"tab": "play",
"label": "Download the next episode while I watch",
"hint": "Saves it for offline in the background"
},
{
"tab": "play",
"label": "Maximum volume",
"hint": "How far the volume slider can go. Above 100% a limiter keeps it clean"
},
{
"tab": "play",
"label": "Remember boost above 100%",
"hint": "Off: every time the app starts, volume goes back to 100% or lower to protect your ears"
},
{
"tab": "play",
"label": "Default equalizer",
"hint": ""
},
{
"tab": "subs",
"label": "Turn on subtitles automatically",
"hint": "Picks a track in your language, inside the video or next to it"
},
{
"tab": "subs",
"label": "Your language",
"hint": ""
},
{
"tab": "subs",
"label": "Subtitle size",
"hint": ""
},
{
"tab": "subs",
"label": "Subtitle colour",
"hint": ""
},
{
"tab": "subs",
"label": "Subtitle background",
"hint": "How dark the box behind the words is"
},
{
"tab": "subs",
"label": "Subtitle outline",
"hint": ""
},
{
"tab": "subs",
"label": "Subtitle position",
"hint": "Distance from the bottom of the picture"
},
{
"tab": "subs",
"label": "Skip if the audio is already in that language",
"hint": ""
},
{
"tab": "subs",
"label": "OpenSubtitles",
"hint": "Free key at opensubtitles.com. The account is only needed to download. Stored encrypted on this computer"
},
{
"tab": "look",
"label": "TMDB key",
"hint": "Free at themoviedb.org. Adds posters, ratings and descriptions"
},
{
"tab": "look",
"label": "Show posters instead of thumbnails",
"hint": "Needs the TMDB key"
},
{
"tab": "look",
"label": "Watching so far",
"hint": ""
},
{
"tab": "offline",
"label": "Save downloads to",
"hint": ""
},
{
"tab": "offline",
"label": "Save while I watch",
"hint": "Keeps a full-quality copy on this laptop in the background, so next time it plays offline and uses no data"
},
{
"tab": "offline",
"label": "Files at the same time",
"hint": ""
},
{
"tab": "offline",
"label": "Speed limit",
"hint": "Keeps some bandwidth for other things"
},
{
"tab": "offline",
"label": "Only download at night",
"hint": "Downloads wait until the time window opens"
},
{
"tab": "offline",
"label": "Between",
"hint": ""
},
{
"tab": "offline",
"label": "Tidy saved videos",
"hint": "Find duplicates and check that saved copies are not broken"
},
{
"tab": "offline",
"label": "Pause on battery",
"hint": "Downloads wait until the laptop is plugged in"
},
{
"tab": "offline",
"label": "Slow down at certain hours",
"hint": "Limit the download speed between two times, for example while you work"
},
{
"tab": "offline",
"label": "Compress on",
"hint": "A laptop with an NVIDIA, Intel or AMD graphics chip compresses many times faster than a server. Auto picks the quickest"
},
{
"tab": "offline",
"label": "Compression speed",
"hint": "Fastest makes slightly bigger files. Smallest takes longer"
},
{
"tab": "offline",
"label": "Space limit for saved videos",
"hint": "When it is full, watched videos are removed first, then the oldest. Your copies on the server stay"
},
{
"tab": "offline",
"label": "Delete watched downloads after",
"hint": "Frees space automatically. Your copy on the server stays"
},
{
"tab": "offline",
"label": "Turbo browser download",
"hint": ""
},
{
"tab": "offline",
"label": "Connections per file",
"hint": ""
},
{
"tab": "play",
"label": "Open in another player",
"hint": "For example VLC. Leave empty to use your computer\u2019s default player"
},
{
"tab": "app",
"label": "Open Cinema when I sign in",
"hint": "It starts quietly in the tray and closes itself again unless a scheduled download or auto-save rule needs it"
},
{
"tab": "app",
"label": "Control playback from your phone",
"hint": "Also lets a phone or smart TV browser watch what is playing"
},
{
"tab": "app",
"label": "Where your movies are stored",
"hint": ""
}
];

function SearchResults({ q, onPick }: { q: string; onPick: (t: Tab) => void }) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = SEARCH_INDEX.filter((f) => words.every((w) => `${f.label} ${f.hint}`.toLowerCase().includes(w))).slice(0, 14);
  return (
    <section className="sres">
      <h4>{hits.length ? 'Matching settings' : 'Nothing matches'}</h4>
      {hits.map((f, i) => <button key={i} className="opt" onClick={() => onPick(f.tab)}><span><b>{f.label}</b><small>{TABS.find((t) => t.id === f.tab)?.label}{f.hint ? ` · ${f.hint}` : ''}</small></span></button>)}
    </section>
  );
}

export default function SettingsDialog({ onClose, mode, prog, onStorage, onServers, onSaved, onTidy }: {
  onClose: () => void; mode: string; prog: Record<string, Prog>; onStorage: () => void; onServers: () => void; onSaved: () => void; onTidy: () => void;
}) {
  const { s, set } = useContext(SettingsCtx);
  const [tab, setTab] = useState<Tab | null>(null);
  const [moveMsg, setMoveMsg] = useState('');
  const [q, setQ] = useState('');
  const [login, setLogin] = useState(false);
  useEffect(() => { bridge?.loginItemGet?.().then(setLogin).catch(() => {}); }, []);
  const cur = q ? '' : (tab ?? '');
  const [kd, setKd] = useState({ tmdb: '', os: '', user: '' });
  const [kMsg, setKMsg] = useState<Record<string, { ok: boolean; text: string } | undefined>>({});
  const [kBusy, setKBusy] = useState('');
  const kSeed = useRef(false);
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
  useEffect(() => { if (srv && !kSeed.current) { kSeed.current = true; setKd({ tmdb: srv.tmdbKey ?? '', os: srv.osKey ?? '', user: srv.osUser ?? '' }); } }, [srv]);
  const saveTest = async (kind: 'tmdb' | 'os') => {
    setKBusy(kind); setKMsg((m) => ({ ...m, [kind]: undefined }));
    try {
      await post<Srv>('settings', kind === 'tmdb' ? { tmdbKey: kd.tmdb } : { osKey: kd.os, osUser: kd.user, ...(osPass ? { osPass } : {}) }).then(setSrv);
      if (osPass) setOsPass('');
      onSaved();
      const r = await api<{ ok: boolean; text: string }>('online/test', { kind });
      setKMsg((m) => ({ ...m, [kind]: r }));
    } catch (e: any) { setKMsg((m) => ({ ...m, [kind]: { ok: false, text: e?.message ?? 'Could not save' } })); }
    setKBusy('');
  };
  const clearKeys = async (kind: 'tmdb' | 'os') => {
    if (kind === 'tmdb') { setKd((x) => ({ ...x, tmdb: '' })); await post<Srv>('settings', { tmdbKey: '' }).then(setSrv); }
    else { setKd((x) => ({ ...x, os: '', user: '' })); setOsPass(''); await post<Srv>('settings', { osKey: '', osUser: '', osPass: '' }).then(setSrv); }
    setKMsg((m) => ({ ...m, [kind]: { ok: true, text: 'Removed.' } })); onSaved();
  };
  const kline = (kind: string, has: boolean) => {
    const m = kMsg[kind];
    return m ? <span className={'kstat ' + (m.ok ? 'ok' : 'bad')}>{m.ok ? '✓' : '✕'} {m.text}</span>
      : <span className={'kstat ' + (has ? 'ok' : 'idle')}>{has ? '✓ Saved. Press “Save & test” to check it works.' : 'Not set yet'}</span>;
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
      <div className="dialog wide settings de-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="set-accent" aria-hidden="true" />
        <div className="dlg-head">
          <div>
            <h3>Settings</h3>
            <span className="dlg-sub">{tab ? (TABS.find((x) => x.id === tab)?.hint ?? 'Preferences') : 'Choose a section or search'}</span>
          </div>
          <button className="icon set-close" onClick={onClose} aria-label="Close settings"><Icon n="close" /></button>
        </div>
        <div className="set-search-bar">
          <input className="set-search" type="search" placeholder="Search settings…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
        </div>

        {!q && tab === null && (
          <div className="set-hub">
            <p className="set-hub-lead muted">Choose a section</p>
            <div className="set-hub-grid">
              {TABS.map((x) => (
                <button key={x.id} type="button" className="set-hub-card" onClick={() => setTab(x.id)}>
                  <span className="set-hub-ico"><Icon n={x.icon} s={18} /></span>
                  <span className="set-hub-text">
                    <b>{x.label}</b>
                    <small>{x.hint}</small>
                  </span>
                  <span className="set-hub-chev" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {(q || tab !== null) && (
        <div className="set-body set-body-card">
        {!q && tab !== null && (
          <div className="set-section-bar">
            <button type="button" className="set-back" onClick={() => setTab(null)} aria-label="Back to all settings">
              <Icon n="back" s={16} /> All settings
            </button>
            <strong>{TABS.find((x) => x.id === tab)?.label}</strong>
          </div>
        )}
        {q && <SearchResults q={q} onPick={(t) => { setTab(t); setQ(''); }} />}

        {cur === 'look' && (
        <section className="look-panel">
          <div className="look-block">
            <div className="look-block-h">
              <h4>Theme</h4>
              <p className="muted small">Overall chrome for the app</p>
            </div>
            <div className="look-theme" role="group" aria-label="Theme">
              <button type="button" className={s.theme === 'dark' ? 'look-theme-card on' : 'look-theme-card'} onClick={() => set({ theme: 'dark' })}>
                <span className="look-theme-preview dark" aria-hidden="true" />
                <span className="look-theme-meta"><b>Dark</b><small>Easy on the eyes at night</small></span>
              </button>
              <button type="button" className={s.theme === 'light' ? 'look-theme-card on' : 'look-theme-card'} onClick={() => set({ theme: 'light' })}>
                <span className="look-theme-preview light" aria-hidden="true" />
                <span className="look-theme-meta"><b>Light</b><small>Bright panels and text</small></span>
              </button>
            </div>
          </div>

          <div className="look-block">
            <div className="look-block-h">
              <h4>Accent</h4>
              <p className="muted small">Highlights, buttons and focus rings</p>
            </div>
            <div className="look-accents">
              {Object.entries(ACCENTS).map(([name, c]) => (
                <button
                  key={name}
                  type="button"
                  className={s.accent === name && !s.accentCustom ? 'look-accent on' : 'look-accent'}
                  onClick={() => set({ accent: name, accentCustom: '' })}
                  title={name}
                  aria-label={name}
                >
                  <i style={{ background: c }} />
                  <span>{name}</span>
                </button>
              ))}
            </div>
            <div className="look-custom">
              <div className="look-custom-left">
                <b>Custom colour</b>
                <small className="muted">Overrides the preset above</small>
              </div>
              <div className="look-custom-right">
                <label className="look-color-pick">
                  <input
                    type="color"
                    value={/^#[0-9a-f]{6}$/i.test(s.accentCustom) ? s.accentCustom : (ACCENTS[s.accent] ?? '#f5c542')}
                    onChange={(e) => set({ accentCustom: e.target.value })}
                    aria-label="Custom accent colour"
                  />
                  <span className="look-color-chip" style={{ background: /^#[0-9a-f]{6}$/i.test(s.accentCustom) ? s.accentCustom : (ACCENTS[s.accent] ?? '#f5c542') }} />
                  <span className="look-color-hex">{(/^#[0-9a-f]{6}$/i.test(s.accentCustom) ? s.accentCustom : (ACCENTS[s.accent] ?? '#f5c542')).toUpperCase()}</span>
                </label>
                {!!s.accentCustom && (
                  <button type="button" className="btn ghost sm" onClick={() => set({ accentCustom: '' })}>Use preset</button>
                )}
              </div>
            </div>
          </div>

          <div className="look-block">
            <div className="look-block-h">
              <h4>Colour style</h4>
              <p className="muted small">Tint behind panels and surfaces</p>
            </div>
            <div className="look-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={s.themePreset === p.id ? 'look-preset on' : 'look-preset'}
                  onClick={() => set({ themePreset: p.id })}
                  aria-label={p.name}
                >
                  <i style={{ background: p.c }} />
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="look-block">
            <div className="look-block-h">
              <h4>Display</h4>
              <p className="muted small">Density and previews</p>
            </div>
            <div className="look-toggles">
              <div className="look-toggle-row">
                <div>
                  <b>Compact mode</b>
                  <small className="muted">Tighter spacing, good for small screens</small>
                </div>
                <Toggle on={s.compact} label="Compact" onClick={() => set({ compact: !s.compact })} />
              </div>
              <div className="look-toggle-row">
                <div>
                  <b>Video thumbnails</b>
                  <small className="muted">Made once on the server, then cached</small>
                </div>
                <Toggle on={s.thumbs} label="Video thumbnails" onClick={() => set({ thumbs: !s.thumbs })} />
              </div>
            </div>
          </div>
        </section>
        )}

        {cur === 'data' && (
        <section className="data-panel">

          {/* Data Saver */}
          <div className="data-block">
            <div className="data-block-h">
              <h4>Data Saver</h4>
              <p className="muted small">Caps the quality Auto may pick and squeezes bitrate. Does not change Original playback or downloads.</p>
            </div>

            <div className="data-saver-grid" role="group" aria-label="Data Saver level">
              {SAVER.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={'data-saver-card' + (s.saver === o.id ? ' on' : '')}
                  onClick={() => set({ saver: o.id })}
                >
                  <b>{o.label}</b>
                  <small>{o.hint}</small>
                </button>
              ))}
            </div>
          </div>

          {/* Budget */}
          <div className="data-block">
            <div className="data-block-h">
              <h4>Monthly budget</h4>
              <p className="muted small">Counts streaming and downloads. 0 = no limit</p>
            </div>

            <div className="data-budget">
              <div className="data-budget-input">
                <input
                  type="number"
                  min={0}
                  value={srv?.budgetGB ?? 0}
                  onChange={(e) => local({ budgetGB: +e.target.value })}
                  onBlur={() => patch({ budgetGB: srv?.budgetGB ?? 0 })}
                />
                <span>GB</span>
              </div>
              <div className="data-budget-presets">
                {[0, 5, 10, 25, 50, 100].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={'data-chip' + ((srv?.budgetGB ?? 0) === n ? ' on' : '')}
                    onClick={() => { local({ budgetGB: n }); patch({ budgetGB: n }); }}
                  >
                    {n === 0 ? 'No limit' : `${n} GB`}
                  </button>
                ))}
              </div>
            </div>

            <div className="data-toggles" style={{ marginTop: 12 }}>
              <div className="data-toggle-row">
                <div>
                  <b>Switch to Low at 80% of budget</b>
                  <small className="muted">Automatically, until the month ends</small>
                </div>
                <Toggle on={s.saverAuto} label="Auto Data Saver" onClick={() => set({ saverAuto: !s.saverAuto })} />
              </div>
            </div>
          </div>

          {/* Speed test */}
          <div className="data-block">
            <div className="data-block-h">
              <h4>Speed test</h4>
              <p className="muted small">
                How fast your server can send data to this laptop. Real limit for streaming and downloads.
                {mode === 'local' ? ' Path: direct (fastest).' : mode && mode !== 'none' ? ' Path: through SSH.' : ''}
              </p>
            </div>

            <div className="data-test">
              <button className="btn" disabled={t.running} onClick={run}>
                <Icon n="bolt" s={15} /> {t.running ? 'Testing…' : 'Run speed test'}
              </button>
              {t.running && (
                <button className="btn ghost" onClick={() => ctl.current?.abort()}>Stop</button>
              )}
              {t.running && (
                <strong className="data-live">{rate(t.live)} <small>{mbps(t.live)}</small></strong>
              )}
            </div>

            {t.res && (
              <div className="data-result">
                <div className="data-result-row">
                  <span>Average</span>
                  <b>{rate(t.res.avg)} <small>({mbps(t.res.avg)})</small></b>
                </div>
                <div className="data-result-row">
                  <span>Peak</span>
                  <b>{mbps(t.res.peak)}</b>
                </div>
                <div className="data-result-row">
                  <span>Transferred</span>
                  <b>{bytes(t.res.bytes)}</b>
                </div>
              </div>
            )}
            {t.err && <p className="err-t">{t.err}</p>}
          </div>

        </section>
        )}

        {cur === 'play' && (
        <section className="play-panel">

          {/* Playback defaults */}
          <div className="play-block">
            <div className="play-block-h">
              <h4>Playback</h4>
              <p className="muted small">Defaults for every new video</p>
            </div>

            <div className="play-field">
              <div className="play-field-label">
                <b>Default quality</b>
                <small className="muted">Auto respects Data Saver</small>
              </div>
              <div className="play-chips" role="group" aria-label="Default quality">
                {QUALITIES.filter((q) => q.id !== 'audio').map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    className={'play-chip' + (s.quality === q.id ? ' on' : '')}
                    onClick={() => set({ quality: q.id })}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="play-field">
              <div className="play-field-label">
                <b>Default screen shape</b>
              </div>
              <div className="play-aspects" role="group" aria-label="Default screen shape">
                {ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={'play-aspect' + (s.aspect === a.id ? ' on' : '')}
                    onClick={() => set({ aspect: a.id })}
                  >
                    <span className={'play-aspect-preview a-' + a.id.replace(':', '')} />
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="play-field">
              <div className="play-field-label">
                <b>Power saving</b>
                <small className="muted">Lowers quality cap and turns off blur / animations</small>
              </div>
              <div className="play-seg" role="group" aria-label="Power saving">
                {([
                  { id: 'off' as const, label: 'Off' },
                  { id: 'battery' as const, label: 'Battery' },
                  { id: 'on' as const, label: 'Always' },
                ]).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={s.eco === o.id ? 'on' : ''}
                    onClick={() => set({ eco: o.id })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Smart features */}
          <div className="play-block">
            <div className="play-block-h">
              <h4>Smart features</h4>
              <p className="muted small">Intros, autoplay and background save</p>
            </div>

            <div className="play-toggles">
              <div className="play-toggle-row">
                <div>
                  <b>Detect intros automatically</b>
                  <small className="muted">Compares ~7 min of 3 episodes once. Uses a little server data.</small>
                </div>
                <Toggle on={s.autoIntro} label="Detect intros" onClick={() => set({ autoIntro: !s.autoIntro })} />
              </div>

              <div className="play-toggle-row">
                <div>
                  <b>Show “Skip intro”</b>
                  <small className="muted">Only on files that already have an intro / recap chapter</small>
                </div>
                <Toggle on={s.skipIntro} label="Skip intro button" onClick={() => set({ skipIntro: !s.skipIntro })} />
              </div>

              <div className="play-toggle-row">
                <div>
                  <b>Play next episode automatically</b>
                </div>
                <Toggle on={s.autoNext} label="Autoplay next" onClick={() => set({ autoNext: !s.autoNext })} />
              </div>

              <div className="play-toggle-row">
                <div>
                  <b>Download next episode while I watch</b>
                  <small className="muted">Saves a full-quality copy in the background for offline</small>
                </div>
                <Toggle on={s.predownload} label="Pre-download next" onClick={() => set({ predownload: !s.predownload })} />
              </div>
            </div>
          </div>

          {/* Sound */}
          <div className="play-block">
            <div className="play-block-h">
              <h4>Sound</h4>
              <p className="muted small">Volume, boost and equalizer</p>
            </div>

            <div className="play-field">
              <div className="play-field-label">
                <b>Maximum volume</b>
                <small className="muted">Above 100% a limiter keeps it clean</small>
              </div>
              <div className="play-chips" role="group" aria-label="Maximum volume">
                {MAX_VOLS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={'play-chip' + (s.maxVol === v ? ' on' : '')}
                    onClick={() => set({ maxVol: v })}
                  >
                    {v}%
                  </button>
                ))}
              </div>
              <div className="play-vol-preview" aria-hidden="true">
                <div className="play-vol-bar">
                  <i style={{ width: `${Math.min(100, (s.maxVol / 500) * 100)}%` }} />
                  <span className="play-vol-boost" />
                </div>
                <span className="play-vol-label">{s.maxVol}%</span>
              </div>
            </div>

            <div className="play-toggles" style={{ marginTop: 4 }}>
              <div className="play-toggle-row">
                <div>
                  <b>Remember boost above 100%</b>
                  <small className="muted">Off: volume resets to ≤100% every time the app starts</small>
                </div>
                <Toggle on={s.rememberBoost} label="Remember boost" onClick={() => set({ rememberBoost: !s.rememberBoost })} />
              </div>
            </div>

            <div className="play-field" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              <div className="play-field-label">
                <b>Default equalizer</b>
              </div>
              <div className="play-eq" role="group" aria-label="Default equalizer">
                {Object.keys(EQ_PRESETS).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={'play-eq-chip' + (s.eqPreset === n ? ' on' : '')}
                    onClick={() => set({ eqPreset: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Other players (desktop only) */}
          {bridge && (
            <div className="play-block">
              <div className="play-block-h">
                <h4>Other players</h4>
                <p className="muted small">Desktop only</p>
              </div>
              <div className="play-field" style={{ borderBottom: 'none', paddingTop: 0 }}>
                <div className="play-field-label">
                  <b>Open in another player</b>
                  <small className="muted">e.g. VLC. Leave empty for system default</small>
                </div>
                <span className="inline">
                  <input
                    value={s.externalPlayer}
                    onChange={(e) => set({ externalPlayer: e.target.value })}
                    placeholder="C:\Program Files\VideoLAN\VLC\vlc.exe"
                  />
                  <button className="btn ghost" onClick={() => browse('player')}>Browse…</button>
                </span>
              </div>
            </div>
          )}

        </section>
        )}

        {cur === 'subs' && (
        <section className="subs-panel">

          {/* Behaviour */}
          <div className="subs-block">
            <div className="subs-block-h">
              <h4>Behaviour</h4>
              <p className="muted small">When and which subtitles appear</p>
            </div>

            <div className="subs-toggles">
              <div className="subs-toggle-row">
                <div>
                  <b>Turn on subtitles automatically</b>
                  <small className="muted">Picks a track in your language, inside the video or next to it</small>
                </div>
                <Toggle on={s.autoSub} label="Auto subtitles" onClick={() => set({ autoSub: !s.autoSub })} />
              </div>

              <div className="subs-toggle-row">
                <div>
                  <b>Skip if audio is already in that language</b>
                  <small className="muted">Don’t show subtitles when the spoken language matches</small>
                </div>
                <Toggle on={s.subSmart} label="Skip when audio matches" onClick={() => set({ subSmart: !s.subSmart })} />
              </div>
            </div>

            <div className="subs-field" style={{ borderBottom: 'none', paddingTop: 12 }}>
              <div className="subs-field-label">
                <b>Your language</b>
              </div>
              <div className="subs-langs" role="group" aria-label="Subtitle language">
                {LANGS.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    className={'subs-lang' + (s.subLang === l.code ? ' on' : '')}
                    onClick={() => set({ subLang: l.code })}
                  >
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Appearance */}
          <div className="subs-block">
            <div className="subs-block-h">
              <h4>Appearance</h4>
              <p className="muted small">How the text looks on screen</p>
            </div>

            <div className="subs-slider">
              <div className="subs-slider-top">
                <b>Size</b>
                <span className="subs-slider-val">{s.subSize}</span>
              </div>
              <input
                type="range"
                min={16}
                max={60}
                value={s.subSize}
                onChange={(e) => set({ subSize: +e.target.value })}
              />
            </div>

            <div className="subs-color-row">
              <b>Colour</b>
              <div className="subs-swatches">
                {['#ffffff', '#fbbf24', '#60a5fa', '#4ade80', '#f472b6', '#a78bfa'].map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={'subs-swatch' + (s.subColor.toLowerCase() === c ? ' on' : '')}
                    style={{ background: c }}
                    onClick={() => set({ subColor: c })}
                    aria-label={c}
                  />
                ))}
                <label className="subs-custom-color" title="Custom colour">
                  <input
                    type="color"
                    value={s.subColor}
                    onChange={(e) => set({ subColor: e.target.value })}
                  />
                </label>
              </div>
            </div>

            <div className="subs-slider">
              <div className="subs-slider-top">
                <b>Background darkness</b>
                <span className="subs-slider-val">{s.subBg}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={s.subBg}
                onChange={(e) => set({ subBg: +e.target.value })}
              />
            </div>

            <div className="subs-toggles">
              <div className="subs-toggle-row">
                <div>
                  <b>Outline</b>
                  <small className="muted">Black stroke around the letters for better contrast</small>
                </div>
                <Toggle on={s.subOutline} label="Outline" onClick={() => set({ subOutline: !s.subOutline })} />
              </div>
            </div>

            <div className="subs-slider">
              <div className="subs-slider-top">
                <b>Position from bottom</b>
                <span className="subs-slider-val">{s.subPos}%</span>
              </div>
              <input
                type="range"
                min={2}
                max={30}
                value={s.subPos}
                onChange={(e) => set({ subPos: +e.target.value })}
              />
            </div>

            <div className="subs-preview">
              <span
                style={{
                  fontSize: Math.min(s.subSize, 40),
                  color: s.subColor,
                  background: `rgba(0,0,0,${s.subBg / 100})`,
                  textShadow: s.subOutline
                    ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 6px #000'
                    : undefined,
                }}
              >
                This is how your subtitles will look.
              </span>
            </div>
          </div>

          {/* OpenSubtitles */}
          <div className="subs-block">
            <div className="subs-block-h">
              <h4>OpenSubtitles</h4>
              <p className="muted small">Free key at opensubtitles.com · stored encrypted on this computer</p>
            </div>

            <div className="subs-keybox">
              <input
                value={kd.os}
                onChange={(e) => setKd({ ...kd, os: e.target.value })}
                placeholder="API key"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="subs-key-row">
                <input
                  value={kd.user}
                  onChange={(e) => setKd({ ...kd, user: e.target.value })}
                  placeholder="Username"
                  autoComplete="off"
                />
                <input
                  type="password"
                  value={osPass}
                  onChange={(e) => setOsPass(e.target.value)}
                  placeholder={srv?.hasOsPass ? 'Password saved (type to change)' : 'Password'}
                  autoComplete="new-password"
                />
              </div>
              <div className="subs-key-status">{kline('os', !!(srv?.osKey || srv?.hasOsPass))}</div>
              <div className="subs-key-actions">
                <button
                  className="btn"
                  disabled={kBusy === 'os' || !kd.os.trim()}
                  onClick={() => saveTest('os')}
                >
                  {kBusy === 'os' ? 'Checking…' : 'Save & test'}
                </button>
                <button className="btn ghost" disabled={kBusy === 'os'} onClick={() => clearKeys('os')}>
                  Remove
                </button>
              </div>
            </div>
          </div>

        </section>
        )}

        {cur === 'look' && (
        <section className="look-panel">
          <div className="look-block">
            <div className="look-block-h">
              <h4>Library</h4>
              <p className="muted small">Posters and watch stats</p>
            </div>
            <div className="look-tmdb">
              <div className="look-tmdb-label">
                <b>TMDB key</b>
                <small className="muted">Free at themoviedb.org — posters, ratings and descriptions</small>
              </div>
              <div className="look-tmdb-row">
                <input value={kd.tmdb} onChange={(e) => setKd({ ...kd, tmdb: e.target.value })} placeholder="API key or read token" autoComplete="off" spellCheck={false} />
                <button type="button" className="btn" disabled={kBusy === 'tmdb' || !kd.tmdb.trim()} onClick={() => saveTest('tmdb')}>{kBusy === 'tmdb' ? 'Checking…' : 'Save & test'}</button>
                <button type="button" className="btn ghost" disabled={kBusy === 'tmdb'} onClick={() => clearKeys('tmdb')}>Remove</button>
              </div>
              <div className="look-tmdb-status">{kline('tmdb', !!srv?.tmdbKey)}</div>
            </div>
            <div className="look-toggles">
              <div className="look-toggle-row">
                <div>
                  <b>Show posters instead of thumbnails</b>
                  <small className="muted">Needs the TMDB key</small>
                </div>
                <Toggle on={s.posters} label="Posters" onClick={() => set({ posters: !s.posters })} />
              </div>
            </div>
            <div className="look-stat">
              <span className="muted">Watching so far</span>
              <b>{hours.toFixed(1)} hours · {finished} finished</b>
            </div>
          </div>
        </section>
        )}

        {cur === 'offline' && (
        <section className="off-panel">

          {/* Storage location */}
          <div className="off-block">
            <div className="off-block-h">
              <h4>Storage</h4>
              <p className="muted small">{moveMsg || (srv?.downloadDir ? srv.downloadDir : 'Choose where downloads are saved')}</p>
            </div>
            <div className="off-actions">
              {bridge && <button className="btn ghost" onClick={() => browse('folder')}>Change folder…</button>}
              <button className="btn ghost" onClick={async () => { setMoveMsg('Moving…'); const e = await moveDownloads('vault', setMoveMsg); setMoveMsg(e ?? 'Done. Saved videos now live in a hidden folder inside the app’s own data.'); patch({}); }} title="Hidden, app-private folder">Private storage</button>
              <button className="btn ghost" onClick={onStorage}><Icon n="hdd" s={15} /> Storage</button>
              <button className="btn ghost" onClick={onTidy}>Tidy saved videos</button>
            </div>
          </div>

          {/* While watching */}
          <div className="off-block">
            <div className="off-block-h">
              <h4>While watching</h4>
              <p className="muted small">Background saving for offline</p>
            </div>
            <div className="off-toggles">
              <div className="off-toggle-row">
                <div>
                  <b>Save while I watch</b>
                  <small className="muted">Keeps a full-quality copy so next time it plays offline</small>
                </div>
                <Toggle on={s.autoCache} label="Save while watching" onClick={() => set({ autoCache: !s.autoCache })} />
              </div>
            </div>
          </div>

          {/* Download behaviour */}
          <div className="off-block">
            <div className="off-block-h">
              <h4>Download behaviour</h4>
              <p className="muted small">Speed, parallel files and schedule</p>
            </div>

            <div className="off-field">
              <div className="off-field-label">
                <b>Files at the same time</b>
              </div>
              <div className="off-chips" role="group">
                {[1, 2, 3, 4, 6].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={'off-chip' + ((srv?.maxParallel ?? 2) === n ? ' on' : '')}
                    onClick={() => patch({ maxParallel: n })}
                  >{n}</button>
                ))}
              </div>
            </div>

            <div className="off-field">
              <div className="off-field-label">
                <b>Speed limit</b>
                <small className="muted">Keeps some bandwidth for other things</small>
              </div>
              <div className="off-chips" role="group">
                {LIMITS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={'off-chip' + ((srv?.limitKBps ?? 0) === n ? ' on' : '')}
                    onClick={() => patch({ limitKBps: n })}
                  >{n ? rate(n * 1024) : 'No limit'}</button>
                ))}
              </div>
            </div>

            <div className="off-toggles">
              <div className="off-toggle-row">
                <div>
                  <b>Only download at night</b>
                  <small className="muted">Downloads wait until the time window opens</small>
                </div>
                <Toggle on={!!srv?.schedule.on} label="Schedule" onClick={() => patch({ schedule: { ...srv!.schedule, on: !srv?.schedule.on } })} />
              </div>
            </div>
            {srv?.schedule.on && (
              <div className="off-time-row">
                <span className="muted">Between</span>
                <input type="time" value={srv.schedule.from} onChange={(e) => patch({ schedule: { ...srv.schedule, from: e.target.value } })} />
                <span className="muted">and</span>
                <input type="time" value={srv.schedule.to} onChange={(e) => patch({ schedule: { ...srv.schedule, to: e.target.value } })} />
              </div>
            )}

            <div className="off-toggles">
              <div className="off-toggle-row">
                <div>
                  <b>Pause on battery</b>
                  <small className="muted">Downloads wait until the laptop is plugged in</small>
                </div>
                <Toggle on={!!srv?.pauseOnBattery} label="Pause on battery" onClick={() => patch({ pauseOnBattery: !srv?.pauseOnBattery })} />
              </div>
              <div className="off-toggle-row">
                <div>
                  <b>Pause on metered connection</b>
                  <small className="muted">If Windows marks Wi-Fi as metered</small>
                </div>
                <Toggle on={!!srv?.pauseOnMetered} label="Pause on metered" onClick={() => patch({ pauseOnMetered: !srv?.pauseOnMetered })} />
              </div>
              <div className="off-toggle-row">
                <div>
                  <b>Slow down at certain hours</b>
                  <small className="muted">Limit speed between two times</small>
                </div>
                <Toggle on={!!srv?.limitWin?.on} label="Slow down" onClick={() => patch({ limitWin: { ...(srv?.limitWin ?? { from: '18:00', to: '23:00', kbps: 2000 }), on: !srv?.limitWin?.on } })} />
              </div>
            </div>
            {srv?.limitWin?.on && (
              <div className="off-time-row">
                <input type="time" value={srv?.limitWin?.from ?? '18:00'} onChange={(e) => patch({ limitWin: { ...(srv?.limitWin ?? { on: false, to: '23:00', kbps: 2000 }), from: e.target.value } })} />
                <span className="muted">–</span>
                <input type="time" value={srv?.limitWin?.to ?? '23:00'} onChange={(e) => patch({ limitWin: { ...(srv?.limitWin ?? { on: false, from: '18:00', kbps: 2000 }), to: e.target.value } })} />
                <input type="number" min={0} step={100} style={{ width: 80 }} value={srv?.limitWin?.kbps ?? 2000} onChange={(e) => patch({ limitWin: { ...(srv?.limitWin ?? { on: false, from: '18:00', to: '23:00' }), kbps: +e.target.value } })} />
                <span className="muted">KB/s</span>
              </div>
            )}
          </div>

          {/* Compression */}
          <div className="off-block">
            <div className="off-block-h">
              <h4>Compression</h4>
              <p className="muted small">Where and how files are made smaller</p>
            </div>

            <div className="off-field">
              <div className="off-field-label">
                <b>Compress on</b>
                <small className="muted">Laptop GPU is usually much faster. Auto picks the quickest</small>
              </div>
              <div className="off-seg" role="group">
                {([
                  { id: 'auto', label: 'Auto' },
                  { id: 'laptop', label: 'This laptop' },
                  { id: 'server', label: 'Server' },
                ] as const).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={(srv?.encodeWhere ?? 'auto') === o.id ? 'on' : ''}
                    onClick={() => patch({ encodeWhere: o.id })}
                  >{o.label}</button>
                ))}
              </div>
            </div>

            <div className="off-field">
              <div className="off-field-label">
                <b>Compression speed</b>
                <small className="muted">Fastest = bigger files. Smallest = takes longer</small>
              </div>
              <div className="off-seg" role="group">
                {([
                  { id: 'fast', label: 'Fastest' },
                  { id: 'balanced', label: 'Balanced' },
                  { id: 'small', label: 'Smallest' },
                ] as const).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={(srv?.encodeSpeed ?? 'fast') === o.id ? 'on' : ''}
                    onClick={() => patch({ encodeSpeed: o.id })}
                  >{o.label}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Space management */}
          <div className="off-block">
            <div className="off-block-h">
              <h4>Space management</h4>
              <p className="muted small">Your copies on the server are never deleted</p>
            </div>

            <div className="off-field">
              <div className="off-field-label">
                <b>Space limit for saved videos</b>
                <small className="muted">When full, watched videos are removed first, then oldest</small>
              </div>
              <div className="off-chips" role="group">
                {[0, 2, 5, 10, 20, 50].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={'off-chip' + ((srv?.quotaGB ?? 0) === n ? ' on' : '')}
                    onClick={() => patch({ quotaGB: n })}
                  >{n === 0 ? 'No limit' : `${n} GB`}</button>
                ))}
              </div>
            </div>

            <div className="off-field">
              <div className="off-field-label">
                <b>Delete watched downloads after</b>
                <small className="muted">Frees space automatically</small>
              </div>
              <div className="off-chips" role="group">
                {[0, 1, 3, 7, 14, 30].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={'off-chip' + ((srv?.autoDeleteDays ?? 0) === n ? ' on' : '')}
                    onClick={() => patch({ autoDeleteDays: n })}
                  >{n === 0 ? 'Never' : `${n} day${n > 1 ? 's' : ''}`}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Browser turbo (web only) */}
          {!bridge && (
            <div className="off-block">
              <div className="off-block-h">
                <h4>Browser download</h4>
                <p className="muted small">{turboOk() ? 'Splits big files across several connections' : 'Needs Chrome, Edge or Opera over HTTPS (or localhost)'}</p>
              </div>
              <div className="off-toggles">
                <div className="off-toggle-row">
                  <div>
                    <b>Turbo download</b>
                  </div>
                  <Toggle on={s.turbo} label="Turbo download" onClick={() => set({ turbo: !s.turbo })} />
                </div>
              </div>
              <div className="off-field">
                <div className="off-field-label">
                  <b>Connections per file</b>
                </div>
                <div className="off-chips" role="group">
                  {[2, 4, 8, 12, 16].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={'off-chip' + (s.conns === n ? ' on' : '')}
                      onClick={() => set({ conns: n })}
                    >{n}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

        </section>
        )}

        

        {cur === 'app' && (
          <section>
            <h4>Start with Windows</h4>
            {bridge ? <Field label="Open Cinema when I sign in" hint="It starts quietly in the tray and closes itself again unless a scheduled download or auto-save rule needs it"><Toggle on={login} label="Start with Windows" onClick={() => bridge?.loginItemSet?.(!login).then(setLogin)} /></Field> : <p className="muted small">Available in the installed app.</p>}
          </section>
        )}
        {cur === 'app' && <section><h4>Phone and TV remote</h4><Field label="Control playback from your phone" hint="Also lets a phone or smart TV browser watch what is playing"><RemoteBlock /></Field></section>}
        {cur === 'app' && <section><h4>Profiles</h4><ProfilesBlock /></section>}
        {cur === 'app' && <section><h4>Backup</h4><BackupBlock clientSettings={s} restoreClient={() => {}} /></section>}
        {cur === 'app' && <ServerTools />}
        {cur === 'app' && <Updates />}

        {cur === 'app' && (
        <section>
          <h4>Servers</h4>
          <Field label="Where your movies are stored"><button className="btn ghost" onClick={onServers}><Icon n="server" s={15} /> Manage servers</button></Field>
        </section>
        )}

        

        {cur === 'app' && <p className="muted small">{APP_NAME}{bridge ? ` ${bridge.version}` : ''}</p>}
        </div>
        )}
      </div>
    </div>
  );
}