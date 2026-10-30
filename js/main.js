// The single screen: always-on meter, Calibrate button, link status.
import { h, toast, modal, fmtDate, DISPLAY_OFFSET } from './ui.js';
import { engine, recordFor } from './engine.js';
import { summarize, median, NB } from './dsp.js';
import { CAL_STEPS, detectSegments, toReferenceScale } from './calibration.js';
import { encodeQR, qrToSvg } from './qr.js';
import { S, commit, onChange } from './state.js';
import { newCode, normalizeCode, hostPairing, joinPairing } from './link.js';
import { sync, connect, unlink, shareOwnRecording, tryCompute, sameSession, refresh as refreshRelay, VERDICT } from './sync.js';

const RES_OFFSET = 40; // resonance shown = singer's-formant ratio (dB) + 40
const appUrl = () => location.origin + location.pathname;

// ---------- meter columns ----------
function column(label, [lo, hi], step) {
  const num = h('span', { class: 'num' }, '–');
  const marker = h('div', { class: 'marker' }, num);
  const ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(h('span', { class: 'tick', style: { bottom: `${((v - lo) / (hi - lo)) * 100}%` } }, String(v)));
  const el = h('section', { class: 'col idle' }, h('h2', { class: 'col-label' }, label), h('div', { class: 'track' }, ...ticks, marker));
  let shown = NaN;
  return {
    el,
    set(v, live, dim) {
      el.classList.toggle('idle', !live);
      el.classList.toggle('dim', !!dim);
      if (!Number.isFinite(v)) return;
      shown = Number.isFinite(shown) ? shown + (v - shown) * 0.3 : v;
      marker.style.bottom = `${Math.max(0, Math.min(1, (shown - lo) / (hi - lo))) * 100}%`;
      num.textContent = Math.round(shown).toString();
    },
  };
}

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

