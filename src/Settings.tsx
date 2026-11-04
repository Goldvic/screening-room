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
    <div className="srv-tool-list">
      <div className="srv-tool-item">
        <div>
          <b>Server ffmpeg</b>
          <small className="muted">{ok ? 'Found. Compressed downloads work.' : 'Not found. Conversion needs it.'}</small>
        </div>
        <span className={'kstat ' + (ok ? 'ok' : 'bad')}>{ok ? '✓ Installed' : '✕ Missing'}</span>
      </div>
      
      <div className="srv-tool-item">
        <div>
          <b>Laptop ffmpeg</b>
        </div>
        <span className={'kstat ' + (c.local.ffmpeg ? 'ok' : 'bad')}>{c.local.ffmpeg ? '✓ Built in' : '✕ Missing'}</span>
      </div>

      {!ok && <p className="mnote" style={{ margin: '4px 0' }}>Run this on your server over SSH:<br /><code>sudo apt update &amp;&amp; sudo apt install -y ffmpeg</code></p>}
      
      <div className="app-btn-row">
        <button className="btn ghost sm" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Update address" hint="GitHub repo link or web folder with latest.yml">
        <input value={feed} placeholder="https://github.com/you/screening-room" autoComplete="off" onChange={(e) => setFeed(e.target.value)} onBlur={() => bridge!.updateConfig({ feed })} />
      </Field>
      <Field label="Check automatically" hint="Downloads new versions quietly in the background"><Toggle on={u.auto} label="Check automatically" onClick={() => bridge!.updateConfig({ auto: !u.auto })} /></Field>
      <p className={u.state === 'error' ? 'err-t' : 'muted small'} role="status" style={{ margin: 0 }}>{status}</p>
      {u.state === 'downloading' && <i className="bar"><i style={{ width: `${u.percent}%` }} /></i>}
      <div className="dlg-actions" style={{ marginTop: 8 }}>
        <button className="btn ghost sm" disabled={busy || !u.packaged} onClick={async () => { await bridge!.updateConfig({ feed }); bridge!.updateCheck(); }}>Check now</button>
        {u.state === 'available' && <button className="btn sm" onClick={() => bridge!.updateDownload()}><Icon n="down" s={14} /> Download</button>}
        {u.state === 'ready' && <button className="btn sm" onClick={() => bridge!.updateInstall()}>Restart & install</button>}
      </div>
    </div>
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
type Tab = 'look' | 'play' | 'subs' | 'data' | 'offline' | 'app' | 'bot';
const TABS: { id: Tab; label: string; icon: string; hint: string }[] = [
  { id: 'look', label: 'Appearance', icon: 'eye', hint: 'Accent, theme, compact mode, thumbnails' },
  { id: 'play', label: 'Playback & sound', icon: 'play', hint: 'Quality, volume, skip keys, autoplay' },
  { id: 'subs', label: 'Subtitles', icon: 'cc', hint: 'Size, colour, background' },
  { id: 'data', label: 'Data & speed', icon: 'bolt', hint: 'Budget, Data Saver, network test' },
  { id: 'offline', label: 'Offline & downloads', icon: 'save', hint: 'Profiles, auto-save, folder' },
  { id: 'app', label: 'App & servers', icon: 'server', hint: 'Servers, TMDB, profiles, about' },
  { id: 'bot', label: 'Media Downloader', icon: 'down', hint: 'Connect to the telegram bot API' },
];
const LIMITS = [0, 250, 500, 1000, 2000, 5000, 10000];

