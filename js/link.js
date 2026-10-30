// Linking two devices and talking between them.
//
// Transport: a public pub/sub relay (ntfy.sh). It only ever sees scrambled data:
//  · Pairing: the lesson device shows a short code. Both devices meet on a channel derived from
//    that code, exchange public keys (ECDH P-256) and derive a shared 256-bit secret, mixed with
//    the code. Both confirm they hold the same secret before saving the link.
//  · Afterwards every message is AES-GCM encrypted with a key derived from that secret, on a
//    private channel whose name is also derived from it.
import { b64u, unb64u, deflate, inflate, uid } from './store.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const DEFAULT_RELAY = 'https://ntfy.sh';
export const relayBase = () => {
  try { return localStorage.getItem('vm-relay') || DEFAULT_RELAY; } catch (e) { return DEFAULT_RELAY; }
};

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

// ---------- relay ----------
export async function publish(topic, text) {
  const res = await fetch(`${relayBase()}/${topic}`, { method: 'POST', body: text });
  if (!res.ok) throw new Error(`Relay refused the message (${res.status})`);
}

// One-off fetch of everything on the topic since `sinceSec` (unix seconds).
export async function poll(topic, sinceSec) {
  const res = await fetch(`${relayBase()}/${topic}/json?poll=1&since=${Math.floor(sinceSec)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Relay error ${res.status}`);
  return (await res.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(m => m && m.event === 'message');
}

// Calls onText(text) once for every message on the topic since `sinceSec`.
// A live stream delivers messages instantly; because live streams can silently stall on some
// networks, the stream is also renewed every minute and the topic is polled as a backstop.
// Returns { close, refresh } — refresh() polls right away.
export function subscribe(topic, sinceSec, onText, onState) {
  const seen = new Set();
  let es = null, closed = false, last = Math.floor(sinceSec);
  const deliver = m => {
    if (m.event !== 'message' || seen.has(m.id)) return;
    seen.add(m.id);
    if (m.time) last = Math.max(last, m.time - 5);
    onText(m.message);
  };
  const open = () => {
    es?.close();
    es = new EventSource(`${relayBase()}/${topic}/sse?since=${last}`);
    es.onopen = () => onState?.('open');
    es.onerror = () => {
      onState?.('retrying');
      if (es.readyState === EventSource.CLOSED && !closed) setTimeout(() => { if (!closed) open(); }, 3000);
    };
    es.onmessage = e => { try { deliver(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
  };
  const refresh = async () => {
    if (closed) return;
    try { (await poll(topic, last)).forEach(deliver); } catch (e) { onState?.('offline'); }
  };
  open();
  const renew = setInterval(() => { if (!closed) open(); }, 60000);
  return { close: () => { closed = true; clearInterval(renew); es?.close(); }, refresh };
}

// ---------- crypto ----------
async function hkdf(secretBytes, info, salt = new Uint8Array(0)) {
  const k = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, k, 256));
}
async function msgKey(secretB64) {
  const raw = await hkdf(unb64u(secretB64), 'vm-msg-v1');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function linkTopic(secretB64) {
  return 'vm-' + (await sha256hex('vm-topic-v1:' + secretB64)).slice(0, 32);
}
export async function seal(secretB64, obj) {
  const key = await msgKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await deflate(enc.encode(JSON.stringify(obj)));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64u(out);
}
export async function unseal(secretB64, text) {
  const key = await msgKey(secretB64);
  const all = unb64u(text);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12));
  return JSON.parse(dec.decode(await inflate(new Uint8Array(pt))));
}
async function proof(secretB64, label) {
  const k = await crypto.subtle.importKey('raw', unb64u(secretB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(label)))).slice(0, 22);
}

// ---------- pairing ----------
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(r, b => ALPHA[b % ALPHA.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normalizeCode = s => {
  const c = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
};
const pairTopic = async code => 'vmpair-' + (await sha256hex('vm-pair-v1:' + code)).slice(0, 24);

async function keyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  return { kp, pub };
}
async function sharedSecret(kp, peerPubB64, code) {
  const peer = await crypto.subtle.importKey('raw', unb64u(peerPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, kp.privateKey, 256));
  return b64u(await hkdf(bits, 'vm-link-v1', enc.encode(code)));
}

const PAIR_TIMEOUT_MS = 5 * 60 * 1000;

// Lesson device: show the code, wait for the other device. Resolves with the link.
export async function hostPairing(code, me, { signal } = {}) {
  const topic = await pairTopic(code);
  const { kp, pub } = await keyPair();
  const nonce = uid();
  return new Promise((resolve, reject) => {
    let secret = null, guest = null, done = false;
    const finish = (err, val) => { if (done) return; done = true; sub.close(); clearInterval(poller); clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('No device joined within 5 minutes.')), PAIR_TIMEOUT_MS);
    signal?.addEventListener('abort', () => finish(new DOMException('Cancelled', 'AbortError')));
    const sub = subscribe(topic, Date.now() / 1000 - 5, async text => {
      try {
        const m = JSON.parse(text);
        if (m.t === 'hello' && !guest && m.host === nonce) {
          guest = m;
          secret = await sharedSecret(kp, m.pub, code);
          await publish(topic, JSON.stringify({ t: 'welcome', to: m.id, pub, id: me.id, name: me.name, proof: await proof(secret, 'host:' + m.id) }));
        } else if (m.t === 'ack' && guest && m.id === guest.id) {
          if (m.proof !== await proof(secret, 'guest:' + me.id)) return finish(new Error('The devices didn’t agree on a key — try again.'));
          finish(null, { peerId: guest.id, peerName: guest.name, secret, role: 'reference', at: Date.now() });
        }
      } catch (e) { /* ignore malformed traffic */ }
    });
    const poller = setInterval(() => sub.refresh(), 4000);
    // Announce ourselves so a guest who opened the channel first can reply to the right host.
    const announce = () => publish(topic, JSON.stringify({ t: 'host', nonce, pub })).catch(() => {});
    announce();
    const again = setInterval(() => { if (done) clearInterval(again); else if (!guest) announce(); }, 15000);
  });
}

// Practice phone: join with the code. Resolves with the link.
export async function joinPairing(code, me) {
  const topic = await pairTopic(code);
  const { kp, pub } = await keyPair();
  return new Promise((resolve, reject) => {
    let done = false, secret = null, asked = false;
    const finish = (err, val) => { if (done) return; done = true; sub.close(); clearInterval(poller); clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('The lesson device didn’t answer. Check the code is still on its screen.')), 60000);
    const sub = subscribe(topic, Date.now() / 1000 - 300, async text => {
      try {
        const m = JSON.parse(text);
        if (m.t === 'host' && !asked) {
          asked = true;
          await publish(topic, JSON.stringify({ t: 'hello', host: m.nonce, pub, id: me.id, name: me.name }));
        } else if (m.t === 'welcome' && m.to === me.id) {
          secret = await sharedSecret(kp, m.pub, code);
          if (m.proof !== await proof(secret, 'host:' + me.id)) return finish(new Error('The devices didn’t agree on a key — try again.'));
          await publish(topic, JSON.stringify({ t: 'ack', id: me.id, proof: await proof(secret, 'guest:' + m.id) }));
          finish(null, { peerId: m.id, peerName: m.name, secret, role: 'follower', at: Date.now() });
        }
      } catch (e) { /* ignore malformed traffic */ }
    });
    const poller = setInterval(() => sub.refresh(), 4000);
  });
}
