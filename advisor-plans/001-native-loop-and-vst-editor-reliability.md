# Plan 001: Make native looping and VST editor sessions reliable

> **Executor instructions**: Validate this plan against the live code before editing. Preserve all existing user changes. Implement the smallest focused solution, run every verification command, and review the final diff for unnecessary protocol or architecture expansion. Do not commit or push.
>
> **Drift check**: `git diff --stat 964a313..HEAD -- src/lib/desktop/native-playback-controller.ts src/lib/desktop/native-schedule-coordinator.ts src/components/timeline/external-plugin-card.tsx apps/desktop/audio-host.ts apps/desktop/native-vst3-editor-session.ts apps/desktop/main.ts apps/desktop/preload.ts native/plugin-host/src/vst3-worker.cpp native/plugin-host/src/worker-main.cpp native/plugin-host/src/vst3-editor-window.mm`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `964a313`, 2026-04-15

## Why this matters

Electron playback is native-only, but native playback currently rejects projects with arrangement looping enabled. VST editor insertion also loses one-shot auto-open requests, does not reconcile native title-bar closure, and can permanently disable a supported editor after a transient open failure. The fix must preserve monotonic native transport and per-instance editor isolation without redesigning the native schedule protocol.

## Current state and required design

### Arrangement loop

- `src/lib/desktop/native-playback-controller.ts` rejects `snapshot.transport.loopEnabled` before native startup and reports raw native transport frames as the public playhead.
- `src/lib/desktop/native-schedule-coordinator.ts` compiles one finite linear timeline and eventually sends `endsSchedule`.
- `packages/audio-engine/src/native-host-wire.ts` and `native/audio-host-macos/src/audio-host.cpp` require contiguous, monotonically increasing absolute schedule windows.
- The C++ transport and audio core advance monotonically. Do not seek or create a new epoch at every loop wrap because that clears/restarts native source and voice state.

Required shape:

1. Remove only the unsupported-loop rejection.
2. Convert loop boundaries to stable integer timeline frames once.
3. Keep native schedule frames and epochs monotonic.
4. In the TypeScript schedule coordinator, split schedule windows at every loop boundary, compile each arrangement slice, and project its events/automation/source commands onto the corresponding absolute native frame range.
5. Before the first loop wrap, play the arrangement normally. At `loopEnd`, repeatedly map to `[loopStart, loopEnd)`.
6. Never mark an active loop schedule complete merely because project content ended.
7. Map the public playhead back to arrangement time while leaving raw native progress monotonic.
8. Preserve end-exclusive boundary semantics. Events at `loopEnd` belong to the next applicable timeline region, not the ending iteration.
9. Prevent ledger identity collisions across loop iterations for MIDI notes and sources. Notes/sources crossing `loopEnd` must terminate at the boundary and restart from the correct loop-start state when applicable.
10. Preserve existing PDC, graph latency, event ordering, per-window capacity checks, and structural rebuild behavior.

STOP and report if this requires changing the native schedule wire format or C++ transport semantics. Those are out of scope unless a concrete failing test proves TypeScript schedule projection cannot satisfy the existing contract.

### VST editor

- `src/components/timeline/external-plugin-card.tsx` currently calls `onAutoOpenHandled` before `editor("open")` succeeds and leaves `autoOpenStarted` true after failure.
- `native/plugin-host/src/vst3-worker.cpp` permanently sets `editorUnsupported` after any native window-open failure.
- `native/plugin-host/src/vst3-editor-window.mm` knows when the native title-bar closes the window, but no close/state notification reaches the renderer.
- `apps/desktop/native-vst3-editor-session.ts` already owns one supervisor/queue per `instanceId`; preserve that isolation.

Required shape:

