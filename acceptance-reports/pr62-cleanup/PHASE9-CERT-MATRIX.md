# PR 62 cleanup: packaged AE-08 phase 9 cert matrix

Run on 2026-11-17 (user decision U14), on the cleanup tree `7cc21c96`.

**Build.** The app was packaged at `c47a71c0`, which rebuilt the native audio host and the VST3 worker from the current sources. `7cc21c96` changes only the harness file `tools/acceptance/ae-08-phase-9-launch.ts`, so the packaged product bytes are the same.

**Command.** `bun tools/acceptance/ae-08-live-graph.ts --phase 9 --matrix cert --out /tmp/ae08-pr62-phase9c`

## Result

`AE-08 phase 9 NON-CERTIFYING: 84 launches, 0 failed, 583 judged edits, 0 failed` (30 minutes).

- Every launch finished, and every judged edit passed. The per-row verdicts are in `phase9-cert-evidence/rows/`.
- The verdict reads NON-CERTIFYING for one reason only: four rows are settled and gated on host evidence but have no per-window PCM compare (`ae-08-live-graph.ts:884`). The rows are `vst-remove-undo`, `vst-latency-switch`, `output-device-switch` and `output-device-switch-instruments`. That is how the matrix is built on this branch, and the cleanup did not change it.
- The pooled failure bound is met. It is not among the reasons.

| Row | Outcome | Judged edits |
|---|---|---|
| raise-lower-burst, fft-transition, attach-remove-long-latency, lookahead-transition | pass | 30 each |
| undo-redo-burst | pass | 32 |
| paged-playback, held-note-unrelated-edit, tempo-burst, manual-automation-override, sustained-live-midi | pass | 30 each |
| instrument-insert, effect-reorder, polyphony-down-held-chord, asset-swap-held-note | pass | 30 each |
| held-note-sampler, held-note-drum-rack, held-note-granular | pass | 30 each |
| delete-while-starting, record-target-guard, unaffected-input, record-target-reroute | pass | 1 each |
| open-editor | pass | 2 |
| faulty-plugin, trust-negative, host-failure-during-play | pass | 1 each |
| pause-stop-during-play-start | pass | 6 |
| vst-remove-undo, vst-latency-switch, output-device-switch, output-device-switch-instruments | settled on host evidence | no per-window compare |

## Earlier attempts on the same build

1. **First attempt (`/tmp/ae08-pr62-phase9`).** It stopped at launch 1 (`raise-lower-burst`, edit 8). The harness's `diagnostics-v2` read came back with no native diagnostics.
   - Cause: the desktop main process refuses a native diagnostics request while another host control request is pending (`apps/desktop/audio-host.ts:2485`). The same guard exists at the pre-cleanup head.
   - The same three rows then ran alone three times. All three passed, with 90 judged edits each.
   - The race between the harness's diagnostics read and in-flight publication is left as it is. It did not recur in the final run.
2. **Second attempt (`/tmp/ae08-pr62-phase9b`).** Launches 1-18 passed (167 judged edits, 0 failed). Launch 19 (`paged-playback`) failed at its 6th import with `Import UI deadline: changed`, and failed 4 of 4 when run alone.
   - Cause: a clip edit during playback pauses Follow until playback stops (`src/components/Timeline.tsx` `setFollowPaused(true)`, `src/hooks/useTimelineFollow.ts`). The 6th import lands at the playhead beyond the unscrolled viewport, so no clip node renders.
   - The behaviour is unchanged since the pre-cleanup head. Earlier evidence ran this row for only 10 edits (5 imports), which never got that far.
   - Fixed in the harness (`7cc21c96`): the edit now confirms the import from the control snapshot, with the same deadline and oracle. The row then passed 30 of 30 edits twice.

## Evidence

- `phase9-cert-evidence/`: verdict, campaign, plan, provenance and per-row verdicts of the final run.
- The full run directory (`/tmp/ae08-pr62-phase9c`, 9.1 GB of PCM and host logs) was not kept in the repository.
