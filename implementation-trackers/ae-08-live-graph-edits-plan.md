# AE-08: live native graph edits

> **Revision 3 (2026-11-10) supersedes Revision 2 for phases 6–10.** See "Revision 3" at the end of this file. It was reviewed by Fable 5.2 (`acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-REV3-FABLE52-2026-11-10.md`) and is bound by `acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-NOTE-USER-DECISIONS-2026-11-10.md`.


## Revision 2 (2026-10-15)

Changes from the Opus review (`ae-08-plan-review.md`) and the user's latency decision:

- **Latency.** The dynamic two-read-head policy and the review's fixed budget are both replaced by the user's adaptive budget. Total output latency equals the current maximum path latency. A raise grows the budget at once and fades the whole mix for about 5 ms around the move. A drop waits for the next transport stop. Monitored and armed tracks skip compensation. The audible cost of a raise is an open point (see Latency policy).
- **Capacity.** The 10,000,000-frame framing and the "release-blocking capacity" language are removed. One constant, `kMaximumGraphLatencyFrames = 65,536`, is shared by both validators. Adaptive history memory: 32 MiB at 64 taps, 96 MiB worst case at 192 taps, preallocated at configure.
- **Deletion.** A 5 ms fade replaces the hard cut. There is still no tail decay.
- **VST insert.** The device shows at once and joins when ready. The plug-in loads once. Deleted instances stay parked for undo. New instances start in parallel. There are no pre-warmed workers.
- **Scope.** Plug-in restarts and latency reports that stop and restart the host are added (review F3), scheduled in phase 6 at the latest.
- **Review fixes.** All 13 suggested edits and the P0 and P1 findings are applied, except the review's fixed budget, which the user replaced, and its effort figures, which are corrected (see Effort). Findings F4 through F18 are reflected in the phase text.
- **Anchors.** Corrected: the prepare gate is at `audio-host.cpp:2095`, and the asset install gates are at `3282`, `3327`, and `3474`. The review cited 2071–2073 and 3255. The untimed publish wait is at `2345`.
- **Effort.** Phases 4 and 6 are revised, and phase 1 grows slightly. The phase sum is 59–94 engineer-days (see Effort).

Design plan, 2026-10-15. Source inspection only. No builds, tests, app launches, process signals, or subagents were used to produce this plan. Anchors refer to this working tree and must be relocated by function name if concurrent work moves them.

## Contract and delivery boundary

Implement the full AE-08 decisions in `experience-polish-tracker.md`, not the earlier investigation's proposed defer/reject policy. Track/effect/VST/routing add, delete, reorder, undo, and redo must not stop or reconstruct the running host, device session, retained voices, or retained tails. Runtime revisions increase even when project history goes backward. Deleted objects fade out over about 5 ms from the first available block boundary, then stop contributing. There is no tail-decay retirement lane. Memory reclamation happens later.

"Always live" means playback never stops while an edit is prepared. A new VST visibly enters **Starting…**, then joins at its scheduled seam when it is validated, state-restored, and ready. The user accepted this asynchronous startup as always live (2026-10-15). It is not "pending until Stop." It must not stall deletion, another track's edit, or the graph coordinator. There is no restart, cold-core, stop-and-resume, reject-for-continuity, or wait-until-Stop branch in the enabled live-edit path.

Existing trust failures, malformed projects, unavailable devices, plugin crashes, and actual resource exhaustion remain genuine failures, not ways to execute unsafe code. Preserve ongoing unrelated audio and report the failed object accurately. No implementation can guarantee successful execution of untrusted or missing binaries, or unlimited allocation. Never label a failure "applied," and never treat these error cases as the latency or topology strategy.

Phases 1–7 are independently packageable infrastructure and safety increments, not partial claims that AE-08 is solved. They do not enable a user-facing partial live-edit mode or add continuity-based rejection or defer UI. Existing behavior remains until phase 8 connects **all** required foundations. Phase 8 is the feature shipment. Phase 9 certifies the full campaign, and phase 10 removes obsolete edit machinery. Each phase has a packaged smoke or gate below. This sequence deliberately avoids shipping "same PID but reset voices."

### One architecture

Extend the existing `graphPrepare → graphPublish → graphRetire` lifecycle and `graphRollback` for unpublished work. Do not invent addTrack/removeProcessor native commands, a second transaction protocol, or public project-control mutations.

```text
desired project snapshot
  → compile monotonic runtime revision + resource delta
  → prepare immutable execution plan and schedule/resource bank
  → publish one bank at a render-block boundary
  → acknowledgement {revision, actual frame, completed render epoch}
  → retire unreachable bank/resources on control thread
```

Retained DSP is **single-owned mutable runtime state**. Immutable execution plans reference it through stable, generation-checked slots. Do not copy live voices, reverb buffers, or worker objects from the control thread while the callback mutates them. Do not render a retained processor twice during a transition. Diffing, ID indexing, allocation, initialization, validation, plugin launch, state capture, and destruction run off the audio thread. Build ID maps once, not nested old/new scans.

### Latency policy (user decision, 2026-10-15)

**Adaptive budget.** The total output latency L equals the current maximum compensated path latency. Each compensated path p gets compensation `L − lat(p)`, so every path's output lines up on the same content time. This replaces the review's fixed budget and the earlier two-read-head policy.

- **Edit does not raise L** (lowering edits and edits below the maximum included). Unaffected paths keep their compensation and stay sample-identical. Only the edited path changes, at its own seam (below).
- **Edit lowers the maximum.** L stays at its old value until the next transport stop, then shrinks while stopped, which is inaudible. Until then each path's compensation is still `L − lat(p)`, so unaffected tracks do not move. Start latency equals the current maximum, so a session that keeps running keeps the higher latency. The cost is latency only.
- **Edit raises the maximum by R frames.** L grows immediately. The whole mix gets one short, time-based fade: about 5 ms out and about 5 ms back in, around one seam frame S. Compensation moves by R on every compensated path at S. Otherwise unaffected tracks are sample-identical.
- **Monitored or armed tracks** skip compensation (compensation 0) and do not count toward L, like Ableton's Keep Latency. Their recording input accounting stays independent of output compensation.
- **Edited path seam.** The transition is scheduled at the write-frame seam, where the node output changes content, not at the publish frame. Use a time-based declick of about 5 ms when one signal ends. Use a linear crossfade of about 10 ms when both signals exist. In a crossfade, both read heads read the same retained tap history at different delays, so both carry the same content.

**Resolved (user, 2026-10-15): closest to Ableton.** Ableton keeps total latency equal to the maximum plug-in latency, with no headroom and no time-stretch. Users report a brief glitch when inserting a high-latency plug-in while playing. So the raise move below is accepted: no extra headroom, no slowdown. The move happens only when an edit raises the maximum during playback. It is masked by the fade-out and fade-in, and its length is reported by the analyzer, not counted as a defect. The original analysis follows. The 5 ms fade hides the seam. It does not hide the move. A raise of R frames forces every compensated path to repeat or skip R frames of content. If the fade is the only mask, the whole mix is silent or repeats for R frames. At R = 2048 frames (43 ms at 48 kHz), that is an audible gap or repeat on every track. Only raises of a few milliseconds fit under the fade. A fixed budget avoids this move until the budget is exceeded. Its cost is a start latency equal to the budget: 171 ms at 48 kHz for 8192 frames, or 1.37 s for 65,536. The analyzer must measure the raise move and report its length. It must not treat that move as a defect.

**Mechanics.** Use persistent source/tap history with read heads, not cold delay lines, core replacement, or playback seek. Retained edge histories are indexed by stable source/tap identity, not edge-array position. Write history even when the current compensation is zero. Prepare the next compensation table and read-head descriptors off-thread. The callback switches each read head at its scheduled seam frame, never at publication. Do not crossfade whole old and new graphs. Serialize transitions: one move is in flight, and later edits queue behind its completion event. No timer. New branches may warm while joining, but an existing branch must already have the history it needs at publication. Do not defer a latency edit to fill a missing history buffer.

**Capacity.** Today the graph rejects any edge above 8192 frames (`audio_core.cpp:1280–1288`, the `kMaximumFramesPerBlock` cap). The worker manifest allows 10,000,000 frames (`worker-supervisor.cpp:95`, `vst3-worker.cpp:702`). Replace both bounds with one constant, `kMaximumGraphLatencyFrames = 65,536`, which is 1.37 s at 48 kHz and 0.68 s at 96 kHz. Define it once in a native header both validators can include, following the existing dependency direction. A plug-in that reports more is a genuine failure with a precise message, for example: "This plug-in reports N frames of latency. The product maximum is 65,536 frames (1.37 s at 48 kHz)."

History holds one ring per distinct tap, with several read heads, not one copy per fan-out edge. Each history stores 8 bytes per frame (stereo float). At the product maximum:

| Case | Per history | × 64 taps | × 192 taps (worst case) |
|---|---|---|---|
| Adaptive, 65,536 frames | 512 KiB | 32 MiB | 96 MiB |

These figures cover 64 nodes with at most 3 taps each (pre-FX, pre-fader, post). Realistic maximums are about 64 to 128 taps. For comparison, `graph_delay_lines` is 16 MiB today (`audio_core.cpp:517`). Histories are allocated and prefaulted at configure, off the audio thread, so prepare never allocates. Memory does not change with sample rate, because the ceiling is in frames.

### Shared verification contract and exact commands

Commands below are executor instructions, **not commands run during planning**. Use the repository root:

```sh
cd /Users/juan/Documents/daw-browser-convex
bun run typecheck
bun run lint
bun test src/hooks/recording-lifecycle.browser.test.ts src/components/midi/midi-editor-persistence.browser.test.ts
bun run build && VST3_SDK_PATH=/Users/juan/Documents/vst3sdk-3.8.0 bun --filter @daw-browser/desktop package
```

Chromium tests here are Bun tests that build Solid fixtures and drive `agent-browser`, not Vitest. See `src/hooks/recording-lifecycle.browser.test.ts:1863–1947`. A browser fixture may serve its own generated test bundle. Never start the application dev server. Add browser and E2E cases **before** implementation. No new TS unit tests. Native isolation is justified for state ownership, delay math, and callback safety. Extend the existing C++ executables rather than building a new framework:

```sh
cmake -S /Users/juan/Documents/daw-browser-convex/native -B /tmp/ae08-native-tests \
  -DBUILD_TESTING=ON -DDAW_BUILD_PLUGIN_HOST=ON -DDAW_BUILD_AUDIO_HOST_MACOS=ON \
  -DVST3_SDK_PATH=/Users/juan/Documents/vst3sdk-3.8.0
cmake --build /tmp/ae08-native-tests
ctest --test-dir /tmp/ae08-native-tests --output-on-failure \
  -R 'daw-audio-core-test|daw-audio-host-macos-(test|graph-integration-test|transaction-test)|daw-host-recording-spool-test|daw-realtime-callback-static-guard'
```

Harness declarations: `native/audio-core/CMakeLists.txt:26–34`, `native/audio-host-macos/CMakeLists.txt:28–57`, `native/plugin-host/tests/worker_supervisor_test.cpp`. Check the plugin SDK CMake cache result rather than accepting a build without VST support.

Phase 1 adds the following **proposed**, not currently existing, tools and command contract:

```sh
bun /Users/juan/Documents/daw-browser-convex/tools/acceptance/ae-08-live-graph.ts \
  --phase 1 --out /tmp/ae08-phase-1
bun /Users/juan/Documents/daw-browser-convex/tools/acceptance/analyze-ae-08-continuity.ts \
  --run /tmp/ae08-phase-1
```

For each subsequent phase, substitute its number and output directory. These exact flags must be implemented in phase 1. Phase 9 also takes `--matrix full --repetitions 100 --vst-repetitions 20`, and both repetition flags are implemented in phase 1. The runner finds and hashes the packaged `.app` artifacts using the existing package-path resolution, never a dev Electron binary. It refuses simultaneous use of its disposable profile. Run it only after the currently active acceptance has finished and a separate owned run is authorized. Never launch, attach destructively to, or shut down that active app. Never use `pkill` or `killall`. Close only the runner's proven-owned app through its normal quit path.

Artifacts per phase: `provenance.json` (dirty-tree diff hash plus HEAD, app.asar/native/manifest hashes, device/sample rate/block size), `actions.jsonl`, timestamped `host.jsonl`, `revisions.jsonl`, diagnostic snapshots, screenshots, `output.wav`, `reference.wav`, `analysis.json`, and a short Markdown verdict. Logs contain wall and monotonic times, host PID, lifecycle generation, device-session identity, graph revisions, transport epoch and frame, worker instance and generation, publication frame, seam frame, and retirement epoch. They contain no credentials or plugin state bytes. Log on the control or telemetry thread through the existing RT bridge, not inside the callback.

