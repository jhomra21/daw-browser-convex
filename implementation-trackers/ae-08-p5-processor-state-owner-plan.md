# AE-08 phase 5: fuzzer, one processor-state owner, certification

## Review incorporation (2026-10-20)

Round-2 Fable review (READY WITH EDITS) applied: E1–E18.

Design only, branch `production-dsp-characterization`. This revision edits only this plan; no tests, builds, app, commits or subagents. Read `AGENTS.md`, `AGENTS-solid.md`, `SOFTWARE_PATTERNS.md` and the phase-5 README sections “Processor-state owner: fuzzer baseline A1 (controller)” and “Processor-state owner: pre-refactor fixes (seeds 2, 4)”. Concurrent controller/fuzzer work is user-owned: wait for handoff and re-read it before implementation. All source lines below are approximate; relocate by symbol.

Source aliases: `ctl` = `src/lib/desktop/native-playback-controller.ts`; `hook` = `src/hooks/useTimelinePlayback.ts`; `panel` = `src/components/timeline/create-effects-panel-audio-effects-state.ts`; `tl` = `src/components/Timeline.tsx`; `native` = `native/audio-host-macos/src/audio-host.cpp`.

## Boundaries and execution model

**Lane model.** Exactly one native execution is in flight: patch, latency publication, schedule publication, or transport transition. Native has one prepared bank and cannot queue renderer intents (`native`, `QueueProcessorStatePatch`, ~3150–3152). Parameter batches bypass this lane, remaining callback-queued and revision/epoch gated. Transport transitions preempt the renderer-side wait of the in-flight execution, then reconcile its native side after the transport ACK, generalizing cancelled-publication reconciliation in `ctl.publishScheduleRevision` (~3236–3260). Preemption does not admit a second competing publication or bypass a pending supervisor control. Compilation and assets stay outside the lane.

**Desktop supervisor.** `apps/desktop/audio-host.ts`, `dispatchNext` (~2141–2171) has one pending control slot, urgent > refill > normal dispatch, FIFO within each class, and replies in dispatch order. `requestGraphRevision` (~2305–2318) throws while *any* control is pending; revision replies have a 2 s deadline, not a transition-duration deadline or automatic host loss. Every A/B step must respect this boundary, including parameter/asset overlap, admission rejection and inspect-after-deadline. Do not assume the execution lane alone excludes bypass traffic.

**Hard deletion rule.** Each step deletes the mechanism it replaces. No compatibility views or parallel ledgers. B6 is a sweep, not deferred migration. Preserve actual-byte inclusion fixes from r8/r8b until the new proof path replaces them.

Keep two-bank scheduling, seam coverage, assets/page/Stretch leases, observation handoff, compiler, coordinator and instrument urgent-event proof. No native ABI, public project-control, Convex conflict-policy, audio algorithm, worker-lifecycle or unsupported-VST expansion. Shared request types may need browser-backend forwarding changes, not browser behavioral redesign.

One Luna implementer and one Sol review per bounded task below, sequentially; the implementer applies findings before the next task. A1's numbered fix groups can be separate tooling tasks; A2 adds witnesses by domain. Use pure transitions, explicit inputs/outputs, indexed Maps, immutable captures and controller-owned I/O. No casts, polling, generic event framework, dependency or barrel export. Production processor waits use events, not timers. Harness-owned timers below are explicit acceptance machinery with deterministic cleanup. Local reference `solid-primitives/packages/promise/src/index.ts`, `until` (~102), illustrates one-shot observation/cleanup, not a timeout implementation to copy.

Chosen model: renderer owns desired intent and in-flight execution; native alone proves application. Use identity/order for desired ownership and content equality **plus native proof** for application. No separate content-document store, per-processor actors or full folding of latency into schedule publication: the latter share a lifecycle, not payload preparation.

## A. Edit-sequence fuzzer, before refactoring

### A1. Repair controller-baseline fidelity before using it as a gate

Existing `tools/acceptance/ae-08-processor-state-fuzz.ts` and `ae-08-processor-state-fuzz-fixture.ts` drive the real controller/compiler/coordinator. The README baseline is **97 pass / 3 fail**, not completed A or certification. Seeds 2/4/7 need the reachability qualifications below. Eight nominally passing seeds (10, 12, 24, 67, 70, 77, 85, 89) falsely reject flushes after revision changes; existing I3 misses this.

Complete these groups in order, retaining frozen baseline evidence:

1. **Host boundary and time.** Model one pending supervisor slot, urgent > refill > normal, FIFO replies within class and dispatch-order completion. Prepare/publish/inspect/retire return `{ok:false}` while a non-revision control is pending; do not invent revision queuing. The non-revision 2 s watchdog is host loss (`audio-host.ts` `controlTimedOut` → `lost`, ~1531–1553; armed ~2162–2164), except while recording Finish is pending; model it as a distinct scheduler action. A revision deadline calls `rejectPending(..., false)` (~1438–1446) and does not dispatch queued sends. Arm a real `setTimeout(..., 0)` sentinel at each A1 seed start and fail if it fired: current runs starve timers inside one macrotask, they do not own time. Clear the sentinel in seed cleanup; it must not drive host progress.
2. **Native fidelity.** `SetTransport` cancels an unclaimed publication (~4403–4404); it returns false only while callback-claimed publication is unacknowledged (~4405); otherwise it rolls back the prepared bank (~4407–4409). Model claim and acknowledgement as separable actions; record this conservative divergence. Inspect includes publish-pending for `LatencyTransitionPending` and queued graph control, plus rebase-required-from-inspect (`InspectGraphRevision`, ~3013–3022). Reclamation is eligible on install/create dispatch as well as explicit control wake/inspect/retire. Release ACK is not proof of reclamation, though actual safe erasure can occur during Release.
3. **Oracle and drain.** Judge false rejection only inside a live domain. Pause/seek “stale” results are expected red until B3b. Extend I3: a flush settling `accepted:false` must be followed by `actual ≠ desired` at next convergence, otherwise fail **“false rejection”**. After B3, cancelled/stale/superseded outcomes are classified separately, never disguised as rejection. Check I2/I3 after **each callback or reply action**, not just final convergence. Add an independent acquire/owner/release conservation ledger for I5 and check it before cleanup can erase evidence. Outstanding waiters after a valid bounded fair drain are **I4**, not harness errors; truly invalid replay dependencies remain harness errors.
4. **Separation and controls.** Split the fixture into a host model (`ae-08-processor-state-fuzz-host.ts`, no controller imports), pure oracle (`ae-08-processor-state-fuzz-oracle.ts`), and existing composition/scenario module; keep scheduler policy in CLI. Add I8/I9 and one mutation control per invariant (matrix below). Retain typed decoding, no casts or production winner imports.
5. **Evidence.** Regenerate the supervisor-valid baseline, distinguish new product failures from impossible schedules, and update README/ledger claims. Seed 2 is **latent, fake-only reachable as minimized**: supervisor FIFO forbids reversed normal replies. Retain the old trace as defensive evidence, not a desktop reproduction. Document conservative divergences: retirement one block later than native; patch claim/apply split across blocks (native performs both in one callback); native pause completes latency transition. Add the latter as an explicit A2 path. Control-before-publish modeling is content-equivalent only because native re-stamps retained queued events; do not reintroduce dropped old-revision batches.

Host semantics remain independent of production merge logic: separate receipt, admission, callback claim/application, telemetry and reply; active/prepared/retired graphs and banks; coverage through seam / seam-plus-block; callback watermark, retained runtime overrides, claimed-patch uncertainty, real reclamation and host-loss rejection. Emit valid 80/88-byte progress with optional capacity generation, absent remaining absent. Malformed-frame decoding belongs to desktop decoder tests, not this fuzzer.

Commands only enqueue; they cannot emit progress, render or recursively schedule host events. Scheduler actions explicitly drive render, control wake, reply, progress, compile/asset/save completion and deadlines. Promise checkpoints only drain selected actions; never await an edit before driving the event that settles it. No controller test-only getters, raw stores or public mutation seams.

### A2a. Mount, timers, sentinel and deferred seed portions

Mount `useTimelinePlayback` and the actual panel interaction state in Solid roots, using browser-conditioned effects and deterministic AudioBuffer/window substitutes from the existing hook fixture. Let the hook create the only controller for that fake host; keep A1's direct-controller fixture separate. Drive projected inputs without calling `restartTimelineSchedule`, plus explicit UI retry/dedup. Use real begin/preview/commit/cancel and gated persistence, not oracle-simulated rollback.

Replace runtime timers and rAF with scheduler-owned `fire-timer` / `raf-tick` actions, including the hook's 10 s lifecycle deadline (`hook` lifecycle wait, ~227–230) and supervisor deadlines. Record scheduling/cancellation and clean up deterministically. Panel coalescing (`panel.sendInteraction`, ~1173–1177) falls back to synchronous work under Bun unless rAF is provided: test the production branch. Keep A1's real macrotask sentinel outside virtual time to catch an unowned wall-clock yield. After B3b, assert no processor-wait timer is created; the hook's existing lifecycle deadline remains an explicitly owned exception, not an excuse for blanket timer rejection.

Add the mount, timer/rAF, sentinel, and deferred seed portions of these witnesses here:

**Gate:** hook/panel fixture selector, owned timers/rAF and sentinel; establish the deferred baseline portions of prefixes 1/6/8/9/10, including seed 6 ownership, seed 9 adoption, seed 10 sample/Stretch/lease, and stale-compile witnesses. One Luna task + Sol review.

### A2b. Transport, latency, lease, retry and attachment witnesses

Add witnesses before their owning behavior change: late reply after cancel and pause/seek; pause completes native latency transition including Inspect pending/completion; page read held across candidate release proves lease order/no early reclamation; flush while prepared but paused settles by progress/loss without hidden 1 s rescue; attachment latency change while candidate parked rebases coherent frozen inputs; cheap patch ACK retry reopening (`ctl.onScheduleOwnershipChange` → `hook` callback ~283–285 → `dispatchScheduleAdoption` ~1469) proves no reopened failure budget; attachment-latency plan change does not classify supported edit as rebuild (`ctl.nativeScheduleRebuildReason`, ~343; `publishAttachmentLatency`, ~3624).

**Gate:** pause-latency, lease, parked flush, retry and attachment witnesses. One Luna task + Sol review.

### A2c. Panel persistence, history and scheduling witnesses

Add real panel failed-save/cancel versus newer local gesture and later external projection; undo/redo, tempo/meter/loop, sample swap/Stretch and stale compile.

**Gate:** real panel gestures, persistence, undo/redo, tempo/meter/loop, sample/Stretch and stale compile. One Luna task + Sol review.

### Oracle, invariants and durable witnesses

Pure reducer fields: Utility gain, spectral FFT/latency, membership/kind, clip timing, sample identity, tempo/meter/loop. Independently decode submitted bytes and compute fixture-topology PDC. Do not import `rebaseScheduleCandidate`, `graphForBuiltInStatePatch`, production winner/merge logic. Distinguish desired, admitted, proven applied, and panel persistence. Legacy `handled`/`accepted` is not application; assert richer owner receipts **from B3 onward**, not B1.

| Invariant | Required assertion | Mutation control |
| --- | --- | --- |
| I1 convergence | After valid recoverable drain, native equals latest projected desired. Independently admissible latency converges while unrelated candidate capacity stays blocked. Permanent failure is explicit, not green convergence. | I1-only: drop one batch. |
| I2 no stale overwrite | Old completion cannot regress newer desired/confirmed content; check each callback/reply. | Existing stale-overwrite. |
| I3 truthfulness | Application requires exact content and strategy proof; rejected flush converging to desired is false rejection. | Existing false-receipt plus I3 false-rejection. |
| I4 settlement | Each barrier settles once; valid bounded drain with pending waiters fails I4. Parked candidate cannot strand independent latency waiters. | I4-only: swallow a waiter. |
| I5 ownership | Acquisitions = releases + live owners before cleanup; no duplicate logical release, early reclaim, stale promotion or leak. | Existing early-release, checked against independent ledger. |
| I6 quiescence | Identical/no-op input stops compile/prepare/publish/retry churn once advancement freezes. | Existing noop-churn. |
| I7 ending-domain settlement | Pause/seek/loop/loss cancel old waits with no further progress; late replies cannot revive them. Desired survives for new-domain execution. | I7-only: never wake latency waiter. |
| I8 coverage | While running, `activeBank.through ≥ renderedThroughFrame + 1 block`. | Underfill active coverage. |
| I9 no spurious rebuild | Supported live edit never yields rebuild, stop, configure or cold install; exclude deliberate transport/setup actions. | Force supported edit to rebuild. |

Each mutation must produce the intended invariant artifact, not merely throw. Distinguish not-exercised from pass.

Reserved seed **prefixes** are durable semantic witnesses: 1 no-op/adoption; 2 latent reversed-completion defense plus legal FIFO run (the reversed branch needs an explicit fake-only unfair-host control or is not-exercised); 3 changed-content inclusion before/after Prepare; 4 parked independent latency **then recovery/rebase**; 5 pre-claim rejection versus uncertain claimed patch; 6 save/cancel ownership; 7 publication/flush cancellation plus late replies; 8 cheap-ACK retry churn; 9 external adoption/undo/tempo/meter/loop; 10 sample/Stretch/lease cancellation; 11 flush between Prepare and Publish of same-core revision, native re-stamp, settles applied; 12 remove/re-add incarnation. Extend prefixes for urgent instruments and attachment classification. Exact A1 action replays are frozen evidence tied to source/fixture hashes; command changes make them dependency-invalid. B6 regenerates from **seed plus prefix**, never edits away a failed assertion to claim green.

CLI gate (repository root; future executor command, not run for this plan):

```sh
perl -e 'alarm shift; exec @ARGV' 600 bun --conditions=browser /Users/juan/Documents/daw-browser-convex/tools/acceptance/ae-08-processor-state-fuzz.ts --fixture controller --seed 1 --seeds 100 --steps 2000 --drain-steps 1000 --out /Users/juan/Documents/daw-browser-convex/acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/review-corrected-a1
```

A2 exposes a documented hook/panel fixture selector and runs the same campaign separately; never silently label controller-only coverage A2. Keep `--replay /absolute/path/minimized.json` for unchanged dependency graphs. Use fixed-version PRNG/stable action ordering, 2,000 random + 1,000 fair-drain actions, at most 100 promise checkpoints per action, shrink limits 200 attempts / 10,000 actions per attempt. No sleeps. Preserve dependency IDs, fairness and failure signature.

Expected-red carry-over:

| After | Expected red |
| --- | --- |
| corrected A1 | 4, 7, prefix-11 class, pause/seek-stale class |
| B1, B2a, B2b | unchanged |
| B3a | 4, 7, pause/seek-stale |
| B3b | 4, 7-publication |
| B4 | 7-publication |
| B5 | none |

“Preserves passing gates” means no seed leaves this set early or joins it.

**Superseded by class gates (A1 final r2).** Seed numbers drift once the command stream changes, so gates are evaluated by failure class plus durable prefixes, not seed lists. The authoritative table is `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/a1-final-r2/classes.json` (README “Class gates, not seed allowlists”); run the campaign with `--gate <step>`, which exits nonzero on any unknown class, harness error, surviving class owned by that step or earlier, or required-green prefix failure. The seed table above is historical context only.

Per-seed artifacts: seed/version/bounds/HEAD/dirty hashes, `events.jsonl` with enabled choices and receipts/proofs, minimized replay, final-state diff **before cleanup**, waiter/lease inventory, summary/coverage and replay command. Passing diffs are empty with explicit no-failure minimization. Persist immediately so the outer alarm leaves evidence; no credentials/plugin state. Record baseline failures without xfails or weakened invariants. Every subsequent step preserves passing gates and closes assigned witnesses.

## Pre-refactor fixes

**Seed 2, defensive.** README title: “Processor-state owner: pre-refactor Fix 1 retained (seed 2)” (~4204). `ctl.queueLiveProcessorControl` (~2642–2648) guards `appliedProcessorSequences` using `isProcessorSequenceOlder`. Keep this monotonic guard until B3a-i deletes the map. It fixes a latent lowering write under reply reordering the supervisor forbids, not admission-as-application. The exact seed-2 replay is dependency-invalid; regenerate prefix 2 from seed plus prefix.

**Seed 4: Fix 2 reverted** (README ~4220–4228; ledger ~95–97). `publishingCandidate` does not exist; `scheduleCandidates.size` remains the lane test (`resumeDeferredStatePatches` ~593, `pumpBuiltInStatePatches` ~3728). Final pre-refactor run: **98 pass, seed 4 I1/I4, seed 7 I7** (~4239–4243). The full suite before revert was 3,604 pass / 37 skip / 4 fail: View-menu fixture, FFT-stream graph-count, and two equal-stamp latency timeouts (~4251–4252). After revert, parent reran `perl -e 'alarm shift; exec @ARGV' 900 bun test --timeout 30000`: **3,607 pass / 37 skip / 1 fail**, the known View-menu fixture. The FFT-stream and two latency failures were Fix 2 regressions and are gone. Baseline G is **3,607 / 37 / 1**.

The third known defect is false “not applied before timeout”/“stale” on same-core revision or epoch change, closed in B3a-i/B3a-ii and B3b. Seed 4 I1/I4 closes in B4a with an owner record; seed 7 I7 closes across B3b/B5. Do not count seed-4's own latency-transition capacity advance as recovery of the separately blocked clip asset; retain the valid semantic witness.

## B. Refactor: one processor-state owner

### Contracts (target from B3; B1 keeps existing boolean results)

1. **Edit identity.** An edit is `{ id, order, target: { nodeId, instanceId, kindId, incarnation }, content }`. `id` is unique per allocation. `order` is a renderer-local counter incremented once per allocation; two edits never share an order. Allocation happens exactly when a new desired value for a target is written (draft write, changed commit, external adoption, undo/redo), before async work. Preview and terminal flush of the same value are one edit; flush is `barrier(id)`. A changed terminal value allocates a new edit and barriers that one. `incarnation` counts creations of `instanceId` in the mounted project; a mismatching edit settles cancelled. Content is normalized absolute state (full params plus encoded native bytes, computed once); synth content is the parameter value set.
2. **Receipt states.** For target T and execution carrying X:
   - `superseded`: `desired(T).order > X.order` when decided; no native claim.
   - `admitted`: host acknowledged command carrying X; no rendering claim.
   - `applied`: native proof exists. Parameters require progress `appliedProcessorSequence ≥` the captured batch sequence in the valid binding: the original revision or any same-core successor retaining the target (same instance, node and kind; node retained; parameter target declared, `audio_core.cpp` ~6842–6859), with the same epoch, host identity and native session start (~5099). The watermark is a max-fold floor (~5398, ~5574–5577); the owner settles native-cancelled batches itself before accepting a floor as proof. The same binding and floor rule applies to `appliedUrgentSequence`. Patch requires OK while stopped or after callback application (`native.QueueProcessorStatePatch`, ~3196–3219); publication requires published/active binding revision, matching host PID/generation and frozen content for T equal to X. A generic reply or model-order floor is never proof; a patch's callback-application ACK is the documented stronger proof.
   - `uncertain`: callback-claimed patch has negative/lost reply (`native`, ~3212–3218). Preserve desired/in-flight, no terminal receipt until later publication proves equal content (applied), newer content supersedes it, or ending-domain cancellation settles it.
   - `failed`: proven rejection/unrecoverable execution failure in a still-live domain, not uncertainty or cancellation. It never triggers panel rollback: keep the panel, retain the draft and report the fault.
   - `cancelled`: target incarnation or execution domain ended.
   `saved` is panel-owned persistence, independent of native. Exactly one terminal receipt per edit: superseded, applied, failed or cancelled. Admission/uncertainty are nonterminal. A cancelled edit can be re-executed with the same id in a new domain without reopening its settled receipt/barrier; record new-domain execution proof separately.
