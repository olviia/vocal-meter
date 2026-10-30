// Two-device calibration: both devices record the same 12 notes, the lesson device sends its
// recording, and the practice device works out the conversion and how trustworthy it is.
import { h, toast, confirmBox, fmtDate } from '../ui.js';
import { engine } from '../engine.js';
import { CAL_STEPS, detectSegments, alignSegments, fitCalibration } from '../calibration.js';
import { S, commit, onChange } from '../state.js';
import { calPayload } from '../store.js';
import { sendModal } from '../transfer.js';

let lastError = '';

export function finishCalibration() {
  const p = S.pendingCal, own = S.calSession;
  if (!p) return;
  if (!own || Math.abs(own.at - p.at) > 3 * 3600) {
    toast(`Got ${p.device.name}’s recording. Now record the same notes on this device too.`);
    return;
  }
  const pairs = alignSegments(p.segments, own.segments);
  const fit = fitCalibration(pairs);
  S.pendingCal = null;
  if (!fit.ok) {
    lastError = `${fit.reason} Make sure both devices recorded the same singing, with a short silence between notes.`;
    commit();
    toast('Calibration failed — see the Calibrate screen');
    return;
  }
  lastError = '';
  S.calibrations[p.device.id] = { srcName: p.device.name, at: Date.now(), level: fit.level, bandOffset: fit.bandOffset, stats: fit.stats, verdict: fit.verdict, problems: fit.problems };
  commit();
  toast(`Calibrated against ${p.device.name}: ${{ good: 'reliable', fair: 'usable with care', poor: 'not reliable' }[fit.verdict]}`);
}

const verdictTitle = { good: 'Reliable', fair: 'Usable with care', poor: 'Not reliable' };

function calCard(id, c) {
  const s = c.stats;
  const lines = [
    `Loudness converts within about ±${Math.max(0.5, s.levelErr).toFixed(1)} dB (slope ${s.slope.toFixed(2)}; 1.00 means both mics follow volume changes equally).`,
    `Ring within ±${Math.max(0.5, s.ringErr).toFixed(1)} dB, brightness within ±${Math.max(0.5, s.brightErr).toFixed(1)} dB.`,
    `Tested from ${Math.round(s.rangeLo + 100)} to ${Math.round(s.rangeHi + 100)} dB on ${c.srcName}; references outside that range are flagged.`,
    `${s.pairs} notes matched between the two recordings.`,
  ];
  return h('article', { class: `cal-card verdict-${c.verdict}` },
    h('header', {}, h('h3', {}, `${c.srcName} → this device`), h('span', { class: 'badge' }, verdictTitle[c.verdict])),
    c.problems.length ? h('ul', { class: 'problems' }, c.problems.map(p => h('li', {}, p[0].toUpperCase() + p.slice(1) + '.'))) : null,
    h('ul', { class: 'facts' }, lines.map(l => h('li', {}, l))),
    c.verdict === 'poor' ? h('p', { class: 'note' }, `On a Windows laptop: turn off microphone effects in Nahimic (or Realtek / Dolby audio software) and Audio enhancements in Windows sound settings, keep the fans quiet, then calibrate again.`) : null,
    h('div', { class: 'row' }, h('span', { class: 'note' }, `Calibrated ${fmtDate(c.at)}`),
      h('button', { class: 'ghost small danger-text', onclick: async () => { if (await confirmBox('Remove calibration?', `References from ${c.srcName} will be shown raw again.`, 'Remove')) { delete S.calibrations[id]; commit(); } } }, 'Remove')));
}

