import Hls from 'hls.js';
import { CSSProperties, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ASPECTS, Cue, Icon, Info, LANGS, Prog, QUALITIES, SPEEDS, SettingsCtx, api, bytes, clock, join, mbps, parseCues, qs, rate, useNet } from './lib';

type MenuId = 'quality' | 'speed' | 'aspect' | 'subs' | 'audio' | 'enhance' | 'more';
type Sprite = { interval: number; cols: number; rows: number; w: number; h: number; count: number; url: string };
type Ai = { available: boolean; state: string; elapsed: number; error?: string };
type Rig = { ctx: AudioContext; gain: GainNode; comp: DynamicsCompressorNode; src: MediaElementAudioSourceNode | null; el: HTMLVideoElement | null };
type Props = {
  root: number; dir: string; name: string; videos: string[]; pkey: string; saved?: Prog;
  onClose: () => void; onNext: (n: string) => void; onDelete: (n: string) => void;
};

const Slider = ({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) => (
  <input type="range" className="slider" min={min} max={max} step={step} value={value}
    onChange={(e) => onChange(+e.target.value)} onPointerUp={(e) => e.currentTarget.blur()} />
);
const Opt = ({ on, label, hint, onClick }: { on?: boolean; label: string; hint?: string; onClick: () => void }) => (
  <button className={on ? 'opt on' : 'opt'} onClick={onClick}>
    <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
    {on && <Icon n="check" s={16} />}
  </button>
);
const Switch = ({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) => (
  <button className="opt" role="switch" aria-checked={on} onClick={onClick}>
    <span><b>{label}</b></span><i className={on ? 'sw on' : 'sw'} />
  </button>
);
const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="mrow"><span>{label}</span>{children}</label>
);

export default function Player(p: Props) {
  const { s, set } = useContext(SettingsCtx);
  const path = join(p.dir, p.name);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const vref = useRef<HTMLVideoElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const last = useRef({ pos: 0, dur: 0 });
  const totalRef = useRef(0);
  const idle = useRef<number>();
  const tt = useRef<number>();
  const rig = useRef<Rig | null>(null);
  const subTouched = useRef(false);
  const lastSub = useRef('off');
  const upCues = useRef<Cue[]>([]);
  const hlsRef = useRef<Hls | null>(null);
  const stalls = useRef<number[]>([]);
  const lastSeek = useRef(0);
  const dismissed = useRef(false);

  const [sid] = useState(() => Math.random().toString(36).slice(2, 12));
  const [start] = useState(() => (p.saved && !p.saved.watched && p.saved.pos > 10 ? Math.max(0, p.saved.pos - 3) : 0));
  const [q, setQ] = useState(s.quality);
  const [speed, setSpeed] = useState(s.speed);
  const [offset, setOffset] = useState(q === 'remux' ? Math.floor(start) : 0);
  const resume = useRef(q === 'remux' ? 0 : start);
  const [pos, setPos] = useState(start);
  const [buf, setBuf] = useState(0);
  const [a, setA] = useState(0);
  const [info, setInfo] = useState<Info>({ duration: 0 });
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [vol, setVol] = useState(() => { const v = Number(localStorage.getItem('sr.vol')); return Number.isFinite(v) && localStorage.getItem('sr.vol') !== null ? v : 1; });
  const [muted, setMuted] = useState(false);
  const [ui, setUi] = useState(true);
  const [menu, setMenu] = useState<MenuId | null>(null);
  const [stats, setStats] = useState(false);
  const [aspect, setAspect] = useState(s.aspect);
  const [zoom, setZoom] = useState(100);
  const [fx, setFx] = useState({ b: 100, c: 100, s: 100 });
  const [boost, setBoost] = useState(100);
  const [night, setNight] = useState(false);
  const [sleep, setSleep] = useState<number | 'end' | null>(null);
  const [sub, setSub] = useState('off');
  const [cues, setCues] = useState<Cue[]>([]);
  const [subBusy, setSubBusy] = useState(false);
  const [subErr, setSubErr] = useState('');
  const [delay, setDelay] = useState(0);
  const [ai, setAi] = useState<Ai>({ available: false, state: 'none', elapsed: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [fs, setFs] = useState(false);
  const [toast, setToast] = useState('');
  const [hlsH, setHlsH] = useState(0);
  const [est, setEst] = useState(0);
  const [wantSprite, setWantSprite] = useState(false);
  const [sprite, setSprite] = useState<Sprite | null>(null);
  const [barW, setBarW] = useState(0);
  const [suggest, setSuggest] = useState(false);
  const net = useNet(sid, 1000);

  const hlsMode = q !== 'orig' && q !== 'remux'; // auto or a locked size: adaptive HLS, browser seeks natively
  const offsetMode = q === 'remux';             // piped stream: seeking restarts the stream at a new offset
  const nativeHls = hlsMode && !Hls.isSupported() && document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
  const vd = vref.current?.duration;
  const total = !offsetMode && vd && Number.isFinite(vd) ? vd : info.duration || 0;
  totalRef.current = total;
  const idx = p.videos.indexOf(p.name);
  const next = idx >= 0 ? p.videos[idx + 1] : undefined;
  const show = ui || !!menu || !playing || scrub !== null;

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

  // position, buffer and play state (4x per second)
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
    }, 250);
    return () => clearInterval(t);
  }, [offset]);

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
    resume.current = nq === 'remux' ? 0 : t;
    setOffset(nq === 'remux' ? Math.floor(t) : 0);
    if (o.q !== undefined) { setQ(nq); if (persist) set({ quality: nq }); }
    if (o.a !== undefined) setA(o.a);
    setFailed(false); setBuffering(true); setSuggest(false); setHlsH(0);
  };

  // ----- volume -----
  useEffect(() => {
    const v = vref.current;
    if (v) { v.volume = vol; v.muted = muted; }
    try { localStorage.setItem('sr.vol', String(vol)); } catch { /* ignore */ }
  }, [vol, muted]);

  // ----- volume boost + night mode (Web Audio) -----
  const src = `/api/stream?${qs({ root: p.root, path, q, t: offset, a, sid })}`;
  const masterUrl = `/api/hls/master.m3u8?${qs({ root: p.root, path, q, a, sid })}`;
  const vkey = hlsMode ? `hls:${q}:${a}` : src;
  useEffect(() => {
    if (!hlsMode || nativeHls) return;
    const v = vref.current;
    if (!v) return;
    const hls = new Hls({
      startPosition: resume.current > 0 ? resume.current : -1,
      capLevelToPlayerSize: true,      // no point converting to 1080p for a small window
      abrEwmaDefaultEstimate: 500_000,   // start low so Auto never wastes data on a high level first
      maxBufferLength: 30, maxMaxBufferLength: 40, backBufferLength: 60,
    });
    hlsRef.current = hls;
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
  }, [hlsMode, nativeHls, masterUrl]);
  useEffect(() => {
    const v = vref.current;
    if (!v || (boost === 100 && !night && !rig.current)) return;
    try {
      let r = rig.current;
      if (!r) {
        const ctx = new AudioContext();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -45; comp.knee.value = 30; comp.ratio.value = 10; comp.attack.value = 0.003; comp.release.value = 0.25;
        r = rig.current = { ctx, gain: ctx.createGain(), comp, src: null, el: null };
      }
      if (r.el !== v) { r.src?.disconnect(); r.src = r.ctx.createMediaElementSource(v); r.el = v; }
      r.src!.disconnect(); r.comp.disconnect(); r.gain.disconnect();
      if (night) { r.src!.connect(r.comp); r.comp.connect(r.gain); } else r.src!.connect(r.gain);
      r.gain.gain.value = (boost / 100) * (night ? 1.7 : 1);
      r.gain.connect(r.ctx.destination);
      r.ctx.resume();
    } catch { /* browser refused: normal audio keeps working */ }
  }, [boost, night, vkey]);
  useEffect(() => () => { rig.current?.ctx.close().catch(() => {}); }, []);

  // ----- seek-bar preview sheet: built by the server on first use, then cached -----
  useEffect(() => {
    if (!wantSprite || sprite) return;
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
  }, [wantSprite, sprite, p.root, path]);

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
  const loadFile = async (f: File) => {
    const c = parseCues(await f.text());
    if (!c.length) { setSubErr('No subtitles found in that file. Use .srt or .vtt.'); return; }
    upCues.current = c;
    pickSub('f:' + f.name);
    setCues(c);
  };
  const toggleSubs = () => {
    if (sub !== 'off') return pickSub('off');
    const t = lastSub.current !== 'off' ? lastSub.current : info.subs?.[0] ? 'e:' + info.subs[0].i : info.external?.[0] ? 'x:' + info.external[0].name : '';
    t ? pickSub(t) : flash('No subtitles found for this video');
  };

  // ----- actions -----
  const onWaiting = () => {
    setBuffering(true);
    const v = vref.current;
    // Count real stalls only (not seeks) while playing the original; three in 90 s = offer Auto quality.
    if (!v || hlsMode || v.currentTime < 3 || Date.now() - lastSeek.current < 3000) return;
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
    } catch { flash('Picture-in-picture is not available in this browser'); }
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

  useEffect(() => {
    if (typeof sleep !== 'number') return;
    const t = setTimeout(() => { vref.current?.pause(); setSleep(null); flash('Sleep timer: paused'); }, Math.max(0, sleep - Date.now()));
    return () => clearTimeout(t);
  }, [sleep]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = vref.current;
      if (!v) return;
      wake();
      const k = e.key;
      if (k === 'Escape') { if (menu) setMenu(null); else p.onClose(); }
      else if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
      else if (k === 'ArrowRight' || k === 'l') skip(10);
      else if (k === 'ArrowLeft' || k === 'j') skip(-10);
      else if (k === 'ArrowUp') { e.preventDefault(); setMuted(false); setVol((x) => Math.min(1, +(x + 0.05).toFixed(2))); }
      else if (k === 'ArrowDown') { e.preventDefault(); setVol((x) => Math.max(0, +(x - 0.05).toFixed(2))); }
      else if (k === 'f') toggleFs();
      else if (k === 'm') setMuted((x) => !x);
      else if (k === 'n' && next) p.onNext(next);
      else if (k === 'c') toggleSubs();
      else if (k === 'a') cycleAspect();
      else if (k === 'i') setStats((x) => !x);
      else if (k === 'p') pip();
      else if (k === 's') shot();
      else if (k === '>' || k === '.') setSpd(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]);
      else if (k === '<' || k === ',') setSpd(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]);
      else if (/^[0-9]$/.test(k) && totalRef.current) seekTo((totalRef.current * Number(k)) / 10);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ----- derived view state -----
  const vstyle: CSSProperties = (() => {
    const base: CSSProperties = { filter: `brightness(${fx.b}%) contrast(${fx.c}%) saturate(${fx.s}%)`, transform: zoom !== 100 ? `scale(${zoom / 100})` : undefined };
    if (aspect === 'fill') return { ...base, width: '100%', height: '100%', objectFit: 'cover' };
    if (aspect === 'stretch') return { ...base, width: '100%', height: '100%', objectFit: 'fill' };
    if (aspect === 'fit' || !size.h) return { ...base, width: '100%', height: '100%', objectFit: 'contain' };
    const [x, y] = aspect.split(':').map(Number);
    const r = x / y, wide = size.w / size.h > r;
    return { ...base, width: wide ? size.h * r : size.w, height: wide ? size.h : size.w / r, objectFit: 'fill' };
  })();
  const t = pos - delay;
  const active = sub === 'off' ? [] : cues.filter((c) => t >= c.s && t < c.e);
  const shown = scrub ?? pos;
  const frac = total ? Math.min(1, shown / total) : 0;
  const pw = sprite?.w ?? 44;
  const peekX = Math.min(Math.max((hover ?? 0) * barW, pw / 2 + 4), Math.max(pw / 2 + 4, barW - pw / 2 - 4));
  const pIdx = sprite ? Math.min(sprite.count - 1, Math.floor(((hover ?? 0) * total) / sprite.interval)) : 0;
  const bufFrac = total ? Math.min(1, Math.max(buf, shown) / total) : 0;
  const modeLabel = q === 'orig' ? 'Direct play' : q === 'remux' ? 'Remux (video copied, audio converted)'
    : q === 'auto' ? `Auto (adaptive)${hlsH ? `, now ${hlsH}p` : ''}` : `Locked to ${hlsH || q}p`;
  const peak = Math.max(0, ...net.hist);
  const vq = (vref.current as any)?.getVideoPlaybackQuality?.();
  const fracOf = (e: React.PointerEvent) => { const r = seekRef.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const toggle = (m: MenuId) => setMenu((x) => (x === m ? null : m));
  const cbtn = (m: MenuId, icon: string, title: string) => (
    <button className={menu === m ? 'cbtn on' : 'cbtn'} title={title} aria-label={title} onClick={() => toggle(m)}><Icon n={icon} s={20} /></button>
  );

  return (
    <div className={'theatre' + (show ? ' ui' : '')} ref={box} onMouseMove={wake} onTouchStart={wake}>
      <div className="stage" ref={stage}>
        <div className="vwrap">
          <video
            key={vkey} ref={vref} src={hlsMode ? (nativeHls ? masterUrl : undefined) : src} autoPlay playsInline crossOrigin="use-credentials" style={vstyle}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              v.playbackRate = speed; v.volume = vol; v.muted = muted;
              if (resume.current) { v.currentTime = resume.current; resume.current = 0; }
              setBuffering(false);
            }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onPlaying={() => { setPlaying(true); setBuffering(false); }}
            onWaiting={onWaiting} onCanPlay={() => setBuffering(false)}
            onEnded={() => {
              post(true);
              if (sleep === 'end') { setSleep(null); flash('Sleep timer: stopped'); return; }
              if (s.autoNext && next) p.onNext(next);
            }}
            onError={() => setFailed(true)}
          />
        </div>

        {active.length > 0 && (
          <div className={'cues' + (show ? ' lift' : '')} style={{ fontSize: s.subSize, color: s.subColor }}>
            {active.map((c, i) => <span key={i} style={{ background: `rgba(0,0,0,${s.subBg / 100})` }} dangerouslySetInnerHTML={{ __html: c.html }} />)}
          </div>
        )}

        <div className="surface" onClick={() => (menu ? setMenu(null) : togglePlay())}
          onDoubleClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
            if (x < 0.3) skip(-10); else if (x > 0.7) skip(10); else toggleFs();
          }} />
        {buffering && !failed && <div className="spin" aria-label="Buffering" />}

        <div className="hud top">
          <div className="ttl">
            <strong>{p.name}</strong>
            <span>{info.width ? `${info.width}×${info.height}${info.codec ? ' ' + info.codec.toUpperCase() : ''}` : 'Streaming from your VPS'}</span>
          </div>
          <button className={'chip' + (stats ? ' on' : '')} onClick={() => setStats((x) => !x)} title="Network and playback stats (I)">
            <Icon n="activity" s={15} />
            <b>{net.ok ? rate(net.speed) : 'offline'}</b>
            <span>{bytes(net.bytes)} used</span>
          </button>
          <button className="cbtn" onClick={p.onClose} title="Close (Esc)" aria-label="Close player"><Icon n="close" s={22} /></button>
        </div>

        {stats && (
          <div className="stats" onClick={(e) => e.stopPropagation()}>
            <h4>Network and playback</h4>
            <dl>
              <dt>Speed now</dt><dd>{rate(net.speed)} <small>{mbps(net.speed)}</small></dd>
              <dt>Peak this session</dt><dd>{rate(peak)} <small>{mbps(peak)}</small></dd>
              <dt>Used by this video</dt><dd>{bytes(net.bytes)}</dd>
              <dt>Used today</dt><dd>{bytes(net.today)}</dd>
              {hlsMode && <><dt>Link estimate</dt><dd>{est ? `${rate(est / 8)}` : '–'} <small>{est ? mbps(est / 8) : ''}</small></dd></>}
              <dt>Buffer ahead</dt><dd>{Math.max(0, Math.round(buf - pos))} s</dd>
              <dt>Mode</dt><dd>{modeLabel}</dd>
              <dt>Source</dt><dd>{info.width ? `${info.width}×${info.height} ${info.codec ?? ''}` : 'unknown'}{info.bitrate ? ` · ${(info.bitrate / 1e6).toFixed(1)} Mbps` : ''}</dd>
              <dt>Showing</dt><dd>{vref.current?.videoWidth ? `${vref.current.videoWidth}×${vref.current.videoHeight}` : '–'}{vq ? ` · ${vq.droppedVideoFrames} dropped` : ''}</dd>
              <dt>Disk path</dt><dd>{net.mode === 'local' ? 'Direct from server disk' : 'Through SSH/SFTP'}</dd>
            </dl>
            <svg className="spark" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">
              <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={net.hist.map((v, i) => `${(i / 59) * 120},${29 - (peak ? (v / peak) * 27 : 0)}`).join(' ')} />
            </svg>
          </div>
        )}

        {failed && (
          <div className="fail">
            <p>{q === 'orig' ? 'Your browser cannot play this file directly. This is common with MKV, HEVC or AC3/DTS audio.' : 'The server could not convert this file. Is ffmpeg installed on the VPS?'}</p>
            <div className="fail-act">
              {q === 'orig' && <button className="btn" onClick={() => reload({ q: 'auto' }, false)}>Try Auto quality</button>}
              {q === 'orig' && <button className="btn ghost" onClick={() => reload({ q: 'remux' }, false)}>Try fixed audio</button>}
              {q !== 'orig' && <button className="btn" onClick={() => reload({ q: 'orig' }, false)}>Try Original</button>}
              {q === 'auto' && <button className="btn ghost" onClick={() => reload({ q: 'remux' }, false)}>Try fixed audio</button>}
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
        {toast && <div className="ptoast">{toast}</div>}

        {menu && (
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <div className="menu-h">
              <strong>{{ quality: 'Quality', speed: 'Speed', aspect: 'Screen shape', subs: 'Subtitles', audio: 'Audio track', enhance: 'Picture and sound', more: 'More' }[menu]}</strong>
              <button className="cbtn sm" onClick={() => setMenu(null)} aria-label="Close menu"><Icon n="close" s={16} /></button>
            </div>

            {menu === 'quality' && QUALITIES.map((o) => <Opt key={o.id} on={q === o.id} label={o.label} hint={o.id === 'auto' && q === 'auto' && hlsH ? `Adaptive. Playing ${hlsH}p right now` : o.hint} onClick={() => { reload({ q: o.id }); setMenu(null); }} />)}
            {menu === 'speed' && SPEEDS.map((v) => <Opt key={v} on={speed === v} label={`${v}×`} onClick={() => { setSpd(v); setMenu(null); }} />)}
            {menu === 'aspect' && ASPECTS.map((o) => <Opt key={o.id} on={aspect === o.id} label={o.label} hint={o.hint} onClick={() => { setAspect(o.id); set({ aspect: o.id }); }} />)}
            {menu === 'audio' && (
              <>
                {(info.audio ?? []).map((t) => <Opt key={t.i} on={a === t.i} label={t.label} onClick={() => { reload({ a: t.i, q: q === 'orig' && t.i !== a ? 'remux' : undefined }, false); setMenu(null); }} />)}
                {q === 'orig' && <p className="mnote">Choosing another track switches to “Original + fixed audio” (video is not re-encoded).</p>}
              </>
            )}

            {menu === 'subs' && (
              <>
                <Opt on={sub === 'off'} label="Off" onClick={() => pickSub('off')} />
                {(info.subs ?? []).map((t) => <Opt key={'e' + t.i} on={sub === 'e:' + t.i} label={t.label} hint="Inside the video" onClick={() => pickSub('e:' + t.i)} />)}
                {(info.external ?? []).map((t) => <Opt key={'x' + t.name} on={sub === 'x:' + t.name} label={t.label} hint={t.name} onClick={() => pickSub('x:' + t.name)} />)}
                {sub.startsWith('f:') && <Opt on label={sub.slice(2)} hint="From this device" onClick={() => {}} />}
                {info.ai && ai.state === 'done' && <Opt on={sub === 'ai'} label="AI generated" hint="Made on your VPS with Whisper" onClick={() => pickSub('ai')} />}
                {info.ai && ai.state === 'running' && <p className="mnote">Generating subtitles on the VPS… {clock(ai.elapsed)} so far. You can keep watching.</p>}
                {info.ai && (ai.state === 'none' || ai.state === 'error') && (
                  <button className="opt" onClick={genAi}><span><b><Icon n="sparkle" s={15} /> Generate subtitles with AI</b><small>Uses Whisper on the VPS. A full movie can take a while on a CPU.</small></span></button>
                )}
                {ai.state === 'error' && ai.error && <p className="mnote err">{ai.error}</p>}
                {!info.ai && !(info.subs?.length || info.external?.length) && <p className="mnote">No subtitles found. Load a file below, or install Whisper on the VPS to generate them automatically (see README).</p>}
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

            {menu === 'enhance' && (
              <>
                <Row label={`Zoom ${zoom}%`}><Slider value={zoom} min={100} max={250} step={5} onChange={setZoom} /></Row>
                <Row label={`Brightness ${fx.b}%`}><Slider value={fx.b} min={50} max={150} onChange={(v) => setFx({ ...fx, b: v })} /></Row>
                <Row label={`Contrast ${fx.c}%`}><Slider value={fx.c} min={50} max={150} onChange={(v) => setFx({ ...fx, c: v })} /></Row>
                <Row label={`Color ${fx.s}%`}><Slider value={fx.s} min={0} max={200} onChange={(v) => setFx({ ...fx, s: v })} /></Row>
                <Row label={`Volume boost ${boost}%`}><Slider value={boost} min={100} max={300} step={10} onChange={setBoost} /></Row>
                <Switch on={night} label="Night mode (quiet explosions, clearer dialogue)" onClick={() => setNight((x) => !x)} />
                <button className="opt" onClick={() => { setZoom(100); setFx({ b: 100, c: 100, s: 100 }); setBoost(100); setNight(false); }}><span><b>Reset picture and sound</b></span></button>
              </>
            )}

            {menu === 'more' && (
              <>
                <Switch on={s.autoNext} label="Play next episode automatically" onClick={() => set({ autoNext: !s.autoNext })} />
                <div className="msec">Sleep timer</div>
                <Opt on={sleep === null} label="Off" onClick={() => setSleep(null)} />
                {[15, 30, 60].map((m) => <Opt key={m} on={typeof sleep === 'number' && Math.abs(sleep - Date.now() - m * 60000) < 90000} label={`${m} minutes`} onClick={() => { setSleep(Date.now() + m * 60000); flash(`Will pause in ${m} minutes`); }} />)}
                <Opt on={sleep === 'end'} label="After this video" onClick={() => setSleep('end')} />
                <div className="msec">Tools</div>
                <button className="opt" onClick={shot}><span><b><Icon n="camera" s={15} /> Save screenshot (S)</b></span></button>
                <button className="opt" onClick={pip}><span><b><Icon n="pip" s={15} /> Picture-in-picture (P)</b></span></button>
                <a className="opt" href={`/api/download?${qs({ root: p.root, path })}`}><span><b><Icon n="down" s={15} /> Download this video</b></span></a>
                <button className="opt danger" onClick={() => p.onDelete(p.name)}><span><b><Icon n="trash" s={15} /> Delete from server</b></span></button>
                <p className="mnote keys">Space play · ←/→ 10s · ↑/↓ volume · F fullscreen · C subtitles · A screen shape · &lt; &gt; speed · 0–9 jump · N next · I stats</p>
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
            <i className="track" /><i className="buffered" style={{ width: `${bufFrac * 100}%` }} /><i className="played" style={{ width: `${frac * 100}%` }} /><i className="knob" style={{ left: `${frac * 100}%` }} />
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
              <Slider value={muted ? 0 : vol} min={0} max={1} step={0.02} onChange={(v) => { setMuted(false); setVol(v); }} />
            </span>
            <span className="time">{clock(shown)} <i>/</i> {total ? clock(total) : '–:––'}</span>
            <span className="grow" />
            <button className={sub !== 'off' ? 'cbtn lit' : 'cbtn'} onClick={() => toggle('subs')} title="Subtitles (C)" aria-label="Subtitles"><Icon n="cc" s={20} /></button>
            {(info.audio?.length ?? 0) > 1 && cbtn('audio', 'audio', 'Audio track')}
            {cbtn('speed', 'gauge', `Speed ${speed}×`)}
            {cbtn('quality', 'film', 'Quality')}
            {cbtn('aspect', 'aspect', 'Screen shape (A)')}
            {cbtn('enhance', 'sliders', 'Picture and sound')}
            {cbtn('more', 'more', 'More')}
            <button className="cbtn" onClick={toggleFs} title="Fullscreen (F)" aria-label="Fullscreen"><Icon n={fs ? 'exitfs' : 'full'} s={20} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}