// Calibration screen: both devices record the same 12 notes; the lesson device sends its
// recording; the phone works out the conversion, keeps it, and uses it from then on.
import { h, toast, fmtDate } from '../ui.js';
import { engine, recordFor } from '../engine.js';
import { CAL_STEPS, detectSegments } from '../calibration.js';
import { median, NB } from '../dsp.js';
import { S, commit, onChange } from '../state.js';
import { calPayload } from '../store.js';
import { sendModal, importFilePicker } from '../transfer.js';
import { finishCalibration, calStatus, VERDICT } from '../calibrate-core.js';

async function measureNoise(onTick) {
  const frames = await recordFor(3, onTick);
  if (frames.length < 20) return false;
  const bandPow = new Array(NB).fill(0);
  for (const f of frames) for (let b = 0; b < NB; b++) bandPow[b] += f.bandPow[b] / frames.length;
  S.noise = { bandPow, levelDb: median(frames.map(f => f.levelDb)), at: Date.now() };
  engine.setNoise(S.noise);
  commit();
  return true;
}

function calCard(c) {
  const s = c.stats;
  return h('article', { class: `cal-card verdict-${c.verdict}` },
    h('header', {}, h('h3', {}, `Calibrated to ${c.srcName}`), h('span', { class: 'badge' }, VERDICT[c.verdict])),
    c.problems.length ? h('ul', { class: 'problems' }, c.problems.map(p => h('li', {}, p[0].toUpperCase() + p.slice(1) + '.'))) : null,
    h('ul', { class: 'facts' },
      h('li', {}, `Loudness within about ±${Math.max(0.5, s.levelErr).toFixed(1)} dB, resonance within ±${Math.max(0.5, s.ringErr).toFixed(1)}.`),
      h('li', {}, `Volume tracking ${s.slope.toFixed(2)} (1.00 = both mics follow volume changes equally).`),
      h('li', {}, `Tested from ${Math.round(s.rangeLo + 100)} to ${Math.round(s.rangeHi + 100)} dB; readings outside that are dimmed on the meter.`),
      h('li', {}, `${s.pairs} notes matched · ${fmtDate(c.at)}`)),
    c.verdict === 'poor' ? h('p', { class: 'note' }, 'On the Windows laptop: switch off microphone effects in Nahimic and Audio enhancements in Windows sound settings, keep the fans quiet, then recalibrate.') : null);
}

export function calibrateView(root) {
  let recording = null;

  function intro() {
    const c = S.calibration, own = S.calSession, pending = S.pendingCal;
    root.replaceChildren(...[
      h('h2', {}, c ? 'Calibration' : 'Calibrate'),
      c ? calCard(c) : h('p', {}, 'The phone and the lesson device hear you differently. Calibrate once, and the phone shows the same numbers the lesson device would. The latest calibration is used every time you open the app.'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Both devices side by side, about 1 m from you. Open this screen on both.'),
        h('li', {}, 'Press Start on both. Stay silent for 3 seconds, then sing the 12 notes on one comfortable pitch: about 3 seconds each, a breath of silence between.'),
        h('li', {}, 'Press Finish on both. On the lesson device press Send to phone, and scan the code with the phone’s camera.')),
      calStatus.error ? h('p', { class: 'status' }, calStatus.error) : null,
      pending ? h('p', { class: 'status' }, `Got the ${pending.device.name}’s recording — record on this phone too, then it finishes automatically.`) : null,
      h('div', { class: 'controls' }, h('button', { class: 'primary big', onclick: startRec }, c ? 'Recalibrate' : 'Start')),
      own && !c ? h('div', { class: 'row wrap' },
        h('span', { class: 'note' }, `This device’s last recording: ${own.segments.length} notes, ${fmtDate(own.at * 1000)}.`),
        h('button', { class: 'ghost small', onclick: () => sendModal(calPayload(S)) }, 'Send to phone')) : null,
      h('div', { class: 'row wrap' },
        h('button', { class: 'ghost small', onclick: noiseOnly }, 'Re-measure room noise'),
        h('button', { class: 'ghost small', onclick: importFilePicker }, 'Import file')),
    ].filter(Boolean));
  }

  async function noiseOnly() {
    try { await engine.start(); } catch (e) { toast(`Microphone didn’t start: ${e.message}`); return; }
    const label = h('p', { class: 'big-count' });
    root.replaceChildren(h('h2', {}, 'Room noise'), label);
    const ok = await measureNoise(el => { label.textContent = `Stay silent… ${Math.max(1, Math.ceil(3 - el))}`; });
    toast(ok ? 'Room noise measured' : 'Not enough audio — try again');
    intro();
  }

  async function startRec() {
    try { await engine.start(); } catch (e) { toast(`Microphone didn’t start: ${e.message}`); return; }
    recording = { cancelled: false };
    const label = h('p', { class: 'big-count' }, 'Stay silent… 3');
    const items = CAL_STEPS.map(s => h('li', {}, h('b', {}, `“${s.vowel}”`), ` ${s.level}`));
    const finishBtn = h('button', { class: 'primary big', onclick: finish, disabled: true }, 'Finish');
    root.replaceChildren(h('h2', {}, 'Recording'), label,
      h('ol', { class: 'protocol' }, items),
      h('div', { class: 'controls' }, finishBtn, h('button', { class: 'ghost', onclick: cancel }, 'Cancel')));

    const ok = await measureNoise(el => { label.textContent = `Stay silent… ${Math.max(1, Math.ceil(3 - el))}`; });
    if (!recording || recording.cancelled) return;
    if (!ok) { toast('Microphone gave no audio'); cancel(); return; }

    const rec = [];
    engine.recorders.add(rec);
    Object.assign(recording, { rec, at: Date.now() / 1000 });
    finishBtn.disabled = false;
    label.textContent = 'Sing note 1';
    recording.timer = setInterval(() => {
      const n = detectSegments(rec).length;
      label.textContent = n >= 12 ? `${n} notes heard — press Finish` : `Sing note ${n + 1}`;
      items.forEach((li, i) => { li.classList.toggle('done', i < n); li.classList.toggle('now', i === n); });
    }, 250);
  }

  function stopRec() {
    if (!recording) return null;
    clearInterval(recording.timer);
    if (recording.rec) engine.recorders.delete(recording.rec);
    const r = recording;
    r.cancelled = true;
    recording = null;
    return r;
  }
  function cancel() { stopRec(); intro(); }
  function finish() {
    const r = stopRec();
    const segments = detectSegments(r.rec || []);
    if (segments.length < 4) {
      calStatus.error = `Only ${segments.length} notes were heard. Hold each note a little longer, with clear silence between, and try again.`;
      intro();
      return;
    }
    calStatus.error = segments.length !== 12 ? `Heard ${segments.length} notes instead of 12 — fine, as long as the other device heard the same ones.` : '';
    S.calSession = { at: r.at, segments };
    commit();
    if (S.pendingCal) finishCalibration();
    intro();
  }

  intro();
  const off = onChange(() => { if (!recording) intro(); });
  return () => { off(); stopRec(); };
}
