# AE-08 song v2: "Macros - Coming Soon" score

The second score for the 29-second trailer `coming-soon.mp4`, made in the packaged DAW. It improves on v1 in melody, rhythm and sound, and it was made in one continuous screen-recorded session. No error dialog, failure notice or failed operation appears in it.

## Deliverables

| File | What it is |
| --- | --- |
| `coming-soon-scored-v2.mp4` | The trailer with the v2 score: H.264 video copied unchanged, AAC 256 kb/s, 29.000 s |
| `macros-coming-soon-score-v2.wav` | The DAW's export (0 to 29 s), with no post-processing: 48 kHz, 24-bit, stereo, 1,392,000 frames, -12.3 LUFS integrated, sample peak at the -1 dBTP limiter ceiling |
| `screen-recording.mkv` | The whole session, 75.6 s: File > New Project, imports, building the song (edits made during playback), a full playback, and the export |
| `session.log`, `renderer-console.log`, `renderer-errors.log` | The session's step log; the renderer console (export progress only, no errors or warnings); no page errors |
| `shot-*.png`, `spectrogram.png` | Screenshots at each step; spectrogram of the score |
| `scripts/` | `gen-samples.ts` (one-shot synthesis), `song2.ts` (the arrangement and mix as control-platform steps), `session.sh` and `record.sh` (the recorded run) |
| `attempt-1/` | The first recorded run. It is rejected, because the projects dashboard stayed open over the timeline (fixed in `3ebe5b66`) |

The repository holds this report, the spectrogram, the scripts and the session logs. The audio, video, screenshots and the rejected attempt stay on the machine that made them, identified by these hashes.

SHA-256:
- `macros-coming-soon-score-v2.wav` `7c0e75dde6ccde3b5c1c1a14a4faebfe2e69da0aa3d4c05fca041b0ffb4a476b`
- `coming-soon-scored-v2.mp4` `98fb4e9f02e7615a2f353d736d7860de237c47f545c24398271b1e7793f8c82b`
- `screen-recording.mkv` `9d32a51f70c931c98f0c49f6bf7a484a234a6a7ddf0bb3c484714c2c8108c008`

## What changed from v1

The music:
- **Harmony.** A royal-road progression (Fmaj9, G6, Em7, Am7, with Dm9, Gsus and G7 in the bridge). It holds the tonic back until the end card lands on Cadd9. v1 cycled C, G, Am and F.
- **Melody.** A hook on its own Lead synth: a statement in Search, an answer in Scan, a higher chorus in Rings, a variation in Track, and a sparse glance line, rising to C6 on the end card. A bell sampler opens the score with a broken chord and doubles the chorus an octave up.
- **Rhythm.** Four-on-the-floor kick from Search on. The backbeat is a clap layered with a quiet snare, with ghost notes. A separate percussion rack carries a 16th-note shaker with accents, hats with open-hat lifts, and rim ticks in Track. Snare rolls and fills lead into each section. The bass uses syncopated patterns (sparse, driving, and eighth-note pumps in the chorus), and a frozen arp plays 16ths in a 3-3-2 accent pattern. Velocities and some timing are humanized, and the result is the same on every run.
- **Sections follow the trailer's cuts.** A riser leads into Search, short risers into Rings and Track, and reverse swells into the glance, "Scan. Done." and the end card. There are impacts and crashes on the hits, and the "Macros. Coming soon." voice tag on the end card.

The sound:
- **New one-shots.** Kick, snare, clap, metallic hats, shaker, rim, crash, risers, swells, an impact and a bell. All are synthesized with proper envelopes and filters (`scripts/gen-samples.ts`).
- **Synth patches.** Detuned saw pads with a slow filter envelope and noise, a triangle and saw lead with filter key tracking, an airy layer, a saw and sine bass, and a plucky arp. There are two returns, Reverb and a quarter-note ping-pong Echo, and a master EQ, glue compressor and -1 dBTP limiter.
- **Engine fixes.** Part of why v1's synths sounded rough was the engine, not the patches, so these were fixed (next section).

## Product fixes (branch `synth-dsp-quality`, on top of `pr62-cleanup`)

| Commit | Fix |
| --- | --- |
| `646fc35d` | **Band-limited oscillators.** Synth saw and square oscillators were naive shapes. A 1760 Hz saw had its alias energy only 19 dB under the harmonics. With polyBLEP correction it is -53 to -63 dB from 110 Hz to 1760 Hz, and the level is within 0.5 dB. |
| `fcef4611` | **Diffuse reverb.** The reverb tail was one feedback delay line, which made a metallic echo train every 20 to 100 ms. It is now an eight-line Hadamard feedback delay network with allpass input diffusion. Echo density went from 0.004 to 0.95, periodicity from 0.73 to 0.16, and left/right correlation from 1.0 to 0.13. The parameters and wire format are unchanged, and the browser worklet mirrors it. |
| `0fd3e1ba` | **Limiter release.** The limiter released its gain during the lookahead, so 80 samples per export went over the ceiling, by up to 0.22 dB. It now holds the sliding minimum of its targets through the lookahead. |
| `a2b3bc82` | **Limiter detector.** The detector's four FIR phases never land on an input sample, so a peak on a sample could be read 0.24 dB low. The detector now also includes the two raw samples it interpolates between. The export now has no sample over the ceiling; one sample sits exactly on it, after 24-bit rounding. |
| `7397ebf9` | **Export refusals.** A refused export reached the client as "The renderer is unavailable." For example, a stems request on the native path, or an output file that already exists. It now gets the real reason, such as "Native desktop stems are unavailable in Phase A; choose Main mixdown." or "The output path already exists." |
| `3ebe5b66` | **New Project.** File > New Project left the projects dashboard open over the new project's timeline. Found while reviewing the first recording. |

Each engine fix has a test that failed first, through the public core API. Validation at the final tree:
- audio-core ctest 18/18, plus the sanitized (ASan+UBSan) run;
- the wasm artifact rebuilt and validated;
- `bun --conditions=browser test` on audio-core, audio-engine, shared and desktop: 1542 pass, 0 fail;
- typecheck: no new errors;
- lint: 0 warnings, 0 errors.

## How the recording was checked

- **Frames.** Every second of the recording was viewed on contact sheets. The only transient UI is the export progress notice ("Timeline mixdown: Rendering…" through 100%), which closes on its own. The renderer console has no errors or warnings, and there are no page errors.
- **Session.** Every `daw-control` call in the session returned ok, and the export completed.
- **Export.**
  - No sample is over -1 dBFS.
  - Each one-second window sits between -11 and -22 dB RMS, with no gaps.
  - Band balance (RMS): sub -21, low -18, low-mid -20, mid -23, high -30, air -32 dB.

## Known limits

- Native desktop export has no stems yet ("Phase A"). The export dialog disables them, and the host protocol now says why.
- The recording shows control-platform edits landing in the UI. The mouse is not driving the UI.
- The engine changes are not recertified yet. FAST-CERT expectations and the packaged AE-08 phase 8/9 runs need a bless and rerun before this branch merges.
