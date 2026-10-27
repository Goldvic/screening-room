import dgram from 'node:dgram';
import http from 'node:http';

import os from 'node:os';
import tls from 'node:tls';

/** Casting to a TV: Chromecast (CastV2) and DLNA / UPnP renderers (most smart TVs). No outside libraries. */
export type CastDevice = { id: string; name: string; kind: 'cast' | 'dlna'; host: string; port: number; control?: string; render?: string };
export type CastStatus = { state: 'idle' | 'loading' | 'playing' | 'paused' | 'error'; pos: number; dur: number; device: string; error?: string };

const ifaces = () => Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).filter((a) => a.family === 'IPv4' && !a.internal));

/** Our address on the same network as the device (the TV has to be able to reach it). */
export function lanIpFor(host: string): string {
  const ip = host.split('.').map(Number);
  for (const a of ifaces()) {
    const m = a.netmask.split('.').map(Number), me = a.address.split('.').map(Number);
    if (ip.length === 4 && ip.every((x, i) => (x & m[i]) === (me[i] & m[i]))) return a.address;
  }
  return ifaces()[0]?.address ?? '127.0.0.1';
}

/* =============================== DNS (for Chromecast discovery) =============================== */
export function dnsQuery(name: string): Buffer {
  const parts = name.split('.').flatMap((l) => [Buffer.from([l.length]), Buffer.from(l)]);
  const head = Buffer.alloc(12); head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4); tail.writeUInt16BE(12, 0); tail.writeUInt16BE(0x8001, 2); // PTR, unicast response wanted
  return Buffer.concat([head, ...parts, Buffer.from([0]), tail]);
}
function readName(b: Buffer, off: number): { name: string; next: number } {
  const out: string[] = []; let next = -1, guard = 0;
  while (guard++ < 64) {
    const len = b[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) { if (next < 0) next = off + 2; off = ((len & 0x3f) << 8) | b[off + 1]; continue; }
    out.push(b.toString('utf8', off + 1, off + 1 + len)); off += 1 + len;
  }
  return { name: out.join('.'), next: next < 0 ? off : next };
}
export type DnsRR = { name: string; type: number; ptr?: string; srv?: { port: number; target: string }; txt?: Record<string, string>; a?: string };
export function parseDns(b: Buffer): DnsRR[] {
  const out: DnsRR[] = [];
  try {
    const qd = b.readUInt16BE(4), total = b.readUInt16BE(6) + b.readUInt16BE(8) + b.readUInt16BE(10);
    let off = 12;
    for (let i = 0; i < qd; i++) off = readName(b, off).next + 4;
    for (let i = 0; i < total; i++) {
      const n = readName(b, off); off = n.next;
      const type = b.readUInt16BE(off), len = b.readUInt16BE(off + 8); off += 10;
      const rr: DnsRR = { name: n.name, type };
      if (type === 12) rr.ptr = readName(b, off).name;
      else if (type === 33) rr.srv = { port: b.readUInt16BE(off + 4), target: readName(b, off + 6).name };
      else if (type === 16) { rr.txt = {}; let p = off; while (p < off + len) { const l = b[p]; const kv = b.toString('utf8', p + 1, p + 1 + l); const i2 = kv.indexOf('='); if (i2 > 0) rr.txt[kv.slice(0, i2)] = kv.slice(i2 + 1); p += 1 + l; } }
      else if (type === 1) rr.a = [...b.subarray(off, off + 4)].join('.');
      out.push(rr); off += len;
    }
  } catch { /* partial packet */ }
  return out;
}

function discoverCast(ms: number): Promise<CastDevice[]> {
  return new Promise((done) => {
    const found = new Map<string, CastDevice>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const all: DnsRR[] = [];
    const from = new Map<string, string>();
    sock.on('message', (m, r) => { for (const rr of parseDns(m)) { all.push(rr); if (rr.ptr) from.set(rr.ptr, r.address); } });
    sock.on('error', () => {});
    sock.bind(0, () => {
      const q = dnsQuery('_googlecast._tcp.local');
      for (const a of ifaces()) { try { sock.setMulticastInterface(a.address); sock.send(q, 5353, '224.0.0.251'); } catch { /* interface down */ } }
    });
    setTimeout(() => {
      try { sock.close(); } catch { /* closed */ }
      for (const rr of all.filter((x) => x.ptr?.includes('._googlecast.'))) {
        const inst = rr.ptr!;
        const srv = all.find((x) => x.srv && x.name === inst);
        const txt = all.find((x) => x.txt && x.name === inst)?.txt ?? {};
        const ip = all.find((x) => x.a && srv && x.name === srv.srv!.target)?.a ?? from.get(inst);
        if (!ip) continue;
        const id = txt.id ?? inst;
        found.set(id, { id, name: txt.fn ?? inst.split('._googlecast.')[0], kind: 'cast', host: ip, port: srv?.srv?.port ?? 8009 });
      }
      done([...found.values()]);
    }, ms);
  });
}

