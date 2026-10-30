// Persistence (localStorage) and the compact format used to send a calibration recording
// from the lesson device to the practice phone.
const KEY = 'vocal-meter:v2';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function guessDeviceName() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Android|iPhone|iPad/i.test(ua) ? 'Phone' : 'Laptop';
}

export function defaultState() {
  return {
    v: 2,
    device: { id: uid(), name: guessDeviceName() },
    noise: null,        // { bandPow[], levelDb, at } — room noise subtracted from readings
    calibration: null,  // latest: { srcName, srcId, at, level, bandOffset, stats, verdict, problems }
    calSession: null,   // this device's latest calibration recording { at, segments }
    pendingCal: null,   // the lesson device's recording, if it arrived before ours
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) { /* storage blocked or corrupt — start fresh */ }
  return defaultState();
}
export function saveState(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch (e) { return false; }
}

// ---------- wire format ----------
const r1 = x => Math.round(x * 10);
const u1 = x => x / 10;
const segToWire = s => [Math.round(s.t0 * 1000), Math.round(s.t1 * 1000), Math.round(s.cents), r1(s.level), s.bands.map(r1)];
const segFromWire = ([t0, t1, cents, level, bands]) => ({ t0: t0 / 1000, t1: t1 / 1000, cents, level: u1(level), bands: bands.map(u1) });

export function calPayload(state) {
  return { k: 'cal', v: 1, d: state.device, at: state.calSession.at, s: state.calSession.segments.map(segToWire) };
}
export function readPayload(p) {
  if (!p || p.k !== 'cal') throw new Error('Not a Vocal Meter calibration');
  return { device: p.d, at: p.at, segments: p.s.map(segFromWire) };
}

// JSON → deflate → base64url, so a payload fits in a link or QR code.
const b64url = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = str => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export async function pack(obj) {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('deflate-raw')));
}
export async function unpack(str) {
  return JSON.parse(new TextDecoder().decode(await pipe(unb64url(str), new DecompressionStream('deflate-raw'))));
}
