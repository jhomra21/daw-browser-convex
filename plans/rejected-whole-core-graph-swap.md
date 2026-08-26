# Plan 001: Publish built-in graph changes without stopping audio

> Follow each step and verification gate. Stop rather than improvising if a graph-only update cannot preserve the active native session.
>
> **Drift check**: `git diff --stat 964a313..HEAD -- src/components/Timeline.tsx src/hooks/useTimelinePlayback.ts src/lib/desktop/native-playback-controller.ts native/audio-host-macos native/audio-core`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug/performance
- **Planned at**: commit `964a313`, 2026-08-01

## Why this matters

Built-in edits outside the current realtime target set still stop and recreate playback. `Timeline.tsx` calls `restartTimelineSchedule(..., { rebuildBackend: true })`; `useTimelinePlayback.ts` then sets playback false and disposes the prepared native/backend session. This necessarily cuts active audio, MIDI voices, and tails. The native host already supports preparing and publishing graph revisions on the active session, so built-in graph/state changes should swap revisions at an audio-block boundary instead of restarting transport.

## Current state

- `src/components/Timeline.tsx:741-765` maps supported commits to parameter events, but unsupported commits rebuild the backend.
- `src/hooks/useTimelinePlayback.ts:516-530` handles `rebuildBackend` by publishing the playhead, setting playback false, and disposing prepared backends.
- `src/lib/desktop/native-playback-controller.ts` retains the prepared graph and already serializes native graph snapshots.
- `native/audio-host-macos/src/main.cpp:674-688` exposes graph prepare, publish, retire, and rollback controls for the active session.
- `native/audio-host-macos/src/audio-host.cpp:1529-1541` already performs prepare/publish/retire without creating a new host process.
- Native graph history retention is keyed by stable processor identity. Preserve stable node/processor IDs.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Focused TS tests | `bun test src/components/Timeline.test.ts src/hooks/useTimelinePlayback.test.ts src/lib/desktop/native-playback-controller.test.ts` | all pass |
| Native tests | `cd native/build && cmake --build . --parallel && ctest --output-on-failure` | 6/6 pass |
| Typecheck | `bun run typecheck` | exit 0 |
| Package | `bun --filter @daw-browser/desktop package` | exit 0 |

## Scope

**In scope**

- `src/components/Timeline.tsx`
- `src/components/Timeline.test.ts`
- `src/hooks/useTimelinePlayback.ts`
- `src/hooks/useTimelinePlayback.test.ts`
- `src/lib/desktop/native-playback-controller.ts`
- `src/lib/desktop/native-playback-controller.test.ts`
- Desktop bridge/protocol files only if active graph revision methods are not exposed
- Native host/core tests needed to prove uninterrupted revision publication

**Out of scope**

- VST editor or VST parameter behavior
- New DSP algorithms
- Browser fallback redesign
- `AGENTS.md` and root `main.js`

## Steps

### 1. Add an active native graph refresh API

Add a controller method shaped for the single consumer, for example `refreshPreparedGraph(transport): Promise<Result>`.

It must:

1. Compile the latest snapshot while the current session remains active.
2. Reject if the session generation, transport epoch, or prepared ownership changed during compilation.
3. Install only newly required assets and coordinate changed VST attachments before publication.
4. Prepare the new graph revision on the existing active host.
5. Publish at the callback boundary.
6. Update `preparedGraph`, snapshot, meter/spectrum revision maps, and schedule coordinator only after publish succeeds.
7. Retire the prior revision after acknowledgement.
8. Roll back preparation and retain the old graph on failure.
9. Never call host stop/start, dispose, or change `isPlaying`.

Use a serialized refresh tail or generation token so rapid unsupported commits become latest-wins rather than concurrent graph transactions.

**Verify**: controller tests prove host `start`, `stop`, and process ownership calls are unchanged during refresh.

### 2. Route unsupported built-in commits through graph refresh

Replace the `rebuildBackend: true` fallback in `handleEffectParamsCommitted` and failed realtime delivery with:

- active/prepared native session: refresh the prepared graph in place;
- browser-only active session: preserve existing browser behavior until a browser hot-swap path exists;
- idle prepared native session: refresh or invalidate without stopping voices;
- unrecoverable refresh failure: report the failure, keep the old graph sounding, and do not automatically restart.

Topology/state edits such as EQ band enable/type/channel mode must use this path.

**Verify**: Timeline tests assert unsupported active edits request graph refresh and never request backend rebuild/disposal.

### 3. Preserve active voices, tails, transport, and telemetry

Add native regressions that publish a changed graph while:

- an instrument voice is held;
- a delay/reverb tail is active;
- transport is running;
- spectrum/meter subscriptions are active.

Assert there is no zeroed block at the boundary, transport frame/epoch continuity is correct, unchanged processor histories survive, and host/worker lifecycle counters do not change.

For a processor whose topology changed, reset only that processor’s incompatible history. Unchanged upstream/downstream processors must retain history.

**Verify**: native CTest passes, including realtime callback guard.

### 4. Bound rapid structural updates

Graph refresh is for discrete state/topology changes, not continuous pointer moves. Coalesce multiple pending graph refresh requests by project generation and keep only the newest snapshot. Never queue unbounded graph revisions.

**Verify**: a test fires several unsupported commits while the first prepare is pending and proves only the current graph is published, with no restart.

## Test plan

- Extend `native-playback-controller.test.ts` using its existing mocked bridge lifecycle assertions.
- Extend `Timeline.test.ts` to distinguish parameter event, graph refresh, browser fallback, and failure.
- Add native graph integration coverage modeled after existing graph revision tests.
- Runtime package check: play arranged audio or hold MIDI, toggle an EQ band/type and an effect enabled state, and confirm continuous meters/audio plus unchanged host/worker PIDs.

## Done criteria

- [ ] Unsupported built-in edits contain no `restartTimelineSchedule(...rebuildBackend...)` path during native ownership.
- [ ] Active graph refresh preserves host process, transport, held voice, and unchanged tails.
- [ ] Failed refresh leaves the old graph active and audible.
- [ ] Rapid refreshes are bounded/latest-wins.
- [ ] Focused tests, typecheck, all native CTest targets, realtime guard, and package pass.
- [ ] Only in-scope files changed.

## STOP conditions

- The active bridge cannot expose prepare/publish/retire without changing the wire protocol substantially.
- VST attachment changes cannot be coordinated before graph publication without stopping a worker.
- Native tests reveal graph publication must block the audio callback.
- The implementation needs to discard the current graph before the replacement is acknowledged.

## Maintenance notes

Keep parameter events for continuous controls. Use graph publication only for topology/state changes. Review every future built-in field and classify it explicitly as realtime parameter, graph revision, or unsupported, never as “restart playback.”
