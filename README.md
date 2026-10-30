# Vocal Meter

Loudness and resonance meter for singing practice — one screen, always listening. Installable web app (PWA), works offline; calibration data stays on each device.

Live at **https://olviia.github.io/vocal-meter/**

## Use

- **Loudness** and **Resonance** ride up and down their scales like a tuner. Yellow while you sing, grey when you stop.
- **Link a device** (once): on the laptop choose *lesson device — show code*; on the phone scan the QR code or choose *practice phone — enter code*. Each side then shows *Linked to …* with **Unlink**.
- **Calibrate**: press it on both devices, placed side by side ~1 m away. Stay quiet for 3 s, then sing the 12 notes the button asks for (~3 s each, a breath between). The button fills as notes are captured; when both recordings are processed a **✓ Synced** badge appears (tap it for details).
- The phone then shows the laptop’s numbers. The latest successful calibration is used on every launch until you recalibrate; before the first one, the built-in default (raw readings) applies.

On the MSI laptop first switch off microphone effects in **Nahimic** and **Audio enhancements** in Windows sound settings.

## How the devices talk

GitHub Pages only serves files, so messages go through the public relay **ntfy.sh**. Pairing uses an ECDH key exchange mixed with the 8-character code; afterwards every message is AES-GCM encrypted with the shared key on a private channel derived from it, so the relay only carries scrambled data. Only per-note acoustic summaries are sent (≈1.5 KB per calibration). The results are computed and stored on each device (browser storage), never in the cloud.

## What the numbers mean

- **Loudness** – relative dB (dBFS + 100), not a sound-level-meter reading.
- **Resonance** – energy in ≈1.8–3.5 kHz (singer’s formant) vs ≈70 Hz–1.8 kHz, in dB, +40 so it reads positive. Higher = more ring. Varies with vowel and pitch.

## Development

No build step: `python3 -m http.server`, open in Chrome. Tests: `node tests/run.mjs`. To use another ntfy-compatible relay, set `localStorage['vm-relay']`.

QR encoder adapted from Project Nayuki’s QR Code generator (MIT).