export function mount(root) {
  const loud = column('Loudness', [30, 110], 10);
  const res = column('Resonance', [0, 40], 5);
  const status = h('p', { class: 'status', hidden: true });
  const chip = h('button', { class: 'chip', hidden: true, onclick: () => showDetails() });
  const calLabel = h('span', { class: 'cal-label' }, 'Calibrate');
  const fillLabel = h('span', { class: 'cal-label' }, 'Calibrate');
  const calBtn = h('button', { class: 'cal-btn', onclick: () => onCalibrate() }, calLabel, h('span', { class: 'fill', 'aria-hidden': 'true' }, fillLabel));
  const cancelBtn = h('button', { class: 'link small', hidden: true, onclick: () => calRun?.cancel() }, 'Cancel calibration');
  const linkLine = h('div', { class: 'link-line' });

  document.getElementById('chip-slot').replaceChildren(chip);
  root.replaceChildren(h('div', { class: 'columns' }, loud.el, res.el), status, calBtn, cancelBtn, linkLine);

  // ---------- link line & chip ----------
  function renderLink() {
    linkLine.replaceChildren(S.link
      ? h('p', { class: 'note' }, `Linked to ${S.link.peerName}`, ' · ', h('button', { class: 'link small', onclick: onUnlink }, 'Unlink'))
      : h('button', { class: 'ghost small', onclick: openLinkChooser }, 'Link a device'));
    const c = S.calibration;
    chip.hidden = !c;
    if (c) {
      chip.className = `chip v-${c.verdict}`;
      chip.replaceChildren(h('span', { class: 'chip-icon', 'aria-hidden': 'true' }, c.verdict === 'good' ? '✓' : '!'), c.verdict === 'good' ? 'Synced' : `Synced · ${VERDICT[c.verdict].toLowerCase()}`);
      chip.setAttribute('aria-label', `Synced with ${c.peerName}: ${VERDICT[c.verdict]}. Show details.`);
    }
    if (!calRun) setCal(0, S.link ? (c ? 'Recalibrate' : 'Calibrate') : 'Calibrate');
  }

  async function onUnlink() {
    await unlink();
    toast('Unlinked. Your last calibration stays in use.');
    renderLink();
  }

  function showDetails() {
    const c = S.calibration;
    if (!c) return;
    const s = c.stats;
    modal(`Synced with ${c.peerName}`,
      h('p', { class: `verdict v-${c.verdict}` }, VERDICT[c.verdict]),
      c.problems.length ? h('ul', { class: 'problems' }, c.problems.map(p => h('li', {}, p[0].toUpperCase() + p.slice(1) + '.'))) : null,
      h('ul', { class: 'facts' },
        h('li', {}, c.role === 'follower' ? `This device shows ${c.peerName}’s numbers.` : `This is the reference device; ${c.peerName} shows this device’s numbers.`),
        h('li', {}, `Loudness within about ±${Math.max(0.5, s.levelErr).toFixed(1)} dB, resonance within ±${Math.max(0.5, s.ringErr).toFixed(1)}.`),
        h('li', {}, `Volume tracking ${s.slope.toFixed(2)} (1.00 = both mics follow volume equally).`),
        h('li', {}, `Covers ${Math.round(s.rangeLo + 100)}–${Math.round(s.rangeHi + 100)} dB; numbers outside that are dimmed.`),
        h('li', {}, `${s.pairs} notes matched · ${fmtDate(c.at)}`)),
      c.verdict === 'poor' ? h('p', { class: 'note' }, 'On the Windows laptop: switch off microphone effects in Nahimic and Audio enhancements in Windows sound settings, keep the fans quiet, then recalibrate.') : null);
  }

  // ---------- linking ----------
  function openLinkChooser() {
    const dlg = modal('Link a device',
      h('p', { class: 'note' }, 'Link the lesson device (laptop) with the practice phone once. After that, Calibrate on both is all it takes.'),
      h('div', { class: 'stack' },
        h('button', { class: 'primary', onclick: () => { dlg.close(); showCode(); } }, 'This is the lesson device — show code'),
        h('button', { class: 'ghost', onclick: () => { dlg.close(); enterCode(); } }, 'This is the practice phone — enter code')));
  }

  function showCode() {
    const code = newCode();
    const ctrl = new AbortController();
    const waiting = h('p', { class: 'note' }, 'Waiting for the phone…');
    const dlg = modal('Link code',
      h('p', { class: 'note' }, 'On the phone: scan this with the camera, or open the app and type the code.'),
      h('div', { class: 'qr', html: qrToSvg(encodeQR(`${appUrl()}#pair=${code}`)) }),
      h('p', { class: 'code' }, code),
      waiting);
    dlg.addEventListener('close', () => ctrl.abort());
    hostPairing(code, S.device, { signal: ctrl.signal })
      .then(link => linked(link, dlg))
      .catch(e => { if (e.name !== 'AbortError') waiting.textContent = e.message; });
  }

  function enterCode(prefill = '') {
    const input = h('input', { type: 'text', value: prefill, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXX-XXXX', 'aria-label': 'Link code', class: 'code-input' });
    const msg = h('p', { class: 'note' }, 'Type the code shown on the lesson device.');
    const go = h('button', { class: 'primary', onclick: () => join() }, 'Link');
    const dlg = modal('Enter link code', input, msg, go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
    async function join() {
      const code = normalizeCode(input.value);
      if (!code) { msg.textContent = 'The code has 8 letters and digits, like K7P2-QX9M.'; return; }
      go.disabled = true; msg.textContent = 'Linking…';
      try { linked(await joinPairing(code, S.device), dlg); }
      catch (e) { msg.textContent = e.message; go.disabled = false; }
    }
    if (prefill) join();
  }

  async function linked(link, dlg) {
    if (S.link && S.link.peerId !== link.peerId) await unlink();
    S.link = link;
    commit();
    dlg.close();
    toast(`Linked to ${link.peerName}`);
    await connect();
    renderLink();
  }

  // ---------- calibration ----------
  let calRun = null;
  function setCal(p, label) {
    calBtn.style.setProperty('--p', String(p));
    calLabel.textContent = label;
    fillLabel.textContent = label;
  }

  function onCalibrate() {
    if (calRun) return;
    if (!S.link) { openLinkChooser(); return; }
    runCalibration();
  }

  async function runCalibration() {
    let cancelled = false, rec = null, timer = null;
    const peer = S.link.peerName;
    calRun = { cancel: () => { cancelled = true; } };
    calBtn.classList.add('busy');
    cancelBtn.hidden = false;
    const end = (msg, ok) => {
      clearInterval(timer);
      if (rec) engine.recorders.delete(rec);
      calRun = null;
      calBtn.classList.remove('busy');
      cancelBtn.hidden = true;
      if (msg) toast(msg);
      if (!ok) renderLink();
    };
    try { await engine.start(); } catch (e) { end(`Microphone didn’t start: ${e.message}`); return; }

    // 1 · room noise
    const okNoise = await measureNoise(el => setCal(0.08 * el / 3, `Quiet please… ${Math.max(1, Math.ceil(3 - el))}`));
    if (cancelled) return end('Calibration cancelled');
    if (!okNoise) return end('The microphone gave no audio.');

    // 2 · twelve notes
    rec = [];
    engine.recorders.add(rec);
    const at = Date.now() / 1000, t0 = performance.now();
    const segments = await new Promise(resolve => {
      timer = setInterval(() => {
        if (cancelled) return resolve(null);
        const segs = detectSegments(rec);
        const n = Math.min(segs.length, 12);
        const step = CAL_STEPS[Math.min(n, 11)];
        const otherDone = S.peerSession && S.peerSession.at > at - 120 ? ` · ${peer} done ✓` : '';
        setCal(0.08 + 0.84 * (n / 12), (n < 12 ? `Note ${n + 1} of 12 · “${step.vowel}” ${step.level}` : 'Got all 12 notes') + otherDone);
        const last = rec.at(-1), lastVoiced = rec.findLast(f => f.voiced);
        const quietFor = last && lastVoiced ? last.t - lastVoiced.t : 0;
        const elapsed = (performance.now() - t0) / 1000;
        if ((segs.length >= 12 && quietFor > 1.2) || elapsed > 150) resolve(segs);
      }, 200);
    });
    clearInterval(timer);
    engine.recorders.delete(rec);
    if (cancelled || !segments) return end('Calibration cancelled');
    if (segments.length < 6) return end(`Only ${segments.length} notes were heard — try again, holding each note about 3 seconds.`);

    S.calSession = { at, segments };
    commit();

    // 3 · exchange: send ours, wait for theirs, compare.
    // Each device sends its 12 note summaries (encrypted) through the relay. The phone can only
    // be converted once both are in, so whoever finishes first waits for the other — up to 3 min.
    const WAIT_MS = 3 * 60 * 1000;
    const before = S.calibration ? S.calibration.at : 0;
    const peerHere = () => sameSession(S.calSession, S.peerSession);
    let sent = false;
    const result = await new Promise(resolve => {
      const t0w = Date.now();
      const onFailed = e => done('failed', e.detail.reason);
      sync.addEventListener('failed', onFailed);
      const tick = setInterval(() => {
        if (cancelled) return done('cancelled');
        if (S.calibration && S.calibration.at > before) return done('synced');
        const left = Math.max(0, WAIT_MS - (Date.now() - t0w));
        if (!left) return done('timeout');
        const mmss = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
        if (!sent) setCal(0.93, 'Sending your notes…');
        else if (!peerHere()) setCal(0.95, `Sent ✓ · waiting for ${peer}’s notes · ${mmss}`);
        else setCal(0.98, 'Comparing both recordings…');
      }, 250);
      const ask = setInterval(() => { refreshRelay(); tryCompute(); }, 4000);
      function done(kind, reason) {
        clearInterval(tick); clearInterval(ask);
        sync.removeEventListener('failed', onFailed);
        resolve({ kind, reason });
      }
      shareOwnRecording()
        .then(() => { sent = true; refreshRelay(); tryCompute(); })
        .catch(e => done('offline', e.message));
    });
    if (result.kind === 'synced') {
      setCal(1, 'Synced ✓');
      end(null, true);
      setTimeout(renderLink, 2500);
    } else if (result.kind === 'failed') end(`Calibration didn’t work: ${result.reason} Both devices must hear the same singing — try again.`);
    else if (result.kind === 'timeout') end(`${peer}’s notes didn’t arrive within 3 minutes. Make sure Calibrate was pressed on ${peer} too and it finished its 12 notes, then try again.`);
    else if (result.kind === 'offline') end(`Couldn’t send your notes: ${result.reason}. Check the internet connection and try again.`);
    else end('Calibration cancelled');
  }

  // ---------- live loop ----------
  let raf;
  function frame() {
    raf = requestAnimationFrame(frame);
    const c = S.calibration && S.calibration.role === 'follower' ? S.calibration : null;
    let msg = '';
    if (engine.error) msg = engine.error;
    else if (engine.running && !engine.listening) msg = 'Tap anywhere to start listening.';

    if (!engine.listening || !engine.latest) {
      loud.set(NaN, false); res.set(NaN, false);
    } else {
      const recent = engine.recent(0.4);
      const voiced = recent.filter(f => f.voiced);
      const live = voiced.length >= 3 && engine.latest.t - voiced.at(-1).t < 0.3;
      const sum = live ? summarize(recent) : null;
      // While you sing: live values. Between notes: the last sung values stay, greyed out —
      // background noise is never shown as a reading.
      let level = NaN, ring = NaN, out = false;
      if (live) {
        level = sum.level; ring = sum.ring;
        if (c) { const r = toReferenceScale(c, sum); level = r.level; ring = r.ring; out = r.outOfRange; }
      }
      loud.set(level + DISPLAY_OFFSET, live, out);
      res.set(ring + RES_OFFSET, live, out);
      const last3 = engine.recent(3);
      const dead = last3.length > 100 && last3.every(f => f.levelDb < -150);
      const gated = last3.length > 60 && last3.filter(f => f.levelDb < -150).length > last3.length * 0.2;
      if (dead) msg = `No sound from “${engine.trackLabel || 'the microphone'}”. In the browser’s site settings choose the real microphone (e.g. Microphone Array), then reopen the app.`;
      else if (engine.recent(1).some(f => f.peak >= 0.98)) msg = 'Too loud for the mic — move it further away.';
      else if (gated) msg = 'This microphone switches itself off between sounds (a noise gate). Turn off noise suppression / noise gate in Nahimic or the Realtek audio settings — it distorts soft notes.';
      else if (out) msg = 'Louder or softer than the calibration covered — numbers are approximate.';
    }
    status.textContent = msg;
    status.hidden = !msg;
  }
  raf = requestAnimationFrame(frame);

  sync.addEventListener('unlinked', () => { toast('The other device unlinked.'); renderLink(); });
  sync.addEventListener('synced', () => { if (!calRun) renderLink(); });
  onChange(() => { if (!calRun) renderLink(); });
  renderLink();

  return { enterCode };
}
