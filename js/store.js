// Local persistence and compact encodings. Everything here stays on this device.
const KEY = 'vocal-meter:v3';
export const uid = () => {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, x => x.toString(36).padStart(2, '0')).join('').slice(0, 14);
};

function guessDeviceName() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Android|iPhone|iPad/i.test(ua) ? 'Phone' : 'Laptop';
}

export function defaultState() {
  return {
    v: 3,
    device: { id: uid(), name: guessDeviceName() },
    noise: null,        // room noise subtracted from readings { bandPow[], levelDb, at }
    link: null,         // { peerId, peerName, secret, role: 'reference'|'follower', at }
    calSession: null,   // this device's latest calibration recording { at, segments }
    peerSession: null,  // the linked device's latest recording { at, segments }
    calibration: null,  // latest successful result; see sync.js
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

// ---------- calibration segments, compact ----------
const r1 = x => Math.round(x * 10);
const u1 = x => x / 10;
export const segToWire = s => [Math.round(s.t0 * 1000), Math.round(s.t1 * 1000), Math.round(s.cents), r1(s.level), s.bands.map(r1), s.harm ? s.harm.map(r1) : 0];
export const segFromWire = ([t0, t1, cents, level, bands, harm]) => ({ t0: t0 / 1000, t1: t1 / 1000, cents, level: u1(level), bands: bands.map(u1), harm: harm ? harm.map(u1) : null });

// ---------- bytes helpers ----------
export const b64u = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = str => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export const deflate = bytes => pipe(bytes, new CompressionStream('deflate-raw'));
export const inflate = bytes => pipe(bytes, new DecompressionStream('deflate-raw'));
