// "Play on TV" from the phone (or any browser): pair a TV with its on-screen code, send what you are watching, and control it
// from here while you keep browsing. Works through the server, so it does not need the laptop.
import { useEffect, useReducer, useState } from 'react';
import { Icon } from './lib';

export type TvState = { title: string; name: string; pos: number; dur: number; playing: boolean; vol: number; muted: boolean; idx: number; count: number; buffering: boolean; idle: boolean; err?: string };
type Dev = { id: string; name: string; online: boolean; state: TvState | null };

// ---------- shared store (one connection for the whole app) ----------
const SEL = 'cinemaTvSel';
let devs: Dev[] = [];
let sel = (() => { try { return localStorage.getItem(SEL) ?? ''; } catch { return ''; } })();
let live: { online: boolean; state: TvState | null } = { online: false, state: null };
let es: EventSource | null = null;
let started = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function watch() {
  es?.close(); es = null; live = { online: false, state: null };
  if (!sel) return;
  const id = sel;
  es = new EventSource(`/api/tv/watch?id=${encodeURIComponent(id)}`);
  es.addEventListener('state', (e) => { if (id !== sel) return; try { live = JSON.parse((e as MessageEvent).data); } catch { /* ignore */ } emit(); });
}
async function refresh() {
  try {
    const r = await fetch('/api/tv/list', { cache: 'no-store' });
    if (!r.ok) return;
    devs = await r.json();
    if (!devs.some((d) => d.id === sel)) { sel = devs[0]?.id ?? ''; try { localStorage.setItem(SEL, sel); } catch { /* ignore */ } }
    watch(); emit();
  } catch { /* offline */ }
}
function choose(id: string) { sel = id; try { localStorage.setItem(SEL, id); } catch { /* ignore */ } watch(); emit(); }

async function call(url: string, body: unknown): Promise<string | undefined> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return undefined;
    return (await r.json().catch(() => ({}))).error || r.statusText;
  } catch { return 'No connection'; }
}
const send = (cmd: Record<string, unknown>) => (sel ? call('/api/tv/cmd', { id: sel, cmd }) : Promise.resolve('No TV chosen'));

export function useTv() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    subs.add(bump);
    if (!started) { started = true; refresh(); }
    return () => { subs.delete(bump); };
  }, []);
  const dev = devs.find((d) => d.id === sel);
  return {
    devs, sel, dev, live, send, refresh, choose,
    pair: async (code: string) => { const e = await call('/api/tv/pair', { code }); await refresh(); if (!e) { const last = devs[devs.length - 1]; if (last) choose(last.id); } return e; },
    unpair: async (id: string) => { await call('/api/tv/unpair', { id }); await refresh(); },
  };
}

const fmt = (x: number) => { x = Math.max(0, Math.floor(x || 0)); const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };

// ---------- the remote (buttons and seek bar) ----------
export function TvControls({ compact = false }: { compact?: boolean }) {
  const tv = useTv();
  const st = tv.live.state;
  const [drag, setDrag] = useState<number | null>(null);
  if (!tv.dev || !st || st.idle) return null;
  const pos = drag ?? st.pos;
  return (
    <div className={compact ? 'tvctl compact' : 'tvctl'}>
      <div className="tvctl-title" title={st.title}>{st.title || st.name}{st.count > 1 && <small> · {st.idx + 1} of {st.count}</small>}</div>
      <input type="range" min={0} max={Math.max(1, Math.floor(st.dur))} value={Math.floor(pos)} aria-label="Position"
        onChange={(e) => setDrag(+e.target.value)} onPointerUp={() => { if (drag !== null) { tv.send({ t: 'seek', to: drag }); setDrag(null); } }} onKeyUp={() => { if (drag !== null) { tv.send({ t: 'seek', to: drag }); setDrag(null); } }} />
      <div className="tvctl-time"><span>{fmt(pos)}</span><span>{st.buffering ? 'Loading…' : st.err ? st.err : ''}</span><span>{fmt(st.dur)}</span></div>
      <div className="tvctl-btns">
        <button onClick={() => tv.send({ t: 'prev' })} aria-label="Previous video" title="Previous"><Icon n="prev" s={20} /></button>
        <button onClick={() => tv.send({ t: 'skip', by: -10 })} aria-label="Back 10 seconds" title="Back 10 seconds"><Icon n="back10" s={22} /></button>
        <button className="main" onClick={() => tv.send({ t: 'toggle' })} aria-label={st.playing ? 'Pause' : 'Play'}><Icon n={st.playing ? 'pause' : 'play'} s={26} /></button>
        <button onClick={() => tv.send({ t: 'skip', by: 10 })} aria-label="Forward 10 seconds" title="Forward 10 seconds"><Icon n="fwd10" s={22} /></button>
        <button onClick={() => tv.send({ t: 'next' })} aria-label="Next video" title="Next"><Icon n="next" s={20} /></button>
      </div>
      <div className="tvctl-vol">
        <button onClick={() => tv.send({ t: 'mute' })} aria-label={st.muted ? 'Unmute' : 'Mute'}><Icon n={st.muted || st.vol === 0 ? 'mute' : 'volume'} s={18} /></button>
        <input type="range" min={0} max={100} value={Math.round((st.muted ? 0 : st.vol) * 100)} aria-label="TV volume" onChange={(e) => tv.send({ t: 'vol', v: +e.target.value / 100 })} />
        <button className="stop" onClick={() => tv.send({ t: 'stop' })} aria-label="Stop on TV">Stop</button>
      </div>
    </div>
  );
}

