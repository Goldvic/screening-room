// Cinema Recorder (main process).
// The studio window (studio.html) does the capturing and encoding. This file gives it what only the main process can:
// the list of screens and windows, the region picker, the file on disk, global shortcuts, and the final MP4 conversion.
const { BrowserWindow, desktopCapturer, screen, session, ipcMain, globalShortcut, dialog, shell, Notification, app, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const HOTKEY_OPEN = 'Control+Alt+R';   // open the recorder, or stop when it is recording
const HOTKEY_PAUSE = 'Control+Alt+P';  // pause or resume

let ctx = { getMain: () => null, icon: undefined, onState: () => {}, onStandby: () => {} };
let studio = null, studioReady = null, regionWin = null, regionDone = null;
let saved = null, wasVisible = true;                                   // studio bounds before it shrinks into the small bar
let blocker = -1;
let out = null;                                     // the file being written { file, stream }
let st = { state: 'idle', ms: 0 };                  // idle | countdown | recording | paused | saving
const PARTITION = 'persist:cinema-recorder';
let pendingSource = { id: '', audio: false };

// ---------- settings ----------
const cfgFile = () => path.join(app.getPath('userData'), 'recorder.json');
const defaultDir = () => path.join(app.getPath('videos'), 'Cinema', 'Recordings');
let cfg = { quality: '1080', fps: 30, sys: true, mic: false, micId: '', cursor: true, countdown: 3, dir: '', standby: false, mode: 'cinema' };
const loadCfg = () => { try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { /* first run */ } };
const saveCfg = () => { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg)); } catch { /* ignore */ } };
const dirNow = () => cfg.dir || defaultDir();

const isBusy = () => ['countdown', 'recording', 'paused', 'saving'].includes(st.state);
const isRecording = () => ['recording', 'paused', 'countdown'].includes(st.state);

// ---------- ffmpeg ----------
function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (!p) return '';
    const sep = path.sep;
    return p.replace('app.asar' + sep, 'app.asar.unpacked' + sep);
  } catch { return process.env.CINEMA_FFMPEG || ''; }
}
const runFfmpeg = (ff, args, onTime) => new Promise((done) => {
  let err = '';
  const p = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  p.stderr.on('data', (d) => {
    const s = String(d); err = (err + s).slice(-4000);
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
    if (m && onTime) onTime(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  });
  p.on('error', () => done({ ok: false, err: 'Could not start ffmpeg' }));
  p.on('exit', (c) => done({ ok: c === 0, err }));
});

// ---------- studio window ----------
function ensureStudio() {
  if (studio && !studio.isDestroyed()) return studio;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'display-capture', 'fullscreen'].includes(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => ['media', 'display-capture'].includes(perm));
  // The studio asks for "the screen"; this answers with exactly the screen or window the person chose, and the computer's sound.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const all = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const src = all.find((s) => s.id === pendingSource.id);
      if (!src) return cb({});
      cb(pendingSource.audio ? { video: src, audio: 'loopback' } : { video: src });
    } catch { try { cb({}); } catch { /* already answered */ } }
  }, { useSystemPicker: false });

  studio = new BrowserWindow({
    width: 580, height: 760, minWidth: 580, minHeight: 760, frame: false, transparent: true, resizable: false, show: false, hasShadow: true,
    backgroundColor: '#00000000', title: 'Cinema Recorder', icon: ctx.icon, skipTaskbar: false, fullscreenable: false, maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'recorder-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false, partition: PARTITION },
  });
  studio.setContentProtection(true);                // the recorder itself never appears in a recording (Windows 10 2004 and newer)
  studio.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  studio.webContents.on('will-navigate', (e) => e.preventDefault());
  studioReady = new Promise((ok) => studio.webContents.once('did-finish-load', ok));
  studio.loadFile(path.join(__dirname, 'studio.html'));
  studio.on('close', (e) => { if (isBusy()) { e.preventDefault(); studio.minimize(); } });
  studio.on('closed', () => { studio = null; });
  return studio;
}
const send = (ch, ...a) => { if (studio && !studio.isDestroyed()) studio.webContents.send(ch, ...a); };

