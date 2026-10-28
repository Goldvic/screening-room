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
          <Field label="Colour style">
            <span className="swatches">{PRESETS.map((p) => <button key={p.id} className={s.themePreset === p.id ? 'swt on' : 'swt'} style={{ background: p.c }} title={p.name} aria-label={p.name} onClick={() => set({ themePreset: p.id })} />)}</span>
          </Field>
          <Field label="Custom accent colour" hint="Overrides the accent colour above">
            <span className="inline"><input type="color" value={/^#[0-9a-f]{6}$/i.test(s.accentCustom) ? s.accentCustom : '#8b7bff'} onChange={(e) => set({ accentCustom: e.target.value })} /><button className="btn ghost sm" onClick={() => set({ accentCustom: '' })}>Use the preset</button></span>
          </Field>
          <Field label="Compact mode" hint="Tighter spacing, good for small screens"><Toggle on={s.compact} label="Compact" onClick={() => set({ compact: !s.compact })} /></Field>
          <Field label="Video thumbnails" hint="Made once on the server, then cached"><Toggle on={s.thumbs} label="Video thumbnails" onClick={() => set({ thumbs: !s.thumbs })} /></Field>
        </section>
        )}

        {cur === 'data' && (
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

        {cur === 'play' && (
        <section>
          <h4>Playback</h4>
          <Field label="Default quality">
            <select value={s.quality} onChange={(e) => set({ quality: e.target.value })}>{QUALITIES.filter((q) => q.id !== 'audio').map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select>
          </Field>
          <Field label="Default screen shape">
            <select value={s.aspect} onChange={(e) => set({ aspect: e.target.value })}>{ASPECTS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select>
          </Field>
          <Field label="Power saving" hint="Lowers the video quality cap and turns off blur and animations to save battery">
            <select value={s.eco} onChange={(e) => set({ eco: e.target.value as 'off' | 'on' | 'battery' })}>
              <option value="off">Off</option><option value="battery">Only on battery</option><option value="on">Always on</option>
            </select>
          </Field>
          <Field label="Detect intros automatically" hint="Finds the opening music by comparing episodes. Reads about 7 minutes of 3 videos once per episode, so it uses some data on a server"><Toggle on={s.autoIntro} label="Detect intros" onClick={() => set({ autoIntro: !s.autoIntro })} /></Field>
          <Field label="Show “Skip intro" hint="Only on episodes whose file has an intro or recap chapter"><Toggle on={s.skipIntro} label="Skip intro button" onClick={() => set({ skipIntro: !s.skipIntro })} /></Field>
          <Field label="Play next episode automatically"><Toggle on={s.autoNext} label="Autoplay next" onClick={() => set({ autoNext: !s.autoNext })} /></Field>
          <Field label="Download the next episode while I watch" hint="Saves it for offline in the background"><Toggle on={s.predownload} label="Pre-download next" onClick={() => set({ predownload: !s.predownload })} /></Field>
        </section>
        )}

        {cur === 'play' && (
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

        {cur === 'subs' && (
        <section>
          <h4>Subtitles</h4>
          <Field label="Turn on subtitles automatically" hint="Picks a track in your language, inside the video or next to it">
            <Toggle on={s.autoSub} label="Auto subtitles" onClick={() => set({ autoSub: !s.autoSub })} />
          </Field>
          <Field label="Your language">
            <select value={s.subLang} onChange={(e) => set({ subLang: e.target.value })}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select>
          </Field>
          <Field label="Subtitle size"><input type="range" min={16} max={60} value={s.subSize} onChange={(e) => set({ subSize: +e.target.value })} /></Field>
          <Field label="Subtitle colour"><input type="color" value={s.subColor} onChange={(e) => set({ subColor: e.target.value })} /></Field>
          <Field label="Subtitle background" hint="How dark the box behind the words is"><input type="range" min={0} max={100} value={s.subBg} onChange={(e) => set({ subBg: +e.target.value })} /></Field>
          <Field label="Subtitle outline"><Toggle on={s.subOutline} label="Outline" onClick={() => set({ subOutline: !s.subOutline })} /></Field>
          <Field label="Subtitle position" hint="Distance from the bottom of the picture"><input type="range" min={2} max={30} value={s.subPos} onChange={(e) => set({ subPos: +e.target.value })} /></Field>
          <div className="subprev"><span style={{ fontSize: Math.min(s.subSize, 40), color: s.subColor, background: `rgba(0,0,0,${s.subBg / 100})`, textShadow: s.subOutline ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 6px #000' : undefined }}>This is how your subtitles will look.</span></div>
          <Field label="Skip if the audio is already in that language"><Toggle on={s.subSmart} label="Skip when audio matches" onClick={() => set({ subSmart: !s.subSmart })} /></Field>
          <Field label="OpenSubtitles" hint="Free key at opensubtitles.com. The account is only needed to download. Stored encrypted on this computer">
            <span className="keybox">
              <input value={kd.os} onChange={(e) => setKd({ ...kd, os: e.target.value })} placeholder="API key" autoComplete="off" spellCheck={false} />
              <span className="inline">
                <input value={kd.user} onChange={(e) => setKd({ ...kd, user: e.target.value })} placeholder="Username" autoComplete="off" />
                <input type="password" value={osPass} onChange={(e) => setOsPass(e.target.value)} placeholder={srv?.hasOsPass ? 'Password saved (type to change)' : 'Password'} autoComplete="new-password" />
              </span>
              {kline('os', !!(srv?.osKey || srv?.hasOsPass))}
              <span className="inline">
                <button className="btn" disabled={kBusy === 'os' || !kd.os.trim()} onClick={() => saveTest('os')}>{kBusy === 'os' ? 'Checking…' : 'Save & test'}</button>
                <button className="btn ghost" disabled={kBusy === 'os'} onClick={() => clearKeys('os')}>Remove</button>
              </span>
            </span>
          </Field>
        </section>
        )}

        {cur === 'look' && (
        <section>
          <h4>Library</h4>
          <Field label="TMDB key" hint="Free at themoviedb.org. Adds posters, ratings and descriptions">
            <span className="keybox">
              <input value={kd.tmdb} onChange={(e) => setKd({ ...kd, tmdb: e.target.value })} placeholder="API key or read token" autoComplete="off" spellCheck={false} />
              {kline('tmdb', !!srv?.tmdbKey)}
              <span className="inline">
                <button className="btn" disabled={kBusy === 'tmdb' || !kd.tmdb.trim()} onClick={() => saveTest('tmdb')}>{kBusy === 'tmdb' ? 'Checking…' : 'Save & test'}</button>
                <button className="btn ghost" disabled={kBusy === 'tmdb'} onClick={() => clearKeys('tmdb')}>Remove</button>
              </span>
            </span>
          </Field>
          <Field label="Show posters instead of thumbnails" hint="Needs the TMDB key"><Toggle on={s.posters} label="Posters" onClick={() => set({ posters: !s.posters })} /></Field>
          <Field label="Watching so far"><span>{hours.toFixed(1)} hours · {finished} finished</span></Field>
        </section>
        )}

        {cur === 'offline' && (
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
          <Field label="Tidy saved videos" hint="Find duplicates and check that saved copies are not broken"><button className="btn" onClick={onTidy}>Open</button></Field>
          <Field label="Pause on battery" hint="Downloads wait until the laptop is plugged in"><Toggle on={!!srv?.pauseOnBattery} label="Pause on battery" onClick={() => patch({ pauseOnBattery: !srv?.pauseOnBattery })} /></Field>
          <Field label="Pause on a metered connection" hint="If Windows marks your Wi-Fi or mobile hotspot as metered, downloads wait"><Toggle on={!!srv?.pauseOnMetered} label="Pause on metered" onClick={() => patch({ pauseOnMetered: !srv?.pauseOnMetered })} /></Field>
          <Field label="Slow down at certain hours" hint="Limit the download speed between two times, for example while you work">
            <span className="inline">
              <Toggle on={!!srv?.limitWin?.on} label="Slow down" onClick={() => patch({ limitWin: { ...(srv?.limitWin ?? { from: '18:00', to: '23:00', kbps: 2000 }), on: !srv?.limitWin?.on } })} />
              <input type="time" value={srv?.limitWin?.from ?? '18:00'} onChange={(e) => patch({ limitWin: { ...(srv?.limitWin ?? { on: false, to: '23:00', kbps: 2000 }), from: e.target.value } })} />
              <input type="time" value={srv?.limitWin?.to ?? '23:00'} onChange={(e) => patch({ limitWin: { ...(srv?.limitWin ?? { on: false, from: '18:00', kbps: 2000 }), to: e.target.value } })} />
              <input type="number" min={0} step={100} style={{ width: 90 }} value={srv?.limitWin?.kbps ?? 2000} onChange={(e) => patch({ limitWin: { ...(srv?.limitWin ?? { on: false, from: '18:00', to: '23:00' }), kbps: +e.target.value } })} /> KB/s
            </span>
          </Field>
          <Field label="Compress on" hint="A laptop with an NVIDIA, Intel or AMD graphics chip compresses many times faster than a server. Auto picks the quickest">
            <select value={srv?.encodeWhere ?? 'auto'} onChange={(e) => patch({ encodeWhere: e.target.value as 'auto' | 'laptop' | 'server' })}>
              <option value="auto">Auto (recommended)</option><option value="laptop">This laptop</option><option value="server">The server</option>
            </select>
          </Field>
          <Field label="Compression speed" hint="Fastest makes slightly bigger files. Smallest takes longer">
            <select value={srv?.encodeSpeed ?? 'fast'} onChange={(e) => patch({ encodeSpeed: e.target.value as 'fast' | 'balanced' | 'small' })}>
              <option value="fast">Fastest</option><option value="balanced">Balanced</option><option value="small">Smallest files</option>
            </select>
          </Field>
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

        {bridge && cur === 'play' && (
          <section>
            <h4>Other players</h4>
            <Field label="Open in another player" hint="For example VLC. Leave empty to use your computer’s default player">
              <span className="inline"><input value={s.externalPlayer} onChange={(e) => set({ externalPlayer: e.target.value })} placeholder="C:\Program Files\VideoLAN\VLC\vlc.exe" /><button className="btn ghost" onClick={() => browse('player')}>Browse…</button></span>
            </Field>
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

        {cur === 'data' && (
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

        {cur === 'app' && <p className="muted small">{APP_NAME}{bridge ? ` ${bridge.version}` : ''}</p>}
        </div>
        )}
      </div>
    </div>
  );
}