3. **Barrier.** `barrier(id)` resolves on a terminal receipt and never dispatches content. Parameter barriers wait for proof. Pause, seek and loop settle barriers before enqueueing the transition. Host loss, stop, dispose/unmount and superseded preview start settle them on the event itself (`invalidateNativeOwnership` callers ~1205, ~1274, ~1288, ~1426, ~1931, ~2087, ~2102). Target removal cancels its barriers. No native reconciliation follows loss; loss handling releases leases, and desired work re-executes only through the next install on a new host identity. No timer.
4. **Conditional rollback.** Only save failure or explicit gesture cancel of X for T triggers rollback. Replace desired only if `desired(T).id === X.id` and incarnation matches. Replacement R has fresh id/order and the canonical projected baseline **read now**; clear only X's draft. Otherwise do nothing to desired/native. Dispatch R normally; never send captured old bytes. Transport cancellation is not explicit gesture cancel.
5. **Pause/seek cancellation.** Renderer cancellation releases the renderer-side wait, not native ownership. Reconcile the admitted native execution after transport ACK: promote on proof, otherwise roll back only proven-unpublished work; release resources only on proof. Host loss is excluded: do not reconcile native state after loss. If `SetTransport` refuses because the callback claimed the publication (~4405), wait for acknowledgement (inspect or progress) and re-issue; never dispose the session for this refusal (today `pause` ~2305–2308 disposes on any SetTransport failure). Generalize `ctl.publishScheduleRevision` (~3236–3260). Preserve desired and reconcile/re-execute it in the new domain **without new ids**. Cancelled and stale are not caller failures: panel treats them like superseded, keeps the draft, persists and sends no restore. This fixes `ctl.queueLiveProcessorControl` (~2641) → `tl` flush (~1160) → `panel.commitParameterInteraction` (~1295–1300) knob reversion.

**Collaboration choice:** external adoption receives order at arrival, so a later-arriving older collaborator change wins at the playback layer. Ingest exactly `resolveDesiredPlaybackFx` output (`tl.getDesiredProcessorState`, ~738–752) so playback matches UI. This is not a new Convex conflict-resolution policy.

**History replay ordering (B1 round 5 decision):** a history reservation identifies the operation only until a newer allocation lands on the same member. If a newer write lands while the history save awaits, the reservation is retired and the successful replay is ordered at arrival with a fresh id/order. Keeping the older reserved order would make native drop the replay as superseded while the panel shows it. Whether the replay should still win over that newer write is persistence-winner policy and belongs to B2b, not B1.

Keep separate host lifetime, transport epoch, structural compatibility, native capacity and renderer edit order. A graph-cache replacement generation is neither model order nor retry permission.

### Shared gates G

For each task, first add the acceptance failure witness, then implement, review and run typecheck, lint and the narrow existing regressions below plus corrected A1/A2 campaigns into fresh task-specific directories. No new unit test files or post-implementation unit-suite writing. Existing unrelated failures are reported against a fresh handoff baseline, never silently waived. Commands are future executor instructions from repository root:

```sh
perl -e 'alarm shift; exec @ARGV' 300 bun run typecheck
perl -e 'alarm shift; exec @ARGV' 300 bun run lint
perl -e 'alarm shift; exec @ARGV' 600 bun test --timeout 30000 src/lib/desktop/native-playback-controller.test.ts src/lib/desktop/native-schedule-coordinator.test.ts src/lib/desktop/native-timeline-page-manager.test.ts src/lib/desktop/native-revision-controller.test.ts src/hooks/useTimelinePlayback.test.ts src/hooks/useTimelineProjectionState.test.ts src/components/timeline/create-effects-panel-audio-effects-state.test.ts src/lib/desktop/native-built-in-parameter-mapper.test.ts apps/desktop/audio-host.test.ts packages/audio-engine/src/native-host-wire.test.ts
perl -e 'alarm shift; exec @ARGV' 300 bun test --timeout 30000 src/lib/desktop/native-live-graph.browser.test.ts
```

**Evidence storage.** `acceptance-reports/` stays under 20 GB, and no run starts with less than 30 GB free disk. Write review, probe and parent re-verification output to `/tmp/<task>/`, and delete it when the task is accepted, keeping only the review report and probe scripts. A gate rerun used only for pass/fail goes to scratch, not to the evidence directory. Each step keeps one campaign directory, the final accepted run, never every rerun. When superseded packaged runs lose their audio, or completed runs are compressed, a `STORAGE-PRUNED.tsv` manifest (name, bytes, sha256) is written beside them. The fuzzer defaults to `--trace failures`: failing seeds keep compressed traces and plain replays, and passing seeds keep their summary and replay from the seed (`--trace all` keeps everything). A 100-seed campaign is about 17 MB (hook) and 13 MB (controller). Planned tooling: before C1, packaged runners check this budget at start, keep WAVs only for failing checks (sha256 and metrics for the rest), and keep every WAV only with an explicit certification flag. `acceptance-reports/*/` is excluded locally in `.git/info/exclude`. Without that exclude, every T3 checkpoint tried to hash about 13 GB of evidence, was cut off, and left an orphaned `.git/objects/tmp_objdir-bulk-fsync-*` of about 1 GB (169 of them, 80 GB, Oct 20–21). If free disk drops unexpectedly, check for those directories first.

Retain browser-conditioned terminal-gesture, r7/r8/r8b inclusion and r4–r6 ordering coverage. No native source change is planned; native dependency changes require their contract executables before certification.

### B1. Identity threading only

**Touch:** `src/lib/live-processor-control.ts` request types (~6–36), mapper `mapNativeBuiltInParameterCommit`, `tl` draft/flush forwarding (~440/~1160), `panel.writeDraftParams`/`createInteractionPayload` (~689/~1090), hook forwarding (~2308), controller entry points. The shared API is also implemented by the **browser backend** (`hook`, ~2313); update forwarding without redesigning it.

Allocate id/order once per content change before dispatch, reuse on unchanged flush/replay, carry full target incarnation and normalized content. Equal orders are impossible: delete the tie-break clause and input-identity-as-edit-clock mechanism. Keep existing boolean results, **no EditReceipt implementation yet**. Do not put transient receipts into persisted history/export metadata.

**Delete now:** equal-stamp-as-identity assumptions replaced by threading; preserve existing byte inclusion checks pending B3. **Gate:** G, seeds 2/3, unchanged flush dispatch count, changed terminal bytes and prefix 12. One Luna task + Sol review.

### B2a. Controller desired ledger

**Touch:** private `src/lib/desktop/native-processor-state-owner.ts`, `ctl.createNativePlaybackController` (~365), `rebaseScheduleCandidate` (~496), processor submissions; snapshot/Timeline forwarding only where needed.

`ProcessorEntry = { target; desired; admitted?; applied? }`, **no saved**. Consumer-shaped owner operations: desired submission/conditional replacement, capture, completion; no generic mutable store. Ingest projected normalized absolute content synchronously, including unmapped fields; removal/kind replacement ends incarnation. Ledger is execution intent, not another project model.

**Hard-delete:** `desiredProcessorPatches` and all writers; materialization reads the ledger directly, no compatibility map. **Gate:** G, seeds 3/6/9, exactly one desired writer, UI-projected content equality. One Luna task + Sol review.

**Status (2026-10-21): accepted** after Sol review r6.
- **Owner:** `native-processor-state-owner.ts`. Its entry is `{ target; desired; applied? }`; `admitted` is left for B3. `setDesired` is the only desired writer.
- **Deleted:** `desiredProcessorPatches`, `acceptedProcessorPatches` and `OrderedProcessorPatch`.
- **Rebase guard:** `order > candidate.processorStateSequence` is kept for B4b's frozen-input rebase.
- **New controller witnesses:**
  - `ledger-inclusion` keeps FFT and other state-only content.
  - `ledger-incarnation` runs in fixture registry mode. Its stale-application window is pinned to the first candidate captured after the re-add, within the same re-add generation.
  - Both were red under owner mutations.
- **Results:**
  - Fuzzer gates B1 and B2a: 0 violations. Hook 80/20, controller 62/38; seed results are identical to the baseline.
  - Full suite: 3,607 pass, 37 skip, 1 known fail.
- **Evidence:** `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/b2a/`.
- **Known, not reachable with production orders:** `isSuperseded` ignores incarnation.

### B2b. Panel conditional rollback

Depends on B1/B2a. **Touch:** `panel.revertFailedSettle`, `cancelParameterInteraction`, `commitParameterInteraction`, `updateInstance` (~1037/~1320/~1269/~1048); Timeline forwarding.

Implement contract 4 through owner conditional replacement. Preserve newer draft/external winner, clear only the cancelled/failed-save edit's draft, read current canonical baseline for a legitimate lone-gesture rollback. A proven `failed` execution persists the panel and draft and reports the fault, never rolling back. Persistence remains panel-owned.

**Hard-delete:** unconditional restore sends and captured-baseline rollback logic. **Gate:** G, seed 6 real-panel save failure/cancel racing newer gesture/external projection, lone cancel restores current canonical baseline, proven `failed` keeps draft and panel. One Luna task + Sol review.

**Status (2026-10-21): accepted** after Sol review r1.
- **Registry:** `replace(failed, payload)` allocates a fresh id/order only when the failed edit is still the latest edit for that incarnation.
- **Panel:** `rollbackEdit` is the only caller. It runs on save failure and explicit cancel. It reads persisted rows at that moment and rebases a newer gesture baseline. It replaces the edit before clearing the draft, so the projection echo cannot mint a competing edit, and it clears only the failed edit's draft. A native `failed` reports the fault, still persists, and keeps the knob and draft.
- **Deleted:** `revertFailedSettle`, `touchedPayload` and the captured-baseline write on cancel.
- **Fuzzer:** new hook check `save-fail-open`. The `current !== wroteKnob` refinement in the hook classifier was reviewed and judged correct.
- **Results:**
  - Gate B2b: hook 87/13 (was 80/20), controller 62/38.
  - `save-fail-positions` 180/180. Seeds 6 and 9 are green. Seed 3 fails only on `restamp-timeout`.
  - Full suite: 3,607 pass, 37 skip, 1 known fail.
- **Newly red seeds:** 33, 39, 51, 80 and 82 (`pause-seek-stale`, B3b) and 84 and 97 (`restamp-timeout`, B3a-i). Review traced each one to an ordinary terminal gesture flush on a trajectory that diverged after the fix. None comes from rollback R. They expose existing B3a-i/B3b defects.
- **Handed to B3a-i:**
  - A cancel that races an in-flight save of a different edit restores the stored row, so native can briefly hold a stale value until the projection change executes. B3a-i keeps a dedicated witness for this.
  - Incarnation-mismatch rollback is guarded but has no fuzzer witness.
- **Evidence:** `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/b2b/`.

### B3a-i. Parameters, urgent proof and rebinding

**Touch:** owner; `ctl.queueBuiltInParameterEvents`/`queueLiveProcessorControl` (~2557/~2625), `reenableProcessorAutomation` (~2689–2727), `rememberInstrumentParameters` (~3948–3953), progress waiter binding (~917–925).

Owner captures immutable included content, target/incarnation, host, epoch, revision and native sequence. Strategies here: **parameters** and **instrument urgent** (desired parameter values; proof `appliedUrgentSequence`, existing `waitForUrgent`). Queue ACK is admission, never application. Move `rememberInstrumentParameters` writes into owner; remove unproven built-in `appliedSequence` from automation re-enable. Parameter proof binding and max-fold floor follow Contract 2; owner settles native-cancelled batches before accepting the floor. Accept proof under the original or rebound binding; rebind is decided from the frozen prepared graph at Publish and takes effect when progress/inspect shows the successor active.

Fix false “not applied before timeout”/“stale” on same-core revision or epoch change: keep waits for retained targets, explicitly rebind proof to native's same-core re-stamping (`native.ReconcileScheduledTargets`, ~2188–2190/~5265), rather than treating revision/epoch change as rejection. Removed targets cancel; foreign host/session never inherits proof. Materialize confirmed content from captured content plus native proof; old completions cannot regress it.

Every desired change to a live processor executes on that processor with proof, including changes with no live gesture (history undo/redo replay, external adoption). A same-processor graph prepare is not execution: native keeps the slot and its live runtime overrides across a structurally compatible prepare (`audio_core.cpp` `compatible_processor_history` ~7118; overrides clear only at slot initialize ~7283 or patch install ~8450). Today an undo while playing changes the panel but not the sound (A2c `history-equal-undo-return`/`history-redo`, class `graph-only-desired-change`).

**Hard-delete:** the native `rememberInstrumentParameters` writer and the unproven applied floor. Owner-held execution records replace them. The Timeline call and the portable-backend branch of `rememberInstrumentParameters` stay, because the portable backend relies on them.

`appliedProcessorSequences` and `isProcessorSequenceOlder` move to B3a-ii (Fable design review r1, F5). They still feed patch supersession, the adoption floor that stops a late older flush, and the guard that keeps an older patch from overwriting a newer gesture. They are deleted together with the patch lane.

**Gate:** G, seeds 2/3/5, prefix 11, urgent instruments, per-action I2/I3, supervisor slot overlap. One Luna task + Sol review.

**Status (2026-10-22): accepted** after Sol code review r5. Before that: Fable design reviews r1 and r2, and Sol code reviews r1–r4, each REVISE. Sonnet implemented.
- **Owner execution store:** per-target records, separate from desired entries, with states queued → admitted → applied or cancelled. Records are registered when their sequence is allocated and become proof-eligible only at the actual send (`send`).
  - `observe` is the only proof entry.
  - `decide(revision)` rebinds or cancels retained batches at Publish, using the `retains` predicate bound at Prepare.
  - `adopted(…, restated)` handles publications that may have replaced a processor's history slot.
  - `joined` joins a flush to the latest dispatch of each parameter (`carriers`).
  - `ended` closes a gesture that a preview left open.
  - Instrument (urgent) targets are keyed by synth instance id.
- **Epoch gate:** a stamped parameter or urgent send waits until a progress frame shows its transport epoch applied. Otherwise an older-epoch callback could drop it while a later floor proved it.
- **Restated processors:** native does not report history-slot identity. So for a retained processor whose published state bytes changed, the owner forgets proof applied after the freeze, resends still-desired values, and re-dispatches in-flight batches on the successor (`rebind`). Only the successor-sent sequence proves them. Processors under a reconfigured instrument keep their overrides.
- **Deleted:** the native `rememberInstrumentParameters` writer and the hook's native branch, plus the fabricated `appliedSequence` on automation re-enable.
- **Deferred:** `appliedProcessorSequences`/`isProcessorSequenceOlder` stay for B3a-ii, and the 1 s proof timer stays for B3b.
- **Fuzzer:** new controller scenarios:
  - instrument-urgent, reenable-automation, urgent-epoch-drop, retained-drift;
  - reconcile-seek, reconcile-first, parameter-preack-epoch, parameter-epoch-drop;
  - future-epoch-drop, held-urgent-note;
  - retained-override-instrument, restated-override, restated-inflight, restated-queued;
  - synth-replaced, rollback-values.
  
  Also:
  - B3a-ii-owned prefixes reconcile-inflight, retained-instrument, two-rejections and overlapping-flushes;
  - hook scenarios cancel-other-save, gesture-equal-return, gesture-cancel-unchanged and gesture-multi-field-return/cancel;
  - plants cancel-retained, false-urgent-receipt and post-recovery-overwrite;
  - fixture-only send attribution through `AsyncLocalStorage`.
- **Results (re-verified by the parent):**
  - Typecheck 0; fuzzer files 0 type errors; oxlint 0 on the 23 reviewed files.
  - Narrow 560/36/0; browser 16/0.
  - Gate B3a-i: hook 80/20 (B2b 87/13), controller 65/35 (B2b 62/38), 0 violations, complete campaigns. Every seed matches the evidence.
  - All three plants exit 1.
  - Full suite 3,606 pass, 37 skip, 2 fail: the known View-menu failure, and `useClipResize` "dense-track resize", which passes alone and is a load flake.
- **Hook seed changes from B2b:** seeds 3, 32, 39, 51, 82, 84 and 97 turned green. The newly red seeds are all `pause-seek-stale` (B3b), and review traced them to bridge-error timeouts that B2b's campaign hid.
- **Handed on:** to B3a-ii (refused successor resend, resend detection, compatibility model coverage, mandatory patch-install case) and to B3b (epoch-gate consolidation, stale re-execution, timer allocations, urgent ending-domain settlement, semantic timer attribution). Both are listed in their sections.
- **Evidence boundary:** these results come from the fake host, not the native runtime; packaged proof is C0/C1.
- **Evidence:** `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/b3a-i/`.
- **Design and reviews:** `acceptance-reports/ae-08-phase-5-2026-10-18/b3a-i-design.md` and `b3a-i-reviews/`.

### B3a-ii. Patch strategy and owner lane admission

**Touch:** owner; `runBuiltInStatePatch` (~3628), patch lane admission, `adoptPublication` sequence bookkeeping (~3102–3117), `rebaseScheduleCandidate` accepted-map read (~519), `queueBuiltInStatePatch` (~3763–3772).

Implement patch receipts and uncertain claimed records, owner lane admission, and adoption/rebase proof bookkeeping. Add `adoptPublication` sequence bookkeeping (~3102–3117), `rebaseScheduleCandidate`'s accepted-map read (~519), and `queueBuiltInStatePatch` (~3763–3772) to the touch points. At Publish, decide rebind from the frozen prepared graph. Rebind reaches the stopped path (~2922) and callback path (~5265). A flush between Prepare and Publish on a same-core revision must be re-stamped and settle applied (prefix 11). Patch lane admission lives in the owner; B4 only changes who holds the lane when parked. B3a-ii also owns the fuzzer class `stale-stamp-at-dispatch/host-refused/resend`: when native refuses a batch stamped for a revision that is no longer current, the owner re-stamps and resends the still-desired content; it never settles it as rejected or drops it. It also owns `post-admission-publication-cancel/resend` (a batch admitted, then cancelled at publication). In both cases, B3a-ii re-executes still-desired content under a proven binding.

