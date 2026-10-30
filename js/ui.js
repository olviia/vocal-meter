// Tiny DOM helpers shared by the views.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

export const DISPLAY_OFFSET = 100; // dBFS + 100 → relative dB shown to the singer
export const fmtLevel = db => Number.isFinite(db) ? Math.round(db + DISPLAY_OFFSET).toString() : '–';
export const fmtSigned = (x, d = 0) => !Number.isFinite(x) ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d);
export const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

let toastTimer;
export function toast(msg, action) {
  const box = document.getElementById('toast');
  box.replaceChildren(h('span', {}, msg));
  if (action) box.append(h('button', { class: 'link', onclick: () => { action.run(); box.hidden = true; } }, action.label));
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 6000 : 3500);
}

export function modal(title, ...body) {
  const dlg = h('dialog', { class: 'modal' },
    h('header', {}, h('h2', {}, title), h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    ...body);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

export function ask(title, label, value = '') {
  return new Promise(resolve => {
    const input = h('input', { type: 'text', value, 'aria-label': label });
    const form = h('form', { method: 'dialog', class: 'stack' },
      h('label', { class: 'field' }, h('span', {}, label), input),
      h('div', { class: 'row end' }, h('button', { value: 'cancel', class: 'ghost', formnovalidate: true }, 'Cancel'), h('button', { value: 'ok', class: 'primary' }, 'Save')));
    const dlg = modal(title, form);
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null));
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function confirmBox(title, text, okLabel = 'Delete') {
  return new Promise(resolve => {
    const form = h('form', { method: 'dialog', class: 'stack' }, h('p', {}, text),
      h('div', { class: 'row end' }, h('button', { value: 'cancel', class: 'ghost' }, 'Cancel'), h('button', { value: 'ok', class: 'danger' }, okLabel)));
    const dlg = modal(title, form);
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'));
  });
}

export function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
