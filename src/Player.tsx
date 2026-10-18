import Hls from 'hls.js';
import { CSSProperties, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AudioRig, EQ_FLAT, EQ_LABELS, EQ_PRESETS, isNeutral } from './audio';
import {
  APP_NAME, ASPECTS, Bookmark, Caps, Cue, Fx, Icon, Info, LANGS, PrefsCtx, Prog, QUALITIES, SAVER, SPEEDS, SettingsCtx,
  api, bridge, bytes, clock, join, mbps, parseCues, parseTitle, qs, rate, useNet,
} from './lib';

type MenuId = 'quality' | 'speed' | 'aspect' | 'subs' | 'audio' | 'sound' | 'picture' | 'more';
type Sprite = { interval: number; cols: number; rows: number; w: number; h: number; count: number; url: string };
type Ai = { available: boolean; state: string; elapsed: number; error?: string };
type OsHit = { id: number; name: string; lang: string; downloads: number };
type Props = {
  root: number; dir: string; name: string; videos: string[]; pkey: string; saved?: Prog;
  offline: boolean; opened?: boolean; saver: number; caps: Caps | null; playlist?: boolean;
  floating?: boolean; onFloat?: (on: boolean) => void;
  onClose: () => void; onNext: (n: string) => void; onDelete: (n: string) => void;
  onDownload?: (n: string) => void; onStarted?: (n: string) => void;
};

// Volume (and boost) survives from one video to the next while the app stays open.
let sessionVol: number | undefined;

const Slider = ({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label?: string }) => (
  <input type="range" className="slider" min={min} max={max} step={step} value={value} aria-label={label}
    onChange={(e) => onChange(+e.target.value)} onPointerUp={(e) => e.currentTarget.blur()} />
);
const Opt = ({ on, label, hint, onClick }: { on?: boolean; label: string; hint?: string; onClick: () => void }) => (
  <button className={on ? 'opt on' : 'opt'} onClick={onClick}>
    <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
    {on && <Icon n="check" s={16} />}
  </button>
);
const Switch = ({ on, label, hint, onClick }: { on: boolean; label: string; hint?: string; onClick: () => void }) => (
  <button className="opt" role="switch" aria-checked={on} onClick={onClick}>
    <span><b>{label}</b>{hint && <small>{hint}</small>}</span><i className={on ? 'sw on' : 'sw'} />
  </button>
);
const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="mrow"><span>{label}</span>{children}</label>
);

