# Plan 003: Keep native live-note tails schedulable until explicit transport ownership ends

> Validate against the current externally modified source before editing. Preserve all user work. Implement the smallest native-only fix, test it, package it, and directly reproduce the four-repeat delay case. Do not commit or push.

## Proven root cause

- Native delay DSP feedback is correct. Repeat amplitude is approximately `A[n] = A[1] * feedback^(n - 1)`.
- `getEffectTiming(delay)` already computes a conservative finite tail from delay time and feedback.
- `createNativeScheduleCoordinator` captures one immutable `scheduleEndFrame` based on static arrangement content plus graph tail.
- Live urgent MIDI note-on/note-off events do not extend or rebase that schedule end.
- The final window sends `endsSchedule`, and `audio-host.cpp` permanently latches `schedule_complete`. It refuses later schedule windows.
- Therefore a live note released after coordinator creation receives only whatever fraction of the original static tail remains. If two delay intervals remain, the first two repeats sound and later repeats are cut.
- The native host tail observer covers VST workers only. It does not continue built-in delay/reverb DSP after the built-in schedule lifetime ends.
- Live built-in state patches can also preserve stale graph `tailFrames` after delay/reverb timing changes.

## Required fix

1. Separate finite arrangement completion from live-preview/live-MIDI schedule ownership.
2. A native session that accepts live MIDI must not irreversibly finalize its built-in schedule before all possible live note/release/effect tails are known.
3. Prefer a small explicit coordinator mode, such as `acceptsLiveMidi`, rather than inferring from track count throughout the scheduler.
4. In paused live-preview mode, maintain contiguous bounded lookahead windows without `endsSchedule`. Urgent live events and their built-in tails must continue processing until explicit Stop, project switch, suspension, host loss, or session replacement.
5. During active arrangement playback, live MIDI accepted near/past the static arrangement end must also remain audible through its current synth/effect tail. Choose the smallest correct existing-contract approach:
   - either keep schedules open for sessions that accept live MIDI and let explicit transport lifecycle end them;
   - or maintain a mutable end and extend it before the terminal window is published.
   The solution must cover notes arriving after a paused preview has already been idle longer than its static arrangement tail.
6. Do not attempt to append after `scheduleComplete`; the native host intentionally rejects it.
7. Preserve finite scheduling for sessions that cannot accept live MIDI if automatic finite completion is still required.
8. Recompute graph processor tail metadata when live built-in state patches change delay/reverb/modulation timing. Do not retain stale `tailFrames`.
9. Do not add arbitrary padding, timers, polling, browser fallback, or audio-core feedback changes.

## Regression tests

- Paused preview is prepared and remains idle beyond the static timeline end; then a live note is pressed/released through a delay configured for at least four audible repeats. All four repeat frame positions remain inside accepted schedule coverage.
- Same case with a long synth release and built-in reverb.
- Live note released near the end of active finite arrangement playback continues through its full current tail.
- A live delay feedback/time state patch updates the tail lifetime used for subsequent notes.
- Explicit Stop/project switch/suspend still clears or terminates sound deterministically.
- Non-live finite sessions retain their intended completion behavior.
- Host windows remain contiguous and bounded; no unbounded in-memory prequeue.

## Packaged validation

Use the currently open normal-profile project or relaunch the exact package with CDP after safely closing only validation-owned processes.

1. Track 2, stopped transport, delay configured so one note produces four clearly separated repeats.
2. Wait longer than the static project tail before pressing the note.
3. Press and release once. Confirm all four repeats remain audible and meters remain active at each repeat.
4. Repeat with long synth release and reverb/Valhalla.
5. Repeat near the end of active arrangement playback.
6. Confirm no native MIDI unavailable or generic VST degradation dialog.
7. Restore all modified project parameters and close validation-owned processes.

## Validation commands

```sh
bun test src/lib/desktop/native-schedule-coordinator.test.ts src/lib/desktop/native-playback-controller.test.ts
bun run typecheck
bun test
bun run build
bun run native:audio-core:test
bun --cwd apps/desktop package
git diff --check
```

## STOP conditions

Stop and report rather than improvise if:

- the current native host cannot process built-in DSP beyond accepted schedule frames without a wire change;
- keeping a live-MIDI schedule open causes unbounded memory/window queuing rather than bounded lookahead;
- correct behavior would require browser audio in Electron;
- a change would overwrite existing user work.
