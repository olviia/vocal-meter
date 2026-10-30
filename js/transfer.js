// Sending the lesson device's calibration recording to the practice phone: QR code, link or file.
import { h, modal, toast, download } from './ui.js';
import { pack, unpack, readPayload } from './store.js';
import { encodeQR, qrToSvg } from './qr.js';
import { S, commit } from './state.js';
import { finishCalibration } from './calibrate-core.js';

const appUrl = () => location.origin + location.pathname;

export async function sendModal(payload) {
  const link = `${appUrl()}#x=${await pack(payload)}`;
  let qrEl;
  try { qrEl = h('div', { class: 'qr', html: qrToSvg(encodeQR(link)) }); }
  catch (e) { qrEl = h('p', { class: 'note' }, 'Too much data for a QR code — use the link or file instead.'); }
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); }
    catch (e) { toast('Copy failed — use the file instead'); }
  };
  modal('Send to your phone',
    h('p', { class: 'note' }, 'Point the phone’s camera at this code and open the link. The phone must have finished its own recording of the same singing.'),
    qrEl,
    h('div', { class: 'row wrap' },
      h('button', { class: 'ghost', onclick: copy }, 'Copy link'),
      navigator.share ? h('button', { class: 'ghost', onclick: () => navigator.share({ title: 'Vocal Meter calibration', url: link }).catch(() => {}) }, 'Share link') : null,
      h('button', { class: 'ghost', onclick: () => download(`vocal-meter-calibration-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload)) }, 'Save as file')));
}

export function importObject(obj) {
  const p = readPayload(obj);
  if (p.device.id === S.device.id) { toast('That recording is from this device — open the link on the other one.'); return; }
  S.pendingCal = p;
  commit();
  location.hash = '#/calibrate';
  finishCalibration();
}

export async function importFromHash() {
  const m = location.hash.match(/^#x=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  history.replaceState(null, '', appUrl() + '#/calibrate');
  try { importObject(await unpack(m[1])); }
  catch (e) { toast('That link is damaged or incomplete — send it again.'); }
  return true;
}

export function importFilePicker() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    try { importObject(JSON.parse(await f.text())); }
    catch (e) { toast(`Couldn’t read that file: ${e.message}`); }
  });
  input.click();
}