**Mandatory: patch installation erases overrides (Sol B3a-i r4).** When native installs a staged processor state, it zeroes all of that processor's overrides (`audio_core.cpp` ~8426–8450). The current `acceptProcessorStatePatch` does not invalidate parameter carriers or live proof. So a parameter edit applied after the patch was captured, but before it was installed, is erased while an old carrier still joins it.

Fix: the owner invalidates the patched target's parameter proof at installation. It re-executes still-desired values on the installed state, without forgetting desired intent and without rolling back the panel.

Required failure-first witnesses:
1. **Base case:**
   - Stage a Utility state patch that carries gain 0.
   - Send gain -9 and prove it on the old state.
   - Install the patch.
   - Deliver the patch ACK and proof only after that.
   - Flush -9. It must be applied on the installed state, and native, panel and persisted values must all end at -9. It must not join the pre-patch sequence.
2. **Base-case variants:**
   - parameter proof delayed until after installation;
   - an unrelated later floor;
   - claimed-patch negative ACK, and lost-ACK recovery.
3. **Opposite order:** patch first, then parameter. The post-install carrier must not be erased.

Use separate callback orderings for the claim/apply race; do not rely only on the fake host's cross-block claim split.

**Also required (Sol B3a-i r5 residuals):**
- **Refused successor resend:** after a publication restates a processor, B3a-i resends its in-flight batches on the successor. If that resend is refused, it is cancelled with no retry and the content stays stranded (`refused-resend`: `nextAdoptionWork 0`). B3a-ii re-executes it the same way as the other two refusal classes. Do not assume `unreconciled` plus a later frame recovers it, because no live key may ever have been proven.
- **Resend detection:** the original call detects a resend by revision change (`execution.revision !== revision`). That works only while resends happen on a strictly newer publication. If B3a-ii resends on the same revision, replace this check with an explicit dispatch-attempt identity. Comparing the record's first sequence does not work, because the epoch gate can change that sequence.
- **Compatibility model coverage:** the fake host's processor-history compatibility covers Utility's structural fields (kind, state size, bytes 12/28/32/36) only. Extend it written from native (`audio_core.cpp` ~7122–7136) for any other kind, layout or version that a B3a-ii witness exercises.

**Hard-delete:** `acceptedProcessorPatches`, `acceptProcessorStatePatch`, `isProcessorPatchSuperseded`, `appliedProcessorSequences`, `isProcessorSequenceOlder` (moved here from B3a-i), patch pump/flags and duplicate queue admission. Owner-held execution records replace them. **Gate:** G, prefix 5 claimed uncertainty, prefix 11, per-action I2/I3, supervisor slot overlap, `--gate B3a-ii` (resend, transient-overwrite and stale-patch-overwrite classes green). One Luna task + Sol review.

**Status (2026-10-22): accepted** after Sol code review r4. Before that: Fable design reviews r1 and r2, and Sol code reviews r1–r3, each REVISE. Sonnet implemented.
- **Patch lane in the owner:** queued, dispatched, claimed and refused patch records sit beside the parameter records.
  - `nextPatch` picks the newest absolute content in the lane task that sends it: submitted, newest registered edit, or projected ledger content.
  - A claimed (negative-ACK) reply answers the caller `handled:true` and leaves live values unknown. A definite stopped-path refusal answers `bridge-error` and keeps desired, with no revert.
  - Only a true ACK replaces prepared graph bytes.
- **Patch install erases overrides:** a true ACK invalidates older carriers on the target and leaves newer ones in place. It settles refused parameter records whose every value it carries, and it moves the applied floor to the materialized order.
- **Dedup:** a patch counts as a no-op only when the owner can prove native already holds that state. The bytes must equal the prepared ones, every live value must be known and equal, and the target must have no queued, dispatched, claimed, refused or in-flight record.
- **Refusals:**
  - A refused parameter record stays desired. `reoffer` offers it again at adoption, at the end of each latency publication attempt and at the end of a schedule attempt that did not adopt, at most once per attempt, plus the single frame retry.
  - A refused preview answers `accepted:true`; its flush follows the record.
  - Attempt identity replaces revision-only resend detection.
- **Holds:** latency-changing patches wait while a candidate compiles or is staged. Every patch waits while a deferred settlement is pending, which is the one window where native refuses at `audio-host.cpp` ~3150. Hold-all-while-staged was rejected because it starved correct staging.
- **Timing:** each edit stores its timing inputs as data (`{ enabled, input: EffectTimingInput }`). The tail is derived only at write sites, from the BPM of the graph being written: patch dispatch at the prepared BPM, candidate folds at the candidate BPM, latency republish at the prepared BPM. No numeric tail is stored as timeless state.
- **Acceptance seam:** optional controller input `onProcessorDispatch({ key, editId, attempt, sequence })`. It is observational only and its one consumer is the fuzzer, which uses it for exact dispatch attribution.
- **Deleted:** `acceptedProcessorPatches`, `acceptProcessorStatePatch`, `isProcessorPatchSuperseded`, `appliedProcessorSequences`, `isProcessorSequenceOlder`, the old patch pump and registries, `nativeBuiltInTimingForCommit`, and the fixture's `AsyncLocalStorage` attribution.
- **Test contract changes (parent-approved):**
  - The four latency-coalescing tests keep a refused follow-up desired at 2048.
  - "older FFT patch" uses bytes that differ from the prepared state.
  - The serialization and timeout tests coalesce same-processor patches. They still check one call at a time, each processor's latest patch, the distinct processor's patch, and that every waiter resolves.
- **Fuzzer:**
  - Controller scenarios: patch-install, patch-install-late-proof, patch-first, patch-negative, patch-race-before-claim, patch-claimed-newest, patch-installed (owner-level), attempt-identity, refused-resend, refused-preview, patch-prepared-override, patch-prepared-pending, patch-refused-settled, patch-projected-timing, rebound-credit, rebound-applied-rejected, joined-flush-credit. patch-race-split is model-only.
  - Hook scenario: patch-install.
  - B3a-ii witnesses run against B3a-i product code (checkpoint) were red, except mutation-only patch-first. Fix sensitivity was shown by in-memory mutations for every fix.
- **Results (re-verified by the parent):**
  - Typecheck 0; fuzzer files 0 type errors; oxlint 0 on the 19 changed files.
  - Narrow 563/36/0; browser 16/0.
  - Every witness passes, except the two B3b deadline prefixes, which are red by design. All three plants exit 1.
  - Gate B3a-ii: controller 64/36 (B3a-i 65/35), hook 78/22 (B3a-i 80/20), 0 violations, 0 rejection violations. Every seed matches the evidence.
  - Full suite: 3,609 pass, 37 skip, 2 fail. The failures are the known View-menu test and the `useClipResize` "dense-track resize" load flake, which passes alone.
- **Seed changes from B3a-i** (each one replayed against B3a-i product code and traced to its first divergence):
  - Controller 18, 35, 54, 56 and 83 turned green.
  - Controller 19, 49, 52, 79, 89 and 92 turned red with B5b latency classes. They first diverge at an equal-content patch that is now acknowledged unsent, or at a refused preview that is now accepted. Later, a coordinator window, user preview or parameter flush takes the single control slot before latency retire/prepare.
  - Controller 8, 10, 14, 17, 20, 31, 44, 59, 70, 72 and 84 lost their I1/I2 failures and keep only the B5b I3 class.
  - Hook 3 and 84 turned red with `pause-seek-stale` (B3b): a refused record stays pending, and a pause then settles its flush stale.
  - None of these changes what native ends up holding.
- **Handed on:** to B3b (two proof-deadline prefixes, refused-pending pause-stale) and to B5b (latency retirement collisions, refused patch terminality, uncertain-patch repair, wire ambiguity). Both are listed in their sections.
- **Known limits:**
  - State bytes are still allocated at the edit's tempo; only the tail is retimed.
  - A paused claimed-patch hold lasts until the next frame or adoption.
  - A patch with no edit identity uses incarnation 0, which is refused once the ledger has moved on. Real callers pass an edit.
  - Unexercised rows: an unrelated later floor (one target in the fixture), and live-session lost-ACK recovery (B5b).
- **Evidence boundary:** fake host only; packaged proof is C0/C1.
- **Evidence:** `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/b3a-ii/`.
- **Design and reviews:** `acceptance-reports/ae-08-phase-5-2026-10-18/b3a-ii-design.md` and `b3a-ii-reviews/`.

### B3b. Event-driven ending-domain cancellation

**Touch:** owner waits, `ctl.waitForNativeProcessorSequence` (~927–945), `invalidateNativeOwnership`, `pause`, `seekPrepared`, `handleNativeHostLoss` (~1077/~2293/~2313/~1277), transport lane (~2135); Timeline flush and panel receipt handling.

Implement contracts 3/5 for parameter/patch waits, including loop/loss and delayed IPC. Preempt renderer wait before transport enqueue without fabricating native cancellation or releasing resources. **Remove the 1 s timer**; progress or domain/loss events settle waits. Cancelled/stale/superseded keep draft and persist, never trigger restore. Seed 7 publication branches stay red until B5; its parameter/patch flush branches close here.

B3a-i handoff (Sol r3):
- **Epoch gate:** B3a-i added `epochWaiters`/`holdUntilEpochApplied`, which hold a stamped send until a progress frame shows its epoch applied. This overlaps the coordinator's transition wait. Consolidate them into one owner-held ending-domain registry. Do not keep both.
- **Stale result:** a held send whose epoch or revision moves on returns `stale` with no same-edit re-execution, so rapid seeks can strand still-desired content. Re-execute it under the new epoch.
- **Timer allocations:** the deadline is a shared helper, not one absolute deadline. The gate wait and the post-ACK proof each allocate 1 s, so a flush can take about 2 s plus admission time. Post-ACK urgent proof has no deadline. Both go with the timer removal.
- **Fuzzer wait attribution:** wait/timer attribution must use semantic origin, not product function names.
- **Urgent ending-domain settlement (Sol r5):** define how an urgent (instrument) wait settles when its epoch, revision or session ends.
- **Late-Inspect window (Sol r5):** in that window, an open preview can stay at its old value until the terminal flush. The gate must keep both the live-gesture and the open-gesture cases.
- **No rollback on stale (Sol r5):** a false or stale receipt never rolls back the panel.

B3a-ii handoff (Sol r3/r4):
- **Proof-deadline prefixes:** `rebound-applied-rejected` and `joined-flush-credit` are registered with `greenAfter: "B3b"` under class `processor-proof-deadline`. Native applied the credited batch, but the 1 s timer fired before its progress frame, so the caller was rejected. Removing the timer must turn both green. Do not restart the deadline per rebound as a workaround.
- **Refused record and pause:** a refused parameter record stays desired and pending (re-offer decision). A pause or seek then cancels its flush, which answers `stale` (hook seeds 3 and 84, `pause-seek-stale`). The ending-domain contract must re-execute or settle it without rollback.

**Hard-delete:** timer and old per-path cancellation/wait registries now owned here. **Gate:** G, seed-7 parameter/patch flush branches, paused-prepared flush, pause/seek mid-flush with no knob revert, late replies, no processor timeout allocation. Publication branches remain red until B5. One Luna task + Sol review.

**Status (2026-10-23): accepted** after Sol code review r2. Before that: Fable design review r1 and Sol code review r1, each REVISE. Sonnet implemented.
- **Domain taxonomy:**
  - Pause, seek, loop and start-over keep the session. Each one bumps the epoch through `endDomain(epoch)`, which only updates bookkeeping and never sends.
  - These end the session and answer `cancelled`: invalidation (including resume), start-replace teardown, transition-failure dispose, hook dispose and host loss. All of them go through `clear()`.
  - An explicit edit stamp that mismatches still answers `stale`.
- **Re-execution:** only a progress frame drives it, through `observe` with `rebind` and `sendExecution(resent)`, once per domain end. A refused record is re-armed at the domain end, and its retry stays bounded by `retryAfter`/`retried`. An unsent record's epoch is the send gate, which replaces `holdUntilEpochApplied`.
- **Answers:**
  - `ExecutionSettlement` is `"applied" | "cancelled"`, and `executionResult` is total (`isReplaced` → accepted).
  - `"cancelled"` is now a `LiveProcessorControlResult` reason.
  - Timeline treats accepted and cancelled as handled; a cancelled commit returns early, with no patch and no rebuild.
  - A retired target answers `cancelled`, previews included.
  - A request with no bridge answers `unavailable`, and one with no prepared graph answers `unprepared`. Either answer comes before any registration, so no session-less wait can exist.
  - Cancelled, stale or superseded results keep the draft and persist it. They never roll back the panel.
- **Deleted:** `epochWaiters`, `releaseEpochWaiters`, `waitForAppliedEpoch`, `withProofDeadline` (the 1 s timer), `waitForNativeProcessorSequence`, `holdUntilEpochApplied`, the post-ACK `stale` in `sendExecution`, per-execution waiter fan-out, and the owner `generation` cancel. In the fuzzer: `isProcessorProofTimer`, the controller `proof-deadline` action and its virtual clock, the hook `processor-wait` scenario, and the `claimed-transport-dispose` class. The controller and owner allocate no processor timers.
- **Kept:** `settleStagedAfterTransport` and `reoffer`, hook `setPlayhead`, structural dispose, and `publicationCancellationListeners` (deleted in B5b).
- **Fuzzer:**
  - Controller witnesses: pause-refused-pending, seek-refused-pending, rapid-seek, urgent-pause, processor-timer, send-straddles-pause, two-registry-frame, late-inspect, browser-flush-pause (real portable controller), flush-no-bridge, flush-unprepared, flush-after-dispose, flush-after-loss, terminal-classifier.
  - Hook witnesses: pause-refused-pending, processor-timer, preview-across-pause.
  - The paused-flush and ending-flush checks now read the persisted row independently and require persisted == knob == expected.
  - The gate's `defers` rule is enforced in code: a prefix may defer only a class whose owner step comes after the gate being run.
  - Mutations m1 and m3–m7, f1, f2 and f3 each turn their witnesses red. Removing the epoch gate (m2b) is caught by the 100-seed gate through the required-green `future-epoch-drop`.
- **Ownership changes (parent-approved):**
  - The `transport-refusal` prefix moved to B5b (`transport-cancellation`).
  - Controller seed 7 is not an epoch-waiter symptom. Its stranded wait is a latency patch held by `publishLatencyGraph`. It is classed B5b `transport-cancellation` through the narrow `behindPublicationWait` predicate: the publication must still be pending, the terminal pause/seek must be pending, and the other old-domain waits may only be latency/pause/seek. Every other stranded wait stays B3b `old-domain-waiter`.
  - The hook `commit-after-removal` witness now carries the draft edit stamp, as the real panel does. Sol traced every built-in commit path and found none unstamped.
- **Results (re-verified by the parent):**
  - Typecheck 0; fuzzer files 0 type errors; oxlint 0 on the 18 changed files.
  - Narrow 543/36/0; browser 16/0.
  - Every listed witness passes. All three plants exit 1.
  - Gate B3b: controller 64/36 (unchanged from B3a-ii, every seed identical), hook 98/2 (B3a-ii 78/22), 0 violations, 0 rejection violations. Every seed matches the evidence.
  - Full suite: 3,609 pass, 37 skip, 2 fail (the known View-menu test and the dense-track resize load flake).
- **Seed changes from B3a-ii:**
  - Hook 3, 12, 17, 19, 22, 23, 24, 33, 34, 36, 42, 49, 52, 53, 57, 61, 67, 79, 80 and 84 turned green (`pause-seek-stale`).
  - Hook 45 and 64 keep only their B5b classes.
  - Remaining red prefixes: hook `prefix-1` and `prefix-8` (B4a) and `pause-latency` (B5b); controller `transport-refusal` and `pause-latency` (B5b) and `attachment` (B4b).
- **Known limits:**
  - The hook fixture's flush path mirrors Timeline's `flushNativeBuiltInParams`, because the Timeline closure cannot be mounted. Revisit in B6.
  - `endDomain` re-targeting an unsent record across a second domain move has no permanent witness. Serialized pause/seek/loop transitions cannot reach it, but an overlapping paused seek plus `start()` can. Sol reproduced that path and it settles correctly (applied on progress, cancelled on loss). Candidate witness for B6.
- **Evidence boundary:** fake host only; packaged proof is C0/C1.
- **Evidence:** `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/b3b/`.
- **Design and reviews:** `acceptance-reports/ae-08-phase-5-2026-10-18/b3b-design.md` (v2, with the v3/v4 addenda) and `b3b-reviews/` (design-v1, fable-design-r1, sol-code-r1, sol-code-r2).

### B4a. Adoption intent and retry ownership

**Touch:** owner, `ctl.prepareScheduleRevision`/`publishScheduleRevision`/`rebaseScheduleCandidate` (~2729/~2821/~496), hook adoption (~1427–1599), progress retry (~2135–2149).

Move latest-intent coalescing, retained compiled candidate and retry decision into owner; hook observes projection/submits and executes surfaced **rebuild** as its existing lifecycle operation (`nativeScheduleRebuildReason`, ~339; hook consumer ~1497–1502). Compile/assets remain outside lane; captures are immutable. Move the `prepareScheduleRevision` compile abort (~2735–2736) from `publicationCancellationListeners` to owner domain-end cancellation, so B5 can delete the set.

One blocked-attempt record keyed by **(content fingerprint, host identity, transport epoch, structural generation, capacity generation)**. Explicit retry clears it. No parallel retry token/budget identity. Cheap patch ACK, ordinary progress and graph-cache replacement cannot reopen it.

**Hard-delete:** hook adoption state (~1427–1441), `dispatchScheduleAdoption`, `completeScheduleAdoption`, fingerprint/failure bookkeeping, progress retry effect (~2135–2149), and `onScheduleOwnershipChange` in controller/hook. **Gate:** G, seed 8 25 cheap ACK/progress opportunities without reopened budget, compile canceled on owner domain end. One Luna task + Sol review.

**Status (2026-10-24): accepted** after Sol code review r4. Before that, Fable design review r1 returned REVISE with binding amendments A1–A12, and Sol code reviews r1, r2 and r3 each returned REVISE. Sonnet implemented.
- **Owner adoption record:**
  - The owner keeps `running`, `latest` (one slot, newest wins, never aborts `running`), `retained` (a compiled candidate) and `blocked`.
  - Two intents are equal when they have the same key (projection, host identity, transport epoch, structural generation, capacity generation) and reference-equal context (`instrumentOverride`, `externalProcessor`). `sameContext` is shared by `sameIntent` and `isNewest`.
  - Explicit never means "unchanged"; the post-compile content check decides that.
  - Submitting the running intent again settles and removes a waiting one (ABA).
  - An explicit call that joins `running` or the queued intent clears `blocked` and upgrades the queued intent to explicit.
