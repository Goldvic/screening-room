// Cinema desktop shell. It starts the Cinema server inside this process, then shows it in a window.
// Everything the window can ask of the computer goes through the small bridge in preload.cjs.
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, powerSaveBlocker, safeStorage, session, shell } = require('electron');
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

let rendererReady = false, pendingOpen = null;
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
function applyFeed() { if (updater && updCfg.feed) updater.setFeedURL({ provider: 'generic', url: updCfg.feed }); }
function initUpdater() {
  loadUpdCfg();
  if (!app.isPackaged) return; // updates only exist in the installed app
  try { updater = require('electron-updater').autoUpdater; } catch { return; }
  updater.autoDownload = false;          // the person decides when to download
  updater.autoInstallOnAppQuit = true;   // a downloaded update installs the next time Cinema closes
  updater.logger = null;
  updater.on('checking-for-update', () => setUpd({ state: 'checking', error: '' }));
  updater.on('update-available', (i) => setUpd({ state: 'available', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => setUpd({ state: 'none' }));
  updater.on('download-progress', (p) => setUpd({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (i) => setUpd({ state: 'ready', version: i.version, percent: 100 }));
  updater.on('error', (e) => setUpd({ state: 'error', error: friendly(e) }));
  applyFeed();
  const auto = () => { if (updCfg.auto && updCfg.feed && ['idle', 'none', 'error'].includes(upd.state)) checkUpdates(); };
  setTimeout(auto, 20000).unref();
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

const hasWork = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/dl?tk=${token}`);
    const j = await r.json();
    return (j.active ?? 0) + (j.waiting ?? 0) > 0;
  } catch { return false; }
};

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 800, x: b.x, y: b.y, minWidth: 380, minHeight: 520,
    backgroundColor: '#0c1017', title: 'Cinema', icon: ICON, autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (b.max) win.maximize();
  win.once('ready-to-show', () => win.show());
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
      tray?.displayBalloon?.({ title: 'Cinema', content: 'Downloads continue in the background. Right-click the tray icon to quit.' });
    } else { quitting = true; app.quit(); }
  });
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Cinema');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Cinema', click: () => { win?.show(); win?.focus(); } },
      { label: 'Check for updates', click: () => { win?.show(); checkUpdates(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => { win?.show(); win?.focus(); });
  } catch { /* some Linux desktops have no tray */ }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Cinema', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }] },
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
ipcMain.handle('reveal', (_e, file) => { if (str(file)) shell.showItemInFolder(file); });
ipcMain.handle('open-folder', (_e, dir) => { if (str(dir)) return shell.openPath(dir); });

app.on('second-instance', (_e, argv, cwd) => {
  if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
  deliver(fileFromArgv(argv, cwd));
});
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
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else win?.show(); });
});
