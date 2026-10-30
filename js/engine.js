// Microphone → analysis frames. One shared instance for the whole app.
import { FrameAnalyzer } from './dsp.js';

export class Engine extends EventTarget {
  constructor() {
    super();
    this.running = false;
    this.frames = [];      // recent frames (last ~40 s)
    this.recorders = new Set(); // arrays that want every frame (calibration, tests)
    this.settings = {};
    this.noise = null;
  }

  // True when audio is flowing; false while the browser waits for a first tap.
  get listening() { return this.running && this.ctx && this.ctx.state === 'running'; }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

  setNoise(profile) {
    this.noise = profile;
    if (this.analyzer) this.analyzer.setNoise(profile);
  }

  async start() {
    if (this.running || this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone access. Use Chrome.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    this.settings = (track.getSettings && track.getSettings()) || {};
    this.trackLabel = track.label || '';
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    ctx.onstatechange = () => this.dispatchEvent(new Event('state'));
    if (ctx.state === 'suspended') ctx.resume().catch(() => {}); // may need a tap first (autoplay rules)
    await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { blockSize: 1024 },
    });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);

    this.analyzer = new FrameAnalyzer(ctx.sampleRate);
    this.analyzer.setNoise(this.noise);
    this.ring = new Float32Array(this.analyzer.fftSize);
    this.filled = 0;
    node.port.onmessage = e => this.onBlock(e.data);
    track.addEventListener('ended', () => this.stop('The microphone was taken by another app or disconnected.'));
    Object.assign(this, { stream, ctx, node, running: true, sampleRate: ctx.sampleRate });
    this.wake();
    this.dispatchEvent(new Event('state'));
  }

  onBlock({ samples, peak }) {
    const r = this.ring, n = samples.length;
    r.copyWithin(0, n);
    r.set(samples, r.length - n);
    this.filled += n;
    if (this.filled < r.length) return;
    const f = this.analyzer.analyze(r, Date.now() / 1000, peak);
    this.frames.push(f);
    const cutoff = f.t - 40;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
    for (const rec of this.recorders) rec.push(f);
    this.latest = f;
  }

  // Frames from the last `sec` seconds.
  recent(sec) {
    const fr = this.frames;
    if (!fr.length) return [];
    const t = fr[fr.length - 1].t - sec;
    let i = fr.length - 1;
    while (i > 0 && fr[i - 1].t >= t) i--;
    return fr.slice(i);
  }

  async wake() {
    try { this.lock = await navigator.wakeLock?.request('screen'); } catch (e) { /* not critical */ }
  }

  stop(reason) {
    if (!this.running) return;
    this.running = false;
    try { this.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { this.ctx.close(); } catch (e) {}
    try { this.lock?.release(); } catch (e) {}
    this.frames = [];
    this.latest = null;
    this.stopReason = reason || '';
    this.dispatchEvent(new Event('state'));
  }
}

export const engine = new Engine();

// Collect every frame for `seconds`, calling onTick(elapsed) along the way.
export function recordFor(seconds, onTick) {
  return new Promise(resolve => {
    const rec = [];
    engine.recorders.add(rec);
    const start = performance.now();
    const tick = () => {
      const el = (performance.now() - start) / 1000;
      onTick?.(el, rec);
      if (el >= seconds || !engine.running) { engine.recorders.delete(rec); resolve(rec); }
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
