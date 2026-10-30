// Cinema desktop shell. It starts the Cinema server inside this process, then shows it in a window.
// Everything the window can ask of the computer goes through the small bridge in preload.cjs.
const { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, powerMonitor, ipcMain, nativeImage, powerSaveBlocker, safeStorage, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

process.env.CINEMA_EMBEDDED = '1'; // the server must not start itself
const DEV_URL = process.env.CINEMA_DEV_URL || '';
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService,PlatformHEVCDecoderSupport');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Windows groups and names notifications by this id. Without it they show up under "electron.app.Cinema".
if (process.platform === 'win32') app.setAppUserModelId('com.cinema.desktop');

let rendererReady = false, pendingOpen = null;
let hadWindow = false;
let win = null, tray = null, server = null, origin = '', port = 0, quitting = false, blocker = -1, miniFrom = null;
const token = crypto.randomBytes(24).toString('hex');

const crypt = {
  encrypt: (s) => (safeStorage.isEncryptionAvailable() ? 'ss:' + safeStorage.encryptString(s).toString('base64') : 'plain:' + Buffer.from(s, 'utf8').toString('base64')),
  decrypt: (s) => (s.startsWith('ss:') ? safeStorage.decryptString(Buffer.from(s.slice(3), 'base64')) : s.startsWith('plain:') ? Buffer.from(s.slice(6), 'base64').toString('utf8') : s),
};

// ---------- open a video from Explorer ("Open with Cinema", double-click, drag onto the icon) ----------
const OPEN_EXT = /\.(mp4|mkv|webm|mov|avi|m4v)$/i;
const fileFromArgv = (argv, cwd) => {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    const p = path.resolve(cwd || process.cwd(), a);
    if (OPEN_EXT.test(p) && fs.existsSync(p)) return p;
  }
  return null;
};
pendingOpen = fileFromArgv(process.argv);
// The window asks for a pending file when it starts; until then (or while it reloads) the file waits here.
function deliver(file) {
  if (!file) return;
  if (win && !win.isDestroyed() && rendererReady) {
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    win.webContents.send('open-file', file);
  } else pendingOpen = file;
}
app.on('open-file', (e, p) => { e.preventDefault(); deliver(p); }); // macOS

