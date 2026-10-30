// Pure signal processing. No DOM, so it runs in the browser and in Node tests.

// 1/3-octave bands (ANSI centres). Band edges are centre × 2^(±1/6).
export const BAND_CENTERS = [63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000];
export const NB = BAND_CENTERS.length;
const EDGE = Math.pow(2, 1 / 6);
const bandsBetween = (lo, hi) =>
  BAND_CENTERS.map((c, i) => [c, i]).filter(([c]) => c >= lo && c <= hi).map(([, i]) => i);

// Resonance metrics, both are energy ratios in dB, so they don't depend on overall loudness.
//  ring   ≈ singer's-formant energy (≈1.8–3.5 kHz) vs the body of the voice (≈70 Hz–1.8 kHz)
//  bright ≈ alpha ratio: energy above ~1 kHz vs below ~1 kHz
export const METRIC_BANDS = {
  ring: { hi: bandsBetween(2000, 3150), lo: bandsBetween(80, 1600) },
  bright: { hi: bandsBetween(1000, 5000), lo: bandsBetween(63, 800) },
};

export const toDb = p => 10 * Math.log10(p > 1e-20 ? p : 1e-20);
export const fromDb = d => Math.pow(10, d / 10);

export function bandSumDb(bandDb, idxs) {
  let s = 0;
  for (const i of idxs) s += fromDb(bandDb[i]);
  return toDb(s);
}

export function metricsFromBands(bandDb) {
  const m = METRIC_BANDS;
  return {
    ring: bandSumDb(bandDb, m.ring.hi) - bandSumDb(bandDb, m.ring.lo),
    bright: bandSumDb(bandDb, m.bright.hi) - bandSumDb(bandDb, m.bright.lo),
  };
}

// ---------- pitch helpers ----------
export const hzToCents = f => 1200 * Math.log2(f / 440) + 6900; // MIDI note × 100
export const centsToHz = c => 440 * Math.pow(2, (c - 6900) / 1200);
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export function noteName(cents) {
  const midi = Math.round(cents / 100);
  return { name: NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1), off: Math.round(cents - midi * 100) };
}

// ---------- statistics ----------
export function median(arr) {
  const n = arr.length;
  if (!n) return NaN;
  const s = Float64Array.from(arr).sort();
  return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}
export function quantile(arr, q) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// Median summary of voiced frames: level, pitch, per-band levels and the derived metrics.
export function summarize(frames) {
  const v = frames.filter(f => f.voiced);
  if (!v.length) return null;
  const bands = new Array(NB);
  for (let b = 0; b < NB; b++) bands[b] = median(v.map(f => f.bandDb[b]));
  return {
    n: v.length,
    level: median(v.map(f => f.levelDb)),
    cents: median(v.map(f => hzToCents(f.f0))),
    bands,
    ...metricsFromBands(bands),
  };
}

// ---------- FFT (radix-2, in place) ----------
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >>> b) & 1);
      this.rev[i] = r;
    }
  }
  transform(re, im) {
    const { n, cos, sin, rev } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * cos[k] + im[l] * sin[k];
          const ti = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tr; im[l] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
  }
}

// ---------- frame analysis ----------
// One analysis per hop: level, pitch (YIN), 1/3-octave band levels with optional noise subtraction.
export class FrameAnalyzer {
  constructor(sampleRate, { fftSize = 4096, pitchWin = 1024, fmin = 70, fmax = 1400 } = {}) {
    this.sr = sampleRate;
    this.fftSize = fftSize;
    this.fft = new FFT(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.win = new Float64Array(fftSize);
    let wsum = 0;
    for (let i = 0; i < fftSize; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
      wsum += this.win[i] * this.win[i];
    }
    this.winNorm = 1 / (wsum * fftSize); // power spectrum scaled so a band sum ≈ mean-square in that band
    this.bandBins = BAND_CENTERS.map(c => {
      const lo = Math.ceil((c / EDGE) * fftSize / sampleRate);
      const hi = Math.min(fftSize / 2 - 1, Math.floor((c * EDGE) * fftSize / sampleRate));
      return [lo, Math.max(lo, hi)];
    });
    this.pitchWin = pitchWin;
    this.tauMin = Math.max(2, Math.floor(sampleRate / fmax));
    this.tauMax = Math.ceil(sampleRate / fmin);
    this.d = new Float64Array(this.tauMax + 2);
    this.noisePow = null;   // per-band noise power to subtract (from the noise check)
    this.noiseLevelDb = -80; // voicing needs to be clearly above this
  }

  setNoise(profile) {
    this.noisePow = profile ? Float64Array.from(profile.bandPow) : null;
    this.noiseLevelDb = profile ? profile.levelDb : -80;
  }

  // YIN pitch estimate on buf[start .. start+pitchWin+tauMax)
  yin(buf, start) {
    const { d, tauMin, tauMax, pitchWin: W } = this;
    d[0] = 1;
    let run = 0;
    let best = -1, bestVal = Infinity;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const x = buf[start + j] - buf[start + j + tau];
        s += x * x;
      }
      run += s;
      d[tau] = run > 0 ? (s * tau) / run : 1;
    }
    // first dip under threshold, then follow it to its local minimum
    const TH = 0.15;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < TH) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau; bestVal = d[tau];
        break;
      }
    }
    if (best < 0) {
      for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < bestVal) { bestVal = d[tau]; best = tau; }
    }
    if (best <= tauMin || best >= tauMax) return { f0: 0, aper: 1 };
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
    return { f0: this.sr / (best + Math.max(-1, Math.min(1, shift))), aper: bestVal };
  }

  // buf: newest samples at the end, length >= fftSize
  analyze(buf, t, peak = 0) {
    const N = this.fftSize, L = buf.length, off = L - N;

    let ms = 0;
    const lvStart = L - 2048;
    for (let i = lvStart; i < L; i++) ms += buf[i] * buf[i];
    const levelDb = toDb(ms / 2048);

    const need = this.pitchWin + this.tauMax + 1;
    const { f0, aper } = this.yin(buf, L - need);

    const { re, im, win } = this;
    for (let i = 0; i < N; i++) { re[i] = buf[off + i] * win[i]; im[i] = 0; }
    this.fft.transform(re, im);
    const bandPow = new Float64Array(NB);
    const bandDb = new Float32Array(NB);
    for (let b = 0; b < NB; b++) {
      const [lo, hi] = this.bandBins[b];
      let p = 0;
      for (let k = lo; k <= hi; k++) p += re[k] * re[k] + im[k] * im[k];
      p *= 2 * this.winNorm;
      bandPow[b] = p;
      const clean = this.noisePow ? Math.max(p - this.noisePow[b], p * 0.03) : p;
      bandDb[b] = toDb(clean);
    }

    const voiced = f0 > 0 && aper < 0.2 && levelDb > Math.max(-75, this.noiseLevelDb + 10);
    return { t, levelDb, peak, f0, aper, voiced, bandPow, bandDb };
  }
}
