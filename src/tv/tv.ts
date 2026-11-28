// The TV page (/tv). A TV opens it, shows a pairing code, then plays what the phone sends.
import Hls from 'hls.js';
import qrcode from 'qrcode-generator';

type Item = { n: string; p: string; k: string };
type Reg = { id: string; secret: string; name?: string };
type Cur = { root: number; items: Item[]; idx: number; a: number; title: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const v = $<HTMLVideoElement>('v');
const KEY = 'cinemaTv';
const SID = 'tv' + Math.random().toString(36).slice(2, 8);
const J = { 'Content-Type': 'application/json' };

let reg: Reg | null = null;
let cur: Cur | null = null;
let hls: Hls | null = null;
let es: EventSource | null = null;
let pending = 0;               // where to start the next video (seconds)
let hudTimer = 0, toastTimer = 0, lastSave = 0, lastState = 0, fatalTries = 0, fellBack = false;

const show = (id: 'boot' | 'pair' | 'ready' | 'fail' | null) => { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id); };
const toast = (t: string) => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => e.classList.remove('on'), 1800); };
const clock = (s: number) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: J, body: JSON.stringify(body) });
const stored = (): Reg | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
const nice = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();

// ---------- hud ----------
function wakeHud(ms = 4000) {
  $('hud').classList.add('on');
  clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => { if (!v.paused) $('hud').classList.remove('on'); }, ms);
}
function paintHud() {
  const d = v.duration || 0;
  $('fill').style.width = d ? `${Math.min(100, (v.currentTime / d) * 100)}%` : '0%';
  $('t1').textContent = clock(v.currentTime); $('t2').textContent = d ? clock(d) : '';
}

// ---------- reporting back to the phone and saving progress ----------
function sendState(extra: Record<string, unknown> = {}) {
  if (!reg) return;
  const it = cur?.items[cur.idx];
  post('/api/tv/state', { id: reg.id, secret: reg.secret, s: {
    title: cur?.title || (it ? nice(it.n) : ''), name: it?.n ?? '', pos: v.currentTime || 0, dur: Number.isFinite(v.duration) ? v.duration : 0,
    playing: !v.paused && !v.ended, vol: v.volume, muted: v.muted, idx: cur?.idx ?? 0, count: cur?.items.length ?? 0, buffering: $('buf').classList.contains('on'), idle: !cur, ...extra,
  } }).catch(() => {});
}
function saveProgress(watched?: boolean) {
  const it = cur?.items[cur.idx];
  if (!it || !it.k || !(v.currentTime > 1 || watched)) return;
  fetch('/api/progress', { method: 'POST', headers: J, keepalive: true, body: JSON.stringify({ key: it.k, pos: v.currentTime, dur: Number.isFinite(v.duration) ? v.duration : 0, watched }) }).catch(() => {});
}

// ---------- playback ----------
function destroyHls() { if (hls) { hls.destroy(); hls = null; } }
const qsOf = (o: Record<string, string | number>) => Object.entries(o).map(([k, x]) => `${k}=${encodeURIComponent(String(x))}`).join('&');

function start(idx: number, pos = 0) {
  if (!cur || !cur.items[idx]) return;
  cur.idx = idx; pending = pos; fatalTries = 0; fellBack = false;
  const it = cur.items[idx];
  destroyHls();
  show(null);
  $('ttl').textContent = (idx === 0 && cur.title) ? cur.title : nice(it.n);
  $('buf').classList.add('on'); wakeHud(5000);
  const master = `/api/hls/master.m3u8?${qsOf({ root: cur.root, path: it.p, q: 'auto', a: cur.a, sid: SID })}`;
  const direct = `/api/stream?${qsOf({ root: cur.root, path: it.p, q: 'orig', sid: SID })}`;
  if (Hls.isSupported()) {
    hls = new Hls({ startPosition: pos > 1 ? pos : -1, maxBufferLength: 40, enableWorker: true });
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      if (++fatalTries <= 3) { if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError(); else hls?.startLoad(); return; }
      fallback(direct);
    });
    hls.loadSource(master); hls.attachMedia(v);
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = master; }
  else { v.src = direct; fellBack = true; }
  v.play().catch(() => { /* waits for the first interaction on some TVs */ });
  sendState();
}
function fallback(direct: string) {
  if (fellBack) { $('buf').classList.remove('on'); toast('This video cannot be played on this TV'); sendState({ err: 'Cannot play on this TV' }); return; }
  fellBack = true; destroyHls(); toast('Switching to a simpler stream…');
  v.src = direct; v.play().catch(() => {});
}
function step(by: number) {
  if (!cur) return;
  const n = cur.idx + by;
  if (n < 0 || n >= cur.items.length) { if (by > 0) toast('That was the last one'); else v.currentTime = 0; return; }
  saveProgress();
  start(n, 0);
}
function goIdle() { saveProgress(); destroyHls(); v.removeAttribute('src'); v.load(); cur = null; $('hud').classList.remove('on'); $('buf').classList.remove('on'); show('ready'); sendState({ idle: true }); }