**Capture actual live output**, not an offline export. Reuse existing loopback or recording infrastructure when available. Otherwise add a private, acceptance-opt-in post-master PCM tap into a preallocated SPSC ring in `AudioHost::ProcessPlanar`. Its control-side writer saves a WAV, and the run fails on any overflow. There is no public capture or mutation operation. This is a new diagnostic tap, not an assumed existing output recorder. Keep it independent of the record-target capture used in phase 7.

Fixtures isolate: continuous two-tone audio; a held built-in synth note; an impulse-excited long built-in reverb; an unaffected real trusted VST; and a sacrificial deleted wet track. Compare with an edit-free reference from the same deterministic fixture. Analyze sample counts, non-finite and clipped samples, unexpected near-zero intervals, discontinuities, per-band energy, held-note phase and envelope, and reverb decay residual around every **publication frame** and every **seam frame**, not only UI click time. Edits that do not raise L must null bit-exact on unaffected paths. A raise must match the declared move: its window is the 5 ms fade plus R frames at the seam. Outside that window, unaffected paths must match the reference shifted by R. Random VST output requires energy, envelope, and worker-continuity evidence, not a bit-exact oracle. Inject synthetic gap, retrigger, tail reset, wrong-delay, and unexpected-gap defects into analyzer input and require detection. Deletion's expected cut is measured separately, and only the deleted contribution inside its 5 ms fade is excluded.

## Phase 1: Evidence and owned packaged harness

**Failure modes first → guards**
- Stable PID conceals DSP reset → audio/reference analysis plus voice and tail fixtures.
- Offline render passes while the live callback drops → post-master live PCM capture; overflow is a failure.
- Runner harms active acceptance or user work → fresh private profile, proven PID ownership, no global signals.
- Sparse logs hide restarts or bad metrics hide silence → timestamp lifecycle and publication records, plus analyzer defect injection.
- Restarts and latency stops hide in the baseline → log each restart and latency cause with its flag or old and new value.

**Goal/result:** establish repeatable evidence without changing edit behavior. The baseline is allowed to fail continuity, and it must say so. It must also count restarts and latency stops.

**Files/functions:** extend lifecycle logging in `apps/desktop/audio-host.ts:2102–2164` (`start` spawn, hello, close) and `2691–2716` (`teardown`), and retain `lifecycleGeneration`. Add publication telemetry around `AudioHost::ProcessPlanar`, `native/audio-host-macos/src/audio-host.cpp:4219–4254`, via `SignalRealtimeBridge`, not callback I/O. Log the restart and latency branches at `native/audio-host-macos/src/audio-host.cpp:3204–3243` with their cause: the restart flag, and the old and new latency. Time each VST startup step in both the preflight process (`apps/desktop/vst3-preflight.ts:96–133`) and the playback worker (`native/plugin-host/src/worker-runtime.cpp:219–264`, `vst3-worker.cpp`): spawn, module load, component and controller init, setState, setupProcessing/setActive/setProcessing, and the preflight total. These are logs only. Add the two proposed `tools/acceptance/` files above. Reuse ownership, provenance, and CLI/UI workflows from `tools/performance/30-track/native-spool-acceptance.ts:125–260`, and use the actual WAV-reading helpers rather than copying its whole recording campaign.

**RT/latency/VST/recording:** only fixed, preallocated capture and telemetry storage. The writer and reclamation are control-side. No graph or PDC behavior changes. Observe existing workers without relaunching them. No recording-target semantics change. The runner uses disposable projects only. Later phases inherit the selected latency and attachment policies, not temporary alternatives.

**Verification:** shared build and package, plus `--phase 1` commands. Save an honest baseline with add, delete, and undo timestamps, respawn count, restart and latency-stop counts, per-step startup times, and measured output defects. Separately verify that capture-only edit-free playback has no capture-induced losses.

**Size/risk:** M (2–5 engineer-days), medium. Tool and analyzer work may proceed beside phase 2 once phase 1's `audio-host.ts` and native logging edits land. No shared-file concurrent editing.

## Phase 2: Expose bounded revision lifecycle on the existing session bridge

**Failure modes first → guards**
- Raw graph IPC becomes a public mutation bypass → existing main-frame and project ownership validators, and internal session-only channels.
- A stale undo revision collides with a runtime revision → per-host-generation monotonic allocator. The project revision is metadata, not the wire revision.
- A lost publication reply causes duplicate publish or rollback of active work → status reconciliation and the actual active revision. Never roll back a published revision.
- Mixed native binaries decode changed fields incorrectly → explicit protocol and artifact version updates, and a regenerated release manifest.
- Publish wait without a timeout hangs the native command loop on device halt → a bounded wait on every path, status reconciliation, and device-halt detection.

**Goal/result:** the renderer can prepare, publish, inspect, roll back unpublished work, and retire through the existing native revision lifecycle. Normal playback behavior is unchanged.

**Files/functions:** `packages/desktop-protocol/src/ipc-channels.ts:22–52` adds session channels matching the existing revision operations. `src/types/desktop-bridge.ts:171–224` (`NativeSessionBridge`), `apps/desktop/preload.ts:356–389`, and `apps/desktop/main.ts:1771` add typed methods with the existing payload limits, trusted sender checks, and ownership binding. They delegate to `apps/desktop/audio-host.ts:2499–2514` (`prepareGraphRevision`, `publishGraphRevision`, `rollbackGraphRevision`, `retireGraphRevision`) and the existing revision status request. They do not use `publishGraph`'s implicit retire. The publish wait in `native/audio-host-macos/src/audio-host.cpp:2330–2351` (`PublishGraphRevision`) has a 1 s timed wait at 2333, then an untimed wait at 2345. Bound it.

Reuse control types 36–40 in `packages/desktop-protocol/src/native-audio-host.ts:48–52` and dispatch in `native/audio-host-macos/src/main.cpp:877–900`. Extend the existing status serialization and decoding together with `native/audio-host-macos/include/daw/audio_host_macos.h` at `GraphRevisionStatus`, and `audio-host.cpp:2278–2406`:

```ts
// Fields on the existing revision status, not a new public operation.
type GraphPublicationProof = {
  requestedRevision: number
  activeRevision: number
  publicationFrame: bigint
  renderEpoch: bigint
}
```

Preserve the existing status fields and encode 64-bit counters consistently. Reserve readiness and retirement proof fields for later phases. The lifecycle is `idle → preparing → prepared → publish-requested → published → retired`, plus `prepared → rolled-back`. A timeout enters status reconciliation, not a blind rollback or restart.

**RT/latency/VST/recording:** IPC decoding and control-side only. The existing block swap and RT bridge remain the publication mechanism. No new callback waits, allocation, locks, or destruction. This phase does not make the current fallback continuity acceptable, and it does not enable live edits. Recording and VST attachment behavior remain unchanged.

**Verification:** add `src/lib/desktop/native-live-graph.browser.test.ts`, which exercises the real controller and bridge adapter in Chromium with delayed and out-of-order replies, ownership changes, and monotonic undo revisions. Run `bun test src/lib/desktop/native-live-graph.browser.test.ts`, the shared checks and package, and runner `--phase 2`. A packaged native revision roundtrip must report the same PID and generation and an accurate active revision.

**Size/risk:** M (3–5 days), medium. Sequential after telemetry lands. No parallel writes with phases 5, 6, or 8 to main, preload, or protocol.

## Phase 3: Retain DSP runtime through topology changes

**Failure modes first → guards**
- Node reindexing resets voices or binds another track's state → stable node, processor, and generation slot tables.
- Control thread races mutable DSP during preparation → immutable configuration only. Retain runtime pointers without reading histories.
- Deleted effect keeps decaying, or deletion contaminates another slot → a 5 ms fade-out of its contribution, then disconnection, then generation and epoch-delayed reuse.
- Large initialization or nested matching misses the callback deadline → initialize spare runtime slots off-thread and publish precomputed indices only.
- A retained source is rendered twice during a transition → one runtime execution per block, never dual whole-graph rendering.

**Goal/result:** the native core supports track, built-in chain, and routing topology changes without resetting retained state. Infrastructure ships before renderer activation.

**Files/functions:** `native/audio-core/src/audio_core.cpp:478–593` (`Core`, storage initialization), `5761–5949` (`same_core_graph_shape`, `prepare_continuity_state`), `6014–6094` (`merge_prepared_instrument_runtime`, `daw_audio_core_publish`), and `include/daw/audio_core.h` at the graph preparation and publication declarations. Replace the edge-count and all-old-nodes compatibility check with an off-thread continuity map over stable IDs and layouts. Separate immutable instrument config from live `InstrumentNodeState`. Eliminate callback-time bulk voice and config copies, and global history resets for edit publication. Preserve manual overrides, sample-source cursors, sustain, round robin, granular RNG, and modulation, filter, dynamics, and reverb state for retained identities.

Name these callback-side resets as removal targets. They are the `memset` of every history array on `kIncompatible` (`audio_core.cpp:6074–6085`), and the whole `InstrumentNodeState` copies in `merge_prepared_instrument_runtime` (`6014–6036`), both reached from the same-core publish. The publish becomes a pointer or index swap. Resets happen off-thread on spare slots. New incompatible or replaced objects get new initialized slots. Retained compatible objects keep their runtime. No global reset happens because one processor changes.

State slots: `free → initialized → prepared-ref → active-ref → retired(epoch) → free`. Reuse the existing two graph slots, prepared and published hooks, history slots, and retirement ownership. Extend the **existing** retire operation to acknowledge same-core plan retirement. Deletion never creates a tail-decay `RetirementLane` (`5811–5910`). Its storage is retained silently until safe. The only audible part of a deletion is its 5 ms fade.

`native/audio-host-macos/src/audio-host.cpp:2060–2169` and `2172–2275` must preserve this plan rather than selecting a fresh core after instrument configuration. Keep initial configure and cold-start behavior separate. Remove the edit-specific `CreateRevisionCore` escape only after phase 8 connects the end-to-end path. Phases 3–7 packaged cases exercise the new revision path through an acceptance-only internal fixture using the normal session bridge. Production UI activation still waits for phase 8. That fixture must not add a public control tool or permit arbitrary native frames.

**RT/latency/VST/recording:** the control side initializes all new DSP. Pointer and slot switches happen at `ProcessPlanar:4219`. Reclamation extends `RetireGraphRevision:2385`. No copying of mutable histories off-thread, and no mass zeroing at publish. PDC history slots move to stable tap slots in phase 4. Existing VST objects remain unchanged. The capture handle and spool stay host-owned, not plan-owned.

**Verification:** first extend `native/audio-core/tests/audio_core_test.cpp` and `native/audio-host-macos/tests/native_graph_integration_test.cpp` for connected addition, removal, reindex, and reorder, held sustain, long wet tails, deletion fade-out, and slot reuse. Run the native command block, the package, and runner `--phase 3`. Graph integration uses the existing revision path. Native tests are necessary because Chromium cannot inspect callback ownership.

**Size/risk:** XL (10–15 days), very high. Core work is sequential with phase 4. Pure acceptance fixture preparation can run in parallel in distinct files.

## Phase 4: Adaptive latency budget and seam-scheduled transitions

**Failure modes first → guards**
- A read head reads uninitialized or overwritten history → histories are preallocated at configure for every tap slot at the product maximum. Writes are always made, and absolute frame ranges are checked.
- Latency above the product maximum passes validation → one `kMaximumGraphLatencyFrames` constant, enforced by both validators. The failure message is precise.
- A raise moves every compensated path → one mix-wide fade around one seam frame, and the analyzer expects exactly that move (see Latency policy, open point).
- A lower moves unaffected paths → the budget shrinks only at transport stop. The analyzer checks compensation equals `L − lat(p)`.
- A latency jump clicks or silences the edited path → seam-scheduled declick or crossfade, with analytic references at ±1 frame and at extreme delays.
- Gain baked into a shared history breaks edges with different gains → the history stores pre-gain tap output, and gain is applied at read.
- A lookahead or FFT change resets unchanged processors → replace only changed algorithm storage and config. Retain unrelated runtimes.
- Overlapping raises or lowers corrupt the move → one move in flight. Later edits queue behind its completion event.

**Goal/result:** every supported latency-changing edit goes live while the transport keeps running. Unaffected paths are sample-identical unless the maximum rises, and then they move only by the declared raise. The policy is the one described in Latency policy.

