# AE-08 song: "Macros - Coming Soon" score

An end-to-end check of the AE-08 desktop runtime. I scored the 29-second trailer
`coming-soon.mp4` (1080x1920, 30 fps, no audio) with the packaged DAW. Every edit went through the public control
tools (the `daw-control` CLI: discovery, snapshot, preview, approval, keyed commit), and transport, recording, and
export went through the desktop runtime protocol. The packaged app was screen-recorded for the whole session.

## Deliverables

| File | What it is |
| --- | --- |
| `coming-soon-scored.mp4` | The trailer with the score: H.264 video copied unchanged, AAC 256 kb/s, 29.000 s |
| `macros-coming-soon-score.wav` | The score, exported by the DAW (range 0 to 29 s) with no post-processing: 48 kHz, 24-bit, stereo, exactly 1,392,000 frames (29.000 s), -13.4 LUFS integrated, -1.5 dBFS peak |
| `daw-export-before-latency-fix-0-29.25s.wav` | Evidence for finding 5: the same project exported by the package built before `b6b60b12`, which starts 10,480 frames late |
| `spectrogram.png` | Spectrogram of the score |
| `screen-recording.mkv` | The packaged app for the song session: 39 min 38 s, 1512x978 H.264 (not for git, 280 MB). It ends before the latency fix; the final export ran on the rebuilt package at `1706c4b4` |

Only this report and the spectrogram are in the repository. The audio, the video and the recording stay on the machine that made them, identified by these hashes.

SHA-256:
- `macros-coming-soon-score.wav` `dcdd04185403927c2fbe439cceaa9fb3d408cddd7b41596a6f93344ba3c604dc`
- `daw-export-before-latency-fix-0-29.25s.wav` `02e16291cbd7e27b9c045ab2c7db0d530678760b1956eef1650b308dfa63d02a`
- `coming-soon-scored.mp4` `1d513b9092d2e4a40ddc39c6115075150db904a0d118f706b3ef4c2037030c6a`
## The project

Project "Macros - Coming Soon (score)", 120 BPM, with a loop over 0 to 29 s. The arrangement follows the trailer's
cuts on a 0.1 s + half-beat grid.

| Track | Source | Devices |
| --- | --- | --- |
| Impact | audio, 3 impact hits (11.6 s, 24.1 s, 26.1 s) | Reverb |
| Drums | Drum Rack (kick 36, snare 38, clap 39, closed hat 42, open hat 46) | LoFi (mix automated) |
| Bass | Synth | Saturator, Compressor, Utility |
| Pad | Synth | EQ Eight, Auto Filter (frequency automated), Ensemble, Tremolo |
| Pluck | Sampler (pluck zone) | Chorus, Delay (dry/wet automated) |
| Arp | Synth; an Arpeggiator played it live, then was frozen to notes (finding 4) | Flanger, Auto Pan |
| Texture | Granular | Spectral (blur automated), Phaser, ValhallaSupermassive VST3 inserted live (Mix 0.45, Feedback 0.7, Width 1) |
| Voice | audio, recorded live: "Macros. Coming soon." from BlackHole 2ch | Gate, EQ Eight |
| Space | return; sends from Impact 0.25, Pad 0.35, Pluck 0.4, Arp 0.3, Voice 0.3 | |
| Master | | Limiter |

Coverage:
- All 17 built-in audio effects, each inserted and tuned at least once.
- The Arpeggiator MIDI effect.
- Four built-in instruments (Synth, Drum Rack, Sampler, Granular).
- One certified VST3 (ValhallaSupermassive), inserted and edited during playback.
- Four automation lanes.
- Live edits during playback: routing, effect parameters, clip moves, the arpeggiator freeze.
- A recorded take, moved into place on the arrangement.
- A mixdown export.

How the result was checked:
- The score is the export from the package rebuilt at `1706c4b4`, with no trim or other processing.
  - From frame 0 onward it is sample-identical to the pre-fix render read from 10,480 frames in: the residual
    is 2.3e-16 relative.
  - So the fixed export drops exactly the engine's accounted graph latency and changes nothing else.
- The voice take and two impact hits were cross-correlated against the score. They land at 27.0595 s (placed at
  27.06 s), 24.0992 s (placed at 24.1 s), and 26.0993 s (placed at 26.1 s). For the 0.5 to 0.8 ms residual, see
  finding 8.
- Every one-second window has signal: mean level -14 to -20 dB, no silence below -50 dB lasting 0.5 s or longer.
## Product bugs found and fixed

1. `e6820371` fix(timeline): a grid-aligned placement never snaps to a negative start.
   - Importing at playhead 0 onto a track that already had a clip at 0 placed the snare at -0.35 s.
   - After that, every control snapshot failed schema validation.
   - `calcNonOverlapStartGridAligned` now only snaps to an edge at or after 0.