- **One refusal record (`blocked`):**
  - It is set only by native refusal retry reasons (asset capacity, asset page capacity, asset publication pending) or by a failed outcome. A failed outcome keeps `blocked.content`, reason `previous-content-rejection`.
  - Aborts, transport mismatches and supersession never set it.
  - It survives the admission of a different intent. Only an explicit call, changed refusal facts or a successful settlement clear it.
  - A non-explicit intent that waited behind a refused attempt, with the same schedule and the same context, receives that refusal and becomes `blocked.intent`. The capacity wake then retries the newest desired intent. This is the old hook `nextFingerprint` rule, now inside the record; without it hook seed 81 regresses to `transient-overwrite`.
- **Wake:**
  - Only `advanceScheduleCapacityEpoch` reopens a refusal, at the six capacity sites. The call is queued with `void` and never awaited inside a lane operation.
  - Cheap patch ACKs, ordinary progress and graph-cache replacement cannot reopen a refusal.
- **Compile:**
  - A compile no longer moves the transport. A mismatch returns `retry/transport-mismatch`; `runAdoption` applies `updateLoop` once, outside any record, and re-runs.
  - An orphaned compile has no side effects (A8). Its `finally` drains patches only when the compile was not aborted.
  - Compiles register in an owner `Set<AbortController>`, because the direct prepare/publish primitives still compile outside an attempt.
  - `endDomain` aborts compiles and returns the retained candidate for disposal. It keeps `latest` and `blocked`.
- **Cancellation:**
  - `dropAdoptionIntents()` and `clear()` cancel the whole attempt: the coalescing microtask, the `updateLoop` wait and settlement. Each caller settles exactly once, and a stale settlement cannot touch a replacement.
  - A drop also bumps `stagedTransportIntent`, so a queued publication abandons itself. Its readers are publication admission and adoption only.
  - A drop cancels a publication that is underway until the first Publish is sent. Native publishes nothing, staged resources are released, and the caller gets `superseded`.
  - After Publish is sent, `AdoptionAttempt.withdrawPublication` keeps the attempt alive until owner settlement, so the reported outcome matches native (`adopted`).
- **Hook:**
  - The adoption machinery is gone. `requestTimelineSchedule` awaits `adoptSchedule` and runs a surfaced `rebuild` behind the existing token guard. The not-playing effect calls `dropAdoptionIntents()`.
  - Playback-input identity uses TanStack `replaceEqualDeep` (A7).
  - `adoptedScheduleFingerprint` was renamed `previewProjectionBaseline` (paused preview only). The hook ignores `superseded`.
  - All token sites are kept (recovery, resume/cleanup, seek reconciliation): owner cancellation cannot revoke a `rebuild` that has already settled.
- **Attachment:** `nativeScheduleRebuildReason` ignores `declaredLatencyFrames`, which `publishAttachmentLatency` carries. That closes `attachment-spurious-rebuild`. The controller `attachment` prefix is now green because B4a removed its own spurious rebuild. Sol confirmed it does not exercise B4b's frozen attachment rebase, which stays B4b's job.
- **Deleted:** `scheduleOwnership`, `isScheduleCandidateCurrent`, `cancelSchedulePreparation`, `candidatePreparation`, `onScheduleOwnershipChange`, `adoptedScheduleFingerprint`, `pendingScheduleAdoption`, `failedScheduleContent`, `dispatchScheduleAdoption`, `completeScheduleAdoption`, `playbackInputIdentities` and the hook progress retry effect. A read-only `adoptionWitness()` accessor serves the fuzzer.
- **Fuzzer:**
  - Controller witnesses:
    - compile and refusal: `transport-mismatch`, `abort-no-block`, `compile-domain-end` (A8, supported and unsupported orphans);
    - adoption: `adoption-cancel` (5 cases), `adoption-aba`, `adoption-context`, `adoption-refusal-context`, `adoption-refusal-key`, `adoption-explicit-upgrade`;
    - content rejection: `content-rejection`, `content-rejection-explicit`;
    - publication cancel: `publication-cancel-{unclaimed,staged,queued,claimed,handoff}`. The handoff sweep is bounded by `handoffSweep` and must cover the window, from a running attempt to a settled one (class `handoff-sweep-short`).
  - Each compile context compiles to its own master gain, and the oracle decodes the native master gain.
  - Hook witnesses: `context-inflight` (0 publications, native master gain 0.5), the `intent-aba` running-A/waiting-B phase, and `retained-seek` with pumps. Sol checked that the pumps do not hide a lost wake.
  - Prefixes `prefix-1` and `prefix-8` are green.
- **Tests changed:**
  - Stretch-lease test: supersede became `dropAdoptionIntents()`, because A2 removed supersede-abort. It keeps its observable.
  - Capacity-generation and candidate-publish tests now count compiles.
  - `pending-exhaustion`, `inputs-during-compile`, `burst-during-compile` and `stale-compile` are byte-unchanged.