**Files/functions:** `audio_core.cpp:1280–1288` validates the edge PDC against `kMaximumFramesPerBlock`. Replace that cap with `kMaximumGraphLatencyFrames`. `1410` (`has_pdc_change`) and `5472–5486` defer the change with `DAW_AUDIO_CORE_LATENCY_CHANGE_DEFERRED` (returned at 5483). Remove that deferral from the successful native live-prepare path. Keep the constant for portable callers. `517–518` stores block-sized rings by edge index. Replace them with per-tap history slots, sized at configure. `3590–3609` (`graph_edge_sample`) and `4527` advance those rings. Replace them with per-tap history reads at the revision's read-head descriptors. The history stores pre-gain tap output in a fixed power-of-two ring with an absolute write index, and gain is applied at read (review F4). Transition descriptors carry an absolute seam frame (review F5).

In `packages/audio-engine/src/native-host-wire.ts:370–447`, preserve whole-graph latency descriptors. Update the graph wire version only for necessary new descriptor fields, and update the native decoder with it. In `src/lib/desktop/native-playback-controller.ts:2012–2081` (`runBuiltInStatePatch`), latency-changing state routes to the same graph update. It is never ignored or disguised as a cheap patch. For a changed processor's own lookahead or history, share the stable input history and preinitialize its replacement storage. Run only that stage's seam transition if needed, and never duplicate retained upstream instruments or VSTs. Removing a processor fades its output over about 5 ms, then disconnects. The surviving path re-compensates under the policy above.

Worker-reported latency changes enter this chain through the phase 6 restart fix. Phase 4 supplies the publish path that accepts a changed latency for an attachment. Do not read the worker's latency here. Carry the value through existing typed worker notifications, generation-check it, recompute PDC, and publish. Do not add a public mutation. Update `native/plugin-host/src/worker-supervisor.cpp:95` and `vst3-worker.cpp:702`, and the associated manifest and transport serializers, only as the unified bound requires.

**RT/latency/VST/recording:** the selected policy is mandatory. Histories and read-head descriptors are preallocated on the control side at configure, so prepare never allocates. The callback writes each tap once, reads bounded heads, advances integer frame counters, and applies ramps at seam frames. Old descriptors are reclaimed after the completion event and the reader epoch. Record input accounting stays independent of output compensation. Adjust monitoring delay only, and never insert or drop captured input samples.

**Verification:** the native harness first covers zero → N → zero, raises and lowers, fan-out, sends and sidechains, the product maximum (65,536 frames), low and high sample rates, and a raise during a move. After every publish, assert these: compensation equals `L − lat(p)` for every compensated path; monitored paths have compensation 0; lowering moves no unaffected path, bit-exact; raising moves every compensated path by exactly R at the seam, inside the fade; the edited path's seam falls on the declared frame; the budget shrinks only at transport stop. Preserve voice and tail state throughout. Run the native checks and the package, plus runner `--phase 4`. Report peak RSS and callback timing. Inspect source for allocations, locks, and destructors in the callback.

**Size/risk:** L (6–9 days), high. Depends on phase 3. No concurrent core or wire writers.

## Phase 5: Atomic graph, schedule, assets and observation handoff

**Failure modes first → guards**
- A new graph drops old-revision note-offs, automation, or source events → a staged next-revision schedule bank, published atomically.
- The playhead advances during prepare and causes duplicates or a hole → publish at a chosen future block frame, with schedule coverage on both sides.
- An audio sample or page is freed under an active voice → stable asset IDs, voice and page leases, and epoch retirement.
- Updated meters clear or show another node → revision-local mappings prepared before publish, switched on acknowledgement.
- Seek, stop, or project-switch races with an update → generation and transport-transition ownership. Cancel only unpublished work.
- Prepare and asset install are refused while a retired or prepared core exists → staged assets bound to the prepared revision, and auto-retire of the previous core before the next prepare once its readers are gone.

**Goal/result:** native execution and renderer scheduling advance as one revision, without seeking, retriggering held voices, or clearing unaffected meters.

**Files/functions:** `src/lib/desktop/native-playback-controller.ts:615` (`createCoordinatorForEpoch`), `1091–1328` (projection, assets, and schedule setup), and `400–505` (meter and spectrum mapping). `src/lib/desktop/native-schedule-coordinator.ts:333,793–942` (`createNativeScheduleCoordinator`, `queueWindow`). `audio-host.cpp:2601` (`QueueScheduleWindow`), `4219–4349` (publish and lane drains), and `native/audio-host-macos/src/native-schedule-state.cpp` at its schedule staging types. The prepare gate is `audio-host.cpp:2095` (`PrepareGraphRevision`), which refuses while `HasQueuedControl`, `prepared_core`, or `retired_core` is set. The asset install gates are at `3282`, `3327`, and `3474`, and they refuse while `prepared_core` or `retired_core` is set. Review F9 cited 2071–2073 and 3255. Those are call sites or nearby lines, and the anchors are corrected here.

Extend the existing schedule-window envelope with a prepared revision or bank binding and a publication frame. Update `packages/desktop-protocol/src/native-audio-host.ts:109`, and the existing schedule serializer and native decoder, together. The existing active bank keeps accepting progress while the prepared bank fills. Publish readiness requires the graph, hooks, instrument config, assets, and initial schedule coverage. Native status reports the actual publication frame. If the requested frame passes while preparing, rebase the unpublished window to a later boundary from fresh progress. Never rewind or stop.

Reuse stable sample source IDs and cursors, and retained note ownership. Do not replay "initial synth state." Include held note-offs, live MIDI handles, and pending manual automation overrides in the handoff. Do not bump the transport epoch just because the graph revision changes. Keep active scheduling running while compiling. Do not require a global `HasQueuedControl` drain that starves automation. Existing event wire queues get revision-bank ownership, not a parallel scheduler.

Assets and pages: create only added resources, prefetch the publication horizon, and retain existing `createNativeTimelinePageManager` work. Release removed assets only after the plan, queued sources, voices, and pages have no readers. Keep revision retirement pending until those leases end, not until IPC acknowledgement alone.

**RT/latency/VST/recording:** prepare banks and maps off-thread. Swap bounded pointers or indices with the graph at a block boundary. Retirement uses completed render epochs and control-side release. Selected PDC transitions travel with the same publication. Worker pointers stay stable, with no reattach here. Capture, spool, and record-target identity remain outside schedule banks.

**Verification:** extend the phase 2 Chromium E2E with held notes, late replies, undo bursts, page preparation, seek and project switch, and stale meter batches. Run `bun test src/lib/desktop/native-live-graph.browser.test.ts`, the native checks, the package, and runner `--phase 5`. Assert no missed note-offs, no repeated note-ons, no paged-source underruns, and no subscription resets.

**Size/risk:** XL (8–12 days), high. Depends on phases 2–4. No concurrent writes with phase 6 in host, protocol, or controller.

**Status (2026-11-11): complete, packaged-certified after RC-P5c.** Ruling: `acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-RC-P5C-CERTIFIED.md`. Report: `RC-P5C-REPORT.md` in the same folder.

- **Package:** `app.asar` `7c367f0c089fb7ca07fe48f043bd07c8f9fb82cf587a45e7be0aca6dcb64b542` (5410452 bytes, built 2026-11-11 08:19:09). Native host `daw-audio-host-macos` `2290d6eee686aaa8112f11c3eca1140e41343e8bc2c70128933466656d64a52e`.
- **RC-P5c results:**

| Runner | Result |
|---|---|
| Phase 5, with effect-state | 9/9, 16/16 |
| Phase 4 | 9/9 |
| Phase 3 | 7/7 |
| r27 A / r27 B | 6/6 / 4/4 |
| Paging export / live | 6/6 / 6/6 |
| LAT1 phase 5 / phase 4 | PASS / PASS |

  The live cells read 11/12 in RC-P5c. Its one failure, `granular-8s-live`, was an oracle defect, fixed by P4. The packaged rerun on the same bytes passed all six live cells (`rc-p5c/PAGING-LIVE-RERUN-REPORT.md`). The export cells were not rerun.

- **Fixes that closed RC-P5b** (RC-P5b was NOT CERTIFIED: `RC-P5B-REPORT.md`, with its addendum):
  - **P1** (`rc-p5b/fixes/P1-FIX-REPORT.md`): a resumed session re-emits `ready` for its prepared sampled instruments. A seek during the preview's session start had left the paging pane on `loading`.
  - **P1-B1** (`rc-p5b/fixes/P1-B1-FIX-REPORT.md`): live publication refreshes the sampled-instrument track IDs, and adoption emits `ready`. This closes blocker 1 in `REVIEW-RC-P5B-FIXES.md`.
  - **P2** (`rc-p5b/fixes/P2-FIX-REPORT.md`): the r27 capture is selected by playback (transport advancing after the Play request), not by capture start. Tools only.
  - **P3** (`rc-p5b/fixes/P3-FIX-REPORT.md`): the import hashes in 64 KiB slices, not 1 MiB. The LAT1 stall was main-thread contention during import. Asset publications are now flagged by `asset-install` evidence.
  - **P4** (`rc-p5c/fixes/P4-FIX-REPORT.md`, review `REVIEW-P4.md`): the granular late-marker probe reads the selected capture through its transport-mapped block.
  - **Judge changes** (`rc-p5b/fixes/LAT1-PREP-OVERHEAD-REPORT.md`, `PARENT-RULING-LAT1-PREP-OVERHEAD.md` with its Correction): the median gate judges preparation time, `armed.wallMs − prepare.wallMs`, p50 ≤ 8 ms. The total prepare-to-publish p50 gate is gone. The p99 ≤ 60 ms, max ≤ 70 ms, asset ≤ 100 ms, lead 2–3 and 0 rebases gates are unchanged. An asset publication must carry `asset-install` evidence at the `assetPublicationFrame` the continuity analyzer reports.
- **Coalescing rejected:** `PARENT-RULING-P3.md` keeps both the track-only and the asset publication. The track-only one must meet the plain LAT1 targets.
- **Open items** are in §E of `ae-08-p5-processor-state-owner-plan.md` ("AE-08 phase 5 follow-ups"). None blocks phase 5 or C1.

Earlier status (2026-11-08): source-level work accepted through B6e and RC4 (`acceptance-reports/ae-08-phase-5-2026-10-18/README.md`, "Post-B6: B6e, DP-04, P1, Option A and RC4").

## Phase 6: Dynamic trusted VST staging, joining, parking and silent retirement

**Failure modes first → guards**
- An unchanged worker is respawned or restored → diff attachments by stable instance ID and validated identity. Retain the exact objects.
- A slow new worker blocks all edits → per-instance async startup. The device shows **Starting…** at once and joins on readiness.
- Delete or undo during startup resurrects an obsolete plug-in → instance generation and a desired-membership check at every async completion.
- A plug-in loads twice per insert → the preflight process that passes the gates becomes the playback worker, so the module loads once. Repeat inserts reuse a cached verdict keyed by bundle fingerprint, class ID, sample rate, and transport, and skip the preflight load. This phase verifies that the preflight process can be reused after its editor view is discarded.
- A plug-in launch bypasses trust or state gates → trust and state gates run before any module load. Native checks repeat at launch.
- Undo of a delete repeats the full startup → bounded parking of deleted instances (see below).
- Removal closes another editor, or captures after destruction → editor identity and generation binding, with independent editor and playback retirement.
- A worker fault globally mutes the host → instance-scoped fault output. Remove the graph-wide mute for isolated worker failures.
- Plug-in restarts and latency reports stop and restart the whole host (review F3, see Restart scope) → decode `restartComponent` flags. Parameter and title flags refresh metadata only. A latency report feeds the phase 4 publish path. The host is never stopped or restarted for these.

**Restart scope (review F3).** Scheduled in this phase at the latest. `restartComponent` maps every flag to `kRestart` (`native/plugin-host/src/vst3-worker.cpp:176–181`). The host then calls `Stop()` and `Start()` (`native/audio-host-macos/src/audio-host.cpp:3225–3243`). A changed latency report sets `native_graph_revision_required` and calls `Stop()` (`audio-host.cpp:3204–3208`, `3236–3238`). After a restart, the worker re-reads only the tail (`vst3-worker.cpp:1145–1156`, `native/plugin-host/src/worker-main.cpp:293–295`). It never re-reads latency after `kLatencyChanged`. Parameter and title restarts, which include routine preset loads, can be fixed earlier on their own. Latency reports need the phase 4 publish path and stay with it.

**Goal/result:** inserting a trusted VST never stops ongoing audio. Only the new plug-in starts, asynchronously. Removal fades its contribution and retires worker and editor resources safely. Plug-in restarts and latency reports no longer stop the host.

