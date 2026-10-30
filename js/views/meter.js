// The main screen: live numbers, targets from the current exercise, and the Mark button.
import { h, toast, ask, fmtLevel, fmtSigned, DISPLAY_OFFSET } from '../ui.js';
import { engine } from '../engine.js';
import { summarize, noteName, quantile } from '../dsp.js';
import { S, commit, currentExercise, referenceFor } from '../state.js';
import { newId } from '../store.js';

const RANGES = { level: [30, 110], ring: [-40, 0], bright: [-35, 5] };

function gauge(key, label, unit) {
  const zone = h('div', { class: 'zone', hidden: true });
  const needle = h('div', { class: 'needle' });
  const value = h('span', { class: 'value' }, '–');
  const delta = h('span', { class: 'delta' });
  const row = h('section', { class: `metric metric-${key}` },
    h('div', { class: 'metric-head' }, h('span', { class: 'label' }, label), h('span', { class: 'readout' }, value, h('small', {}, unit)), delta),
    h('div', { class: 'gauge', role: 'img', 'aria-label': `${label} gauge` }, zone, needle));
  const pct = v => {
    const [lo, hi] = RANGES[key];
    return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  };
  return {
    row,
    set(v, live, target, tol) {
      value.textContent = Number.isFinite(v) ? Math.round(v).toString().replace('-', '−') : '–';
      row.classList.toggle('idle', !live);
      needle.style.left = `${pct(Number.isFinite(v) ? v : RANGES[key][0])}%`;
      if (Number.isFinite(target)) {
        zone.hidden = false;
        zone.style.left = `${pct(target - tol)}%`;
        zone.style.width = `${pct(target + tol) - pct(target - tol)}%`;
        if (live && Number.isFinite(v)) {
          const d = v - target;
          const on = Math.abs(d) <= tol;
          row.dataset.state = on ? 'on' : d < 0 ? 'low' : 'high';
          delta.textContent = on ? 'on target' : `${Math.abs(Math.round(d))} ${d < 0 ? 'below' : 'above'}`;
        } else { row.dataset.state = ''; delta.textContent = `target ${Math.round(target)}`; }
      } else { zone.hidden = true; row.dataset.state = ''; delta.textContent = ''; }
    },
  };
}

