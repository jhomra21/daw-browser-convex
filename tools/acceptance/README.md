# AE-08 continuity evidence

From the repository root, after packaging:

```sh
bun tools/acceptance/ae-08-live-graph.ts --phase 1 --out /tmp/ae08-phase-1
bun tools/acceptance/analyze-ae-08-continuity.ts --run /tmp/ae08-phase-1
```

Use a **new output directory** for each run. The runner refuses an existing
directory or another running packaged app. Every app uses a newly created,
exclusively locked disposable profile, an independently verified CDP endpoint,
and normal window-close quit. Failed profiles and evidence are retained.
It never signals the app or globally stops browsers.

Phase 1 runs a combined fixture, then isolated two-tone, held-note, and reverb
oracles. Each has edit-free and edited live captures. Edits use the product UI;
fixture project actions use discovery, fresh snapshots, preview, approval when
required, keyed commit, and re-observation. Plug-ins use the normal trust,
scan, insertion, and preflight UI. ValhallaSupermassive must be installed.
No public operation or raw native command is added. Reverb is excited by
deterministic impulses every two seconds, so its measured tail remains audible
at each edit instead of decaying below the analysis floor before Undo.

The only enable switch is the child environment variable
`DAW_AE08_EVIDENCE_DIR`. Without it there is no PCM tap allocation or telemetry
file output. The callback copies post-master stereo PCM and scalar metadata
into preallocated SPSC storage. The existing non-RT bridge writes float WAV
segments and timestamped JSONL. Overflow, missing measured-capture terminal evidence, or
inconsistent block/WAV frame accounting fails the harness.
Superseded startup hosts wholly outside the measured interval remain lifecycle
evidence but are not read as PCM.

`output.wav` preserves device downtime between callback-timestamped segments;
it is not an offline export. Callback scheduling gaps over a block period plus
20 ms start a new segment. Wall/monotonic clock pairing has millisecond
anchoring uncertainty. Analysis uses one initial signal alignment, never
per-edit time warping, 10 ms defect windows, and a recorded 5% relative
residual tolerance. The master-band report is not a per-track null proof;
isolated source captures supply the source-specific evidence. Random VST
output is not treated as bit-exact.

The edit-free capture gate checks callback coverage and overflow terminals.
For sustained sources it also checks unexpected silence. Sparse impulse tails
use callback coverage rather than treating their natural zero samples as loss.

Synthetic gap, retrigger, tail-reset, wrong-delay, and off-edit unexpected-gap injections run before
analysis; pristine data must pass and every injection must fail its oracle.
An expected baseline continuity failure is a successful **evidence run**, not
AE-08 feature certification. Capture/harness failures exit nonzero.

`--phase N` is parsed, but phases after 1 are not implemented.
`--matrix full --repetitions N --vst-repetitions N` is reserved for phase 9
and fails explicitly.