**Files/functions:** `apps/desktop/native-vst3-coordinator.ts:644–754` (`coordinateNativeVst3Attachments`) becomes delta-aware within revision preparation, rather than attaching everything in a cold transaction. Preserve canonical roots, consent, scanner protocol and classes, fingerprints, codesign, quarantine, arm64, the packaged release manifest, worker preflight, the parameter manifest, the bus and state revision, and transport limits. Preserve SHA-256 and the 512 KiB state ceiling. Stateless plugins use persisted parameters. Reuse `apps/desktop/main.ts:1721–1750` coordination and the existing `vstAttach`, `vstDetach`, and `vstStateSet` wire types (`native-audio-host.ts:22–24,37`). Bind staging to the existing prepared revision, and do not introduce a new transaction family. The preflight spawn is `apps/desktop/vst3-preflight.ts:96–133`, and the playback spawn is `native/plugin-host/src/worker-runtime.cpp:219–264`. Both are part of the single-load rule above.

`audio-host.cpp:3945–4009` (`AttachNativeVst`, `DetachVstReference`) replaces the `graph_prepared` prohibition with staged, active, and retired ownership. `1562` (`StartNativeVstWorkers`) becomes a per-new-instance startup helper that can run off-thread. `1792` (`RegisterPreparedGraphHooks`) binds only ready staged or retained objects. Never modify a callback-visible attachment map. Stable pointees are control-owned. Immutable hook banks contain generation-checked references. New startup must not hold the main native command loop or the Electron serialized command queue while waiting for worker-ready.

```text
desired → validating → starting → state-applied → warming → ready
        → join prepared revision → active → disconnected → retired
        active → parked (detached, bounded) → rejoin active | expired → retired
any pre-join state → cancelled/failed (generation checked, control cleanup)
```

The effect placeholder is transparent dry routing. The instrument placeholder produces only its own silence. The project edit is represented immediately, and the UI says **Starting plug-in… Audio continues.** Once state and parameters, bus configuration, the worker pipeline, and reported latency are ready, publish the join using the phase 4 policy. Use a crossfade where dry and wet both exist, and a seam-scheduled declick otherwise. The new instrument receives the current transport and the current held input state once. It does not replay past clip note-ons into retained instruments. Deletion preempts startup. The contribution fades out over about 5 ms, without waiting for state capture.

**Parking.** A deleted instance parks detached: no audio, and its editor is closed. It is kept for a bounded age (starting value 60 s) and a bounded count (4, per the review). It is released on expiry, project close, or session teardown. Undo of a delete rejoins the parked instance with its state in one publish. Each parked entry holds one plug-in instance, so its memory is measured in this phase. Because the budget does not shrink until transport stop, undoing a delete normally does not raise L.

**Parallel startup.** Each new instance starts on its own, in parallel with the others. A burst of N inserts takes about max(t), not sum(t). There are no pre-warmed idle workers. They save only the cheapest step, the spawn (about 5–20 ms), and they add idle memory.

`apps/desktop/native-vst3-editor-session.ts:170` keeps its separate supervisor lifecycle. Open only a matching ready generation. Retained editors stay open through unrelated changes. Removal closes its own editor off-thread, drains or ignores stale callbacks, and uses validated persisted state or an off-thread pre-removal snapshot for undo. Do not put a successful capture on the critical path to audible removal. A failed required state capture is an explicit persistence or recovery failure. It is not permission to fabricate state or restart the host.

`audio-host.cpp:907–934,4158–4164` currently has a global worker `mute_requested` path. Replace isolated-worker fault handling with per-attachment output isolation. Keep a separate fatal-host mechanism only for actual whole-host faults. Preserve the bounded supervisor restart policy and all trust gates.

**RT/latency/recording:** launch, state, editor, shutdown, and destruction run off-thread. Hooks switch with the prepared bank at a boundary. Detach audio first, then reclaim after render and worker in-flight epochs, and use process-group cleanup only for proven-owned workers. Retained workers never get a state reload, a note reset, or a redundant Start. Output PDC transitions cannot modify the recording spool or the input clock.

**Verification:** first add existing C++ supervisor and host harness cases for delete-while-starting, fault during join, stale ready, rapid undo, worker-hook retirement, parked-instance expiry, and restart and latency flags. The flag cases are: no host Stop or Start for parameter restarts, and a latency report updates the publish path without a Stop. Add an acceptance-only test VST3 built from the SDK samples. It has a switchable latency parameter and calls `restartComponent(kLatencyChanged)`. It is locally signed, trusted only in the disposable acceptance profile, and excluded from production packages. `docs/native-vst3.md:180–201` certifies only Valhalla today (review F11). Extend the Chromium E2E for placeholder copy and editor-generation handling. Package, then run runner `--phase 6` with the real trusted installed plugin and the test plug-in. Cover warm effect and instrument insert, remove, reorder, and undo. Include changed fingerprint and state-gate negatives, editor open through an unrelated edit, and an unaffected held synth and long reverb. Do not use public control for VST insertion. Use the UI.

**Size/risk:** XL (13–20 days), very high. Depends on phases 2–5. Separate editor-only work can run in parallel with phase 7 UI work after ownership contracts land. No shared main, preload, or controller writers.

## Phase 7: Recording-target lock, without stopping unrelated edits

**Failure modes first → guards**
- Delete or routing auto-finishes a take → replace settlement-on-destructive-action with a target lock.
- The lock is only visual, and keyboard, undo, or control bypasses it → a final mutation-owner check, not just disabled menus.
- A starting or finishing race unlocks the target early → the lock runs from accepted start intent through Finish completion and target clip handoff.
- Removing a group or return indirectly reroutes the target → compare the target dependency closure before and after the candidate mutation.
- An unrelated graph swap restarts capture or alters the frame count → capture and spool lifetime independent of graph revision and PDC.
- Shared collaborator edits evade local UI → authoritative target lease and lock checks in existing shared mutation paths.

**Goal/result:** unrelated edits stay available during audio or MIDI recording. The record target cannot be deleted or rerouted until Finish. Blocked actions do not stop recording.

**Files/functions:** `src/hooks/useTrackRecording.ts:206–219,330–383,416,622` (recording identity, cleanup, finalization, start). `src/hooks/useMidiTrackRecording.ts` at the target, start, and finish lifecycle. `src/components/Timeline.tsx:1451–1458` (`settleActiveRecording`, which currently stops the take), `1601–1620` (mutation settlement), and `2362,2665–2668` (routing and recording props). Replace "stop, then mutate" for target deletion and routing with a synchronous final guard. Keep the explicit user Finish and Stop flow intact.

Introduce a consumer-shaped `src/lib/recording-target-lock.ts`, used by the existing mutation owners, with `{projectId, projectGeneration, sessionId, targetTrackId, lockedRoutingIds, phase}` and `starting → recording → finishing → released`. Route delete, group and ungroup, routing, sends and sidechains, undo and redo, and restoration through a before-and-after comparison of the target and its routing. Allow unrelated effect edits, including on the target unless they reroute or delete it. Do not freeze the whole mixer.

Inspect the actual consumers of `Timeline`'s `settleActiveRecording`, then `src/lib/local-control/local-control-service.ts:633–720` (`commit`), before applying the plan. Also check the existing shared track lock checks in the shared mutation owners. There is no new public mutation, schema action kind, or raw store adapter. A local commit must recheck after async approval or lock changes. Shared durable operations must respect the current target lease. Native `PrepareGraphRevision` independently checks the capture-bound target routing in the proposed plan. That is a last invariant, not how ordinary UI edits are rejected.

UI: `src/components/timeline/TrackLane.tsx:75`, `TrackSidebarRow.tsx:357,525–573`, `TrackSidebar.tsx:430,574–588`, and `timeline-workspace.tsx:173–186,688` expose disabled Delete, output, send, and affected-group controls with an accessible reason. The track header shows the badge **Recording target locked**. The tooltip or inline notice reads **Finish recording to delete this track or change its routing.** Preserve the current transport button naming. Say "Finish" in guidance, and show **Finishing recording…** while locked. Use the existing notice and live-region UI for keyboard and undo attempts. Add no modal that interrupts recording.

**RT/latency/VST:** lock checks and config comparisons are control-side. `audio-host.cpp:3534–3637` capture and Finish own their independent handle and session. A live graph publish never calls Stop, Cancel, or ConfigureRecording, and never resets capture or monitor counters. PDC affects output monitoring only. New VST startup remains asynchronous under phase 6, not a capture dependency.

**Verification:** extend `src/hooks/recording-lifecycle.browser.test.ts` before code, with delete, reroute, group, undo, and control attempts, starting and finishing races, and unrelated edits. Mount the real sidebar and lane surfaces, not a static DOM substitute. Run its exact shared command and the package. Runner `--phase 7` records known continuous input while editing. Require one take, contiguous frame accounting, no added dropped frames or blocks, the original capture identity, and a Complete → import → release proof. Add lock screenshots and usable controls after Finish.

**Size/risk:** L (5–8 days), high. The lock and its UI may land once phase 2 lands (review F18). Packaged certification needs phases 5 and 6. Renderer UI and the lock helper may be developed beside phase 6, in disjoint files only. Native, controller, and Timeline integration is sequential.

## Phase 8: Switch every renderer structural edit to the live coordinator

**Failure modes first → guards**
- A paused fingerprint path tears down the host → route maintenance and explicit rebuild entry through one coordinator.
- An obscure effect or undo callback uses stop or rebuild recovery → inventory every caller, and prohibit edit-caused teardown with provenance logs.
- Burst updates starve deletion behind VST startup → publish placeholders and removals independently. Per-instance readiness schedules later joins.
- Stale project work publishes after a switch → generation checks at compile, prepare, and final publish.
- A no-fallback code path hides a failed edit as success → reconcile the active revision and surface genuine object failures, without restarting unrelated audio.

**Goal/result:** the full user-visible AE-08 ships. Add, delete, and undo tracks, effects, VSTs, and routing, in playing or paused preview, retain the host, device, and unaffected voices and tails. Recording with unrelated edits stays live.

**Files/functions:** add a private `src/lib/desktop/native-live-graph-coordinator.ts`, owned by `createNativePlaybackController` (`native-playback-controller.ts:298`). Reuse compilation, attachment, and asset helpers, not a copy of `startAttempt`. The API is shaped for this sole consumer: `requestUpdate(snapshot)`, generation invalidation, publication notifications, and retirement completion.

`src/hooks/useTimelinePlayback.ts:1333–1406` keeps the existing synchronous microtask and latest-desired drain. `1496–1556,1621–1640` replaces native structural stop, dispose, and reprepare with an update. `1786–1802,1847–1893` replaces the paused fingerprint teardown with a desired-snapshot update. Keep initial preparation and legitimate project-switch disposal (`1821–1844`). Broad fingerprints may still discover changes, but they no longer own host teardown.

`Timeline.tsx:749–809` (`captureStructuralPlaybackIntent`, `rebuildPlaybackBackend`), `1986–2062` (VST insertion and rebuild error handling), and `2377–2435` (instrument, bypass, and mixed reorder) submit updates. Remove the VST insertion catch paths that rebuild again. Preserve browser backend behavior separately. At `native-playback-controller.ts:673–778`, ownership invalidation and disposal remain exclusively session, project, device, shutdown, or host-loss work.

The coordinator has one graph prepare and publish in flight, one latest desired immutable snapshot, and separate per-instance worker startups. Drain on completion events, with no polling or debounce timer. Cancel only unpublished superseded revisions, and release their resources. After publication, reconcile to the latest desired state through a newer revision. Never cancel capture, stop transport, bump the host generation, or reapply retained instrument startup state for an edit. Initial startup may configure and start the device. Updates may not.

**RT/latency/VST/recording:** phase 3 stable runtime slots, phase 4 delay transitions, phase 5 atomic bank swap, phase 6 staged attachments, and the phase 7 lock are mandatory prerequisites. There is no fallback flag, no cold-core escape, and no "pending until Stop." A deletion starts its 5 ms fade at the first render boundary after the native update is available. It does not wait for worker shutdown or new worker startup.

**Verification:** run both Chromium files, the shared checks and package, and runner `--phase 8`. Exercise playing and paused held-note edits through the real UI and canonical actions. Cover undo and redo, mixed reorder, sends, returns, groups and sidechains, latency changes, and recording. Require exactly one host spawn for the owned session, an unchanged lifecycle and device identity, monotonic revisions, current meters, and passing WAV analysis. PID stability alone cannot pass.

**Size/risk:** L (5–8 days), very high integration risk. Sequential after phases 2–7. No parallel writers in playback, Timeline, or the controller.

## Phase 9: Packaged adversarial campaign and continuity thresholds

**Failure modes first → guards**
- A friendly fixture hides breaks → adversarial interleavings, maximum declared limits, and multiple buffer and sample-rate cases.
- Analyzer tolerances hide a short dropout → synthetic defect injection and checked frame windows at each publication and seam.
- Nondeterministic VST output produces false success or failure → separate deterministic built-in null tests from statistical plugin evidence.
- A recording passes playback but loses spool proof → independent input and take verification, plus Complete, import, and release checks.

