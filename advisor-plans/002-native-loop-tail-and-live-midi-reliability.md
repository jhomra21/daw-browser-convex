# Plan 002: Preserve native tails, synchronized loop transport, and live MIDI

> Validate every assumption against live code first. Preserve all existing user changes. Implement the smallest complete native-only Electron fix. Do not commit or push.

## Reported failures

1. MIDI notes with a long release and notes through reverb audibly stop too early or harshly.
2. Native audio loops, but the red arrangement playhead sometimes continues linearly, especially when Play starts inside the loop.
3. Intermittent VST/native-playback warning dialogs appear during the same flows.
4. Computer or hardware MIDI can be silent until arrangement Play initializes/crosses a MIDI note, then notes may work but release abruptly.

## Confirmed code defects

- `src/lib/desktop/native-playback-controller.ts:startAttempt` replaces the schedule coordinator using `refreshed.snapshot` but does not update `preparedSnapshot`. `currentPositionSec()` maps the public playhead using `preparedSnapshot`, so audio can loop while UI position remains linear.
- `startLiveMidiNote()` defers note-on until `ensureLivePreview()`. If release occurs while preparation is pending, the readiness continuation emits note-off, and `releaseLiveMidiNote()` schedules another note-off after the same promise. Short notes can become silent or clipped.
- Paused preview preparation in `useTimelinePlayback.ts` is keyed too coarsely. A prepared graph may not contain the current selected/edited instrument until arrangement Play refreshes the snapshot.
- Generic coordinator/refill failures are reported as native playback faults, and `Timeline.tsx` can bypass/degrade every external processor even when no plug-in worker failed.

## Required investigation before tail changes

Trace the actual native tail lifecycle end-to-end:

- timeline schedule end and `endsSchedule`;
- native host schedule-complete semantics;
- built-in synth release envelopes and active voice lifetime;
- built-in reverb/delay tails;
- VST declared/dynamic tail tracking;
- loop-boundary arranged note-off policy;
- graph rebuild/session teardown and all-sound-off paths.

Add reason-coded temporary diagnostics only if needed to identify the exact cutoff boundary. Remove temporary noise after diagnosis. Do not solve tails by an arbitrary fixed delay.

## Implementation requirements

### 1. Synchronize loop transport metadata

- On successful prepared-preview promotion, atomically update `preparedSnapshot` to the exact snapshot used by the replacement coordinator before exposing active playback.
- Ensure all rebuild/promotion paths use the same transport snapshot for scheduling and `currentPositionSec()`.
- Regression: prepare paused with loop disabled, then Play inside an enabled loop and advance several iterations. Audio schedule and public position must use the same loop mapping.

### 2. Make live MIDI readiness truthful and track-specific

- Never claim a native MIDI note started merely because the bridge exists.
- Ensure the prepared native graph contains the target track/instrument revision before accepting note-on.
- A short press released before preparation completes must either be rejected/not activated, or emit exactly one ordered note-on/note-off pair. It must never emit duplicate note-offs.
- Rebuild paused preview when instrument/track graph ownership changes, not only on project mount generation.
- Preserve deterministic release across Play, Pause, seek, loop wrap, project switch, and graph rebuild.
- Do not add polling or timers.

### 3. Preserve audible release and effect tails

- Distinguish timeline schedule acceptance/completion from audible DSP tail completion.
- Do not teardown, clear voices, reset DSP, or publish a terminal transport state merely because no more arrangement events remain while synth/effect output is still audible.
- Preserve built-in synth release, built-in reverb/delay tails, and finite VST tails according to existing native state. Infinite VST tails require explicit bounded/manual-stop semantics, not infinite UI playback.
- At a loop boundary, arrangement note ownership must remain deterministic. A note whose musical duration ends must receive note-off, but its release voice and downstream effects must continue naturally. New-loop retriggers must not hard-clear prior release/tail state.
- If native host tail-complete state is already available, reuse it. If it is not available and a protocol addition is necessary, add the narrowest explicit tail-active/tail-complete progress field rather than overloading `scheduleComplete`.
- Regression tests must cover long synth release, built-in reverb tail, finite VST tail, exact loop-boundary note-off/retrigger, and normal Stop/all-sound-off behavior.

### 4. Stop misclassifying scheduler faults as VST corruption

- Add structured native fault classification or preserve existing identity/reason data.
- Scheduler capacity/refill/transport-transition failures may stop/retry playback but must not mark every VST degraded.
- Only confirmed plug-in worker/host faults should degrade the affected external processor(s); do not globally bypass healthy processors without identity evidence.
- Add tests for persistent refill rejection versus a confirmed worker/plugin fault.

## Scope

Expected files include:

- `src/lib/desktop/native-playback-controller.ts` and tests
- `src/lib/desktop/native-schedule-coordinator.ts` and tests
- `src/hooks/useTimelinePlayback.ts` and tests
- `src/hooks/useTimelineMidiOverlay.ts` and tests
- `src/lib/midi/live-midi-backend.ts` and tests
- `src/components/Timeline.tsx` and tests
- Native host/core/protocol files only where concrete tail-lifecycle evidence requires them

Do not:

- add browser/Web Audio fallback in Electron;
- add arbitrary sleeps, polling, or fixed tail padding;
- reset the native epoch at each loop wrap;
- redesign the graph or effect ordering;
- degrade all VSTs for a generic scheduler error;
- modify unrelated files.

## Validation

Run focused regression tests after each area, then:

```sh
bun run typecheck
bun test
bun run build
bun run native:audio-core:test
bun run package:desktop
git diff --check
```

Use exact equivalent repository scripts if names differ.

## Packaged Electron validation

Use a clean packaged app/CDP process and the existing local validation project. Record original state and restore it afterward.

1. Enable a short loop containing a MIDI note with a long release. Play for at least five iterations. Verify the red playhead wraps with the audible loop and releases do not hard-cut.
2. Repeat with built-in reverb/delay and Valhalla. Verify tails continue naturally across note-off and loop wraps.
3. Start Play from inside the loop after a paused preview was prepared. Verify visual and audible loop positions remain synchronized.
4. While stopped, select the instrument track and play short and long computer MIDI notes before any arrangement Play. Verify immediate sound and natural release.
5. Repeat hardware MIDI if available.
6. Hold/release live notes across Play, Pause, seek, and loop boundaries.
7. Confirm no generic scheduler/transition failure bypasses or degrades healthy VST rows.
8. Capture screenshots/logs and remove validation-created processors/restore loop state.

## STOP conditions

Stop and report rather than guessing if:

- the cutoff cannot be localized to a concrete state transition after focused diagnostics;
- correct tail completion requires an unbounded or arbitrary timing heuristic;
- the fix would require browser audio in Electron;
- a required change would overwrite pre-existing user work;
- focused validation fails twice after reasoned repairs.