// ---------- the sheet: choose a TV, pair a new one, send what is playing ----------
export function TvSheet({ onClose, onSend, modal = false }: { onClose: () => void; onSend?: (send: (c: Record<string, unknown>) => Promise<string | undefined>) => Promise<string | undefined>; modal?: boolean }) {
  const tv = useTv();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const paired = tv.devs.length > 0;
  const pairNow = async () => {
    setBusy(true); setMsg('');
    const e = await tv.pair(code);
    setBusy(false);
    if (e) setMsg(e); else setCode('');
  };
  const sendNow = async () => {
    if (!onSend) return;
    setBusy(true); setMsg('');
    const e = await onSend(tv.send);
    setBusy(false);
    if (e) setMsg(e);
  };
  return (
    <div className={modal ? 'castbox de-cast tvsheet modal' : 'castbox de-cast tvsheet'} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Play on TV">
      <div className="castbox-h">
        <div><b><Icon n="cast" s={16} /> Play on TV</b><span className="dlg-sub">Works from anywhere, the laptop can stay off</span></div>
        <button className="cbtn sm" onClick={onClose} aria-label="Close"><Icon n="close" s={16} /></button>
      </div>

      <div className="castlist">
        {tv.devs.map((d) => (
          <div key={d.id} className={d.id === tv.sel ? 'opt on tvdev' : 'opt tvdev'} role="button" tabIndex={0} onClick={() => tv.choose(d.id)} onKeyDown={(e) => { if (e.key === 'Enter') tv.choose(d.id); }}>
            <span><b>{d.name}</b><small>{d.online ? 'Ready' : 'Not open. Open the Cinema page on that TV'}</small></span>
            <i className={d.online ? 'tvdot on' : 'tvdot'} />
            <button className="cbtn sm" onClick={(e) => { e.stopPropagation(); if (confirm(`Remove ${d.name}?`)) tv.unpair(d.id); }} aria-label={`Remove ${d.name}`} title="Remove this TV"><Icon n="trash" s={15} /></button>
          </div>
        ))}

        {onSend && tv.dev && (
          <span className="inline"><button className="btn" disabled={busy || !tv.dev.online} onClick={sendNow}>{busy ? 'Sending…' : `Play this on ${tv.dev.name}`}</button></span>
        )}
        {msg && <span className="kstat bad">{msg}</span>}
        {tv.dev?.online && <TvControls />}

        <div className="tvpair">
          <b>{paired ? 'Add another TV' : 'Pair your TV'}</b>
          <p className="muted small">On the TV, open its web browser and go to <span className="tvurl">{location.host}/tv</span>. It shows a 6-letter code. Type it here.</p>
          <div className="tvpair-row">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} placeholder="CODE" inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} aria-label="Code shown on the TV"
              onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) pairNow(); }} />
            <button className="btn" disabled={busy || code.length < 6} onClick={pairNow}>Pair</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- the small remote that stays on screen while you browse ----------
export function TvDock() {
  const tv = useTv();
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(false);
  const st = tv.live.state;
  const show = !!tv.dev && tv.live.online && !!st && !st.idle;
  if (!show && !open) return null;
  return (
    <>
      {show && st && (
        <div className={big ? 'tvdock big' : 'tvdock'}>
          <div className="tvdock-top" onClick={() => setBig((x) => !x)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setBig((x) => !x); }}>
            <Icon n="cast" s={16} />
            <span className="tvdock-name"><b>{st.title || st.name}</b><small>On {tv.dev?.name}</small></span>
            <button onClick={(e) => { e.stopPropagation(); tv.send({ t: 'toggle' }); }} aria-label={st.playing ? 'Pause' : 'Play'}><Icon n={st.playing ? 'pause' : 'play'} s={20} /></button>
            <button onClick={(e) => { e.stopPropagation(); setOpen(true); }} aria-label="TV options" title="TV options"><Icon n="more" s={20} /></button>
          </div>
          <div className="tvdock-bar"><i style={{ width: `${st.dur ? Math.min(100, (st.pos / st.dur) * 100) : 0}%` }} /></div>
          {big && <TvControls compact />}
        </div>
      )}
      {open && <TvSheet modal onClose={() => setOpen(false)} />}
    </>
  );
}
