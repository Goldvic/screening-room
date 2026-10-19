import { spawn } from 'node:child_process';

/** Intro detection: two episodes of the same show share the same theme music. We fingerprint the first minutes of each
 *  (spectral hash per 128 ms frame) and look for the longest stretch where the two fingerprints line up. */
const RATE = 8000, FRAME = 2048, HOP = 1024, BANDS = 32;
const HOP_S = HOP / RATE;

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

export function fingerprint(pcm: Int16Array): Int32Array {
  const frames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP));
  const lo = 300 / (RATE / FRAME), hi = 3000 / (RATE / FRAME);
  const edges = Array.from({ length: BANDS + 2 }, (_, i) => Math.round(lo * Math.pow(hi / lo, i / (BANDS + 1))));
  const win = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const out = new Int32Array(frames);
  let prev = new Float64Array(BANDS + 1);
  for (let t = 0; t < frames; t++) {
    for (let i = 0; i < FRAME; i++) { re[i] = pcm[t * HOP + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const e = new Float64Array(BANDS + 1);
    for (let b = 0; b <= BANDS; b++) { let s = 0; for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) s += re[k] * re[k] + im[k] * im[k]; e[b] = s; }
    let h = 0;
    for (let b = 0; b < BANDS; b++) if (e[b] - e[b + 1] - (prev[b] - prev[b + 1]) > 0) h |= 1 << b;
    out[t] = h; prev = e;
  }
  return out;
}

const pop = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

/** Longest matching stretch between two fingerprints, as [start,end] seconds in each. */
export function matchIntro(a: Int32Array, b: Int32Array, minSec = 15, maxLagSec = 240): { a: [number, number]; b: [number, number] } | null {
  const maxLag = Math.floor(maxLagSec / HOP_S);
  let best = { len: 0, ai: 0, bi: 0 };
  for (let d = -maxLag; d <= maxLag; d++) {
    let run = 0, start = 0, gap = 0, lastGood = 0;
    for (let i = Math.max(0, -d); i < a.length && i + d < b.length; i++) {
      if (pop(a[i] ^ b[i + d]) <= 9) { if (run === 0) start = i; run++; lastGood = i; gap = 0; }
      else if (run > 0 && ++gap > 6) { const len = lastGood - start + 1; if (len > best.len) best = { len, ai: start, bi: start + d }; run = 0; gap = 0; }
    }
    if (run > 0) { const len = lastGood - start + 1; if (len > best.len) best = { len, ai: start, bi: start + d }; }
  }
  const sec = best.len * HOP_S;
  if (sec < minSec || sec > 300) return null;
  const f = (i: number) => Math.round(i * HOP_S * 10) / 10;
  return { a: [f(best.ai), f(best.ai + best.len)], b: [f(best.bi), f(best.bi + best.len)] };
}

/** Decode the first `seconds` of audio (mono, 8 kHz) from a file path or URL. */
export function pcm(ffmpeg: string, input: string, seconds: number): Promise<Int16Array> {
  return new Promise((ok, no) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-t', String(seconds), '-i', input, '-vn', '-sn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', no);
    p.on('close', () => { const b = Buffer.concat(chunks); ok(new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 2)))); });
  });
}