/* =============================== DLNA discovery + control =============================== */
const httpGet = (url: string, ms = 2500) => new Promise<string>((ok, no) => {
  const r = http.get(url, { timeout: ms }, (res) => { let d = ''; res.on('data', (c) => { d += c; if (d.length > 400_000) r.destroy(); }); res.on('end', () => ok(d)); });
  r.on('error', no); r.on('timeout', () => { r.destroy(); no(new Error('timeout')); });
});
const tag = (xml: string, t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1]?.trim() ?? '';

export function parseDlnaDescription(xml: string, location: string): Omit<CastDevice, 'id'> | null {
  const u = new URL(location);
  const abs = (p: string) => (/^https?:/.test(p) ? p : `${u.protocol}//${u.host}${p.startsWith('/') ? '' : '/'}${p}`);
  let control = '', render = '';
  for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/g)) {
    const t = tag(m[1], 'serviceType'), c = tag(m[1], 'controlURL');
    if (t.includes('AVTransport')) control = abs(c); else if (t.includes('RenderingControl')) render = abs(c);
  }
  if (!control) return null;
  return { name: tag(xml, 'friendlyName') || u.hostname, kind: 'dlna', host: u.hostname, port: Number(u.port) || 80, control, render };
}

function discoverDlna(ms: number): Promise<CastDevice[]> {
  return new Promise((done) => {
    const locs = new Set<string>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (m) => { const l = /^location:\s*(\S+)/im.exec(m.toString()); if (l) locs.add(l[1]); });
    sock.on('error', () => {});
    sock.bind(0, () => {
      const msg = Buffer.from(['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2', 'ST: urn:schemas-upnp-org:service:AVTransport:1', '', ''].join('\r\n'));
      for (const a of ifaces()) { try { sock.setMulticastInterface(a.address); sock.send(msg, 1900, '239.255.255.250'); } catch { /* interface down */ } }
    });
    setTimeout(async () => {
      try { sock.close(); } catch { /* closed */ }
      const out: CastDevice[] = [];
      await Promise.all([...locs].map(async (l) => { try { const d = parseDlnaDescription(await httpGet(l), l); if (d) out.push({ ...d, id: `dlna:${d.host}:${d.control}` }); } catch { /* not a renderer */ } }));
      done(out);
    }, ms);
  });
}

export async function discover(ms = 2500): Promise<CastDevice[]> {
  const [a, b] = await Promise.all([discoverCast(ms), discoverDlna(ms)]);
  return [...a, ...b];
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
function soap(url: string, service: string, action: string, args: Record<string, string | number>): Promise<string> {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${Object.entries(args).map(([k, v]) => `<${k}>${typeof v === 'string' ? esc(v) : v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  return new Promise((ok, no) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', timeout: 6000,
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"urn:schemas-upnp-org:service:${service}:1#${action}"`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => (res.statusCode && res.statusCode < 300 ? ok(d) : no(new Error(`The TV answered ${res.statusCode}`)))); });
    r.on('error', no); r.on('timeout', () => { r.destroy(); no(new Error('The TV did not answer')); });
    r.end(body);
  });
}
const hms = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const unhms = (t: string) => { const p = t.split(':').map(Number); return p.length === 3 && p.every((x) => !isNaN(x)) ? p[0] * 3600 + p[1] * 60 + p[2] : 0; };

