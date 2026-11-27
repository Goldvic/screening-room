// Cinema Recorder: the part that runs inside the studio window.
// Capture -> (crop and scale on a canvas, drawings painted on top) -> MediaRecorder -> chunks go to the main process,
// which writes the file and makes the MP4 (or MOV, WebM, GIF, MP3) and any smaller copies.
(() => {
  const $ = (id) => document.getElementById(id);
  const BOX = { 720: [1280, 720], 1080: [1920, 1080], 2160: [3840, 2160] };
  const LABEL = { 720: '720p', 1080: '1080p', 2160: '4K' };
  const MBPS = { 720: [5, 8], 1080: [10, 16], 2160: [35, 50] }; // [30 fps, 60 fps] video bitrate
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const S = { mode: 'cinema', sourceId: '', display: null, region: null, aspect: 'free', quality: '1080', fps: 30, sys: true, mic: false, micId: '', sysVol: 100, micVol: 100,
    cursor: true, countdown: 3, dir: '', standby: false, format: 'mp4', extras: [], drawing: true };
  let sources = { screens: [], windows: [] };
  let cinema = { open: false, w: 0, h: 0 };
  let run = null;          // the live recording
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
    let r = null;
    if (S.mode === 'cinema') r = cinema.open ? [cinema.w, cinema.h] : null;
    else if (S.mode === 'region') r = S.region ? [S.region.pxW, S.region.pxH] : null;
    else if (S.mode === 'screen') { const s = sources.screens.find((x) => x.id === S.sourceId); r = s ? [s.px.w, s.px.h] : null; }
    return r && r[0] > 0 && r[1] > 0 ? r : null; // a window: its size is known once capture starts
  }
  const modeAllowsDrawing = () => S.mode !== 'window';
  function summary() {
    const ss = sourceSize();
    const mb = Math.round((MBPS[S.quality][S.fps === 60 ? 1 : 0] + 0.19) * 7.5);
    const size = ss ? outSize(ss[0], ss[1]) : null;
    const fm = { mp4: 'MP4', mov: 'MOV', webm: 'WebM', gif: 'GIF', mp3: 'MP3' }[S.format];
    $('summary').innerHTML = (size ? `Video will be <b>${size[0]}×${size[1]}</b>` : 'Video size follows what you pick') + ` · ${S.fps} fps · about <b>${mb} MB</b> per minute · saved as ${fm}`;
    $('extraBox').hidden = !['mp4', 'mov', 'webm'].includes(S.format);
    const d = modeAllowsDrawing();
    $('drawing').disabled = !d;
    $('drawHint').textContent = d ? 'Draw on the screen while recording: pen, highlighter, shapes, any colour. Ctrl+Alt+D' : 'Not available when recording another app’s window. Use Screen or Area instead.';
  }

  // ---------- configuration ----------
  const save = (p) => window.rec.cfgSet(p);
  function mark(group, attr, value) { for (const b of $(group).children) b.classList.toggle('on', String(b.dataset[attr]) === String(value)); }
  function soundValue() { return S.sys && S.mic ? 'both' : S.sys ? 'sys' : S.mic ? 'mic' : 'none'; }
  function paintSound() {
    mark('soundMode', 's', soundValue());
    $('sysVolRow').hidden = !S.sys; $('micRow').hidden = !S.mic; $('micVolRow').hidden = !S.mic; $('micNote').hidden = !(S.sys && S.mic);
    $('sysVol').value = S.sysVol; $('sysVolO').textContent = S.sysVol + '%'; $('micVol').value = S.micVol; $('micVolO').textContent = S.micVol + '%';
  }
  function paintExtras() { for (const b of $('extras').children) b.classList.toggle('on', S.extras.includes(Number(b.dataset.x))); }
  async function loadCfg() {
    const c = await window.rec.cfgGet();
    Object.assign(S, { quality: String(c.quality), fps: c.fps, sys: c.sys, mic: c.mic, micId: c.micId, sysVol: c.sysVol ?? 100, micVol: c.micVol ?? 100, cursor: c.cursor, countdown: c.countdown,
      dir: c.dir, standby: c.standby, mode: c.mode || 'cinema', format: c.format || 'mp4', extras: (c.extras || []).map(Number), drawing: c.drawing !== false });
    $('hkOpen').textContent = c.hotkeys.open;
    $('pause').title = `Pause (${c.hotkeys.pause})`; $('stop').title = `Stop (${c.hotkeys.open})`; $('draw').title = `Draw on the screen (${c.hotkeys.draw})`;
    mark('quality', 'q', S.quality); mark('fps', 'f', S.fps); mark('countdown', 'c', S.countdown); mark('format', 'fm', S.format);
    $('cursor').checked = S.cursor; $('standby').checked = S.standby; $('drawing').checked = S.drawing;
    $('dir').textContent = S.dir;
    paintSound(); paintExtras();
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
    $('cinemaSize').textContent = cinema.open ? `Now ${cinema.w}×${cinema.h}${cinema.minimized ? ' · minimized, it will come back when you start' : ''}` : 'Cinema is closed';
    const k = cinema.open && cinema.w > 0 && cinema.h > 0 ? Math.min(150 / cinema.w, 110 / cinema.h) : 0;
    const m = $('mock');
    if (k) { m.style.width = Math.max(30, Math.round(cinema.w * k)) + 'px'; m.style.height = Math.max(30, Math.round(cinema.h * k)) + 'px'; }
  }
  async function refreshSources() {
    try { sources = await window.rec.sources(); } catch { sources = { screens: [], windows: [] }; }
  }
  function drawSources() {
    $('screens').innerHTML = sources.screens.map((s) => `<button class="card${S.sourceId === s.id ? ' on' : ''}" data-id="${esc(s.id)}"><div class="th" style="background-image:url(${s.thumb})"></div><div class="cap"><b>${esc(s.name)}</b><small>${s.px.w}×${s.px.h}</small></div></button>`).join('') || '<div class="empty">No screens found</div>';
    $('windows').innerHTML = sources.windows.map((s) => `<button class="card${S.sourceId === s.id ? ' on' : ''}" data-id="${esc(s.id)}"><div class="th" style="background-image:url(${s.thumb})"></div><div class="cap">${s.icon ? `<img src="${s.icon}" alt="">` : ''}<b title="${esc(s.name)}">${esc(s.name)}</b></div></button>`).join('') || '<div class="empty">No other windows are open</div>';
    $('regScreens').innerHTML = sources.screens.map((s) => `<button data-d="${s.displayId}" data-id="${esc(s.id)}" class="${(S.display?.displayId ?? sources.screens[0]?.displayId) === s.displayId ? 'on' : ''}">${esc(s.name)}</button>`).join('');
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
    } catch {
      $('micSel').innerHTML = '<option>No microphone available</option>';
      S.mic = false; save({ mic: false }); paintSound();
      alertBox('Microphone not available', 'Windows did not allow the microphone. Check Settings → Privacy → Microphone and that one is plugged in.');
    }
  }

  // ---------- recording ----------
  // WebM output prefers VP9; everything else prefers H.264 so MP4 can be made without re-encoding.
  const pickMime = () => {
    const list = S.format === 'webm' ? [['video/webm;codecs=vp9,opus', false], ['video/webm;codecs=vp8,opus', false], ['video/webm;codecs=h264,opus', true]]
      : [['video/webm;codecs=h264,opus', true], ['video/webm;codecs=vp9,opus', false], ['video/webm;codecs=vp8,opus', false]];
    for (const [m, h264] of list) if (MediaRecorder.isTypeSupported(m)) return { mime: m, h264 };
    return { mime: 'video/webm', h264: false };
  };
  const fmt = (ms) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60, p = (n) => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`; };
  const push = (state) => window.rec.state({ state, ms: run ? run.elapsed() : 0 });

  function showPill(on) {
    $('studio').hidden = on; $('pill').hidden = !on;
    window.rec.compact(on);
  }
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

  // Ask for the screen or window. Several ways are tried, from the best to the most reliable, so one failing does not stop the recording.
  async function getPicture(o, src, wantSys, wantDraw) {
    const isCinema = o.mode === 'cinema';
    const tries = [];
    if (isCinema) {
      if (!wantDraw) tries.push({ kind: 'window', audio: wantSys });          // just that window
      tries.push({ kind: 'crop', audio: wantSys });                            // the screen it is on, cut to the window
      if (wantSys) tries.push({ kind: 'crop', audio: false });                 // same, without computer sound
    } else {
      tries.push({ kind: 'plain', audio: wantSys });
      if (wantSys) tries.push({ kind: 'plain', audio: false });
    }
    const errs = [];
    for (const t of tries) {
      let d = null;
      try {
        const prep = await window.rec.prepare({ sourceId: src, audio: t.audio, cinema: isCinema, wantScreen: t.kind === 'crop' });
        d = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: S.fps, max: S.fps }, cursor: S.cursor ? 'always' : 'never' }, audio: t.audio });
        const v = document.createElement('video');
        v.muted = true; v.srcObject = d;
        await withTimeout(v.play(), 4000, 'no picture arrived');
        for (let i = 0; i < 60 && !v.videoWidth; i++) await new Promise((r) => setTimeout(r, 50));
        if (!v.videoWidth) throw new Error('no picture arrived (is the window hidden or minimized?)');
        return { display: d, video: v, kind: t.kind, soundLost: wantSys && !t.audio, geom: prep && prep.geom };
      } catch (e) {
        errs.push(`${t.kind === 'window' ? 'Window capture' : t.kind === 'crop' ? 'Screen capture' : 'Capture'}${t.audio ? '' : ' without sound'}: ${(e && e.message) || e}`);
        try { d && d.getTracks().forEach((x) => x.stop()); } catch { /* none */ }
      }
    }
    throw new Error(errs.join('\n'));
  }

  async function begin(o = {}) {
    if (run) return;
    const isCinema = o.mode === 'cinema';
    const cd = typeof o.countdown === 'number' ? o.countdown : S.countdown;
    const wantSys = o.sys !== undefined ? o.sys : S.sys;
    const quality = o.quality || S.quality;
    let src = S.sourceId;
    if (isCinema) src = o.sourceId || cinema.id || '';
    else if (S.mode === 'region') src = S.display ? S.display.id : '';
    if (!src && !isCinema) return;
    const useMode = isCinema ? 'cinema' : S.mode;
    const wantDraw = S.drawing && useMode !== 'window';

    run = { elapsedBase: 0, startAt: 0, pausedAt: 0, cancelled: false, queue: Promise.resolve(), strokes: [], fadeMs: 0, state: 'countdown',
      elapsed() { return this.state === 'paused' ? this.pausedAt - this.startAt - this.elapsedBase : this.startAt ? Date.now() - this.startAt - this.elapsedBase : 0; } };
    const me = run;
    showPill(true);
    $('pill').classList.remove('paused');
    $('tag').textContent = `${LABEL[quality]} · ${S.fps} fps`;
    $('live').hidden = true; $('draw').hidden = true;
    push('countdown');
    for (let n = cd; n > 0; n--) {
      $('count').hidden = false; $('count').innerHTML = `${n}<small>Recording starts…</small>`;
      await new Promise((r) => setTimeout(r, 1000));
      if (me.cancelled) { cleanup(me); return; }
    }
    $('count').hidden = true; $('live').hidden = false;

    try {
      const pic = await getPicture({ mode: useMode }, src, wantSys, wantDraw);
      me.display = pic.display; me.video = pic.video;
      const video = pic.video;
      let sound = wantSys && !pic.soundLost;

      // where the picture comes from: the whole frame, a fixed area, or the Cinema window cut out of its screen (follows the window)
      let crop = null, dyn = false, dispW = 0, dispId = null;
      if (pic.kind === 'crop' && pic.geom) { dyn = true; dispW = pic.geom.display.w; dispId = pic.geom.display.id; me.rect = pic.geom; }
      else if (useMode === 'region' && S.region) { dispW = S.region.display.w; dispId = S.region.display.id; }
      else if (useMode === 'screen') { const sc = sources.screens.find((x) => x.id === src); dispW = sc ? sc.dip.w : 0; dispId = sc ? sc.displayId : null; }
      const k = dispW ? video.videoWidth / dispW : 1;
      if (useMode === 'region' && !isCinema && S.region) crop = { x: S.region.x * k, y: S.region.y * k, w: S.region.w * k, h: S.region.h * k };
      const srcW = dyn ? me.rect.w * k : crop ? crop.w : video.videoWidth;
      const srcH = dyn ? me.rect.h * k : crop ? crop.h : video.videoHeight;
      const [W, H] = outSize(srcW, srcH, quality);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      ctx.imageSmoothingQuality = 'high';
      const canDraw = wantDraw && dispId !== null && dispW > 0;

      const draw = () => {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw) return;
        let sx = 0, sy = 0, sw = vw, sh = vh;
        if (dyn) { const r = me.rect; sx = clamp(r.x * k, 0, vw - 2); sy = clamp(r.y * k, 0, vh - 2); sw = Math.max(2, Math.min(r.w * k, vw - sx)); sh = Math.max(2, Math.min(r.h * k, vh - sy)); }
        else if (crop) { sx = Math.min(crop.x, vw - 2); sy = Math.min(crop.y, vh - 2); sw = Math.min(crop.w, vw - sx); sh = Math.min(crop.h, vh - sy); }
        // if the window changes size while recording, the picture is re-fitted with black bars, so the video keeps one size
        const sc = Math.min(W / sw, H / sh), dw = sw * sc, dh = sh * sc, ox = (W - dw) / 2, oy = (H - dh) / 2;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(video, sx, sy, sw, sh, ox, oy, dw, dh);
        if (me.strokes.length) window.Strokes.paint(ctx, me.strokes, { mx: (x) => (x * k - sx) * sc + ox, my: (y) => (y * k - sy) * sc + oy, unit: k * sc, fadeMs: me.fadeMs });
      };
      draw();
      me.timer = setInterval(draw, Math.round(1000 / S.fps));
      if (dyn) me.rectTimer = setInterval(async () => { try { const g = await window.rec.cinemaRect(); if (g && !g.minimized && g.w > 4 && g.h > 4) me.rect = g; } catch { /* keep the last */ } }, 150);

      // sound: computer sound and microphone mixed into one track, each with its own level
      const tracks = [...canvas.captureStream(S.fps).getVideoTracks()];
      let micOk = false;
      me.ac = new AudioContext();
      const dest = me.ac.createMediaStreamDestination();
      let inputs = 0;
      if (sound && pic.display.getAudioTracks().length) {
        const g = me.ac.createGain(); g.gain.value = S.sysVol / 100;
        me.ac.createMediaStreamSource(new MediaStream(pic.display.getAudioTracks())).connect(g).connect(dest); inputs++;
      } else if (wantSys) sound = false;
      if (S.mic) {
        try {
          me.micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: S.micId ? { exact: S.micId } : undefined, echoCancellation: true, noiseSuppression: true } });
          const g = me.ac.createGain(); g.gain.value = S.micVol / 100;
          me.ac.createMediaStreamSource(me.micStream).connect(g).connect(dest); inputs++; micOk = true;
        } catch { /* record without the microphone */ }
      }
      if (inputs) tracks.push(...dest.stream.getAudioTracks());
      const missing = [];
      if (wantSys && !sound) missing.push('computer sound');
      if (S.mic && !micOk) missing.push('the microphone');
      me.warn = missing.length ? `Recorded without ${missing.join(' and ')}.` : '';

      const f = await window.rec.fileOpen();
      if (!f || !f.ok) throw new Error(f?.error || 'Could not create the file');
      const { mime, h264 } = pickMime();
      const mr = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: MBPS[quality][S.fps === 60 ? 1 : 0] * 1e6, audioBitsPerSecond: 192000 });
      me.mr = mr; me.h264 = h264; me.fps = S.fps; me.w = W; me.h = H;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) me.queue = me.queue.then(() => e.data.arrayBuffer()).then((b) => window.rec.chunk(b)); };
      mr.onstop = () => finish(me);
      // the thing being recorded went away (window closed, screen unplugged)
      pic.display.getVideoTracks()[0].addEventListener('ended', () => { if (run === me) stop(); });
      mr.start(1000);
      me.startAt = Date.now(); me.state = 'recording';
      me.tick = setInterval(() => { $('clock').textContent = fmt(me.elapsed()); push(me.state); }, 500);
      $('clock').textContent = '00:00';
      if (canDraw) { await window.rec.drawInit(dispId); me.hasDraw = true; $('draw').hidden = false; $('draw').classList.remove('on'); }
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
    if (run.state === 'stopping') return;
    if (run.state === 'paused') run.elapsedBase += Date.now() - run.pausedAt;
    run.durationMs = run.elapsed();
    run.state = 'stopping';
    clearInterval(run.timer); clearInterval(run.tick); clearInterval(run.rectTimer);
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
    const r = await window.rec.fileClose({ durationMs: dur, h264: me.h264, fps: me.fps, format: S.format, extras: S.extras, w: me.w, h: me.h });
    $('busy').hidden = true;
    run = null;
    if (r && r.file) {
      lastFile = r.file;
      $('lastName').textContent = r.file; $('last').hidden = false;
      const more = [];
      if (r.files && r.files.length > 1) more.push(`${r.files.length - 1} smaller cop${r.files.length > 2 ? 'ies' : 'y'} saved next to it.`);
      if (me.warn) more.push(me.warn);
      if (r.note) more.push(r.note);
      $('lastMore').textContent = more.join(' '); $('lastMore').hidden = !more.length;
    } else if (r && r.error) alertBox('Recording problem', r.error);
  }

  function cleanup(me, keepRun) {
    clearInterval(me.timer); clearInterval(me.tick); clearInterval(me.rectTimer);
    try { me.display?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    try { me.micStream?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    try { me.ac?.close(); } catch { /* gone */ }
    if (me.video) me.video.srcObject = null;
    if (me.hasDraw) { window.rec.drawClose(); me.hasDraw = false; }
    if (!keepRun) { run = null; window.rec.state({ state: 'idle', ms: 0 }); }
  }

  function alertBox(title, text) {
    const b = $('busy');
    b.hidden = false;
    b.innerHTML = `<b style="font-size:16px">${esc(title)}</b><p style="max-width:400px;text-align:center;color:var(--mute);margin:0;white-space:pre-wrap;user-select:text">${esc(text)}</p><button class="rec" style="width:220px;padding:12px" id="ok"><span>OK</span></button>`;
    $('ok').onclick = () => { b.hidden = true; b.innerHTML = '<div class="ring"></div><b id="busyText"></b><div class="meter"><i id="busyBar"></i></div>'; };
  }

  // ---------- events ----------
  $('modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); });
  const pickCard = (e) => { const b = e.target.closest('.card'); if (!b) return; S.sourceId = b.dataset.id; drawSources(); summary(); ready(); };
  $('screens').addEventListener('click', pickCard);
  $('windows').addEventListener('click', pickCard);
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
  $('format').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.format = b.dataset.fm; mark('format', 'fm', S.format); save({ format: S.format }); summary(); });
  $('extras').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = Number(b.dataset.x);
    S.extras = S.extras.includes(v) ? S.extras.filter((x) => x !== v) : [...S.extras, v];
    paintExtras(); save({ extras: S.extras });
  });
  $('soundMode').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = b.dataset.s;
    S.sys = v === 'sys' || v === 'both'; S.mic = v === 'mic' || v === 'both';
    paintSound(); save({ sys: S.sys, mic: S.mic });
    if (S.mic) { await loadMics(); save({ micId: S.micId, mic: S.mic }); }
  });
  $('sysVol').oninput = (e) => { S.sysVol = +e.target.value; $('sysVolO').textContent = S.sysVol + '%'; };
  $('sysVol').onchange = () => save({ sysVol: S.sysVol });
  $('micVol').oninput = (e) => { S.micVol = +e.target.value; $('micVolO').textContent = S.micVol + '%'; };
  $('micVol').onchange = () => save({ micVol: S.micVol });
  $('micSel').onchange = (e) => { S.micId = e.target.value; save({ micId: S.micId }); };
  $('cursor').onchange = (e) => { S.cursor = e.target.checked; save({ cursor: S.cursor }); };
  $('drawing').onchange = (e) => { S.drawing = e.target.checked; save({ drawing: S.drawing }); };
  $('standby').onchange = (e) => { S.standby = e.target.checked; save({ standby: S.standby }); };
  $('chdir').onclick = async () => { const d = await window.rec.chooseDir(); if (d) { S.dir = d; $('dir').textContent = d; } };
  $('openDir').onclick = () => window.rec.openFolder();
  $('lastShow').onclick = () => lastFile && window.rec.reveal(lastFile);
  $('lastOpen').onclick = () => lastFile && window.rec.openFile(lastFile);
  $('close').onclick = () => window.rec.hide();
  $('min').onclick = () => window.rec.minimize();
  $('start').onclick = () => begin({ mode: S.mode === 'cinema' ? 'cinema' : undefined });
  $('pause').onclick = togglePause;
  $('stop').onclick = stop;
  $('draw').onclick = () => window.rec.drawToggle();
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !run) window.rec.hide(); });

  window.rec.onCmd((c) => {
    if (c.cmd === 'start') { S.quality = String(c.quality || S.quality); begin({ mode: c.mode, sourceId: c.sourceId, quality: S.quality, countdown: c.countdown, sys: c.sys }); }
    else if (c.cmd === 'stop') stop();
    else if (c.cmd === 'toggle-pause') togglePause();
    else if (c.cmd === 'opened' && !run) { loadCfg(); }
    else if (c.cmd === 'strokes' && run) { run.strokes = c.strokes || []; run.fadeMs = c.fadeMs || 0; }
    else if (c.cmd === 'draw-state') $('draw').classList.toggle('on', !!c.on);
  });
  window.rec.onFinalize((d) => { $('busyBar').style.width = d.pct + '%'; $('busyText').textContent = d.pct ? `Making your files… ${d.pct}%` : 'Making your files…'; });
  setInterval(() => { if (!run && !$('studio').hidden && S.mode === 'cinema') updateCinema().then(() => { summary(); ready(); }); }, 1500);

  loadCfg();
})();
