# 10. Native audio-host graph updates

Read-only design investigation, 2026-10-15. Only this report was written. No app launch, build, tests, process signals, or subagents. References describe the working tree, not necessarily the currently packaged binary; concurrent work can move line numbers.

## 1. Current flow and consequences

1. **Broad invalidation:** `src/hooks/useTimelinePlayback.ts:1786-1802` fingerprints every track compiler input and clip, replacing AudioBuffer identity with a local ID. Add/delete/undo changes that string; this is not a topology-only comparison.
2. **Paused preview:** the effect at `useTimelinePlayback.ts:1847-1893` compares fingerprints. When a preview was requested and no live MIDI tails remain, it clears the request and calls `disposeNativePreview()` (`1858-1862`). It then requests another preview after pending disposal (`1878-1890`). Pending hydration and disabled/unready audio have additional disposal paths (`1864-1875`). Importantly, the effect **returns during playback or a structural rebuild** (`1855-1857`); it does not itself tear down every playing track edit.
3. **Playing/explicit structural edits:** `src/components/Timeline.tsx:749-772,800-809` captures playback intent and requests a backend rebuild. `useTimelinePlayback.ts:1333-1406` already coalesces synchronous structural requests with one justified microtask and a latest-pending drain. The active rebuild stops UI playback and disposes prepared backends (`1496-1512`), prepares another preview and resumes (`1523-1556`). Paused structural rebuilds also dispose then prepare (`1621-1640`). This path must change too, not just the fingerprint effect. Project ID/generation changes intentionally dispose separately (`1821-1844`).
4. **Renderer disposal:** `useTimelinePlayback.ts:1812-1819` increments an invalidation token and serializes disposal. `1221-1246` cancels pending preparation, attempts VST state capture, and disposes even if capture fails. `src/lib/desktop/native-playback-controller.ts:750-770` invalidates ownership, drains paging/stretch work, requests stop, cancels recording, releases assets, and calls session teardown.
5. **Physical restart:** preload maps teardown to IPC (`apps/desktop/preload.ts:387-389`). `apps/desktop/audio-host.ts:2691-2716` increments lifecycle generation, waits for an accepted recording Finish if pending, rejects other pending work, clears session ownership/hello, then calls `child.kill()` (default SIGTERM). Next supervisor start spawns and sends hostHello (`2092-2115,2163-2165`). Teardown during startup cancels that handshake rather than proving a crash.
6. **Reconstruction:** `native-playback-controller.ts:1095-1154,1231-1303,1327-1334` compiles graph/external latency, coordinates validated VST attachments, configures the device in a transaction, installs assets, publishes graph, configures instruments/transport, commits, rebinds meters, and starts audio.

### What is reset, versus restored

| State | Actual boundary |
|---|---|
| Playback position | Native frame/epoch/running reset on teardown (`native/audio-host-macos/src/audio-host.cpp:4090-4099`); renderer transport frame resets too (`native-playback-controller.ts:744-747`). The UI position is not necessarily lost: structural intent captures it and resumes from it (`Timeline.tsx:749-758`; `useTimelinePlayback.ts:1503,1524-1526,1584-1590`); paused preview reads the current UI playhead (`1880`). Continuity and elapsed audio during reconstruction are lost, not necessarily the displayed location. |
| VST workers/state | Native Stop stops workers; teardown clears attachments (`audio-host.cpp:4071,4089`). Live voices, tails and worker/editor lifetime do not survive. Opaque state capture is attempted before disposal, then validated captured state is supplied to attachment coordination (`useTimelinePlayback.ts:1230-1237`; `native-playback-controller.ts:1134-1143`). This is reconstruction, not preserving the running instance. Capture failure does not prevent disposal. State-support limitations are documented in `docs/native-vst3.md:123-127`. |
| Meters/spectrum | Ownership invalidation clears readings and graph bindings (`native-playback-controller.ts:713-727`); startup recreates revision mappings/subscriptions (`1327-1333`). Expect a blank/reset interval, not uninterrupted metering. |
| Latency/DSP history | Device block/sample-rate state resets (`native-playback-controller.ts:744-745`); graph/PDC and external latency are rebuilt (`1095-1099`). Destroying cores discards DSP/delay history (`audio-host.cpp:4080-4088`). Persisted latency configuration is not shown to be erased, but running compensation/history and worker readiness are recreated. |
| Recording | Disposal explicitly cancels recording (`native-playback-controller.ts:765`). Native Stop retires capture and abandons an unfinished recording session (`audio-host.cpp:4058-4069`). A pending accepted Finish has a supervisor barrier (`audio-host.ts:2701`); this does **not** make arbitrary graph edits safe during capture. Paused maintenance guards acknowledge recording clip hydration (`useTimelinePlayback.ts:1855-1857`). Do not claim an observed lost take: the diagnosis exercised no playback/recording. |

