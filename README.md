# Vocal Meter

Loudness, pitch and resonance meter for singing practice. Installable web app (PWA), works offline, keeps all data on the device.

## Put it online (GitHub Pages, once)

1. On github.com, create a new **public** repository, e.g. `vocal-meter`.
2. **Add file → Upload files**, drag in everything from this folder (keep the `css`, `js`, `icons` folders), **Commit**.
3. **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, Branch *main*, folder */ (root)*, **Save**.
4. After a minute the app is at `https://<your-username>.github.io/vocal-meter/`.

Updating later: upload the changed files the same way. Installed copies pick up the new version on the next launch after that (sometimes the one after).

## Install

- **Phone (Chrome):** open the address, then menu ⋮ → **Install app** (or the Install button in the app’s header).
- **Laptop (Chrome or Edge):** open the address, click the install icon in the address bar.

## Set up each device (Setup tab)

1. Give the device a name (e.g. “Laptop”, “Phone”).
2. Start the microphone and check the browser processing flags show **off**.
3. Measure background noise in the room you’ll use.
4. Run the auto-gain test.

On the MSI laptop, before step 3: in **Nahimic** turn off all microphone effects, and in **Windows Settings → System → Sound → your microphone** turn **Audio enhancements** off and fix the input volume.

## Calibrate laptop → phone (Calibrate tab, once per setup)

Both devices side by side ~1 m away, both on Calibrate → Start recording, sing the 12 listed notes, Finish on both. On the laptop: **Send to practice device** and scan the QR code with the phone’s camera. The phone shows a verdict: reliable, usable with care, or not reliable (with the reason).

## In a lesson (laptop)

Meter tab → pick or create an exercise → when your teacher says “that’s it”, keep holding the note and press **Mark this** (or `M` / Space). Mark several pitches per exercise: targets are matched to the nearest marked note, because resonance changes with pitch and vowel.

Afterwards: Exercises → **Send all to another device** → scan with the phone.

## Practising (phone)

Meter tab → choose the exercise → sing. Each number shows a green target zone; the right-hand text says on target, or how far below/above you are. Keep the phone at the same distance and orientation as during calibration.

## What the numbers mean

- **Loudness** – relative dB (dBFS + 100), not a sound-level-meter reading.
- **Ring** – energy in ≈1.8–3.5 kHz (singer’s formant) vs ≈70 Hz–1.8 kHz, in dB. Higher = more ring.
- **Brightness** – energy above ≈1 kHz vs below (alpha ratio), in dB.

## Development

No build step. Serve the folder over `http://localhost` (e.g. `python3 -m http.server`) and open it in Chrome. Signal-processing and calibration tests: `node tests/run.mjs`.

QR encoder adapted from Project Nayuki’s QR Code generator (MIT).
