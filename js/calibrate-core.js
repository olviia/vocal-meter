// Combine the lesson device's recording with this device's own and store the result.
// The newest calibration replaces the previous one and is used on every later launch.
import { toast } from './ui.js';
import { alignSegments, fitCalibration } from './calibration.js';
import { S, commit } from './state.js';

export const calStatus = { error: '' };
export const VERDICT = { good: 'Reliable', fair: 'Usable with care', poor: 'Not reliable' };

export function finishCalibration() {
  const p = S.pendingCal, own = S.calSession;
  if (!p) return;
  if (!own || Math.abs(own.at - p.at) > 3 * 3600) {
    toast(`Got the ${p.device.name}’s recording. Now press Finish on this phone’s recording too.`);
    return;
  }
  const fit = fitCalibration(alignSegments(p.segments, own.segments));
  S.pendingCal = null;
  if (!fit.ok) {
    calStatus.error = `${fit.reason} Both devices must record the same singing, with a short silence between notes.`;
    commit();
    toast('Calibration failed — see below');
    return;
  }
  calStatus.error = '';
  S.calibration = {
    srcName: p.device.name, srcId: p.device.id, at: Date.now(),
    level: fit.level, bandOffset: fit.bandOffset, stats: fit.stats, verdict: fit.verdict, problems: fit.problems,
  };
  commit();
  toast(`Calibrated to ${p.device.name}: ${VERDICT[fit.verdict].toLowerCase()}`);
}
