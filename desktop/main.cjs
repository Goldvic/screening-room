const { app, BrowserWindow, Menu } = require('electron');

// >>> CHANGE THIS to your VPS address (the one you open in the browser) <<<
const URL = 'http://YOUR-VPS-IP-OR-DOMAIN:3001';

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ width: 1280, height: 800, backgroundColor: '#0b0d12', autoHideMenuBar: true, title: 'Screening Room' });
  win.loadURL(URL);
  win.webContents.on('did-fail-load', () => {
    win.loadURL('data:text/html,<body style="background:#0b0d12;color:#ddd;font:16px sans-serif;padding:40px">Cannot reach the server. Check your internet and that the VPS app is running.<br><br><button onclick="location.href=\'' + URL + '\'">Retry</button></body>');
  });
});
app.on('window-all-closed', () => app.quit());
