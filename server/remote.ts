import http from 'node:http';
import os from 'node:os';

export type RemoteState = { title: string; pos: number; dur: number; playing: boolean; vol: number; hasNext: boolean; stream?: string; at: number };
export type RemoteCmd = { cmd: string; value?: number };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Cinema remote</title><style>
:root{color-scheme:dark}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font:16px system-ui,sans-serif;background:#0d0d10;color:#eee;display:grid;gap:18px;padding:22px;max-width:520px;margin:auto}
h1{font-size:15px;color:#8b7bff;letter-spacing:.14em;text-transform:uppercase;margin:6px 0 0}
#t{font-size:20px;font-weight:700;line-height:1.25;min-height:50px}#s{color:#8a92a3;font-size:13px}
input[type=range]{width:100%;accent-color:#8b7bff;height:34px}
.row{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px}
button{padding:18px 6px;border:0;border-radius:16px;background:#1a1a21;color:#eee;font-size:17px;font-weight:600}
button:active{background:#2b2b36}button.main{background:#8b7bff;color:#111}
a{color:#2dd4bf}#off{display:none;color:#f0624f}
</style></head><body><h1>Cinema remote</h1><div id="t">Nothing playing</div><div id="s"></div><div id="off">Cannot reach the laptop.</div>
<input id="seek" type="range" min="0" max="1000" value="0">
<div class="row"><button data-c="prev">&#9198;</button><button data-c="back">-10</button><button data-c="toggle" class="main" id="pp">&#9654;</button><button data-c="fwd">+10</button><button data-c="next">&#9197;</button></div>
<div class="row"><button data-c="vdown">Vol -</button><button data-c="mute">Mute</button><button data-c="vup">Vol +</button></div>
<div class="row"><button data-c="fs">Full screen</button><button data-c="stop">Close video</button></div>
<a id="w" href="#">Watch on this device</a>
<script>
const q=new URLSearchParams(location.search);let pin=q.get('pin')||localStorage.pin||'';
if(!pin){pin=prompt('PIN shown in Cinema settings')||'';}localStorage.pin=pin;
const $=s=>document.querySelector(s);let dragging=false,st=null;
const fmt=x=>{x=Math.max(0,Math.floor(x));const h=Math.floor(x/3600),m=Math.floor(x%3600/60),s=x%60;return (h?h+':'+String(m).padStart(2,'0'):m)+':'+String(s).padStart(2,'0')};
async function send(cmd,value){try{await fetch('/cmd?pin='+encodeURIComponent(pin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cmd,value})})}catch{}}
document.querySelectorAll('button[data-c]').forEach(b=>b.onclick=()=>send(b.dataset.c));
$('#seek').oninput=()=>{dragging=true};$('#seek').onchange=()=>{dragging=false;if(st&&st.dur)send('seek',$('#seek').value/1000*st.dur)};
async function poll(){try{const r=await fetch('/state?pin='+encodeURIComponent(pin));if(r.status===401){localStorage.pin='';pin=prompt('Wrong PIN. Try again')||'';localStorage.pin=pin;return}
st=await r.json();$('#off').style.display='none';
if(!st||!st.title){$('#t').textContent='Nothing playing';$('#s').textContent='Start a video on the laptop.';return}
$('#t').textContent=st.title;$('#s').textContent=fmt(st.pos)+' / '+fmt(st.dur);$('#pp').innerHTML=st.playing?'&#10074;&#10074;':'&#9654;';
if(!dragging&&st.dur)$('#seek').value=st.pos/st.dur*1000;
$('#w').href='/watch?pin='+encodeURIComponent(pin);$('#w').style.display=st.stream?'inline':'none'}catch{$('#off').style.display='block'}}
setInterval(poll,1000);poll();
</script></body></html>`;

const WATCH = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#000">
<video id="v" controls autoplay playsinline style="width:100vw;height:100vh;background:#000"></video>
<script>const pin=new URLSearchParams(location.search).get('pin')||localStorage.pin||'';document.getElementById('v').src='/stream?pin='+encodeURIComponent(pin);</script></body>`;

/** A small page on your home network so a phone or TV browser can control playback, or watch the current video. */
export class Remote {
  state: RemoteState | null = null;
  cmds: RemoteCmd[] = [];
  port = 0;
  private srv: http.Server | null = null;
  private pin = '';
  private fails = new Map<string, { n: number; t: number }>();
  constructor(private mainPort: () => number, private token: string) {}
  get on() { return !!this.srv; }

  urls() {
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${this.port}`);
    return out;
  }

  stop() { this.srv?.close(); this.srv = null; this.state = null; this.cmds = []; }

  start(port: number, pin: string): Promise<void> {
    this.stop();
    this.pin = pin; this.port = port;
    return new Promise((ok, no) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.on('error', (e) => { this.srv = null; no(e); });
      srv.listen(port, '0.0.0.0', () => { this.srv = srv; ok(); });
    });
  }

  private authed(req: http.IncomingMessage, url: URL, res: http.ServerResponse) {
    const ip = req.socket.remoteAddress ?? '?';
    const f = this.fails.get(ip);
    if (f && f.n >= 8 && Date.now() - f.t < 60_000) { res.writeHead(429).end('Too many tries'); return false; }
    if (url.searchParams.get('pin') === this.pin) { this.fails.delete(ip); return true; }
    this.fails.set(ip, { n: (f && Date.now() - f.t < 60_000 ? f.n : 0) + 1, t: Date.now() });
    res.writeHead(401).end('PIN needed');
    return false;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(PAGE); return; }
    if (!this.authed(req, url, res)) return;
    if (url.pathname === '/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(this.state && Date.now() - this.state.at < 6000 ? this.state : null)); return; }
    if (url.pathname === '/cmd' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => { b += d; if (b.length > 2000) req.destroy(); });
      req.on('end', () => { try { const c = JSON.parse(b); if (typeof c.cmd === 'string' && this.cmds.length < 30) this.cmds.push({ cmd: c.cmd.slice(0, 20), value: Number(c.value) || undefined }); } catch { /* ignore */ } res.writeHead(204).end(); });
      return;
    }
    if (url.pathname === '/watch') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(WATCH); return; }
    if (url.pathname === '/stream' && this.state?.stream) {
      const headers: Record<string, string> = {};
      if (req.headers.range) headers.range = String(req.headers.range);
      const up = http.request({ host: '127.0.0.1', port: this.mainPort(), method: 'GET', path: `${this.state.stream}&tk=${encodeURIComponent(this.token)}`, headers }, (r) => {
        res.writeHead(r.statusCode ?? 200, r.headers); r.pipe(res);
      });
      up.on('error', () => res.destroy());
      res.on('close', () => up.destroy());
      up.end();
      return;
    }
    res.writeHead(404).end('Not found');
  }
}