**Measured cost:** the diagnosis reports 23 spawns in one no-playback session and five closes during hostHello, versus one spawn for launch/quit; another log had generations 0–31 (`acceptance-reports/daw-experience-batch2-anomaly-diagnosis-2026-10-15.md:130-147`). Those logs lack timestamps and explicitly did not measure respawn duration. No directly attributable edit-to-ready duration was found in the searched acceptance evidence. Startup/renderer timings and test-suite durations are not respawn measurements. Gain in milliseconds therefore remains unquantified.

## 2. Existing protocol: substantial, but not end-to-end continuity

### Exists now

- **Whole graph revisions, without process restart:** protocol v23 defines graphSnapshot plus graphPrepare/Publish/Retire/Rollback/RevisionStatus (`packages/desktop-protocol/src/native-audio-host.ts:5,16,48-52`). Supervisor implementations exist (`apps/desktop/audio-host.ts:2489-2514`); native dispatch targets the active host for explicit revision operations (`native/audio-host-macos/src/main.cpp:877-900`).
- **Tracks, routing and built-in chains are representable:** `packages/audio-engine/src/native-host-wire.ts:370-447` serializes nodes, node latency, edges (gain, tap, sidechain, PDC), ordered processor descriptors and state. Add/remove is expressed by the next complete snapshot, not imperative addTrack/removeTrack messages. Changing topology does not intrinsically require a new OS process.
- **Native preparation/publication/retirement:** `audio-host.cpp:2060-2169` validates increasing revisions and prepares away from the render callback. It attempts same-core continuity, otherwise creates a replacement core. Publication while running waits on a condition variable for the render boundary (`2278-2355`); the render callback applies the swap and signals an acknowledgement (`4219-4254`). Retired cores are destroyed by the control-side retirement method (`2385-2406`). Rollback cancels a **prepared** revision (`2358-2374`), not arbitrary post-publication undo.
- **Existing cheap updates:** parameter, processor-state-patch and VST parameter wires are exposed (`preload.ts:372-374`). The renderer refuses a built-in state patch that changes processor latency (`native-playback-controller.ts:2038`); structural work cannot simply be disguised as parameter changes.

### Partially connected / constrained

- The renderer exposes only `publishGraph` (graphSnapshot), not explicit revision prepare/publish/status/retire (`preload.ts:356-389`; main handler at `apps/desktop/main.ts:1771`). GraphSnapshot itself calls native prepare/publish/retire (`main.cpp:877-880`; `audio-host.cpp:2045-2057`), so a same-process prototype is possible, but it hides continuity/status choices needed for a safe product policy.
- There is **no production `native-session-bridge.ts` module** in this checkout. `apps/desktop/native-session-bridge.test.ts:4-13` inspects main/preload/renderer types; its tests cover IPC shape and security, not packaged seamless edits.
- Same-core continuity is restrictive: `native/audio-core/src/audio_core.cpp:5761-5791` requires unchanged edge count/endpoints and all old nodes retained with matching layout/bus/latency. Ordinary connected track addition/removal or routing changes therefore generally fall back. Compatible processor history and selected removed effect tails can survive (`5811-5949`); PDC changes defer same-core preparation (`5472-5486`). **No respawn is not equivalent to preserved synth voices/reverb tails or click-free output.**
- Unchanged VST attachment objects can remain owned by a retained host, but adding/removing attachments after graph preparation is explicitly rejected (`audio-host.cpp:3945-3955,4007-4009`). Existing attachment coordination must not be treated as a hot-swap API.
- Schedule events are revision/epoch-scoped; old-revision events are dropped (`audio-host.cpp:4283-4291`). Renderer snapshot, asset/page ownership, scheduling, instruments, meters and revision must advance together. Calling publishGraph alone leaves these responsibilities unsolved.

### Missing for the promised experience

A renderer-facing graph-update coordinator with stable IDs and monotonic runtime revisions across undo; explicit continuity acceptance/fallback policy; atomic schedule/instrument/meter handoff; asset retirement after readers finish; state-preserving topology changes in the core; safe dynamic VST attachment staging/retirement; and a defined recording-edit policy. Existing wire commands should be extended/exposed, not replaced by a parallel protocol or new public project-mutation tools.

## 3. Options, ranked by product fit

### 1. (b) Retain the host and reuse revision updates, with an explicit continuity gate

**Scope:** `useTimelinePlayback.ts`, `native-playback-controller.ts`, `Timeline.tsx` rebuild entry; `src/types/desktop-bridge.ts`, desktop preload/main and protocol IPC channels/schemas to expose bounded revision operations/status. Reuse supervisor/native graph revision methods and existing serializer. Keep one active update and one latest desired graph, drained on completion events; revalidate project/generation before publish. No polling or debounce timer.

Start with unchanged attachment sets and supported graph shapes. Prepare resources and graph, configure prepared instruments, inspect continuity, publish at a render boundary, rebind schedule/meters, then retire old resources. Do not call device configure, session stop or teardown for ordinary edits. Preserve the old audible graph on preparation failure. Runtime revisions must increase even when undo restores older project content.

