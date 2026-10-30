// Calibration exchange over the encrypted link, and turning two recordings into a result.
//
// Result (S.calibration), kept until a newer calibration succeeds:
//   follower (practice phone): conversion into the lesson device's numbers + verdict
//   reference (lesson device): verdict only — its own numbers are the scale everyone uses
import { S, commit } from './state.js';
import { segToWire, segFromWire } from './store.js';
import { alignSegments, fitCalibration } from './calibration.js';
import { linkTopic, subscribe, publish, seal, unseal } from './link.js';

export const VERDICT = { good: 'Reliable', fair: 'Usable with care', poor: 'Not reliable' };
const MATCH_WINDOW_S = 15 * 60;

export const sync = new EventTarget();
const emit = (type, detail) => sync.dispatchEvent(new CustomEvent(type, { detail }));

let closeSub = null;

export async function connect() {
  closeSub?.(); closeSub = null;
  if (!S.link) return;
  const topic = await linkTopic(S.link.secret);
  closeSub = subscribe(topic, Date.now() / 1000 - 2 * MATCH_WINDOW_S, async text => {
    let m;
    try { m = await unseal(S.link.secret, text); } catch (e) { return; } // not ours / tampered
    if (m.from === S.device.id) return;
    if (m.t === 'cal') {
      const at = m.at;
      if (S.peerSession && S.peerSession.at >= at) return;
      S.peerSession = { at, segments: m.s.map(segFromWire) };
      commit();
      emit('peer-data');
      tryCompute();
    } else if (m.t === 'unlink' && S.link && m.from === S.link.peerId) {
      dropLink();
      emit('unlinked', { byPeer: true });
    }
  }, state => emit('relay', state));
}

export async function send(obj) {
  if (!S.link) throw new Error('Not linked');
  await publish(await linkTopic(S.link.secret), await seal(S.link.secret, { ...obj, from: S.device.id }));
}

export async function shareOwnRecording() {
  const own = S.calSession;
  await send({ t: 'cal', at: own.at, s: own.segments.map(segToWire) });
}

function dropLink() {
  closeSub?.(); closeSub = null;
  S.link = null; S.peerSession = null;
  commit();
}
export async function unlink() {
  try { await send({ t: 'unlink' }); } catch (e) { /* the other side can unlink itself */ }
  dropLink();
}

// Compute when both recordings are present and were made at about the same time.
export function tryCompute() {
  const own = S.calSession, peer = S.peerSession, link = S.link;
  if (!own || !peer || !link) return;
  if (Math.abs(own.at - peer.at) > MATCH_WINDOW_S) return;
  const basedOn = `${own.at}:${peer.at}`;
  if (S.calibration?.basedOn === basedOn) return;

  const isRef = link.role === 'reference';
  const [src, dst] = isRef ? [own, peer] : [peer, own];
  const fit = fitCalibration(alignSegments(src.segments, dst.segments));
  if (!fit.ok) { emit('failed', { reason: fit.reason }); return; }

  S.calibration = {
    role: link.role, peerName: link.peerName, at: Date.now(), basedOn,
    verdict: fit.verdict, stats: fit.stats, problems: fit.problems,
    ...(isRef ? {} : { level: fit.level, bandOffset: fit.bandOffset }),
  };
  commit();
  emit('synced', S.calibration);
}
