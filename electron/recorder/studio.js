// Cinema Recorder: the part that runs inside the studio window.
// Capture -> (crop and scale on a canvas) -> MediaRecorder -> chunks go to the main process, which writes the file and makes the MP4.
(() => {
  const $ = (id) => document.getElementById(id);
  const BOX = { 720: [1280, 720], 1080: [1920, 1080], 2160: [3840, 2160] };
  const LABEL = { 720: '720p', 1080: '1080p', 2160: '4K' };
  const MBPS = { 720: [5, 8], 1080: [10, 16], 2160: [35, 50] }; // [30 fps, 60 fps] video bitrate
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  const S = { mode: 'cinema', sourceId: '', display: null, region: null, aspect: 'free', quality: '1080', fps: 30, sys: true, mic: false, micId: '', cursor: true, countdown: 3, dir: '', standby: false };
  let sources = { screens: [], windows: [] };
  let cinema = { open: false, w: 0, h: 0 };
  let run = null;          // the live recording: { video, canvas, mr, tracks, timer, ... }
  let lastFile = '';

  // ---------- output size ----------
  // The picture is fitted into 1280x720, 1920x1080 or 3840x2160 (turned on its side for a tall window), so a small or tall window
  // still gives a clean video of the right quality with the same shape as the window.
  function outSize(sw, sh, q = S.quality) {
    const [bw, bh] = BOX[q];
    const [W, H] = sh > sw ? [bh, bw] : [bw, bh];
    const k = Math.min(W / sw, H / sh);
    return [even(sw * k), even(sh * k)];
  }
  function sourceSize() {
    if (S.mode === 'cinema') return cinema.open ? [cinema.w, cinema.h] : null;
    if (S.mode === 'region') return S.region ? [S.region.pxW, S.region.pxH] : null;
    if (S.mode === 'screen') { const s = sources.screens.find((x) => x.id === S.sourceId); return s ? [s.px.w, s.px.h] : null; }
    return null; // a window: its size is known once capture starts
  }
  function summary() {
    const ss = sourceSize();
    const mb = Math.round((MBPS[S.quality][S.fps === 60 ? 1 : 0] + 0.19) * 7.5);
    const size = ss ? outSize(ss[0], ss[1]) : null;
    $('summary').innerHTML = (size ? `Video will be <b>${size[0]}×${size[1]}</b>` : 'Video size follows the window you pick') + ` · ${S.fps} fps · about <b>${mb} MB</b> per minute · saved as MP4`;
  }

  // ---------- configuration ----------
  const save = (p) => window.rec.cfgSet(p);
  function mark(group, attr, value) { for (const b of $(group).children) b.classList.toggle('on', String(b.dataset[attr]) === String(value)); }
  async function loadCfg() {
    const c = await window.rec.cfgGet();
    Object.assign(S, { quality: String(c.quality), fps: c.fps, sys: c.sys, mic: c.mic, micId: c.micId, cursor: c.cursor, countdown: c.countdown, dir: c.dir, standby: c.standby, mode: c.mode || 'cinema' });
    $('hkOpen').textContent = c.hotkeys.open;
    $('pause').title = `Pause (${c.hotkeys.pause})`; $('stop').title = `Stop (${c.hotkeys.open})`;
    mark('quality', 'q', S.quality); mark('fps', 'f', S.fps); mark('countdown', 'c', S.countdown);
    $('sys').checked = S.sys; $('mic').checked = S.mic; $('cursor').checked = S.cursor; $('standby').checked = S.standby;
    $('dir').textContent = S.dir;
    $('micRow').hidden = !S.mic;
    if (S.mic) loadMics();
    setMode(S.mode, true);
  }

  // ---------- modes and sources ----------
  async function setMode(m, quiet) {
    S.mode = m;
    if (!quiet) save({ mode: m });
    for (const b of $('modes').children) b.classList.toggle('on', b.dataset.m === m);
    for (const k of ['cinema', 'screen', 'window', 'region']) $('pane-' + k).hidden = k !== m;
    $('refresh').hidden = m === 'cinema' || m === 'region';
    if (m === 'cinema') { await updateCinema(); S.sourceId = cinema.id || ''; }
    else await refreshSources();
    if (m === 'screen' && !sources.screens.find((x) => x.id === S.sourceId)) S.sourceId = sources.screens[0]?.id || '';
    if (m === 'window' && !sources.windows.find((x) => x.id === S.sourceId)) S.sourceId = '';
    drawSources(); summary(); ready();
  }
  async function updateCinema() {
    const c = await window.rec.cinemaInfo();
    cinema = c && c.open ? c : { open: false, w: 0, h: 0 };
    $('cinemaSize').textContent = cinema.open ? `Now ${cinema.w}×${cinema.h}${cinema.minimized ? ' · minimized' : ''}` : 'Cinema is closed';
    const k = cinema.open && cinema.h ? Math.min(150 / cinema.w, 110 / cinema.h) : 0;
    const m = $('mock');
    if (k) { m.style.width = Math.max(30, Math.round(cinema.w * k)) + 'px'; m.style.height = Math.max(30, Math.round(cinema.h * k)) + 'px'; }
  }
  async function refreshSources() {
    try { sources = await window.rec.sources(); } catch { sources = { screens: [], windows: [] }; }
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function drawSources() {
    $('screens').innerHTML = sources.screens.map((s) => `<button class="card${S.sourceId === s.id ? ' on' : ''}" data-id="${esc(s.id)}"><div class="th" style="background-image:url(${s.thumb})"></div><div class="cap"><b>${esc(s.name)}</b><small>${s.px.w}×${s.px.h}</small></div></button>`).join('') || '<div class="empty">No screens found</div>';
    $('windows').innerHTML = sources.windows.map((s) => `<button class="card${S.sourceId === s.id ? ' on' : ''}" data-id="${esc(s.id)}"><div class="th" style="background-image:url(${s.thumb})"></div><div class="cap">${s.icon ? `<img src="${s.icon}" alt="">` : ''}<b title="${esc(s.name)}">${esc(s.name)}</b></div></button>`).join('') || '<div class="empty">No other windows are open</div>';
    $('regScreens').innerHTML = sources.screens.map((s, i) => `<button data-d="${s.displayId}" data-id="${esc(s.id)}" class="${(S.display?.displayId ?? sources.screens[0]?.displayId) === s.displayId ? 'on' : ''}">${esc(s.name)}</button>`).join('');
    if (S.mode === 'region' && !S.display && sources.screens[0]) S.display = sources.screens[0];
  }
  function ready() {
    const ok = S.mode === 'cinema' ? cinema.open : S.mode === 'region' ? !!S.region : !!S.sourceId;
    $('start').disabled = !ok;
    $('startLabel').textContent = ok ? 'Start recording' : S.mode === 'cinema' ? 'Open Cinema to record it' : S.mode === 'region' ? 'Select an area first' : S.mode === 'window' ? 'Pick a window first' : 'Pick a screen first';
  }

  // ---------- microphones ----------
  async function loadMics() {
    try {
      const t = await navigator.mediaDevices.getUserMedia({ audio: true });
      t.getTracks().forEach((x) => x.stop());
      const d = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === 'audioinput' && x.deviceId !== 'communications');
      $('micSel').innerHTML = d.map((x, i) => `<option value="${esc(x.deviceId)}">${esc(x.label || 'Microphone ' + (i + 1))}</option>`).join('');
      if (S.micId && d.some((x) => x.deviceId === S.micId)) $('micSel').value = S.micId; else S.micId = $('micSel').value;
    } catch { $('micSel').innerHTML = '<option>No microphone available</option>'; S.mic = false; $('mic').checked = false; $('micRow').hidden = true; save({ mic: false }); }
  }

  // ---------- recording ----------
  const pickMime = () => {
    for (const [m, h264] of [['video/webm;codecs=h264,opus', true], ['video/webm;codecs=vp9,opus', false], ['video/webm;codecs=vp8,opus', false]]) if (MediaRecorder.isTypeSupported(m)) return { mime: m, h264 };
    return { mime: 'video/webm', h264: false };
  };
  const fmt = (ms) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60, p = (n) => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`; };
  const push = (state) => window.rec.state({ state, ms: run ? run.elapsed() : 0 });

  function showPill(on) {
    $('studio').hidden = on; $('pill').hidden = !on;
    window.rec.compact(on);
  }

  async function begin(o = {}) {
    if (run) return;
    const cd = typeof o.countdown === 'number' ? o.countdown : S.countdown;
    const wantSys = o.sys !== undefined ? o.sys : S.sys;
    const quality = o.quality || S.quality;
    let src = S.sourceId;
    if (o.mode === 'cinema') src = o.sourceId;
    else if (S.mode === 'region') src = S.display ? S.display.id : '';
    if (!src) return;

    run = { elapsedBase: 0, startAt: 0, pausedAt: 0, cancelled: false, queue: Promise.resolve(), elapsed() { return this.state === 'paused' ? this.pausedAt - this.startAt - this.elapsedBase : this.startAt ? Date.now() - this.startAt - this.elapsedBase : 0; }, state: 'countdown' };
    const me = run;
    showPill(true);
    $('pill').classList.remove('paused');
    $('tag').textContent = `${LABEL[quality]} · ${S.fps} fps`;
    $('live').hidden = true;
    push('countdown');
    // countdown (skipped when it is 0)
    for (let n = cd; n > 0; n--) {
      $('count').hidden = false; $('count').innerHTML = `${n}<small>Recording starts…</small>`;
      await new Promise((r) => setTimeout(r, 1000));
      if (me.cancelled) { cleanup(me); return; }
    }
    $('count').hidden = true; $('live').hidden = false;

    try {
      await window.rec.prepare({ sourceId: src, audio: wantSys });
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: S.fps, max: S.fps }, cursor: S.cursor ? 'always' : 'never' }, audio: wantSys });
      me.display = display;
      const video = document.createElement('video');
      video.muted = true; video.srcObject = display;
      await video.play();
      for (let i = 0; i < 60 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 50));
      if (!video.videoWidth) throw new Error('Nothing to record (is the window minimized?)');
      me.video = video;

      // the part of the picture to keep (an area) and the size of the finished video
      let crop = null;
      if (S.mode === 'region' && o.mode !== 'cinema' && S.region) {
        const k = video.videoWidth / S.region.display.w;
        crop = { x: S.region.x * k, y: S.region.y * k, w: S.region.w * k, h: S.region.h * k };
      }
      const srcW = crop ? crop.w : video.videoWidth, srcH = crop ? crop.h : video.videoHeight;
      const [W, H] = outSize(srcW, srcH, quality);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      ctx.imageSmoothingQuality = 'high';
      const draw = () => {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw) return;
        let sx = 0, sy = 0, sw = vw, sh = vh;
        if (crop) { sx = Math.min(crop.x, vw - 2); sy = Math.min(crop.y, vh - 2); sw = Math.min(crop.w, vw - sx); sh = Math.min(crop.h, vh - sy); }
        // if the window changes size while recording, the picture is re-fitted with black bars, so the video keeps one size
        const k = Math.min(W / sw, H / sh), dw = sw * k, dh = sh * k;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(video, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
      };
      draw();
      me.timer = setInterval(draw, Math.round(1000 / S.fps));

      // sound: computer sound and microphone mixed into one track
      const tracks = [...canvas.captureStream(S.fps).getVideoTracks()];
      const ins = [];
      if (wantSys) display.getAudioTracks().forEach((t) => ins.push(t));
      if (S.mic) { try { me.micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: S.micId ? { exact: S.micId } : undefined, echoCancellation: true, noiseSuppression: true } }); me.micStream.getAudioTracks().forEach((t) => ins.push(t)); } catch { /* record without the microphone */ } }
      if (ins.length) {
        me.ac = new AudioContext();
        const dest = me.ac.createMediaStreamDestination();
        for (const t of ins) me.ac.createMediaStreamSource(new MediaStream([t])).connect(dest);
        tracks.push(...dest.stream.getAudioTracks());
      }

      const f = await window.rec.fileOpen();
      if (!f || !f.ok) throw new Error(f?.error || 'Could not create the file');
      const { mime, h264 } = pickMime();
      const mr = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: MBPS[quality][S.fps === 60 ? 1 : 0] * 1e6, audioBitsPerSecond: 192000 });
      me.mr = mr; me.h264 = h264; me.fps = S.fps;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) me.queue = me.queue.then(() => e.data.arrayBuffer()).then((b) => window.rec.chunk(b)); };
      mr.onstop = () => finish(me);
      // the thing being recorded went away (window closed, screen unplugged)
      display.getVideoTracks()[0].addEventListener('ended', () => { if (run === me) stop(); });
      mr.start(1000);
      me.startAt = Date.now(); me.state = 'recording';
      me.tick = setInterval(() => { $('clock').textContent = fmt(me.elapsed()); push(me.state); }, 500);
      $('clock').textContent = '00:00';
      push('recording');
    } catch (e) {
      cleanup(me);
      showPill(false);
      alertBox('Could not start recording', String((e && e.message) || e));
    }
  }

  function togglePause() {
    if (!run || !run.mr) return;
    if (run.state === 'recording') { run.mr.pause(); run.state = 'paused'; run.pausedAt = Date.now(); $('pill').classList.add('paused'); }
    else if (run.state === 'paused') { run.mr.resume(); run.elapsedBase += Date.now() - run.pausedAt; run.state = 'recording'; $('pill').classList.remove('paused'); }
    push(run.state);
  }

  function stop() {
    if (!run) return;
    if (run.state === 'countdown' || !run.mr) { run.cancelled = true; cleanup(run); showPill(false); return; }
    if (run.state === 'paused') run.elapsedBase += Date.now() - run.pausedAt;
    run.durationMs = run.elapsed();
    run.state = 'stopping';
    clearInterval(run.timer); clearInterval(run.tick);
    try { run.mr.stop(); } catch { finish(run); }
  }

  async function finish(me) {
    if (me.finishing) return; me.finishing = true;
    const dur = me.durationMs ?? me.elapsed();
    $('busy').hidden = false; $('busyBar').style.width = '0%'; $('busyText').textContent = 'Saving your recording…';
    showPill(false);
    $('studio').hidden = false;
    await me.queue;
    cleanup(me, true);
    const r = await window.rec.fileClose({ durationMs: dur, h264: me.h264, fps: me.fps });
    $('busy').hidden = true;
    run = null;
    if (r && r.file) {
      lastFile = r.file;
      $('lastName').textContent = r.file; $('last').hidden = false;
      $('lastOpen').hidden = false;
    } else if (r && r.error) alertBox('Recording problem', r.error);
  }

  function cleanup(me, keepRun) {
    clearInterval(me.timer); clearInterval(me.tick);
    try { me.display?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    try { me.micStream?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    try { me.ac?.close(); } catch { /* gone */ }
    if (me.video) me.video.srcObject = null;
    if (!keepRun) { run = null; window.rec.state({ state: 'idle', ms: 0 }); }
  }

  function alertBox(title, text) {
    $('busy').hidden = false; $('busy').innerHTML = `<b style="font-size:16px">${esc(title)}</b><p style="max-width:340px;text-align:center;color:var(--mute);margin:0">${esc(text)}</p><button class="rec" style="width:220px;padding:12px" id="ok"><span>OK</span></button>`;
    $('ok').onclick = () => { $('busy').hidden = true; $('busy').innerHTML = '<div class="ring"></div><b id="busyText"></b><div class="meter"><i id="busyBar"></i></div>'; };
  }

  // ---------- events ----------
  $('modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); });
  $('screens').addEventListener('click', (e) => { const b = e.target.closest('.card'); if (!b) return; S.sourceId = b.dataset.id; drawSources(); summary(); ready(); });
  $('windows').addEventListener('click', (e) => { const b = e.target.closest('.card'); if (!b) return; S.sourceId = b.dataset.id; drawSources(); summary(); ready(); });
  $('regScreens').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.display = sources.screens.find((x) => String(x.displayId) === b.dataset.d); S.sourceId = S.display.id; S.region = null; $('regionLabel').textContent = 'Select an area on the screen'; $('pickRegion').classList.remove('set'); drawSources(); summary(); ready(); });
  $('aspects').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.aspect = b.dataset.a; mark('aspects', 'a', S.aspect); });
  $('pickRegion').onclick = async () => {
    const d = S.display || sources.screens[0];
    if (!d) return;
    S.display = d; S.sourceId = d.id;
    const r = await window.rec.pickRegion(d.displayId, S.aspect);
    if (!r) return;
    const k = d.px.w / d.dip.w;
    S.region = { ...r, pxW: Math.round(r.w * k), pxH: Math.round(r.h * k) };
    $('regionLabel').textContent = `${S.region.pxW}×${S.region.pxH} area selected. Click to change it`;
    $('pickRegion').classList.add('set');
    summary(); ready();
  };
  $('refresh').onclick = async () => { await refreshSources(); drawSources(); };
  $('quality').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.quality = b.dataset.q; mark('quality', 'q', S.quality); save({ quality: S.quality }); summary(); });
  $('fps').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.fps = Number(b.dataset.f); mark('fps', 'f', S.fps); save({ fps: S.fps }); summary(); });
  $('countdown').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.countdown = Number(b.dataset.c); mark('countdown', 'c', S.countdown); save({ countdown: S.countdown }); });
  $('sys').onchange = (e) => { S.sys = e.target.checked; save({ sys: S.sys }); };
  $('cursor').onchange = (e) => { S.cursor = e.target.checked; save({ cursor: S.cursor }); };
  $('standby').onchange = (e) => { S.standby = e.target.checked; save({ standby: S.standby }); };
  $('mic').onchange = async (e) => { S.mic = e.target.checked; $('micRow').hidden = !S.mic; save({ mic: S.mic }); if (S.mic) { await loadMics(); save({ mic: S.mic, micId: S.micId }); } };
  $('micSel').onchange = (e) => { S.micId = e.target.value; save({ micId: S.micId }); };
  $('chdir').onclick = async () => { const d = await window.rec.chooseDir(); if (d) { S.dir = d; $('dir').textContent = d; } };
  $('openDir').onclick = () => window.rec.openFolder();
  $('lastShow').onclick = () => lastFile && window.rec.reveal(lastFile);
  $('lastOpen').onclick = () => lastFile && window.rec.openFile(lastFile);
  $('close').onclick = () => window.rec.hide();
  $('min').onclick = () => window.rec.minimize();
  $('start').onclick = () => begin({});
  $('pause').onclick = togglePause;
  $('stop').onclick = stop;
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !run) window.rec.hide(); });

  window.rec.onCmd((c) => {
    if (c.cmd === 'start') { S.quality = String(c.quality || S.quality); begin({ mode: c.mode, sourceId: c.sourceId, quality: S.quality, countdown: c.countdown, sys: c.sys }); }
    else if (c.cmd === 'stop') stop();
    else if (c.cmd === 'toggle-pause') togglePause();
    else if (c.cmd === 'opened' && !run) { loadCfg(); }
  });
  window.rec.onFinalize((d) => { $('busyBar').style.width = d.pct + '%'; $('busyText').textContent = d.pct ? `Making your MP4… ${d.pct}%` : 'Making your MP4…'; });
  setInterval(() => { if (!run && !$('studio').hidden && S.mode === 'cinema') updateCinema().then(() => { summary(); ready(); }); }, 1500);

  loadCfg();
})();
