// The meter: loudness and resonance side by side. Each number rides up and down its own scale,
// like a tuner. With a calibration, the phone shows the lesson device's numbers.
import { h, toast, DISPLAY_OFFSET } from '../ui.js';
import { engine } from '../engine.js';
import { summarize, metricsFromBands } from '../dsp.js';
import { toReferenceScale } from '../calibration.js';
import { S } from '../state.js';
import { VERDICT } from '../calibrate-core.js';

export const RES_OFFSET = 40; // resonance shown = ring dB + 40, so it reads as a positive number

function column(label, [lo, hi], step) {
  const marker = h('div', { class: 'marker' }, h('span', { class: 'num' }, '–'));
  const ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(h('span', { class: 'tick', style: { bottom: `${((v - lo) / (hi - lo)) * 100}%` } }, String(v)));
  const track = h('div', { class: 'track' }, ...ticks, marker);
  const col = h('section', { class: 'col idle' }, h('h2', { class: 'col-label' }, label), track);
  let shown = NaN;
  return {
    el: col,
    set(v, live, dim) {
      col.classList.toggle('idle', !live);
      col.classList.toggle('dim', !!dim);
      if (!Number.isFinite(v)) return;
      shown = Number.isFinite(shown) ? shown + (v - shown) * 0.3 : v;
      const frac = Math.max(0, Math.min(1, (shown - lo) / (hi - lo)));
      marker.style.bottom = `${frac * 100}%`;
      marker.firstChild.textContent = Math.round(shown).toString();
    },
  };
}

export function meterView(root) {
  const loud = column('Loudness', [30, 110], 10);
  const res = column('Resonance', [0, 40], 5);
  const calLine = h('p', { class: 'cal-line' });
  const status = h('p', { class: 'status', hidden: true });
  const startBtn = h('button', { class: 'primary big', onclick: start }, 'Start');
  const stopBtn = h('button', { class: 'ghost big', onclick: () => engine.stop() }, 'Stop');
  const controls = h('div', { class: 'controls' });

  async function start() {
    try { await engine.start(); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone permission was refused. Allow it in the browser’s site settings.' : `Microphone didn’t start: ${e.message}`); }
  }
  const renderControls = () => controls.replaceChildren(engine.running ? stopBtn : startBtn);
  const onState = () => { renderControls(); if (!engine.running && engine.stopReason) toast(engine.stopReason); };
  engine.addEventListener('state', onState);
  renderControls();

  const c = S.calibration;
  calLine.replaceChildren(c
    ? h('span', {}, `Calibrated to ${c.srcName} · `, h('b', { class: `v-${c.verdict}` }, VERDICT[c.verdict]))
    : h('a', { href: '#/calibrate' }, 'Not calibrated — tap to calibrate'));

  root.replaceChildren(calLine, h('div', { class: 'columns' }, loud.el, res.el), status, controls);

  let raf, lastRes = NaN;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!engine.running || !engine.latest) { loud.set(NaN, false); res.set(NaN, false); status.hidden = true; return; }

    const recent = engine.recent(0.4);
    const voicedFrames = recent.filter(f => f.voiced);
    const live = voicedFrames.length >= 3 && engine.latest.t - voicedFrames.at(-1).t < 0.3;
    const sum = live ? summarize(recent) : null;

    let level = live ? sum.level : engine.latest.levelDb;
    let ring = live ? metricsFromBands(sum.bands).ring : NaN;
    let outOfRange = false;
    if (c) {
      if (live) {
        const ref = toReferenceScale(c, sum);
        level = ref.level; ring = ref.ring; outOfRange = ref.outOfRange;
      } else level = (level - c.level.b) / c.level.a;
    }
    if (live) lastRes = ring + RES_OFFSET;

    loud.set(level + DISPLAY_OFFSET, live, outOfRange);
    res.set(lastRes, live, outOfRange);

    let msg = '';
    if (engine.recent(1).some(f => f.peak >= 0.98)) msg = 'Too loud for the mic — move it further away.';
    else if (!S.noise) msg = 'Measure room noise on the Calibrate screen for accurate resonance.';
    else if (outOfRange) msg = 'Louder or softer than the calibration covered — numbers are approximate.';
    status.textContent = msg;
    status.hidden = !msg;
  }
  raf = requestAnimationFrame(frame);

  return () => { cancelAnimationFrame(raf); engine.removeEventListener('state', onState); };
}
