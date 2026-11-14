# Area 2: Transport, playback, recording, metering

## Summary

Transport/playback has deliberate coalescing and cancellation for asynchronous starts, seeks, and structural rebuilds, and recording writers enforce bounded queues. The clearest user-facing rough edges are that transport buttons offer no pending feedback while lengthy async starts run and audio recording starts have no equivalent in-flight guard. No verified dead-code candidates or broad playback/metering performance regressions found.

## Findings

### TP-01 — Audio recording start is not serialized

- **Category:** A
- **Evidence:** `src/hooks/useTrackRecording.ts:614-616`
  > `if (isRecordingInternal()) return { ok: false, reason: 'Already recording' }`
  `...`
  `activeCtx = {` (`:949`)
- **User experience:** `isRecordingInternal` is set only after asynchronous device, transport, and capture setup (`:994`). Repeated record actions during setup can both pass the guard and initiate setup for the same track. Since `activeCtx` is a single mutable owner, an overlapping attempt can replace the context used to clean up or save the earlier capture.
- **Minimal fix:** Add a start-promise/in-flight guard, as already used by `createMidiTrackRecordingController` (`src/lib/midi/midi-recording-controller.ts:82-84,257-263`), and clear it in `finally`. Disable or expose pending state for the record action during setup.
- **Size:** M
- **Risk:** med
- **Verify:** Browser E2E: delay microphone permission/capture setup, trigger Record twice, then assert one active capture, one take, and one cleanup.

### TP-02 — No pending feedback during playback startup

- **Category:** A
- **Evidence:** `src/components/timeline/TransportControls.tsx:79-90`
  > `onClick={() => {`
  > `  if (transport().isPlaying) {`
  > `    transport().onPause();`
  > `  }`
  `src/hooks/useTimelinePlayback.ts:703-711` commits `isPlaying` only once backend start succeeds.
- **User experience:** Startup awaits backend preparation and start before `isPlaying` changes. The button stays labeled Play and has no disabled/pending state while the request is in flight. Users can click repeatedly without knowing a start is underway; controller-side coalescing prevents some duplicate starts but does not communicate progress.
- **Minimal fix:** Expose a derived pending-start state from `useTimelinePlayback` using its existing `playAttempt` lifecycle, then bind button `disabled`/accessible busy state without changing its visual design.
- **Size:** S
- **Risk:** low
- **Verify:** Browser E2E with a delayed playback-start fixture: confirm the control exposes pending state, ignores repeated activation, and switches to Pause once started.

### TP-03 — Track meter updates replace unchanged level objects

- **Category:** B
- **Evidence:** `src/components/timeline/TrackSidebar.tsx:164-173`
  > `const next = {`
  > `  left: clampUnit(levels.left),`
  > `  right: clampUnit(levels.right),`
  > `};`
  > `if (previous?.left === next.left && previous.right === next.right) continue;`
- **User experience / maintenance cost:** The equality check skips unchanged values, but the callback still allocates one object per track before checking equality on every meter publication. This is a concrete allocation in the frequent metering path.
- **Minimal fix:** Clamp into scalar locals, compare them with the previous levels first, and construct the object only when levels changed. Keep the existing fine-grained store updates.
- **Size:** S
- **Risk:** low
- **Verify:** Browser-observable meter check with instrumented allocations or a focused profiling session; confirm unchanged meter frames produce no per-track level objects/store updates.

## Looked at and fine

- Playback startup has attempt tokens and pending-start handling in `src/hooks/useTimelinePlayback.ts:572-620`; stop/pause invalidates in-flight starts. Structural rebuild requests coalesce using `pendingRebuildTracks` and `rebuildPromise` (`:1311-1393`).
- Active portable/native seeking deliberately rebuilds with explicit ownership and resume intent (`src/hooks/useTimelinePlayback.ts:1169-1184`). No verified playhead-jump defect found in the inspected seek path.
- Timeline keyboard handling routes Space through `handleTransportPause()` while recording, and protects buttons/editable targets (`src/hooks/useTimelineKeyboard.ts:191-200`; `src/components/Timeline.tsx:1638-1646`).
- Spectrum delivery coalesces native frames to one animation-frame callback and cancels subscriptions/frames on release (`src/hooks/spectrum-frame-delivery.ts:45-85`).
- Audio meter state updates skip unchanged values; stale track meter keys are removed when tracks change (`src/components/timeline/TrackSidebar.tsx:159-200`).
- Recording worker queues are explicitly bounded and fail on overflow (`src/lib/recording/recording-transfer-transport.ts:134-142`; `src/lib/recording/recording-writer-core.ts:205-212`). No unbounded recording queue identified.
- Sampler and drum-rack sync share sampled-region identity, loading, budget, validation, and cache primitives. Their track/pad-specific ownership and runtime behavior differ, so merging the two sync modules would not be a verified deduplication win.
- `compileLivePlaybackSnapshot` is shared by portable playback, native playback, and export/control consumers. Portable scheduling is also reused by the native schedule coordinator. No identical duplicated browser/native core was verified.
- Metronome is present; no count-in implementation was found in the scoped source. No dead exports/files/branches were claimed; scoped searches showed the inspected playback and scheduling modules have consumers.
