# Plan 004: Preserve sparse and dynamically changed native VST tails

> Validate all assumptions against current source before editing. Preserve existing user changes. Do not commit or push.

## Proven runtime symptom

- Track 2 contains an external Valhalla VST followed by native downstream metering/EQ.
- A live MIDI note configured for eight delay repeats produces only approximately two echoes.
- Track meters and EQ spectrum drop instantly at the cutoff, proving downstream graph output becomes zero.

## Root cause

- `NativeVstWorkerAttachment` uses the VST's declared finite tail as a countdown.
- After the countdown, it treats two completed silent blocks or a short fixed grace interval as proof that processing may stop.
- Sparse delays naturally contain more than two silent blocks between repeats, so silence streaks do not prove tail completion.
- VST tail metadata can be stale because `getTailSamples()` is refreshed during initial transport/state configuration, but not reliably after all live editor/parameter changes.
- Plugins may also legally or practically underreport dynamic/tempo-synced tails.
- When the host stops submitting VST blocks, later echoes cannot evolve and all downstream native meters/spectrum fall to zero.

## Required implementation

1. Treat VST tail metadata as informational/optimization metadata, not authority to stop realtime processing for an attached render-enabled plugin.
2. Continue submitting realtime blocks for active attached VST workers while the native session owns the graph, including:
   - held notes;
   - released-note tails;
   - sparse delays with long silent gaps;
   - finite, infinite, unknown, stale, or underreported tails;
   - tails changed from the plugin editor or parameter automation.
3. End processing only through explicit lifecycle boundaries already owned by the app, such as plugin detach/bypass if that contract tears down processing, graph/session teardown, Stop ownership disposal, host loss, or project replacement.
4. Remove dead tail countdown/grace/silent-completion state and branches if they no longer have a correct role. Keep worker tail metadata publication if used for diagnostics, offline export, schedule estimates, or UI.
5. Do not replace the current bug with a larger arbitrary silence window.
6. Do not change audio-core delay DSP, add browser fallback, poll, or introduce timers.
7. Review idle CPU implications. Prefer the simplest correct always-submit behavior within the existing fixed attachment limits. If an existing explicit inactive/bypass lifecycle can safely skip processing without losing state, retain it only where correctness is proven.
8. Do not implement the separate paused schedule-progress field unless a test proves accepted schedule coverage gates VST/core processing. Current investigation found the paused refill cursor stalls, but accepted coverage is not itself a demonstrated audio-processing gate.

## Regression tests

1. A VST with a finite declared tail emits sound, then more than two silent blocks, then later sound. The host must continue submitting and the later sound must reach output.
2. A live note-off through a sparse delay remains processed for all configured repeats.
3. A live parameter/editor change that lengthens delay feedback cannot cause the host to stop at stale startup tail metadata.
4. Infinite/unknown tails continue processing.
5. Explicit session/plugin teardown still stops worker submissions deterministically.
6. Downstream meter and spectrum test data remains nonzero on later delayed repeats.
7. Existing worker deadline/missed-callback/degradation behavior remains intact.

## Validation

```sh
bun test apps/desktop/audio-host.test.ts apps/desktop/native-vst3-coordinator.test.ts src/lib/desktop/native-playback-controller.test.ts
sh native/audio-core/scripts/test-native.sh
bun run typecheck
bun test
bun run build
bun --cwd apps/desktop package
git diff --check
```

## Packaged verification

1. Relaunch the newly packaged app in the existing project.
2. Select Track 2 with Valhalla delay configured for eight repeats.
3. Press and release one keyboard MIDI note.
4. Confirm all eight repeats are audible.
5. Confirm track meters and EQ spectrum remain active for each later repeat rather than dropping after the second.
6. Repeat after changing delay/feedback from the Valhalla editor.
7. Confirm `rejectedBlocks` remains zero and no VST/native MIDI warning appears.