**Goal/result:** reproducible packaged proof of the complete feature, with no remaining "source-only" continuity claims.

**Files/functions:** extend phase 1's runner and analyzer, and write to `acceptance-reports/ae-08-live-graph-<run-id>/`. Do not add a second runner protocol or public operation. Use existing public discovery, capabilities, snapshot, preview, approval, keyed commit, and re-observation for supported mutations. Use the UI for VST and editor operations. Include packet and status delays only through owned test-harness boundaries, never arbitrary production IPC injection. The test plug-in from phase 6 is part of the fixture set.

**RT/latency/VST/recording:** no algorithm changes here. Preserve the previous policies. Test long-latency attach and remove, live latency notification, a raise and a lower in the same burst, lookahead and FFT transitions, 100 bursts with undo and redo, delete while starting, an open editor, manual automation override, sustained live MIDI, paged playback, the record-target guard, and unaffected input. A genuinely faulty plug-in or trust negative must leave unrelated audio live and report the failure. It must not invoke a fallback.

**Verification:**

```sh
cd /Users/juan/Documents/daw-browser-convex
bun run build && VST3_SDK_PATH=/Users/juan/Documents/vst3sdk-3.8.0 bun --filter @daw-browser/desktop package
bun /Users/juan/Documents/daw-browser-convex/tools/acceptance/ae-08-live-graph.ts \
  --phase 9 --matrix full --repetitions 100 --vst-repetitions 20 --out /tmp/ae08-phase-9
bun /Users/juan/Documents/daw-browser-convex/tools/acceptance/analyze-ae-08-continuity.ts \
  --run /tmp/ae08-phase-9
```

Repetitions are set per row class: 100 for deterministic built-in rows, and 20 for VST and recording rows. Add a scheduled long soak. Record the wall-time budget, which is set from phase 8 timings.

Publish thresholds and raw figures:
- Zero unexplained missing frames, non-finite samples, gaps, retriggers, or tail resets.
- Zero edit-caused worker restarts, zero host Stop or Start from restart or latency reports, and zero rejected callback blocks.
- Edits that do not raise L null bit-exact on unaffected paths.
- A raise produces only the declared move, of exactly R frames inside the 5 ms fade.
- The deleted contribution is absent after its 5 ms fade.
- Measured compensated alignment is within one sample after each transition.
- Edit-to-publish P95 is under two render periods plus the measured prepare time. Confirm the figure by measurement.
- Numerical tolerance is calibrated from duplicate no-edit runs. It is never relaxed to accommodate a visible regression.

Report callback time and peak memory, not just wall-clock edit latency. Save a repeatable command and output hashes. Do not certify unavailable hardware or plug-in rows.

**Size/risk:** L (5–8 days), medium execution and high discovery risk. Analyzer and report review can run beside the matrix in different files. Do not run two packaged runs on the same profile or device capture.

## Phase 10: Remove edit restart path and document retained lifecycle

**Failure modes first → guards**
- Cleanup deletes actual shutdown, device, or host-loss recovery → delete by caller provenance, not by function name.
- Removing legacy ABI breaks browser, offline, or export consumers → retain compatibility constants and the initial `graphSnapshot` where consumers remain.
- A deleted helper is still used dynamically → compiler and package checks, and a source consumer inventory before deletion.
- Documentation promises more than measured behavior → link the campaign and describe the startup and latency-transition behavior honestly.

**Goal/result:** one live edit path, with no dormant restart fallback that can regress the experience.

**Files/functions/deletions:** remove native edit-specific stop, dispose, and restart branches at `useTimelinePlayback.ts:1496–1556,1621–1640,1858–1890`. Remove obsolete resume-intent plumbing in `Timeline.tsx:749–772` where no browser consumer remains, and the retry-via-rebuild paths at `1986–2062`. Delete the native edit cold-core fallback in `audio-host.cpp:2093–2128,2252–2275`, after proving that initial startup and offline consumers use their own lifecycle. Remove edit-created audible tail retirement paths at `audio_core.cpp:5862–5910`. Retain any portable or offline semantics that have live consumers rather than globally changing their contracts.

Keep `disposeNativeSession`, the session teardown IPC, `AudioHost::Stop` and `Teardown`, first configure and start, device and project changes, explicit shutdown, the accepted Finish barrier, and actual host-loss recovery. Keep `graphSnapshot` if startup or export still consumes it. Keep protocol compatibility symbols used by portable Wasm until a versioned migration proves otherwise. Do not create a nonexistent production `native-session-bridge.ts` just because a test has that filename.

Update `docs/native-vst3.md` (attachment, worker, editor, and latency behavior) and the AE-08 tracker evidence only after packaged proof. This is executor work. This planning task writes no such files.

**RT/latency/VST/recording:** no new mechanism. Retain block-boundary bank swaps, silent epoch retirement, the seam-scheduled latency policy, independent worker and editor lifecycles, and the record-target lock. Cleanup cannot turn safe retirement into callback destruction.

**Verification:** shared checks, the native harness, both Chromium files, the package, and runner `--phase 10`. Rerun the full matrix only if cleanup changes behavior. Audit the edit call paths in source to prove there are no configure, start, stop, or teardown calls, no continuity fallback, and no public catalog additions.

**Size/risk:** M (2–4 days), medium. Sequential after phase 9. No parallel edits to files being cleaned.

## Dependencies, parallelism and completion criteria

```text
1 → 2 → 3 → 4 → 5 → 6 → 7 (packaged completion) → 8 → 9 → 10
        └──→ 7 (lock and UI, may land after 2) ──┘
```

The lock and its UI can start after phase 2 (review F18). Their packaged certification also needs phases 5 and 6. The primary native and core path, phases 3 → 4 → 5 → 6, is sequential because it shares ownership structures. Parallel opportunities are limited to disjoint acceptance tooling, editor UI, and recording-lock surfaces with explicit file ownership. Size estimates are implementation effort, not a promise of calendar duration.

Parameter and title restarts can be fixed before phase 3, because they need no core change. Latency reports depend on the phase 4 publish path, so the latency stop stays until then.

Feature completion requires all currently supported valid edits, including latency and VST changes, to use the same live path. There is no restart fallback, no stop-only pending state, no continuity rejection, no reset of unrelated runtime, safe resource retirement, and certified recording behavior. Phase 4 completes when every supported latency edit, including raises to the product maximum, passes the packaged matrix. The raise cost in Latency policy must be confirmed before phase 4 code.

**Scope note for phases 6–10 (2026-11-08): non-live instrument edits.** Instrument edits outside the live parameter set are heard only after a playback rebuild, with an audible gap: the 21 non-live Synth controls on every engine (everything `mapInstrument` excludes, `src/lib/desktop/native-built-in-parameter-mapper.ts:154–168`), and Drum Rack, Sampler and Granular in the portable session, which has no live path for them (`src/lib/portable-browser-playback-controller.ts:2100`). This conflicts with "live graph edits never interrupt audio", so it belongs to the phases 6–10 plan. Sources: `dv01-parent/dp04/PARENT-RULING-P1-DESIGN.md` D5, `dv01-parent/boundary/REVIEW-RC4.md` §7 item 2, and `ae-08-p5-processor-state-owner-plan.md` §E "RC4 review follow-ups".

### Effort (Revision 2)

| Phase | Engineer-days | Risk | Change from the review |
|---|---|---|---|
| 1 | 2–5 | medium | Restart and latency logs, per-step startup timing (+1 day) |
| 2 | 3–5 | medium | Bounded publish wait |
| 3 | 10–15 | very high | None |
| 4 | 6–9 | high | Adaptive policy, not the fixed budget (review: 5–8) |
| 5 | 8–12 | high | Prepare and asset gates |
| 6 | 13–20 | very high | Restart scope, single module load, parking, parallel start |
| 7 | 5–8 | high | None |
| 8 | 5–8 | very high | None |
| 9 | 5–8 | medium execution, high discovery | Repetitions by row class, test VST fixture |
| 10 | 2–4 | medium | None |
| **Total** | **59–94** | | Realistic with discovery risk: about 80–115 |

The review's own figures sum to 58–92. Its stated 88 was an arithmetic slip. The adaptive policy makes phase 4 larger than the review's estimate, by about a day, so the total is about 1 to 2 days larger. Compared with the original plan (60–94), phase 4 is smaller, because burst chaining and the transition banks are gone. Phase 6 is larger, because of the restart scope, the single module load, and parking. Plan for about 80–115 engineer-days including discovery risk, in phases 3, 5, and 6 especially. Calendar time is longer, because packaged runs cannot overlap other acceptance runs.

## Final step: a scored track as the end-to-end proof

This step runs after phase 10, and after DV-01 and the AE-08 packaged certification. It is a user decision of 2026-11-07.

**What it is:** produce a finished track in the DAW, scored to a video the user will supply for an app the user is building. The track must exercise every shipped feature end to end:
- live graph edits during playback;
- built-in devices and instruments;
- VST, where certified;
- automation;
- recording;
- export.

**Why:** a real piece of music is the final evidence that the features work together, alongside the packaged campaigns.

**What it replaces:** the earlier idea of a song based on an RTS game. That idea is dropped.

**Open:** the video has not been received yet. Do not start this step until the user provides it. Record its path, duration and frame rate here when it arrives.
## Open implementation investigations, not reopened product decisions

1. Measure the memory and callback cost of full history provisioning at the product maximum on target hardware: 32 MiB at 64 taps, and 96 MiB in the worst case at 192. This is a measurement, not a release gate.
2. Latency notification support is located. `vst3-worker.cpp:176–181` maps restarts, `866` emits the latency notification, and `1145–1156` refreshes only the tail. The worker never re-reads latency on `kLatencyChanged`. A certified plug-in with a switchable latency is still needed (the phase 6 fixture).
3. Identify the existing authoritative shared-recording lease coverage, and whether indirect group and routing changes already consult it. Add checks to existing owners, not a public recording mutation.
4. Confirm a reliable owned live-output capture source on the acceptance machine. If none exists, implement the private SPSC diagnostic tap in phase 1.
5. Confirm the raise policy before phase 4 code: the audible cost of a raise move on every compensated path (see Latency policy, open point).

The latency policy, the deletion fade, and the VST join rules are user decisions of 2026-10-15. Do not misrepresent starting a native process as instantaneous.


---

## Revision 3 (2026-11-10): phases 6, 6i, 7, 8, 9, 10

Date: 2026-11-10. Planning only; nothing was built or run. Replaces the phase 6–10 text of `implementation-trackers/ae-08-live-graph-edits-plan.md` (R2) once the parent accepts it. Applies the draft (D), Fable 5.2's review (REV §1–§6), user decisions UD 1–12 and the test policy (TP).

Aliases: FR = `acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-PLAN-FABLE52-2026-11-10.md`. T = `implementation-trackers/ae-08-p5-processor-state-owner-plan.md`. UD = `…/PARENT-NOTE-USER-DECISIONS-2026-11-10.md`. TP = `…/REVIEW-TEST-POLICY-FABLE52-2026-11-10.md`. C = `src/lib/desktop/native-playback-controller.ts`. H = `src/hooks/useTimelinePlayback.ts`. TL = `src/components/Timeline.tsx`. PB = `src/lib/portable-browser-playback-controller.ts`. N = `native/audio-host-macos/src/audio-host.cpp`. AC = `native/audio-core/src/audio_core.cpp`. HDR = `native/audio-core/include/daw/audio_core.h`. WK = `public/audio-worklets/daw-portable-audio-core-host-v2.js`. RUN = `tools/acceptance/ae-08-live-graph.ts`. A = `tools/acceptance/analyze-ae-08-continuity.ts` (pinned hash `a5c4f5ff…7761`; any edit needs an analyzer rebase and review).

Line numbers were checked against the working tree by the draft and the review (2026-11-10). AC lines inside functions are within a few lines. Cited-through-FR items (`P5/README.md`, LAT1 ruling) were not re-read.

## 0. Binding decisions and corrections

- UD 1/6: every non-live instrument edit plays on with no gap, for **all four instruments** (Synth, Sampler, Granular, Drum Rack), on native and WASM, from the shared core. Supersedes `…/boundary/PARENT-NOTE-USER-DECISION-PORTABLE-MIXER-2026-11-08.md:9`.
- UD 2/9: a held note changes **instantly**, and so does a Sampler zone edit under a held note (start, tuning, and the like). UD 5: lowering polyphony makes the oldest notes give way with a quick fade. UD 12: the Synth polyphony control is capped at 32.
- UD 10: knob drags are perfectly smooth from the first delivery (design in §4).
- UD 7: a paused structural edit updates the live paused graph in place. UD 8: a failed live edit is never visible. No rebuild fallback, no gap, no dialog; the old graph keeps playing and staging is retried silently with a diagnostic log. Any such failure in certification is a product defect.
- UD 11: a loaded VST must never fail on our side. Only a plugin-caused failure is reported to the user.
- UD 3: portable and native recording behave the same, including the lock. UD 4: the parent commits at its discretion and pushes after each commit; the first commit comes when C1 certifies phase 5. Paused portable sessions are always live (`PARENT-NOTE-USER-CONFIRMATION-PORTABLE-LIVE-2026-11-08.md:3`).
- TP is in force. Each phase names its tier. Rows are not added as a completion condition; "source-level caller tests" are replaced by a row that performs the edit and asserts no dispose or stop in `host.jsonl`.

