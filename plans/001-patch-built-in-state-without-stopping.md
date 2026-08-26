# Plan 001: Patch built-in processor state without stopping audio

> Execute step by step. Never mutate active core state from the control thread and never fall back to a whole-core graph swap.
>
> **Drift check**: `git diff --stat 964a313..HEAD -- packages/audio-engine/src/native-host-wire.ts packages/desktop-protocol apps/desktop src/components/Timeline.tsx src/lib/desktop/native-playback-controller.ts native/audio-host-macos native/audio-core`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug/performance
- **Planned at**: commit `964a313`, 2026-08-01

## Why this matters

Unsupported built-in state edits currently call `restartTimelineSchedule(..., { rebuildBackend: true })`, which stops playback and disposes the prepared session. The existing native graph revision system cannot solve continuity because it prepares a separate audio-core handle; swapping it resets voices, sources, histories, and tails. Add a bounded same-core processor-state patch applied at an audio-block boundary so state-only edits change without stopping transport or clearing active sound.

## Current state

- `src/components/Timeline.tsx:741-765` restarts the backend when realtime mapping is unavailable or delivery fails.
- `src/hooks/useTimelinePlayback.ts:516-530` explicitly sets playback false and disposes prepared backends for rebuilds.
- `native/audio-host-macos/src/audio-host.cpp` owns fixed-size callback-safe command queues.
- `native/audio-core/src/audio_core.cpp` already decodes and validates canonical processor state during graph preparation.
- Existing whole-host revision preparation blocks other control queues and uses a separate core. Do not expose or reuse it here.
- Continuous fields already use processor parameter events. This plan covers state-only changes whose graph topology, latency, identity, assets, instruments, and VST attachments are unchanged.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Wire/protocol tests | `bun test packages/audio-engine/src/native-host-wire.test.ts packages/desktop-protocol/src/index.test.ts` | all pass |
| Desktop bridge tests | `bun test apps/desktop/audio-host.test.ts apps/desktop/native-session-bridge.test.ts` | all pass |
| Controller/Timeline tests | `bun test src/lib/desktop/native-playback-controller.test.ts src/components/Timeline.test.ts` | all pass |
| Native tests | `cd native/build && cmake --build . --parallel && ctest --output-on-failure` | 6/6 pass |
| Typecheck | `bun run typecheck` | exit 0 |
| Package | `bun --filter @daw-browser/desktop package` | exit 0 |

## Scope

**In scope**

- Native host wire serialization and protocol version/control ID
- Electron native session bridge plumbing
- Fixed-size native host patch command
- Audio-core callback-boundary processor state application
- Native playback controller classification, serialization, and latest-wins queue
- Timeline commit routing and focused tests

**Out of scope**

- Processor insertion, removal, reorder, routing, layouts, assets, instruments, VST attachments, or latency topology
- Whole-core graph revision redesign
- Browser fallback redesign
- Persistence schema changes
- `AGENTS.md` and root `main.js`

## Steps

### 1. Define a bounded processor-state patch contract

Add a binary payload with:

- expected active graph revision;
- stable graph node ID;
- stable numeric processor instance ID and processor kind;
- state schema version and byte length;
- bypass, layouts, latency, and parameter-target metadata required to prove descriptor compatibility;
- updated tail-frame metadata;
- canonical processor state bytes.

Use the next unused native control ID and increment the native protocol version. Reuse existing wire endian helpers and processor state encoding. Reject payloads beyond fixed state capacity.

**Verify**: serialization round-trip, malformed length, invalid version, and capacity tests pass.

### 2. Decode into inactive same-core staging off the callback

Add an additive audio-core staging API. On the native control thread:

- verify expected active revision and unique node/processor identity;
- verify kind, schema, state size, bypass, layouts, latency, and parameter-target compatibility;
- decode and fully validate canonical state into a preallocated inactive staging slot owned by the existing core;
- permit one staged/in-flight patch per core and reject another while occupied;
- publish only a fixed atomic token after staging is complete.

Do not mutate active processor state during staging.