const SEARCH_INDEX: { tab: Tab; label: string; hint: string }[] = [
{ "tab": "look", "label": "Accent color", "hint": "" },
{ "tab": "look", "label": "Theme", "hint": "" },
{ "tab": "look", "label": "Colour style", "hint": "" },
{ "tab": "look", "label": "Custom accent colour", "hint": "Overrides the accent colour above" },
{ "tab": "look", "label": "Compact mode", "hint": "Tighter spacing, good for small screens" },
{ "tab": "look", "label": "Video thumbnails", "hint": "Made once on the server, then cached" },
{ "tab": "data", "label": "Monthly data budget", "hint": "0 means no limit. Counts streaming and downloads" },
{ "tab": "data", "label": "Switch to Low at 80% of the budget", "hint": "Automatically, until the month ends" },
{ "tab": "play", "label": "Default quality", "hint": "" },
{ "tab": "play", "label": "Default screen shape", "hint": "" },
{ "tab": "play", "label": "Power saving", "hint": "Lowers the video quality cap and turns off blur and animations to save battery" },
{ "tab": "play", "label": "Detect intros automatically", "hint": "Finds the opening music by comparing episodes. Reads about 7 minutes of 3 videos once per episode, so it uses some data on a server" },
{ "tab": "play", "label": "Show \u201cSkip intro", "hint": "Only on episodes whose file has an intro or recap chapter" },
{ "tab": "play", "label": "Play next episode automatically", "hint": "" },
{ "tab": "play", "label": "Download the next episode while I watch", "hint": "Saves it for offline in the background" },
{ "tab": "play", "label": "Maximum volume", "hint": "How far the volume slider can go. Above 100% a limiter keeps it clean" },
{ "tab": "play", "label": "Remember boost above 100%", "hint": "Off: every time the app starts, volume goes back to 100% or lower to protect your ears" },
{ "tab": "play", "label": "Default equalizer", "hint": "" },
{ "tab": "subs", "label": "Turn on subtitles automatically", "hint": "Picks a track in your language, inside the video or next to it" },
{ "tab": "subs", "label": "Your language", "hint": "" },
{ "tab": "subs", "label": "Subtitle size", "hint": "" },
{ "tab": "subs", "label": "Subtitle colour", "hint": "" },
{ "tab": "subs", "label": "Subtitle background", "hint": "How dark the box behind the words is" },
{ "tab": "subs", "label": "Subtitle outline", "hint": "" },
{ "tab": "subs", "label": "Subtitle position", "hint": "Distance from the bottom of the picture" },
{ "tab": "subs", "label": "Skip if the audio is already in that language", "hint": "" },
{ "tab": "subs", "label": "OpenSubtitles", "hint": "Free key at opensubtitles.com. The account is only needed to download. Stored encrypted on this computer" },
{ "tab": "look", "label": "TMDB key", "hint": "Free at themoviedb.org. Adds posters, ratings and descriptions" },
{ "tab": "look", "label": "Show posters instead of thumbnails", "hint": "Needs the TMDB key" },
{ "tab": "look", "label": "Watching so far", "hint": "" },
{ "tab": "offline", "label": "Save downloads to", "hint": "" },
{ "tab": "offline", "label": "Save while I watch", "hint": "Keeps a full-quality copy on this laptop in the background, so next time it plays offline and uses no data" },
{ "tab": "offline", "label": "Files at the same time", "hint": "" },
{ "tab": "offline", "label": "Speed limit", "hint": "Keeps some bandwidth for other things" },
{ "tab": "offline", "label": "Only download at night", "hint": "Downloads wait until the time window opens" },
{ "tab": "offline", "label": "Between", "hint": "" },
{ "tab": "offline", "label": "Tidy saved videos", "hint": "Find duplicates and check that saved copies are not broken" },
{ "tab": "offline", "label": "Pause on battery", "hint": "Downloads wait until the laptop is plugged in" },
{ "tab": "offline", "label": "Slow down at certain hours", "hint": "Limit the download speed between two times, for example while you work" },
{ "tab": "offline", "label": "Compress on", "hint": "A laptop with an NVIDIA, Intel or AMD graphics chip compresses many times faster than a server. Auto picks the quickest" },
{ "tab": "offline", "label": "Compression speed", "hint": "Fastest makes slightly bigger files. Smallest takes longer" },
{ "tab": "offline", "label": "Space limit for saved videos", "hint": "When it is full, watched videos are removed first, then the oldest. Your copies on the server stay" },
{ "tab": "offline", "label": "Delete watched downloads after", "hint": "Frees space automatically. Your copy on the server stays" },
{ "tab": "offline", "label": "Turbo browser download", "hint": "" },
{ "tab": "offline", "label": "Connections per file", "hint": "" },
{ "tab": "play", "label": "Open in another player", "hint": "For example VLC. Leave empty to use your computer\u2019s default player" },
{ "tab": "app", "label": "Open Cinema when I sign in", "hint": "It starts quietly in the tray and closes itself again unless a scheduled download or auto-save rule needs it" },
{ "tab": "app", "label": "Control playback from your phone", "hint": "Also lets a phone or smart TV browser watch what is playing" },
{ "tab": "app", "label": "Where your movies are stored", "hint": "" },
{ "tab": "bot", "label": "Media Downloader API URL", "hint": "The URL of your bot's API" },
{ "tab": "bot", "label": "Media Downloader API Key", "hint": "From BOT_API_KEY in your .env" },
{ "tab": "bot", "label": "Telegram User ID", "hint": "Your numeric Telegram ID" }
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
  const [tab, setTab] = useState<Tab>('look');
  const [moveMsg, setMoveMsg] = useState('');
  const [q, setQ] = useState('');
  const [login, setLogin] = useState(false);
  useEffect(() => { bridge?.loginItemGet?.().then(setLogin).catch(() => {}); }, []);
  const cur = q ? '' : tab;
  const [kd, setKd] = useState({ tmdb: '', os: '', user: '' });
  const [kMsg, setKMsg] = useState<Record<string, { ok: boolean; text: string } | undefined>>({});
  const [kBusy, setKBusy] = useState('');
  const kSeed = useRef(false);
  const [srv, setSrv] = useState<Srv | null>(null);
  const [osPass, setOsPass] = useState('');
  const [t, setT] = useState<{ running: boolean; live: number; res?: { avg: number; peak: number; bytes: number }; err?: string }>({ running: false, live: 0 });
  const ctl = useRef<AbortController>();
  
  const [botTest, setBotTest] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [botErr, setBotErr] = useState('');

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

  const testBot = async () => {
    setBotTest('testing'); setBotErr('');
    const apiUrl = (s.botApiUrl || '').replace(/\/$/, '');
    if (!apiUrl || !s.botApiKey) {
      setBotTest('error'); setBotErr('URL and API Key are required.'); return;
    }
    try {
      const res = await fetch(`${apiUrl}/api/ping`, { headers: { 'x-api-key': s.botApiKey } });
      if (res.ok) {
        setBotTest('ok');
      } else {
        const data = await res.json().catch(() => ({}));
        setBotTest('error');
        setBotErr(data.detail || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setBotTest('error');
      setBotErr('Could not reach the server. Check the URL.');
    }
  };

  const seen = Object.values(prog);
  const hours = seen.reduce((a, p) => a + (p.watched && p.dur ? p.dur : p.pos), 0) / 3600;
  const finished = seen.filter((p) => p.watched).length;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog settings de-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        
        <div className="set-sidebar">
          <div className="set-side-top">
            <h3>Settings</h3>
            <button className="icon sm set-close" onClick={onClose} aria-label="Close settings"><Icon n="close" /></button>
          </div>
          <div className="set-search-bar">
            <input className="set-search" type="search" placeholder="Search settings…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
          </div>
          <nav className="set-nav">
            {TABS.map((x) => (
              <button key={x.id} type="button" className={tab === x.id && !q ? 'set-nav-b on' : 'set-nav-b'} onClick={() => { setTab(x.id); setQ(''); }}>
                <Icon n={x.icon} s={16} />
                <span>{x.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="set-content">
          {q && <SearchResults q={q} onPick={(t) => { setTab(t); setQ(''); }} />}

          {cur === 'look' && (
            <section className="look-panel">
              <div className="look-grid">
                {/* Theme */}
                <div className="look-block">
                  <div className="look-block-h">
                    <h4>Theme</h4>
                    <p className="muted small">Choose how Cinema looks.</p>
                  </div>
                  <div className="look-theme" role="group" aria-label="Theme">
                    <button type="button" className={s.theme === 'dark' ? 'look-theme-card on' : 'look-theme-card'} onClick={() => set({ theme: 'dark' })}>
                      <span className="look-theme-preview dark" aria-hidden="true">
                        <span className="mock-sidebar" />
                        <span className="mock-content" />
                      </span>
                      <span className="look-theme-meta"><b>Dark</b><small>Easy on the eyes at night</small></span>
                    </button>
                    <button type="button" className={s.theme === 'light' ? 'look-theme-card on' : 'look-theme-card'} onClick={() => set({ theme: 'light' })}>
                      <span className="look-theme-preview light" aria-hidden="true">
                        <span className="mock-sidebar" />
                        <span className="mock-content" />
                      </span>
                      <span className="look-theme-meta"><b>Light</b><small>Bright panels and text</small></span>
                    </button>
                  </div>
                </div>

                {/* Accent Colors */}
                <div className="look-block">
                  <div className="look-block-h">
                    <h4>Accent</h4>
                    <p className="muted small">Highlights, buttons and focus rings.</p>
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
                        {s.accent === name && !s.accentCustom && <Icon n="check" s={14} />}
                      </button>
                    ))}
                  </div>
                  <div className="look-custom-row">
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

                {/* Colour Style */}
                <div className="look-block">
                  <div className="look-block-h">
                    <h4>Colour Style</h4>
                    <p className="muted small">Tint behind panels and surfaces.</p>
                  </div>
                  <div className="look-presets">
                    {PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={s.themePreset === p.id ? 'look-preset on' : 'look-preset'}
                        onClick={() => set({ themePreset: p.id })}
                        aria-label={p.name}
                        title={p.name}
                      >
                        <i style={{ background: p.c }} />
                        {s.themePreset === p.id && <Icon n="check" s={16} />}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Display */}
                <div className="look-block">
                  <div className="look-block-h">
                    <h4>Display</h4>
                    <p className="muted small">Density and previews.</p>
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
              </div>

              {/* Library block spans full width */}
              <div className="look-block" style={{ marginTop: 'var(--sp-4)' }}>
                <div className="look-block-h">
                  <div className="look-icon-title">
                    <span className="look-ico"><Icon n="film" s={16} /></span>
                    <div>
                      <h4>Library & Metadata</h4>
                      <p className="muted small">Posters, descriptions, and watch stats</p>
                    </div>
                  </div>
                </div>
                
                <div className="look-field">
                  <div className="look-field-info">
                    <b>TMDB key</b>
                    <small className="muted">Free at themoviedb.org — adds posters, ratings and descriptions</small>
                  </div>
                  <div className="look-field-input">
                    <div className="input-with-icon">
                      <Icon n="info" s={16} />
                      <input value={kd.tmdb} onChange={(e) => setKd({ ...kd, tmdb: e.target.value })} placeholder="API key or read token" autoComplete="off" spellCheck={false} />
                    </div>
                    <button type="button" className="btn" disabled={kBusy === 'tmdb' || !kd.tmdb.trim()} onClick={() => saveTest('tmdb')}>
                      {kBusy === 'tmdb' ? 'Checking…' : 'Save & test'}
                    </button>
                    {!!srv?.tmdbKey && (
                      <button type="button" className="btn ghost" disabled={kBusy === 'tmdb'} onClick={() => clearKeys('tmdb')} title="Remove key">Remove</button>
                    )}
                  </div>
                  
                  {kMsg['tmdb'] && (
                    <div className={'look-status ' + (kMsg['tmdb'].ok ? 'ok' : 'bad')}>
                      <Icon n={kMsg['tmdb'].ok ? 'check' : 'info'} s={14} />
                      <span>{kMsg['tmdb'].text}</span>
                    </div>
                  )}
                </div>

                <div className="look-divider" />

                <div className="look-toggle-row">
                  <div>
                    <b>Show posters instead of thumbnails</b>
                    <small className="muted">Replaces the default video frame with a beautiful poster from TMDB</small>
                  </div>
                  <Toggle on={s.posters} label="Posters" onClick={() => set({ posters: !s.posters })} />
                </div>

                <div className="look-divider" />

                <div className="look-stat">
                  <div className="look-stat-ico"><Icon n="activity" s={18} /></div>
                  <div className="look-stat-text">
                    <span className="muted small">Watching so far</span>
                    <b>{hours.toFixed(1)} hours · {finished} finished</b>
                  </div>
                </div>
              </div>
            </section>
          )}

          {cur === 'play' && (
            <section className="play-panel">
              <div className="play-grid-2">
                <div className="play-card">
                  <div className="play-card-h">
                    <div className="play-card-icon"><Icon n="gauge" s={18} /></div>
                    <div>
                      <h4>Default Quality</h4>
                      <p>Auto respects your Data Saver settings.</p>
                    </div>
                  </div>
                  <div className="play-chips" role="group" aria-label="Default quality">
                    {QUALITIES.filter((q) => q.id !== 'audio').map((q) => (
                      <button key={q.id} type="button" className={'play-chip' + (s.quality === q.id ? ' on' : '')} onClick={() => set({ quality: q.id })}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="play-card">
                  <div className="play-card-h">
                    <div className="play-card-icon"><Icon n="aspect" s={18} /></div>
                    <div>
                      <h4>Screen Shape</h4>
                      <p>How the picture fits your window.</p>
                    </div>
                  </div>
                  <div className="play-aspects">
                    {ASPECTS.map((a) => (
                      <button key={a.id} type="button" className={'play-aspect' + (s.aspect === a.id ? ' on' : '')} onClick={() => set({ aspect: a.id })} title={a.hint}>
                        <span className={'play-aspect-preview a-' + a.id.replace(':', '')} />
                        <span className="play-aspect-label">{a.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="play-grid-2">
                <div className="play-card">
                  <div className="play-card-h">
                    <div className="play-card-icon"><Icon n="bolt" s={18} /></div>
                    <div>
                      <h4>Power Saving</h4>
                      <p>Lowers the quality cap and turns off blur.</p>
                    </div>
                  </div>
                  <div className="play-seg" role="group" aria-label="Power saving">
                    {([{ id: 'off' as const, label: 'Off' },{ id: 'battery' as const, label: 'On battery' },{ id: 'on' as const, label: 'Always' }]).map((o) => (
                      <button key={o.id} type="button" className={s.eco === o.id ? 'on' : ''} onClick={() => set({ eco: o.id })}>{o.label}</button>
                    ))}
                  </div>
                </div>

                <div className="play-card">
                  <div className="play-card-h">
                    <div className="play-card-icon"><Icon n="sparkle" s={18} /></div>
                    <div>
                      <h4>Smart Features</h4>
                      <p>Intros, autoplay and background saving.</p>
                    </div>
                  </div>
                  <div className="play-toggles">
                    <div className="play-toggle-row"><div><b>Detect intros</b><small>Compares episodes once</small></div><Toggle on={s.autoIntro} label="Detect intros" onClick={() => set({ autoIntro: !s.autoIntro })} /></div>
                    <div className="play-toggle-row"><div><b>Show “Skip intro”</b><small>Only if chapters exist</small></div><Toggle on={s.skipIntro} label="Skip intro button" onClick={() => set({ skipIntro: !s.skipIntro })} /></div>
                    <div className="play-toggle-row"><div><b>Autoplay next</b><small>Play next automatically</small></div><Toggle on={s.autoNext} label="Autoplay next" onClick={() => set({ autoNext: !s.autoNext })} /></div>
                    <div className="play-toggle-row"><div><b>Pre-download next</b><small>Save next ep while you watch</small></div><Toggle on={s.predownload} label="Pre-download next" onClick={() => set({ predownload: !s.predownload })} /></div>
                  </div>
                </div>
              </div>

              <div className="play-grid-2">
                <div className="play-card">
                  <div className="play-card-h">
                    <div className="play-card-icon"><Icon n="volume" s={18} /></div>
                    <div>
                      <h4>Sound & Volume</h4>
                      <p>Above 100% a limiter keeps it clean.</p>
                    </div>
                  </div>
                  
                  <div className="play-field">
                    <div className="play-chips" role="group" aria-label="Maximum volume">
                      {MAX_VOLS.map((v) => (<button key={v} type="button" className={'play-chip' + (s.maxVol === v ? ' on' : '')} onClick={() => set({ maxVol: v })}>{v}%</button>))}
                    </div>
                    <div className="play-vol-preview" aria-hidden="true">
                      <div className="play-vol-bar">
                        <i style={{ width: `${Math.min(100, (s.maxVol / 500) * 100)}%` }} />
                        <span className="play-vol-boost" title="100% mark" />
                      </div>
                      <span className="play-vol-label">{s.maxVol}%</span>
                    </div>
                  </div>

                  <div className="play-toggles" style={{ marginTop: '16px' }}>
                    <div className="play-toggle-row"><div><b>Remember boost</b><small>Off: resets to 100% on startup</small></div><Toggle on={s.rememberBoost} label="Remember boost" onClick={() => set({ rememberBoost: !s.rememberBoost })} /></div>
                  </div>

                  <div className="play-field" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                    <div className="play-field-label"><b>Default equalizer</b></div>
                    <div className="play-eq" role="group" aria-label="Default equalizer">
                      {Object.keys(EQ_PRESETS).map((n) => (<button key={n} type="button" className={'play-eq-chip' + (s.eqPreset === n ? ' on' : '')} onClick={() => set({ eqPreset: n })}>{n}</button>))}
                    </div>
                  </div>
                </div>

                {bridge && (
                  <div className="play-card">
                    <div className="play-card-h">
                      <div className="play-card-icon"><Icon n="external" s={18} /></div>
                      <div>
                        <h4>External Player</h4>
                        <p>Open videos in VLC or MPV.</p>
                      </div>
                    </div>
                    <div className="play-field" style={{ paddingTop: 0 }}>
                      <div className="play-field-label"><b>Application path</b><small>Leave empty for system default</small></div>
                      <span className="inline">
                        <input value={s.externalPlayer} onChange={(e) => set({ externalPlayer: e.target.value })} placeholder="C:\Program Files\VideoLAN\VLC\vlc.exe" />
                        <button className="btn ghost" onClick={() => browse('player')}>Browse…</button>
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {cur === 'subs' && (
            <section className="subs-panel">
              <div className="subs-grid">
                <div className="subs-col">
                  <div className="sub-card">
                    <div className="sub-card-h">
                      <div className="sub-card-icon"><Icon n="cc" s={18} /></div>
                      <div>
                        <h4>Behaviour</h4>
                        <p>When and how subtitles appear.</p>
                      </div>
                    </div>
                    <div className="sub-toggles">
                      <div className="sub-toggle-row">
                        <div><b>Turn on automatically</b><small>Picks a track in your language inside the video</small></div>
                        <Toggle on={s.autoSub} label="Auto subtitles" onClick={() => set({ autoSub: !s.autoSub })} />
                      </div>
                      <div className="sub-toggle-row">
                        <div><b>Smart matching</b><small>Skip if the audio is already in your language</small></div>
                        <Toggle on={s.subSmart} label="Skip when audio matches" onClick={() => set({ subSmart: !s.subSmart })} />
                      </div>
                    </div>
                  </div>

                  <div className="sub-card">
                    <div className="sub-card-h">
                      <div className="sub-card-icon"><Icon n="search" s={18} /></div>
                      <div>
                        <h4>Language</h4>
                        <p>Your preferred subtitle language.</p>
                      </div>
                    </div>
                    <div className="sub-langs">
                      {LANGS.map((l) => (
                        <button key={l.code} type="button" className={'sub-lang-btn' + (s.subLang === l.code ? ' on' : '')} onClick={() => set({ subLang: l.code })}>
                          {l.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="sub-card">
                    <div className="sub-card-h">
                      <div className="sub-card-icon"><Icon n="server" s={18} /></div>
                      <div>
                        <h4>OpenSubtitles API</h4>
                        <p>Download missing subtitles on demand.</p>
                      </div>
                    </div>
                    <div className="sub-api-form">
                      <input value={kd.os} onChange={(e) => setKd({ ...kd, os: e.target.value })} placeholder="API Key" autoComplete="off" spellCheck={false} />
                      <div className="sub-api-row">
                        <input value={kd.user} onChange={(e) => setKd({ ...kd, user: e.target.value })} placeholder="Username (optional)" autoComplete="off" />
                        <input type="password" value={osPass} onChange={(e) => setOsPass(e.target.value)} placeholder={srv?.hasOsPass ? 'Password saved' : 'Password (optional)'} autoComplete="new-password" />
                      </div>
                      <div className="sub-api-status">
                        {kMsg['os'] ? (
                          <span className={'look-status ' + (kMsg['os'].ok ? 'ok' : 'bad')}>
                            <Icon n={kMsg['os'].ok ? 'check' : 'info'} s={14} /> <span>{kMsg['os'].text}</span>
                          </span>
                        ) : (
                          <span className={'kstat ' + ((srv?.osKey || srv?.hasOsPass) ? 'ok' : 'idle')}>
                            {(srv?.osKey || srv?.hasOsPass) ? '✓ Key saved. Press “Save & test” to verify.' : 'Not set yet'}
                          </span>
                        )}
                      </div>
                      <div className="sub-api-actions">
                        <button className="btn" disabled={kBusy === 'os' || !kd.os.trim()} onClick={() => saveTest('os')}>{kBusy === 'os' ? 'Checking…' : 'Save & test'}</button>
                        <button className="btn ghost" disabled={kBusy === 'os'} onClick={() => clearKeys('os')}>Remove</button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="subs-col">
                  <div className="sub-card sub-studio-card">
                    <div className="sub-card-h">
                      <div className="sub-card-icon"><Icon n="eye" s={18} /></div>
                      <div>
                        <h4>Live Appearance</h4>
                        <p>Real-time preview of your styling.</p>
                      </div>
                    </div>
                    <div className="sub-preview">
                      <div className="sub-preview-video">
                        <div className="sub-preview-text" style={{
                          fontSize: Math.min(s.subSize, 44),
                          color: s.subColor,
                          background: `rgba(0,0,0,${s.subBg / 100})`,
                          textShadow: s.subOutline ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 6px #000' : undefined,
                          bottom: `${s.subPos}%`
                        }}>
                          This is how your subtitles will look.
                        </div>
                      </div>
                    </div>
                    <div className="sub-studio-controls">
                      <div className="sub-slider">
                        <div className="sub-slider-h"><b>Size</b><span>{s.subSize}px</span></div>
                        <input type="range" min={16} max={60} value={s.subSize} onChange={(e) => set({ subSize: +e.target.value })} />
                      </div>
                      <div className="sub-slider">
                        <div className="sub-slider-h"><b>Background Darkness</b><span>{s.subBg}%</span></div>
                        <input type="range" min={0} max={100} value={s.subBg} onChange={(e) => set({ subBg: +e.target.value })} />
                      </div>
                      <div className="sub-slider">
                        <div className="sub-slider-h"><b>Distance from bottom</b><span>{s.subPos}%</span></div>
                        <input type="range" min={2} max={30} value={s.subPos} onChange={(e) => set({ subPos: +e.target.value })} />
                      </div>
                      
                      <div className="sub-color-row">
                        <b>Text Colour</b>
                        <div className="sub-swatches">
                          {['#ffffff', '#fbbf24', '#60a5fa', '#4ade80', '#f472b6', '#a78bfa'].map((c) => (
                            <button key={c} type="button" className={'sub-swatch' + (s.subColor.toLowerCase() === c ? ' on' : '')} style={{ background: c }} onClick={() => set({ subColor: c })} aria-label={c} />
                          ))}
                          <label className="sub-custom-color" title="Custom colour">
                            <input type="color" value={s.subColor} onChange={(e) => set({ subColor: e.target.value })} />
                          </label>
                        </div>
                      </div>

                      <div className="sub-toggle-row" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                        <div><b>Text Outline</b><small>Black stroke around the letters for better contrast</small></div>
                        <Toggle on={s.subOutline} label="Outline" onClick={() => set({ subOutline: !s.subOutline })} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {cur === 'data' && (
            <section className="data-panel">
              <div className="data-grid">
                <div className="data-col">
                  <div className="data-card">
                    <div className="data-card-h">
                      <div className="data-card-icon"><Icon n="bolt" s={18} /></div>
                      <div>
                        <h4>Data Saver</h4>
                        <p>Cap the quality to save mobile data.</p>
                      </div>
                    </div>
                    <div className="data-saver-grid">
                      {SAVER.map((o) => (
                        <button key={o.id} type="button" className={'data-saver-opt' + (s.saver === o.id ? ' on' : '')} onClick={() => set({ saver: o.id })}>
                          <b>{o.label}</b>
                          <small>{o.hint}</small>
                        </button>
                      ))}
                    </div>
                    <div className="data-toggle-row" style={{ marginTop: 12 }}>
                      <div><b>Auto-switch to Low at 80%</b><small>Prevents going over your budget</small></div>
                      <Toggle on={s.saverAuto} label="Auto Data Saver" onClick={() => set({ saverAuto: !s.saverAuto })} />
                    </div>
                  </div>

                  <div className="data-card">
                    <div className="data-card-h">
                      <div className="data-card-icon"><Icon n="activity" s={18} /></div>
                      <div>
                        <h4>Monthly Budget</h4>
                        <p>Counts streaming and downloads.</p>
                      </div>
                    </div>
                    <div className="data-budget-input">
                      <input type="number" min={0} value={srv?.budgetGB || 0} onChange={(e) => patch({ budgetGB: Math.max(0, +e.target.value) })} />
                      <span>GB</span>
                    </div>
                    <div className="data-budget-presets">
                      {[0, 10, 50, 100, 250, 500].map((g) => (
                        <button key={g} type="button" className={'data-chip' + ((srv?.budgetGB || 0) === g ? ' on' : '')} onClick={() => patch({ budgetGB: g })}>
                          {g === 0 ? 'No limit' : `${g} GB`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="data-col">
                  <div className="data-card">
                    <div className="data-card-h">
                      <div className="data-card-icon"><Icon n="gauge" s={18} /></div>
                      <div>
                        <h4>Network Speed Test</h4>
                        <p>Check the real speed from the server.</p>
                      </div>
                    </div>
                    <div className="data-test">
                      {t.running ? (
                        <div className="data-live">
                          <b>{rate(t.live)}</b> <small>{mbps(t.live)}</small>
                          <button className="btn ghost" onClick={() => ctl.current?.abort()}>Stop</button>
                        </div>
                      ) : t.res ? (
                        <div className="data-result">
                          <div className="data-result-row"><span>Average</span><b>{rate(t.res.avg)} <small>{mbps(t.res.avg)}</small></b></div>
                          <div className="data-result-row"><span>Peak</span><b>{rate(t.res.peak)} <small>{mbps(t.res.peak)}</small></b></div>
                          <div className="data-result-row"><span>Data used</span><b>{bytes(t.res.bytes)}</b></div>
                          <button className="btn" onClick={run}>Test again</button>
                        </div>
                      ) : (
                        <div className="data-test-start">
                          <p className="muted small">Tests the actual download speed from your server to this laptop.</p>
                          <button className="btn" onClick={run}>Start speed test</button>
                        </div>
                      )}
                      {t.err && <p className="err-t">{t.err}</p>}
                    </div>
                  </div>

                  <div className="data-card">
                    <div className="data-card-h">
                      <div className="data-card-icon"><Icon n="info" s={18} /></div>
                      <div>
                        <h4>About Data Usage</h4>
                        <p>How Cinema counts your data.</p>
                      </div>
                    </div>
                    <p className="muted small" style={{ lineHeight: 1.5 }}>
                      Data is measured on the server. It counts every byte streamed to this laptop, including the speed test. Original quality uses the least data because no conversion is needed.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}

          {cur === 'offline' && (
            <section className="off-panel">
              <div className="off-grid">
                <div className="off-col">
                  <div className="off-card">
                    <div className="off-card-h">
                      <div className="off-card-icon"><Icon n="hdd" s={18} /></div>
                      <div>
                        <h4>Storage Location</h4>
                        <p>Where offline videos are saved.</p>
                      </div>
                    </div>
                    <div className="off-path" title={srv?.downloadDir || 'Default path'}>
                      {moveMsg || (srv?.downloadDir ? srv.downloadDir : 'Choose where downloads are saved')}
                    </div>
                    <div className="off-actions">
                      {bridge && <button className="btn ghost" onClick={() => browse('folder')}>Change folder…</button>}
                      <button className="btn ghost" onClick={async () => { setMoveMsg('Moving…'); const e = await moveDownloads('vault', setMoveMsg); setMoveMsg(e ?? 'Done. Saved videos now live in a hidden folder inside the app’s own data.'); patch({}); }}>Private storage</button>
                      <button className="btn ghost" onClick={onStorage}><Icon n="hdd" s={15} /> Storage</button>
                      <button className="btn ghost" onClick={onTidy}>Tidy videos</button>
                    </div>
                    <div className="off-toggle-row" style={{ marginTop: 12 }}>
                      <div><b>Save while I watch</b><small>Keeps a full-quality copy so next time it plays offline</small></div>
                      <Toggle on={s.autoCache} label="Save while watching" onClick={() => set({ autoCache: !s.autoCache })} />
                    </div>
                  </div>

                  <div className="off-card">
                    <div className="off-card-h">
                      <div className="off-card-icon"><Icon n="activity" s={18} /></div>
                      <div>
                        <h4>Space Management</h4>
                        <p>Your copies on the server are never deleted.</p>
                      </div>
                    </div>
                    <div className="off-field">
                      <div className="off-field-label"><b>Limit saved videos to</b><small>When full, watched videos are removed first, then oldest</small></div>
                      <div className="off-chips" role="group">
                        {[0, 2, 5, 10, 20, 50].map((n) => (<button key={n} type="button" className={'off-chip' + ((srv?.quotaGB ?? 0) === n ? ' on' : '')} onClick={() => patch({ quotaGB: n })}>{n === 0 ? 'No limit' : `${n} GB`}</button>))}
                      </div>
                    </div>
                    <div className="off-field">
                      <div className="off-field-label"><b>Delete watched after</b><small>Frees space automatically</small></div>
                      <div className="off-chips" role="group">
                        {[0, 1, 3, 7, 14, 30].map((n) => (<button key={n} type="button" className={'off-chip' + ((srv?.autoDeleteDays ?? 0) === n ? ' on' : '')} onClick={() => patch({ autoDeleteDays: n })}>{n === 0 ? 'Never' : `${n} day${n > 1 ? 's' : ''}`}</button>))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="off-col">
                  <div className="off-card">
                    <div className="off-card-h">
                      <div className="off-card-icon"><Icon n="down" s={18} /></div>
                      <div>
                        <h4>Download Behaviour</h4>
                        <p>Speed, parallel files and schedule.</p>
                      </div>
                    </div>
                    <div className="off-field">
                      <div className="off-field-label"><b>Files at the same time</b></div>
                      <div className="off-chips" role="group">
                        {[1, 2, 3, 4, 6].map((n) => (<button key={n} type="button" className={'off-chip' + ((srv?.maxParallel ?? 2) === n ? ' on' : '')} onClick={() => patch({ maxParallel: n })}>{n}</button>))}
                      </div>
                    </div>
                    <div className="off-field">
                      <div className="off-field-label"><b>Speed limit</b><small>Keeps some bandwidth for other things</small></div>
                      <div className="off-chips" role="group">
                        {LIMITS.map((n) => (<button key={n} type="button" className={'off-chip' + ((srv?.limitKBps ?? 0) === n ? ' on' : '')} onClick={() => patch({ limitKBps: n })}>{n ? rate(n * 1024) : 'No limit'}</button>))}
                      </div>
                    </div>
                    <div className="off-toggles">
                      <div className="off-toggle-row"><div><b>Only download at night</b><small>Downloads wait until the time window opens</small></div><Toggle on={!!srv?.schedule.on} label="Schedule" onClick={() => patch({ schedule: { ...srv!.schedule, on: !srv?.schedule.on } })} /></div>
                      {srv?.schedule.on && (
                        <div className="off-time-row">
                          <span className="muted">Between</span>
                          <input type="time" value={srv.schedule.from} onChange={(e) => patch({ schedule: { ...srv.schedule, from: e.target.value } })} />
                          <span className="muted">and</span>
                          <input type="time" value={srv.schedule.to} onChange={(e) => patch({ schedule: { ...srv.schedule, to: e.target.value } })} />
                        </div>
                      )}
                      <div className="off-toggle-row"><div><b>Pause on battery</b><small>Downloads wait until the laptop is plugged in</small></div><Toggle on={!!srv?.pauseOnBattery} label="Pause on battery" onClick={() => patch({ pauseOnBattery: !srv?.pauseOnBattery })} /></div>
                      <div className="off-toggle-row"><div><b>Pause on metered connection</b><small>If Windows marks Wi-Fi as metered</small></div><Toggle on={!!srv?.pauseOnMetered} label="Pause on metered" onClick={() => patch({ pauseOnMetered: !srv?.pauseOnMetered })} /></div>
                      <div className="off-toggle-row"><div><b>Slow down at certain hours</b><small>Limit speed between two times</small></div><Toggle on={!!srv?.limitWin?.on} label="Slow down" onClick={() => patch({ limitWin: { ...(srv?.limitWin ?? { from: '18:00', to: '23:00', kbps: 2000 }), on: !srv?.limitWin?.on } })} /></div>
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
                  </div>

                  <div className="off-card">
                    <div className="off-card-h">
                      <div className="off-card-icon"><Icon n="sparkle" s={18} /></div>
                      <div>
                        <h4>Compression</h4>
                        <p>Where and how files are made smaller.</p>
                      </div>
                    </div>
                    <div className="off-field">
                      <div className="off-field-label"><b>Compress on</b><small className="muted">Laptop GPU is usually much faster</small></div>
                      <div className="off-seg" role="group">
                        {([{ id: 'auto', label: 'Auto' },{ id: 'laptop', label: 'This laptop' },{ id: 'server', label: 'Server' }] as const).map((o) => (
                          <button key={o.id} type="button" className={(srv?.encodeWhere ?? 'auto') === o.id ? 'on' : ''} onClick={() => patch({ encodeWhere: o.id })}>{o.label}</button>
                        ))}
                      </div>
                    </div>
                    <div className="off-field">
                      <div className="off-field-label"><b>Compression speed</b><small className="muted">Fastest = bigger files. Smallest = takes longer</small></div>
                      <div className="off-seg" role="group">
                        {([{ id: 'fast', label: 'Fastest' },{ id: 'balanced', label: 'Balanced' },{ id: 'small', label: 'Smallest' }] as const).map((o) => (
                          <button key={o.id} type="button" className={(srv?.encodeSpeed ?? 'fast') === o.id ? 'on' : ''} onClick={() => patch({ encodeSpeed: o.id })}>{o.label}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {cur === 'app' && (
            <section className="app-panel">
              <div className="app-grid">
                {/* ================= LEFT COLUMN ================= */}
                <div className="app-col">
                  
                  {/* Servers */}
                  <div className="app-card">
                    <div className="app-card-h">
                      <div className="app-card-icon"><Icon n="server" s={18} /></div>
                      <div>
                        <h4>Servers</h4>
                        <p>Where your movies are stored and streamed from.</p>
                      </div>
                    </div>
                    
                    <div className="app-action-row">
                      <div>
                        <b>Connections</b>
                        <small className="muted">Add or manage your VPS and local folders.</small>
                      </div>
                      <button className="btn ghost" onClick={onServers}>
                        Manage servers
                      </button>
                    </div>

                    <ServerTools />
                  </div>

                  {/* App Behaviour */}
                  <div className="app-card">
                    <div className="app-card-h">
                      <div className="app-card-icon"><Icon n="info" s={18} /></div>
                      <div>
                        <h4>App Behaviour</h4>
                        <p>System integration and version.</p>
                      </div>
                    </div>
                    
                    {bridge ? (
                      <div className="app-action-row">
                        <div>
                          <b>Start on sign in</b>
                          <small className="muted">Runs quietly in the tray for scheduled downloads.</small>
                        </div>
                        <Toggle on={login} label="Start with Windows" onClick={() => bridge?.loginItemSet?.(!login).then(setLogin)} />
                      </div>
                    ) : (
                      <p className="muted small">Available in the installed app.</p>
                    )}
                    
                    <div className="app-action-row">
                      <div>
                        <b>Version</b>
                        <small className="muted">{bridge ? `Cinema for Windows v${bridge.version}` : 'Cinema Web'}</small>
                      </div>
                    </div>
                  </div>

                  {/* Updates */}
                  {bridge && (
                    <div className="app-card">
                      <div className="app-card-h">
                        <div className="app-card-icon"><Icon n="cloud" s={18} /></div>
                        <div>
                          <h4>Updates</h4>
                          <p>Keep Cinema up to date.</p>
                        </div>
                      </div>
                      <Updates />
                    </div>
                  )}
                </div>

                {/* ================= RIGHT COLUMN ================= */}
                <div className="app-col">
                  
                  {/* Remote */}
                  <div className="app-card">
                    <div className="app-card-h">
                      <div className="app-card-icon"><Icon n="cast" s={18} /></div>
                      <div>
                        <h4>Phone & TV Remote</h4>
                        <p>Control playback from your phone.</p>
                      </div>
                    </div>
                    <RemoteBlock />
                  </div>

                  {/* Profiles */}
                  <div className="app-card">
                    <div className="app-card-h">
                      <div className="app-card-icon"><Icon n="eye" s={18} /></div>
                      <div>
                        <h4>Profiles</h4>
                        <p>Separate watch history and lists.</p>
                      </div>
                    </div>
                    <ProfilesBlock />
                  </div>

                  {/* Backup */}
                  <div className="app-card">
                    <div className="app-card-h">
                      <div className="app-card-icon"><Icon n="save" s={18} /></div>
                      <div>
                        <h4>Backup</h4>
                        <p>Save or restore your data.</p>
                      </div>
                    </div>
                    <BackupBlock clientSettings={s} restoreClient={() => {}} />
                  </div>
                </div>

              </div>
            </section>
          )}

          {cur === 'bot' && (
            <section className="look-panel">
              <div className="look-block">
                <div className="look-block-h">
                  <h4>Connection</h4>
                  <p className="muted small">Point the app to your Telegram bot.</p>
                </div>
                <div className="app-inner">
                  <div className="s-field">
                    <div className="s-field-label">
                      <b>API URL</b>
                      <small>e.g. http://51.21.221.236:8080</small>
                    </div>
                    <input value={s.botApiUrl} onChange={(e) => { set({ botApiUrl: e.target.value }); setBotTest('idle'); }} placeholder="http://ip:port" autoComplete="off" />
                  </div>
                  <div className="s-field">
                    <div className="s-field-label">
                      <b>API Key</b>
                      <small>From BOT_API_KEY in your .env</small>
                    </div>
                    <input type="password" value={s.botApiKey} onChange={(e) => { set({ botApiKey: e.target.value }); setBotTest('idle'); }} autoComplete="new-password" />
                  </div>
                  <div className="s-field" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                    <div className="s-field-label">
                      <b>Telegram User ID</b>
                      <small>Your numeric Telegram ID</small>
                    </div>
                    <input value={s.telegramId} onChange={(e) => { set({ telegramId: e.target.value }); setBotTest('idle'); }} autoComplete="off" />
                  </div>
                </div>
              </div>

              <div className="look-block">
                <div className="look-block-h">
                  <h4>Test Connection</h4>
                  <p className="muted small">Ensure the bot is running and the key is correct.</p>
                </div>
                <div className="app-btn-row" style={{ marginTop: 0 }}>
                  <button type="button" className="btn" onClick={testBot} disabled={botTest === 'testing'}>
                    {botTest === 'testing' ? 'Testing…' : 'Test Now'}
                  </button>
                </div>
                {botTest === 'ok' && (
                  <div className="look-status ok" style={{ marginTop: '16px' }}>
                    <Icon n="check" s={16} /> Connection successful!
                  </div>
                )}
                {botTest === 'error' && (
                  <div className="look-status bad" style={{ marginTop: '16px' }}>
                    <Icon n="close" s={16} /> {botErr}
                  </div>
                )}
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  );
}