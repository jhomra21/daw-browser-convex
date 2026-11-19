# PR 62: final packaged AE-08 certification

Run on 2026-11-18 after phase 10 (the edit restart path removed), on the `pr62-cleanup` tree.

**Package.** Built at `8b893e32` with a clean tracked tree. Artifact hashes (`ae08-final-cert-evidence/provenance.json`):

| Artifact | SHA-256 |
|---|---|
| `app.asar` | `b8ae6fb49d8e1136cab5aeb5b763934ded43d46cc93944b7cd68b26b43bcd58f` |
| `daw-audio-host-macos` | `c6e6bff814716d81d45621879572d8751a45427810ba337abf6644eafc26c9c4` |
| `daw-vst3-worker` | `ee97be92db9ad62028d1af6eefc37e2354fbc4172f32645f104905148a5f1bf5` |
| `daw-vst3-scanner` | `6c13c5382f4b871fcbb3272119878f405cd101ea585bd4b2c6242fdb8e4c670e` |

The phase 8 rows and the phase 9 matrix ran on the same package (identical artifact hashes). The matrix ran at `2ecfb8be`, which changes only harness files under `tools/acceptance/` after the package was built.

## Phase 8 rows

`bun tools/acceptance/ae-08-live-graph.ts --phase 8 --out /tmp/ae08-p10-phase8`

`PHASE 8 PACKAGED PASS: 2/2 rows`. A structural edit (a new track) while paused and while playing. Each row had one host process, one device session across the edit, no stop, teardown, start, configure or rebuild event from the edit to the end of the capture, one in-place publication at a block boundary, and a gap-free capture that was audible after the edit and resumed at the pause.

## Phase 9 certifying matrix

`bun tools/acceptance/ae-08-live-graph.ts --phase 9 --matrix cert --out /tmp/ae08-final-cert`

`AE-08 phase 9 PASS: 84 launches, 0 failed, 663 judged edits, 0 failed` (30.6 minutes). The pooled failure bound is below 1 %. Mean launch overhead was 5.97 s; a built-in edit step took 1.17 s and a VST step 1.11 s (`phase9-timings.json`).

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

## Evidence

- `ae08-final-cert-evidence/`: the matrix verdict, campaign, plan, timings, provenance, and every row's `verdict.json`; `phase8/` holds the phase 8 verdict, analysis and provenance.
- The full run directories (`/tmp/ae08-final-cert`, 9.1 GB of PCM and host logs, and `/tmp/ae08-p10-phase8`) are not kept in the repository.

## Known gaps

- Two mutation arms survive by record 81 (`PARENT-RULING-PR62-TEST-CLEANUP.md`, Phase 10): the controller guard on `paused-preview-structural-change` and the `handlePlay` join after a pending Pause are kept but no test reaches them.
- The phase 9 diagnostics read can race a host control request (`PHASE9-CERT-MATRIX.md`); it did not recur.
- `--judge-only` does not accept a phase 9 run directory yet.