**Verify**: staging failures leave canonical/decoded active state untouched.

### 3. Apply and acknowledge at the callback boundary

At the next internal audio block boundary, callback work may only:

- consume/check the fixed pending token;
- verify active revision and pre-resolved identity/index;
- copy/apply the already-decoded fixed-size state and tail metadata;
- write a bounded result token and signal the existing realtime bridge.

Do not parse wire bytes, scan the graph, call variable-length decoders, allocate, lock, or log in the callback. Desktop acknowledgement means applied or rejected at the callback boundary, not merely enqueued. For a configured idle host with no callback, use the same bounded apply function synchronously.

Preserve graph revision, transport, source state, instrument voices, processor history/PDC slots, and live parameter latches.

Reject revision mismatch, duplicate/unknown processor identity, incompatible state, malformed values, and staging overflow. Every rejection leaves the old state untouched.

**Verify**: realtime static guard passes.

### 4. Expose the operation through the thin desktop bridge

Follow existing session IPC naming and reply patterns in:

- `apps/desktop/audio-host.ts`
- `apps/desktop/preload.ts`
- `apps/desktop/main.ts`
- `src/types/desktop-bridge.ts`

Return acknowledgement of accepted/rejected patch. Preserve all existing bridge contracts.

**Verify**: desktop bridge tests prove exact bytes and error forwarding.

### 5. Classify snapshot differences before patching

In `native-playback-controller.ts`, compile the latest snapshot and compare it with the prepared snapshot.

Patch only when all of these remain identical:

- nodes, edges, processor order and identities;
- processor kinds, layouts, target mappings, and latency metadata;
- assets, instrument state/attachments, VST attachments, and routing.

Permit only fields explicitly classified by a per-kind compatibility matrix. Categories are continuous parameter event, compatible state patch, bounded transition patch, or structural/latency change. Reject unclassified fields. Send only changed eligible processors.

Serialize refreshes with one in-flight operation and one latest dirty snapshot. After acknowledgement update the cached prepared snapshot while retaining the host revision. On rejection, report failure but keep the old graph active and audible.

**Verify**: tests cover eligible state change, ineligible topology/latency change, rapid latest-wins updates, rejection, and ownership changes during compile.

### 6. Route state-only commits without restart

Keep continuous parameter events as the first choice. If mapping returns no event and native playback is prepared, request the state patch path.

- Eligible state-only change: patch.
- Structural/latency change: classify explicitly and keep current audio running; notify that the change will reconcile on the next normal preparation unless a separate continuity-safe topology feature exists.
- Patch failure: keep current audio running and notify.
- Never automatically call backend restart/dispose for native-owned built-in edits.

Browser-only ownership may retain existing behavior until it has an equivalent hot-update path.

**Verify**: Timeline tests prove no restart/dispose call for eligible, ineligible, or rejected native changes.

### 7. Prove voice and tail continuity

Add native tests where a state patch occurs during:

- a held synth voice;
- a running delay tail;
- a running reverb tail;
- active transport and telemetry.

Assert output remains nonzero through the patch boundary, unchanged histories continue, active revision/epoch remain stable, and host/worker lifecycle counters do not change.

## Done criteria

- [ ] State-only native built-in edits never stop/dispose/restart playback.
- [ ] Patch applies at a callback boundary with no allocation or locks.
- [ ] Held voices and active tails survive.
- [ ] Structural/latency edits are never misclassified as patches.
- [ ] Rejection leaves the old graph sounding.
- [ ] Rapid edits are bounded/latest-wins.
- [ ] Focused tests, typecheck, native CTest/static guard, and package pass.

## STOP conditions

- The patch cannot be applied at a callback boundary without allocation or locking.
- Processor instance IDs are not unique in the active graph.
- The requested change affects topology, latency, assets, instruments, layouts, routing, or VST attachments.
- Continuity tests fail or require a whole-core revision swap.

## Maintenance notes

Every built-in field must remain explicitly classified as continuous parameter, state patch, structural change, or latency change. Never use “restart playback” as an implicit fallback for an edit while native audio owns output.
