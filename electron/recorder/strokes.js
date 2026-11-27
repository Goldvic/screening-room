// Draws the annotation strokes. Used twice: by the on-screen drawing layer (so you see what you draw)
// and by the recorder (so the drawing is burned into the video at the right place and size).
// A stroke: { tool: 'pen'|'hl'|'line'|'arrow'|'rect'|'oval', color, size, pts: [[x, y], ...], t }
// Points are in screen units (DIP) of the display being recorded; t is when the stroke was finished (0 while drawing).
(function () {
  const FADE_OUT = 700;

  function alphaOf(s, fadeMs, now) {
    if (!fadeMs || !s.t) return 1;
    const age = now - s.t - fadeMs;
    if (age <= 0) return 1;
    return age >= FADE_OUT ? 0 : 1 - age / FADE_OUT;
  }

  // o: { mx(x), my(y): map a point to canvas pixels, unit: canvas pixels per screen unit, fadeMs }
  function paint(ctx, list, o) {
    const now = Date.now();
    for (const s of list) {
      const a = alphaOf(s, o.fadeMs, now);
      if (a <= 0 || !s.pts || !s.pts.length) continue;
      const P = s.pts.map((p) => [o.mx(p[0]), o.my(p[1])]);
      const w = Math.max(1, s.size * o.unit * (s.tool === 'hl' ? 3 : 1));
      ctx.save();
      ctx.globalAlpha = a * (s.tool === 'hl' ? 0.38 : 1);
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
      ctx.lineWidth = w; ctx.lineCap = s.tool === 'hl' ? 'butt' : 'round'; ctx.lineJoin = 'round';
      const A = P[0], B = P[P.length - 1];
      ctx.beginPath();
      if (s.tool === 'pen' || s.tool === 'hl') {
        if (P.length === 1) { ctx.arc(A[0], A[1], w / 2, 0, Math.PI * 2); ctx.fill(); }
        else {
          ctx.moveTo(P[0][0], P[0][1]);
          for (let i = 1; i < P.length - 1; i++) { const mxp = (P[i][0] + P[i + 1][0]) / 2, myp = (P[i][1] + P[i + 1][1]) / 2; ctx.quadraticCurveTo(P[i][0], P[i][1], mxp, myp); }
          ctx.lineTo(B[0], B[1]); ctx.stroke();
        }
      } else if (s.tool === 'line') { ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); }
      else if (s.tool === 'arrow') {
        const ang = Math.atan2(B[1] - A[1], B[0] - A[0]), hl = Math.max(14 * o.unit, w * 3.4);
        ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(B[0], B[1]);
        ctx.lineTo(B[0] - hl * Math.cos(ang - 0.45), B[1] - hl * Math.sin(ang - 0.45));
        ctx.moveTo(B[0], B[1]);
        ctx.lineTo(B[0] - hl * Math.cos(ang + 0.45), B[1] - hl * Math.sin(ang + 0.45)); ctx.stroke();
      } else if (s.tool === 'rect') { ctx.strokeRect(Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.abs(B[0] - A[0]), Math.abs(B[1] - A[1])); }
      else if (s.tool === 'oval') {
        ctx.ellipse((A[0] + B[0]) / 2, (A[1] + B[1]) / 2, Math.max(1, Math.abs(B[0] - A[0]) / 2), Math.max(1, Math.abs(B[1] - A[1]) / 2), 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Is the point (x, y) on or inside this stroke (for the eraser)?
  function hit(s, x, y, r) {
    const P = s.pts; if (!P || !P.length) return false;
    const seg = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)) : 0;
      return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) <= r + s.size;
    };
    if (s.tool === 'pen' || s.tool === 'hl') { if (P.length === 1) return Math.hypot(x - P[0][0], y - P[0][1]) <= r + s.size; for (let i = 1; i < P.length; i++) if (seg(P[i - 1], P[i])) return true; return false; }
    if (s.tool === 'line' || s.tool === 'arrow') return seg(P[0], P[P.length - 1]);
    const A = P[0], B = P[P.length - 1];
    return x >= Math.min(A[0], B[0]) - r && x <= Math.max(A[0], B[0]) + r && y >= Math.min(A[1], B[1]) - r && y <= Math.max(A[1], B[1]) + r;
  }

  window.Strokes = { paint, hit, FADE_OUT };
})();