- **Mutations:** every one was red and restored with `cmp`. They cover A1–A8, the attachment change, each r1–r3 fix (including Sol's own A6 abort→failed) and the handoff sweep bound. Sol re-ran a sample in each round.
- **Results (re-verified by the parent):**
  - Typecheck 0. Fuzzer tsc has 0 errors inside `tools/acceptance`. Oxlint 0 on 30 files.
  - Test runs:
    - controller and portable tests: 268/0;
    - hook tests, default conditions: 100/32 skip/0;
    - hook tests, browser conditions: 129/1/2. Both failures are pre-existing and fail identically on the pre-B4a product: "preserves an explicitly captured native owner across queued generation rebuilds" and "failed lifecycle transition cancels delayed native startup";
    - narrow: 206/4/0; browser: 16/0.
  - Gate B4a:
    - hook: 98/2 (seeds 45 `retained-override` and 64 `latency-after-publish-false-rejection`, both B5b);
    - controller: 64/36;
    - 0 violations and 0 rejection violations. Every seed is identical to B3b and to the worker's evidence.
  - Seed 81 passes at B3b in both fixtures. All three plants fail with their classes.
  - Full suite: 3,609 pass, 37 skip, 2 fail (the known View-menu test and the dense-track resize flake).
  - Remaining red prefixes: hook `pause-latency`, and controller `transport-refusal` and `pause-latency`, all B5b.
- **Evidence boundary:** fake host only; packaged proof is C0/C1.
- **Evidence:** `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/b4a/`.
- **Design and reviews:** `acceptance-reports/ae-08-phase-5-2026-10-18/b4a-design.md` (v2, with the v3 addendum and the r1/r2/r3 fixes) and `b4a-reviews/` (design-v1, fable-design-r1, sol-code-r1 to sol-code-r4).

### B4b. Parked lane release and recovery rebase

Parked ≠ preparing/publishing: release execution-lane ownership and wake independent admissible edits once, without restarting blocked candidate budget. Before recovery promotion, invalidate/rebase candidate with latest processor/attachment latency, preserving leases. Close seed 4 with an owner record. Compile abort was moved to owner domain-end cancellation in B4a.

**Gate:** G, seed 4 owner record; parked latency settles without pause/seek/loss or clip-capacity recovery, then one permitted recovery retry retains latency and balances leases; stale compile witness from A2c. One Luna task + Sol review.

**Status (2026-10-31): ACCEPTED.**
- **Reviews:** Fable design r1 was REVISE, with binding items B1–B9. Sol code reviews r1–r3 were REVISE; r4 ACCEPTED. Implementation was Sonnet; the parent re-verified everything.
- **Root cause of seed 4:** `runNextStatePatch` held latency patches whenever `scheduleCandidates.size > 0`, so a refused (parked) candidate starved latency.
- **Native protocol 27 → 28 (user-approved):**
  - A separate `latency_completion_generation` counter, at offset 88 of a 96-byte progress frame.
  - Arena refusals compare only `capacity`. Every other refusal also compares the new `settled` field.
  - The controller mirror resets on host loss.
  - A real protocol-27 host is rejected at handshake. Payloads of 80, 88 and 96 bytes still decode.
- **Hold rule:** a patch is held while `compiling() || adoptionRunning() ||` there is any candidate without the `parked` flag. That flag lives on `ScheduleRevisionCandidate`.
  - Direct prepares have no owner `retained` record, so this flag is the only state that tells a staged candidate apart from a refused one.
- **Wakes:**
  - after `settleAdoption` (unconditional);
  - on disposal of a non-parked candidate;
  - on transport ACK, compile completion and attempt completion.
- **Removed:**
  - The publication-`finally` drain. No witness needed it (parent ruling; Sol r3 traced every queuing point).
  - The dispose drain.
  - The waiter rule. `admit` now answers a non-explicit intent for the same schedule and context with the standing refusal.
- **Witnesses** (all classified red under their mutations; patches in `fuzz/b4b/mutations/patches/`):
  - `parked-latency`/W1 and seed 4 are direct-path witnesses.
  - `parked-rebase`/W2 covers owner-record rebase.
  - `parked-owner` covers owner wake only: M8b and M9 are red, and M8a is a joined duplicate, so it stays green.
  - `hold-dispose` (H1).
  - `parked-hold` (D1).
  - `leases-valid` and `leases-invalid` use real Stretch leases over fake IndexedDB (M5, skip-dispose).
  - `parked-settled-only-synthetic` (N4, N5, M9, X1). It is synthetic-only by parent ruling; see the B5b handoff.
- **Seed 64 (hook):** green because the `adoptionRunning()` hold folds the latency edit into the in-flight adoption's prepare. This is not a B5b fix.
- **Parent verification (2026-10-31):**
  - Native build and ctest: 23/23.
  - tsc 0, fuzzer tsc 0, oxlint 0 on 16 files.
  - Controller and portable tests: 268/0.
  - Hook tests: default 100/32 skip/0; browser 129/1/2, with the 2 known failures.
  - Narrow: 207/4/0. Browser: 16/0. `bun run build` OK.
  - Gate B4b:
    - hook 99/1 (seed 45 is `retained-override`, B5b);
    - controller 65/35;
    - 0 violations;
    - per seed, identical to the archived `fuzz/b4b`;
    - compared with `fuzz/b4a`, only hook 64 and controller 4 changed.
  - Seed 81 at B3b passes in both fixtures. The plants fail with their own classes: `latency-starvation`+`retained-predicate-drift`, `urgent-instrument-proof`, `transient-overwrite`.
  - Full suite: 3,610 pass, 37 skip, 3 fail. Two are the known View-menu and dense-track failures. The third is the unrelated, in-progress `device-control-cost` browser test.
- **Evidence:** `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/b4b/`, with logs in `b4b-parent/verify/`.
- **Design and reviews:** `b4b-design.md` and `b4b-reviews/` (design-v1, fable-design-r1, sol-code-r1 to sol-code-r4).
- **Follow-up (minor, Sol r2):** fixture harness errors, rather than classified reds, for M1/M7/M8b on the leases scenarios and for M5 on rebase/owner/settled. Each mutation is red elsewhere.

### B5a. Shared lifecycle on the schedule path

**Touch:** owner; `publishScheduleRevision` (~2821).

Move schedule publication through the shared lifecycle: admission, inspect/rebase, matching proof, cancellation reconciliation, retirement and waiter settlement. Keep schedule seam/coverage/assets/tempo/maps preparation distinct. Reconcile callback-wins cancellation after transport ACK; if callback claimed publication, promote on proof, otherwise reconcile rolled-back native state. No native reconciliation follows loss.

B4a handoff (Sol r3/r4):
- **Deferred settlement across pause/seek:** a publication claimed by native and then rolled back across a pause or seek answers `publish-pending` and keeps `settleStagedAfterTransport`/`discardStagedAfterTransport` (controller `publishScheduleRevision` `finally`, ~3365–3391). The transport ACK settles it later (~2234–2262: `adoptedLate`, `executeReconcile(processorState.reoffer())`). By then the adoption caller has already been answered `superseded`, while native may promote. The hook ignores `superseded`, so no panel or preview baseline moves. Close this in the shared lifecycle: the outcome must never contradict native.
- **Drop protection:** keep `AdoptionAttempt.withdrawPublication` semantics when publication moves to the shared lifecycle. Cancel before the first Publish; after it, settle with native's result.

B4b handoff (Fable design r1, Sol r1/r2):
- **One drain point per lifecycle:** B4b drains queued state patches after adoption settlement, after disposal of a non-parked candidate, and on transport ACK. The shared lifecycle must keep exactly one wake per terminal transition, with no second drain path.
- **Privatize the publication surface:** `publishLatencyGraph` and `publishScheduleRevision` are still exported for the fuzzer. Make them private once the lifecycle owns publication, and keep the controller witnesses on public entry points.
- **Candidate hold:** the `parked` flag on `ScheduleRevisionCandidate` exists because the direct path has no owner `retained` record. If the lifecycle gives every candidate an owner record, fold the flag into it, and keep `hold-dispose`, `parked-owner` and seed 4 green.
- **Native rollback self-wake (Fable F2):** the fake host does not model native's own rollback waking a parked refusal. Add a witness for it, or record why the lifecycle makes it unreachable.

**Gate:** G, prefix-7 publication branches, callback-wins-cancel/lost-reply/retirement holds. One Luna task + Sol review.

**Status 2026-10-31:**
- **Phase 1 done.** Design and Fable review: `acceptance-reports/ae-08-phase-5-2026-10-18/b5a-parent/review-design/` (APPROVE WITH AMENDMENTS, E1–E9).
- **E9 done.** The fake host is now faithful: acknowledgement keeps the publication in flight until a control-thread Inspect, SetTransport or Stop; staged assets are released at Rollback, cancelling SetTransport and Stop; retirement happens only on explicit Retire or Prepare auto-retire; reclamation is separate.
  - Accounting: `acceptance-reports/ae-08-phase-5-2026-10-18/fuzz/b5a/e9-accounting.md`. Controller went from 65/35 to 66/34; hook results did not move because of E9.
  - New red witnesses owned by B5a: `inspect-reply-lost`, `rollback-reply-lost`, and the re-expressed `deferred-outcome-pause-late`. New convergence check: `publication-left-in-flight` (I5).

**Parent rulings on E9:**
1. **Faithful retirement is kept** (retirement only on explicit Retire or Prepare auto-retire). This overrides the REVIEW E9 note that A1 retire-on-wake moves with B5b; the user's root-cause rule prefers fidelity. Seed 42 turning green is an interleaving shift; the class still reaches 31 seeds.
2. **Controller seed 8** (`latency-starvation`, I1/I4) is a real defect that the old acknowledgement model hid. Its root cause is `publication-left-in-flight`: the controller drops a publication native still holds. It is not exempted or reclassified. The B4b gate shows it as a known exposed violation, and the **B5a gate requires seed 8 fully green**.
3. **`retirement-starves-reclamation`** (`reclaim-held-by-retirement`) is owned by B5b's retirement policy.
4. **Hook-gate drift from DV-01's panel API rewrite:** `gesture-multi-field-*`, `history-save-newer`, `prefix-6`, `save-fail-positions` and seed 35. DV-01 owns these; its done criteria include a hook gate per-seed identical to `fuzz/b4b`.

**Remaining order:** B5c, then B5a phase 2, which rebases onto B5c with E1–E8, then B5b.

**Routed to B5b (2026-11-01):** after DV-01's panel rewrite, hook seeds 22 and 35 fail with `I1 retained-override`, the same class as seed 45. Content that advances after a compile has captured it is not reconciled once the start lands. The trace is in `acceptance-reports/device-control-cost-2026-10-31/dv01-parent/ae08-hook-gate.md` and `review-code/STATE-R2.md`.
- **Seed 22:** the restart lands four hook flushes; after `start`, no parameters are dispatched.
- **Seed 35:** a paused-preview rebuild chain (`useTimelinePlayback.ts` ~1755–1790) cancels the flush in `ending-incarnation`.

The B5b gate requires seeds 22, 35 and 45 to be green. Panel timing must not be tuned to hide them.

### B5b. Latency joins the shared lifecycle

**Touch:** owner; `ctl.publishLatencyGraph` (~3310–3547), `publishScheduleRevision` (~2821), `publishAttachmentLatency`, `reconcileKeepLatency`, `queuePreparedTransportTransition`, `settleStagedAfterTransport` (~3609/~3590/~2136/~2208).

Use the shared lifecycle from B5a. Keep schedule seam/coverage/assets/tempo/maps preparation distinct from latency coordinator suspend/resume. Review suspend timing explicitly against I8.

Freeze **graph bytes, Keep Latency membership and attachment latency together**, including their generation bindings. PDC is a function of this frozen graph/snapshot only (`compensateGraph`, ~538–546), never a subsequent ledger read. Late desired changes become follow-up executions.

Use **one retirement policy for both payloads**: consume `proof.revision.retiredRevision`, request retirement through the existing revision API when admissible, and retain leases until native/reader proof permits release. No latency-only retirement loop. Use **one bounded rebase/resubmit policy**: inspect uncertain/stale prepared bank, roll back only proven-unpublished work, recapture current desired/frozen inputs and retry only on the existing relevant opportunity; never roll back active work or restart budget from progress.

Give latency the schedule path's cancelled-publication reconciliation after transport ACK. If callback won, promote on proof; otherwise reconcile rolled-back native state. Implement uncertain-patch **REPAIR** as a newer absolute publication with proof once claimed-patch ownership clears, not an invented per-edit native receipt. Preserve desired; satisfy or supersede uncertain edit only from content/proof.

B3a-ii handoff (Sol r1–r4):
- **Retirement collision:** a coordinator `window`, a user preview or a parameter flush can take the single control slot between an inspect reply and latency `retire`/`prepare`. The host then answers "unavailable", and an already-applied latency waiter rejects (`latency-after-publish-false-rejection`) or loses its edit (`latency-before-publish-lost-edit`). B3a-ii's changed walk reaches this more often: controller seeds 19, 49, 52, 79, 89 and 92 are newly red, and seeds such as 23 and 34 now show a second distinct waiter.
- **Refused patch terminality:** a definitely refused patch with no later publication stays nonterminal until the domain ends.
- **Uncertain-patch REPAIR and live lost-ACK recovery:** still `notExercised`. A claimed (negative-ACK) patch keeps an uncertain record. The wire cannot tell a pre-claim refusal from a claimed-but-unresolved patch.

B3b handoff (Sol r1/r2):
- **`transport-refusal` prefix** (`greenAfter: "B5b"`, class `transport-cancellation`): a pause disposes the native session after a callback-claimed SetTransport refusal. The pause must survive the refusal through the shared lifecycle, with no new timer.

B4b handoff (Sol r1/r2):
- **Attachment fold/freeze:** `parked-rebase` (W2) must stay green when attachment latency moves into the frozen graph snapshot. W2 is the witness for owner-record rebase behaviour. Seed 4 is a direct-path regression and cannot see the owner wake.
- **Completion-frame wake for non-arena refusals is synthetic-only (parent ruling, 2026-10-31):**
  - `handleNativeScheduleProgress` advances the settled epoch on a new `latency_completion_generation`.
  - No protocol-28 ordering makes this the only reopening fact.
  - `InspectGraphRevision` clears `publication_in_flight` (`audio-host.cpp:3011`) and returns Published (`:3014–3015`) before it checks `LatencyTransitionPending` (`:3022`).
  - `InstallAsset` refuses with `asset-publication-pending` only while that flag is set (`:4088–4092`). Such a refusal therefore always comes before the controller's own settle, which reopens it.
  - Witness: `parked-settled-only-synthetic`, which uses the fake-host `hold-completion` action.
  - When latency joins the lifecycle, decide whether this settled advance is still needed:
    - If it is needed, keep the witness.
    - If it is not, delete both the advance and its witness.
  - Keep the completion counter itself, because latency waiters (`pause-latency-completion`) depend on it.
- **Seed 64 is not a B5b fix:** hook seed 64 turned green in B4b only because the `adoptionRunning()` hold folds a latency edit into the in-flight adoption's prepare, instead of publishing a separate one ahead of it (first divergence at step 47). The `latency-after-publish-false-rejection` class is still reached by 33 controller seeds and by the `pause-latency` and `transport-refusal` prefixes.
- **Controller seed 7:** a latency state patch held by `publishLatencyGraph` keeps the transport lane, and the pause/seek waits queued behind it. The host stays `publish-pending` after Inspect until a render frame. When latency joins the lifecycle, remove the `behindPublicationWait` exemption in the controller fixture's terminal check, so that any surviving case is blocking again.

**Hard-delete:** `publishLatencyGraph`, latency-only retirement, schedule-private progress subscription/`waitForProgress`, `publicationFailure`, `cancelStagedPublication`, `publicationCancellationListeners`, duplicate retirement/resubmit and equal-floor settlement machinery. Freeze Keep Latency and attachment inputs; pause completion and REPAIR use the shared lifecycle. **Gate:** G, full I1–I9, latency publish-before-reply/lost reply/callback-wins-cancel/retirement holds, latency pause completion, uncertain patch repair, frozen attachment/Keep Latency changes. **Seed 7 fully closes here.** One Luna task + Sol review.

### B5c. Processor-only edits stay off the schedule path (added 2026-10-31)

**Order (ruled 2026-10-31):** Fable answered the B5a design review's Q3 (`acceptance-reports/ae-08-phase-5-2026-10-18/b5a-parent/review-design/REVIEW.md`): B5c lands **before B5a phase 2**, sequentially.

The sequence is:
1. B5a phase 1, done.
2. B5a E9, the fake-host fidelity change, with its own per-seed accounting.
3. B5c, design then implementation.
4. B5a phase 2, which rebases onto B5c and applies amendments E1–E8.
5. B5b.

B5a's campaigns re-run once after the rebase.

**Re-sequenced by the user, 2026-11-02 (native delivery boundary).**

*Why.* DV-01's panel engine-sync design (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/review-code-r7/ENGINE-SYNC-DESIGN-v2.md`) was rejected by Sol in `DESIGN-REVIEW-v2.md`. Its blockers N3, N4, N5 and the native half of N6 are facts the controller does not report:
- a running host's failed patch reply returns `{handled:true}`;
- a restore below the floor does not close a retained native override;
- a persistent decline has no notification and no recovery owner;
- instrument native readiness cannot be observed.

*Decision.* The user decided to design the controller and the panel together and to lift the AE-08 freeze for this boundary. One design covers both: `…/dv01-parent/boundary/BOUNDARY-DESIGN.md` (Fable). Its delivery-outcome vocabulary must be one vocabulary with B5a phase 2's proof amendments E1–E8.

*Implementation order.* The controller-side contract comes first, then the DV-01 panel engine-sync. The design states exactly how B5c, B5a phase 2 and B5b merge, reorder or simplify, and this section is updated once Sol approves it.

*Approved order (Sol REVIEW-r2, ACCEPT WITH AMENDMENTS A1–A8; `…/dv01-parent/boundary/PARENT-RULING-r2.md`).*
1. **Step 0:** hashes and failure-first witnesses.
2. **Step 1:** native protocol 29, with a coherent resolved-record handoff, the lost-claim blocking token, all-or-nothing parameter batches, and a compile-time-only test seam. On the controller and ledger side: content-bound receipts, gesture tokens, fresh configure ingestion, the whole-content carrier selector, synth recovery and the typed session incident.
3. **Step 2:** persistence provenance. Row revisions are stamped inside the existing transaction revision owner. Typed admitted/applied outbox results bind via the durable completion record. A local `{through, rows}` publication.
4. **Step 3, atomic:** the wiring, panel engine-sync v3, engine-boundary joining of current work, and owner-fed all-track local arpeggiator rows.
5. **Step 4:** coverage witnesses, then deletion of the old writers.
6. **Step 5:** the B5c remainder (H2/H3; H1 is absorbed into step 1, and the projection-change reconcile is dropped).
7. **Step 6:** B5a phase 2 (E1/E3/E6/E7, plus the publication terminals for structural receipts).
8. **Step 7:** a reduced B5b. Hook seeds 22 and 45 move to step 1. B5b keeps controller seed 7, retirement-starves-reclamation, the latency lifecycle and transport-refusal.

Then B6.

*Fable second review, adopted 2026-11-02 (`…/boundary/PARENT-RULING-r4.md`).* Seven simplifications and fixes. The engine boundaries become their own step, which can run in parallel with steps 1 and 2.

*Follow-ups after DV-01:*
- The track, clip, master-volume and automation write adapters pass `queuedResult: {status:'applied'}` for writes that were only queued. Give them typed admitted/applied results through the shared durable read.
- Fixed inside the engine step: the in-place engine edits in `live-mixer-runtime.ts:545-571` change the live node before the staleness check at `:645`, so a cancel can leave a discarded tick audible.

*Carried constraints from DV-01:*
- an edit-less flush or patch is never a gesture end;
- a B5c reconcile must not give the panel's own projection-first previews a second execution;
- the open-gesture expectations of `history-save-newer` are based on the committed view;
- the B5b hook seeds 22 and 45 have been classified by Sol (70, 73 and 89 are schedule-sensitive).

*DV-01 follow-ups.* The panel/instrument writers found during the DV-01 rounds. The boundary design must absorb each one or assign it to a step:
- Effect reconcile re-sends the same values to the engine.
- `registerSampledInstrumentWork` is a second writer of the instrument engine state.
- `exec.ts:414-421` writes instrument state to the engine directly, outside the owner.
- Instrument native previews are detached from the owner lane (`create-persisted-effect-state.ts:125-152`).
- The device-control-cost measurement's in-flight tracking (`settle()`) must cover any new asynchronous work the contract introduces, such as claimed-pending settlement and recovery. Otherwise the run-to-run determinism in `dv01-parent/determinism/REPORT.md` is lost.

**Measured defect** (`acceptance-reports/device-control-cost-2026-10-31/`, Part B; audit `implementation-trackers/experience-audit/11-device-control-performance.md`, DP-07). In `useTimelinePlayback`, the desired-schedule fingerprint includes `readPlaybackInputsIdentity()`. Its input is Timeline's `nativePlaybackInputs`, which includes `effects: snapshotEffectsProjection()`, and preview drafts flow into that projection. Any processor-only parameter change therefore advances the identity:
- **While playing:** one schedule compile, prepare and publish per change. 20 edits made 20 publishes.
- **While paused with a native preview:** one `disposeNativePreview(…, "paused-preview-structural-change")` per change, which is a host stop plus teardown.

The built-in state-patch path (mapper, then `liveProcessorControl`) already carries these edits with zero schedule work. The fingerprint duplicates it.

**Fix direction:** the fingerprint must see only inputs that change the compiled schedule.
- Keep: structure, membership, order, routing, and non-live fields that the mapper cannot express.
- Exclude: processor parameter values that the state-patch path owns. Use the mapper's own classification; do not add a second list.
- Do not add a second general-purpose fingerprint.

Settle this together with B5b's "exactly one desired writer". Do it before C0/C1, because the packaged effect-edit row (C0) depends on it.

**Gate:**
- Measurement Part B, re-run:
  - 0 compiles and 0 preview disposals for processor-only edits, both playing and paused;
  - a structural edit, such as adding an effect or changing the order, still compiles;
  - a non-live field still reaches playback through its existing path.
- Gate G stays green.
- The device-control-cost Part B rows are the witness. Add them to the fuzzer only if they can be expressed there without duplication.

### B6. End-state sweep, not a second migration

Delete fallback clocks/legacy result projections and dead metadata only after consumer search (`src/lib/undo/types.ts`, `src/lib/export/run-export-job.ts`). No compatibility views. Exactly one desired writer and one receipt authority; confirmed graph is a materialized cache. Regenerate every reserved seed-plus-prefix under the final command graph, run G and 100 corrected seeds with no failures, deterministic trace comparison, then extended 1,000 seeds before packaging. Old exact A1 replays remain frozen evidence, not mandatory executable sequences.

Carried from B3b:
- Make the real Timeline flush/commit path (`flushNativeBuiltInParams`, `handleNativeBuiltInFlush`, `handleEffectParamsCommitted`) reachable from the hook fixture, or extract it, so the fixture stops mirroring it.
- Add a permanent witness for an unsent record across a second domain move (overlapping paused seek plus `start()`).

Sol checks scope, dead paths, no casts/processor timers/polling, ownership balance and final checklist. One Luna sweep + Sol review. The following is Fable's **verbatim end-state checklist**; line notation is approximate and aliases are defined above (the symbol, not the number, is authoritative).

Controller (`ctl`):
- `processorStateSequence` clock `:481`, allocation at `:2737`, `:2796-2797`, `:3760-3762`.
- `desiredProcessorPatches` `:483` (`:1094`, `:2922`, `:3105-3111`, `:3734-3737`, `:3764-3770`).
- `acceptedProcessorPatches` `:484` (`:1095`, `:3105`, `:3587`, `:3735`).
- `preparedProcessorStateSequence` `:486` (`:1097`, `:1854`, `:3102-3116`, `:3129`, `:3295`).
- `appliedProcessorSequences` `:487` (`:1098`, `:2644`, `:3103-3117`, `:3296`, `:3582-3586`, `:3639`).
- `replacePreparedGraph`'s `statePatch` parameter and `preparedGraphGeneration` `:476,:488-492`; `isScheduleCandidateValid` keeps `structuralGraphGeneration` only.
- `isProcessorSequenceOlder` `:495`, `isProcessorPatchSuperseded` `:3289-3298`, `statePatchMatchesCurrentProcessor` `:3299-3305`, `acceptProcessorStatePatch` `:3577-3588`.
- `rebaseScheduleCandidate` winner selection `:500-528` (keep `compensateGraph` `:538-546` as a pure helper; materialization reads the ledger).
- `publicationCancellationListeners` `:550`, `cancelStagedPublication` `:551` (`:2880`, `:3281`, `:3344`, `:2299`, `:2319`).
- `pendingStatePatches` `:589`, `deferredStatePatches` `:590`, `resumeDeferredStatePatches` `:591-600`, `statePatchActive`/`statePatchPumpScheduled` `:601-602`, `pumpBuiltInStatePatches` `:3713-3749`, dedup in `queueBuiltInStatePatch` `:3763-3772`.
- Timer in `waitForNativeProcessorSequence` `:937-945`; `processorSequenceWaiters` `:702` becomes owner-private.
- `queueLiveProcessorControl` as a writer `:2625-2679` (the `liveProcessorControl` facade `:2681-2688` may stay as the public shape).
- Unproven `appliedSequence` in `reenableProcessorAutomation` `:2725-2726`.
- `publishScheduleRevision`: `mergedPatches` `:2922`, sequence bookkeeping in `adoptPublication` `:3102-3117`, deferred equal-floor settlement `:3128-3136`, private progress subscription and `waitForProgress` `:2883-2895`, `publicationFailure` `:3084,:3207,:3214-3220`.
- `publishLatencyGraph` entirely `:3310-3547`.
- `onScheduleOwnershipChange` `:390`, `:561`, `:3700`.
- `isScheduleCandidateCurrent` `:3981`, `scheduleOwnership` `:3982`.

Hook (`hook`): `:283-285`; `:1427-1441`; `completeScheduleAdoption` `:1442-1450`; `dispatchScheduleAdoption` `:1451-1557`; `failedScheduleContent` reset `:1563`; fingerprint dedup `:1576-1599`; progress retry effect `:2135-2149`.

Panel (`panel`): unconditional restore in `revertFailedSettle` `:1044`; cancel restore `:1338-1344`; the stamp capture in `writeDraftParams` `:693-694` (replaced by identity allocation).

Timeline (`tl`): the inputs-identity counter as edit order `:440-444`; the three-way read in `getDesiredProcessorState` `:738-752` once the ledger ingests projected state directly.

May legitimately remain: `transportEpoch`, `lifecycleGeneration`, `nativeSessionGeneration`, `preparedHostIdentity`, `nativeAdmissionCapacityGeneration` and `scheduleCapacityEpoch` (as capacity facts, not retry identity), `structuralGraphGeneration`, `preparedGraph` as the confirmed materialized cache, `preparedSnapshot`, the coordinator and its suspend/resume, the native execution lane (`:2135-2140`, with preemption), `nextLiveProcessorSequence` as a wire sequence (owner-private), `nextLiveEventSequence`, leases and page manager, `graphForBuiltInStatePatch` as a pure materializer, `nativeScheduleRebuildReason`, `nativeSnapshotSupportError`, `settleStagedAfterTransport` generalized.

**Status: complete (2026-11-08).** B6a1–a3, B6b and B6d1–d8 are accepted, and the plan §5 re-certification (RC1 restart, RC2, RC3) passed on the frozen final bytes `/tmp/dv01-b6/rc/final-manifest-3.json`. Evidence: [`PARENT-RULING-B6-ACCEPTED.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-B6-ACCEPTED.md) and [`REVIEW-B6-RECERT.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-B6-RECERT.md) (Claude Fable 5.1, ACCEPT, 0 blockers); `B6-REPORT.md` RC1 (restart), RC2 and RC3; the archived envelopes in [`evidence-b6/INDEX.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/evidence-b6/INDEX.md). Write-up: "Processor-state owner: B6 end-state sweep and re-certification" in `acceptance-reports/ae-08-phase-5-2026-10-18/README.md`. This is source-level evidence only; C0 and C1 have not run.

**Addendum (2026-11-08): B6e accepted.** The B6 re-certification review's F1 (§E) was probed, reproduced together with F1b, and fixed as B6e: `handlePause` chains `cancelStartKeepingGraph("pause-superseded-rebuild", pausePromise)` (`useTimelinePlayback.ts:1036`), and `cancelStartKeepingGraph` routes that `after` promise to `disposeNativePreview` (`:989–990`), so the paused graph is re-prepared from the edited tracks. Mutations 439 and 440 kill it. The DP-04 fix, P1 and Option A landed in the same window, and RC4 re-certified all four on the frozen bytes `/tmp/dv01-b6/rc4/final-manifest-4.json` (`aeaa0238…4d9d`, 36 entries). RC4's `trace-hook-a` (`d0645803…7e82`) is now the hook trace reference for later RCs. Evidence: [`PARENT-RULING-RC4-ACCEPTED-DV01-COMPLETE.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-RC4-ACCEPTED-DV01-COMPLETE.md), [`REVIEW-RC4.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-RC4.md) (Claude Fable 5.1, ACCEPT, 0 blockers), [`RC4-REPORT.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/RC4-REPORT.md), [`F1-PROBE-REPORT.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/F1-PROBE-REPORT.md), [`B6E-REPORT.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/B6E-REPORT.md), [`PARENT-RULING-B6E-verified.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-B6E-verified.md), and the archive [`evidence-rc4/INDEX.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/evidence-rc4/INDEX.md). Write-up: "Post-B6: B6e, DP-04, P1, Option A and RC4" in `acceptance-reports/ae-08-phase-5-2026-10-18/README.md`. Still source-level only: C0 and C1 have not run.

**Addendum (2026-11-09): B6f–B6f5, RC5, the packaged C0 rounds, C0f–C0j, RC6 and RC7.** BD = `../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/`; P5 = `../acceptance-reports/ae-08-phase-5-2026-10-18/`.

**B6f–B6f5: the portable browser session is always live.**
- **The user's two decisions:**
  - A paused portable session follows native's always-live rule ([`PARENT-NOTE-USER-CONFIRMATION-PORTABLE-LIVE-2026-11-08.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-NOTE-USER-CONFIRMATION-PORTABLE-LIVE-2026-11-08.md)).
  - Mixer edits reach a playing portable session live, with no gap, on the shared C++ core through WASM ([`PARENT-NOTE-USER-DECISION-PORTABLE-MIXER-2026-11-08.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-NOTE-USER-DECISION-PORTABLE-MIXER-2026-11-08.md)).
- **B6f** (mutations 449–459) re-prepares or re-seeks the portable session on every paused or stopped route.
- **B6f2** (460–464) waits for a pending Pause before a locate, removes the guards proven redundant, and closes the G5 project-switch gap.
- **B6f3** (465–467) keeps G6 with a fault witness, which re-witnesses row 456.
- **B6f4** (468–471) disposes the stale paused session after a mixer edit with native off.
- **B6f5 steps 0–5c** (472–509):
  - fix the source-bus limit that kept 3-track browser projects off the portable session;
  - ramp edge-gain changes at publish;
  - disconnect portable sources from the microphone;
  - pass a null pointer for a zero-byte event buffer;
  - adopt mixer, master and automation edits live;
  - keep name and colour out of the playback fingerprint.
- **Rulings:** `PARENT-RULING-B6F-AUDIT.md`, `-B6F-ACCEPTED.md`, `-B6F3-ACCEPTED.md`, `-B6F4-ACCEPTED.md`, `-B6F5-MIXER-DESIGN.md`, `-B6F5-STEP0-2.md`, `-B6F5-CORE-REVIEW.md`, `-B6F5-STEP2C.md`, `-B6F5-STEP3-5.md`, `-REVIEW-B6F5-STEP3-5.md` and `-B6F5-STEP5C.md`, beside their reports and reviews in BD.

**RC5** ([`PARENT-RULING-RC5-ACCEPTED.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-RC5-ACCEPTED.md), [`REVIEW-RC5.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-RC5.md), Claude Fable 5.1 ACCEPT with 0 blockers, and [`RC5-REPORT.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/RC5-REPORT.md)).
- The first run stopped on row 456 ([`PARENT-RULING-RC5-STOP-456.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-RC5-STOP-456.md)), which B6f3 settled.
- The restart re-certified B6f–B6f5c and C0/C0b on `/tmp/dv01-b6/rc5/final-manifest-5b.json` (`59846b72…05c6dd`, 58 entries), with 487 envelopes.
- Ledger ID 510. Trace references: controller `e49cb9e2…295d`, hook `38e08cf2…715a`.

**The packaged C0 rounds** ([`PARENT-RULING-C0-PACKAGED-STOP.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0-PACKAGED-STOP.md) and the rulings below). These are the first packaged phase-5 runs that passed any row; every earlier one was 0/8.
- **C0: 6/9** ([`C0-PACKAGED-REPORT.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/C0-PACKAGED-REPORT.md)).
  - Three rows failed: effect-state cold-rebuilt on resume, add-paged-asset was never heard live, and remove-readd-track published 4 times.
  - C0d repeated the run, so the failures are deterministic, and found the roots ([`C0D-DIAGNOSIS.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/C0D-DIAGNOSIS.md), [`PARENT-RULING-C0D.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0D.md)).
- **C0f** ([`C0F-REPORT.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/C0F-REPORT.md), [`REVIEW-C0F.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-C0F.md), [`PARENT-RULING-C0F-REVIEW.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0F-REVIEW.md)):
  - the prepared snapshot keeps its compile revision;
  - a local import is decoded;
  - `waveformAssetKey` leaves the clip fingerprint;
  - the fixture's knob drag is gated on the knob's own state.
- **C0g** ([`C0G-REPORT.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/C0G-REPORT.md), [`REVIEW-C0G.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-C0G.md), [`PARENT-RULING-C0G-ACCEPTED.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0G-ACCEPTED.md)):
  - an `unchanged` adoption carries the compile revision, so the resume stays warm;
  - the clip fingerprint is built from an explicit field list;
  - the parent added the `satisfies` guard.
- **RC6** ([`RC6-REPORT.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/RC6-REPORT.md), [`PARENT-RULING-RC6-STOP-513.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-RC6-STOP-513.md), [`PARENT-RULING-RC6-ACCEPTED.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-RC6-ACCEPTED.md)):
  - manifest-6 `9b5b11ff…bd2a`, 62 entries;
  - row 513 re-witnessed;
  - ID 517.
- **C0e: 7/9** ([`C0E-PACKAGED-REPORT.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/C0E-PACKAGED-REPORT.md), [`PARENT-RULING-C0E.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0E.md)).
  - The remove-readd-track and add-paged-asset fixes held.
  - A `structuredClone(AudioBuffer)` fault dialog stopped effect-state.
  - The import published twice, and the user chose to keep that, Ableton-style ([`PARENT-NOTE-USER-DECISION-IMPORT-PUBLISH-2026-11-09.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-NOTE-USER-DECISION-IMPORT-PUBLISH-2026-11-09.md)).
- **C0h** ([`C0H-REPORT.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/C0H-REPORT.md), [`REVIEW-C0H.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-C0H.md), [`PARENT-RULING-C0H-ACCEPTED.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0H-ACCEPTED.md)):
  - the latency capture makes a shallow copy (`native-playback-controller.ts:4277`);
  - the add-paged-asset oracle admits one silent track-only publication.
- **RC7** ([`RC7-REPORT.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/RC7-REPORT.md), [`PARENT-RULING-RC7-ACCEPTED.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-RC7-ACCEPTED.md)):
  - manifest-7 `02b1ddf6…f490`, 62 entries;
  - lint judged as a set;
  - ID 520.
- **C0i: 8/9** ([`C0I-PACKAGED-REPORT.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/C0I-PACKAGED-REPORT.md), [`PARENT-RULING-C0I.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0I.md)).
  - Effect-state completed its whole route with a warm resume, and the −14 dB edit survived.
  - Its two failing checks were oracle defects.
- **C0j: re-analysis of the C0i run, 9/9**, with effect-state at 16/16 ([`C0J-REPORT.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/C0J-REPORT.md), [`PARENT-RULING-C0J-ACCEPTED.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0J-ACCEPTED.md), [`REVIEW-C0J.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-C0J.md), [`PARENT-RULING-C0J-REVIEW-C1.md`](../acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C0J-REVIEW-C1.md)).
  - `pauseBoundary` requires a warm resume at the paused epoch and frame.
  - `retainedLeftExact` uses each reference's derived compensation.
  - F1 and F5 are promoted.
  - Mutations 521–524; the next free ID is 525.

**Standing references after RC7:**
- manifest-7 `02b1ddf6…f490`;
- traces: controller `84960ebf…80f7`, hook `6f1422d4…7ac5`;
- DP `a2695086…6e76`;
- WASM `0595e7d1…f195`;
- analyzer `32a36cc6…9330`;
- the C1 package: `app.asar` `f4b2f0e0…fb95`, host `2290d6ee…`.

**Evidence:** [`evidence-rc5-rc7/INDEX.md`](../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/evidence-rc5-rc7/INDEX.md), and P5 `c0-packaged/`, `c0d-repeat/`, `c0e-packaged/`, `c0h/`, `c0i-packaged/` and `c0j/`. Write-up: "Packaged phase 5: C0 rounds, fixes and RC5–RC7" in `acceptance-reports/ae-08-phase-5-2026-10-18/README.md`. The follow-ups are in §E below.

C1 running; certification status pending.


## C. Certification afterwards

### C0. Extend effect-state packaged coverage before certification

One Luna implementation task plus Sol review: extend `tools/acceptance/ae-08-phase-5-fixture.ts` phase-5 rows (~164–215), the existing `ae-08-live-graph.ts` runner and continuity analyzer as needed. Existing eight rows certify clip/track/tempo edits, not processor-state editing.

| New packaged row | Required real evidence |
| --- | --- |
| Effect-state live edit | Gain preview and flush, spectral FFT change during playback, and pause during the flush; retain the knob/draft and persist without restore. Capture real PCM through the existing runner and have the analyzer check continuity over playing spans, respecting deliberate pause/resume boundaries, plus resulting gain/FFT and publication/transport proof. |

Add the failure witness before implementation; preserve package ownership guards, thresholds and synthetic-defect analyzer controls. This extension is its own prerequisite task, not something the fuzzer implicitly certifies. Record its final row/check counts before running C1.

### C1. Serial packaged campaign

Only after the source gates pass and the app/device/profile is available. Run serially on one rebuilt package; never attach to or terminate another acceptance/user app. Keep existing ownership guards, normal quit, thresholds, PCM/reference capture and synthetic-defect analyzer checks. A fuzzer pass is not native/audio certification.

Commands below are executor instructions, **not run during this planning task**. From repository root, set a fresh absolute `R` under the phase-5 report for this campaign; record its exact value. Every Bun command has a Perl hard guard:

```sh
R=/Users/juan/Documents/daw-browser-convex/acceptance-reports/ae-08-phase-5-2026-10-18/processor-owner-certification
(cd /Users/juan/Documents/daw-browser-convex/apps/desktop && VST3_SDK_PATH=/Users/juan/Documents/vst3sdk-3.8.0 perl -e 'alarm shift; exec @ARGV' 2400 bun run package)
perl -e 'alarm shift; exec @ARGV' 7200 bun tools/acceptance/ae-08-live-graph.ts --phase 5 --out "$R/phase5"
perl -e 'alarm shift; exec @ARGV' 300 bun tools/acceptance/analyze-ae-08-continuity.ts --run "$R/phase5"
perl -e 'alarm shift; exec @ARGV' 3600 bun tools/acceptance/ae-08-live-graph.ts --phase 4 --out "$R/phase4"
perl -e 'alarm shift; exec @ARGV' 300 bun tools/acceptance/analyze-ae-08-continuity.ts --run "$R/phase4"
perl -e 'alarm shift; exec @ARGV' 1800 bun tools/acceptance/ae-08-live-graph.ts --phase 3 --out "$R/phase3"
perl -e 'alarm shift; exec @ARGV' 300 bun tools/acceptance/analyze-ae-08-continuity.ts --phase-3-run "$R/phase3"
```

Then pin r27/paging to this package, not their historical defaults:

```sh
RES=/Users/juan/Documents/daw-browser-convex/apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/Resources
export DAW_EXPECTED_ASAR_SIZE="$(stat -f %z "$RES/app.asar")"
export DAW_EXPECTED_HOST_SIZE="$(stat -f %z "$RES/daw-audio-host-macos")"
export DAW_EXPECTED_ASAR_MTIME="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$RES/app.asar")"
DAW_R27_BATCH=A perl -e 'alarm shift; exec @ARGV' 6000 bun tools/acceptance/packaged-r27-regressions.ts
DAW_R27_BATCH=B perl -e 'alarm shift; exec @ARGV' 6000 bun tools/acceptance/packaged-r27-regressions.ts
DAW_ACCEPTANCE_REPORT_DIRECTORY="$R/paging" perl -e 'alarm shift; exec @ARGV' 6000 bun tools/acceptance/native-instrument-paging-packaged.ts
```

The host path matches `packaged-r27-regressions.ts` package identity check (~1214). Required verdicts in order: package, phase 5 **all original 8/8 plus the new effect-state row/checks (record final total)**, phase 4 **9/9**, phase 3 **7/7 checks**, r27 A **6/6**, B **4/4**, paging **12/12**. r27 writes to its existing batch directories, so link its exact run IDs from `R`, rather than claiming an unsupported output override. Record artifact hashes before/after each runner, host/configuration/transport identities, normal quits, raw WAVs, revision proofs and unchanged tolerances.

Append implementation/fuzzer findings and final certification separately to `acceptance-reports/ae-08-phase-5-2026-10-18/README.md`, following “Phase 5 adopted dispatch review fixes r8b”; add a named “Processor-state owner: fuzzer and certification” section. Append exact commands, exit codes, failures/skips and artifact links under the matching heading in `live-command-ledger.md`. Update `implementation-trackers/experience-polish-tracker.md`, “AE-08 phase 5” checkpoint/remaining entries (~367–378), and the phase-5 status in `ae-08-live-graph-edits-plan.md`. Mark this plan's A/B/C milestones complete only with corresponding evidence. No universal live-VST, collaboration conflict-resolution or later-phase completion claim.

## D. Blocking open questions

None block source design. Certification is blocked until the C0 fixture/runner extension is complete and an owned rebuilt-package/device acceptance slot is available. Collaboration arrival ordering is a documented choice, not an open question.

## E. Follow-ups recorded outside DV01

- **Content-bearing admission identity** (from DV01 6B, `acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-6B-stop4.md`). The playback-inputs identity (`useTimelinePlayback.ts` `readPlaybackInputsIdentity`) and the registry's `processorStructure` are monotonic counters, so a structural edit that reverts gets a new identity. A queued intent that self-wakes after a not-taken terminal then compiles before the post-compile `unchanged` check discards it. This costs renderer CPU only, with no native I/O. The fix is to give admission a structural content key that covers every non-live compiler input and to associate it with native's active and in-flight schedule, so equal content skips the compile.
- **Step 6 review follow-ups** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-6-r4.md`). None of these blocks step 6:
  - F1: without a desired projection, an old-incarnation urgent carrier that is refused or unconfirmed is rebound and re-sent against the newer incarnation (`native-playback-controller.ts` retry paths ~2913, ~2947; owner ~1421). This is pre-existing. Production always supplies the projection (`Timeline.tsx:774–778`).
  - F2: after an incarnation replacement, a promoted key-only synth receipt whose recovery was deferred stays unanswered until the session is cleared. Its lifetime must be defined and ended without certifying the replacement content. No current caller makes a key-only synth join; the panel routes synths through edited delivery (`create-effects-panel-state.ts:389–392`).
  - An effect delivery behind an unmatched effect `joinPublication` stays unanswered after one send. This is pre-existing, and there is no effect caller of `joinPublication`.
  - W40 coverage: add the row where native proves `published` on the first Inspect and every later Inspect is lost. Only that row kills a failure-before-proof mutant.
- **DONE 2026-11-06: Recording Finish masked a lost processor-patch status** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-RECORDING-FINISH.md`). The watchdog is now suppressed only for a Finish that is both pending and dispatched (`apps/desktop/audio-host.ts:1602`, `:2338`). A queued Stop is rejected unsent when the host is lost. The graph-reply deadline now advances the queue (`:2270`). A stale stack capture can no longer kill a newer command (`:1618–1620`). There are 11 supervisor cases in `apps/desktop/audio-host.test.ts:2545` onward. The Sol review accepts it with 0 blockers.
- **Recording-Finish test follow-ups (low priority).**
  - The late-patch/stack-capture case (`apps/desktop/audio-host.test.ts:2877–2893`) races the real `/usr/bin/sample` completion. On a host without that sampler, the spawn error can finish capture first, so the case fails, as reproduced by the review. The fix is to give the test control of sampler completion through a fixture seam.
  - The `recordingFinishFixture` setup (`:2591–2595`) has no cleanup if setup fails, and its disposer does not await each child's `close`. Add a setup try/catch and per-child close promises.
- **B6a2 follow-ups** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-B6A2-accepted.md`, `B6A2-W19-DIAGNOSIS.md`). Neither has a product caller.
  - W19 uses a synth for its key-only join. It selects the fixture's `"key-only"` mode to withhold the synth's registry identity. Product key-only joins come only from sampler, drum-rack and granular instruments (`create-effects-panel-state.ts:392–403`), and the registry tracks synths only. The witness should move to a sampler so it mirrors the product.
  - A public key-only synth join on a registered synth carries the owner's incarnation, not the registry's. `attachPublication` therefore excludes it from every cohort (`native-processor-state-owner.ts` ~1012), and it stays pending until loss or dispose answers `unavailable`. The contract for mixing the two needs a definition. This extends F2 above.
  - The no-projection execution paths (F1) and key-only synth recovery (`native-processor-state-owner.ts` ~622, `edit?.id ?? receipt.key`) remain kept, with W36 and W39 public-path proof.