v.addEventListener('loadedmetadata', () => { if (pending > 1 && !hls) v.currentTime = pending; pending = 0; });
v.addEventListener('playing', () => { $('buf').classList.remove('on'); sendState(); });
v.addEventListener('waiting', () => { $('buf').classList.add('on'); });
v.addEventListener('pause', () => { wakeHud(60_000); sendState(); });
v.addEventListener('play', () => { wakeHud(); sendState(); });
v.addEventListener('seeked', () => sendState());
v.addEventListener('volumechange', () => sendState());
v.addEventListener('error', () => { if (cur && !hls) { const it = cur.items[cur.idx]; if (it) fallback(`/api/stream?${qsOf({ root: cur.root, path: it.p, q: 'orig', sid: SID })}`); } });
v.addEventListener('ended', () => {
  saveProgress(true);
  if (cur && cur.idx + 1 < cur.items.length) start(cur.idx + 1, 0); else goIdle();
});
v.addEventListener('timeupdate', () => {
  paintHud();
  const now = Date.now();
  if (now - lastState > 1000) { lastState = now; sendState(); }
  if (now - lastSave > 10_000) { lastSave = now; saveProgress(); }
});

// ---------- commands from the phone ----------
function onCmd(c: any) {
  switch (c?.t) {
    case 'load': {
      const items: Item[] = Array.isArray(c.items) ? c.items : [];
      if (!items.length) return;
      cur = { root: Number(c.root) || 0, items, idx: Math.min(items.length - 1, Math.max(0, Number(c.idx) || 0)), a: Number(c.a) || 0, title: String(c.title ?? '') };
      start(cur.idx, Number(c.pos) || 0);
      break;
    }
    case 'toggle': if (v.paused) v.play().catch(() => {}); else v.pause(); toast(v.paused ? 'Paused' : 'Playing'); break;
    case 'play': v.play().catch(() => {}); break;
    case 'pause': v.pause(); break;
    case 'skip': v.currentTime = Math.max(0, Math.min(v.duration || 1e9, v.currentTime + (Number(c.by) || 0))); toast(`${c.by > 0 ? '+' : ''}${c.by} s`); wakeHud(); break;
    case 'seek': if (Number.isFinite(Number(c.to))) { v.currentTime = Math.max(0, Number(c.to)); wakeHud(); } break;
    case 'vol': v.volume = Math.max(0, Math.min(1, Number(c.v))); v.muted = false; toast(`Volume ${Math.round(v.volume * 100)}%`); break;
    case 'mute': v.muted = !v.muted; toast(v.muted ? 'Muted' : 'Sound on'); break;
    case 'next': step(1); break;
    case 'prev': if (v.currentTime > 5) { v.currentTime = 0; } else step(-1); break;
    case 'audio': if (cur) { cur.a = Number(c.a) || 0; start(cur.idx, v.currentTime); } break;
    case 'stop': goIdle(); break;
  }
}