## 1. Verified findings that shape the plan

- No `native-live-graph-coordinator.ts`. Its job is done by `adoptSchedule` (C:3253), the schedule coordinator, the processor-state owner and `requestTimelineSchedule` (H:1530–1575). R2:321 is obsolete.
- `rebuildPlaybackBackend` (TL:883–895) is `requestTimelineSchedule(..., true)` (H:1526–1529). On a **playing native** session it already goes to `adoptSchedule` (H:1535–1566) and rebuilds only on outcome `rebuild` (H:1571–1572), whose only source is `external-attachment-ownership` (C:457–469; latency excluded, C:461–463). Real rebuild conditions:
  - playing portable: callers pass an intent, so `options` is set and H:1542 skips adoption;
  - paused, either engine: `resumePlayback: isPlaying()` (TL:871–872) fails H:1537; the paused preview is disposed with `"paused-preview-structural-change"` (H:2189–2192);
  - VST attachment change (C:465–469).
- Other exits: seek `rebuildBackend: true` (H:1324, H:1370); `retryNativeInstrumentPreparation` (TL:2473); legacy `restartTimelineSchedule` (TL:931, TL:1699); TL:1692 (portable-only loop toggle); PB:1818 (no fingerprint), PB:1827, PB:1833 (unsupported compile or different notes), PB:1854, PB:1859 (failed install); C:3244 and C:3252 throw on unsupported compile and `nativeSnapshotSupportError` (C:426–434: MIDI expression, sidechain with VST), reaching the catch at TL:2509–2516 ("Native playback rebuild failed"), which is user-visible and falls under UD 8.
- Non-live instrument edit on a playing native session (derived from source): `same_instrument_configuration` (AC:7208–7232) differs, so the node gets a fresh slot with `runtime = {}` and **no voices** (AC:7868–7893); the old slot fades out in 5 ms (AC:7826–7830, AC:8090–8112, `fade_frames` AC:7502–7503); new events go to the new slot only (AC:5323–5328). A held note dies and nothing sounds until the next note-on.
- Core live set is eight synth targets (AC:4251–4263); the descriptor holds at most 16 (`HDR:28`, `HDR:358`); a parameter event carries one float, the target in `note` (AC:4642–4645, `HDR:1059`). Synth `retrigger` is validated (AC:1215) and never read; the Sampler reads it (AC:4597). Capacity: Synth `min(32, polyphony)` (`packages/audio-engine/src/mixer/graph-contract.ts:139`), Sampler `min(32, …)`, Drum Rack fixed 32, Granular 2 (`packages/audio-engine/src/portable-session-compiler.ts:236,313,356`). `wasm_entry.cpp` is 3 lines; the WASM surface is in AC.
- The portable path refuses non-synth instruments before the core: PB:1705, PB:2250, `src/components/timeline/create-effects-panel-state.ts:395`.
- Worklet: `MAX_PROCESSOR_EVENTS = 256` (WK:15); `materializeSchedule` returns `null` at WK:2108, 2122, 2131 and silences a block (T:980–983).
- No `src/lib/recording-target-lock*`; `src/lib/track-recording-target.ts` and `track-recording-session.ts` exist. `settleActiveRecording` (TL:1520) is called on track delete (`src/hooks/useTimelineClipActions.ts:581`). `CreateRevisionCore` has no definition under `native/` (only `realtime_callback_guard.test.ts:160`).
- RUN rejects `--matrix`, `--repetitions`, `--vst-repetitions` (RUN:636) and phases above 5 (RUN:637). Measured packaged cost (`C1-REPORT.md`): phase 5, 9 rows, 4 min 26 s (1 launch per row, ~30 s); phase 4, 9 fixtures, 7 min 47 s (27 launches, ~17 s per launch).
- The repository has no CI. Every gate runs on one Mac, so packaged runs and CPU-heavy tiers need queuing (FR F6).

## 2. Dependency graph and parallel schedule

```text
C1 passes → commit + push (no worktree starts from a dirty parent)
  → SLOT 0 (serial, integrator + tools; before any phase starts)
      ├─ 7   lock + UI (renderer)          ┐ each finishes its LOWER layer against harnesses,
      ├─ 6i  core seeding + smoothing + WK ├ then takes its integrator slot
      └─ 6   VST staging (N, plugin-host)  ┘
  → SLOT 1: 7 → SLOT 2: 6i → SLOT 3: 6 → SLOT 4: 8 closure (each followed by a non-certifying smoke)
  → 7's portable parity acceptance (needs slot 2)
  → C2 (T4, one candidate for 6 + 6i + 7) → 8 sign-off → 9 campaign → 10
```

**Slot 0 (owner: one integrator worker; files C, H, A-rebase excluded, fuzz host, RUN, `tools/certification/`):**
1. §E blockers (T:1008–1011, T:1025–1027, T:1053): C keeps `preparedSnapshot.revision` when latency capture replaces the object (T:1011); `.catch` on `updateKeepLatency` (H:353). The analyzer part (T:1053, T:1071–1073) waits for the analyzer-rebase slot (§8).
2. Fuzz host models staged attachments (`ae-08-processor-state-fuzz-host.ts`), before any phase 6 product change (LAT1 lost two FAST-CERT runs on unmodelled fakes, FR §3.2).
3. RUN: `--rows` filter, `--matrix`, `--repetitions`, `--vst-repetitions`, phases 6/6i/7 accepted (RUN:636–637). A filtered run can never give a certifying verdict (campaign analysis needs all rows, A:806–808).
4. TP rollout steps 1–4 (`tools/certification/`): retire duplicate campaigns, base-commit detection with `--tier`, set-based test judge, invariant seed judge beside the hash judge. Reason: otherwise each core change still costs a full run.

**Disjoint writers after slot 0:**

| Owner | Exclusive files |
|---|---|
| 6 | N, `native/plugin-host/**`, `apps/desktop/native-vst3-coordinator.ts`, `vst3-preflight.ts`, `vst3-insertion-preflight.ts`, `vst3-attachment.ts`, `native-vst3-editor-session.ts`, `ae-08-phase-6-fixture.ts` (new). `apps/desktop/audio-host.ts`, `main.ts`, `preload.ts` are dirty and shared: forbidden unless the parent names an owner. |
| 6i | AC, HDR, `public/audio-core/daw-audio-core.wasm` (tracked binary; only 6i may rebuild it), WK, PB, `src/lib/desktop/native-built-in-parameter-mapper.ts`, `packages/shared/src/synth-params.ts`, `packages/shared/src/sampler-params.ts`, `ae-08-phase-6i-fixture.ts` (new) |
| 7 | `src/lib/track-recording-target.ts` / `track-recording-session.ts` (new file only if the lock does not fit), `useTrackRecording.ts`, `useMidiTrackRecording.ts`, `useTimelineClipActions.ts`, recording UI surfaces under `src/components/timeline/*` except `create-effects-panel-state.ts`, `ae-08-phase-7-fixture.ts` (new) |
| Integrator (slots 1–4, one worker at a time) | C, H, TL, `create-effects-panel-state.ts`, fuzz host, RUN dispatcher. TL edits: 7 at TL:1520; 6i at TL:2492–2508; 6 at TL:2109, TL:2128–2140, TL:2136; 8 at TL:2473 and the catch at TL:2509–2516. |
| 9 runner prep | new files under `tools/acceptance/` only; no edit to A before the analyzer-rebase slot |

Phase 7 step 7 edits N after phase 6's N work, in the same worktree and in a separate commit. Packaged runs are queued by the parent; no FAST-CERT or other CPU-heavy run starts while one is active. Phase 8 inventory (step 1) and phase 9 runner prep (new files) can start now.

## 3. Phase 6: dynamic trusted VST staging

**Goal.** Insert, remove, reorder or undo of a trusted VST never stops the host; a restart or latency notification never stops it; a worker fault mutes only that instance. Once a VST is loaded, our side never fails (UD 11).

**Done.** `publishAttachmentLatency`; latency is not a rebuild reason (C:461–463); adoption entry for processor insert (H:1561); phase 4 publish path takes changed latency (R2:204).

**Not done.** Every `restartComponent` flag maps to `kRestart` (`native/plugin-host/src/vst3-worker.cpp:178–180`). Latency report sets `native_graph_revision_required` and logs `host-stop-request` (N:4154–4162), then `Stop()` (N:4194–4196); restart is `Stop()` then `Start()` (N:4199–4201); a worker fault takes the same stop path (N:4186–4189). `AttachNativeVst` refuses once a graph is prepared (N:5019–5021). Rebuild on attachment change (C:465–469). TL rolls back with a second rebuild (TL:2109, TL:2136).

**Steps** (slot 0 covers §E blockers and the fuzz host).
1. **Plugin-host flag decode** (`vst3-worker.cpp:178–180`, `worker-supervisor.cpp`, `worker-runtime.cpp`, owner 6): parameter/title flags refresh metadata, latency flag carries the value, only component-restart flags stay `kRestart` for the worker's own re-setup.
2. **Host, no global stop** (N:4154–4201): latency → existing typed publish path; restart → worker-local; fault → per-attachment output isolation; global stop only for a whole-host fault (R2:276). Reuse the bounded supervisor restart policy.
3. **Staged attach** (N:5021, `StartNativeVstWorkers`): replace the `graph_prepared` refusal with staged/active/retired ownership; startup per instance off the command loop; hooks bind only ready objects.
4. **Spike with stop rule: module-load reuse.** Prove first whether the preflight process can become the playback worker (`vst3-preflight.ts`, coordinator). If not, phase 6 keeps two module loads and acceptance line "one module load per insert" becomes "two". Decide before step 5 depends on it.
5. **Coordinator delta** (`native-vst3-coordinator.ts`, `vst3-insertion-preflight.ts`, `vst3-attachment.ts`): diff by instance ID and fingerprint; parking 60 s, 4 instances (R2:270), measured here.
6. **Failure attribution (UD 11).** A staged plug-in that never becomes ready or crashes is a plugin failure: audio continues, the device shows a failed state on its own title bar, no dialog, and the failure is reported. Anything our side can cause (stale ready after undo, startup race, join lost, lost hook binding, host stop) must never reach the user and counts as a defect. Attribution rule: see open question 3.
7. **Renderer (integrator slot 3):** delete the C:465–469 reason; replace the catch-and-rollback at TL:2128–2140 with the UD 8 behaviour (old graph keeps playing, silent retry, log). The adoption call already exists; nothing to rewire. Join uses the LAT1 late bind and per-engine rule (`PARENT-RULING-C1-PHASE4.md:8–9`, via FR §3.2).
8. **Test VST3** (locally signed, acceptance profile only, R2:280) with switchable latency, an injectable plugin-side fault and a delayed-ready mode. Spec now, build with step 1.

**Failure-first witnesses.** C++ harness: no `Stop`/`Start` on parameter-only restart; latency change publishes without `Stop`; delete during startup; fault during join leaves other audio running; stale ready after undo; parked instance expiry; rapid insert/undo burst; `AttachNativeVst` with a prepared graph succeeds. Fuzz: staged attachment, join lost, undo during startup. Chromium E2E: placeholder copy, editor open through an unrelated edit.

**Acceptance.** Zero host `Stop`/`Start` from restart, latency or fault in `host.jsonl`; held synth and long reverb unaffected by an unrelated insert, bit-exact **only where the declared latency is unchanged** (an insert with latency moves compensation by design); a plugin-fault row shows other audio live and the failed state on the device; no our-side failure in any row; FAST-CERT green on the final bytes. No new mutation arms as a completion condition.

**Tier.** T2n (native, plugin-host, wire) plus T2 for C and H; non-certifying packaged smoke at merge (own rows via `--rows` plus phase 5). Parked-instance limits and per-insert time are measured here (feeds §8).

## 4. Phase 6i: instrument edits with no gap, smooth drags

**Goal (UD 1, 2, 5, 6, 9, 10, 12).** Every instrument edit on all four instruments applies to sounding notes at once with no gap on native and WASM, from the shared core, and every continuous knob drag is perfectly smooth.