export function meterView(root) {
  const select = h('select', { 'aria-label': 'Exercise', onchange: e => { S.currentExerciseId = e.target.value || null; commit(); } });
  const fillSelect = () => {
    select.replaceChildren(h('option', { value: '' }, S.exercises.length ? 'No exercise (just measure)' : 'No exercises yet'),
      ...S.exercises.map(e => h('option', { value: e.id, selected: e.id === S.currentExerciseId }, `${e.name} (${e.marks.length})`)));
  };
  fillSelect();
  const newEx = async () => {
    const name = await ask('New exercise', 'Name', `Exercise ${S.exercises.length + 1}`);
    if (!name) return null;
    const ex = { id: newId(), name, created: Date.now(), marks: [] };
    S.exercises.push(ex); S.currentExerciseId = ex.id; commit(); fillSelect();
    return ex;
  };

  const level = gauge('level', 'Loudness', 'dB'), ring = gauge('ring', 'Ring', 'dB'), bright = gauge('bright', 'Brightness', 'dB');
  const pitchName = h('span', { class: 'value' }, '–'), pitchOff = h('small', {}), pitchHz = h('span', { class: 'delta' });
  const pitch = h('section', { class: 'metric metric-pitch idle' },
    h('div', { class: 'metric-head' }, h('span', { class: 'label' }, 'Pitch'), h('span', { class: 'readout' }, pitchName, pitchOff), pitchHz));
  const canvas = h('canvas', { class: 'trace', height: 120, 'aria-label': 'Loudness over the last 10 seconds' });
  const status = h('p', { class: 'status', 'aria-live': 'polite' });
  const refInfo = h('p', { class: 'refinfo' });

  const startBtn = h('button', { class: 'primary big', onclick: () => start() }, 'Start microphone');
  const markBtn = h('button', { class: 'mark big', onclick: () => mark(), title: 'Shortcut: M or Space' }, 'Mark this');
  const stopBtn = h('button', { class: 'ghost', onclick: () => engine.stop() }, 'Stop');

  async function start() {
    try { await engine.start(); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone permission was refused. Allow it in the browser’s site settings.' : `Microphone didn’t start: ${e.message}`); }
  }

  async function mark() {
    if (!engine.running) { toast('Start the microphone first'); return; }
    const sum = summarize(engine.recent(2));
    if (!sum || sum.n < 20) { toast('Hold a note for a moment, then mark'); return; }
    let ex = currentExercise() || await newEx();
    if (!ex) return;
    const m = { id: newId(), t: Date.now(), cents: sum.cents, level: sum.level, bands: sum.bands.map(v => Math.round(v * 10) / 10), dev: { ...S.device } };
    ex.marks.push(m);
    ex.marks.sort((a, b) => a.cents - b.cents);
    commit(); fillSelect();
    toast(`Marked ${noteName(sum.cents).name} · ${fmtLevel(sum.level)} dB · ring ${Math.round(sum.ring)}`, {
      label: 'Undo', run: () => { ex.marks = ex.marks.filter(x => x.id !== m.id); commit(); fillSelect(); },
    });
  }

  const key = e => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    if ((e.key === 'm' || e.key === ' ') && engine.running) { e.preventDefault(); mark(); }
  };
  document.addEventListener('keydown', key);

  const controls = h('div', { class: 'controls sticky' });
  const renderControls = () => controls.replaceChildren(...(engine.running ? [markBtn, stopBtn] : [startBtn]));
  renderControls();
  const onState = () => { renderControls(); if (!engine.running && engine.stopReason) toast(engine.stopReason); };
  engine.addEventListener('state', onState);

  root.replaceChildren(
    h('div', { class: 'exercise-bar' }, select, h('button', { class: 'ghost', onclick: newEx }, 'New')),
    h('div', { class: 'metrics' }, level.row, pitch, ring.row, bright.row),
    canvas, refInfo, status, controls);

  // ---- drawing loop
  let raf, lastCents = NaN, css = null;
  const readCss = () => {
    const cs = getComputedStyle(document.documentElement);
    css = { line: cs.getPropertyValue('--ink').trim(), faint: cs.getPropertyValue('--muted').trim(), zone: cs.getPropertyValue('--zone-fill').trim(), grid: cs.getPropertyValue('--rule').trim() };
  };
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', readCss);

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!css) readCss();
    const tol = S.tolerance;
    const ex = currentExercise();
    const recent = engine.running ? engine.recent(0.5) : [];
    const sum = summarize(recent);
    const live = !!(sum && sum.n >= 3 && engine.latest?.voiced !== undefined && (engine.latest.t - recent.filter(f => f.voiced).at(-1).t) < 0.35);
    if (live) lastCents = sum.cents;
    const r = referenceFor(ex, lastCents);
    const ref = r && r.near ? r.ref : null;

    const lv = live ? sum.level : engine.latest ? engine.latest.levelDb : NaN;
    level.set(lv + DISPLAY_OFFSET, live, ref ? ref.level + DISPLAY_OFFSET : NaN, tol.level);
    ring.set(live ? sum.ring : NaN, live, ref ? ref.ring : NaN, tol.ring);
    bright.set(live ? sum.bright : NaN, live, ref ? ref.bright : NaN, tol.bright);
    pitch.classList.toggle('idle', !live);
    if (live) {
      const nn = noteName(sum.cents);
      pitchName.textContent = nn.name;
      pitchOff.textContent = nn.off ? ` ${fmtSigned(nn.off)}¢` : '';
      pitchHz.textContent = `${Math.round(440 * Math.pow(2, (sum.cents - 6900) / 1200))} Hz`;
    }

    // reference line
    if (!ex) refInfo.textContent = S.exercises.length ? 'Pick an exercise to see your targets.' : 'In a lesson, hold a note your teacher approves and press Mark this.';
    else if (!ex.marks.length) refInfo.textContent = `No marks in “${ex.name}” yet.`;
    else if (!r) refInfo.textContent = `Sing to see the target for the nearest marked note.`;
    else if (!r.near) refInfo.textContent = `No mark within 3 semitones — nearest is ${noteName(r.ref.cents).name}.`;
    else {
      const src = r.ref.status === 'own' ? 'this device' : r.ref.dev.name;
      const tags = { own: '', converted: ' (converted)', uncalibrated: ' — not calibrated, raw numbers', outOfRange: ' — louder/softer than the calibration covered' };
      refInfo.textContent = `Target: ${noteName(r.ref.cents).name} from ${src}${tags[r.ref.status]}`;
      refInfo.dataset.warn = r.ref.status === 'uncalibrated' || r.ref.status === 'outOfRange' || r.ref.verdict === 'poor' ? '1' : '';
    }

    // warnings
    let msg = '';
    if (engine.running) {
      const last = engine.recent(1);
      const bg = engine.recent(8).map(f => f.levelDb);
      if (last.some(f => f.peak >= 0.98)) msg = 'Too loud for the mic — move it further away.';
      else if (!S.noise) msg = 'Run the noise check in Setup for cleaner ring and brightness readings.';
      else if (bg.length > 100 && quantile(bg, 0.1) > S.noise.levelDb + 6) msg = 'Background is noisier than at your noise check — fans or room noise will skew ring.';
    } else if (!engine.running) msg = '';
    status.textContent = msg;
    status.hidden = !msg;

    drawTrace(ref ? ref.level + DISPLAY_OFFSET : NaN, tol.level);
  }

  function drawTrace(target, tol) {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const [lo, hi] = RANGES.level;
    const y = v => hgt - ((v - lo) / (hi - lo)) * hgt;
    g.strokeStyle = css.grid; g.lineWidth = 1;
    for (let v = 40; v < hi; v += 20) { g.beginPath(); g.moveTo(0, y(v) + 0.5); g.lineTo(w, y(v) + 0.5); g.stroke(); }
    if (Number.isFinite(target)) { g.fillStyle = css.zone; g.fillRect(0, y(target + tol), w, y(target - tol) - y(target + tol)); }
    const fr = engine.running ? engine.recent(10) : [];
    if (!fr.length) return;
    const tEnd = fr[fr.length - 1].t;
    const x = t => w - ((tEnd - t) / 10) * w;
    for (const voicedPass of [false, true]) {
      g.strokeStyle = voicedPass ? css.line : css.faint;
      g.lineWidth = voicedPass ? 2.5 : 1;
      g.beginPath();
      let pen = false;
      for (const f of fr) {
        const on = voicedPass ? f.voiced : true;
        const yy = y(Math.max(lo, f.levelDb + DISPLAY_OFFSET));
        if (on) { if (pen) g.lineTo(x(f.t), yy); else g.moveTo(x(f.t), yy); pen = true; } else pen = false;
      }
      g.stroke();
    }
  }

  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', key);
    engine.removeEventListener('state', onState);
    mq.removeEventListener('change', readCss);
  };
}
