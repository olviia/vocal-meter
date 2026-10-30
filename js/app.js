import { h } from './ui.js';
import { engine } from './engine.js';
import { S } from './state.js';
import { meterView } from './views/meter.js';
import { calibrateView } from './views/calibrate.js';
import { importFromHash } from './transfer.js';

const ROUTES = {
  meter: ['Meter', meterView],
  calibrate: ['Calibrate', calibrateView],
};

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let cleanup = null;

function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const key = ROUTES[name] ? name : 'meter';
  cleanup?.();
  main.replaceChildren();
  cleanup = ROUTES[key][1](main) || null;
  for (const a of nav.querySelectorAll('a')) a.toggleAttribute('aria-current', a.dataset.route === key);
}

nav.replaceChildren(...Object.entries(ROUTES).map(([k, [label]]) => h('a', { href: `#/${k}`, 'data-route': k }, label)));

engine.setNoise(S.noise);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && engine.running) engine.wake(); });

let installEvt = null;
const installBtn = document.getElementById('install');
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; installBtn.hidden = false; });
installBtn.addEventListener('click', async () => { installBtn.hidden = true; await installEvt?.prompt(); installEvt = null; });
addEventListener('appinstalled', () => { installBtn.hidden = true; });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});

addEventListener('hashchange', async () => { if (!(await importFromHash())) route(); });
(async () => { await importFromHash(); route(); })();
