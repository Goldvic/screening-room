// Access control for when Cinema is reachable from other devices (your phone, a TV, the internet).
//
//   ACCESS_PIN       short code for family and guests: they can browse and watch, nothing else  ("viewer")
//   ADMIN_PASSWORD   your own password: the whole app                                           ("admin")
//
// Both give a long-lasting signed cookie, so a phone only logs in once. The server itself enforces what a viewer may call;
// hiding buttons in the app is only a courtesy. Not used by the desktop app, which has its own private secret.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Express, NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';

export type Role = 'admin' | 'viewer';
declare module 'express-serve-static-core' { interface Request { role?: Role } }

// What a viewer may call. Everything else is for the owner only (settings, servers, downloads, deleting, backups, ...).
const VIEWER_GET = /^\/api\/(prefs|caps|roots|list|info|intro|subs|thumb|sprite|progress|stream|download|meta|meta\/search|poster|folder-poster|trailer|whoami|profiles|net|tv\/list|tv\/watch|hls\/(master\.m3u8|level\.m3u8|seg\.ts))$/;
const VIEWER_POST = /^\/api\/(progress|prefs|opened|tv\/(pair|cmd|unpair))$/;
const STATIC_FILE = /^\/(assets\/|favicon|icon\.svg|manifest\.webmanifest)|\.(js|css|svg|png|jpg|jpeg|webp|ico|woff2?|map)$/i;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const eq = (a: string, b: string) => { const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest(); return timingSafeEqual(x, y); };

export type Access = ReturnType<typeof createAccess>;