1. Consume the insertion auto-open request only after confirmed success. On false/error, leave the request retryable and reset only the local in-flight guard. Do not add polling or timers.
2. Reserve permanent `editorUnsupported` for deterministic capability absence, such as `createView(...) == nullptr`; a transient window creation/attachment failure must remain retryable.
3. Add an event-driven editor-open-state notification from the worker/native close path through the existing worker notification transport and isolated editor manager to Electron preload/renderer.
4. Update only the matching instance card when its native editor closes itself.
5. Open, close, focus, and reopen of one instance must not tear down or alter another instance.
6. Prefer extending the existing worker notification union and existing editor/session IPC channel. Do not create polling, global renderer state, or a second general event bus.

## Scope

Modify only files needed from these groups:

- Loop: `src/lib/desktop/native-playback-controller.ts`, `src/lib/desktop/native-playback-controller.test.ts`, `src/lib/desktop/native-schedule-coordinator.ts`, `src/lib/desktop/native-schedule-coordinator.test.ts`.
- Editor renderer/tests: `src/components/timeline/external-plugin-card.tsx`, `src/components/timeline/external-plugin-editor.test.ts`, and the nearest existing component/bridge tests if behavioral rendering requires them.
- Editor transport/session/tests: `apps/desktop/audio-host.ts`, `apps/desktop/audio-host.test.ts`, `apps/desktop/native-vst3-editor-session.ts`, `apps/desktop/native-vst3-editor-session.test.ts`, `apps/desktop/main.ts`, `apps/desktop/preload.ts`, their nearest existing tests, and `src/types/desktop.d.ts` or the actual existing desktop bridge declaration.
- Native editor: `native/plugin-host/src/vst3-worker.cpp`, `native/plugin-host/src/worker-main.cpp`, `native/plugin-host/src/vst3-editor-window.mm`, and existing native plugin-host tests.

Out of scope:

- Browser/Web Audio loop behavior.
- Native wire version changes.
- Native audio transport epoch/wrap protocol.
- Effect-chain persistence or ordering changes.
- Editor visual redesign.
- Unrelated cleanup/refactors.

## Implementation steps

### 1. Add failing loop mapping tests

In `src/lib/desktop/native-schedule-coordinator.test.ts`, add focused tests for:

- pre-loop material plays once, then loop body repeats;
- one refill window crossing one boundary;
- a refill window spanning multiple short loop iterations;
- contiguous monotonic native windows without `endsSchedule`;
- MIDI note/source crossing the boundary is truncated and restarted correctly;
- exact-boundary events occur once;
- VST/built-in automation resets to the loop-start value;
- loop iteration identities do not collide.

In `native-playback-controller.test.ts`, cover loop acceptance and wrapped public playhead reporting.

### 2. Implement loop projection in the coordinator

Add small pure helpers for:

- validating/normalizing loop start and end frames;
- mapping absolute playback offsets to arrangement frames;
- splitting an absolute schedule range into arrangement slices with an iteration identity;
- shifting compiled slice outputs to absolute native frames.

Reuse the existing linear compiler per slice rather than duplicating clip/MIDI/automation compilation. Extend ledger keys with the iteration identity where necessary. Keep all externally sent windows contiguous and monotonic.

For preflight/capacity validation, do not iterate an infinite loop. Validate the pre-loop region and a bounded representative set of loop-boundary alignments sufficient to catch a window crossing the boundary and a full loop body. If the current code exposes a simpler deterministic capacity calculation, use it. Document only the non-obvious finite-loop-preflight bound.

### 3. Enable loop snapshots and wrap playhead

Remove the native loop rejection in `native-playback-controller.ts`. Pass the transport loop configuration into the coordinator in the existing snapshot/config shape. Map the public playhead into arrangement time using the exact same integer-frame loop semantics as the scheduler. Do not alter raw progress used for refill accounting.

### 4. Add failing editor behavior tests

Replace source-order assertions with behavior tests where feasible:

- auto-open callback is not consumed before success;
- failed auto-open becomes retryable without timers;
- successful auto-open is consumed exactly once;
- native-close notification updates the matching instance only;
- transient native open failure remains supported/retryable;
- two isolated instances can be open, close/reopen A, and keep B alive.

### 5. Make auto-open transactional