2. `c795a349` fix(effects): an EQ always has eight bands.
   - Committing a 3-band EQ crashed the renderer ("Portable EQ requires exactly eight bands").
   - `normalizeEqParams` now always returns eight bands. Given bands keep their slots, missing slots get defaults,
     and bands past eight are dropped.
3. `247811e2` fix(mixer): a send stored without a tap is compensated as post-fader.
   - Stored sends have no tap. The timing plan keyed their delay as `post-fader`, but the graph contract looked it
     up with the missing tap, so every such send got 0 frames of compensation.
   - When two sends with different source latencies met at one return (Pad has 6 frames of latency), the native
     core rejected the graph (`audio_core.cpp` pdc check). The live edit kept the old graph, and the next Play
     failed: "Native playback stopped … rejected graphSnapshot request 4" (screen recording, about 25 min in).
   - `mixerRouteKey` now applies the post-fader default itself.
   - Diagnosed from an lldb dump of the graph bytes and an instrumented core harness.
   - New test in `graph-contract.test.ts`: it fails without the fix and passes with it.
   - After rebuilding the package, a fresh Play with all five sends worked, and the host logged no rejected
     publication for the rest of the session.

4. `b6b60b12` fix(export): an export starts on the timeline, not one graph latency late (finding 5).
5. `c4847f0e`, `1706c4b4` fix(lint): the 5 errors and 17 warnings that PR 62's phase 5 commit (`22321b83`)
   introduced. `bun run lint` (with `--deny-warnings`) failed on the pushed PR and now reports 0 warnings and
   0 errors.
   - The instrument effect row is built without conditional empty spreads.
   - `structuredCloneJsonValue` carries the I/O-boundary rule exemptions that `jsonl.ts` uses.
   - Number fields apply their value from the change handler (`takeTypedNumber`).
   - Two setup-time prop reads go through `untrack`.
   - An unused binding is removed.

Validation at `1706c4b4`, run with `bun --conditions=browser test` as the certification harness runs it:
- export, audio-engine, shared, control, and local-control: 1287 pass, 0 fail.
- `native-playback-controller.test.ts` and `useTimelinePlayback.test.ts`: 997 pass, 2 skip, 0 fail.
- Suites that touch the lint-fixed files: 2165 pass, 2 skip, 0 fail.
- `bun run typecheck`: exit 0 (no errors beyond the repository's 101-entry baseline).
- `bun run lint`: 0 warnings, 0 errors.
- Plain `bun test` without `--conditions=browser` fails the two playback suites with or without these fixes. That
  is how those suites are run, not a regression.
## Limitations met

4. **Native export does not run arpeggiators.**
   - Export refused: "Native Phase A export does not support arpeggiators."
     (`src/lib/export/native-offline-render-plan.ts:249`)
   - I froze the arpeggiator live: the up pattern, 1/16 rate, two octaves, gate 0.6, written as 40 notes into the
     clip, then removed the arpeggiator.
5. **An export was shifted later by the graph's total latency (fixed in `b6b60b12`).**
   - Both export paths compensated tracks against each other, but neither removed the total path latency from the
     file's start. Every element landed one graph latency late, and the end of the range was cut off.
   - This project's latency is 10,480 frames (0.218 s; Spectral, the VST3 worker, and the limiter).
   - Decision (user): an export lines up with the timeline. Both backends (native and portable) now render the
     range plus the latency of the graph being rendered, for mixdown and for each stem, then drop the leading
     latency frames before tail detection, analysis, and encoding.
   - The latency comes from the same timing plan as the snapshot, which the native core validates its own path
     latency against. Wire schemas are unchanged.6. **Native playback has no sidechain routing** (`native-snapshot-support.ts`).
   - The control platform accepted a sidechain commit, and native playback then stopped.
   - I removed the sidechain from the song.
7. **Native VST3 insertion needs a directly routed track with no sends, group, or output change**
   (`native-vst3-insertion.ts`).
   - So the VST3 is on Texture, which has no send, and not on a return or the master.
8. **A 0.5 to 0.8 ms residual between accounted and actual latency (follow-up, not fixed).**
   - After the fix, dry elements land 24 to 38 frames before their timeline position.
   - The export drops exactly the accounted latency (10,480 frames, verified sample for sample).
   - So some path's real delay is slightly shorter than its declared latency.
   - Removing the master Limiter did not change the residual. The voice and the impact disagree on its size.
   - The same accounting drives live delay compensation, so the gap is not specific to export. Isolating it needs a
     per-processor delay measurement (or a resampler group-delay check for non-48 kHz sources).