async function openStudio() {
  ensureStudio();
  await studioReady;
  if (isBusy()) { send('rec:cmd', { cmd: 'focus' }); studio.showInactive(); return; }
  if (studio.isMinimized()) studio.restore();
  studio.center();
  studio.show(); studio.focus();
  send('rec:cmd', { cmd: 'opened' });
}

function setCompact(on) {
  if (!studio || studio.isDestroyed()) return;
  if (on) {
    if (!saved) { saved = studio.getBounds(); wasVisible = studio.isVisible(); }
    const main = ctx.getMain();
    const d = screen.getDisplayMatching(main && !main.isDestroyed() ? main.getBounds() : studio.getBounds());
    const w = 372, h = 72;
    studio.setResizable(true); studio.setMinimumSize(w, h);
    studio.setBounds({ width: w, height: h, x: Math.round(d.workArea.x + (d.workArea.width - w) / 2), y: d.workArea.y + 14 });
    studio.setResizable(false);
    studio.setAlwaysOnTop(true, 'screen-saver');
    studio.setSkipTaskbar(true);
    studio.showInactive();
  } else {
    studio.setAlwaysOnTop(false);
    studio.setSkipTaskbar(false);
    studio.setResizable(true); studio.setMinimumSize(580, 760);
    if (saved) studio.setBounds(saved);
    studio.setResizable(false);
    saved = null;
    if (!wasVisible) studio.hide(); // it was started from the player: stay out of the way afterwards
  }
}

// ---------- screens and windows ----------
async function listSources() {
  const main = ctx.getMain();
  const mainId = main && !main.isDestroyed() ? main.getMediaSourceId() : '';
  const selfId = studio && !studio.isDestroyed() ? studio.getMediaSourceId() : '';
  const all = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 210 }, fetchWindowIcons: true });
  const jpg = (img) => (img && !img.isEmpty() ? 'data:image/jpeg;base64,' + img.toJPEG(72).toString('base64') : '');
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay().id;
  const screens = all.filter((s) => s.id.startsWith('screen:')).map((s, i) => {
    const d = displays.find((x) => String(x.id) === String(s.display_id)) || displays[i] || displays[0];
    return {
      id: s.id, displayId: d.id, name: `Screen ${i + 1}${d.id === primary ? ' (main)' : ''}`, thumb: jpg(s.thumbnail),
      px: { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) }, dip: { w: d.bounds.width, h: d.bounds.height },
    };
  });
  const windows = all.filter((s) => s.id.startsWith('window:') && s.id !== selfId && s.name.trim() && !/^(Program Manager|Windows Input Experience|Settings)$/i.test(s.name) && s.id !== mainId)
    .map((s) => ({ id: s.id, name: s.name, thumb: jpg(s.thumbnail), icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '' }));
  return { screens, windows };
}

function cinemaInfo() {
  const main = ctx.getMain();
  if (!main || main.isDestroyed()) return { open: false };
  const [w, h] = main.getContentSize();
  const sf = screen.getDisplayMatching(main.getBounds()).scaleFactor;
  return { open: true, id: main.getMediaSourceId(), w: Math.round(w * sf), h: Math.round(h * sf), minimized: main.isMinimized() };
}

