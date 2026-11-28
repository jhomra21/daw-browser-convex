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
- U15 (2026-11-18, from the user's "fix everything" and "push and recertify"): the 5 lint errors and 17 lint warnings the phase 5 commit `22321b83` left are fixed, and gate `g-lint` moves from that known set (exit 1) to exit 0 with no findings by hand record `pr62-lint-cleared` (83). `--bless` cannot record an exit move that no named test explains.

## Test removals this ruling allows

Tests that only match source text, extract component source with an AST or `new Function`, assert private state that a behavioral test now covers, or exercise code this cleanup deletes (the test-only VST revision coordinator, the test-only revision controller, `sendBlock`, `beforeReleaseUnlink`, the extraction-harness self-test). Each removal is listed in a `removals/pr62-*.json` manifest or, for a deleted file or a test moved between files, proved by a name diff in the hand record. A killer test is never removed; it keeps its name and still fails its mutants.

A test renamed in the same file so its name states the behavior it now proves is the removal of the old name plus an addition, and is listed in the phase manifest (`pr62-p18-desktop.json`, `pr62-p21-convex.json`, and later phases). The P21 removal of `accepts effect writer stamps only when each equals the owner's revision` exercises `assertEffectWriterRevisions`, which P21 deletes; the new `a project edit stamps all effect rows and advances the project once` covers the stamp.

## Phase 10 (remove the edit restart path)

Ruled by the parent on 2026-11-18 under the user's direction to accept the plan's recommendations.

- The v1 portable host is deleted (c1fb2566); its shared tests now name the v2 host. The renames are listed in `tools/certification/removals/pr62-p10-portable.json`; each old name is a removal and the v2 name its addition, with the same assertions.
- Every killer a7bacca5 removed or renamed is restored under its original name (c0c5de9e, 262831a1, 78ad76fb, fe0d8046, 9341a1de, 49b73707), reaching its path through a lifecycle cause: an output device move or a project reload. `B6d4 a Stop while the mount preview is starting keeps a live graph at the start`, the name a7bacca5 introduced, goes back to `B6d4 a Stop while the paused replacement is starting keeps a live graph at the start`.
- Two arms no longer kill and are recorded as survivors by hand record 81 (`tools/certification/rebases/pr62-p10-unreachable-arms.json`), with no product change:
  - `diag:169:169-plus-409` combines a mutation of the hook's structural-change dispose (`tracksChanged ? pendingBackendPause?.promise : undefined`) with one of the controller guard `reason === "paused-preview-structural-change" && active && processorState.publication()`. The controller sets `active = true` only in the resume path of a prepared session, and clears `active` and `prepared` together, so `active` implies `prepared`. The hook branch that disposes with this reason runs only when `nativePlayback.isPrepared()` is false (a prepared preview adopts the edit in place). The other caller with this reason, `playback-session-reconciliation.ts`, runs on the portable path, where no rebuild request reaches it. With the guard false, the combined mutant equals the hook mutant alone, which the STEP7B3 tests do not distinguish.
  - `rc2:170:0` removes the `await pendingNativeDispose` that `handlePlay` makes after a pending Pause. The dispose it waited for was the structural-change dispose chained after that Pause, which no longer runs while a session is prepared. A Play during a pending Pause also joins `preparedBackendDisposePromise` earlier in `handlePlay`. A project reload, two queued reloads and a held teardown each pass under the mutant (worker audit, re-measured in /tmp/fast-cert/p10-v1).
  The code both arms mutate stays: the guard and the join are harmless, and no test proves them dead on every path. This is noted in the PR as a known gap.