In `external-plugin-card.tsx`, treat `autoOpenStarted` as an in-flight guard, not permanent completion. Call `onAutoOpenHandled` only after `editor("open")` returns true. Reset the guard after failure. Avoid an immediate reactive retry loop: retry must be driven by a meaningful state/input change or explicit Open UI action.

### 6. Add editor state notification and transient-failure recovery

- Define one new worker notification kind representing editor open-state changes, with instance identity and an explicit open/closed value.
- Emit it on successful open/close and native title-bar closure. Reuse existing framing and decoding.
- Forward only matching-instance notifications through `native-vst3-editor-session.ts`.
- Expose a narrow Electron subscription through main/preload/desktop bridge, following the existing event subscription and cleanup patterns.
- Subscribe in the card lifecycle and reconcile `editorOpen`; clean up on instance change/unmount.
- Do not mark `editorUnsupported` after ordinary window-open failure. Preserve permanent unsupported state only for deterministic capability checks.

### 7. Validate and simplify

Run:

```sh
bun test src/lib/desktop/native-schedule-coordinator.test.ts src/lib/desktop/native-playback-controller.test.ts
bun test src/components/timeline/external-plugin-editor.test.ts apps/desktop/audio-host.test.ts apps/desktop/native-vst3-editor-session.test.ts
bun run typecheck
bun test
bun run build
bun run native:audio-core:test
bun run package:desktop
git diff --check
```

If script names differ, inspect `package.json` and use the repository's exact existing equivalent. All commands must exit 0. Review `git diff` and remove redundant abstractions, duplicate loop mapping logic, dead code, and unrelated edits.

## Packaged validation

After automated gates pass, test the final packaged app, not a dev server:

1. Ensure no stale packaged-output Electron/audio-host/plugin-host process owns the chosen CDP port.
2. Launch the exact packaged app executable with a fresh remote debugging port.
3. Open the existing local validation project and record original loop state and processors.
4. Enable a non-empty arrangement loop before Play. Verify visible playhead repeatedly wraps and native audio continues for at least three iterations.
5. Verify MIDI/source playback and a VST in the loop repeat across boundaries without a host-loss or unsupported-loop diagnostic.
6. Insert Valhalla A while stopped; verify its editor auto-opens once.
7. Insert Valhalla B; verify its editor opens independently while A remains open.
8. Close A using the native title-bar; verify the A card updates to closed.
9. Press Open UI on A; verify it reopens while B remains open.
10. Close/reopen A through card controls while B remains open.
11. Repeat editor insertion/reopen while playback and looping are active.
12. Capture screenshots and relevant sanitized logs.
13. Remove validation-created plug-ins and restore the original loop/processors before closing the app.

Do not claim packaged success unless every observed step passes. If macOS automation cannot inspect native child windows reliably, use visible screenshots plus app/native logs and renderer state as evidence, and state the limitation.

## Done criteria

- [ ] Loop-enabled native playback starts and repeats arrangement scheduling on monotonic frames.
- [ ] Public playhead wraps while internal progress remains monotonic.
- [ ] Loop boundary MIDI/source/automation tests pass.
- [ ] Auto-open is consumed only after success and remains retryable after failure.
- [ ] Transient editor open failures do not permanently disable supported editors.
- [ ] Native title-bar close updates the matching card.
- [ ] Two Valhalla instances remain independently open/reopenable.
- [ ] Focused tests, full tests, typecheck, browser build, native audio-core tests, packaging, and `git diff --check` pass.
- [ ] Final packaged behavior is directly observed and validation project data is restored.

## STOP conditions

Stop and report rather than improvise if:

- Correct looping demonstrably requires a native protocol/version change.
- The existing portable compiler cannot compile arbitrary subranges without changing browser behavior.
- Loop-length rounding cannot be represented consistently in integer sample frames.
- Native editor title-bar closure cannot be observed from the worker without changing ownership/lifetime semantics.
- Any required fix would overwrite or revert pre-existing user changes.
- A focused verification still fails after two reasoned repair attempts.