**Done.** Eight live synth targets (AC:4251–4263); mapper declares an edit live only for those and returns `undefined` for `retrigger`, `polyphony` or other compiled state (`native-built-in-parameter-mapper.ts:151–168`); the core keeps a replaced slot beside its replacement (AC:7826, waveform crossfade AC:8009); portable prepares, stages and publishes on the core (PB:1807–1859). Synth envelope values are read per frame (AC:4274–4285), so a changed config reaches sounding voices immediately.

**Not done.** The replacement slot starts empty (AC:7886–7892). Panel asks for a rebuild (TL:2492–2508, rebuild at TL:2507). `adoptLive` refuses non-synth and changed notes (PB:1827, PB:1833). Worklet 256-event cap (WK:15, 2108–2131). Sampler zone clamp (T:936, `packages/shared/src/sampler-params.ts:147`). Synth polyphony control allows 128 (`packages/shared/src/synth-params.ts:24`).

### Mechanism A: voice seeding at publish (gapless, instant)

At the callback side of publish (`begin_node_dips`, AC:8098–8112), copy voice, grain and note state from the old slot into the new one, keep the new slot's configuration, keep the 5 ms crossfade (AC:7826–7830). Copied voices take the new settings at once because render reads config per frame (AC:4270–4299). No descriptor, wire or contract change, so 6i stays out of N and the contract hash; only the core binary and `daw-audio-core.wasm` change.

- **Polyphony lowered (UD 5):** copy only the voices that fit; the rest stay in the old slot and leave with its 5 ms fade. Victim order is the existing one (AC:4692–4697): released first, then oldest. Raised: sounding voices unchanged.
- **Sampler and Drum Rack (UD 9):** a voice copies zone-derived values at note-on (AC:4627–4633) and stores no zone identity. Add a zone reference to the voice and read zone start, end, loop, tuning, gain and pan through it each frame, so an edit under a held note takes effect instantly. The clamp (T:936) must clamp the edited bound and not drop the zone. Per-field table committed with the code. A swapped asset: see open question 1.
- **Granular:** per-field table for grains, frozen position and seed (AC:538–553); state which fields copy.
- **Risks to close before code:** copy cost on the callback (32 voices, 32 sample voices, 128 grains, 32 zones; allocation-free, must pass the realtime guard, measured at several instruments replaced in one publish); assets resident until the old slot retires (check against phase 5 paging); blend-chain limit of eight unfinished replacements (AC:7996–7997, AC:8002–8004), which a failure may not surface under UD 8; no level bump while both slots render copied voices (complementary weights, AC:5330–5332).
- **Synth polyphony cap (UD 12):** cap the control at 32 in `synth-params.ts:24`. Saved values above 32 already compile to `min(32, …)` (`graph-contract.ts:139`), so nothing audible changes.

### Mechanism B: smoothing inside the shared core (UD 10)

Today a live parameter event is a **step**: `apply_instrument_event` → `set_synth_parameter` writes the config at the event frame (AC:4642–4644, AC:4251–4263) and render reads it per frame (cutoff and resonance feed a per-sample biquad, AC:4305–4318; gain and pan AC:4322–4326), so a drag zippers. A non-live edit is a 5 ms crossfade per publication. Neither is smooth across a drag.

Existing smoothing in the core, which the design follows and does not replace:
- fader ramps: `MixerRamp` (AC:944–951), set at publish with `from = applied`, `frames = plan.fade_frames` (`begin_mixer_ramps`, AC:8127–8145), applied per frame (AC:2316–2344);
- edge gain ramps: `EdgeRamp`, from the applied value (AC:4012–4015, `begin_edge_ramps` AC:8152–8166);
- per-frame slew: `clamp_bypass_step` (AC:2346–2350) and `advance_bypass`, a 10 ms linear move computed from the sample rate (AC:2355–2359).

Design:
1. Each instrument node's runtime keeps an `applied` copy of its continuous config fields. Render reads `applied`, never the config. Each frame, `applied` moves toward the config with the `clamp_bypass_step` pattern, with the step derived from the sample rate as in `advance_bypass` (AC:2356). Because the slew sits on the config, it smooths both live events (AC:4642) and publication-driven edits with one mechanism, on native and WASM alike.
2. **Continuous-only edits do not replace the slot.** `same_instrument_configuration` (AC:7208–7232, a `memcmp` over the whole state today) must ignore the continuous fields, so a drag updates the config in place at publish on the callback side and `applied` slews. This avoids a replacement and a double render per publication, and the blend-chain limit.
3. Discrete and structural fields (waveform, filter mode, enable flags, polyphony, capacity, zone set, asset) cannot slew. They keep the replacement with voice seeding and the existing 5 ms crossfade (Mechanism A), which is click-free for copied voices. Octave and semitone fold into one continuous semitone sum (AC:4298) and are smoothed together with detune.
4. A seeded replacement copies `applied` from the old slot, like `ramp.from = applied` (AC:8139); a new node starts with `applied = config`, so nothing slews in from zero.
5. Fields covered, from the header: Synth `HDR:308–349`; Sampler state `HDR:215–233` and zone gain, pan and tuning `HDR:198–200`; Granular `HDR:247–253`. Drum Rack uses the Sampler fields and zones. Envelope times are slewed as ms values before the per-frame reciprocal (AC:4274–4276).
6. **No per-event ramp fields and no new targets.** The event carries one float (AC:4642–4645, `HDR:1059`), the descriptor holds 16 targets (`HDR:28`), and a per-sample ramp wire would also hit the worklet cap (WK:15). The eight existing live targets keep working and feed the same `applied` slew.
7. **Slew time is set by measurement, not assumed:** pick it from the failing-first drag witness below (the smallest value that meets the bound), and record it with the numbers.

### Steps

1. Baseline witnesses that fail today (below), per instrument. They replace the 1-day measurement run.
2. Mechanism A in AC with the per-field tables; policy for victims, sustain pedal and `note_id` survival (a later note-off releases the copied voice).
3. Mechanism B in AC (`applied` state, slew, `same_instrument_configuration` change).
4. Mapper (`native-built-in-parameter-mapper.ts:151–168`): `polyphony` and continuous fields no longer return `undefined`; the discrete set routes to the replacement.
5. WASM rebuild (6i only), Chromium twin through the real worklet. FAST-CERT's WASM hash expectation moves (FR §3.2).
6. Worklet cap (WK; own commit): ramps per block as native does, or raise the cap; fader live drag follows (T:975).
7. **Integrator slot 2:** TL:2492–2508 stops rebuilding; PB `adoptLive` accepts all four instruments (PB:1705, 1827, 1833, 2250) and `create-effects-panel-state.ts:395` stops refusing; H:1542 no longer skips adoption for them.

**Failure-first witnesses.** Core C++ harness, per instrument unless stated:
- held note + any non-live edit: output never zero for longer than the unedited reference, held voice phase continues;
- chord of 8, polyphony 8 → 2: the two newest continue with unbroken phase, six fade within 5 ms; 2 → 8: sounding voices unchanged;
- Sampler/Drum Rack zone start, tuning, gain, pan edit under a held note takes effect without retrigger; asset swap under a held note;
- Granular parameter edit under hold;
- sustain pedal held across the edit; a note-off after the edit releases the copied voice;
- ten replacements inside 50 ms (blend chain); no level bump across the seam;
- **drag smoothness:** a held steady tone, a continuous sweep of each continuous field through repeated publications at the minimum publication interval; the sweep response must stay within the bound set by a sample-accurate reference ramp rendered without publications (second difference and peak step, no sample-to-sample step over the reference); fails today with the step at the event frame.
Worklet: two overlapping ramps; 257 events in a block with audible output. Mapper: each previously `undefined` case maps or routes to the replacement. Chromium twin of each core case through the real worklet.

**Acceptance.** Witnesses green on native and WASM; no retrigger of held notes; native and WASM equal within the existing portable parity tolerance (find that comparison before coding; compare on the publication frame, since the worklet renders 128-frame blocks and native 512, and `std::pow` differs by platform, so no bit equality); drag witnesses meet the bound; FAST-CERT WASM hash rebased and reviewed.

**Tier.** T2n plus the worklet path rule (`native/audio-core/**` and `public/audio-worklets/**` select the Chromium WASM twin; DP does not exercise WASM, T:953). Smoke at merge.

## 5. Phase 7: recording-target lock

**Goal.** Unrelated edits stay live during audio or MIDI recording on native and portable alike (UD 3). The record target cannot be deleted or rerouted until Finish. A blocked action does not stop recording. A blocked action is a refusal with a reason, not a failed live edit, so UD 8 does not apply to it.

**Done.** Portable keeps a take through edits and holds rebuilds until the take ends (H:1548–1550); portable adopt-while-recording exists (PB:1807, `isRecording` PB:2389).

**Not done.** No lock. Delete settles the take first (`useTimelineClipActions.ts:581`, TL:1520). T:972–974, T:985–987, T:1012–1015 open.

**Steps.**
1. Failure-first browser tests in `src/hooks/recording-lifecycle.browser.test.ts` (extend): delete, reroute, group/ungroup, undo, control commit, start/finish race, unrelated edit, on both backends.
2. Lock: extend `track-recording-target.ts` or `track-recording-session.ts` if it fits; a new file only if it does not. States `starting → recording → finishing → released` with a before/after target-closure comparison. Used by the mutation owners and `src/lib/local-control/local-control-service.ts` commit (R2:300). No new public mutation or schema action.
3. Replace stop-then-mutate with the synchronous guard (TL:1520, `useTimelineClipActions.ts:581`; integrator slot 1).
4. UI: disabled controls with reason, badge **Recording target locked**, copy **Finish recording to delete this track or change its routing.** (R2:302), existing notice and live region, on the real sidebar and lane surfaces.
5. Portable parity: same lock; once 6i's slot lands, portable edits stop answering `rebuild` and the H:1550 hold shrinks to leftovers. Fix T:972 (run `followPortableEdits` from the controller's failure path); add the recording-capable HT fake (T:985). **This acceptance waits for slot 2.**
6. T:1012: normalize in `buildLocalClip` so a MIDI take publishes once.
7. Native: `PrepareGraphRevision` last-invariant check of capture-bound routing (R2:300) in N, after phase 6's N work, separate commit.

**Acceptance.** One take; contiguous frame accounting; no added dropped frames; original capture identity; Complete → import → release, on native (packaged row) and portable (Chromium).

**Tier.** T1 for the recording hooks, T2 once H is touched; step 7 is T2n. Smoke at merge.

## 6. Phase 8: inventory and closure

**Goal.** No user edit answers `rebuild` or takes a staging fallback, playing or paused, native or portable, except a documented, tested exception list. A live-edit failure is never visible (UD 8).

**Done.** Playing structural edits go through the seam (FR §3.1). Paused portable stays live. C0f–C0h widen warm resume.

**Steps.**
1. **Inventory by condition, not caller:** engine × transport state × edit class → live / staged / rebuilt, with the owning phase. The nine TL callers collapse into one function. Include every exit in §1 and the checkpoint-3 leftovers (time signature, loop boundaries, new Stretch recipes, same-key sampled PCM; `P5/README.md:2293–2295` via FR). Read-only; can start now.
2. **Paused path (UD 7):** a paused structural edit publishes onto the live paused graph in place. Change H:1537 (`resumePlayback` gate), TL:871–872 and the dispose at H:2189–2192. Acceptance: one host spawn and unchanged device identity (PID stability alone does not pass, R2:331).
3. **Fallback removal (UD 8):** delete H:1571–1572; staging failure keeps the old graph playing, retries silently with a diagnostic log. The retry policy (attempts, backoff, end state) is a design item, see open question 2. C:3244/C:3252 throws and the TL:2509–2516 catch: each case is fixed or listed as a documented exception, with the parent ruling the list.
4. **Resume gate** (T:873–878): route every structural change through the live path or compare a structural fingerprint subset at resume.
5. Remaining items on the path: T:888–892 (Play during project switch), T:881 (start during pending pause), T:964 (PB paused forward locate). Seek rebuilds (H:1324, H:1370) and TL:2473 are classified, not assumed edits.
6. Parity table native vs portable, checked in as evidence.

**Failure-first.** A Chromium E2E or packaged row per edit class that performs the edit and asserts no dispose, `host-stop` or re-prepare in the log. Fuzz scenario for T:873 (a recompile that changes tracks/sends reaches resume uninstalled). No source-grep tests as gates.

**Acceptance.** Table complete and signed by exception list; no edit-caused `host-stop`, dispose or re-prepare in `host.jsonl`; any UD 8 retry exhaustion in a row is a defect.

**Tier.** T2 (T2n if native changes). Integrator slot 4; sign-off after C2.

## 7. Batched packaged campaign (C2, tier T4, one candidate)

