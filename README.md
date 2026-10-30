# Vocal Meter

Loudness and resonance meter for singing practice. Installable web app (PWA): works offline, keeps all data on the device.

Live at **https://olviia.github.io/vocal-meter/**

## Screens

- **Meter** – two numbers side by side, Loudness and Resonance, each riding up and down its own scale like a tuner. Grey = not singing (last value held).
- **Calibrate** – makes the practice phone show the numbers the lesson device would show. The latest calibration is saved and used on every launch; **Recalibrate** replaces it.

## Calibrating (once, or whenever the setup changes)

1. Laptop and phone side by side, about 1 m from you, both on **Calibrate**.
2. Press **Start** on both. Stay silent 3 s (room noise is measured), then sing the 12 listed notes on one comfortable pitch, ~3 s each with a breath of silence between.
3. Press **Finish** on both. On the laptop press **Send to phone** and scan the QR code with the phone’s camera (or use Copy link / Save as file).
4. The phone shows the verdict: Reliable, Usable with care, or Not reliable (with the reason).

On the MSI laptop first switch off microphone effects in **Nahimic** and **Audio enhancements** in Windows sound settings.

Practising in a different room: **Calibrate → Re-measure room noise**.

## What the numbers mean

- **Loudness** – relative dB (dBFS + 100), not a sound-level-meter reading.
- **Resonance** – energy in ≈1.8–3.5 kHz (singer’s formant) vs ≈70 Hz–1.8 kHz, in dB, shifted by +40 so it reads as a positive number. Higher = more ring. It varies with vowel and pitch, so compare like with like.

## Development

No build step. `python3 -m http.server` in this folder, open in Chrome. Tests: `node tests/run.mjs`.

QR encoder adapted from Project Nayuki’s QR Code generator (MIT).
