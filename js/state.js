// App state: one object, saved after every change. Views read S and call commit().
import { loadState, saveState } from './store.js';
import { applyCalibration } from './calibration.js';
import { metricsFromBands } from './dsp.js';

export const S = loadState();
const listeners = new Set();

export function commit() {
  if (!saveState(S)) console.warn('Could not save — storage blocked');
  for (const fn of listeners) fn();
}
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

export const currentExercise = () => S.exercises.find(e => e.id === S.currentExerciseId) || null;

// A mark expressed in this device's numbers. Marks from another device are converted when a
// calibration exists; otherwise they're returned raw and flagged.
export function markHere(m) {
  const base = { ...m, ...metricsFromBands(m.bands) };
  if (m.dev.id === S.device.id) return { ...base, status: 'own' };
  const cal = S.calibrations[m.dev.id];
  if (!cal) return { ...base, status: 'uncalibrated' };
  const conv = applyCalibration(cal, base);
  return { ...conv, status: conv.outOfRange ? 'outOfRange' : 'converted', verdict: cal.verdict };
}

// The reference nearest in pitch to what's being sung now (within 3 semitones).
export function referenceFor(exercise, cents) {
  if (!exercise || !exercise.marks.length || !Number.isFinite(cents)) return null;
  let best = null, dist = Infinity;
  for (const m of exercise.marks) {
    const d = Math.abs(m.cents - cents);
    if (d < dist) { dist = d; best = m; }
  }
  return { ref: markHere(best), dist, near: dist <= 300 };
}