/* =============================== Chromecast (CastV2) =============================== */
const vi = (n: number) => { const o: number[] = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const field = (n: number, t: number, v: Buffer) => Buffer.concat([vi((n << 3) | t), v]);
const str = (n: number, s: string) => { const b = Buffer.from(s); return field(n, 2, Buffer.concat([vi(b.length), b])); };
export function encodeCast(src: string, dst: string, ns: string, payload: string): Buffer {
  const m = Buffer.concat([field(1, 0, vi(0)), str(2, src), str(3, dst), str(4, ns), field(5, 0, vi(0)), str(6, payload)]);
  const len = Buffer.alloc(4); len.writeUInt32BE(m.length);
  return Buffer.concat([len, m]);
}
export function decodeCast(b: Buffer): { src: string; dst: string; ns: string; payload: string } {
  const o = { src: '', dst: '', ns: '', payload: '' };
  let p = 0;
  const rv = () => { let r = 0, s = 1; for (;;) { const x = b[p++]; r += (x & 127) * s; if (x < 128) break; s *= 128; } return r; };
  while (p < b.length) {
    const k = rv(), f = k >> 3, t = k & 7;
    if (t === 0) rv();
    else if (t === 2) { const l = rv(); const v = b.toString('utf8', p, p + l); p += l; if (f === 2) o.src = v; else if (f === 3) o.dst = v; else if (f === 4) o.ns = v; else if (f === 6) o.payload = v; }
    else break;
  }
  return o;
}

const NS = { conn: 'urn:x-cast:com.google.cast.tp.connection', hb: 'urn:x-cast:com.google.cast.tp.heartbeat', rec: 'urn:x-cast:com.google.cast.receiver', media: 'urn:x-cast:com.google.cast.media' };

class CastSession {
  sock?: tls.TLSSocket; buf = Buffer.alloc(0); req = 1; hb?: NodeJS.Timeout; poll?: NodeJS.Timeout;
  transport = ''; mediaId = 0; state: CastStatus['state'] = 'loading'; pos = 0; dur = 0; error = ''; waiters = new Map<number, (m: any) => void>();
  constructor(public dev: CastDevice) {}
  send(dst: string, ns: string, o: object) { this.sock?.write(encodeCast('sender-0', dst, ns, JSON.stringify(o))); }
  ask(dst: string, ns: string, o: object, ms = 8000): Promise<any> {
    const id = this.req++;
    return new Promise((ok, no) => { const t = setTimeout(() => { this.waiters.delete(id); no(new Error('The TV did not answer')); }, ms); this.waiters.set(id, (m) => { clearTimeout(t); ok(m); }); this.send(dst, ns, { ...o, requestId: id }); });
  }
  connect(): Promise<void> {
    return new Promise((ok, no) => {
      const s = tls.connect({ host: this.dev.host, port: this.dev.port, rejectUnauthorized: false }, () => {
        this.send('receiver-0', NS.conn, { type: 'CONNECT' });
        this.hb = setInterval(() => this.send('receiver-0', NS.hb, { type: 'PING' }), 5000);
        ok();
      });
      s.on('data', (d) => this.onData(d));
      s.on('error', (e) => { this.error = e.message; this.state = 'error'; no(e); });
      s.on('close', () => { if (this.state !== 'error') this.state = 'idle'; this.stop(); });
      this.sock = s;
    });
  }
  onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + n) break;
      const m = decodeCast(this.buf.subarray(4, 4 + n)); this.buf = this.buf.subarray(4 + n);
      let j: any; try { j = JSON.parse(m.payload); } catch { continue; }
      if (j.requestId && this.waiters.has(j.requestId)) { this.waiters.get(j.requestId)!(j); this.waiters.delete(j.requestId); }
      if (j.type === 'PING') this.send(m.src, NS.hb, { type: 'PONG' });
      if (j.type === 'MEDIA_STATUS' && j.status?.[0]) {
        const s = j.status[0];
        this.mediaId = s.mediaSessionId ?? this.mediaId; this.pos = s.currentTime ?? this.pos; if (s.media?.duration) this.dur = s.media.duration;
        const ps = s.playerState;
        this.state = ps === 'PLAYING' ? 'playing' : ps === 'PAUSED' ? 'paused' : ps === 'IDLE' ? (s.idleReason === 'ERROR' ? 'error' : 'idle') : 'loading';
        if (s.idleReason === 'ERROR') this.error = 'The TV could not play this file. Try an MP4 with H.264 video.';
      }
    }
  }
  async load(url: string, type: string, title: string, start: number) {
    await this.connect();
    const st = await this.ask('receiver-0', NS.rec, { type: 'LAUNCH', appId: 'CC1AD845' }, 15000);
    const app = st.status?.applications?.find((a: any) => a.appId === 'CC1AD845') ?? st.status?.applications?.[0];
    if (!app?.transportId) throw new Error('The TV did not start its media player');
    this.transport = app.transportId;
    this.send(this.transport, NS.conn, { type: 'CONNECT' });
    this.send(this.transport, NS.media, { type: 'LOAD', requestId: this.req++, autoplay: true, currentTime: start, media: { contentId: url, contentType: type, streamType: 'BUFFERED', metadata: { metadataType: 0, title } } });
    this.poll = setInterval(() => { if (this.transport) this.send(this.transport, NS.media, { type: 'GET_STATUS', requestId: this.req++ }); }, 2000);
  }
  control(a: string, v?: number) {
    if (a === 'volume') return this.send('receiver-0', NS.rec, { type: 'SET_VOLUME', requestId: this.req++, volume: { level: Math.max(0, Math.min(1, (v ?? 50) / 100)) } });
    const base = { mediaSessionId: this.mediaId, requestId: this.req++ };
    if (a === 'play') this.send(this.transport, NS.media, { type: 'PLAY', ...base });
    else if (a === 'pause') this.send(this.transport, NS.media, { type: 'PAUSE', ...base });
    else if (a === 'seek') this.send(this.transport, NS.media, { type: 'SEEK', currentTime: v ?? 0, ...base });
  }
  stop() { clearInterval(this.hb); clearInterval(this.poll); try { this.sock?.destroy(); } catch { /* closed */ } }
  async end() { try { if (this.transport) this.send(this.transport, NS.media, { type: 'STOP', mediaSessionId: this.mediaId, requestId: this.req++ }); this.send('receiver-0', NS.rec, { type: 'STOP', requestId: this.req++, sessionId: this.transport }); } catch { /* gone */ } setTimeout(() => this.stop(), 400); }
}