- **B6a3 review follow-up** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-B6A3.md` F2). The controller `lost-edit` plant does not test a permanently lost edit. Its retry is enqueued while `droppedBatch` still answers refused, so the run converges and I3 is never exercised. This also happens on pre-B6 bytes. Fix the plant so the edit stays absent across retry and fallback, and require the lost-edit classification with an identical passing control (`tools/acceptance/ae-08-processor-state-fuzz-host.ts:488–492`, FF:379–387).
- **B6b follow-ups** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-B6B.md` F1 and F2; mutation 279). None of these blocks B6.
  - **Owner L:1578 must stay.** It retargets the epoch of unsent executions at `endDomain`.
    - Mutation 279 removes it and survives every executed witness. The reason is that `sendExecution` rebinds an unsent record to the current epoch (`native-playback-controller.ts` ~3003–3010, owner ~1484–1491).
    - That only proves it is redundant for the tested schedule. Epoch also feeds delivery coverage (owner ~734–762).
    - Sol's untested discriminator:
      1. Hold `seekPrepared(0.25)`, then send edit A (−9 dB), which stays unsent.
      2. Call `start(0.5)`, which moves the controller to epoch 3 with native still held.
      3. Send a newer edit B back to the installed 0 dB.
      4. With the line intact, B stays pending. Without it, A falls back to the installed value and B answers `applied` at once (owner ~737–740, ~1219–1222).
    - Run this in its own approved checkpoint before deciding whether to keep, delete or replace the retarget.
  - **Effects of the start-domain `endDomain` with no witness yet:** recovering followers, clearing `exhausted`, releasing `queuedPatch.held`, aborting compiles, and disposing the retained candidate. Only the refused-requeue effect has a witness (`native-playback-controller.test.ts` ~6617–6717).
  - **Hook gate-prefix children** (`ae-08-processor-state-fuzz-hook-runner.ts` ~307–310) do not inherit the `--preload` argv, so mutation overlays cannot be credited to hook prefixes.
  - **Mount gap:** the fixture shares the production history callback but does not mount the full Timeline or `reserveInstanceEffectEdit` wiring (FHC:78).
- **B6d2 follow-ups** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-B6D2-DESIGN.md` §7; `PARENT-RULING-B6D2-design.md`).
  - **Must close before AE-08 phase 8 is accepted.** Resume compares only assets and processor membership against the prepared graph. A recompile that changes tracks, buses, sends or routing can still be adopted at resume without being installed, through remote changes or the MIDI-tails route (`useTimelinePlayback.ts` ~2064).
    - Close it either by routing every structural change through the live coordinator, which is what phase 8 does, or by comparing a structural subset of the product fingerprint at resume, without parameters or transport.
    - **Update 2026-11-09** (`REVIEW-C0F.md` §1.2 and §7 item 1; `REVIEW-C0G.md` §6 item 5; both in `acceptance-reports/ae-08-phase-5-2026-10-18/`).
      - C0f and C0g widen the set of sessions that reach the warm resume. Before them, a session with any staged publication always cold-started; it now resumes warm, and so does one whose adoption deduped to `unchanged` at a newer revision.
      - The hook's paused path still re-prepares on a fingerprint change unless MIDI tails are live (`useTimelinePlayback.ts` ~2189–2198), so the exposure stays the MIDI-tails and remote-change routes above.
      - A structural fingerprint at the resume gate (`native-playback-controller.ts:1620` on the C0f bytes) would close this item and subsume the C0g revision fix.
  - The E949 `execution.sent &&` condition is a conservative diagnostic survivor.
  - The W-G2 discriminating mutant is `p-g1.diff` (queued-only).
- **B6d2 follow-up: start during a pending pause** (`REVIEW-B6D2.md` finding 1). `controller.start` answers `"started"` as a no-op while a pause is pending (`native-playback-controller.ts` ~2279), and the session stays paused. No product caller reaches it, because every play path awaits the pending pause (`useTimelinePlayback.ts` ~669–692, ~1620). It is a contract hazard for any future caller. Either queue the start behind the pause, or answer it truthfully.
- **B6d3 follow-ups** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-B6D3.md` §11).
  - **F1.** A seek issued between `disposeNativePreview`'s request and the chained dispose's execution is routed correctly only because host replies arrive in order (`useTimelinePlayback.ts` ~1233–1266, ~1354). A structural close needs a request-time marker.
  - **F2.** A superseded paused seek that answers after the replacement has started prepares once more. The end state is correct.
  - **F7.** A seek on a committed preview that is still starting replaces its coordinator. This is contract-conformant and not visible to the user.
