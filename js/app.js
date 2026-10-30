import { engine } from './engine.js';
import { S } from './state.js';
import { connect } from './sync.js';
import { normalizeCode } from './link.js';
import { mount } from './main.js';

engine.setNoise(S.noise);
const ui = mount(document.getElementById('main'));
try { sessionStorage.removeItem('vm-reloaded'); } catch (e) { /* not critical */ }

// The meter is always on while the app is open.
async function listen() {
  engine.error = '';
  try { await engine.start(); }
  catch (e) {
    engine.error = e.name === 'NotAllowedError'
      ? 'Microphone access is blocked. Allow it for this site in the browser settings, then reopen the app.'
      : `Microphone unavailable: ${e.message}`;
  }
}
listen();
const wake = () => { if (!engine.running) listen(); else engine.resume(); };
addEventListener('pointerdown', wake);
addEventListener('keydown', wake);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') engine.stop();
  else { listen(); engine.wake(); }
});

// Linked devices stay connected to their private channel while the app is open.
connect();

// Opened from the link QR code on the lesson device.
const m = location.hash.match(/^#pair=([A-Za-z0-9-]+)/);
if (m) {
  history.replaceState(null, '', location.origin + location.pathname);
  const code = normalizeCode(m[1]);
  if (code) ui.enterCode(code);
}

let installEvt = null;
const installBtn = document.getElementById('install');
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; installBtn.hidden = false; });
installBtn.addEventListener('click', async () => { installBtn.hidden = true; await installEvt?.prompt(); installEvt = null; });
addEventListener('appinstalled', () => { installBtn.hidden = true; });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
