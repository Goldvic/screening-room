// "Play on TV": a TV opens /tv in its browser and shows a short code. You enter it once on your phone and the TV is paired.
// After that the phone sends commands (play this, pause, seek, volume, next) and the TV reports what it is doing.
// Both stay connected with Server-Sent Events, so nothing needs the laptop: it works from the same server that serves the app.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Access } from './access';

type Dev = { id: string; secret: string; name: string; paired: boolean; code: string; created: number; seen: number };
type Live = { events?: Response; watchers: Set<Response>; state?: any; stateAt?: number };

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L to avoid misreading a TV screen from across the room
const CMDS = new Set(['load', 'toggle', 'play', 'pause', 'skip', 'seek', 'vol', 'mute', 'next', 'prev', 'stop', 'audio']);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function createTv(o: { dataDir: string; access: Access }) {
  const file = path.join(o.dataDir, 'tv.json');
  const devs = new Map<string, Dev>();
  const live = new Map<string, Live>();
  try { for (const d of JSON.parse(fs.readFileSync(file, 'utf8')) as Dev[]) devs.set(d.id, d); } catch { /* first run */ }
  let dirty = false;
  const save = () => { dirty = true; };
  const flush = () => { if (!dirty) return; dirty = false; try { fs.mkdirSync(o.dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify([...devs.values()])); } catch { /* ignore */ } };
  const timer = setInterval(() => {
    flush();
    const now = Date.now();
    for (const [id, d] of devs) if (!d.paired && now - d.created > 15 * 60_000) { devs.delete(id); live.delete(id); save(); }   // an unused code expires
  }, 20_000);
  timer.unref?.();

  const L = (id: string): Live => { let l = live.get(id); if (!l) { l = { watchers: new Set() }; live.set(id, l); } return l; };
  const newCode = () => { for (;;) { let c = ''; for (let i = 0; i < 6; i++) c += CODE_CHARS[randomBytes(1)[0] % CODE_CHARS.length]; if (![...devs.values()].some((d) => d.code === c)) return c; } };
  const authDev = (id: unknown, secret: unknown) => { const d = devs.get(String(id ?? '')); return d && same(hash(String(secret ?? '')), d.secret) ? d : undefined; };
  const sse = (res: Response) => { res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); res.write('retry: 2000\n\n'); };
  const push = (res: Response | undefined, ev: string, data: unknown) => { try { res?.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ } };
  const online = (id: string) => !!live.get(id)?.events;
  const tell = (id: string) => { const l = live.get(id); if (l) for (const w of l.watchers) push(w, 'state', { online: online(id), state: l.state ?? null }); };

  // Registration attempts per address (this is open to anyone who can reach /tv)
  const regs = new Map<string, number[]>();
  const regOk = (ip: string) => { const now = Date.now(), a = (regs.get(ip) ?? []).filter((t) => now - t < 3_600_000); if (a.length >= 20) return false; a.push(now); regs.set(ip, a); return true; };

  // Routes the TV itself uses: it proves who it is with its id and secret, so they sit in front of the login gate.
  function attachPublic(app: Express) {
    const json = express.json({ limit: '32kb' });

    app.post('/api/tv/register', json, (req, res) => {
      if (!o.access.enabled) return res.status(404).json({ error: 'Not available' });
      if (!regOk(o.access.ipOf(req))) return res.status(429).json({ error: 'Too many requests' });
      if ([...devs.values()].filter((d) => !d.paired).length > 200) return res.status(429).json({ error: 'Busy' });
      const id = randomBytes(9).toString('base64url'), secret = randomBytes(24).toString('base64url');
      const name = String(req.body?.name ?? '').replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'TV';
      const d: Dev = { id, secret: hash(secret), name, paired: false, code: newCode(), created: Date.now(), seen: Date.now() };
      devs.set(id, d); save();
      res.json({ id, secret, code: d.code, name });
    });

    // The TV trades its id and secret for a viewer session once it has been paired (and again whenever the cookie is gone).
    app.post('/auth/tv', json, (req, res) => {
      const d = authDev(req.body?.id, req.body?.secret);
      if (!d) return res.status(404).json({ error: 'Unknown TV' });
      d.seen = Date.now();
      if (!d.paired) return res.json({ ok: false, waiting: true, code: d.code });
      o.access.issue(req, res, 'viewer', 180);
      res.json({ ok: true, name: d.name });
    });

    // The TV's long connection: it receives commands here.
    app.get('/api/tv/events', (req, res) => {
      const d = authDev(req.query.id, req.query.secret);
      if (!d || !d.paired) return res.status(401).end();
      const l = L(d.id);
      if (l.events && l.events !== res) { try { l.events.end(); } catch { /* gone */ } }
      sse(res); l.events = res; d.seen = Date.now();
      push(res, 'hello', { name: d.name });
      tell(d.id);
      const beat = setInterval(() => { try { res.write(': \n\n'); } catch { /* closed */ } }, 15_000);
      req.on('close', () => { clearInterval(beat); if (l.events === res) { l.events = undefined; tell(d.id); } });
    });

    // What the TV is doing now (position, title, playing...). The phone sees this.
    app.post('/api/tv/state', json, (req, res) => {
      const d = authDev(req.body?.id, req.body?.secret);
      if (!d || !d.paired) return res.status(401).json({ error: 'Not paired' });
      const s = req.body?.s ?? {};
      L(d.id).state = {
        title: String(s.title ?? '').slice(0, 200), name: String(s.name ?? '').slice(0, 300), pos: Number(s.pos) || 0, dur: Number(s.dur) || 0,
        playing: !!s.playing, vol: Math.max(0, Math.min(1, Number(s.vol) || 0)), muted: !!s.muted, idx: Number(s.idx) || 0, count: Number(s.count) || 0, buffering: !!s.buffering, idle: !!s.idle, err: s.err ? String(s.err).slice(0, 200) : undefined,
      };
      L(d.id).stateAt = Date.now();
      tell(d.id);
      res.json({ ok: true });
    });
  }

  // Routes the phone uses (these sit behind the login gate).
  function attachPrivate(app: Express) {
    const json = express.json({ limit: '256kb' });

    app.post('/api/tv/pair', json, (req, res) => {
      const code = String(req.body?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const ip = o.access.ipOf(req), wait = o.access.locked(ip);
      if (wait) return res.status(429).json({ error: `Too many tries. Wait ${wait} s.` });
      const d = [...devs.values()].find((x) => !x.paired && x.code === code);
      if (!d) { o.access.fail(ip); return res.status(404).json({ error: 'That code is not on a TV screen right now.' }); }
      d.paired = true; d.seen = Date.now();
      const n = String(req.body?.name ?? '').replace(/[^\w .'-]/g, '').trim().slice(0, 40);
      if (n) d.name = n;
      save(); flush();
      res.json({ ok: true, id: d.id, name: d.name });
    });

    app.get('/api/tv/list', (_req, res) => {
      res.set('Cache-Control', 'no-store').json([...devs.values()].filter((d) => d.paired).map((d) => ({ id: d.id, name: d.name, online: online(d.id), state: live.get(d.id)?.state ?? null })));
    });

    app.post('/api/tv/unpair', json, (req, res) => {
      const id = String(req.body?.id ?? '');
      const l = live.get(id);
      if (l?.events) { push(l.events, 'unpaired', {}); try { l.events.end(); } catch { /* gone */ } }
      devs.delete(id); live.delete(id); save(); flush();
      res.json({ ok: true });
    });

    app.post('/api/tv/cmd', json, (req, res) => {
      const id = String(req.body?.id ?? ''), cmd = req.body?.cmd;
      const d = devs.get(id);
      if (!d || !d.paired) return res.status(404).json({ error: 'Unknown TV' });
      if (!cmd || typeof cmd.t !== 'string' || !CMDS.has(cmd.t)) return res.status(400).json({ error: 'Bad command' });
      if (cmd.t === 'load') {
        // only what the TV needs, and no more than it should have to trust
        const items = (Array.isArray(cmd.items) ? cmd.items : []).slice(0, 500).map((i: any) => ({ n: String(i?.n ?? '').slice(0, 300), p: String(i?.p ?? '').slice(0, 600), k: String(i?.k ?? '').slice(0, 700) }));
        cmd.items = items; cmd.root = Number(cmd.root) || 0; cmd.idx = Math.max(0, Math.floor(Number(cmd.idx) || 0)); cmd.pos = Math.max(0, Number(cmd.pos) || 0);
        cmd.title = String(cmd.title ?? '').slice(0, 200);
      }
      const l = live.get(id);
      if (!l?.events) return res.status(409).json({ error: `${d.name} is not open. Open the Cinema page on the TV.` });
      push(l.events, 'cmd', cmd);
      res.json({ ok: true });
    });

    // The phone's long connection: it receives what the TV is doing.
    app.get('/api/tv/watch', (req, res) => {
      const id = String(req.query.id ?? '');
      const d = devs.get(id);
      if (!d || !d.paired) return res.status(404).end();
      const l = L(id);
      sse(res); l.watchers.add(res);
      push(res, 'state', { online: online(id), state: l.state ?? null });
      const beat = setInterval(() => { try { res.write(': \n\n'); } catch { /* closed */ } }, 15_000);
      req.on('close', () => { clearInterval(beat); l.watchers.delete(res); });
    });
  }

  return { attachPublic, attachPrivate, close: () => { clearInterval(timer); flush(); } };
}
