const { contextBridge, ipcRenderer } = require('electron');
const inv = (c, ...a) => ipcRenderer.invoke(c, ...a);
const on = (ch, cb) => { const f = (_e, d) => cb(d); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };

contextBridge.exposeInMainWorld('rec', {
  cfgGet: () => inv('rec:cfg-get'),
  cfgSet: (p) => inv('rec:cfg-set', p),
  sources: () => inv('rec:sources'),
  cinemaInfo: () => inv('rec:cinema-info'),
  cinemaRect: () => inv('rec:cinema-rect'),
  drawInit: (displayId) => inv('rec:draw-init', displayId),
  drawToggle: () => inv('rec:draw-toggle'),
  drawClose: () => inv('rec:draw-close'),
  drawStrokes: (p) => ipcRenderer.send('draw:strokes', p),
  drawDone: () => ipcRenderer.send('draw:done'),
  onDraw: (cb) => on('draw:mode', cb),
  pickRegion: (displayId, aspect) => inv('rec:region-pick', displayId, aspect),
  prepare: (o) => inv('rec:prepare', o),
  compact: (on_) => inv('rec:compact', !!on_),
  hide: () => inv('rec:hide'),
  minimize: () => inv('rec:minimize'),
  chooseDir: () => inv('rec:choose-dir'),
  openFolder: () => inv('rec:open-folder'),
  reveal: (f) => inv('rec:reveal', f),
  openFile: (f) => inv('rec:open-file', f),
  fileOpen: () => inv('rec:file-open'),
  chunk: (buf) => ipcRenderer.send('rec:chunk', buf),
  fileClose: (meta) => inv('rec:file-close', meta),
  state: (s) => ipcRenderer.send('rec:state', s),
  regionDone: (r) => ipcRenderer.send('rec:region-done', r),
  onCmd: (cb) => on('rec:cmd', cb),
  onFinalize: (cb) => on('rec:finalize', cb),
});
