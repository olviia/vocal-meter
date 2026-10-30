// Persistence (localStorage) and the compact wire format used to move data between devices.
import { NB } from './dsp.js';

const KEY = 'vocal-meter:v1';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function guessDeviceName() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Android|iPhone|iPad/i.test(ua) ? 'Phone' : 'Laptop';
}

export function defaultState() {
  return {
    v: 1,
    device: { id: uid(), name: guessDeviceName() },
    noise: null,            // { bandPow[], levelDb, at }
    exercises: [],          // [{ id, name, created, marks: [Mark] }]
    currentExerciseId: null,
    calibrations: {},       // { [sourceDeviceId]: { srcName, at, level, bandOffset, stats, verdict, problems } }
    calSession: null,       // this device's latest calibration recording { at, segments }
    pendingCal: null,       // a source recording that arrived before our own
    tolerance: { level: 2, ring: 2, bright: 2 },
    gainTest: null,
  };
}
// Mark = { id, t, cents, level, bands[NB], dev: { id, name } }  (raw numbers of the device that measured it)

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
export const newId = uid;

// ---------- wire format ----------
const r1 = x => Math.round(x * 10);   // 0.1 dB precision as integers
const u1 = x => x / 10;

function markToWire(m) { return [m.id, Math.round(m.t / 1000), Math.round(m.cents), r1(m.level), m.bands.map(r1), m.dev.id, m.dev.name]; }
function markFromWire(w) { const [id, t, cents, level, bands, did, dname] = w; return { id, t: t * 1000, cents, level: u1(level), bands: bands.map(u1), dev: { id: did, name: dname } }; }
function segToWire(s) { return [Math.round(s.t0 * 1000), Math.round(s.t1 * 1000), Math.round(s.cents), r1(s.level), s.bands.map(r1)]; }
function segFromWire(w) { const [t0, t1, cents, level, bands] = w; return { t0: t0 / 1000, t1: t1 / 1000, cents, level: u1(level), bands: bands.map(u1) }; }

export function refsPayload(state, exerciseIds) {
  const ex = state.exercises.filter(e => !exerciseIds || exerciseIds.includes(e.id));
  return { k: 'refs', v: 1, d: state.device, e: ex.map(e => ({ i: e.id, n: e.name, c: e.created, m: e.marks.map(markToWire) })) };
}
export function calPayload(state) {
  return { k: 'cal', v: 1, d: state.device, at: state.calSession.at, s: state.calSession.segments.map(segToWire) };
}
export function backupPayload(state) { return { k: 'backup', v: 1, state }; }

export function readPayload(p) {
  if (!p || typeof p !== 'object') throw new Error('Not a Vocal Meter file');
  if (p.k === 'refs') {
    return { kind: 'refs', device: p.d, exercises: p.e.map(e => ({ id: e.i, name: e.n, created: e.c, marks: e.m.map(markFromWire) })) };
  }
  if (p.k === 'cal') return { kind: 'cal', device: p.d, at: p.at, segments: p.s.map(segFromWire) };
  if (p.k === 'backup') return { kind: 'backup', state: p.state };
  throw new Error('Unknown data type');
}

// Merge exercises by id, marks by id; nothing is overwritten or deleted.
export function mergeExercises(state, incoming) {
  let addedMarks = 0, addedEx = 0;
  for (const e of incoming) {
    let mine = state.exercises.find(x => x.id === e.id);
    if (!mine) { mine = { id: e.id, name: e.name, created: e.created, marks: [] }; state.exercises.push(mine); addedEx++; }
    for (const m of e.marks) {
      if (m.bands.length !== NB) continue;
      if (!mine.marks.some(x => x.id === m.id)) { mine.marks.push(m); addedMarks++; }
    }
    mine.marks.sort((a, b) => a.cents - b.cents);
  }
  return { addedEx, addedMarks };
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
  const json = new TextEncoder().encode(JSON.stringify(obj));
  return b64url(await pipe(json, new CompressionStream('deflate-raw')));
}
export async function unpack(str) {
  const bytes = await pipe(unb64url(str), new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(bytes));
}