// ---------- region picker ----------
function pickRegion(displayId, aspect) {
  return new Promise((resolve) => {
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
    if (regionWin && !regionWin.isDestroyed()) regionWin.destroy();
    regionDone = (r) => { regionDone = null; try { if (regionWin && !regionWin.isDestroyed()) regionWin.destroy(); } catch { /* gone */ } regionWin = null; if (studio && !studio.isDestroyed()) { studio.show(); studio.focus(); } resolve(r ? { ...r, display: { id: d.id, w: d.bounds.width, h: d.bounds.height } } : null); };
    if (studio && !studio.isDestroyed()) studio.hide();
    regionWin = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, movable: false, fullscreenable: false, hasShadow: false, show: false, enableLargerThanScreen: true, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'recorder-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    regionWin.setAlwaysOnTop(true, 'screen-saver');
    regionWin.once('ready-to-show', () => { regionWin.setBounds(d.bounds); regionWin.show(); regionWin.focus(); });
    regionWin.on('closed', () => { if (regionDone) regionDone(null); });
    regionWin.loadFile(path.join(__dirname, 'region.html'), { query: { aspect: aspect || 'free' } });
  });
}

// ---------- writing the file and finishing it ----------
async function finish(meta) {
  const raw = out.file;
  const ff = ffmpegPath();
  const mp4 = raw.replace(/\.webm$/i, '.mp4');
  if (!ff) return { ok: true, file: raw, note: 'Saved as WebM (the converter is not available).' };
  const prog = (t) => send('rec:finalize', { pct: meta.durationMs ? Math.min(99, Math.round((t * 1000 / meta.durationMs) * 100)) : 0 });
  const common = ['-y', '-hide_banner', '-loglevel', 'error', '-i', raw];
  const tail = ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', mp4];
  let r = { ok: false };
  if (meta.h264) r = await runFfmpeg(ff, [...common, '-c:v', 'copy', ...tail], prog);        // video already H.264: just wrap it, very fast
  if (!r.ok) r = await runFfmpeg(ff, [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(meta.fps || 30), ...tail], prog);
  if (r.ok && fs.existsSync(mp4) && fs.statSync(mp4).size > 1024) { try { fs.unlinkSync(raw); } catch { /* keep both */ } return { ok: true, file: mp4 }; }
  try { fs.unlinkSync(mp4); } catch { /* none */ }
  return { ok: true, file: raw, note: 'Saved as WebM (MP4 conversion failed).' };
}

const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; };

function notify(title, body, file) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ctx.icon });
  if (file) n.on('click', () => shell.showItemInFolder(file));
  n.show();
}

// ---------- state shared with the rest of the app ----------
function setState(s) {
  st = { ...st, ...s };
  if (isRecording() && blocker < 0) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!isRecording() && blocker >= 0) { powerSaveBlocker.stop(blocker); blocker = -1; }
  try { ctx.onState({ ...st, standby: cfg.standby }); } catch { /* window gone */ }
}

// ---------- start / stop from outside the studio ----------
async function startCinema(o = {}) {
  const main = ctx.getMain();
  if (!main || main.isDestroyed()) return { ok: false, error: 'Open Cinema first.' };
  if (isBusy()) return { ok: false, error: 'A recording is already running.' };
  if (main.isMinimized()) main.restore();
  ensureStudio();
  await studioReady;
  send('rec:cmd', { cmd: 'start', mode: 'cinema', sourceId: main.getMediaSourceId(), quality: o.quality || cfg.quality, countdown: typeof o.countdown === 'number' ? o.countdown : 0, sys: o.sys !== false });
  return { ok: true };
}
const stop = () => { if (isRecording()) send('rec:cmd', { cmd: 'stop' }); };
const pause = () => { if (st.state === 'recording' || st.state === 'paused') send('rec:cmd', { cmd: 'toggle-pause' }); };

function hotOpen() { if (isRecording()) stop(); else if (studio && !studio.isDestroyed() && studio.isVisible() && !isBusy()) studio.hide(); else openStudio(); }

function registerHotkeys() {
  for (const [k, fn] of [[HOTKEY_OPEN, hotOpen], [HOTKEY_PAUSE, pause]]) { try { globalShortcut.register(k, fn); } catch { /* another app owns this key */ } }
}

