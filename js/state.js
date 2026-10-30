// App state: one object, saved after every change.
import { loadState, saveState } from './store.js';

export const S = loadState();
const listeners = new Set();

export function commit() {
  if (!saveState(S)) console.warn('Could not save — storage blocked');
  for (const fn of listeners) fn();
}
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
