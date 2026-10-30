// Exercises and their marked references; sending them to the practice device.
import { h, ask, confirmBox, fmtLevel, fmtDate } from '../ui.js';
import { noteName } from '../dsp.js';
import { S, commit, markHere } from '../state.js';
import { refsPayload } from '../store.js';
import { sendModal, importFilePicker } from '../transfer.js';

const statusText = {
  own: '',
  converted: 'converted',
  outOfRange: 'outside calibrated range',
  uncalibrated: 'not calibrated',
};

export function exercisesView(root) {
  function render() {
    const list = S.exercises.map(ex => {
      const rows = ex.marks.map(m => {
        const r = markHere(m);
        return h('tr', { class: r.status === 'uncalibrated' || r.status === 'outOfRange' ? 'warn' : '' },
          h('td', {}, noteName(r.cents).name),
          h('td', { class: 'num' }, fmtLevel(r.level)),
          h('td', { class: 'num' }, Math.round(r.ring)),
          h('td', { class: 'num' }, Math.round(r.bright)),
          h('td', { class: 'src' }, `${m.dev.id === S.device.id ? 'here' : m.dev.name}, ${fmtDate(m.t)}`, statusText[r.status] ? h('em', {}, ` · ${statusText[r.status]}`) : null),
          h('td', {}, h('button', {
            class: 'icon', 'aria-label': `Delete ${noteName(r.cents).name} mark`,
            onclick: async () => { if (await confirmBox('Delete mark?', `Remove the ${noteName(r.cents).name} mark from “${ex.name}”?`)) { ex.marks = ex.marks.filter(x => x.id !== m.id); commit(); render(); } },
          }, '✕')));
      });
      return h('article', { class: 'exercise' + (ex.id === S.currentExerciseId ? ' current' : '') },
        h('header', {},
          h('h3', {}, ex.name),
          h('div', { class: 'row' },
            h('button', { class: 'ghost small', onclick: () => { S.currentExerciseId = ex.id; commit(); location.hash = '#/meter'; } }, 'Practise'),
            h('button', { class: 'ghost small', onclick: () => sendModal(`Send “${ex.name}”`, refsPayload(S, [ex.id])) }, 'Send'),
            h('button', { class: 'ghost small', onclick: async () => { const n = await ask('Rename exercise', 'Name', ex.name); if (n) { ex.name = n; commit(); render(); } } }, 'Rename'),
            h('button', { class: 'ghost small danger-text', onclick: async () => { if (await confirmBox('Delete exercise?', `“${ex.name}” and its ${ex.marks.length} marks will be removed from this device.`)) { S.exercises = S.exercises.filter(x => x.id !== ex.id); if (S.currentExerciseId === ex.id) S.currentExerciseId = null; commit(); render(); } } }, 'Delete'))),
        ex.marks.length
          ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Note'), h('th', { class: 'num' }, 'dB'), h('th', { class: 'num' }, 'Ring'), h('th', { class: 'num' }, 'Bright'), h('th', {}, 'Measured'), h('th', {}))), h('tbody', {}, rows))
          : h('p', { class: 'note' }, 'No marks yet. Choose this exercise on the Meter screen and press Mark this during a good note.'));
    });

    root.replaceChildren(
      h('div', { class: 'page-head' },
        h('h2', {}, 'Exercises'),
        h('div', { class: 'row wrap' },
          S.exercises.length ? h('button', { class: 'primary', onclick: () => sendModal('Send all exercises', refsPayload(S), 'Open this on your practice phone: point its camera at the code and open the link.') }, 'Send all to another device') : null,
          h('button', { class: 'ghost', onclick: importFilePicker }, 'Import file'))),
      h('p', { class: 'note' }, 'Numbers are shown in this device’s scale. Marks from another device are converted once you’ve calibrated the two devices together.'),
      ...(list.length ? list : [h('p', { class: 'empty' }, 'No exercises yet. Create one on the Meter screen, or receive them from your lesson device.')]));
  }
  render();
}
