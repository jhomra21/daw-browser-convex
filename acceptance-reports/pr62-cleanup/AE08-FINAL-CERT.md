# PR 62: final packaged AE-08 certification

Rerun on 2026-11-19, after the DSP quality fixes and the app fixes from the AE-08 song v2 session (`acceptance-reports/ae-08-song-v2/`), on the `synth-dsp-quality` tree. The certification of `1706c4b4` that this replaces (song v1 fixes) had the same totals; its package predates these fixes.

**Package.** Built at `9ad09783` with a clean tracked tree. Artifact hashes (`ae08-final-cert-evidence/provenance.json`):

| Artifact | SHA-256 |
|---|---|
| `app.asar` | `37ec18385c0db37606c31c563da0f0b4eddd5518cfb0c461ecd5b1a23b2c7781` |
| `daw-audio-host-macos` | `af9e71a2dd26ffed1d339be9ef2b8bfcb29b15ad8f222ae96c027af4c1baf24f` |
| `daw-vst3-worker` | `ee97be92db9ad62028d1af6eefc37e2354fbc4172f32645f104905148a5f1bf5` |
| `daw-vst3-scanner` | `6c13c5382f4b871fcbb3272119878f405cd101ea585bd4b2c6242fdb8e4c670e` |

`app.asar` and the audio host differ from the `1706c4b4` package (the host links the audio core); the plug-in worker and scanner are byte-identical. The phase 8 rows and the phase 9 matrix ran on this one package at `005302eb`, which adds only the FAST-CERT record after the package was built.

What the package adds over `1706c4b4`:
- `646fc35d`: band-limited (polyBLEP) saw and square oscillators.
- `fcef4611`: a diffuse 8-line feedback-delay-network reverb, in the native core and the worklet.
- `0fd3e1ba`, `a2b3bc82`: the limiter holds its gain through the lookahead and its true-peak detector includes the samples it interpolates between, so peaks stay under the ceiling.
- `7397ebf9`: an export the host refuses reaches the client with the real reason.
- `3ebe5b66`: File > New Project closes the projects dashboard.

## Phase 8 rows

`bun tools/acceptance/ae-08-live-graph.ts --phase 8 --out /tmp/ae08-synth-phase8`

`PHASE 8 PACKAGED PASS: 2/2 rows`. A structural edit (a new track) while paused and while playing. Each row had:
- one host process and one device session across the edit;
- no stop, teardown, start, configure or rebuild event from the edit to the end of the capture;
- one in-place publication at a block boundary;
- a gap-free capture that was audible after the edit and resumed at the pause.

## Phase 9 certifying matrix

`bun tools/acceptance/ae-08-live-graph.ts --phase 9 --matrix cert --out /tmp/ae08-synth-phase9`

`AE-08 phase 9 PASS: 84 launches, 0 failed, 663 judged edits, 0 failed` (30.7 minutes, first run on this package). The pooled failure bound is below 1 %. Mean launch overhead was 6.04 s; a built-in edit step took 1.17 s and a VST step 1.11 s (`phase9-timings.json`).

Attempts on the previous (`1706c4b4`) package, kept for the record:

1. **`66d039c6`: the first run was NON-CERTIFYING.** It ran 84 launches with 0 failed and 632 judged edits with 2 failed.
   - `lookahead-transition` failed at edit 1. A "states" row without a reference compared the capture with each state's export unshifted. That worked only because the export used to start one graph latency late, which equals the live pinned budget there. With the export fix, every state's export is compared delayed by the pinned budget, as the reference rows already were.
   - `output-device-switch-instruments` failed at edit 3: the rebuilt session had a plug-in worker spawned but not yet ready when the step was observed. It did not recur in the probe run of both rows (35 judged edits, 0 failed) or in the certifying run.
2. **`44bb6a6b`: two runs stopped at launch 1.** In `raise-lower-burst`, around edit 80, the harness's asset-inventory `diagnostics-v2` read was refused while another host request was pending. This is the race `PHASE9-CERT-MATRIX.md` recorded. A refused read is now asked again, up to a bound; any other reply still fails.
3. **A fourth run was cut off** at launch 83 of 84 (0 failed) when the session running it restarted. It wrote no verdict.

