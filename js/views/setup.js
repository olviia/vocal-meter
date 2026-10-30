// Device setup and checks: name, mic processing, background noise, auto-gain test, data.
import { h, toast, confirmBox, download, fmtLevel } from '../ui.js';
import { engine, recordFor } from '../engine.js';
import { median, NB } from '../dsp.js';
import { S, commit } from '../state.js';
import { backupPayload, defaultState } from '../store.js';
import { importFilePicker } from '../transfer.js';

const flag = v => v === false ? ['off', 'good'] : v === true ? ['on', 'bad'] : ['unknown', 'unknown'];

export function setupView(root) {
  const micBox = h('div', { class: 'check-body' });
  const noiseBox = h('div', { class: 'check-body' });
  const gainBox = h('div', { class: 'check-body' });

  function renderMic() {
    if (!engine.running) { micBox.replaceChildren(h('p', { class: 'note' }, 'Start the microphone to see what the browser is doing to the signal.'), h('button', { class: 'ghost', onclick: startMic }, 'Start microphone')); return; }
    const s = engine.settings;
    const items = [['Auto-gain', s.autoGainControl], ['Noise suppression', s.noiseSuppression], ['Echo cancellation', s.echoCancellation]];
    micBox.replaceChildren(
      h('ul', { class: 'flags' }, items.map(([k, v]) => { const [txt, cls] = flag(v); return h('li', { class: cls }, h('span', {}, k), h('b', {}, txt)); })),
      h('p', { class: 'note' }, `${engine.trackLabel || 'Microphone'} · ${engine.sampleRate} Hz. “Off” only means the browser’s own processing is off; the phone or laptop can still process audio in hardware — the auto-gain test below checks for that.`));
  }
  async function startMic() {
    try { await engine.start(); renderMic(); }
    catch (e) { toast(`Microphone didn’t start: ${e.message}`); }
  }

  function renderNoise() {
    const n = S.noise;
    const verdict = !n ? null : n.levelDb < -60 ? ['Quiet — good', 'good'] : n.levelDb < -50 ? ['Some background noise — fine for loud singing, soft notes will be less accurate', 'fair'] : ['Noisy — ring and brightness of soft notes will be unreliable', 'bad'];
    noiseBox.replaceChildren(
      n ? h('p', { class: `result ${verdict[1]}` }, h('b', {}, `${fmtLevel(n.levelDb)} dB background. `), verdict[0], '.') : h('p', { class: 'note' }, 'Not measured yet.'),
      h('p', { class: 'note' }, 'Stay silent for 3 seconds. The app subtracts this background from every reading, so redo it if the room or fan noise changes.'),
      h('button', { class: 'ghost', onclick: measureNoise }, n ? 'Measure again' : 'Measure background'));
  }
  async function measureNoise() {
    if (!engine.running) { try { await engine.start(); renderMic(); } catch (e) { toast(e.message); return; } }
    const label = h('p', { class: 'big-count' }, 'Stay silent… 3');
    noiseBox.replaceChildren(label);
    const frames = await recordFor(3, el => { label.textContent = `Stay silent… ${Math.max(1, Math.ceil(3 - el))}`; });
    if (frames.length < 20) { toast('Not enough audio — try again'); renderNoise(); return; }
    const bandPow = new Array(NB).fill(0);
    for (const f of frames) for (let b = 0; b < NB; b++) bandPow[b] += f.bandPow[b] / frames.length;
    S.noise = { bandPow, levelDb: median(frames.map(f => f.levelDb)), at: Date.now() };
    engine.setNoise(S.noise);
    commit();
    renderNoise();
  }

  function renderGain() {
    const g = S.gainTest;
    const parts = [h('p', { class: 'note' }, 'Checks whether the device quietly turns its own volume up and down. Follow the prompts: silence, a soft “ah”, a loud “ah”, silence. Takes 11 seconds.')];
    if (g) {
      const issues = [];
      if (g.pump > 4) issues.push(`Background got ${g.pump.toFixed(1)} dB louder right after the loud note — this device is probably auto-adjusting its gain.`);
      if (g.range < 10) issues.push(`Only ${g.range.toFixed(0)} dB between soft and loud. Either the contrast was small, or the mic is compressing. Try again with a really soft and a really loud note.`);
      parts.unshift(h('p', { class: `result ${issues.length ? 'bad' : 'good'}` },
        h('b', {}, `Soft ${fmtLevel(g.soft)} dB, loud ${fmtLevel(g.loud)} dB. `),
        issues.length ? issues.join(' ') : 'No sign of automatic gain: background stayed steady and loud notes read clearly louder.'));
    }
    parts.push(h('button', { class: 'ghost', onclick: runGain }, g ? 'Run again' : 'Run auto-gain test'));
    gainBox.replaceChildren(...parts);
  }
  async function runGain() {
    if (!engine.running) { try { await engine.start(); renderMic(); } catch (e) { toast(e.message); return; } }
    const phases = [[0, 2, 'Silence'], [2, 5, 'Soft “ah”'], [5, 8, 'Loud “ah”'], [8, 11, 'Silence']];
    const label = h('p', { class: 'big-count' }), bar = h('div', { class: 'level-bar' }, h('i'));
    gainBox.replaceChildren(label, bar);
    const fr = await recordFor(11, el => {
      const p = phases.find(([a, b]) => el >= a && el < b) || phases[3];
      label.textContent = `${p[2]} · ${Math.ceil(p[1] - el)}`;
      bar.firstChild.style.width = `${(el / 11) * 100}%`;
    });
    if (!fr.length) { renderGain(); return; }
    const t0 = fr[0].t;
    const pick = (a, b, voiced) => fr.filter(f => f.t - t0 >= a && f.t - t0 < b && (voiced == null || f.voiced === voiced)).map(f => f.levelDb);
    const before = median(pick(0.3, 1.8)), after = median(pick(8.4, 10.8, false));
    const soft = median(pick(2.5, 5, true)), loud = median(pick(5.5, 8, true));
    if (!Number.isFinite(soft) || !Number.isFinite(loud)) { toast('Didn’t hear both notes — try again and hold each note'); renderGain(); return; }
    S.gainTest = { before, after, soft, loud, pump: after - before, range: loud - soft, at: Date.now() };
    commit();
    renderGain();
  }

  const tol = (key, label) => h('label', { class: 'field inline' }, h('span', {}, label),
    h('input', { type: 'number', min: 0.5, max: 10, step: 0.5, value: S.tolerance[key], onchange: e => { const v = parseFloat(e.target.value); if (v > 0) { S.tolerance[key] = v; commit(); } } }), h('small', {}, '± dB'));

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h2', {}, 'Setup')),
    h('section', { class: 'check' }, h('h3', {}, 'This device'),
      h('label', { class: 'field' }, h('span', {}, 'Name shown on references it measures'),
        h('input', { type: 'text', value: S.device.name, onchange: e => { const v = e.target.value.trim(); if (v) { S.device.name = v; commit(); } } }))),
    h('section', { class: 'check' }, h('h3', {}, 'Microphone processing'), micBox),
    h('section', { class: 'check' }, h('h3', {}, 'Background noise'), noiseBox),
    h('section', { class: 'check' }, h('h3', {}, 'Auto-gain test'), gainBox),
    h('section', { class: 'check' }, h('h3', {}, 'How close counts as on target'), h('div', { class: 'row wrap' }, tol('level', 'Loudness'), tol('ring', 'Ring'), tol('bright', 'Brightness'))),
    h('section', { class: 'check' }, h('h3', {}, 'What the numbers mean'),
      h('dl', { class: 'glossary' },
        h('dt', {}, 'Loudness'), h('dd', {}, 'Relative dB, not a sound-level-meter reading. Only compare numbers from the same device, at the same distance, in the same room.'),
        h('dt', {}, 'Ring'), h('dd', {}, 'How much of your sound sits in the 2–3.5 kHz “singer’s formant” region compared with the body of the voice. Higher (closer to 0) means more ring and projection. It shifts with vowel and pitch, which is why targets are matched to the nearest marked note.'),
        h('dt', {}, 'Brightness'), h('dd', {}, 'Energy above about 1 kHz compared with below it. Higher is brighter, lower is darker or warmer.'))),
    h('section', { class: 'check' }, h('h3', {}, 'Your data'),
      h('p', { class: 'note' }, 'Everything is stored on this device only. Save a backup before clearing browser data.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'ghost', onclick: () => download(`vocal-meter-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backupPayload(S))) }, 'Save backup'),
        h('button', { class: 'ghost', onclick: importFilePicker }, 'Restore or import file'),
        h('button', { class: 'ghost danger-text', onclick: async () => { if (await confirmBox('Erase everything?', 'All exercises, marks, calibrations and checks on this device will be deleted.', 'Erase')) { const keep = S.device; Object.keys(S).forEach(k => delete S[k]); Object.assign(S, defaultState(), { device: keep }); engine.setNoise(null); commit(); location.reload(); } } }, 'Erase all data'))),
  );
  renderMic(); renderNoise(); renderGain();
  const onState = () => renderMic();
  engine.addEventListener('state', onState);
  return () => engine.removeEventListener('state', onState);
}
