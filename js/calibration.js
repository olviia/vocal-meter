// Two-device calibration: find sung notes on each device, pair them up, and learn how to
// convert one device's readings into the other's. Pure functions, tested in Node.
import { NB, median, hzToCents, metricsFromBands } from './dsp.js';

export const CAL_STEPS = (() => {
  const vowels = ['ah', 'ee', 'oo', 'eh'];
  const levels = ['soft', 'medium', 'loud'];
  const out = [];
  for (const v of vowels) for (const l of levels) out.push({ vowel: v, level: l });
  return out;
})();

// Voiced runs (gaps up to maxGap allowed) lasting at least minDur seconds.
// Each note is summarised from its middle 60% so attacks and releases don't count.
export function detectSegments(frames, { minDur = 1.0, maxGap = 0.2 } = {}) {
  const segs = [];
  let cur = null;
  for (const f of frames) {
    if (f.voiced) {
      if (cur && f.t - cur.last <= maxGap) { cur.frames.push(f); cur.last = f.t; }
      else { if (cur) segs.push(cur); cur = { frames: [f], last: f.t }; }
    }
  }
  if (cur) segs.push(cur);
  return segs
    .filter(s => s.last - s.frames[0].t >= minDur)
    .map(s => {
      const t0 = s.frames[0].t, t1 = s.last, d = t1 - t0;
      const core = s.frames.filter(f => f.t >= t0 + 0.2 * d && f.t <= t1 - 0.2 * d);
      const bands = new Array(NB);
      for (let b = 0; b < NB; b++) bands[b] = median(core.map(f => f.bandDb[b]));
      return {
        t0, t1,
        level: median(core.map(f => f.levelDb)),
        cents: median(core.map(f => hzToCents(f.f0))),
        bands,
      };
    });
}

// Pair notes from two recordings of the same performance. Device clocks differ by an unknown
// constant, so try every pair as the anchor and keep the offset that matches the most notes.
export function alignSegments(src, dst, { tolT = 0.5, tolCents = 80 } = {}) {
  let best = [];
  for (const a of src) {
    for (const b of dst) {
      const shift = b.t0 - a.t0;
      if (Math.abs(a.cents - b.cents) > tolCents) continue;
      const pairs = [];
      const used = new Set();
      for (const s of src) {
        let match = -1, err = Infinity;
        dst.forEach((d, j) => {
          if (used.has(j)) return;
          const e = Math.abs(d.t0 - s.t0 - shift);
          if (e < tolT && Math.abs(d.cents - s.cents) <= tolCents && e < err) { err = e; match = j; }
        });
        if (match >= 0) { used.add(match); pairs.push([s, dst[match]]); }
      }
      if (pairs.length > best.length) best = pairs;
    }
  }
  return best;
}

function linfit(x, y) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const a = sxx > 0 ? sxy / sxx : 1;
  return { a, b: my - a * mx };
}
const rms = arr => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / Math.max(1, arr.length));

// Build the conversion src → dst and judge how trustworthy it is.
export function fitCalibration(pairs) {
  const n = pairs.length;
  if (n < 4) return { ok: false, reason: `Only ${n} notes matched between the devices (need at least 4).` };

  const xs = pairs.map(([s]) => s.level), ys = pairs.map(([, d]) => d.level);
  const range = Math.max(...xs) - Math.min(...xs);
  // A slope is only meaningful if soft and loud notes are far enough apart.
  let level;
  if (range >= 8) level = linfit(xs, ys);
  else level = { a: 1, b: median(ys.map((y, i) => y - xs[i])) };
  const levelResid = pairs.map(([s, d]) => d.level - (level.a * s.level + level.b));

  const bandOffset = new Array(NB);
  for (let b = 0; b < NB; b++) bandOffset[b] = median(pairs.map(([s, d]) => d.bands[b] - s.bands[b]));

  const ringErr = [], brightErr = [];
  for (const [s, d] of pairs) {
    const pred = metricsFromBands(s.bands.map((v, b) => v + bandOffset[b]));
    const real = metricsFromBands(d.bands);
    ringErr.push(pred.ring - real.ring);
    brightErr.push(pred.bright - real.bright);
  }

  const stats = {
    pairs: n,
    slope: level.a,
    levelErr: rms(levelResid),
    ringErr: rms(ringErr),
    brightErr: rms(brightErr),
    rangeLo: Math.min(...xs),
    rangeHi: Math.max(...xs),
    slopeTested: range >= 8,
  };

  const problems = [];
  if (!stats.slopeTested) problems.push('soft and loud notes were too close in volume to test whether the mics agree across volumes — redo with a bigger contrast');
  if (Math.abs(stats.slope - 1) > 0.3) problems.push(`loudness changes don't match between devices (slope ${stats.slope.toFixed(2)}), which usually means one mic is auto-adjusting its gain`);
  if (stats.levelErr > 3) problems.push(`loudness conversion is off by about ±${stats.levelErr.toFixed(1)} dB note to note`);
  if (stats.ringErr > 3) problems.push(`ring conversion is off by about ±${stats.ringErr.toFixed(1)} dB`);
  if (stats.brightErr > 3) problems.push(`brightness conversion is off by about ±${stats.brightErr.toFixed(1)} dB`);

  let verdict;
  if (problems.length) verdict = 'poor';
  else if (Math.abs(stats.slope - 1) <= 0.15 && stats.levelErr <= 1.5 && stats.ringErr <= 1.5 && stats.brightErr <= 1.5) verdict = 'good';
  else verdict = 'fair';

  return { ok: true, level, bandOffset, stats, verdict, problems };
}

// Convert a reference measured on the source device into this device's numbers.
export function applyCalibration(cal, ref) {
  const bands = ref.bands.map((v, b) => v + cal.bandOffset[b]);
  return {
    ...ref,
    level: cal.level.a * ref.level + cal.level.b,
    bands,
    ...metricsFromBands(bands),
    converted: true,
    outOfRange: ref.level < cal.stats.rangeLo - 3 || ref.level > cal.stats.rangeHi + 3,
  };
}
