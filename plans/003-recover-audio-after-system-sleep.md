# Plan 003: Recover audio deterministically after system sleep

> Execute step by step. Treat sleep as a planned session boundary, never as elapsed playback time or an ordinary host-loss timeout.
>
> **Drift check**: `git diff --stat 964a313..HEAD -- apps/desktop/main.ts apps/desktop/audio-host.ts apps/desktop/preload.ts src/types/desktop-bridge.ts src/hooks/useTimelinePlayback.ts src/lib/desktop/native-playback-controller.ts src/hooks/useTimelineMidiOverlay.ts native/audio-host-macos native/plugin-host`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-patch-built-in-state-without-stopping.md`
- **Category**: bug/reliability
- **Planned at**: commit `964a313`, 2026-08-01

## Why this matters

The desktop app has no explicit suspend/resume lifecycle. Playback position is extrapolated from `performance.now()`, native requests use two-second timers, live MIDI requests are serialized, and the native host retains queues across a plain stop. After sleep, overdue deadlines can falsely declare host loss, the playhead can jump by the sleep duration, and note-off/pause commands can sit behind stale work. Recovery must invalidate the pre-sleep session and restore a fresh paused session from committed state.

## Current state

- `apps/desktop/main.ts` does not subscribe to Electron `powerMonitor`.
- `apps/desktop/audio-host.ts` has one in-flight command plus urgent/refill/normal queues; each command has a two-second deadline.
- `src/hooks/useTimelinePlayback.ts:351-355,443-447` extrapolates native/portable position from a wall-time anchor.
- `src/lib/desktop/native-playback-controller.ts` serializes live MIDI through `liveInstrumentEventTail`.
- Visibility handlers panic some MIDI paths, but visibility is not a reliable system-sleep lifecycle.
- `native/audio-host-macos/src/audio-host.cpp::Stop` stops devices/workers but does not define a suspend boundary that clears all control lanes.
- Unscheduled urgent MIDI and processor events are not epoch-filtered and must not survive resume.

## Policy

- Sleep pauses playback and interrupts recording.
- Wake never auto-resumes playback.
- The playhead freezes at the last authoritative audio frame, not at wall time.
- The old native host/VST worker generation is discarded.
- Pre-sleep commands and replies are never replayed or accepted after wake.
- Resume re-resolves devices and prepares a fresh paused session.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Desktop tests | `bun test apps/desktop/audio-host.test.ts apps/desktop/request-queue.test.ts apps/desktop/native-session-bridge.test.ts` | all pass |
| Renderer tests | `bun test src/hooks/useTimelinePlayback.test.ts src/lib/desktop/native-playback-controller.test.ts src/lib/midi/live-midi-router.test.ts` | all pass |
| Native tests | `cd native/build && cmake --build . --parallel && ctest --output-on-failure` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |
| Package | `bun --filter @daw-browser/desktop package` | exit 0 |

## Scope

**In scope**

- Electron power lifecycle coordination
- Native supervisor planned invalidation
- Renderer playback clock freeze and recovery
- Live MIDI panic/generation invalidation
- CoreAudio/VST teardown and fresh preparation
- Recording interruption handling
- Native queue clearing and tests

**Out of scope**

- Automatic playback resume
- Saving partial interrupted recordings beyond already-safe committed data
- Persisting native host state across sleep
- Reopening native plugin editors automatically
- `AGENTS.md` and root `main.js`

## State machine

Electron main owns a monotonic `powerGeneration` and one of:

- `awake-idle`
- `awake-active`
- `suspending`
- `suspended`
- `resuming`
- `recovery-required`
- `faulted`

A reply is valid only if renderer generation, power generation, native-host generation, project generation, and transport epoch still match at the layers where they apply.

## Steps

### 1. Add Electron power events and generation

Subscribe only to Electron `powerMonitor` events `suspend` and `resume` in `apps/desktop/main.ts`. Translate them into application lifecycle records with a current-state query plus subscription for missed-event/reload safety:

- `suspended`
- `recovering`
- `ready`
- `failed`

Increment `powerGeneration` synchronously before callbacks. Gate new native/renderer operations while not awake.

**Verify**: bridge tests cover event registration, cleanup, and generation ordering.

### 2. Atomically invalidate the old native supervisor

Add a planned invalidation distinct from `lost()`:

1. Set suspended mode and increment lifecycle generation before rejecting anything.
2. Detach the child from active ownership.
3. Clear pending request timers.
4. Reject the pending request and all urgent/refill/normal queues exactly once as `power-suspended`.
5. Invalidate transaction owners/tokens.
6. Prevent `dispatchNext()` while suspended.
7. Ignore late stdout, ACK, diagnostics, close, and worker notifications from the detached generation.
8. Best-effort graceful teardown, then bounded forced termination.

Fix the existing teardown ordering so `rejectPending()` cannot dispatch another queued request before teardown state is installed.

**Verify**: suspend during handshake, pending ACK, each queue class, graph transaction, and teardown dispatch race.

### 3. Expose authoritative native and portable transport frames

- Native controller exposes latest schedule-coordinator rendered frame and sample rate.
- Portable worklet emits a versioned bounded `transport-position` status containing session/epoch, monotonic sequence, running state, and current transport frame.
- Validate identity, epoch, and sequence in backend/controller.
- Use a cache-busted worklet module version rather than changing an immutable `*-v1.js` module in place.

Remove wall-time extrapolation for native and portable tick, pause, rebuild, and suspend paths. Legacy Web Audio may continue using `audioEngine.currentTimelineSec`.

**Verify**: controller/worklet tests reject stale position frames and report monotonic authoritative positions.

### 4. Freeze renderer transport from authoritative audio state

On suspend:

- cancel playback RAF before evaluating a stale wall-time anchor;
- freeze native position from schedule coordinator rendered/current frame divided by sample rate;
- freeze portable position from its last acknowledged frame, adding an accessor if needed;
- use the last published playhead as fallback;
- set UI transport paused;
- dispose prepared backends/coordinators after position capture.

Add a defensive large-gap check in `tick()`: if elapsed display-clock time exceeds a bounded threshold, enter the same paused recovery path instead of advancing by the gap.

**Verify**: a multi-hour fake clock jump does not move the playhead or auto-resume.

### 5. Panic MIDI and invalidate live queues

Suspend ordering:

1. Gate keyboard/hardware/live MIDI ingress.
2. Clear browser and hardware router ownership, including sustain.
3. Best-effort send native all-sound-off through a dedicated suspend path not blocked by normal live MIDI tails.
4. Increment live MIDI queue generation and discard pending readiness/tails.
5. Destroy the old host whether or not panic acknowledgement arrives.

Held-key note-offs after wake must be harmless and no pre-sleep note-on may replay.

**Verify**: active notes and sustain clear; pending note-on/off promises cannot affect the new generation.

### 6. Quiesce native queues, CoreAudio, recording, and VST workers

Before old-host destruction:

- stop CoreAudio callbacks before worker miss accounting;
- clear urgent, instrument, source, processor, transport, schedule, and VST automation lanes;
- clear native/VST note ledgers;
- atomically detach and cancel/discard recording using existing failure cleanup, remove temporary PCM/locks and any auto-created empty recording track, and invalidate its generation;
- add a recoverable VST editor `suspendAll()` that generation-invalidates pending initialization/notifications, closes entries, then returns the manager to a reusable state. Keep quit-only `teardownAll()` permanent.

Correctness must rely on a fresh process/session, not successful pre-sleep acknowledgements.

**Verify**: native tests prove no queued event survives a suspend boundary and no stale worker miss diagnostics appear after wake.

### 7. Restore a fresh paused session

On resume:

1. Increment power generation again.
2. Ensure old child/process ownership is gone.
3. Resolve preferred/default output and input devices again.
4. Spawn a fresh host and workers.
5. Recompile/reinstall current committed project graph, assets, and VST attachments.
6. Create a new transport epoch and schedule coordinator at the frozen frame.
7. Keep transport paused and notify the UI that audio is ready.

If preparation fails, enter `recovery-required`, keep the UI responsive, and require explicit retry.

**Verify**: repeated suspend/resume is idempotent and each resume creates one fresh generation.

### 8. Add safe diagnostics

In development builds, log only:

- lifecycle state and generations;
- durations for suspend invalidation and resume preparation;
- count of discarded queued commands;
- device re-resolution outcome;
- whether recording was interrupted.

Do not log project data, note content, plugin paths, or user identifiers.

## Test plan

- Desktop supervisor: suspend during every request phase, no false loss notification, no post-wake timeout, old replies ignored.
- Playback: wall-clock jump freezes at authoritative frame and remains paused.
- Native controller: start, live MIDI, schedule, parameter, recording, and spectrum work from old generation is ignored.
- MIDI router: notes and sustain panic; late key-up is safe.
- Native host: all lanes empty after suspend and before fresh session.
- VST supervisor: pending slots and miss counters reset with worker teardown.
- Runtime: play and hold notes, sleep macOS, wake, verify no stuck note, no command replay, responsive UI, paused transport, and successful explicit play.

## Done criteria

- [ ] Sleep never advances transport by sleep duration.
- [ ] No pre-sleep command or reply affects the resumed session.
- [ ] No note remains stuck after suspend.
- [ ] Native request deadlines do not report false host loss after wake.
- [ ] Resume uses fresh CoreAudio/native/VST ownership and a new transport epoch.
- [ ] Playback remains paused until explicit user action.
- [ ] Repeated sleep/wake is idempotent.
- [ ] Focused tests, native CTest/static guard, typecheck, lint, and package pass.

## STOP conditions

- Recovery requires depending on asynchronous cleanup finishing before macOS sleeps.
- Old and new child generations cannot be distinguished reliably.
- An authoritative native/portable frame cannot be captured before invalidation.
- Queue clearing requires allocation or locking in the realtime callback.
- Recording salvage would require inventing missing frames or timestamps.

## Maintenance notes

Power lifecycle is an ownership boundary. Future timers, queues, workers, recording sessions, plugin editors, and device resources must carry or validate the active power generation rather than assuming process lifetime equals audio-session lifetime.