// ---------- updates ----------
const updCfgFile = () => path.join(app.getPath('userData'), 'updater.json');
let updCfg = { feed: '', auto: true };
let upd = { state: 'idle', version: '', percent: 0, error: '' };
let updater = null;
const loadUpdCfg = () => { try { updCfg = { ...updCfg, ...JSON.parse(fs.readFileSync(updCfgFile(), 'utf8')) }; } catch { /* first run */ } };
const updView = () => ({ ...upd, current: app.getVersion(), feed: updCfg.feed, auto: updCfg.auto, packaged: app.isPackaged });
const setUpd = (p) => { upd = { ...upd, ...p }; if (win && !win.isDestroyed()) win.webContents.send('update-status', updView()); };
const friendly = (e) => {
  const m = String((e && e.message) || e || 'Unknown error');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|net::/i.test(m)) return 'Could not reach the update address. Check the address and your internet connection.';
  if (/404|latest.*yml|Cannot find/i.test(m)) return 'The update address does not have a latest.yml file. Check that you uploaded the release files there.';
  return m.split('\n')[0].slice(0, 200);
};
function feedConfig(feed) {
  const m = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(feed) || /^([\w.-]+)\/([\w.-]+)$/.exec(feed.trim());
  if (m) return { provider: 'github', owner: m[1], repo: m[2].replace(/\.git$/, ''), releaseType: 'release' };
  return { provider: 'generic', url: feed };
}
function applyFeed() { if (updater && updCfg.feed) updater.setFeedURL(feedConfig(updCfg.feed)); }
function initUpdater() {
  loadUpdCfg();
  if (!app.isPackaged) return; // updates only exist in the installed app
  try { updater = require('electron-updater').autoUpdater; } catch { return; }
  updater.autoDownload = false;          // the person decides when to download
  updater.autoInstallOnAppQuit = true;   // a downloaded update installs the next time Cinema closes
  updater.logger = null;
  updater.on('checking-for-update', () => setUpd({ state: 'checking', error: '' }));
  updater.on('update-available', (i) => {
    setUpd({ state: 'available', version: i.version, percent: 0 });
    if (updCfg.auto) updater.downloadUpdate().catch(() => {}); // Automatic: fetch it quietly in the background
  });
  updater.on('update-not-available', () => setUpd({ state: 'none' }));
  updater.on('download-progress', (p) => setUpd({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (i) => {
    setUpd({ state: 'ready', version: i.version, percent: 100 });
    if (Notification.isSupported()) new Notification({ title: 'Cinema update ready', body: `Version ${i.version} installs when you close Cinema, or restart now from Settings.` }).show();
  });
  updater.on('error', (e) => setUpd({ state: 'error', error: friendly(e) }));
  applyFeed();
  const auto = () => { if (updCfg.auto && updCfg.feed && ['idle', 'none', 'error'].includes(upd.state)) checkUpdates(); };
  setTimeout(auto, 8000).unref();
  setInterval(auto, 6 * 3600 * 1000).unref();
}
async function checkUpdates() {
  if (!app.isPackaged || !updater) return setUpd({ state: 'error', error: 'Updates only work in the installed app.' });
  if (!updCfg.feed) return setUpd({ state: 'error', error: 'Enter the update address first.' });
  try {
    const r = await updater.checkForUpdates();
    // null = the updater switched itself off (for example a Linux build that is not an AppImage)
    if (!r) setUpd({ state: 'error', error: 'Updates are not available for this kind of installation. Use the Windows installer version.' });
  } catch (e) { setUpd({ state: 'error', error: friendly(e) }); }
}

const stateFile = () => path.join(app.getPath('userData'), 'window.json');
const loadBounds = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } };
const saveBounds = () => {
  if (!win || win.isDestroyed() || win.isMinimized() || miniFrom) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), max: win.isMaximized() })); } catch { /* ignore */ }
};

async function startServer() {
  const mod = require(path.join(__dirname, '..', 'dist-server', 'server.cjs'));
  server = await mod.start({
    dataDir: path.join(app.getPath('userData'), 'data'),
    staticDir: path.join(__dirname, '..', 'dist'),
    defaultDownloadDir: path.join(app.getPath('videos'), 'Cinema'),
    port: DEV_URL ? 3001 : 38141, // a fixed port keeps the window's saved settings stable between launches
    fallbackPort: true, bind: '127.0.0.1', token, crypt, embedded: true,
  });
  port = server.port;
  origin = DEV_URL || `http://127.0.0.1:${port}`;
}