export default function Player(p: Props) {
  const { s, set } = useContext(SettingsCtx);
  const { prefs, setPref } = useContext(PrefsCtx);
  const path = join(p.dir, p.name);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const vref = useRef<HTMLVideoElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const last = useRef({ pos: 0, dur: 0 });
  const totalRef = useRef(0);
  const idle = useRef<number>();
  const tt = useRef<number>();
  const rig = useRef<AudioRig | null>(null);
  const subTouched = useRef(false);
  const lastSub = useRef('off');
  const upCues = useRef<Cue[]>([]);
  const hlsRef = useRef<Hls | null>(null);
  const stalls = useRef<number[]>([]);
  const lastSeek = useRef(0);
  const dismissed = useRef(false);
  const everPlayed = useRef(false);
  const startedFired = useRef(false);

  const ds = p.saver;
  const [sid] = useState(() => Math.random().toString(36).slice(2, 12));
  const [start] = useState(() => (p.saved && !p.saved.watched && p.saved.pos > 10 ? Math.max(0, p.saved.pos - 3) : 0));
  const [q, setQ] = useState(() => {
    if (p.offline) return ['orig', 'remux', 'audio'].includes(s.quality) ? s.quality : 'orig';
    return ds > 0 && s.quality === 'orig' ? 'auto' : s.quality;
  });
  const [speed, setSpeed] = useState(s.speed);
  const [offset, setOffset] = useState(q === 'remux' || q === 'audio' ? Math.floor(start) : 0);
  const resume = useRef(q === 'remux' || q === 'audio' ? 0 : start);
  const [pos, setPos] = useState(start);
  const [buf, setBuf] = useState(0);
  const [a, setA] = useState(0);
  const [info, setInfo] = useState<Info>({ duration: 0 });
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const maxVol = Math.max(1, s.maxVol / 100);
  const [vol, setVol] = useState(() => Math.min(maxVol, sessionVol ?? (s.rememberBoost ? s.vol : Math.min(1, s.vol))));
  const [muted, setMuted] = useState(false);
  const [ui, setUi] = useState(true);
  const [menu, setMenu] = useState<MenuId | null>(null);
  const [stats, setStats] = useState(false);
  const [aspect, setAspect] = useState(s.aspect);
  const [zoom, setZoom] = useState(100);
  const [pic, setPic] = useState({ b: 100, c: 100, s: 100, h: 0 });
  const [rot, setRot] = useState(0);
  const [flip, setFlip] = useState(false);
  const saved = prefs.audio?.[p.pkey];
  const [eq, setEq] = useState<number[]>(saved?.eq ?? EQ_PRESETS[s.eqPreset] ?? EQ_FLAT);
  const [dialogue, setDialogue] = useState(saved?.dialogue ?? false);
  const [night, setNight] = useState(saved?.night ?? false);
  const [mono, setMono] = useState(saved?.mono ?? false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [sink, setSink] = useState('default');
  const [sleep, setSleep] = useState<number | 'end' | null>(null);
  const [sub, setSub] = useState('off');
  const [cues, setCues] = useState<Cue[]>([]);
  const [subBusy, setSubBusy] = useState(false);
  const [subErr, setSubErr] = useState('');
  const [delay, setDelay] = useState(0);
  const [ai, setAi] = useState<Ai>({ available: false, state: 'none', elapsed: 0 });
  const [os, setOs] = useState<{ open: boolean; busy: boolean; err: string; hits: OsHit[] }>({ open: false, busy: false, err: '', hits: [] });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [fs, setFs] = useState(false);
  const [mini, setMini] = useState(false);
  const [toast, setToast] = useState('');
  const [hlsH, setHlsH] = useState(0);
  const [est, setEst] = useState(0);
  const [wantSprite, setWantSprite] = useState(false);
  const [sprite, setSprite] = useState<Sprite | null>(null);
  const [barW, setBarW] = useState(0);
  const [suggest, setSuggest] = useState(false);
  const [noNext, setNoNext] = useState(false);
  const [ab, setAb] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const net = useNet(sid, 1000);
  // "Save while watching": the original is copied to this laptop in the background; the bar shows how much is saved.
  const [cache, setCache] = useState<{ state: string; frac: number }>({ state: 'none', frac: 0 });
  const startCache = () => {
    if (p.offline || p.opened || !s.autoCache || ds > 0) return; // Data Saver on: never spend extra data on a copy
    fetch('/api/dl/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: p.root, paths: [path], profile: 'orig', opts: {} }) }).catch(() => {});
  };
  useEffect(() => {
    if (p.offline || p.opened) return;
    let dead = false;
    const tick = async () => {
      try {
        const j = await api<{ state: string; done?: number; size?: number }>('saved', { root: p.root, path });
        if (!dead) setCache({ state: j.state, frac: j.state === 'done' ? 1 : j.size ? Math.min(1, (j.done ?? 0) / j.size) : 0 });
      } catch { /* server not reachable */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { dead = true; clearInterval(t); };
  }, [p.root, path, p.offline, p.opened]);
  const cachedFrac = p.offline && !p.opened ? 1 : cache.frac;

  const hlsMode = !p.offline && q !== 'orig' && q !== 'remux' && q !== 'audio'; // auto or a locked size: adaptive HLS
  const offsetMode = q === 'remux' || q === 'audio';                             // piped stream: seeking restarts it at an offset
  const nativeHls = hlsMode && !Hls.isSupported() && document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
  const vd = vref.current?.duration;
  const total = !offsetMode && vd && Number.isFinite(vd) ? vd : info.duration || 0;
  totalRef.current = total;
  const idx = p.videos.indexOf(p.name);
  const next = idx >= 0 ? p.videos[idx + 1] : undefined;
  const show = ui || !!menu || !playing || scrub !== null;
  const chapters = info.chapters ?? [];
  const bookmarks: Bookmark[] = prefs.bookmarks?.[p.pkey] ?? [];
  const title = parseTitle(p.name);

  const flash = (m: string) => { setToast(m); clearTimeout(tt.current); tt.current = window.setTimeout(() => setToast(''), 2600); };
  const wake = useCallback(() => {
    setUi(true);
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setUi(false), 3000);
  }, []);
  useEffect(() => { wake(); return () => { clearTimeout(idle.current); clearTimeout(tt.current); }; }, [wake]);

  const post = (watched?: boolean) => {
    if (!last.current.pos && watched === undefined) return;
    fetch('/api/progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: p.pkey, pos: last.current.pos, dur: last.current.dur, watched }) }).catch(() => {});
  };
  useEffect(() => {
    const t = setInterval(() => post(), 10000);
    return () => { clearInterval(t); post(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api<Info>('info', { root: p.root, path }).then(setInfo).catch(() => {}); }, [path, p.root]);

  // position, buffer and play state (4x per second), plus the A-B loop
  useEffect(() => {
    const t = setInterval(() => {
      const v = vref.current;
      if (!v) return;
      const now = offset + v.currentTime;
      setPos(now);
      last.current = { pos: now, dur: totalRef.current };
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) end = v.buffered.end(i);
      setBuf(offset + end);
      setEst(hlsRef.current?.bandwidthEstimate ?? 0);
      if (ab.a !== null && ab.b !== null && now >= ab.b) seekTo(ab.a);
    }, 250);
    return () => clearInterval(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const f = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

  // ----- seeking / reloading -----
  const seekTo = (t: number) => {
    const tot = totalRef.current;
    t = Math.max(0, tot ? Math.min(t, tot - 0.5) : t);
    lastSeek.current = Date.now();
    if (offsetMode) { setOffset(Math.floor(t)); setPos(t); setFailed(false); setBuffering(true); }
    else if (vref.current) { vref.current.currentTime = t; setPos(t); }
  };
  const reload = (o: { q?: string; a?: number }, persist = true) => {
    const t = offset + (vref.current?.currentTime ?? 0), nq = o.q ?? q;
    const off = nq === 'remux' || nq === 'audio';
    resume.current = off ? 0 : t;
    setOffset(off ? Math.floor(t) : 0);
    if (o.q !== undefined) { setQ(nq); if (persist && nq !== 'audio') set({ quality: nq }); } // audio-only is a one-off, never the default
    if (o.a !== undefined) setA(o.a);
    setFailed(false); setBuffering(true); setSuggest(false); setHlsH(0);
  };

  const src = `/api/stream?${qs({ root: p.root, path, q, t: offset, a, sid })}`;
  // Locked sizes load every size and pick one in the player, so changing size keeps what is already buffered.
  const mq = q === 'auto' ? 'auto' : 'all';
  const masterUrl = `/api/hls/master.m3u8?${qs({ root: p.root, path, q: mq, a, ds, sid })}`;
  const vkey = hlsMode ? `hls:${mq}:${a}:${ds}` : src;
  const qRef = useRef(q); qRef.current = q;
  const applySize = (h: Hls) => {
    if (qRef.current === 'auto') { h.loadLevel = -1; return; }
    const want = Number(qRef.current); let idx = -1;
    h.levels.forEach((l, i) => { if (l.height <= want && (idx < 0 || l.height > h.levels[idx].height)) idx = i; });
    h.loadLevel = idx < 0 ? 0 : idx;
  };
  useEffect(() => { if (hlsRef.current?.levels?.length) applySize(hlsRef.current); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hlsMode || nativeHls) return;
    const v = vref.current;
    if (!v) return;
    const hls = new Hls({
      startPosition: resume.current > 0 ? resume.current : -1,
      capLevelToPlayerSize: true,                        // no point converting to 1080p for a small window
      abrEwmaDefaultEstimate: ds ? 1_500_000 : 8_000_000, // Data Saver starts low; otherwise start high and adapt
      maxBufferLength: ds ? 20 : 40, backBufferLength: ds ? 10 : 30,
    });
    hlsRef.current = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => applySize(hls));
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => setHlsH(hls.levels[d.level]?.height ?? 0));
    let netTries = 0, mediaTries = 0;
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR && netTries++ < 3) hls.startLoad();
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaTries++ < 2) hls.recoverMediaError();
      else setFailed(true);
    });
    hls.loadSource(masterUrl);
    hls.attachMedia(v);
    return () => { hls.destroy(); hlsRef.current = null; };
  }, [hlsMode, nativeHls, masterUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  // Data Saver: stop downloading ahead while paused
  useEffect(() => {
    const h = hlsRef.current;
    if (!h || !ds || !everPlayed.current) return;
    if (playing) h.startLoad(); else h.stopLoad();
  }, [playing, ds]);

  // ----- sound: volume up to 500%, limiter, EQ, dialogue boost, night mode, mono, 5.1 downmix -----
  const channels = q === 'orig' ? info.audio?.[a]?.channels ?? info.channels ?? 2 : 2;
  const needRig = !isNeutral({ gain: Math.max(1, vol), eq, dialogue, night, mono, channels });
  useEffect(() => {
    const v = vref.current;
    if (!v) return;
    const plain = () => { v.volume = Math.min(1, vol); v.muted = muted; };
    if (!rig.current && !needRig) { plain(); return; }
    try {
      const r = rig.current ?? (rig.current = new AudioRig());
      r.attach(v);
      v.volume = 1; v.muted = muted; // from here on the volume is applied inside the audio chain
      r.apply({ gain: vol, eq, dialogue, night, mono, channels });
    } catch { plain(); }
  }, [vol, muted, eq, dialogue, night, mono, channels, vkey, needRig]);
  useEffect(() => { sessionVol = vol; }, [vol]);
  useEffect(() => () => { rig.current?.dispose(); }, []);
  const saveFx = (n: Partial<Fx>) => {
    const f: Fx = { eq, dialogue, night, mono, ...n };
    setPref('audio', { ...(prefs.audio ?? {}), [p.pkey]: f });
  };
  const updEq = (v: number[]) => { setEq(v); saveFx({ eq: v }); };
  const eqName = Object.entries(EQ_PRESETS).find(([, v]) => v.every((x, i) => x === eq[i]))?.[0] ?? 'Custom';
  const openSound = async () => {
    toggle('sound');
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')); } catch { /* no permission */ }
  };

  // ----- seek-bar preview sheet: built by the server on first use, then cached -----
  useEffect(() => {
    if (!wantSprite || sprite || ds >= 2) return;
    let dead = false, timer = 0;
    const poll = async () => {
      try {
        const j = await api<any>('sprite', { root: p.root, path });
        if (dead) return;
        if (j.state === 'ready') {
          const url = `/api/sprite?${qs({ root: p.root, path, img: 1 })}`;
          new Image().src = url;
          setSprite({ interval: j.interval, cols: j.cols, rows: j.rows, w: j.w, h: j.h, count: j.count, url });
          return;
        }
        if (j.state === 'error') return;
      } catch { return; }
      timer = window.setTimeout(poll, 3000);
    };
    poll();
    return () => { dead = true; clearTimeout(timer); };
  }, [wantSprite, sprite, p.root, path, ds]);

  // ----- subtitles -----
  const pickSub = (id: string) => {
    subTouched.current = true;
    if (id !== 'off') lastSub.current = id;
    setSub(id); setSubErr('');
    if (id === 'off') setCues([]);
  };
  useEffect(() => {
    if (sub === 'off') return;
    if (sub.startsWith('f:')) { setCues(upCues.current); return; }
    let dead = false;
    setSubBusy(true); setSubErr('');
    const params: Record<string, string | number> = { root: p.root, path };
    if (sub.startsWith('e:')) params.s = Number(sub.slice(2));
    else if (sub.startsWith('x:')) params.ext = sub.slice(2);
    else params.s = 'ai';
    fetch(`/api/subs?${qs(params)}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load subtitles'); return r.text(); })
      .then((t) => { if (dead) return; const c = parseCues(t); setCues(c); if (!c.length) setSubErr('This subtitle track is empty.'); })
      .catch((e) => { if (!dead) { setSubErr(e.message); setCues([]); } })
      .finally(() => { if (!dead) setSubBusy(false); });
    return () => { dead = true; };
  }, [sub, p.root, path]);

  // auto-select subtitles by language once the track list is known
  useEffect(() => {
    if (!s.autoSub || subTouched.current || sub !== 'off') return;
    const l = LANGS.find((x) => x.code === s.subLang);
    if (!l) return;
    const m = (t: string) => !!t && t.toLowerCase().split(/[^a-z]+/).some((x) => l.alts.includes(x));
    if (s.subSmart && m(info.audio?.[a]?.lang ?? '')) return; // already hearing this language
    const emb = (info.subs ?? []).filter((t) => m(t.lang) || m(t.label));
    const pick = emb.find((t) => !/forced/i.test(t.label)) ?? emb[0];
    if (pick) { lastSub.current = 'e:' + pick.i; setSub('e:' + pick.i); return; }
    const ex = (info.external ?? []).find((t) => m(t.lang));
    if (ex) { lastSub.current = 'x:' + ex.name; setSub('x:' + ex.name); }
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const pollAi = useCallback(async () => {
    try { const j = await api<Ai>('autosub', { root: p.root, path }); setAi(j); return j; } catch { return null; }
  }, [p.root, path]);
  useEffect(() => {
    if (!info.ai) return;
    pollAi().then((j) => { if (j?.state === 'done' && s.autoSub && !subTouched.current && lastSub.current === 'off') { lastSub.current = 'ai'; setSub('ai'); } });
  }, [info.ai]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ai.state !== 'running') return;
    const t = setInterval(async () => {
      const j = await pollAi();
      if (j?.state === 'done') { pickSub('ai'); flash('AI subtitles are ready'); }
    }, 4000);
    return () => clearInterval(t);
  }, [ai.state, pollAi]); // eslint-disable-line react-hooks/exhaustive-deps
  const genAi = async () => {
    try { await api('autosub', { root: p.root, path, lang: s.subLang }, 'POST'); } catch (e: any) { flash(e.message); }
    pollAi();
  };
  const useCuesFrom = (text: string, name: string) => {
    const c = parseCues(text);
    if (!c.length) { setSubErr('No subtitles found in that file.'); return false; }
    upCues.current = c;
    pickSub('f:' + name);
    setCues(c);
    return true;
  };
  const loadFile = async (f: File) => { useCuesFrom(await f.text(), f.name); };
  const toggleSubs = () => {
    if (sub !== 'off') return pickSub('off');
    const t = lastSub.current !== 'off' ? lastSub.current : info.subs?.[0] ? 'e:' + info.subs[0].i : info.external?.[0] ? 'x:' + info.external[0].name : '';
    t ? pickSub(t) : flash('No subtitles found for this video');
  };
  // online subtitle search (OpenSubtitles)
  const searchOs = async () => {
    setOs({ open: true, busy: true, err: '', hits: [] });
    try {
      const hits = await api<OsHit[]>('os/search', { q: title.title, lang: s.subLang, year: title.year, season: title.season, episode: title.episode });
      setOs({ open: true, busy: false, err: hits.length ? '' : 'Nothing found for this title.', hits });
    } catch (e: any) { setOs({ open: true, busy: false, err: e.message, hits: [] }); }
  };
  const getOs = async (h: OsHit) => {
    setOs((x) => ({ ...x, busy: true, err: '' }));
    try {
      const r = await fetch(`/api/os/get?id=${h.id}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed');
      if (useCuesFrom(await r.text(), h.name)) { setOs({ open: false, busy: false, err: '', hits: [] }); flash('Subtitles loaded'); }
      else setOs((x) => ({ ...x, busy: false }));
    } catch (e: any) { setOs((x) => ({ ...x, busy: false, err: e.message })); }
  };

  // ----- actions -----
  const onWaiting = () => {
    setBuffering(true);
    const v = vref.current;
    // Count real stalls only (not seeks) while playing the original; three in 90 s = offer Auto quality.
    if (!v || hlsMode || p.offline || v.currentTime < 3 || Date.now() - lastSeek.current < 3000) return;
    const now = Date.now();
    stalls.current = [...stalls.current.filter((x) => now - x < 90000), now];
    if (stalls.current.length >= 3 && !dismissed.current) setSuggest(true);
  };
  const togglePlay = () => { const v = vref.current; if (v) (v.paused ? v.play().catch(() => {}) : v.pause()); };
  const skip = (d: number) => seekTo(offset + (vref.current?.currentTime ?? 0) + d);
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (box.current?.requestFullscreen) box.current.requestFullscreen().catch(() => {});
    else (vref.current as any)?.webkitEnterFullscreen?.();
  };
  const pip = async () => {
    try {
      if ((document as any).pictureInPictureElement) await (document as any).exitPictureInPicture();
      else await (vref.current as any).requestPictureInPicture();
    } catch { flash('Picture-in-picture is not available here'); }
  };
  const shot = () => {
    const v = vref.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    try {
      c.getContext('2d')!.drawImage(v, 0, 0);
      c.toBlob((b) => {
        if (!b) return;
        const l = document.createElement('a');
        l.href = URL.createObjectURL(b);
        l.download = `${p.name.replace(/\.[^.]+$/, '')} ${clock(pos).replace(/:/g, '-')}.png`;
        l.click();
        setTimeout(() => URL.revokeObjectURL(l.href), 1000);
        flash('Screenshot saved');
      }, 'image/png');
    } catch { flash('Could not capture this frame'); }
  };
  const cycleAspect = () => { const i = ASPECTS.findIndex((x) => x.id === aspect); const n = ASPECTS[(i + 1) % ASPECTS.length]; setAspect(n.id); set({ aspect: n.id }); flash(`Screen: ${n.label}`); };
  const setSpd = (v: number) => { setSpeed(v); set({ speed: v }); if (vref.current) vref.current.playbackRate = v; };
  const stepFrame = (dir: 1 | -1) => {
    const v = vref.current;
    if (!v) return;
    v.pause();
    seekTo(offset + v.currentTime + dir / (info.fps && info.fps > 0 ? info.fps : 24));
  };
  const cycleAb = () => {
    const now = offset + (vref.current?.currentTime ?? 0);
    if (ab.a === null) { setAb({ a: now, b: null }); flash(`Loop start ${clock(now)}. Press B again for the end`); }
    else if (ab.b === null) { if (now > ab.a + 0.5) { setAb({ a: ab.a, b: now }); flash(`Looping ${clock(ab.a)} to ${clock(now)}`); } }
    else { setAb({ a: null, b: null }); flash('Loop off'); }
  };
  const addBookmark = () => {
    const t = Math.floor(offset + (vref.current?.currentTime ?? 0));
    const list = [...bookmarks, { t, label: `Bookmark at ${clock(t)}` }].sort((x, y) => x.t - y.t);
    setPref('bookmarks', { ...(prefs.bookmarks ?? {}), [p.pkey]: list });
    flash(`Bookmarked ${clock(t)}`);
  };
  const delBookmark = (t: number) => setPref('bookmarks', { ...(prefs.bookmarks ?? {}), [p.pkey]: bookmarks.filter((b) => b.t !== t) });
  const openOutside = async () => {
    if (!bridge) return;
    try {
      if (p.offline) { const { path: file } = await api<{ path: string }>('localpath', { root: p.root, path }); await bridge.openExternal(file, s.externalPlayer); }
      else await bridge.openStream(`/api/stream?${qs({ root: p.root, path, q: 'orig' })}`, s.externalPlayer);
      vref.current?.pause();
    } catch (e: any) { flash(e.message || 'Could not open the other player'); }
  };
  const toggleMini = async () => { if (!bridge) return; const n = !mini; await bridge.miniPlayer(n); setMini(n); };

  useEffect(() => {
    if (typeof sleep !== 'number') return;
    const t = setTimeout(() => { vref.current?.pause(); setSleep(null); flash('Sleep timer: paused'); }, Math.max(0, sleep - Date.now()));
    return () => clearTimeout(t);
  }, [sleep]);

  // keep the laptop awake while playing
  useEffect(() => { bridge?.powerSave(playing).catch(() => {}); }, [playing]);
  useEffect(() => () => { bridge?.powerSave(false).catch(() => {}); if (mini) bridge?.miniPlayer(false).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // media keys + system media overlay
  useEffect(() => {
    const ms = (navigator as any).mediaSession;
    if (!ms) return;
    try {
      ms.metadata = new (window as any).MediaMetadata({ title: title.title, artist: APP_NAME, artwork: [{ src: `/api/thumb?${qs({ root: p.root, path })}`, sizes: '480x270', type: 'image/jpeg' }] });
      ms.setActionHandler('play', () => vref.current?.play());
      ms.setActionHandler('pause', () => vref.current?.pause());
      ms.setActionHandler('seekbackward', () => skip(-10));
      ms.setActionHandler('seekforward', () => skip(10));
      ms.setActionHandler('nexttrack', next ? () => p.onNext(next) : null);
    } catch { /* not supported */ }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (p.floating) return;
      const v = vref.current;
      if (!v) return;
      wake();
      const k = e.key;
      if (k === 'Escape') { if (menu) setMenu(null); else p.onClose(); }
      else if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
      else if (k === 'ArrowRight' || k === 'l') skip(10);
      else if (k === 'ArrowLeft' || k === 'j') skip(-10);
      else if (k === 'ArrowUp') { e.preventDefault(); setMuted(false); setVol((x) => Math.min(maxVol, +(x + 0.05).toFixed(2))); }
      else if (k === 'ArrowDown') { e.preventDefault(); setVol((x) => Math.max(0, +(x - 0.05).toFixed(2))); }
      else if (k === 'f') toggleFs();
      else if (k === 'm') setMuted((x) => !x);
      else if (k === 'n' && next) p.onNext(next);
      else if (k === 'c') toggleSubs();
      else if (k === 'a') cycleAspect();
      else if (k === 'i') setStats((x) => !x);
      else if (k === 'p') pip();
      else if (k === 's') shot();
      else if (k === 'b') cycleAb();
      else if (k === 'd') addBookmark();
      else if (k === 'e') stepFrame(1);
      else if (k === 'E') stepFrame(-1);
      else if (k === 'g') setMenu((x) => (x === 'sound' ? null : 'sound'));
      else if (k === '>' || k === '.') setSpd(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]);
      else if (k === '<' || k === ',') setSpd(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]);
      else if (/^[0-9]$/.test(k) && totalRef.current) seekTo((totalRef.current * Number(k)) / 10);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ----- derived view state -----
  const turned = rot % 180 !== 0;
  const vstyle: CSSProperties = (() => {
    const tf = [rot ? `rotate(${rot}deg)` : '', flip ? 'scaleX(-1)' : '', zoom !== 100 ? `scale(${zoom / 100})` : ''].filter(Boolean).join(' ');
    const base: CSSProperties = { filter: `brightness(${pic.b}%) contrast(${pic.c}%) saturate(${pic.s}%)${pic.h ? ` hue-rotate(${pic.h}deg)` : ''}`, transform: tf || undefined };
    const W = turned ? size.h : size.w, H = turned ? size.w : size.h; // a sideways picture swaps the available box
    if (aspect === 'fill') return { ...base, width: turned ? H : '100%', height: turned ? W : '100%', objectFit: 'cover' };
    if (aspect === 'stretch') return { ...base, width: turned ? H : '100%', height: turned ? W : '100%', objectFit: 'fill' };
    if (aspect === 'fit' || !size.h) return { ...base, width: turned ? H : '100%', height: turned ? W : '100%', objectFit: 'contain' };
    const [x, y] = aspect.split(':').map(Number);
    const r = x / y, wide = W / H > r;
    return { ...base, width: wide ? H * r : W, height: wide ? H : W / r, objectFit: 'fill' };
  })();
  const t = pos - delay;
  const active = sub === 'off' ? [] : cues.filter((c) => t >= c.s && t < c.e);
  const shown = scrub ?? pos;
  const frac = total ? Math.min(1, shown / total) : 0;
  const pw = sprite?.w ?? 44;
  const peekX = Math.min(Math.max((hover ?? 0) * barW, pw / 2 + 4), Math.max(pw / 2 + 4, barW - pw / 2 - 4));
  const pIdx = sprite ? Math.min(sprite.count - 1, Math.floor(((hover ?? 0) * total) / sprite.interval)) : 0;
  const bufFrac = total ? Math.min(1, Math.max(buf, shown) / total) : 0;
  const modeLabel = p.offline ? (q === 'orig' ? 'Offline file, direct play' : q === 'remux' ? 'Offline file, audio converted on this laptop' : 'Offline file, audio only')
    : q === 'orig' ? 'Direct play' : q === 'remux' ? 'Remux (video copied, audio converted)' : q === 'audio' ? 'Audio only'
    : q === 'auto' ? `Auto (adaptive)${hlsH ? `, now ${hlsH}p` : ''}${ds ? ` · Data Saver ${SAVER[ds].label}` : ''}` : `Locked to ${hlsH || q}p`;
  const peak = Math.max(0, ...net.hist);
  const vq = (vref.current as any)?.getVideoPlaybackQuality?.();
  const fracOf = (e: React.PointerEvent) => { const r = seekRef.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const toggle = (m: MenuId) => setMenu((x) => (x === m ? null : m));
  const cbtn = (m: MenuId, icon: string, title: string, on = false) => (
    <button className={menu === m ? 'cbtn on' : on ? 'cbtn lit' : 'cbtn'} title={title} aria-label={title} onClick={() => toggle(m)}><Icon n={icon} s={20} /></button>
  );
  const fileKey = p.offline && info.origin ? `${info.origin.rootName}:${info.origin.rel}` : p.pkey;
  const baseLen = p.offline && info.origin ? (info.origin.rel.split('/').pop() ?? '').length : p.name.length;
  const ikey = title.episode ? fileKey.slice(0, fileKey.length - baseLen) : fileKey; // episodes share one setting per folder, movies get their own
  const mark = prefs.intros?.[ikey];
  const chapIntro = !s.skipIntro ? undefined : chapters.find((c) => /\b(intro|recap|previously)\b/i.test(c.title) && !/credit/i.test(c.title) && pos >= c.start && pos < c.end - 1 && c.end - c.start <= 300);
  const intro = !s.skipIntro ? undefined : chapIntro ?? (mark && pos >= mark.start - 1 && pos < mark.end - 1 ? { end: mark.end, title: 'Intro', start: mark.start } : undefined);
  const qualityList = QUALITIES.filter((o) => {
    if (p.offline) return o.id === 'orig' || o.id === 'audio' || (o.id === 'remux' && !!p.caps?.local.ffmpeg);
    const h = Number(o.id); // hide sizes bigger than the video itself
    return !(h > 0 && info.height && h > info.height * 1.1 && o.id !== q);
  });
  const volPct = Math.round((muted ? 0 : vol) * 100);

  return (
    <div className={'theatre' + (show ? ' ui' : '') + (mini ? ' mini' : '') + (p.floating ? ' float' : '')} ref={box} onMouseMove={wake} onTouchStart={wake}
      onWheel={(e) => { if (menu) return; setMuted(false); setVol((x) => Math.min(maxVol, Math.max(0, +(x + (e.deltaY < 0 ? 0.05 : -0.05)).toFixed(2)))); }}>
      <div className="stage" ref={stage}>
        <div className="vwrap">
          <video
            key={vkey} ref={vref} src={hlsMode ? (nativeHls ? masterUrl : undefined) : src} autoPlay playsInline crossOrigin="use-credentials" style={vstyle}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              v.playbackRate = speed; v.volume = rig.current ? 1 : Math.min(1, vol); v.muted = muted;
              if (resume.current) { v.currentTime = resume.current; resume.current = 0; }
              setBuffering(false);
            }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onPlaying={() => {
              setPlaying(true); setBuffering(false); everPlayed.current = true;
              if (!startedFired.current) { startedFired.current = true; p.onStarted?.(p.name); startCache(); }
            }}
            onWaiting={onWaiting} onCanPlay={() => setBuffering(false)}
            onEnded={() => {
              post(true);
              if (sleep === 'end') { setSleep(null); flash('Sleep timer: stopped'); return; }
              if (s.autoNext && next && !noNext) p.onNext(next);
            }}
            onError={() => setFailed(true)}
          />
        </div>
        {q === 'audio' && !failed && (
          <div className="audio-only"><Icon n="audio" s={56} /><strong>Audio only</strong><span>Saving data. Pick another quality to bring the picture back.</span></div>
        )}

        {active.length > 0 && (
          <div className={'cues' + (show ? ' lift' : '')} style={{ fontSize: s.subSize, color: s.subColor }}>
            {active.map((c, i) => <span key={i} style={{ background: `rgba(0,0,0,${s.subBg / 100})` }} dangerouslySetInnerHTML={{ __html: c.html }} />)}
          </div>
        )}

        <div className="surface" onClick={() => (menu ? setMenu(null) : togglePlay())}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); togglePlay(); } }}
          onDoubleClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
            if (x < 0.3) skip(-10); else if (x > 0.7) skip(10); else toggleFs();
          }} />
        {buffering && !failed && <div className="spin" aria-label="Buffering" />}
        {intro && <button className="skipintro" onClick={() => seekTo(intro.end)}><Icon n="skip" s={16} /> Skip intro</button>}

        <div className="hud top">
          <button className="cbtn" onClick={p.onClose} title="Back (Esc)" aria-label="Back to library"><Icon n="back" s={22} /></button>
          <div className="ttl">
            <strong className="full" title={p.name}>{p.name.replace(/\.[^.]+$/, '')}</strong>
            <span>
              {p.dir ? `${p.dir.split('/').join(' › ')} · ` : ''}
              {info.width ? `${info.width}×${info.height}${info.codec ? ' ' + info.codec.toUpperCase() : ''}` : p.opened ? 'Playing from your computer' : p.offline ? 'Playing from this laptop' : 'Streaming from your server'}
              {p.offline && info.width ? ' · offline' : ''}{ds > 0 && !p.offline ? ` · Data Saver ${SAVER[ds].label}` : ''}
            </span>
          </div>
          {p.playlist && idx >= 0 && <span className="chip" title="Position in your playlist"><Icon n="list" s={15} /><b>{idx + 1} / {p.videos.length}</b></span>}
          {!p.offline && !p.opened && cache.state !== 'none' && (
            <span className={'chip save' + (cache.state === 'done' ? ' done' : '')} title="A copy of this video is kept on this laptop so it can play offline">
              <Icon n="save" s={15} /><b>{cache.state === 'done' ? 'Saved' : cache.state === 'paused' ? 'Save paused' : cache.state === 'queued' ? 'Save queued' : `Saving ${Math.round(cache.frac * 100)}%`}</b>
            </span>
          )}
          {vol > 1 && <span className="chip loud" title="Volume is boosted above 100%"><Icon n="volume" s={15} /><b>{Math.round(vol * 100)}%</b></span>}
          <button className={'chip' + (stats ? ' on' : '')} onClick={() => setStats((x) => !x)} title="Network and playback stats (I)">
            <Icon n="activity" s={15} />
            <b>{p.offline ? 'Offline' : net.ok ? rate(net.speed) : 'offline'}</b>
            <span>{p.offline ? 'no data used' : `${bytes(net.bytes)} used`}</span>
          </button>
        </div>

        {stats && (
          <div className="stats" onClick={(e) => e.stopPropagation()}>
            <h4>Network and playback</h4>
            <dl>
              <dt>Speed now</dt><dd>{rate(net.speed)} <small>{mbps(net.speed)}</small></dd>
              <dt>Peak this session</dt><dd>{rate(peak)} <small>{mbps(peak)}</small></dd>
              <dt>Used by this video</dt><dd>{p.offline ? '0 B (local file)' : bytes(net.bytes)}</dd>
              <dt>Used today</dt><dd>{bytes(net.today)}</dd>
              <dt>Used this month</dt><dd>{bytes(net.month)}</dd>
              {hlsMode && <><dt>Link estimate</dt><dd>{est ? `${rate(est / 8)}` : '–'} <small>{est ? mbps(est / 8) : ''}</small></dd></>}
              <dt>Buffer ahead</dt><dd>{Math.max(0, Math.round(buf - pos))} s</dd>
              <dt>Mode</dt><dd>{modeLabel}</dd>
              <dt>Source</dt><dd>{info.width ? `${info.width}×${info.height} ${info.codec ?? ''}` : 'unknown'}{info.bitrate ? ` · ${(info.bitrate / 1e6).toFixed(1)} Mbps` : ''}</dd>
              <dt>Showing</dt><dd>{vref.current?.videoWidth ? `${vref.current.videoWidth}×${vref.current.videoHeight}` : '–'}{vq ? ` · ${vq.droppedVideoFrames} dropped` : ''}</dd>
              <dt>Sound</dt><dd>{Math.round(vol * 100)}%{rig.current ? ' · limiter on' : ''}{channels >= 6 ? ' · 5.1 mixed down' : ''}</dd>
            </dl>
            <svg className="spark" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">
              <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={net.hist.map((v, i) => `${(i / 59) * 120},${29 - (peak ? (v / peak) * 27 : 0)}`).join(' ')} />
            </svg>
          </div>
        )}

        {failed && (
          <div className="fail">
            <p>{q === 'orig' ? 'This file cannot be played directly. This is common with MKV, HEVC or AC3/DTS audio.' : p.offline ? 'This laptop could not convert the file. Try Original.' : 'The server could not convert this file. Is ffmpeg installed on the VPS?'}</p>
            <div className="fail-act">
              {q === 'orig' && !p.offline && <button className="btn" onClick={() => reload({ q: 'auto' }, false)}>Try Auto quality</button>}
              {q === 'orig' && (!p.offline || p.caps?.local.ffmpeg) && <button className={p.offline ? 'btn' : 'btn ghost'} onClick={() => reload({ q: 'remux' }, false)}>Try fixed audio</button>}
              {q !== 'orig' && <button className="btn" onClick={() => reload({ q: 'orig' }, false)}>Try Original</button>}
              {q === 'auto' && <button className="btn ghost" onClick={() => reload({ q: 'remux' }, false)}>Try fixed audio</button>}
              {bridge && <button className="btn ghost" onClick={openOutside}><Icon n="external" s={15} /> Open in another player</button>}
            </div>
          </div>
        )}
        {suggest && !failed && (
          <div className="suggest" onClick={(e) => e.stopPropagation()}>
            <span>Playback keeps pausing to buffer. Auto quality adapts to your connection.</span>
            <button className="btn" onClick={() => reload({ q: 'auto' }, false)}>Switch to Auto</button>
            <button className="btn ghost" onClick={() => { setSuggest(false); dismissed.current = true; }}>Not now</button>
          </div>
        )}
        {p.floating && (
          <div className="floatbar" onClick={(e) => e.stopPropagation()}>
            <span className="fl-t" title={p.name}>{p.name.replace(/\.[^.]+$/, '')}</span>
            <button className="cbtn sm" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}><Icon n={playing ? 'pause' : 'play'} s={16} /></button>
            <button className="cbtn sm" onClick={() => p.onFloat?.(false)} aria-label="Expand" title="Back to full screen"><Icon n="full" s={16} /></button>
            <button className="cbtn sm" onClick={p.onClose} aria-label="Close player"><Icon n="close" s={16} /></button>
          </div>
        )}
        {next && s.autoNext && !noNext && !failed && total > 0 && total - pos <= 20 && total - pos > 0 && (
          <div className="nextcard" onClick={(e) => e.stopPropagation()}>
            <small>Next episode</small>
            <strong>{next.replace(/\.[^.]+$/, '')}</strong>
            <span className="inline"><button className="btn" onClick={() => p.onNext(next)}><Icon n="next" s={15} /> Play now</button><button className="btn ghost" onClick={() => setNoNext(true)}>Cancel</button></span>
          </div>
        )}
        {toast && <div className="ptoast">{toast}</div>}

        {menu && (
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-h">
              <strong>{{ quality: 'Quality and data', speed: 'Speed', aspect: 'Screen shape', subs: 'Subtitles', audio: 'Audio track', sound: 'Sound', picture: 'Picture', more: 'More' }[menu]}</strong>
              <button className="cbtn sm" onClick={() => setMenu(null)} aria-label="Close menu"><Icon n="close" s={16} /></button>
            </div>
            <div className="menu-tabs" role="tablist">
              {([['quality', 'Quality'], ['speed', 'Speed'], ['subs', 'Subtitles'], ...((info.audio?.length ?? 0) > 1 ? [['audio', 'Audio']] : []), ['sound', 'Sound'], ['picture', 'Picture'], ['aspect', 'Shape'], ['more', 'More']] as [MenuId, string][]).map(([id, l]) => (
                <button key={id} role="tab" aria-selected={menu === id} className={menu === id ? 'on' : ''} onClick={() => (id === 'sound' ? (menu !== 'sound' && openSound()) : setMenu(id))}>{l}</button>
              ))}
            </div>

            {menu === 'quality' && (
              <>
                {!p.offline && (
                  <>
                    <div className="msec">Data Saver</div>
                    <div className="seg-m" role="group" aria-label="Data Saver">
                      {SAVER.map((o) => <button key={o.id} className={ds === o.id ? 'on' : ''} onClick={() => { set({ saver: o.id }); reload({}, false); }}>{o.label}</button>)}
                    </div>
                    <p className="mnote">{SAVER[ds].hint}. Applies to Auto and locked sizes; Original is never changed.</p>
                    <div className="msec">Quality</div>
                  </>
                )}
                {qualityList.map((o) => <Opt key={o.id} on={q === o.id} label={o.label} hint={o.id === 'auto' && q === 'auto' && hlsH ? `Adaptive. Playing ${hlsH}p right now` : o.hint} onClick={() => { reload({ q: o.id }); setMenu(null); }} />)}
              </>
            )}
            {menu === 'speed' && SPEEDS.map((v) => <Opt key={v} on={speed === v} label={`${v}×`} onClick={() => { setSpd(v); setMenu(null); }} />)}
            {menu === 'aspect' && ASPECTS.map((o) => <Opt key={o.id} on={aspect === o.id} label={o.label} hint={o.hint} onClick={() => { setAspect(o.id); set({ aspect: o.id }); }} />)}
            {menu === 'audio' && (
              <>
                {(info.audio ?? []).map((t) => <Opt key={t.i} on={a === t.i} label={t.label} onClick={() => { reload({ a: t.i, q: q === 'orig' && t.i !== a ? 'remux' : undefined }, false); setMenu(null); }} />)}
                {q === 'orig' && <p className="mnote">Choosing another track switches to “Original + fixed audio” (video is not re-encoded).</p>}
              </>
            )}

            {menu === 'subs' && !os.open && (
              <>
                <Opt on={sub === 'off'} label="Off" onClick={() => pickSub('off')} />
                {(info.subs ?? []).map((t) => <Opt key={'e' + t.i} on={sub === 'e:' + t.i} label={t.label} hint="Inside the video" onClick={() => pickSub('e:' + t.i)} />)}
                {(info.external ?? []).map((t) => <Opt key={'x' + t.name} on={sub === 'x:' + t.name} label={t.label} hint={t.name} onClick={() => pickSub('x:' + t.name)} />)}
                {sub.startsWith('f:') && <Opt on label={sub.slice(2)} hint="Loaded" onClick={() => {}} />}
                {info.ai && ai.state === 'done' && <Opt on={sub === 'ai'} label="AI generated" hint="Made on your VPS with Whisper" onClick={() => pickSub('ai')} />}
                {info.ai && ai.state === 'running' && <p className="mnote">Generating subtitles on the VPS… {clock(ai.elapsed)} so far. You can keep watching.</p>}
                {info.ai && !p.offline && (ai.state === 'none' || ai.state === 'error') && (
                  <button className="opt" onClick={genAi}><span><b><Icon n="sparkle" s={15} /> Generate subtitles with AI</b><small>Uses Whisper on the VPS. A full movie can take a while on a CPU.</small></span></button>
                )}
                {ai.state === 'error' && ai.error && <p className="mnote err">{ai.error}</p>}
                {!info.ai && !(info.subs?.length || info.external?.length) && <p className="mnote">No subtitles found for this video. Search online or load a file below.</p>}
                {!p.offline && <button className="opt" onClick={searchOs}><span><b><Icon n="search" s={15} /> Find subtitles online</b><small>Searches OpenSubtitles for “{title.title}”</small></span></button>}
                <label className="opt file"><span><b><Icon n="upload" s={15} /> Load .srt or .vtt from this device</b></span>
                  <input type="file" accept=".srt,.vtt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; }} />
                </label>
                {subBusy && <p className="mnote">Loading subtitles…</p>}
                {subErr && <p className="mnote err">{subErr}</p>}
                <div className="msec">Look and timing</div>
                <Row label={`Size ${s.subSize}px`}><Slider value={s.subSize} min={16} max={64} onChange={(v) => set({ subSize: v })} /></Row>
                <Row label={`Background ${s.subBg}%`}><Slider value={s.subBg} min={0} max={95} step={5} onChange={(v) => set({ subBg: v })} /></Row>
                <Row label="Color">
                  <span className="swatches">{['#ffffff', '#ffe066', '#7df9ff', '#9dff9d'].map((c) => (
                    <button key={c} className={s.subColor === c ? 'sw-c on' : 'sw-c'} style={{ background: c }} aria-label={`Subtitle color ${c}`} onClick={() => set({ subColor: c })} />
                  ))}</span>
                </Row>
                <Row label={`Sync ${delay > 0 ? '+' : ''}${delay.toFixed(1)}s`}>
                  <span className="nudge">
                    <button onClick={() => setDelay((d) => +(d - 0.5).toFixed(1))}>−0.5</button>
                    <button onClick={() => setDelay((d) => +(d - 0.1).toFixed(1))}>−0.1</button>
                    <button onClick={() => setDelay(0)}>0</button>
                    <button onClick={() => setDelay((d) => +(d + 0.1).toFixed(1))}>+0.1</button>
                    <button onClick={() => setDelay((d) => +(d + 0.5).toFixed(1))}>+0.5</button>
                  </span>
                </Row>
              </>
            )}
            {menu === 'subs' && os.open && (
              <>
                <button className="opt" onClick={() => setOs({ open: false, busy: false, err: '', hits: [] })}><span><b><Icon n="back" s={15} /> Back to subtitles</b></span></button>
                <Row label="Language">
                  <select value={s.subLang} onChange={(e) => set({ subLang: e.target.value })}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select>
                </Row>
                <button className="opt" onClick={searchOs} disabled={os.busy}><span><b><Icon n="search" s={15} /> Search again</b></span></button>
                {os.busy && <p className="mnote">Working…</p>}
                {os.err && <p className="mnote err">{os.err}</p>}
                {os.hits.map((h) => <button key={h.id} className="opt" onClick={() => getOs(h)}><span><b>{h.name}</b><small>{h.lang} · {h.downloads.toLocaleString()} downloads</small></span></button>)}
              </>
            )}

            {menu === 'sound' && (
              <>
                <p className="mnote loudnote">
                  Volume goes up to {Math.round(maxVol * 100)}% (use the slider or the mouse wheel). A limiter keeps loud peaks clean instead of crackling. Very high volume can hurt your ears and speakers.
                </p>
                <Row label={`Equalizer: ${eqName}`}>
                  <select value={eqName} onChange={(e) => { const v = EQ_PRESETS[e.target.value]; if (v) updEq([...v]); }}>
                    {Object.keys(EQ_PRESETS).map((n) => <option key={n} value={n}>{n}</option>)}
                    {eqName === 'Custom' && <option value="Custom">Custom</option>}
                  </select>
                </Row>
                <div className="eq" role="group" aria-label="Equalizer bands">
                  {eq.map((g, i) => (
                    <label key={i}>
                      <input type="range" min={-12} max={12} step={1} value={g} aria-label={`${EQ_LABELS[i]} Hz`}
                        onChange={(e) => { const n = [...eq]; n[i] = +e.target.value; updEq(n); }} />
                      <small>{EQ_LABELS[i]}</small>
                    </label>
                  ))}
                </div>
                <Switch on={dialogue} label="Dialogue boost" hint="Clearer speech: lifts voices, lowers rumble, louder centre on 5.1" onClick={() => { setDialogue(!dialogue); saveFx({ dialogue: !dialogue }); }} />
                <Switch on={night} label="Night mode" hint="Quiet explosions, louder whispers" onClick={() => { setNight(!night); saveFx({ night: !night }); }} />
                <Switch on={mono} label="Mono" hint="Same sound in both ears" onClick={() => { setMono(!mono); saveFx({ mono: !mono }); }} />
                {devices.length > 0 && (
                  <Row label="Output device">
                    <select value={sink} onChange={(e) => { setSink(e.target.value); rig.current?.setSink(e.target.value); if (!rig.current) flash('Turn on a sound effect first, then pick the device'); }}>
                      <option value="default">System default</option>
                      {devices.filter((d) => d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
                    </select>
                  </Row>
                )}
                <button className="opt" onClick={() => { updEq([...EQ_FLAT]); setDialogue(false); setNight(false); setMono(false); saveFx({ eq: [...EQ_FLAT], dialogue: false, night: false, mono: false }); setVol((x) => Math.min(1, x)); }}>
                  <span><b>Reset sound (and volume to 100%)</b></span>
                </button>
                <p className="mnote">These settings are remembered for this video.</p>
              </>
            )}

            {menu === 'picture' && (
              <>
                <Row label={`Zoom ${zoom}%`}><Slider value={zoom} min={100} max={250} step={5} onChange={setZoom} /></Row>
                <Row label={`Brightness ${pic.b}%`}><Slider value={pic.b} min={50} max={150} onChange={(v) => setPic({ ...pic, b: v })} /></Row>
                <Row label={`Contrast ${pic.c}%`}><Slider value={pic.c} min={50} max={150} onChange={(v) => setPic({ ...pic, c: v })} /></Row>
                <Row label={`Color ${pic.s}%`}><Slider value={pic.s} min={0} max={200} onChange={(v) => setPic({ ...pic, s: v })} /></Row>
                <Row label={`Hue ${pic.h}°`}><Slider value={pic.h} min={-180} max={180} step={5} onChange={(v) => setPic({ ...pic, h: v })} /></Row>
                <div className="nudge pad">
                  <button onClick={() => setRot((r) => (r + 90) % 360)}>Rotate {rot}°</button>
                  <button className={flip ? 'on' : ''} onClick={() => setFlip((f) => !f)}>Flip</button>
                </div>
                <button className="opt" onClick={() => { setZoom(100); setPic({ b: 100, c: 100, s: 100, h: 0 }); setRot(0); setFlip(false); }}><span><b>Reset picture</b></span></button>
              </>
            )}

            {menu === 'more' && (
              <>
                <Switch on={s.autoNext} label="Play next episode automatically" onClick={() => set({ autoNext: !s.autoNext })} />
                <div className="msec">Loop and frames</div>
                <button className="opt" onClick={cycleAb}><span><b><Icon n="repeat" s={15} /> A–B loop (B)</b><small>{ab.a === null ? 'Press to set the start' : ab.b === null ? `Start ${clock(ab.a)}. Press to set the end` : `Looping ${clock(ab.a)} to ${clock(ab.b)}. Press to stop`}</small></span></button>
                <button className="opt" onClick={() => stepFrame(1)}><span><b>Next frame (E) · previous frame (Shift+E)</b><small>Pauses the video and moves one frame</small></span></button>
                {chapters.length > 0 && (
                  <>
                    <div className="msec">Chapters</div>
                    {chapters.map((c, i) => <Opt key={i} on={pos >= c.start && pos < c.end} label={c.title || `Chapter ${i + 1}`} hint={clock(c.start)} onClick={() => { seekTo(c.start); setMenu(null); }} />)}
                  </>
                )}
                <div className="msec">Bookmarks</div>
                <button className="opt" onClick={addBookmark}><span><b><Icon n="bookmark" s={15} /> Bookmark this moment (D)</b></span></button>
                {bookmarks.map((b) => (
                  <div key={b.t} className="opt bm">
                    <button onClick={() => { seekTo(b.t); setMenu(null); }}><b>{b.label}</b></button>
                    <button className="cbtn sm" onClick={() => delBookmark(b.t)} aria-label="Delete bookmark"><Icon n="close" s={14} /></button>
                  </div>
                ))}
                <div className="msec">Sleep timer</div>
                <Opt on={sleep === null} label="Off" onClick={() => setSleep(null)} />
                {[15, 30, 60].map((m) => <Opt key={m} on={typeof sleep === 'number' && Math.abs(sleep - Date.now() - m * 60000) < 90000} label={`${m} minutes`} onClick={() => { setSleep(Date.now() + m * 60000); flash(`Will pause in ${m} minutes`); }} />)}
                <Opt on={sleep === 'end'} label="After this video" onClick={() => setSleep('end')} />
                <div className="msec">Skip intro for this {title.episode ? 'folder' : 'video'}</div>
                <button className="opt" onClick={() => { setPref('intros', { ...(prefs.intros ?? {}), [ikey]: { start: Math.floor(pos), end: mark && mark.end > pos ? mark.end : Math.floor(pos) + 90 } }); flash('Intro starts here'); }}><span><b>Intro starts here</b><small>{mark ? `Now ${clock(mark.start)} to ${clock(mark.end)}` : 'Pause at the start of the intro, then press this'}</small></span></button>
                <button className="opt" onClick={() => { const st = mark && mark.start < pos ? mark.start : Math.max(0, Math.floor(pos) - 90); setPref('intros', { ...(prefs.intros ?? {}), [ikey]: { start: st, end: Math.floor(pos) } }); flash('Skip intro is set for every video in this folder'); }}><span><b>Intro ends here</b><small>{title.episode ? 'Every video in this folder then gets a Skip intro button' : 'This video gets a Skip intro button'}</small></span></button>
                {mark && <button className="opt" onClick={() => { const n = { ...(prefs.intros ?? {}) }; delete n[ikey]; setPref('intros', n); }}><span><b>Clear this folder’s intro</b></span></button>}
                <div className="msec">Tools</div>
                <button className="opt" onClick={shot}><span><b><Icon n="camera" s={15} /> Save screenshot (S)</b></span></button>
                <button className="opt" onClick={pip}><span><b><Icon n="pip" s={15} /> Picture-in-picture (P)</b></span></button>
                {bridge && <button className="opt" onClick={toggleMini}><span><b><Icon n="pip" s={15} /> {mini ? 'Leave mini player' : 'Mini player (stays on top)'}</b></span></button>}
                {bridge && <button className="opt" onClick={openOutside}><span><b><Icon n="external" s={15} /> Open in another player</b><small>{s.externalPlayer ? 'Uses the player chosen in Settings' : 'Uses your computer’s default player'}</small></span></button>}
                {!p.offline && p.onDownload && <button className="opt" onClick={() => { setMenu(null); p.onDownload!(p.name); }}><span><b><Icon n="save" s={15} /> Save for offline…</b><small>Watch on this laptop without internet</small></span></button>}
                {!p.offline && !bridge && <a className="opt" href={`/api/download?${qs({ root: p.root, path })}`}><span><b><Icon n="down" s={15} /> Download this video</b></span></a>}
                <button className="opt danger" onClick={() => p.onDelete(p.name)}><span><b><Icon n="trash" s={15} /> {p.opened ? 'Remove from the list' : p.offline ? 'Delete from this laptop' : 'Delete from server'}</b>{p.opened && <small>The video stays where it is on your computer</small>}</span></button>
                <p className="mnote keys">Space play · ←/→ 10s · ↑/↓ or wheel volume (to {Math.round(maxVol * 100)}%) · F fullscreen · C subtitles · G sound · A screen shape · &lt; &gt; speed · B loop · D bookmark · E frame · 0–9 jump · N next · I stats</p>
              </>
            )}
          </div>
        )}

        <div className="hud bottom">
          <div className="seek" ref={seekRef} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.floor(total)} aria-valuenow={Math.floor(shown)}
            onPointerDown={(e) => { if (!total) return; e.currentTarget.setPointerCapture(e.pointerId); setScrub(fracOf(e) * total); }}
            onPointerMove={(e) => { const f = fracOf(e); setHover(f); setBarW(seekRef.current!.clientWidth); setWantSprite(true); if (scrub !== null) setScrub(f * total); }}
            onPointerUp={(e) => { if (scrub !== null) { seekTo(fracOf(e) * total); setScrub(null); } }}
            onPointerCancel={() => setScrub(null)} onPointerLeave={() => setHover(null)}>
            <i className="track" /><i className="buffered" style={{ width: `${bufFrac * 100}%` }} /><i className="cached" style={{ width: `${cachedFrac * 100}%` }} /><i className="played" style={{ width: `${frac * 100}%` }} /><i className="knob" style={{ left: `${frac * 100}%` }} />
            {total > 0 && chapters.slice(1).map((c, i) => <i key={i} className="chap" style={{ left: `${(c.start / total) * 100}%` }} />)}
            {total > 0 && ab.a !== null && <i className="abmark" style={{ left: `${(ab.a / total) * 100}%`, width: ab.b !== null ? `${((ab.b - ab.a) / total) * 100}%` : 3 }} />}
            {hover !== null && total > 0 && (
              <div className="peek" style={{ left: peekX }}>
                {sprite && (
                  <i className="peek-img" style={{
                    width: sprite.w, height: sprite.h, backgroundImage: `url(${sprite.url})`,
                    backgroundSize: `${sprite.cols * sprite.w}px ${sprite.rows * sprite.h}px`,
                    backgroundPosition: `-${(pIdx % sprite.cols) * sprite.w}px -${Math.floor(pIdx / sprite.cols) * sprite.h}px`,
                  }} />
                )}
                <span>{clock(hover * total)}</span>
              </div>
            )}
          </div>
          <div className="ctl">
            <button className="cbtn big" onClick={togglePlay} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'}><Icon n={playing ? 'pause' : 'play'} s={24} /></button>
            <button className="cbtn" onClick={() => skip(-10)} title="Back 10 seconds" aria-label="Back 10 seconds"><Icon n="back10" s={20} /></button>
            <button className="cbtn" onClick={() => skip(10)} title="Forward 10 seconds" aria-label="Forward 10 seconds"><Icon n="fwd10" s={20} /></button>
            {next && <button className="cbtn" onClick={() => p.onNext(next)} title="Next episode (N)" aria-label="Next episode"><Icon n="next" s={20} /></button>}
            <span className="vol">
              <button className="cbtn" onClick={() => setMuted((x) => !x)} title="Mute (M)" aria-label="Mute"><Icon n={muted || vol === 0 ? 'mute' : 'volume'} s={20} /></button>
              <Slider label="Volume" value={Math.round((muted ? 0 : vol) * 100)} min={0} max={Math.round(maxVol * 100)} step={5} onChange={(v) => { setMuted(false); setVol(v / 100); }} />
              <span className={'volpct' + (vol > 1 ? ' hot' : '')}>{volPct}%</span>
            </span>
            <span className="time">{clock(shown)} <i>/</i> {total ? clock(total) : '–:––'}</span>
            <span className="grow" />
            <button className={sub !== 'off' ? 'cbtn lit' : 'cbtn'} onClick={() => toggle('subs')} title="Subtitles (C)" aria-label="Subtitles"><Icon n="cc" s={20} /></button>
            {(info.audio?.length ?? 0) > 1 && cbtn('audio', 'audio', 'Audio track')}
            <button className="cbtn" onClick={pip} title="Picture-in-picture, over other apps (P)" aria-label="Picture-in-picture"><Icon n="pip" s={20} /></button>
            {p.onFloat && <button className="cbtn" onClick={() => p.onFloat!(true)} title="Mini player: keep watching while you browse" aria-label="Mini player"><Icon n="exitfs" s={20} /></button>}
            {cbtn('quality', 'sliders', 'Settings: quality, speed, sound, picture', (ds > 0 && !p.offline) || needRig)}
            <button className="cbtn" onClick={toggleFs} title="Fullscreen (F)" aria-label="Fullscreen"><Icon n={fs ? 'exitfs' : 'full'} s={20} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}