export function calibrateView(root) {
  let recording = null;

  function intro() {
    const cals = Object.entries(S.calibrations);
    const own = S.calSession;
    const pending = S.pendingCal;
    root.replaceChildren(...[
      h('div', { class: 'page-head' }, h('h2', {}, 'Calibrate two devices')),
      h('p', {}, `Your lesson device and practice phone have different microphones. Calibrating once lets this app convert lesson references into practice-phone numbers — and tells you whether that conversion can be trusted.`),
      h('ol', { class: 'steps' },
        h('li', {}, 'Put both devices side by side, about 1 m from you, at the same height. Open this screen on both.'),
        h('li', {}, 'Press Start recording on both, then sing the 12 notes below on one comfortable pitch: about 3 seconds each, with a breath of silence between.'),
        h('li', {}, 'Press Finish on both. On the lesson device, press Send to practice device and scan the code with your phone’s camera.')),
      h('ol', { class: 'protocol' }, CAL_STEPS.map(s => h('li', {}, h('b', {}, `“${s.vowel}”`), ` ${s.level}`))),
      lastError ? h('p', { class: 'status' }, lastError) : null,
      pending ? h('p', { class: 'status info' }, `Waiting for this device’s own recording to finish calibrating against ${pending.device.name}.`) : null,
      h('div', { class: 'controls' }, h('button', { class: 'primary big', onclick: startRec }, 'Start recording')),
      own ? h('section', { class: 'last-rec' },
        h('h3', {}, 'Latest recording on this device'),
        h('p', {}, `${own.segments.length} notes captured, ${fmtDate(own.at * 1000)}.`),
        h('div', { class: 'row wrap' },
          h('button', { class: 'ghost', onclick: () => sendModal('Send calibration recording', calPayload(S), 'Scan this with the practice phone’s camera and open the link. Its own recording must be from the same singing.') }, 'Send to practice device'))) : null,
      cals.length ? h('section', {}, h('h3', {}, 'Calibrations on this device'), ...cals.map(([id, c]) => calCard(id, c))) : null,
    ].filter(Boolean));
  }

  async function startRec() {
    try { await engine.start(); } catch (e) { toast(`Microphone didn’t start: ${e.message}`); return; }
    const rec = [];
    engine.recorders.add(rec);
    const at = Date.now() / 1000;
    const items = CAL_STEPS.map(s => h('li', {}, h('b', {}, `“${s.vowel}”`), ` ${s.level}`));
    const count = h('p', { class: 'big-count' }, '0 of 12 notes heard');
    const lvl = h('div', { class: 'level-bar' }, h('i'));
    recording = { rec, at, timer: null };
    root.replaceChildren(
      h('div', { class: 'page-head' }, h('h2', {}, 'Recording…')),
      h('p', { class: 'note' }, 'Sing each note for about 3 seconds, then pause. Ticks appear as notes are heard.'),
      count, lvl,
      h('ol', { class: 'protocol live' }, items),
      h('div', { class: 'controls' },
        h('button', { class: 'primary big', onclick: finish }, 'Finish'),
        h('button', { class: 'ghost', onclick: cancel }, 'Cancel')));
    recording.timer = setInterval(() => {
      const segs = detectSegments(rec);
      count.textContent = segs.length <= 12 ? `${segs.length} of 12 notes heard` : `${segs.length} notes heard`;
      items.forEach((li, i) => li.classList.toggle('done', i < segs.length));
      const l = engine.latest ? Math.max(0, Math.min(100, (engine.latest.levelDb + 70) * 1.6)) : 0;
      lvl.firstChild.style.width = `${l}%`;
    }, 250);
  }

  function stopRec() {
    if (!recording) return null;
    clearInterval(recording.timer);
    engine.recorders.delete(recording.rec);
    const r = recording;
    recording = null;
    return r;
  }
  function cancel() { stopRec(); intro(); }
  function finish() {
    const r = stopRec();
    const segments = detectSegments(r.rec);
    if (segments.length < 4) {
      lastError = `Only ${segments.length} notes were heard. Sing a little longer per note, with clear silence between notes, and try again.`;
      intro();
      return;
    }
    lastError = segments.length !== 12 ? `Heard ${segments.length} notes instead of 12 — that’s fine as long as the other device heard the same ones.` : '';
    S.calSession = { at: r.at, segments };
    commit();
    if (S.pendingCal) finishCalibration();
    intro();
  }

  intro();
  const off = onChange(() => { if (!recording) intro(); });
  return () => { off(); if (recording) stopRec(); };
}
