# Parent ruling: PR 62 cleanup test removals and decisions

Ruled by the parent from the user's answers on 2026-11-17. Plan: `implementation-trackers/pr62-cleanup-plan.md`. Removal manifests under `tools/certification/removals/pr62-*.json` cite this file.

## Decisions

- U1: a captured VST state that differs for an unchanged plug-in reloads it, unless the new state is the one the host last captured from that running instance.
- U2: the five real-plug-in native tests register as their own ctest entry that reports skipped when the AE-08 test bundle is missing; `tools/acceptance/run-ae08-test-plugin.ts` stays the runner that builds the bundle; `DAW_AE08_*_ONLY` selectors that no script in `tools/` sets are deleted.
- U3: overlapping parameter releases are each their own undo step. The B5c3 known-red tests become passing behavior tests; `DV01_B5_STRICT_HISTORY` is deleted.
- U4: line targets: `native-playback-controller.ts` <= 3,300; `apps/desktop/audio-host.ts` <= 2,800; `apps/desktop/main.ts` <= 2,450; `src/hooks/useTimelinePlayback.ts` <= 2,100; `live-mixer-runtime.ts` < 1,000; `local-project-db.ts` < 800; `native-vst3-coordinator.ts` < 700. `audio_core.cpp` and `audio-host.cpp` get structure fixes only.
- U5: `src/lib/desktop/native-revision-controller.ts` and `native-live-graph.browser.test.ts` are deleted; gate `rc1-g-native-live-graph-browser` is retired by hand record with a direct audit of the covering production tests.
- U5b: the historical baseline modes in `native-playback-lifecycle.browser.test.ts` are removed; `tools/acceptance/*.test.ts` run by FAST-CERT gates stay.
- U6: the desktop mirror of native parking is removed if the verdict cache already avoids the repeated preflight; otherwise the limits come from the native hello.
- U7: only the current schedule-progress payload size is accepted.
- U8: `DAW_AE08_RENDERER_PROFILE` and its README line are deleted.
- U9: PCM range clamping and rejection stay as two named functions over one validator.
- U10: a rewritten killer test may keep one minimal internal assertion when no behavioral assertion kills its mutant; no arm is retired for this cleanup without a further ruling.
- U12: the cleanup lands on branch `pr62-cleanup`, stacked on `production-dsp-characterization`, merged into the PR branch after the final phase.
- U13: the seed summary hash judge (`dropAfter: 2026-11-17`) is dropped in the final bless.
- U14: the packaged phase 9 `--matrix cert` preset runs once at the end.

## Test removals this ruling allows

Tests that only match source text, extract component source with an AST or `new Function`, assert private state that a behavioral test now covers, or exercise code this cleanup deletes (the test-only VST revision coordinator, the test-only revision controller, `sendBlock`, `beforeReleaseUnlink`, the extraction-harness self-test). Each removal is listed in a `removals/pr62-*.json` manifest or, for a deleted file or a test moved between files, proved by a name diff in the hand record. A killer test is never removed; it keeps its name and still fails its mutants.

A test renamed in the same file so its name states the behavior it now proves is the removal of the old name plus an addition, and is listed in the phase manifest (`pr62-p18-desktop.json`, `pr62-p21-convex.json`, and later phases). The P21 removal of `accepts effect writer stamps only when each equals the owner's revision` exercises `assertEffectWriterRevisions`, which P21 deletes; the new `a project edit stamps all effect rows and advances the project once` covers the stamp.
