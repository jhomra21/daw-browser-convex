# PR 62: final packaged AE-08 certification

Rerun on 2026-11-18, after the fixes the AE-08 song session found (`acceptance-reports/ae-08-song/SONG-REPORT.md`), on the `pr62-cleanup` tree. The certification of `8b893e32` that this replaces had the same totals; its package predates those fixes.

**Package.** Built at `1706c4b4` with a clean tracked tree. Artifact hashes (`ae08-final-cert-evidence/provenance.json`):

| Artifact | SHA-256 |
|---|---|
| `app.asar` | `8f14acdc4e73fc47fb43e2bebe45426d6e820fa23c634eccbf2513a501f71014` |
| `daw-audio-host-macos` | `c6e6bff814716d81d45621879572d8751a45427810ba337abf6644eafc26c9c4` |
| `daw-vst3-worker` | `ee97be92db9ad62028d1af6eefc37e2354fbc4172f32645f104905148a5f1bf5` |
| `daw-vst3-scanner` | `6c13c5382f4b871fcbb3272119878f405cd101ea585bd4b2c6242fdb8e4c670e` |

Only `app.asar` differs from the `8b893e32` package; the native binaries are byte-identical. The phase 8 rows and the phase 9 matrix ran on this one package. The matrix ran at `44bb6a6b`, which changes only harness files under `tools/acceptance/` after the package was built.

What the package adds over `8b893e32`:
- `e6820371`: a grid-aligned placement never snaps to a negative start.
- `c795a349`: an EQ always has eight bands.
- `247811e2`: a send stored without a tap is compensated as post-fader.
- `b6b60b12`: an export starts on the timeline, not one graph latency late.
- `c4847f0e`, `1706c4b4`: the lint errors and warnings from the phase 5 commit.

## Phase 8 rows

`bun tools/acceptance/ae-08-live-graph.ts --phase 8 --out /tmp/ae08-recert-phase8`

`PHASE 8 PACKAGED PASS: 2/2 rows`. A structural edit (a new track) while paused and while playing. Each row had:
- one host process and one device session across the edit;
- no stop, teardown, start, configure or rebuild event from the edit to the end of the capture;
- one in-place publication at a block boundary;
- a gap-free capture that was audible after the edit and resumed at the pause.

## Phase 9 certifying matrix

`bun tools/acceptance/ae-08-live-graph.ts --phase 9 --matrix cert --out /tmp/ae08-recert5`

`AE-08 phase 9 PASS: 84 launches, 0 failed, 663 judged edits, 0 failed` (30.6 minutes). The pooled failure bound is below 1 %. Mean launch overhead was 5.97 s; a built-in edit step took 1.17 s and a VST step 1.11 s (`phase9-timings.json`).

Earlier attempts on this package:
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

The song-session fixes are blessed in two records:
- `pr62-lint-cleared` (record 83, ruling U15 in `PARENT-RULING-PR62-TEST-CLEANUP.md`) is a hand record. Gate `g-lint` moves from the 5 errors and 17 warnings the phase 5 commit left (exit 1) to a clean run (exit 0, no findings). `--bless` refuses an exit move that no named test explains; the first bless attempt was refused on that field alone, with its live run passing.
- `pr62-song-fixes` (record 84) is the `--bless --full` run. It moves 6 fields, all added passing tests (`graph-contract.test.ts` and `portable-export-snapshot.test.ts` in `f-engine` and `last-engine`, and four `rc1-i4-consumers` tests), 4 watched hashes and the hook trace tree. Nothing was weakened, and the source freeze held.

The confirming `bun tools/certification/fast-cert.ts --full` run at `934a8810` passes: 929 jobs, 0 failing, freeze held (19.8 minutes). One earlier confirming run also had 0 failing jobs but reported the freeze broken: the tracked files were unchanged, but `git status` differed between the start and the end of the run, and FAST-CERT records only a hash of it, not the paths. The rerun captured `git status` before and after; both were identical.

## Evidence

- `ae08-final-cert-evidence/`: the matrix verdict, campaign, plan, timings, provenance, and every row's `verdict.json`; `phase8/` holds the phase 8 verdict, analysis and provenance.
- The full run directories (`/tmp/ae08-recert5`, about 9 GB of PCM and host logs, and `/tmp/ae08-recert-phase8`) are not kept in the repository.

## Known gaps

- Two mutation arms survive by record 81 (`PARENT-RULING-PR62-TEST-CLEANUP.md`, Phase 10): the controller guard on `paused-preview-structural-change` and the `handlePlay` join after a pending Pause are kept but no test reaches them.
- The main process still refuses a native diagnostics read while another host request is pending; the harness now re-reads, but any other client sees the refusal.
- `output-device-switch-instruments` once observed a plug-in worker not yet ready after a device switch (see above).
- `--judge-only` does not accept a phase 9 run directory yet.