**Risk:** medium/high. Same-process fallback can still reset built-in state; revision-switched schedules can underrun; existing VST references and latency hooks need proof. Do not admit recording-time updates until capture ownership and Finish behavior pass acceptance. Expose continuity rather than silently treating fallback as success.

**Gain:** eliminates process/handshake churn for admitted updates and retains device/unchanged workers. It is an enabling slice, **not yet a complete track-add fix**: normal topology edits require option 2's continuity work to meet uninterrupted audio.

**Packaged verification:** paused add/delete/undo and bursts with timestamped spawn/ready evidence; require unchanged PID/generation/device session, exactly the latest graph and fresh meter bindings. During playback use a held synth note plus long reverb and an unaffected VST track; capture output and prove no gap, voice reset or tail reset. Verify rejected preparation leaves old audio running and emits an actionable result. PID stability alone is insufficient.

### 2. (c) Extend native continuity and VST lifecycle to cover ordinary topology edits

**Scope:** option 1 plus `native/audio-core/src/audio_core.cpp`, `native/audio-host-macos/src/audio-host.cpp` and header/main dispatch; VST attachment coordination/worker ownership where necessary. Preserve retained node/processor/instrument state by stable identity, preallocate new graph/storage off the callback, publish bounded pointer/slot changes at a block boundary, and retire removed objects only after render ownership ends. Extend the existing revision API rather than adding redundant add/remove commands.

**Risk:** highest. Remapping must preserve voices, DSP/PDC history and external hooks without allocations, locks or destruction on the audio thread. Dynamic VST insertion/removal needs staged trusted workers and safe tail/editor retirement. Recording must keep capture/monitor routing and spool ownership independent of graph replacement. Latency-changing edits need a separate policy, not an accidental reset.

**Gain:** the actual Ableton-style result: adding an unrelated track does not interrupt existing audio, including recording once certified. Broader scope than a respawn-count fix, but necessary for the stated standard.

**Packaged verification:** option 1 matrix plus built-in/VST insert/remove/reorder, sends/returns/sidechains, latency changes, capacity rejection and repeated undo/redo. Record a known continuous input while editing unrelated tracks; require one take, contiguous frame accounting, no added dropped frames/blocks, valid Complete proof/import/release and unchanged host identity. Save logs, action timestamps, diagnostic snapshots and captured WAV with repeatable gap/tail analysis.

### 3. (a) Coalesce rebuilds only, as temporary containment

**Scope:** paused fingerprint effect in `useTimelinePlayback.ts` and pending-preview cancellation in the controller. Reuse the existing structural rebuild queue (`1333-1406`) rather than creating another scheduling layer. Latest-desired-state draining after promise completion can prevent killing successive handshakes; synchronous Solid updates can be batched.

**Risk:** lowest implementation scope, but VST teardown/state capture, recording cancellation, gaps and latency reconstruction remain. Delaying teardown without explicit lifecycle ownership risks stale previews. A wall-clock debounce adds latency and requires timer justification/cleanup, so prefer event/microtask coalescing.

**Gain:** fewer spawns during bursts, not zero spawns per isolated edit. Does not meet uninterrupted track addition.

**Packaged verification:** repeat the diagnosis's add/delete/undo burst; timestamp actions and host events, compare spawn/hostHello-cancellation counts, and verify final tracks/transport. Require no stale preview after project switch or undo. Still measure audio gaps and recording interruption, rather than declaring success from reduced counts.

## 4. Recommendation and product decisions

Use option 1 as the integration seam and deliver option 2's **retained-state track topology support** before calling the ordinary add/delete/undo problem solved. Prioritize adding an empty unrelated track with existing built-in and VST audio continuing unchanged. Keep project switch, device change, explicit shutdown and unrecoverable host loss as separate lifecycle boundaries. Option 3 is containment only if acceptance needs an immediate reduction in churn.

No new public control mutations are needed. This belongs behind the existing renderer/native session boundary and canonical project edits. Preserve scanner/trust/fingerprint/state gates (`docs/native-vst3.md:101-107`).

User decisions:

1. When a live edit cannot preserve continuity (latency/capacity/unsupported VST), defer it audibly until Stop with a visible pending state, or reject it? Recommend defer/reject, never silently interrupt unrelated audio.
2. On deleting a sounding track/effect, cut its own sound immediately or allow tails to decay? Unaffected tracks must continue either way; this defines retirement behavior.
3. During recording, permit unrelated track edits once certified, but prohibit deleting/rerouting the recording target until Finish? Recommend that boundary initially, with explicit UI feedback, not cancellation of a take.

Validation performed: source and existing acceptance-evidence inspection only. No runtime continuity, timing or recording claims were newly tested. Future packaged verification must run after the currently active acceptance/dedupe work, in a separately authorized owned session.