- **B6d4 follow-ups:** F8–F11 are fixed in B6d5 (`PARENT-RULING-B6D4-accepted.md`). F12 is a ledger correction, already appended.
- **B6d6/B6d7 follow-ups** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-B6D6-D7.md` §8.3).
  - **Play during a project switch.**
    - **Symptom:** a Play made while the project-switch dispose is still capturing VST state is answered `started` on the session being retired. One frame later the tick stops it, the user sees "Native audio playback stopped because the native graph is no longer active", and the new project's paused graph is live.
    - **Effect:** it corrects itself, so all invariants hold, but the Play is lost and a spurious fault is shown.
    - **Cause:** a Play waits for an in-flight dispose only when that dispose had a pending start (`useTimelinePlayback.ts` ~676–679, controller ~2288).
    - **Fix direction:** have the Play wait on any in-flight `preparedBackendDisposePromise`.
  - **B6d5 report §11.1** is covered by F13 by reading the code. It has not been probed.
- **RC2 follow-up: mutant 169** (`PARENT-RULING-RC2-169.md`).
  - **What we know:** in the step-7 latency schedule, two guards protect the same ordering, so each masks the other:
    - the hook chains a paused structural dispose behind the pending pause when tracks changed (`useTimelinePlayback.ts` ~2120);
    - the controller defers paused-preview maintenance during an active publication (`native-playback-controller.ts` ~1549–1552).
  - **What is not known:** whether the hook guard is redundant when no publication is active.
  - **Next step:** write a discriminator (a pending pause, no publication, and a track change; the dispose must still wait for the pause). Then decide whether to delete the hook guard or keep both.
- **RC2 follow-up: fixture correction E has only a unit-level witness.** On the final bytes, no census seed reaches asset-identity reuse under rollback and re-prepare any more. Hook seeds 120, 274 and 878 changed trajectory, so mutant 385 is killed only by `native-playback-controller.test.ts` ~2117–2149. Add a fuzz scenario or prefix that reaches it.
- **RC2 follow-ups** (`PARENT-VERIFY-RC2.md`; RC2 section of `B6-REPORT.md` §11).
  - **Two more redundant guard pairs,** handled like the 169/409 pair: 418/427 (B6d4/B6d5) and 419/437 (B6d4/B6d8). In each pair, the two guards mask each other only on the tested schedules. Neither guard is proven redundant beyond those schedules. Write a discriminator for each pair, then decide whether to delete one guard or keep both.
  - **Fuzz coverage gap for fix C2.** Resume hands the recompiled processor content to the ledger. On the final bytes, hook seed 498 reaches that code under mutant 390 and still passes. Only the CT witness kills the mutant. Add a fuzz scenario that observes the resumed content.
- **RESOLVED 2026-11-08 by B6e. B6 re-certification review F1: Pause during a resuming rebuild that has not retired the graph** (`REVIEW-B6-RECERT.md` §9 F1; `REVIEW-B6D6-D7.md` §8.4). The probe reproduced it, plus F1b (a Pause after the rebuild's Play commits ended with no graph); both are fixed at `useTimelinePlayback.ts:989–990` and `:1036`, with mutations 439 and 440, and accepted after RC4 (`F1-PROBE-REPORT.md`, `B6E-REPORT.md`, `PARENT-RULING-RC4-ACCEPTED-DV01-COMPLETE.md`). The original entry follows as history. **Probe before C1; if reproduced, fix before packaging.** It bears on the user's rule that the native graph is always live.
  - **Unverified, by reading only.** A Pause while playing, while a resuming rebuild waits before it retires the graph (`useTimelinePlayback.ts` ~1671), pauses the old session and supersedes the rebuild. The paused graph may then keep the pre-edit structure:
    - the maintenance effect (~2098–2156) run by `setIsPlaying(false)` returns at ~2108, because `rebuildInProgress` (a plain `let`, ~192) is still true;
    - the rebuild's `finally` (~1595–1600) changes no tracked signal, so the effect does not run again until some other signal changes.
  - The census oracle passes on the final bytes, so either the fuzz does not reach this window or it converges.
  - **Probe:** the B6d8 Q1 fixture shape (`useTimelinePlayback.test.ts` ~5584), holding the rebuild before ~1671 instead of at teardown, and asserting that the replacement paused preview carries the edited structure.
- **B6 re-certification review F2: validation lists** (`REVIEW-B6-RECERT.md` §9 F2; `PARENT-RULING-RC1-stop.md`, `PARENT-RULING-RC3-stop.md`). `tools/acceptance/device-control-cost.browser.test.ts` and `src/lib/instrument-buffer-sync.test.ts` pin paused structural behaviour, and neither was in any B6d validation list, so the accepted B6d3 change reached them only at RC1 and RC3. Every future checkpoint's validation list must include:
  - the cost browser suite and the instrument-buffer suite;
  - the §5.6 item 1 suites: `packages/audio-engine/src` and `src/lib/instrument-buffer-sync.test.ts`, isolated and last.

  A list that leaves any of them out states why. An edit to a file under `src/` also re-runs G typecheck and G root lint, which load it (`PARENT-RULING-B6-ACCEPTED.md`, correction F3).
- **B6 re-certification review F5: the cost browser test is not type-checked** (`REVIEW-B6-RECERT.md` §9 F5; `RC1-FIX-REPORT.md` §5). `bun run typecheck` uses the root `tsconfig.json`, which includes `src`, `convex` and `vite.config.ts` but not `tools/`. `tools/acceptance/device-control-cost.browser.test.ts` carries 3 pre-existing `tsc` errors, all `canonical` shape mismatches (lines 729, 730 and 806 on the RC1 entry bytes, 732, 733 and 809 after the RC1 amendment). Either add a `tools/acceptance` tsconfig to `bun run typecheck`, or fix the three sites in their own step.
- **RC4 review follow-ups** (`REVIEW-RC4.md` §7, items 1–12; grouped by `PARENT-RULING-RC4-ACCEPTED-DV01-COMPLETE.md`). None blocks DV-01 or B6e. Line numbers are on the manifest-4 bytes. R = `acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-RC4.md`.
  - **For the AE-08 phases 6–10 plan (the largest item):**
    - **Item 2: non-live instrument edits rebuild with an audible gap** (R:145). The 21 non-live Synth controls (everything `mapInstrument` excludes, `src/lib/desktop/native-built-in-parameter-mapper.ts:154–168`), and Drum Rack, Sampler and Granular, which have no portable live path (`src/lib/portable-browser-playback-controller.ts:2100` refuses non-synth nodes; `allocateEdit` returns `undefined` for non-synth, `src/components/timeline/create-effects-panel-state.ts:395`). Pre-existing; P1 is a strict improvement. Bears on AE-08's goal that live graph edits never interrupt audio (`PARENT-RULING-P1-DESIGN.md` D5).
      - Re-listed by `PARENT-RULING-RC5-ACCEPTED.md`. Build it on the shared native core through WASM, as the user directed for the live portable mixer path (`PARENT-NOTE-USER-DECISION-PORTABLE-MIXER-2026-11-08.md`), rather than as a parallel TypeScript path.
  - **Before C1:**
    - **CLOSED 2026-11-09 by B6f–B6f5: item 10, the paused-portable contract** (R:153).
      - The user confirmed that a paused portable session follows the same always-live rule (`PARENT-NOTE-USER-CONFIRMATION-PORTABLE-LIVE-2026-11-08.md`).
      - B6f–B6f5 implemented it (`REVIEW-B6F.md` §7: "RC4 follow-up 10 is closed by this step"), and RC5 re-certified it (`PARENT-RULING-RC5-ACCEPTED.md`).
      - The original entry follows as history.
    - **Item 10: paused-portable contract** (R:153). `cancelStartKeepingGraph` disposes a paused portable session too (`src/hooks/useTimelinePlayback.ts:1396–1398` when `!requiresNativeAudio`) and re-requests only native (`:995`), so in the F1 window on portable a paused session is disposed and the next Play compiles fresh. Decide whether a paused portable session must also stay live.
    - **Item 4: supply `SYNTH_KIND_ID` in the HT deps** (R:147). `src/hooks/useTimelinePlayback.test.ts:201` destructures it but `:254–263` does not supply it, so it is `undefined`; correct for today's Utility edit, a trap for a future Synth case. HT is in manifest-4, so do it the next time HT is re-certified (playback suite and the B6 witness set at minimum).
  - **Recorded trade-offs:**
    - **Item 3: native ≤2 registrations in the recovery frame after a stall** (R:146; R §5.3). The stalled job's `register` and the queued job's land together (`src/components/timeline/parameter-gesture-owner.ts:235`), in one frame, in order. Guard: the `OPTA ` witnesses in `src/hooks/useEffectsPanelAudioSync.test.ts` and mutations 445–446.
    - **Item 9: a final-delivery portable `bridge-error` fails the release** (R:152). `deliver` rejects into `repairFailure` (`parameter-gesture-owner.ts:366–368`), so the gesture is not persisted although the browser engine took the value. Accepted by D3-amended (`src/components/Timeline.tsx:2531–2537`) and identical to the effects path.
    - **Item 12: browser-engine lag under a portable ack stall** (R:155). The Synth apply awaits the portable ack (`create-effects-panel-state.ts:362`), so during a stall the browser engine (live MIDI fallback) holds the stalled value until recovery. The DP cannot show it.
  - **Recorded decision:**
    - **Item 5: hook trace-tree reference** (R:148). Option A changed the hook normalized trace-tree hash to `d0645803…7e82` (`RC4-REPORT.md` §3, fully attributed). RC4's `trace-hook-a` is the reference for later RCs (adopted by the ruling).
  - **Cleanups:**
    - **Item 1: duplicate fault on a refused Pause during a rebuild** (R:144). `useTimelinePlayback.ts:1036` `.catch(reportNativeStateCaptureFailure)` reports what `src/lib/desktop/native-playback-controller.ts:2656` already reported; same class at `useTimelinePlayback.ts:2122` (no catch). Dedupe in `reportNativeStopped`, or pass `pausePromise.catch(() => undefined)` and accept the redundant teardown (`PARENT-RULING-B6E-verified.md` ruling 1).
    - **Item 6: stale `previewProjectionBaseline` after a cancelled-start re-prepare** (R:149). `useTimelinePlayback.ts:994–996` does not set it (only `:791` and `:2154` do), so the next paused effect run with no track change takes `:2118` and rebuilds once more. Cost only, self-healing; shared with B6d8.
    - **Item 7: clamp Sampler zone ranges, Ableton style** (R:150). `packages/shared/src/sampler-params.ts:147` drops a zone when `keyLow > keyHigh` or `velocityLow > velocityHigh`; clamp the edited bound to the other instead.
    - **Item 8: assert the F1b witness anchor** (R:151). `committed()` (`useTimelinePlayback.test.ts:5810–5812`, defined and polled; R cites :5811) is state-based; "before `useTimelinePlayback.ts:1764`" is implied by two awaits. Optionally assert that no `stop`/`teardown` follows the rebuild's `start` at the anchor.
    - **Item 11: dead passthrough** (R:154). `rememberInstrumentParameters` at `useTimelinePlayback.ts:2224–2226` has no product consumer after P1. H is frozen; remove it in a later step.
- **RC5 ruling follow-ups** (`PARENT-RULING-RC5-ACCEPTED.md`). R5 = `acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/REVIEW-RC5.md`. Line numbers are those of the cited source. None blocks C1.
  - **From REVIEW-RC5 §9:**
    - **Name the mechanism behind the hook seed count shifts** (R5 §9 item 2; §6).
      - RC5: seeds 286, 357, 685 and 848 change observation counts (I2/I3/I5/I8/I9/I10), and seed 685 also changes `compileCount` 19 → 21.
      - RC6: 9 seeds (206, 246, 311, 357, 444, 449, 583, 667 and 785) change counts after C0f/C0g (`RC6-REPORT.md` §9.3).
      - Both RCs attributed this by an in-memory revert of the whole change set, not file by file. The likely cause is that B6f5's live adoptions compile where a rebuild path used not to.
      - A per-file revert of one affected batch (601 for RC5) would name the file. Record the class here so the next RC does not re-derive it.
    - **`rows-ledger.py` is not disposition-aware** (R5 §9 item 4, §5.3; `evidence-rc5-rc7/rc5b/rows-ledger.py:129–140`, RC6 and RC7 copies beside it).
      - Its predicate `killed == recordedKilled` cannot express "recorded SURVIVES, later killed by a new witness".
      - So the runner exits 2 on row 495 in RC5, RC6 and RC7 (`RC6-REPORT.md` §4.2, `RC7-REPORT.md` §4.2).
      - Fix: take each accepted disposition from a small table of row, disposition and ruling.
    - **CLOSED 2026-11-09: archive row 444's regenerated mutant** (R5 §9 item 5).
      - `evidence-rc5-rc7/rc5b/mut439/444/Timeline.mutant.tsx` (`a425e2e3…f868`) and the rewritten `specs/444-*.json` are archived, and the archive's `INDEX.md` records that the specs are path-moved copies.
      - The text ledger is append-only and was not edited.
    - **Note on DP coverage** (R5 §9 item 8, §7). DP's `portableSession` series counts a stub (`tools/acceptance/device-control-cost.browser-runtime.tsx:705`), so DP never runs the WASM worklet, the shared core or the portable controller's `adoptLive`. An unchanged DP hash is therefore no evidence about the portable live mixer path. The portable, WASM, matrix and native gates cover that path.
    - **CLOSED by the ruling or by the archive: items 1, 3, 6 and 7.**
      - Item 1: the host-linked ctest suite (tests 17–23) is a standing gate, 7/7 in RC6 and RC7.
      - Item 3: the RC5 and RC7 adopted trace trees are archived in `evidence-rc5-rc7/` as root files plus each seed's `seed.json` and `summary.json`. `REFERENCE-TREES-RC7.sha256` hashes every file of the RC7 trees, and the `events.jsonl` files are listed by hash.
      - Items 6 and 7: the ruling records row 495's disposition and the new trace references.
  - **Collected since RC4** (B6f–B6f5). H = `src/hooks/useTimelinePlayback.ts`, on each source's bytes.
    - **G9, R16 and R18: native playback turned off at runtime** (`PARENT-RULING-B6F-AUDIT.md` item 2; `PARENT-RULING-B6F-ACCEPTED.md`; `B6F-AUDIT-REPORT.md` rows R16, R18 and G9).
      - **G9** made the paused-preview effect read the lifecycle before `!enabled` (H:2126 on the B6f entry bytes). It was dropped because it served only R16, lifecycle suspended → ready, which the browser cannot reach: the browser has no lifecycle bridge (`Timeline.tsx:167`; H:171–178). The 160-case probe keeps G9 as its one red.
      - **R18,** turning native playback off, has no UI caller: the only caller is `setNativePlaybackEnabled(true)` (`Timeline.tsx:2076`).
      - **CLOSED by B6f4: the stale portable session after a mixer edit with native off** (`REVIEW-B6F.md` §8 item 3). B6f3 showed the native-off path is reachable for migrated preferences (`app-preferences-core.ts:254–257`). B6f4 fixed the stale session (`PARENT-RULING-B6F4-ACCEPTED.md`, mutations 468–471).
      - Revisit G9 and R18 if the browser gains a lifecycle bridge or a control that turns native playback off.
    - **A paused forward locate re-prepares instead of seeking** (`REVIEW-B6F.md` §5, §8 items 5–6).
      - `compatibleWithActiveSchedule` (`src/lib/portable-browser-playback-controller.ts` ~1300–1307, B6f bytes) seeks in place only for a backward locate inside the prepared range. So each paused forward ruler click in the browser costs one compile and one worklet session.
      - This is cost only: the end state meets the rule. The fix belongs in the controller, as a paused `refreshSchedule`.
      - Same class: Stop in the browser disposes and recompiles (H:1125–1127), where native seeks to 0.
    - **CLOSED 2026-11-09, a record correction: the R14 citation** (`REVIEW-B6F.md` §8 item 7). The B6f audit's R14 row cited `useTimelineProjectRoute.ts:118–122`, the sequential `setProjectId`. The product's dashboard project switch is the batched `navigateToRoom` at `useTimelineProjectRoute.ts:97–100`.
    - **Bounded auto-recovery after a fault while paused, for both backends** (`PARENT-RULING-B6F3-ACCEPTED.md`, new gap 1).
      - A worklet fault while paused leaves no portable session, with native on or off. That matches the user-confirmed native loss projection from B6a3: a lost session projects to `unprepared` and is not re-prepared.
      - Decide whether either backend should recover on its own, bounded so that a repeating fault cannot loop.
    - **F6: a take ended by a device fault does not re-run the follow** (`REVIEW-B6F5-STEP3-5.md` §10 F6; `PARENT-RULING-B6F5-STEP5C.md`; `B6F5-STEP5C-REPORT.md` §9).
      - A take that ends through `failRecording` (a worklet fault, a device `ended`, or a writer failure) leaves a held structural edit unfollowed until the next edit or transport change.
      - Fix direction: run `followPortableEdits` from the controller's `onFailure` path. It is in B6f3's parity class.
    - **Mixer faders heard live during a drag, on both builds** (`PARENT-RULING-B6F5-MIXER-DESIGN.md` D2; `REVIEW-B6F5-MIXER-DESIGN.md` §4 item 5; `REVIEW-B6F5-STEP3-5.md` §10 F7; `B6F5-MIXER-DESIGN.md` §5.2). Native and portable adopt a fader edit on commit, while Ableton plays fader moves live. For AE-08 phases 6–10, building on the R5 gain smoothing.
    - **The v1 portable host's zero-byte event pointer** (`PARENT-RULING-B6F5-STEP2C.md`; `B6F5-STEP2C-REPORT.md`; `public/audio-worklets/daw-portable-audio-core-host-v1.js:1436`).
      - v1 still passes a non-null pointer with a zero byte count, which the core rejects. Step 2c fixed v2 only.
      - The product loads only v2 (`daw-portable-audio-core-processor-v2.js`, `daw-portable-export-worker-v2.js`); only tests reach v1.
      - Remove v1, or apply the same guard deliberately.
    - **The worklet's 256-event block cap, combined with per-frame ramps and publish seeds** (`PARENT-RULING-REVIEW-B6F5-STEP3-5.md`; `REVIEW-B6F5-STEP3-5.md` §10 F3; `REVIEW-B6F5-MIXER-DESIGN.md` §4 item 2).
      - `materializeSchedule` (WK:2108, WK = `public/audio-worklets/daw-portable-audio-core-host-v2.js`) materializes ramps per frame.
      - Past 256 events, a block returns `null`: the block is silent and the cursor resets (WK:2207–2214 on the design-review bytes). Two concurrent ramps already silence a block.
      - Fix: step ramps per block as native does, or raise the cap.
    - **Chromium timing of prepare, publish and install** (`PARENT-RULING-REVIEW-B6F5-STEP3-5.md`; `REVIEW-B6F5-STEP3-5.md` §10 F4; `REVIEW-B6F5-MIXER-DESIGN.md` §4 item 3). The R1 gate (adoption at 0.55 ms p50 and 1.40 ms max, against a 2.9 ms block) was measured under Bun/JSC. Measure it in the browser runner.
    - **A recording-capable fake in HT** (`PARENT-RULING-REVIEW-B6F5-STEP3-5.md`; `REVIEW-B6F5-STEP3-5.md` §10 F2).
      - The fake must answer `recording-capture-configure`, `finalize` and `cancel`.
      - Then the D6 and RC2 behaviours get hook-level witnesses: an adoption during a portable take keeps the take, and a held edit is followed after record stops. Today both rest on PBT and code reading.
    - **A clip-colour variant in the matrix probe** (`PARENT-RULING-B6F5-STEP5C.md`; `B6F5-STEP5C-REPORT.md` §9). The `B6F5PROBE` matrix lives in `/tmp`, outside step 5c's write authority. The HT witnesses cover clip colour and name with native on and off.
    - **C0 review F4, F8 and F9** (`PARENT-RULING-C0.md`; `acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-C0.md`, "Follow-ups"):
      - **F4:** `pauseDuringFlush` is proven by fixture stamps only. Either require `appliedProcessorSequence` in the resumed epoch to reach at least the preview watermark, or document that `draftRetained`, `persistedWithoutRestore` and `gainChanged` are the product-side proof.
      - **F8:** `previewFromFrame` is read right after the CDP moves are sent, before native has necessarily applied the last preview, so under load `previewApplied` can fail conservatively.
        - C0f now gates each move on the knob's `aria-valuenow` (`tools/acceptance/ae-08-phase-5-fixture.ts:99–133`). That proves the UI moved, not that native applied the move.
        - Waiting for a watermark advance would remove the false-negative risk.
      - **F9:** a dropped final `deliver` is invisible when the preview already matched; only the history entry is lost. This belongs to a later row with undo-history evidence.
    - **Already in §E and still open,** re-listed by the ruling and not repeated here: RC4 review items 1 (the duplicate fault on a refused Pause), 2 (non-live instrument edits rebuild with a gap), 6 (the stale `previewProjectionBaseline`) and 7 (Sampler zone clamping), above. For item 6, `REVIEW-B6F.md` §8 item 9 adds that a portable re-prepare does not set the baseline either (only H:792 and H:2182 do).
- **C0f, C0g and C0h review follow-ups** (`PARENT-RULING-C0F-REVIEW.md`, `PARENT-RULING-C0G-ACCEPTED.md`, `PARENT-RULING-C0H-ACCEPTED.md`).
  - Sources: F = `REVIEW-C0F.md`, G = `REVIEW-C0G.md` and Hr = `REVIEW-C0H.md`, all in `acceptance-reports/ae-08-phase-5-2026-10-18/`.
  - Files: C = `src/lib/desktop/native-playback-controller.ts`, H = `src/hooks/useTimelinePlayback.ts`.
  - Line numbers are on the manifest-7 bytes unless stated. None blocks C1.
  - **CLOSED by C0g and the parent: the clip fingerprint is order-independent and drift-guarded** (F §3.2 finding F2 and §7 item 8; G §6 item 1).
    - C0g builds the clip entry from an explicit list of 18 fields (H:2061–2067), excluding `name`, `color` and `waveformAssetKey`. Its witnesses cover undo of a MIDI clip and of a `sampleUrl` clip (mutation 516).
    - The parent's `satisfies Record<keyof Omit<Track['clips'][number], 'name' | 'color' | 'waveformAssetKey'> | 'buffer', …>` (H:2067) makes a new clip field a TS1360 compile error (`PARENT-RULING-C0G-ACCEPTED.md`). RC6 records its TS2353 rejection of mutant 513 as a second catch.
  - **CLOSED by C0g: the fixture's fixed revision, "§E:800" in the rulings** (F §7 items 2–3; G §6 item 7).
    - `tools/acceptance/b5c-playback-witness-support.ts` gained a revision accessor.
    - The C0G Timeline-composition witness ("play, delete a track, undo, Pause and Play … warm") bumps it as `rebuildPlaybackBackend` does (`C0G-REPORT.md` §10).
    - The C0F witnesses keep revision 1.
  - **CLOSED by C0g: Pause then Play cold-started after an `unchanged` adoption at a newer compile revision** (F §1.3, finding F1). C:4185–4187 gives the prepared snapshot the compile revision when the adoption's own dedupe finds the content equal (mutation 515).
  - **The latency capture can regress the compile revision** (G §6 item 2; G §1.1).
    - The route: a latency record captures its snapshot (C:4277 on manifest-7, C:4275 when reviewed) before an `unchanged` adoption at a newer revision. Its proof lands after that adoption with a changed `declaredLatencyFrames`. It then writes the older revision back at C:3644, and the next Pause then Play is cold.
    - The window is narrow (an in-flight VST latency change concurrent with a deduplicated structural rebuild), and the defect is pre-existing in kind.
    - Cheapest root fix: keep the current `preparedSnapshot.revision` when C:3644 replaces the object.
  - **A MIDI recording take publishes twice** (G §6 item 3; G §2.4).
    - The take's `midi` and `fades` are projected unnormalized (`recording-session.ts:166–188` and `midi-recording-controller.ts:117–130`, through `buildLocalClip`, `clip-create.ts:100–124`).
    - So the persisted row's fingerprint differs in content: `[]` on one side, a dropped `undefined` on the other. The second publication is inaudible.
    - Fix: normalize in `buildLocalClip`, or fingerprint the compile output.
  - **The `Timeline.tsx` wiring has no witness** (G §6 item 4). The C0G composition witness mirrors `rebuildPlaybackBackend` (`Timeline.tsx:883–895`) instead of calling it. A `Timeline.test.ts` row that drives `rescheduleChangedClips`, Pause and Play through the real component would close the gap. The packaged remove-readd-track row never pauses.
  - **The step-5b clip-field witness spells the list out a third time** (G §6 item 6; `useTimelinePlayback.test.ts` ~7754–7756). With the `satisfies` guard it could assert against a typed key list. Low value.
  - **The import witness stubs `isActiveProjectTrack`** (F §7 item 4; F §2.2).
    - `C0F a local import during native playback …` (`src/lib/timeline-audio-import-metadata-only.test.ts`) passes `() => true`.
    - A variant with the real guard (`useTimelineClipImport.ts:119–120`) and an auto-created track would pin the microtask timing.
    - The packaged add-paged-asset row now covers that route end to end (C0e, C0i).
  - **`drag-missed` and `gain-unchanged` fail the same checks** (F §7 item 5). The self-test tells them apart only by their intended-check mapping. Say so in the analyzer's comment.
  - **A decoded buffer for a removed clip stays cached** (F §7 item 6; `src/hooks/useClipBuffers.ts:242–254`, `storeWhenCurrentMissing`). It is retained until the cache clears. Pre-existing, and shared with the URL import path.
  - **The tools typecheck still has the 17 C0 diagnostics** (F §7 item 7). Unchanged through RC7 and C0j, and none is in a file C0f–C0j changed.
  - **Add a `.catch` to the Keep Latency update** (Hr §4 F1; `PARENT-RULING-C0H-ACCEPTED.md`).
    - `void nativePlayback.updateKeepLatency().then(…)` (H:353) has no rejection handler. A failed Keep Latency publication would become an unhandled rejection, and the membership would stay unpublished without any report.
    - Report the rejection through `reportNativeStopped` or the fault path.
    - After C0h, no known route throws there.
  - **Exercise `assetAudible` in the add-paged-asset admission** (Hr §4 F2; ruling). In `tools/acceptance/analyze-ae-08-continuity.ts` (~880–889 on the C0h bytes), a mutant that drops `&& trackOnlyPublication.assetAudible`, or `startFrame < endFrame`, survives the self-test. Add a defect whose final reference is silent after the asset seam, or record a mutation ID that kills it.
  - **A per-revision asset inventory in the runner** (Hr §4 F3; ruling).
    - Today's evidence cannot show an early publication that installs the asset without making it audible: no host event names assets, and `installedAssets` is read once, at the end.
    - `tools/acceptance/ae-08-live-graph.ts` should sample `native.diagnostics.installedAssets` after the import returns and for each publication. Then the oracle can require it to stay unchanged across the track-only publication.
  - **Two `structuredClone` calls protect nothing** (Hr §4 F4). C:3400 (`merged.graph`) and C:4289 (`preparedGraph`) copy graphs that are already fresh. Remove them in a later tidy of C.
  - **A bare `bun test <path>` also matches archived copies** (Hr §4 F5; ruling).
    - Without the `./`, `bun test src/hooks/useTimelinePlayback.test.ts` also runs copies under `acceptance-reports/**/reconstruct/**`, which fail to import.
    - Add a test-path exclusion for `acceptance-reports`.
    - `evidence-rc5-rc7/` holds no test files.
  - **CLOSED by RC7 and C0i: Hr §4 F6.** RC7 re-certified C, CT and the analyzer, and C0i covered effect-state packaged.
- **C0j review follow-ups** (`PARENT-RULING-C0J-REVIEW-C1.md`).
  - Sources: J = `acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-C0J.md`, A = `tools/acceptance/analyze-ae-08-continuity.ts` at `32a36cc6…9330`, T = `tools/performance/30-track/native-spool-wav.test.ts`.
  - None blocks C1.
  - **F1: the `resumedStart` lookup (T:174–177) finds a held block.**
    - The synthetic pause and resume share epoch 5 (A:1260–1261). So the lookup returns the first of 16 held blocks, not the first block that advances.
    - Two C0b witnesses are therefore weaker than their comments say: the restore is 229 ms instead of 400 ms, and the dropout lands 8192 frames early. Both still reject.
    - When T is next reopened under a ruling, look up the first epoch-5 block whose next block advances.
  - **F2: `resumeBoundaryBounded` reads the reference unshifted** (A:1080–1084; parent note 2).
    - The compensated reference is 512 frames later. On C0i the bound is the same either way.
    - The fix is one line: read `leftReference.samples[(frame + state.fromLatencyFrames) * channels]`.
  - **F3: residual cold signs** (A:1165–1168 and A:1076–1079).
    - A lone `capture-configure` just outside the warm window passes both checks. That cannot pass in the product, because `native/audio-host-macos/src/acceptance-output-tap.h:29–47` starts a new capture.
    - `host-suspend-request` (`apps/desktop/audio-host.ts:3268`) matches neither regex. Add `suspend` to both.
    - An event without `wallMs` is invisible to both checks. No real event lacks it.
  - **F4: the substring regexes over-reject**, in the safe direction. `worker-supervisor-started` (`native/audio-host-macos/src/audio-host.cpp:2151`) matches `start`, so it would fail a genuine warm resume in a row that has a VST3 worker.
  - **F5, a recorded limit:** `resumedEarlyGain` cannot see a restore shorter than about 134 ms after resume. Its region starts at `resumeGuard + toLatencyFrames` (A:1149–1150). This is the C0b design.
  - **CLOSED: F6 and F7.**
    - F6: the ruling regenerated `/tmp/dv01-c0j-parent/parent.diff` with all 4 hunks.
    - F7: `C0J-REPORT.md` §3's "25 defects" is cosmetic. The final analyzer has 26 effect-state defects.
- **Recorded decision: exports apply full delay compensation** (`PARENT-RULING-C0I.md` item 2; `C0I-PACKAGED-REPORT.md` §4.4; `REVIEW-C0J.md` Q3).
  - Live playback with the Spectral track armed keeps that track's latency out of compensation: Keep Latency, for monitoring (`native-playback-controller.ts:764–772`, `:2069–2070`).
  - The offline export always compensates fully (`packages/audio-engine/src/mixer/apply-offline-routing.ts:169, 213–216`). So it delays the effect-free left track by the Spectral latency: 512 frames before the edit and 4096 after, as `packages/shared/src/spectral-params.ts:105–109` gives.
  - This matches Ableton: reduced-latency monitoring affects live monitoring only, and a render is fully compensated.
  - No product change. `retainedLeftExact` compares against each reference shifted by its own derived compensation.
- **C1a review follow-ups** (`acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-C1A-ACCEPTED.md`, ruling 5; details from `acceptance-reports/ae-08-phase-5-2026-10-18/REVIEW-C1A.md` §6). Bare line numbers are in `tools/acceptance/analyze-ae-08-continuity.ts` at analyzer `a5c4f5ff…7761`.
  - **Lost-lower blind spot (pre-existing).**
    - A lower never shifts the retained channel, so a lost lower with any substitute publication in its place passes (§3.2 case B); the entry analyzer had the same gap.
    - The edited right path is only energy-checked (`:724–727`).
    - Candidate fix: after each lower, measure the right channel's content delay against the left as `monitoredContentDelay` does for keep-latency (`:728–731`), expecting the group's `toLatencyFrames`.
  - **`overlappingMoveWaitsForCompletion` (`:783–785`) in the merged shape.**
    - It no longer tests what its name says. `publications[1]` is now the first lower, which trivially follows the first completion.
    - Either rename/redefine it for the merged shape (e.g. "no publication between the first `graph-publish` and its `latency-move-complete`"), or make it vacuous only when the first turn is merged.
  - **Mixed-group total formula (`:463–464`).**
    - `raiseFrames` sums each edit's positive move. For a turn containing both a raise and a lower, the product's pinned budget moves by `max(0, last.to − first.from)`, not by the sum of the raises.
    - No current fixture has such a turn; align the formula before one does.
  - **Runner comment out of date (`tools/acceptance/ae-08-live-graph.ts:396–397`).**
    - The comment reads "Distinct processors prevent same-instance coalescing".
    - It is out of date, as ruling item 1 and the worker's note 3 say. Runner edits were out of C1a's scope.
  - **Document the cross-turn strictness (§3.3).**
    - If a future fixture places edits closer than a compile duration, the oracle will FAIL the row even though the audio is right.
    - Acceptable for certification. Document it next to the comment at `:446–449`.
- **FAST-CERT follow-ups** (`acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/PARENT-RULING-FAST-CERT-VALIDATED.md`, items 2 and 5).
  - **Remove the fixture Convex websocket network dependency from `rc1-i4-consumers` (item 2).**
    - Until it is removed, a parallel job that fails only with the exact known fixture Convex websocket network error is rerun alone. The failing attempt stays in the result, and the rerun must meet the unchanged expectation.
    - Any other failure text is never rerun.
  - **The product overlay does not reach `bun x` and `bun run` programs, or spawned children (item 5).**
    - The in-memory product overlay does not reach `bun x` or `bun run` programs, or spawned children.
  - **The freeze is strict about writes under `tools/certification/` and `acceptance-reports/` (item 5).**
    - The freeze fails on any write under `tools/certification/` or `acceptance-reports/` during a run, so workers must not write there while it runs.
- **AE-08 phase 5 follow-ups** (RC-P5b and RC-P5c, 2026-11-11; `acceptance-reports/ae-08-phase-5-2026-10-18/PARENT-RULING-RC-P5C-CERTIFIED.md`, `RC-P5C-REPORT.md` §4 and §7, `REVIEW-RC-P5B-FIXES.md`, `REVIEW-P4.md`). None blocks phase 5 or C1.
  - **Watch: phase 4 total p99 is 59.94 ms, against the 60 ms limit.** Max is 63 ms, against 70 ms. RC-P5b measured 56.84 ms. The gate passes by 0.06 ms (`RC-P5C-REPORT.md` §7).
  - **Watch: `remove-readd-track` asset publications take 82–91 ms, against the 100 ms limit.** All three final runs fell in that band (`rc-p5b/fixes/P3-FIX-REPORT.md` §6). The P3 fix does not touch this cost.
  - **`manifest-7a` is stale for 12 of 62 files** (`RC-P5C-REPORT.md` §4). The freeze uses the start snapshot as its baseline. The parent must decide whether to re-freeze the manifest.
  - **The paging runner has 16 pre-existing tsc errors** under `--strict`. P4 added none (`rc-p5c/fixes/P4-FIX-REPORT.md`, Validation).
  - **The paging runner selects its live capture by size, not by playback epoch.** `tools/acceptance/native-instrument-paging-packaged.ts:619–625` takes the largest completed capture. Restrict the choice to the playback epoch, as r27 does (`REVIEW-P4.md`).
  - **No tsconfig covers `tools/`.** `tools/performance/30-track/native-spool-wav.test.ts` has 2 pre-existing type errors (`:85` and `:89`, `offset` missing), and no gate sees them (`rc-p5b/fixes/P2-FIX-REPORT.md`, Typecheck). This is the same gap as the B6 re-certification F5 item above.
  - **P2 quality is measured over the whole WAV, not the Play window, and `wallMs` is drain time.** Earlier audible sound in a capture can mask a later silent interval. Restrict the quality check to the Play window, and use callback timestamps, before any new caller (`REVIEW-RC-P5B-FIXES.md`, P2 assessment).
  - **Cold, far-rebased LAT1 timing is unmeasured.** The certified runs had 0 rebases. No run has measured a cold start followed by a far rebase.
  - **`sampler-buffer-sync.ts` H2 is unproven.** A `clearTrack`, or a first sync after a project reload, that lands after `ready` would erase native readiness. The P1 fix does not cover this beyond the next resume. Capture the ordering if the pane sticks on `loading` again (`rc-p5b/fixes/P1-FIX-REPORT.md`; `REVIEW-RC-P5B-FIXES.md`, H2).
  - **Two standing hook reds need attribution.** `src/hooks/useTimelinePlayback.test.ts` at `:2757` and `:4218` fail on `activeBackend` and `isPlaying`. They match the known reds by name and message, but are not yet mapped to those lines (`rc-p5b/fixes/P1-FIX-REPORT.md`, `P1-B1-FIX-REPORT.md`).
  - **Optional: a controller foreign-owner witness.** Not written.
  - **`asset-install` evidence records the request, not the success, and has no revision identity** (`apps/desktop/audio-host.ts:2874,2892`). That is enough for the serialized path. Cancellation, retry or overlapping publications need the success and the owning candidate (`REVIEW-RC-P5B-FIXES.md`, P3 evidence).
  - **Phase 4 has a negative block phase.** One publication measured −3 ms in the re-judge. Block phase is diagnostic only, so inspect it before anyone gates on it (`rc-p5b/fixes/LAT1-PREP-OVERHEAD-REPORT.md`, Correction).
  - **Pre-existing `as const` tuples sit in the controller's dirty hunks** (`native-playback-controller.ts`). The repo rule says never use `as`. Clean them in a separate change, not inside phase work.
  - **The hash path needs a worker and a large-file benchmark.** 64 KiB slices mean 16,384 yields per GiB. The import hash went from about 413 ms to 432 ms, about 4.6%, and no large-file or concurrent-import benchmark exists. A dedicated hash worker would move the hashing off the renderer. Benchmark it before claiming headroom (`REVIEW-RC-P5B-FIXES.md`, P3).