Every row of the preset has a judge. The run of 2026-11-17 (`PHASE9-CERT-MATRIX.md`) was NON-CERTIFYING only because four rows had none; they were added in `fb049f20` and `2ecfb8be`:

- `vst-remove-undo` uses the `states` judge. Each window is compared with the export of the state without the plug-in, delayed by the pinned latency budget (the test plug-in passes audio through at its default latency, so both states sound alike). The edited channel is not compared during its swap window (one transport block plus the 10 ms crossfade). Every edit must also leave the playing host untouched and start no worker beyond an insert's own.
- `vst-latency-switch` uses the `latency` judge with the same no-restart check. The host reports a plug-in's latency plus one transport block (512 frames at the packaged device block), so the declared moves are 512 ↔ 4608 frames.
- `output-device-switch` and `output-device-switch-instruments` use a new `output-device` judge on host evidence. A device change is a lifecycle rebuild, not an edit. Each step must cause exactly what it should: a switch while playing rebuilds once and resumes on the new device, a switch while paused holds the position and the next Play sounds on the new device, a missing device reports a notice and refuses Play, restoring it plays again, a take keeps its devices, and one host process runs throughout. In the instruments row, every rebuild also brings back a ready plug-in worker and the sampler's assets.

| Row | Judged edits |
|---|---|
| raise-lower-burst, fft-transition, attach-remove-long-latency, lookahead-transition | 30 each |
| undo-redo-burst | 32 |
| paged-playback, held-note-unrelated-edit, tempo-burst, manual-automation-override, sustained-live-midi | 30 each |
| instrument-insert, effect-reorder, polyphony-down-held-chord, asset-swap-held-note | 30 each |
| held-note-sampler, held-note-drum-rack, held-note-granular | 30 each |
| vst-remove-undo | 40 |
| vst-latency-switch | 20 |
| output-device-switch | 15 |
| output-device-switch-instruments | 5 |
| delete-while-starting, record-target-guard, unaffected-input, record-target-reroute | 15 launches, 1 each |
| pause-stop-during-play-start | 6 |
| open-editor | 2 |
| faulty-plugin, trust-negative, host-failure-during-play | 1 each |

## FAST-CERT

The DSP quality fixes are blessed in record 85 (`pr62-synth-dsp`, `--bless --full`): only the wasm artifact hashes and four watched files move; the live run passed and the source freeze held.

The first confirming `bun tools/certification/fast-cert.ts --full` run had one failing job, `gate:x-host-ctest`: `TestRetiringASlowWorkerDoesNotBlockTheCommandLoop` asserted that a never-ready plug-in worker's process group was gone 2 s after its retirement (`audio_host_test.cpp:6306`). The retirement escalates stop, then SIGTERM after 250 ms, then SIGKILL after another 250 ms, on a reaper thread. No audio host code changed in this branch. The test passed 6 of 6 times when rerun alone, 3 of them with 14 busy processes loading the CPU. The second confirming run at `005302eb` passes: 929 jobs, 0 failing, freeze held, `git status` identical before and after (20.1 minutes).

The earlier records, for the song v1 fixes: `pr62-lint-cleared` (record 83, a hand record for the lint gate moving from exit 1 to a clean run) and `pr62-song-fixes` (record 84, 6 added passing tests, 4 watched hashes and the hook trace tree; nothing weakened).
## Evidence

- `ae08-final-cert-evidence/`: the matrix verdict, campaign, plan, timings, provenance, and every row's `verdict.json`; `phase8/` holds the phase 8 verdict, analysis and provenance.
- The full run directories (`/tmp/ae08-synth-phase9`, about 3 GB of PCM and host logs, and `/tmp/ae08-synth-phase8`) are not kept in the repository.

## Known gaps

- Two mutation arms survive by record 81 (`PARENT-RULING-PR62-TEST-CLEANUP.md`, Phase 10): the controller guard on `paused-preview-structural-change` and the `handlePlay` join after a pending Pause are kept but no test reaches them.
- The main process still refuses a native diagnostics read while another host request is pending; the harness now re-reads, but any other client sees the refusal.
- `output-device-switch-instruments` once observed a plug-in worker not yet ready after a device switch (see above).
- `--judge-only` does not accept a phase 9 run directory yet.
- `TestRetiringASlowWorkerDoesNotBlockTheCommandLoop` failed once in a full FAST-CERT run and has not reproduced (see FAST-CERT).
