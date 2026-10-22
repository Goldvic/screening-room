const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The only things the web page may ask the computer to do.
contextBridge.exposeInMainWorld('cinema', {
  version: ipcRenderer.sendSync('app-version'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  selectFiles: (filters) => ipcRenderer.invoke('select-files', filters),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  powerSave: (on) => ipcRenderer.invoke('power-save', !!on),
  miniPlayer: (on) => ipcRenderer.invoke('mini-player', !!on),
  openExternal: (file, player) => ipcRenderer.invoke('open-external', file, player),
  openStream: (apiPath, player) => ipcRenderer.invoke('open-stream', apiPath, player),
  // opening files from Explorer, drag and drop
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  takePendingOpen: () => ipcRenderer.invoke('take-pending-open'),
  loginItemGet: () => ipcRenderer.invoke('login-item-get'),
  loginItemSet: (on) => ipcRenderer.invoke('login-item-set', !!on),
  popout: (qs) => ipcRenderer.invoke('popout', String(qs)),
  mediaState: (playing) => ipcRenderer.invoke('media-state', !!playing),
  onMediaKey: (cb) => { const f = (_e, k) => cb(k); ipcRenderer.on('media-key', f); return () => ipcRenderer.removeListener('media-key', f); },
  onOpenFile: (cb) => { const f = (_e, file) => cb(file); ipcRenderer.on('open-file', f); return () => ipcRenderer.removeListener('open-file', f); },
  // updates
  updateGet: () => ipcRenderer.invoke('update-get'),
  updateConfig: (cfg) => ipcRenderer.invoke('update-config', cfg),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdate: (cb) => { const f = (_e, s) => cb(s); ipcRenderer.on('update-status', f); return () => ipcRenderer.removeListener('update-status', f); },
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
});
