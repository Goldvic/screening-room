const { app, BrowserWindow, Menu } = require('electron');

// Your VPS address (the one you open in the browser)
const URL = 'http://139.162.182.113:3001';

const errorPage = (msg) => 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<body style="background:#0b0d12;color:#ddd;font:16px sans-serif;padding:40px">
   <h2>Cannot open Cinema</h2><p>${msg}</p><p>Trying: ${URL}</p>
   <button onclick="location.href='${URL}'" style="padding:8px 16px">Retry</button></body>`);

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ width: 1280, height: 800, backgroundColor: '#0b0d12', autoHideMenuBar: true, title: 'Cinema' });
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (isMain && !failedUrl.startsWith('data:')) win.loadURL(errorPage(`Error: ${desc} (${code}). The VPS app may be off, the port closed, or the address wrong.`));
  });
  win.loadURL(URL);
});
app.on('window-all-closed', () => app.quit());