// Background work = a download that is running or waiting, or one scheduled for later. Nothing else keeps the app alive.
const pendingSchedules = async () => {
  try { const j = await (await fetch(`http://127.0.0.1:${port}/api/dl/schedules?tk=${token}`)).json(); return j.items || []; } catch { return []; }
};
const rulesOn = async () => {
  try { const j = await (await fetch(`http://127.0.0.1:${port}/api/dl/rules?tk=${token}`)).json(); return (j.items || []).some((x) => x.on); } catch { return false; }
};
const hasWork = async () => {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/api/dl?tk=${token}`)).json();
    if ((j.active ?? 0) + (j.waiting ?? 0) > 0) return true;
  } catch { /* server not ready */ }
  return (await pendingSchedules()).length > 0 || (await rulesOn());
};
function showWin() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// Download progress on the taskbar icon and in the tray tooltip, plus a notice when everything is done.
let lastBusy = false;
const dlSeen = new Map();                          // download id -> the state we saw last time
let dlBatch = { ok: [], bad: [] };                 // what finished since the last time the queue went quiet
let lastNote = null;                               // keep a reference so the click handler is not garbage collected
function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => showWin());
  lastNote = n;
  n.show();
}
function reportBatch() {
  const { ok, bad } = dlBatch;
  dlBatch = { ok: [], bad: [] };
  if (!ok.length && !bad.length) return;                       // paused or cancelled: nothing to announce
  const nm = (x) => String(x.name || '').replace(/\.[^.]+$/, '');
  if (ok.length && !bad.length) notify(ok.length === 1 ? 'Saved for offline' : `${ok.length} videos saved`, ok.length === 1 ? `“${nm(ok[0])}” is ready to watch offline.` : 'They are ready to watch offline.');
  else if (bad.length && !ok.length) notify(bad.length === 1 ? 'Download failed' : `${bad.length} downloads failed`, bad.length === 1 ? `“${nm(bad[0])}”: ${bad[0].error || 'something went wrong'}` : 'Open Downloads to see why and retry.');
  else notify(`${ok.length} saved, ${bad.length} failed`, 'Open Downloads to see what went wrong and retry.');
}
let meteredNow = false, lastMeteredCheck = 0;
function checkMetered() {
  if (process.platform !== 'win32') return;
  lastMeteredCheck = Date.now();
  const ps = "$null=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime];$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile();if($p){$p.GetConnectionCost().NetworkCostType}else{'None'}";
  require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, out) => { if (!err) meteredNow = /Fixed|Variable/i.test(String(out)); });
}
function trackDownloads() {
  const tick = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/dl?tk=${token}`);
      const j = await r.json();
      for (const i of j.items || []) {              // count real outcomes: finished fine, or failed
        const was = dlSeen.get(i.id);
        if (was && was !== i.state) {
          if (i.state === 'done' && ['queued', 'encoding', 'downloading', 'finalizing'].includes(was)) dlBatch.ok.push(i);
          else if (i.state === 'error') dlBatch.bad.push(i);
        }
        dlSeen.set(i.id, i.state);
      }
      const items = (j.items || []).filter((i) => ['encoding', 'downloading', 'finalizing', 'queued'].includes(i.state));
      const live = items.filter((i) => i.state !== 'queued');
      const busy = items.length > 0;
      if (busy) {
        const total = items.reduce((a, i) => a + (i.size || 0), 0), done = items.reduce((a, i) => a + (i.done || 0), 0);
        const frac = total > 0 ? Math.min(1, done / total) : 0;
        const pct = Math.round(frac * 100), mb = ((j.speed || 0) / 1048576).toFixed(1);
        win?.setProgressBar?.(frac > 0 ? frac : 1, frac > 0 ? { mode: 'normal' } : { mode: 'indeterminate' });
        tray?.setToolTip?.(`Cinema · ${live.length} downloading${j.waiting ? `, ${j.waiting} waiting` : ''} · ${pct}% · ${mb} MB/s`);
      } else {
        win?.setProgressBar?.(-1);
        tray?.setToolTip?.('Cinema');
        reportBatch();
      }
      const sched = await pendingSchedules();
      if (!busy && sched.length) {
        const next = Math.min(...sched.map((x) => x.at));
        tray?.setToolTip?.(`Cinema · next download ${new Date(next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`);
      }
      const rules = await rulesOn();
      const hidden = hadWindow && (!win || win.isDestroyed() || (!win.isVisible() && !win.isMinimized()));
      if (hidden && !busy && !sched.length && !rules && !quitting) { quitting = true; app.quit(); }
      try {
        fetch(`http://127.0.0.1:${port}/api/power?tk=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ battery: powerMonitor.isOnBatteryPower(), metered: meteredNow }) })
          .then((r) => r.json()).then((j) => { if (j.wantMetered && Date.now() - lastMeteredCheck > 60000) checkMetered(); if (!j.wantMetered) meteredNow = false; }).catch(() => {});
      } catch { /* no power info */ }
      lastBusy = busy;
    } catch { /* server not ready */ }
  };
  setInterval(tick, 3000).unref?.();
}

function createWindow() {
  hadWindow = true;
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 800, x: b.x, y: b.y, minWidth: 380, minHeight: 520,
    backgroundColor: '#0c1017', title: 'Cinema', icon: ICON, autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (b.max) win.maximize();
  win.once('ready-to-show', () => { win.show(); updateThumbar(); });
  win.on('closed', () => { win = null; });
  win.loadURL(origin);
  win.on('resize', saveBounds); win.on('move', saveBounds);
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) e.preventDefault(); });
  // Closing the window while downloads are running keeps them going in the tray.
  win.on('close', async (e) => {
    if (quitting) return;
    if (await hasWork()) {
      e.preventDefault();
      win.hide();
      // Free the window's memory; only the small background part keeps running, and it quits by itself when the work is done.
      setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible() && !quitting) win.destroy(); }, 1500);
      tray?.displayBalloon?.({ title: 'Cinema', content: 'Cinema keeps running only to finish your downloads, then closes by itself.' });
    } else { quitting = true; app.quit(); }
  });
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Cinema');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Cinema', click: () => showWin() },
      { label: 'Check for updates', click: () => { showWin(); checkUpdates(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showWin());
  } catch { /* some Linux desktops have no tray */ }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Cinema', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'togglefullscreen' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
  ]));
}

// ---------- the bridge ----------
const str = (v) => typeof v === 'string' && v.length > 0 && v.length < 4096;
ipcMain.on('app-version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.handle('select-file', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], filters: Array.isArray(filters) ? filters : undefined });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('select-files', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections', 'showHiddenFiles'], filters: Array.isArray(filters) ? filters : undefined });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('select-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('power-save', (_e, on) => {
  if (on && blocker < 0) blocker = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && blocker >= 0) { powerSaveBlocker.stop(blocker); blocker = -1; }
});
ipcMain.handle('mini-player', (_e, on) => {
  if (!win) return;
  if (on && !miniFrom) {
    miniFrom = { bounds: win.getBounds(), max: win.isMaximized(), fs: win.isFullScreen() };
    if (miniFrom.fs) win.setFullScreen(false);
    if (miniFrom.max) win.unmaximize();
    win.setMinimumSize(320, 180);
    win.setAspectRatio(16 / 9);
    win.setBounds({ width: 480, height: 270 });
    win.setAlwaysOnTop(true, 'floating');
  } else if (!on && miniFrom) {
    win.setAlwaysOnTop(false); win.setAspectRatio(0); win.setMinimumSize(380, 520);
    win.setBounds(miniFrom.bounds);
    if (miniFrom.max) win.maximize();
    miniFrom = null;
  }
});
const launch = (player, arg) => new Promise((ok) => {
  try {
    const c = spawn(player, [arg], { detached: true, stdio: 'ignore' });
    c.on('error', (e) => ok(`Could not start that player: ${e.message}`));
    c.unref();
    setTimeout(() => ok(''), 400);
  } catch (e) { ok(`Could not start that player: ${e.message}`); }
});
ipcMain.handle('open-external', async (_e, file, player) => {
  if (!str(file) || !path.isAbsolute(file)) return 'Bad file';
  if (str(player)) return launch(player, file);
  return shell.openPath(file); // returns '' on success
});
ipcMain.handle('open-stream', async (_e, apiPath, player) => {
  if (!str(apiPath) || !apiPath.startsWith('/api/stream?')) return 'Bad address';
  if (!str(player)) return 'Choose the player you want to use in Settings > Other players first.';
  return launch(player, `http://127.0.0.1:${port}${apiPath}&tk=${token}`);
});
ipcMain.handle('take-pending-open', () => { rendererReady = true; const f = pendingOpen; pendingOpen = null; return f; });
ipcMain.handle('update-get', () => updView());
ipcMain.handle('update-config', (_e, cfg) => {
  const feed = typeof cfg?.feed === 'string' ? cfg.feed.trim() : updCfg.feed;
  if (feed && !/^https?:\/\//i.test(feed)) { setUpd({ state: 'error', error: 'The update address must start with http:// or https://' }); return updView(); }
  updCfg = { feed, auto: typeof cfg?.auto === 'boolean' ? cfg.auto : updCfg.auto };
  try { fs.writeFileSync(updCfgFile(), JSON.stringify(updCfg)); } catch { /* ignore */ }
  applyFeed();
  if (upd.state === 'error') setUpd({ state: 'idle', error: '' });
  return updView();
});
ipcMain.handle('update-check', () => checkUpdates());
ipcMain.handle('update-download', async () => {
  if (!updater || upd.state !== 'available') return;
  setUpd({ state: 'downloading', percent: 0 });
  try { await updater.downloadUpdate(); } catch (e) { setUpd({ state: 'error', error: friendly(e) }); }
});
ipcMain.handle('update-install', () => {
  if (!updater || upd.state !== 'ready') return;
  quitting = true;
  try { server?.close(); } catch { /* ignore */ } // pauses and saves the download queue
  updater.quitAndInstall(false, true);
});
// ----- extras: start with Windows, pop-out window, media keys and taskbar buttons -----
const hiddenStart = process.argv.includes('--hidden');
ipcMain.handle('login-item-get', () => app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin);
ipcMain.handle('login-item-set', (_e, on) => { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; });
ipcMain.handle('popout', (_e, qs) => {
  if (!/^[\w&=%.\-~]+$/.test(String(qs))) return;
  const w = new BrowserWindow({ width: 960, height: 560, backgroundColor: '#000000', title: 'Cinema', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  w.loadURL(`${origin}/?pop=1&${qs}`);
});
let mediaPlaying = false;
const sendMedia = (k) => { if (win && !win.isDestroyed()) win.webContents.send('media-key', k); };
function updateThumbar() {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  const img = (n) => nativeImage.createFromPath(path.join(__dirname, '..', 'build', n));
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: img('media-prev.png'), click: () => sendMedia('prev') },
    { tooltip: mediaPlaying ? 'Pause' : 'Play', icon: img(mediaPlaying ? 'media-pause.png' : 'media-play.png'), click: () => sendMedia('toggle') },
    { tooltip: 'Next', icon: img('media-next.png'), click: () => sendMedia('next') },
  ]);
}
ipcMain.handle('media-state', (_e, playing) => { if (mediaPlaying !== !!playing) { mediaPlaying = !!playing; updateThumbar(); } });
function registerMediaKeys() {
  for (const [key, cmd] of [['MediaPlayPause', 'toggle'], ['MediaNextTrack', 'next'], ['MediaPreviousTrack', 'prev'], ['MediaStop', 'stop']]) { try { globalShortcut.register(key, () => sendMedia(cmd)); } catch { /* key taken by another app */ } }
}
ipcMain.handle('reveal', (_e, file) => { if (str(file)) shell.showItemInFolder(file); });
ipcMain.handle('open-folder', (_e, dir) => { if (str(dir)) return shell.openPath(dir); });

app.on('second-instance', (_e, argv, cwd) => {
  showWin();
  deliver(fileFromArgv(argv, cwd));
});
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch { /* ignore */ } });
app.on('before-quit', () => { quitting = true; saveBounds(); try { server?.close(); } catch { /* ignore */ } });
app.on('window-all-closed', () => { if (quitting) app.quit(); });

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox('Cinema could not start', String((e && e.stack) || e));
    app.exit(1);
    return;
  }
  const url = new URL(origin);
  await session.defaultSession.cookies.set({ url: `${url.protocol}//${url.hostname}`, name: 'cinema', value: token, httpOnly: true, sameSite: 'strict', path: '/' });
  // Only allow what a video player needs.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['fullscreen', 'clipboard-sanitized-write'].includes(perm)));
  buildMenu();
  initUpdater();
  registerMediaKeys();
  if (hiddenStart) {
    // Started with Windows: stay in the tray only when there is something to do (a scheduled download or an auto-save rule).
    createTray(); trackDownloads();
    setTimeout(async () => { if (!(await hasWork()) && !quitting) { quitting = true; app.quit(); } }, 45000);
  } else { createWindow(); createTray(); trackDownloads(); }
  app.on('activate', () => showWin());
});