export function createAccess(o: { dataDir: string; pin?: string; admin?: string; dist: string }) {
  const pin = (o.pin ?? '').trim(), admin = (o.admin ?? '').trim();
  const enabled = !!(pin || admin);
  const keyFile = path.join(o.dataDir, 'access.key');
  let secret = '';
  try { secret = fs.readFileSync(keyFile, 'utf8').trim(); } catch { /* first run */ }
  if (secret.length < 32) { secret = randomBytes(32).toString('hex'); try { fs.mkdirSync(o.dataDir, { recursive: true }); fs.writeFileSync(keyFile, secret, { mode: 0o600 }); } catch { /* keep in memory */ } }
  // Changing the PIN or the password signs everybody out: it is part of what a session is signed with.
  const stamp = createHash('sha256').update(`${secret}|${pin}|${admin}`).digest('hex').slice(0, 10);
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('base64url');

  const makeToken = (r: Role, days: number) => { const body = b64(JSON.stringify({ r, e: Date.now() + days * 864e5, s: stamp })); return `${body}.${sign(body)}`; };
  const readToken = (t: string | undefined): Role | undefined => {
    if (!t) return undefined;
    const [body, sig] = t.split('.');
    if (!body || !sig || !eq(sig, sign(body))) return undefined;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); if (p.s === stamp && p.e > Date.now() && (p.r === 'admin' || p.r === 'viewer')) return p.r; } catch { /* bad */ }
    return undefined;
  };
  const cookieOf = (req: Request) => /(?:^|;\s*)cinema_s=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const issue = (req: Request, res: Response, r: Role, days = 60) => {
    const secure = req.secure || String(req.headers['x-forwarded-proto'] ?? '').includes('https');
    res.append('Set-Cookie', `cinema_s=${makeToken(r, days)}; Path=/; Max-Age=${days * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  };

  // Guessing the PIN: lock out an address after repeated failures, for longer each time.
  const tries = new Map<string, { n: number; until: number; at: number }>();
  const ipOf = (req: Request) => req.ip || req.socket.remoteAddress || 'x';
  const locked = (ip: string) => { const t = tries.get(ip); return t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0; };
  const fail = (ip: string) => {
    const t = tries.get(ip) ?? { n: 0, until: 0, at: 0 };
    t.n++; t.at = Date.now();
    if (t.n >= 5) t.until = Date.now() + Math.min(2 ** (t.n - 5) * 30_000, 15 * 60_000);
    tries.set(ip, t);
    if (tries.size > 5000) for (const [k, v] of tries) if (Date.now() - v.at > 3_600_000) tries.delete(k);
  };
  const login = (code: string): Role | undefined => (admin && eq(code, admin) ? 'admin' : pin && eq(code, pin) ? 'viewer' : undefined);

  const safeNext = (n: unknown) => { const s = String(n ?? '/'); return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') ? s : '/'; };

  const page = (next: string, msg = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b0b11"><title>Cinema</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg">
<style>*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:grid;place-items:center;background:radial-gradient(900px 500px at 70% -10%,#2a1d4a,transparent 70%),#0b0b11;color:#f1f1f6;font:16px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:20px}
.c{width:min(380px,100%);text-align:center}.logo{width:64px;height:64px;margin:0 auto 18px;border-radius:18px;background:linear-gradient(135deg,#8b5cf6,#ec4899);display:grid;place-items:center;box-shadow:0 12px 40px #8b5cf655}
.logo i{border-left:20px solid #fff;border-top:12px solid transparent;border-bottom:12px solid transparent;margin-left:6px}h1{font-size:26px;margin:0 0 6px}p{margin:0 0 22px;color:#9a9bb0}
input{width:100%;padding:16px 18px;border-radius:16px;border:1px solid #ffffff26;background:#16161f;color:#fff;font:inherit;font-size:20px;text-align:center;letter-spacing:.12em;outline:0}input:focus{border-color:#8b5cf6;box-shadow:0 0 0 4px #8b5cf633}
button{width:100%;margin-top:12px;padding:16px;border:0;border-radius:16px;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;font:inherit;font-weight:700;font-size:17px;cursor:pointer}button:active{transform:scale(.98)}
.e{min-height:22px;margin-top:14px;color:#ff7a8a;font-size:14px}</style></head><body><form class="c" method="post" action="/auth/login">
<div class="logo"><i></i></div><h1>Cinema</h1><p>Enter your access code</p>
<input name="code" type="password" autocomplete="current-password" autofocus required aria-label="Access code"><input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}">
<button type="submit">Open</button><div class="e">${msg}</div></form></body></html>`;

  const manifest = {
    name: 'Cinema', short_name: 'Cinema', start_url: '/', display: 'standalone', background_color: '#0b0b11', theme_color: '#0b0b11',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect width="96" height="96" rx="24" fill="url(#g)"/><path d="M38 28l30 20-30 20z" fill="#fff"/></svg>`;

  // Registers the public routes (login, icons, the TV page) and then the gate every other request must pass.
  function attach(app: Express) {
    if (!enabled) return;
    const form = [express.json({ limit: '4kb' }), express.urlencoded({ extended: false, limit: '4kb' })];

    app.get('/login', (req, res) => res.set('Cache-Control', 'no-store').type('html').send(page(safeNext(req.query.next))));
    app.post('/auth/login', ...form, async (req: Request, res: Response) => {
      const ip = ipOf(req), wait = locked(ip);
      const wantsJson = String(req.headers.accept ?? '').includes('json');
      const next = safeNext(req.body?.next);
      if (wait) return wantsJson ? res.status(429).json({ error: `Too many tries. Wait ${wait} s.` }) : res.status(429).type('html').send(page(next, `Too many tries. Wait ${wait} seconds.`));
      const role = login(String(req.body?.code ?? '').trim());
      if (!role) {
        fail(ip);
        await new Promise((r) => setTimeout(r, 600));
        return wantsJson ? res.status(401).json({ error: 'Wrong code' }) : res.status(401).type('html').send(page(next, 'That code is not right.'));
      }
      tries.delete(ip);
      issue(req, res, role);
      return wantsJson ? res.json({ ok: true, role }) : res.redirect(303, next);
    });
    app.post('/auth/logout', (req, res) => {
      res.append('Set-Cookie', 'cinema_s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      res.json({ ok: true });
    });
    app.get('/manifest.webmanifest', (_q, res) => res.type('application/manifest+json').json(manifest));
    app.get('/icon.svg', (_q, res) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(icon));
    app.get('/tv', (_q, res) => {
      const f = path.join(o.dist, 'tv.html');
      if (fs.existsSync(f)) res.set('Cache-Control', 'no-store').sendFile(f); else res.status(404).send('TV page is not built');
    });
  }

  // The gate. Place it after the public routes (including the TV pairing ones, which authenticate themselves).
  const gate = (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) return next();
    const role = readToken(cookieOf(req));
    const p = req.path;
    if (!role) {
      if (STATIC_FILE.test(p) && !p.startsWith('/api/')) return next();     // the app's own files: no data in them
      if (p.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
      return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    req.role = role;
    if (role === 'viewer' && p.startsWith('/api/')) {
      const ok = req.method === 'GET' || req.method === 'HEAD' ? VIEWER_GET.test(p) : req.method === 'POST' ? VIEWER_POST.test(p) : false;
      if (!ok) return res.status(403).json({ error: 'Not allowed with this code' });
    }
    next();
  };

  return { enabled, attach, gate, issue, readToken, cookieOf, ipOf, locked, fail, whoami: (req: Request) => ({ role: req.role ?? 'admin', access: enabled }) };
}