One package after 6, 6i and 7 land. Each phase has already passed its non-certifying smoke at merge (own rows via `--rows` plus phase 5, about 14 s packaging and 5–8 min), so a C2 failure is attributable. The scheduled T3 passes on an ancestor first; then one T3 on the frozen bytes, repackage, C1 (TP §5.1 T4). A fix made after a C2 failure reruns the failed jobs and its own tier, then one T3 and one C1 for the final bytes.

Rows, one launch each, estimated 45–60 min round (D's 15–20 min was too low; phases 5 and 4 alone are 12 min measured):
- Regression first, once for the candidate: phases 3, 4, 5, r27 A, r27 B, paging. A failure is classified oracle / renderer / native and the round continues (FR §2.2.6–7); hard stop only on a product error dialog, host crash or freeze mismatch.
- Phase 6: warm effect insert; instrument insert; remove; reorder; undo of delete (parked rejoin); test-VST latency switch; plugin-side fault with unrelated audio live; trust negative; editor open through an unrelated edit.
- Phase 6i, per instrument (Synth, Sampler, Drum Rack, Granular): held note with the edit mid-note; plus polyphony down under a held chord; asset swap under a held note; a continuous drag. The analyzer checks no gap, no retrigger and drag smoothness.
- Phase 7: unrelated edit during take; blocked delete and reroute; Finish; Complete → import → release.
- Phase 8: paused structural edit (no spawn, device identity unchanged).
- Timing tool (§8 step 3) runs on every row.

Outputs go to `/tmp` where the freeze forbids writes under `acceptance-reports/` (FR §2.2.5). Verdict stays FAIL until every runner passes.

## 8. Phase 9: runner and campaign (redesigned, about 50–70 min per candidate)

**Goal.** Reproducible packaged proof, plus a portable proof, with frozen LAT1 timing gates in place of R2:369 (unreachable, the bound lead alone is 3 blocks, FR §3.1).

**Done.** Rows and analyzer for phases 4–5; flag parsing exists but rejects the matrix (RUN:636).

**Why the draft changes.** D's 2–2.5 h recounts to 4.5–5.5 h (18 rows × ~7 min, references, 4 recording rows × 20 takes, 9 VST rows × 20 × 20 s, regression runners, portable campaign). The redesign moves the repetition count down a level:

1. **Bursts of 100 in the core C++ harness and the WASM host test** (faster than real time), and fuzz for the controller. They test determinism, slot leaks, generation reuse and blend-chain build-up.
2. **Packaged: 10–20 repetitions per row**, one launch per row class carrying N alternating edits (A ↔ B, raise/lower, undo/redo). 18 rows × 20 ≈ 25–35 min.
3. **Settle on evidence, not a fixed 4 s:** wait for the publication-complete line in `host.jsonl` (about 1.5–2 s per edit). The oracle window after edit k is the window before edit k+1 (A needs 1 s before, between and after, A:771–775). Cross-turn strictness stays (`PARENT-RULING-C1A-ACCEPTED.md` ruling 5 via T:1077–1079).
4. **Reference rule (the per-state hole).** A reference is comparable only at the same timeline position, and held notes, reverb tails, LFO, noise and granular randomness are not periodic over a loop. Each row declares itself loop-periodic or not. A loop-periodic row uses two short per-state references. Any other row gets one full-length no-edit capture per class (about +1× burst time), compared bit-exactly on unaffected paths. Calibration (no-edit duplicate) stays once per class and package.
5. **A failure ends the burst, counts once, and is reported with the edit index** (a corrupted slot at edit 12 must not fail edits 13–100).
6. **Pooled statistics:** 18 rows × 20 = 360 trials bound the pooled failure rate below 1 % (3/N); the overnight run bounds each row. R2:360 says 100 per row, so this needs a ruling (open question 4).
7. **VST:** 20 repetitions on three rows (insert, remove with undo, latency switch), one pass on the other six, about 20 min. Per-insert time (assumed 20 s) is measured in phase 6 first.
8. **Merge rows that share a project** only where the fixture state after burst k is the documented start of burst k+1.
9. **Regression runners run once per candidate in C2,** not again here when the bytes are the same. The full matrix reruns only if a file under `native/` or the wire changed. The overnight 100-repetition matrix and soak run unattended outside the certifying budget, on the candidate package.
10. **Portable campaign** (Chromium, real worklet and core; DP uses a stub, T:953): same bursts, budget ≤ 10 min, to be measured; tolerance calibrated by duplicate no-edit runs.

**Steps and ownership.**
1. (slot 0) RUN `--matrix`, `--repetitions`, `--vst-repetitions`, `--rows`.
2. New `tools/acceptance/ae-08-phase-9-matrix.ts` (burst schedule, per-class state sets, per-launch capture). Runner worker.
3. New frozen `tools/acceptance/ae-08-latency-gates.ts`, thresholds written before data (FR F1–F3: per-class targets; lead as 2–3 blocks at bind; rebase as the publication frame moved; whether one 72 ms row stops the run). Self-test must reject a 16-block lead, a moved publication frame and a late completion, and fail the existing C1 evidence as a negative control. Parent rules the per-class targets first.
4. **Analyzer-rebase slot** (only slot that edits A): multi-publication segmentation per burst; lost-lower check via the `monitoredContentDelay` pattern (T:1064–1067); redefine `overlappingMoveWaitsForCompletion` (A:783–785, T:1068–1070); `assetAudible` defect (T:1029); per-revision asset inventory sampling in RUN (T:1030–1032); T:1053, T:1071–1073.
5. Chromium timing of prepare, publish and install (T:984) and the portable runner (item 10).
6. Wall-time budget table recorded from C2 timings; fix the budget there.

**Failure-first.** Analyzer self-test defects for each new check before the check is trusted; matrix dry-run on stored phase 4/5 evidence; timing-tool negative controls.

**Acceptance.** R2:362–370 thresholds with timing replaced by the frozen gates; zero edit-caused worker restarts, host `Stop`/`Start` or rejected callback blocks; calibrated tolerances never relaxed; callback time and peak memory reported; repeatable command and output hashes saved. Does not certify unavailable hardware or plug-in rows.

**Tier.** T4, once per candidate; the overnight matrix and soak are outside it.

## 9. Phase 10: remove the restart path

**Goal.** One live edit path; no dormant restart fallback.

**Done.** `CreateRevisionCore` has no definition under `native/`.

**Steps.**
1. Re-inventory by condition (phase 8 table), not R2's stale anchors (R2:386 is past the code).
2. Delete edit-specific stop, dispose and re-prepare branches in H and the TL rebuild catch paths, and the rebuild fallback, once phase 8 is signed. **Keep** the seek uses (H:1324, H:1370) and `retryNativeInstrumentPreparation` (TL:2473) until each is shown to be something other than an edit.
3. Native cold-core edit fallback in N and AC retirement paths, after proving initial startup and offline use their own lifecycle.
4. Keep: `disposeNativeSession`, `AudioHost::Stop`/`Teardown`, first configure/start, device and project changes, Finish barrier, host-loss recovery, `graphSnapshot`, portable ABI constants (R2:388).
5. Remove the v1 portable host (`daw-portable-audio-core-host-v1.js`, T:976–979) or guard it; remove `rememberInstrumentParameters` (T:938).
6. Docs: `docs/native-vst3.md` and tracker evidence after packaged proof.

**Failure-first.** Compiler and package checks; a packaged or Chromium row that performs each listed edit and asserts no configure/start/stop/teardown in the log.

**Acceptance.** Source audit table; both Chromium suites; native harness; package. The full matrix reruns only if `native/` or the wire changed.

**Tier.** T2; candidate proof via T4.

## 10. Dependency summary

| Phase | Depends on | Parallel with | Unblocks |
|---|---|---|---|
| Commit (UD 4) | C1 pass | none | worktrees |
| Slot 0 | commit | phase 8 inventory, runner prep | 6, 6i, 7 |
| 7 | slot 0 | 6, 6i | C2; portable parity needs 6i slot |
| 6i | slot 0 | 6, 7 | C2, 8 |
| 6 | slot 0 | 6i, 7 | C2, 8 |
| C2 | 6, 6i, 7, T3 on ancestor | runner prep | 8 sign-off |
| 8 | slots 1–3, C2 | phase 9 runner prep | 9 |
| 9 | 8, analyzer-rebase slot | none (campaign) | 10 |
| 10 | 9, 8 signed | none | final scored-track step |

## 11. Effort (engineer-days; judgment, not measurement)

| Phase | R2 | Rev 3 | Why |
|---|---|---|---|
| Slot 0 | n/a | 4–6 | §E blockers, fuzz host, RUN flags, TP rollout 1–4 |
| 6 | 13–20 | 12–18 | Renderer half done; spike, UD 11 attribution, test-VST faults |
| 6i | n/a | 8–11 | Seeding, smoothing, zone ref, all four instruments, WASM twin, worklet cap |
| 7 | 5–8 | 6–9 | Portable parity, HT fake, T:972, T:1012 |
| 8 | 5–8 | 4–6 | Inventory, paused in-place publication, fallback removal and retry |
| 9 | 5–8 | 7–10 | Matrix, timing tool, analyzer rebase, portable runner, core/WASM bursts |
| 10 | 2–4 | 2–4 | Unchanged |
| Total | 30–48 | 43–64 | |

Wall clock adds serial packaged time: C2 45–60 min plus a T3 (about 16 min) per candidate; phase 9 certifying run 50–70 min; overnight matrix and soak outside the budget. Estimates, not measurements; fix them from the C2 timings.

## 12. Not verified

- Copy cost of `InstrumentNodeState` seeding in the callback; whether assets stay resident until the old slot retires.
- Whether `same_instrument_configuration` can ignore continuous fields without breaking a retained-slot invariant elsewhere (AC:7208–7232, 7868–7893); the slew time constant (§4 item 7).
- Whether the preflight process can serve as the playback worker (phase 6 step 4).
- Whether the fuzz host and hook tests already model a paused publication (UD 7).
- The row-to-class mapping for phase 9; per-edit (about 1.5–2 s) and per-insert (about 20 s) times are assumptions.
- Whether C1 passed on the LAT1 bytes (`PARENT-RULING-LAT1-CERTIFIED.md` exists; no later C1 report was found).
- `P5/README.md`, the LAT1 ruling text and `C1-REPORT.md` rulings are quoted through FR. Nothing was built or run.

## 13. Open questions (only those still open)

1. **User: a swapped sample under a held Sampler or Drum Rack note.** UD 9 settles zone edits (start, tuning). A different asset under a sounding voice cannot simply continue. Proposed default: the held voice finishes on the old asset in its release while the next note uses the new one. Confirm.
2. **Parent: the silent-retry policy under UD 8** (attempts, backoff, and what the project holds if staging still fails). Proposed default: nothing visible during playback, retry on the next publication opportunity, and a certification failure if it never converges.
3. **Parent: the plugin-versus-our-side attribution rule** for UD 11, and the failed-state UI. Proposed default: a worker that fails by its own exit, crash or unresponsive ready is plugin-caused (device title bar, no dialog); every host, supervisor or coordinator fault is our defect.
4. **Parent/user: the phase 9 statistic and budget.** Accept 10–20 packaged repetitions per row plus 100 in core and WASM harnesses and an overnight 100-repetition matrix (pooled bound below 1 %), instead of R2:360's 100 per row packaged. Also rule the LAT1 per-class targets before the timing tool (§8 step 3) and which UD 8 failures in §1 go on the exception list.

### Answers to Revision 3 §13 open questions (2026-11-10)
1. **A swapped sample under a held note (user decision 13):** it switches instantly to the new sample at the same playback position.
   - A seeded voice keeps its position and takes the new asset.
   - If the new sample is shorter than that position, the voice ends with the existing release fade.
2. **The silent-retry policy (parent):**
   - a failed staging keeps the old graph and retries at the next block boundary, with the existing `min(L·2^r, 16·(r+1))` growth, up to the existing 8 resubmits;
   - it never rebuilds, never gaps, and never shows a dialog;
   - every retry is logged;
   - exhaustion is logged as a defect, and the user's edit stays in the project and applies on the next successful publication;
   - any retry in a certification run fails that run.
3. **VST failure attribution (parent).** It is the plugin's fault only when the plugin's own process or worker crashes, or the plugin's API returns an error for a valid call. Those are reported to the user.
   - Our IPC, timeouts, staging, host errors and lifecycle errors are ours. They are never shown as a plugin fault, and they count as a defect.
   - Certification injects a crashing plugin to test the reporting path.
4. **The phase 9 budget:** at most 70 min per certifying run, with the long soak run separately.
   - The LAT1 per-class targets are set from the first C1 timing data (`tools/acceptance/analyze-lat1-timing.ts`).
   - The exception list starts empty.
