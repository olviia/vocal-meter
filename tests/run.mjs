// Node tests for the pure modules: node tests/run.mjs
import { FrameAnalyzer, FFT, summarize, hzToCents, metricsFromBands, NB, BAND_CENTERS } from '../js/dsp.js';
import { detectSegments, alignSegments, fitCalibration, applyCalibration, toReferenceScale } from '../js/calibration.js';
import { segToWire, segFromWire, defaultState } from '../js/store.js';
import { seal, unseal, linkTopic, newCode, normalizeCode } from '../js/link.js';
import { encodeQR, totalCodewords, maxBytes } from '../js/qr.js';
import { writeFileSync } from 'node:fs';

let failed = 0;
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`);
  if (!cond) failed++;
};
const SR = 48000;

// Harmonic "voice": formant envelope + optional singer's formant peak at 2.8 kHz.
function voice(f0, seconds, { amp = 0.3, ringGain = 0, seed = 1 } = {}) {
  const n = Math.round(seconds * SR), out = new Float32Array(n);
  const formant = (f, fc, bw, g) => g * Math.exp(-0.5 * ((f - fc) / bw) ** 2);
  const harmonics = [];
  for (let k = 1; k * f0 < 9000; k++) {
    const f = k * f0;
    const env = 0.15 + formant(f, 700, 150, 1) + formant(f, 1200, 200, 0.6) + formant(f, 2800, 350, ringGain);
    harmonics.push([f, env / Math.pow(k, 0.8), (k * 2.39996 * seed) % (2 * Math.PI)]);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const [f, a, ph] of harmonics) s += a * Math.sin((2 * Math.PI * f * i) / SR + ph);
    out[i] = s; peak = Math.max(peak, Math.abs(s));
  }
  for (let i = 0; i < n; i++) out[i] *= amp / peak;
  return out;
}
function analyzeSignal(sig, an = new FrameAnalyzer(SR), t0 = 0) {
  const frames = [], buf = new Float32Array(an.fftSize);
  for (let pos = 0; pos + 1024 <= sig.length; pos += 1024) {
    buf.copyWithin(0, 1024); buf.set(sig.subarray(pos, pos + 1024), buf.length - 1024);
    if (pos + 1024 >= an.fftSize) frames.push(an.analyze(buf, t0 + (pos + 1024) / SR));
  }
  return frames;
}

// ---- FFT: Parseval
{
  const n = 1024, f = new FFT(n), re = new Float64Array(n), im = new Float64Array(n);
  let e = 0;
  for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.3) + 0.2 * Math.cos(i * 1.7); e += re[i] ** 2; }
  f.transform(re, im);
  let ef = 0;
  for (let i = 0; i < n; i++) ef += re[i] ** 2 + im[i] ** 2;
  check('FFT Parseval', Math.abs(ef / n - e) / e < 1e-9);
}

// ---- level and band scaling with a 1 kHz sine, amplitude 0.5
{
  const sig = new Float32Array(SR);
  for (let i = 0; i < SR; i++) sig[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  const fr = analyzeSignal(sig).slice(-5);
  const expect = 20 * Math.log10(0.5 / Math.SQRT2);
  check('level of sine', Math.abs(fr[4].levelDb - expect) < 0.2, `${fr[4].levelDb.toFixed(2)} vs ${expect.toFixed(2)}`);
  const b1k = BAND_CENTERS.indexOf(1000);
  check('1 kHz band holds the sine power', Math.abs(fr[4].bandDb[b1k] - expect) < 0.5, fr[4].bandDb[b1k].toFixed(2));
}

// ---- pitch accuracy across the singing range
for (const f0 of [98, 147, 220, 330, 440, 660, 880, 1046]) {
  const fr = analyzeSignal(voice(f0, 0.6)).slice(-10);
  const s = summarize(fr);
  const err = s ? s.cents - hzToCents(f0) : NaN;
  check(`pitch ${f0} Hz`, s && Math.abs(err) < 5 && s.n >= 8, s ? `${err.toFixed(1)} cents, ${s.n}/10 voiced` : 'unvoiced');
}

// ---- metrics respond to the singer's formant, and not to loudness
{
  const plain = summarize(analyzeSignal(voice(220, 0.6, { ringGain: 0 })).slice(-10));
  const ringy = summarize(analyzeSignal(voice(220, 0.6, { ringGain: 1.2 })).slice(-10));
  const quiet = summarize(analyzeSignal(voice(220, 0.6, { ringGain: 1.2, amp: 0.03 })).slice(-10));
  check('ring rises with singer\'s formant', ringy.ring - plain.ring > 6, `${plain.ring.toFixed(1)} → ${ringy.ring.toFixed(1)}`);
  check('ring independent of loudness', Math.abs(ringy.ring - quiet.ring) < 0.3, `${ringy.ring.toFixed(2)} vs ${quiet.ring.toFixed(2)}`);
  check('level drops 20 dB with amp ÷10', Math.abs(ringy.level - quiet.level - 20) < 0.3, (ringy.level - quiet.level).toFixed(2));
}

// ---- silence and noise are not voiced
{
  const noise = new Float32Array(SR / 2);
  let x = 1;
  for (let i = 0; i < noise.length; i++) { x = (x * 16807) % 2147483647; noise[i] = 0.01 * ((x / 2147483647) * 2 - 1); }
  const fr = analyzeSignal(noise);
  check('white noise mostly unvoiced', fr.filter(f => f.voiced).length / fr.length < 0.1);
}

// ---- calibration: build a sung protocol, "record" it on two simulated devices
function protocol(transformDst) {
  const notes = [];
  const pitches = [220, 220, 220, 247, 247, 247, 196, 196, 196, 233, 233, 233];
  const amps = [0.02, 0.07, 0.25];
  pitches.forEach((f, i) => notes.push({ f, amp: amps[i % 3], ring: [0.2, 0.8, 1.4, 0.5][Math.floor(i / 3)] }));
  const gap = new Float32Array(Math.round(1.5 * SR));
  const parts = [gap];
  for (const n of notes) { parts.push(voice(n.f, 2.2, { amp: n.amp, ringGain: n.ring })); parts.push(gap); }
  const len = parts.reduce((a, p) => a + p.length, 0), src = new Float32Array(len);
  let o = 0;
  for (const p of parts) { src.set(p, o); o += p.length; }
  return { src, dst: transformDst(src) };
}
// Device B: quieter mic (−9 dB) with a high-frequency roll-off — a linear difference.
function micB(sig) {
  const out = new Float32Array(sig.length);
  let y = 0;
  for (let i = 0; i < sig.length; i++) { y += 0.55 * (sig[i] - y); out[i] = y * 0.355; }
  return out;
}
// Device C: same as B plus a crude slow automatic gain control (non-linear).
function micAGC(sig) {
  const lin = micB(sig), out = new Float32Array(sig.length);
  let env = 0.01;
  for (let i = 0; i < sig.length; i++) {
    env += 0.0003 * (Math.abs(lin[i]) - env);
    out[i] = lin[i] * Math.min(8, 0.05 / Math.max(env, 1e-4));
  }
  return out;
}
{
  const { src, dst } = protocol(micB);
  const segA = detectSegments(analyzeSignal(src, new FrameAnalyzer(SR), 1000));
  const segB = detectSegments(analyzeSignal(dst, new FrameAnalyzer(SR), 5003.7)); // other clock
  check('12 notes detected on device A', segA.length === 12, `${segA.length}`);
  check('12 notes detected on device B', segB.length === 12, `${segB.length}`);

  const pairs = alignSegments(segA, segB.slice(1)); // B missed the first note
  check('alignment survives a missed note', pairs.length === 11 && pairs.every(([a, b]) => Math.abs(b.t0 - a.t0 - 4003.7) < 0.3), `${pairs.length} pairs`);

  const cal = fitCalibration(alignSegments(segA, segB));
  check('linear mic difference → good verdict', cal.verdict === 'good', `${cal.verdict} ${JSON.stringify(cal.stats, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`);
  check('level slope ≈ 1 for a linear mic', Math.abs(cal.level.a - 1) < 0.05, `a=${cal.level.a.toFixed(3)} b=${cal.level.b.toFixed(2)}`);
  const conv = applyCalibration(cal, { ...segA[5], ...metricsFromBands(segA[5].bands) });
  const real = metricsFromBands(segB[5].bands);
  check('converted ring matches device B', Math.abs(conv.ring - real.ring) < 1, `${conv.ring.toFixed(2)} vs ${real.ring.toFixed(2)}`);
  check('converted level matches device B', Math.abs(conv.level - segB[5].level) < 1, `${conv.level.toFixed(2)} vs ${segB[5].level.toFixed(2)}`);
  const back = toReferenceScale(cal, segB[7]);
  const realA = metricsFromBands(segA[7].bands);
  check('phone reading → lesson-device numbers', Math.abs(back.level - segA[7].level) < 1 && Math.abs(back.ring - realA.ring) < 1, `level ${back.level.toFixed(2)} vs ${segA[7].level.toFixed(2)}, ring ${back.ring.toFixed(2)} vs ${realA.ring.toFixed(2)}`);
  globalThis.__segs = segA;
}
{
  const { src, dst } = protocol(micAGC);
  const segA = detectSegments(analyzeSignal(src));
  const segC = detectSegments(analyzeSignal(dst));
  const cal = fitCalibration(alignSegments(segA, segC));
  check('auto-gain mic → poor verdict', cal.ok && cal.verdict === 'poor', `${cal.verdict}: ${cal.problems?.[0] || ''} slope=${cal.stats?.slope.toFixed(2)}`);
}

// ---- encrypted link messages
{
  const secret = 'q2v8sY1bC0x3n9Lm4Pz7Rt6Wk5Jh2Gf1Dd0Ss9Aa8E';
  const msg = { t: 'cal', at: 1761820000, s: globalThis.__segs.map(segToWire) };
  const text = await seal(secret, msg);
  const back = await unseal(secret, text);
  check('seal/unseal round trip', back.s.length === 12 && Math.abs(segFromWire(back.s[3]).level - globalThis.__segs[3].level) < 0.06, `${text.length} chars (relay limit 4096)`);
  check('calibration message fits relay limit', text.length < 4000);
  let rejected = false;
  try { await unseal(secret.replace('q', 'r'), text); } catch (e) { rejected = true; }
  check('wrong key cannot read it', rejected);
  check('link topic is stable and opaque', (await linkTopic(secret)) === (await linkTopic(secret)) && !(await linkTopic(secret)).includes(secret.slice(0, 6)));
  const c = newCode();
  check('code format + normalisation', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c) && normalizeCode(c.toLowerCase().replace('-', ' ')) === c, c);
}

// ---- QR: table consistency + matrices for the Python decoder check
{
  const tc = [1, 7, 10, 25, 40].map(totalCodewords);
  check('QR codeword totals', JSON.stringify(tc) === JSON.stringify([26, 196, 346, 1588, 3706]), JSON.stringify(tc));
  check('QR max bytes v40-L', maxBytes(40) === 2953, String(maxBytes(40)));
  const lens = [10, 60, 200, 270, 600, 900, 1300, 1800, 2400, 2900];
  const out = lens.map(len => {
    let text = 'https://example.github.io/vocal-meter/#x=';
    while (text.length < len) text += 'AbC-_9xyz'[text.length % 9];
    const q = encodeQR(text);
    return { text, version: q.version, size: q.size, rows: Array.from({ length: q.size }, (_, y) => Array.from({ length: q.size }, (_, x) => q.get(x, y) ? 1 : 0).join('')) };
  });
  writeFileSync(process.argv[2] || '/dev/null', JSON.stringify(out));
  console.log('     QR versions generated:', out.map(o => o.version).join(','));
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