/* =============================== one active cast =============================== */
let cast: CastSession | null = null;
let dlna: { dev: CastDevice; state: CastStatus['state']; pos: number; dur: number; error: string; timer?: NodeJS.Timeout } | null = null;

export async function castPlay(dev: CastDevice, url: string, title: string, start: number, mime: string): Promise<void> {
  await castStop();
  if (dev.kind === 'cast') {
    const s = new CastSession(dev); cast = s;
    await s.load(url, mime, title, start);
    return;
  }
  const meta = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="0" restricted="1"><dc:title>${esc(title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:${mime}:*">${esc(url)}</res></item></DIDL-Lite>`;
  const d: NonNullable<typeof dlna> = { dev, state: 'loading', pos: 0, dur: 0, error: '' }; dlna = d;
  await soap(dev.control!, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: meta });
  await soap(dev.control!, 'AVTransport', 'Play', { InstanceID: 0, Speed: '1' });
  d.state = 'playing';
  if (start > 5) setTimeout(() => soap(dev.control!, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(start) }).catch(() => {}), 2000);
  const d2 = d;
  d2.timer = setInterval(async () => {
    try {
      const pi = await soap(dev.control!, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 });
      d2.pos = unhms(tag(pi, 'RelTime')); d2.dur = unhms(tag(pi, 'TrackDuration'));
      const ti = await soap(dev.control!, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 });
      const st = tag(ti, 'CurrentTransportState');
      d2.state = st === 'PLAYING' ? 'playing' : st === 'PAUSED_PLAYBACK' ? 'paused' : st === 'STOPPED' || st === 'NO_MEDIA_PRESENT' ? 'idle' : 'loading';
    } catch { /* keep the last state */ }
  }, 2000);
}

export async function castControl(action: string, value?: number): Promise<void> {
  if (cast) { cast.control(action, value); return; }
  if (!dlna) throw new Error('Nothing is being cast');
  const c = dlna.dev.control!;
  if (action === 'play') await soap(c, 'AVTransport', 'Play', { InstanceID: 0, Speed: '1' });
  else if (action === 'pause') await soap(c, 'AVTransport', 'Pause', { InstanceID: 0 });
  else if (action === 'seek') await soap(c, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(value ?? 0) });
  else if (action === 'volume' && dlna.dev.render) await soap(dlna.dev.render, 'RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(Math.max(0, Math.min(100, value ?? 50))) });
}

export function castStatus(): CastStatus | null {
  if (cast) return { state: cast.state, pos: cast.pos, dur: cast.dur, device: cast.dev.name, error: cast.error || undefined };
  if (dlna) return { state: dlna.state, pos: dlna.pos, dur: dlna.dur, device: dlna.dev.name, error: dlna.error || undefined };
  return null;
}

export async function castStop(): Promise<void> {
  if (cast) { await cast.end(); cast = null; }
  if (dlna) { clearInterval(dlna.timer); await soap(dlna.dev.control!, 'AVTransport', 'Stop', { InstanceID: 0 }).catch(() => {}); dlna = null; }
}

export const mimeOf = (name: string) => (/\.(mp4|m4v)$/i.test(name) ? 'video/mp4' : /\.mkv$/i.test(name) ? 'video/x-matroska' : /\.webm$/i.test(name) ? 'video/webm' : /\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4');