// ---------- the bridge the studio talks to ----------
function wire() {
  const h = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { if (!studio || studio.isDestroyed() || (e.sender !== studio.webContents && e.sender !== regionWin?.webContents)) return null; return fn(...a); });
  h('rec:cfg-get', () => ({ ...cfg, dir: dirNow(), hotkeys: { open: HOTKEY_OPEN.replace('Control', 'Ctrl'), pause: HOTKEY_PAUSE.replace('Control', 'Ctrl') } }));
  h('rec:cfg-set', (p) => {
    const keys = ['quality', 'fps', 'sys', 'mic', 'micId', 'cursor', 'countdown', 'standby', 'mode'];
    for (const k of keys) if (p && k in p) cfg[k] = p[k];
    saveCfg();
    if (p && 'standby' in p) ctx.onStandby(!!cfg.standby);
    return true;
  });
  h('rec:sources', () => listSources());
  h('rec:cinema-info', () => cinemaInfo());
  h('rec:region-pick', (displayId, aspect) => pickRegion(displayId, aspect));
  h('rec:prepare', (o) => { pendingSource = { id: String(o?.sourceId || ''), audio: !!o?.audio }; return true; });
  h('rec:compact', (on) => { setCompact(!!on); return true; });
  h('rec:hide', () => { if (studio && !isBusy()) studio.hide(); });
  h('rec:minimize', () => { if (studio) studio.minimize(); });
  h('rec:choose-dir', async () => {
    const r = await dialog.showOpenDialog(studio, { properties: ['openDirectory', 'createDirectory'], defaultPath: dirNow() });
    if (r.canceled || !r.filePaths[0]) return null;
    cfg.dir = r.filePaths[0]; saveCfg(); return cfg.dir;
  });
  h('rec:open-folder', () => { try { fs.mkdirSync(dirNow(), { recursive: true }); } catch { /* ignore */ } return shell.openPath(dirNow()); });
  h('rec:reveal', (f) => { if (typeof f === 'string' && f) shell.showItemInFolder(f); });
  h('rec:open-file', (f) => { if (typeof f === 'string' && f) return shell.openPath(f); });
  h('rec:file-open', () => {
    try {
      fs.mkdirSync(dirNow(), { recursive: true });
      const file = path.join(dirNow(), `Cinema Recording ${stamp()}.webm`);
      out = { file, stream: fs.createWriteStream(file) };
      return { ok: true, file };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  h('rec:file-close', async (meta) => {
    if (!out) return { ok: false, error: 'No file' };
    await new Promise((ok) => out.stream.end(ok));
    setState({ state: 'saving' });
    const r = await finish(meta || {}).catch((e) => ({ ok: false, error: String((e && e.message) || e), file: out.file }));
    out = null;
    setState({ state: 'idle', ms: 0 });
    if (r.ok) notify('Recording saved', `${path.basename(r.file)}${r.note ? ' · ' + r.note : ''}`, r.file);
    return r;
  });
  ipcMain.on('rec:chunk', (e, buf) => { if (studio && e.sender === studio.webContents && out) out.stream.write(Buffer.from(buf)); });
  ipcMain.on('rec:state', (e, s) => { if (studio && e.sender === studio.webContents && s && typeof s.state === 'string') setState({ state: s.state, ms: Number(s.ms) || 0 }); });
  ipcMain.on('rec:region-done', (e, r) => {
    if (!regionWin || e.sender !== regionWin.webContents || !regionDone) return;
    const ok = r && r.w >= 32 && r.h >= 32;
    regionDone(ok ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null);
  });
}

function init(c) {
  ctx = { ...ctx, ...c };
  loadCfg();
  wire();
  registerHotkeys();
}

module.exports = {
  init, openStudio, startCinema, stop, pause,
  state: () => ({ ...st, standby: cfg.standby }),
  isRecording, isBusy, isStandby: () => !!cfg.standby,
  destroy: () => { try { if (studio && !studio.isDestroyed()) studio.destroy(); } catch { /* ignore */ } },
};
