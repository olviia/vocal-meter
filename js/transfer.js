// Moving references and calibration data between devices: QR code, link or file.
import { h, modal, toast, download } from './ui.js';
import { pack, unpack, readPayload, mergeExercises } from './store.js';
import { encodeQR, qrToSvg } from './qr.js';
import { S, commit } from './state.js';
import { finishCalibration } from './views/calibrate.js';

const appUrl = () => location.origin + location.pathname;

export async function sendModal(title, payload, hint) {
  const data = await pack(payload);
  const link = `${appUrl()}#x=${data}`;
  let qrEl;
  try {
    const qr = encodeQR(link);
    qrEl = h('div', { class: 'qr', 'data-version': qr.version, html: qrToSvg(qr) });
  } catch (e) {
    qrEl = h('p', { class: 'note warn' }, 'Too much data for one QR code. Send one exercise at a time, or use the link or file below.');
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); }
    catch (e) { toast('Copy failed — use Share or the file instead'); }
  };
  const share = navigator.share
    ? h('button', { class: 'ghost', onclick: () => navigator.share({ title: 'Vocal Meter data', url: link }).catch(() => {}) }, 'Share link')
    : null;
  modal(title,
    h('p', { class: 'note' }, hint || 'On the other device, point the camera at this code and open the link.'),
    qrEl,
    h('div', { class: 'row wrap' },
      h('button', { class: 'ghost', onclick: copy }, 'Copy link'),
      share,
      h('button', { class: 'ghost', onclick: () => download(`vocal-meter-${payload.k}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload)) }, 'Save as file')));
}

export async function importObject(obj) {
  const p = readPayload(obj);
  if (p.kind === 'refs') {
    if (p.device.id === S.device.id) { toast('These references came from this device already.'); return; }
    const { addedEx, addedMarks } = mergeExercises(S, p.exercises);
    if (!S.currentExerciseId && S.exercises.length) S.currentExerciseId = S.exercises[0].id;
    commit();
    const calNote = S.calibrations[p.device.id] ? '' : ` Not calibrated against ${p.device.name} yet — numbers are shown raw.`;
    toast(`Added ${addedMarks} reference${addedMarks === 1 ? '' : 's'} (${addedEx} new exercise${addedEx === 1 ? '' : 's'}) from ${p.device.name}.${calNote}`);
    location.hash = '#/exercises';
    return;
  }
  if (p.kind === 'cal') {
    if (p.device.id === S.device.id) { toast('That calibration recording is from this device.'); return; }
    S.pendingCal = { device: p.device, at: p.at, segments: p.segments };
    commit();
    location.hash = '#/calibrate';
    finishCalibration();
    return;
  }
  if (p.kind === 'backup') {
    const mine = S.device;
    Object.assign(S, p.state);
    if (p.state.device?.id !== mine.id) S.device = mine; // a backup from another device keeps this device's identity
    commit();
    toast('Backup restored');
    location.hash = '#/meter';
  }
}

export async function importFromHash() {
  const m = location.hash.match(/^#x=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  history.replaceState(null, '', appUrl() + '#/meter');
  try { await importObject(await unpack(m[1])); }
  catch (e) { toast('That link is damaged or incomplete — try sending it again.'); }
  return true;
}

export function importFilePicker() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    try { await importObject(JSON.parse(await f.text())); }
    catch (e) { toast(`Couldn't read that file: ${e.message}`); }
  });
  input.click();
}
