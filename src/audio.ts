// Web Audio chain used by the player:
//
//  video -> [5.1 -> stereo with louder dialogue] -> 10-band EQ -> dialogue boost -> [night compressor]
//        -> [mono] -> volume gain (up to 5x) -> LIMITER -> soft clipper -> speakers
//
// The limiter and soft clipper at the end are what keep very high volume (up to 500%) clear:
// instead of harsh digital clipping, loud peaks are smoothly squeezed.

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
export const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Movie: [3, 3, 1, 0, -1, 0, 1, 2, 3, 2],
  Dialogue: [-5, -4, -2, 0, 1, 3, 4, 3, 1, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
  'Laptop speakers': [-8, -6, 1, 4, 4, 2, 3, 3, 2, 1],
  Headphones: [3, 2, 0, -1, -1, 0, 1, 2, 2, 1],
};
export const EQ_FLAT = EQ_PRESETS.Flat;

export type FxState = { gain: number; eq: number[]; dialogue: boolean; night: boolean; mono: boolean; channels: number };
export const isNeutral = (f: FxState) =>
  f.gain <= 1.001 && !f.dialogue && !f.night && !f.mono && f.eq.every((v) => v === 0);

const softClip = (() => {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x), k = 0.8;
    c[i] = a < k ? x : Math.sign(x) * (k + (1 - k) * Math.tanh((a - k) / (1 - k)));
  }
  return c;
})();

export class AudioRig {
  readonly ctx = new AudioContext();
  private el: HTMLMediaElement | null = null;
  private src: MediaElementAudioSourceNode | null = null;
  private eq = EQ_FREQS.map((f) => { const b = this.ctx.createBiquadFilter(); b.type = 'peaking'; b.frequency.value = f; b.Q.value = 1.1; return b; });
  private dlgBody = this.ctx.createBiquadFilter();
  private dlgRumble = this.ctx.createBiquadFilter();
  private night = this.ctx.createDynamicsCompressor();
  private mono = this.ctx.createGain();
  private gain = this.ctx.createGain();
  private limiter = this.ctx.createDynamicsCompressor();
  private clip = this.ctx.createWaveShaper();
  // 5.1 -> stereo
  private split = this.ctx.createChannelSplitter(6);
  private merge = this.ctx.createChannelMerger(2);
  private taps = Array.from({ length: 6 }, () => this.ctx.createGain());
  private lastKey = '';

  constructor() {
    this.dlgBody.type = 'peaking'; this.dlgBody.frequency.value = 2400; this.dlgBody.Q.value = 0.9;
    this.dlgRumble.type = 'lowshelf'; this.dlgRumble.frequency.value = 160;
    this.night.threshold.value = -45; this.night.knee.value = 30; this.night.ratio.value = 10; this.night.attack.value = 0.003; this.night.release.value = 0.25;
    this.mono.channelCount = 1; this.mono.channelCountMode = 'explicit'; this.mono.channelInterpretation = 'speakers';
    this.limiter.threshold.value = -6; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.1;
    this.clip.curve = softClip; this.clip.oversample = '4x';
    // taps: L, R, C, LFE, Ls, Rs
    this.split.connect(this.merge, 0, 0); this.split.connect(this.merge, 1, 1);
    this.taps.forEach((t, i) => { if (i >= 2) { this.split.connect(t, i); t.connect(this.merge, 0, i === 5 ? 1 : 0); if (i === 2 || i === 3) t.connect(this.merge, 0, 1); } });
    this.clip.connect(this.ctx.destination);
    this.limiter.connect(this.clip);
    this.gain.connect(this.limiter);
  }

  attach(el: HTMLMediaElement) {
    if (this.el === el) return;
    try { this.src?.disconnect(); } catch { /* old element is gone */ }
    this.src = this.ctx.createMediaElementSource(el);
    this.el = el;
    this.lastKey = '';
  }

  apply(f: FxState) {
    if (!this.src) return;
    const matrix = f.channels >= 6;
    // wiring only changes when these flags change; numbers below are updated live
    const key = `${matrix}|${f.night}|${f.mono}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      for (const n of [this.src, this.merge, ...this.eq, this.dlgBody, this.dlgRumble, this.night, this.mono]) { try { n.disconnect(); } catch { /* not connected yet */ } }
      let tail: AudioNode;
      if (matrix) { this.src.connect(this.split); tail = this.merge; } else tail = this.src;
      for (const n of [...this.eq, this.dlgBody, this.dlgRumble]) { tail.connect(n); tail = n; }
      if (f.night) { tail.connect(this.night); tail = this.night; }
      if (f.mono) { tail.connect(this.mono); tail = this.mono; }
      tail.connect(this.gain);
    }
    const t = this.ctx.currentTime;
    this.eq.forEach((b, i) => b.gain.setTargetAtTime(f.eq[i] ?? 0, t, 0.02));
    this.dlgBody.gain.setTargetAtTime(f.dialogue ? 5 : 0, t, 0.02);
    this.dlgRumble.gain.setTargetAtTime(f.dialogue ? -4 : 0, t, 0.02);
    // taps: C 0.707, LFE 0.35, Ls/Rs 0.6 normally; dialogue mode lifts the centre (where speech lives) and lowers the rear
    const centre = f.dialogue ? 1.45 : 0.707, rear = f.dialogue ? 0.45 : 0.6;
    [1, 1, centre, 0.35, rear, rear].forEach((v, i) => { if (i >= 2) this.taps[i].gain.setTargetAtTime(v, t, 0.02); });
    this.gain.gain.setTargetAtTime(f.gain * (f.night ? 1.7 : 1), t, 0.02);
    this.ctx.resume().catch(() => {});
  }

  async setSink(id: string) { try { await (this.ctx as any).setSinkId?.(id === 'default' ? '' : id); } catch { /* not supported */ } }
  dispose() { this.ctx.close().catch(() => {}); }
}