// ---------- remote control keys on the TV itself ----------
addEventListener('keydown', (e) => {
  if (!cur) return;
  const k = e.key;
  if (k === 'Enter' || k === ' ' || k === 'MediaPlayPause' || e.keyCode === 415 || e.keyCode === 19) { onCmd({ t: 'toggle' }); e.preventDefault(); }
  else if (k === 'ArrowRight' || k === 'MediaFastForward' || e.keyCode === 417) { onCmd({ t: 'skip', by: 10 }); e.preventDefault(); }
  else if (k === 'ArrowLeft' || k === 'MediaRewind' || e.keyCode === 412) { onCmd({ t: 'skip', by: -10 }); e.preventDefault(); }
  else if (k === 'ArrowUp') { onCmd({ t: 'vol', v: v.volume + 0.1 }); e.preventDefault(); }
  else if (k === 'ArrowDown') { onCmd({ t: 'vol', v: v.volume - 0.1 }); e.preventDefault(); }
  else if (k === 'MediaTrackNext') onCmd({ t: 'next' });
  else if (k === 'MediaTrackPrevious') onCmd({ t: 'prev' });
  else if (k === 'MediaStop' || e.keyCode === 413) onCmd({ t: 'stop' });
  wakeHud();
});

// ---------- connection ----------
function connect() {
  if (!reg) return;
  show(cur ? null : 'ready');
  $('rname').textContent = reg.name || 'Cinema TV';
  es?.close();
  es = new EventSource(`/api/tv/events?${qsOf({ id: reg.id, secret: reg.secret })}`);
  es.addEventListener('hello', (e) => { $('conn').classList.remove('on'); try { const n = JSON.parse((e as MessageEvent).data).name; if (n && reg) { reg.name = n; $('rname').textContent = n; localStorage.setItem(KEY, JSON.stringify(reg)); } } catch { /* ignore */ } });
  es.addEventListener('cmd', (e) => { try { onCmd(JSON.parse((e as MessageEvent).data)); } catch { /* ignore */ } });
  es.addEventListener('unpaired', () => { localStorage.removeItem(KEY); location.reload(); });
  es.onerror = async () => {
    $('conn').classList.add('on');
    // If the server no longer knows this TV (it was removed), start over; otherwise the browser reconnects by itself.
    try { const r = await post('/auth/tv', { id: reg!.id, secret: reg!.secret }); if (r.status === 404) { localStorage.removeItem(KEY); location.reload(); } } catch { /* offline: keep trying */ }
  };
  if ('wakeLock' in navigator) (navigator as any).wakeLock.request('screen').catch(() => {});
}

async function waitForPairing(): Promise<void> {
  if (!reg) return;
  show('pair');
  $('host').textContent = location.host;
  try { const q = qrcode(0, 'M'); q.addData(location.origin); q.make(); $('qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch { $('qr').style.display = 'none'; }
  for (;;) {
    try {
      const r = await post('/auth/tv', { id: reg.id, secret: reg.secret });
      if (r.status === 404) { localStorage.removeItem(KEY); return boot(); }
      const j = await r.json();
      if (j.ok) { if (j.name) reg.name = j.name; localStorage.setItem(KEY, JSON.stringify(reg)); return connect(); }
      if (j.code) $('code').textContent = j.code;
    } catch { /* server unreachable: keep trying */ }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

async function boot(): Promise<void> {
  show('boot');
  reg = stored();
  try {
    if (reg) {
      const r = await post('/auth/tv', { id: reg.id, secret: reg.secret });
      if (r.status === 404) { localStorage.removeItem(KEY); reg = null; }
      else { const j = await r.json(); if (j.ok) { if (j.name) reg.name = j.name; return connect(); } if (j.code) { $('code').textContent = j.code; return waitForPairing(); } }
    }
    if (!reg) {
      const r = await post('/api/tv/register', { name: /android|tizen|web0s|webos|smart-?tv|bravia|aft/i.test(navigator.userAgent) ? 'TV' : 'This screen' });
      if (!r.ok) throw new Error(r.status === 404 ? 'Phone and TV access is not turned on for this server.' : 'The server refused the request.');
      const j = await r.json();
      reg = { id: j.id, secret: j.secret, name: j.name };
      localStorage.setItem(KEY, JSON.stringify(reg));
      $('code').textContent = j.code;
      return waitForPairing();
    }
  } catch (e) {
    $('failmsg').textContent = String((e as Error).message || e);
    show('fail');
    setTimeout(boot, 5000);
  }
}
boot();
