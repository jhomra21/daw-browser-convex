# Ruling: Solid 2 bless (branch solid-2)

Ruled by the owner on 2026-11-22, on the evidence of FAST-CERT bless runs 2 and 4 (`/tmp/fast-cert/s2-bless2`, `/tmp/fast-cert/s2-bless4`).

## 1. Hook seed rejection records (accepted)

Seeds 51, 127, 319, 350, 543 and 767 of the hook fuzz pass before and after. Each gains or loses one `latency|cancelled|ending-transport-domain` rejection, a cancelled settlement that the B6 gate never counts.

- 127, 319, 543, 767: commit 9cf4e211 retries a paused Play whose schedule coordinator an edit adoption replaced during its compile. Solid 1 reported "Native audio playback is unavailable." and settled the Play in the ending domain; the Play now starts.
- 51, 350: Solid 2's microtask batching reorders a compile or a loop settlement against a transport command. Not traced step by step.

Recorded with `--allow-rejection hook:<seed>:latency|cancelled|ending-transport-domain` for each seed.

## 2. rc2:432 retired as "no witness" (accepted)

`rc2:432:0:mutant` turns `if (!relocated) setIsPlayPending(false)` into `setIsPlayPending(false)`. Under Solid 2 the mutant's `false` and the replayed Play's `true` are written in the same turn and apply together at the flush, so no reader sees the dip: a memo over `isPlayPending` records `[false, true]` on both builds, and no engine or session call sits on the line. `rc2:432` joins `noWitnessRows` in tiers.ts, and the diagnostic pair `diag:419:419-plus-432`, whose discriminating half was 432, joins `noWitnessArms`. Both are listed in test-debt.md.

## 3. x-probe160 ported to Solid 2 (accepted)

The archived probe `rc5/tools/dv01-b6f5-step5b/probe160-adoption.ts` imported `batch`, which Solid 2 removed, so the gate ran 1 of 160 tests. The port drops the import and adds `flush()` where the 1.x writes ran their effects synchronously: after `setGeneration` in the project routes (one flush per write, the batched order once after both), after the edit that precedes the Timeline's resuming rebuild, and before the probe reads the playhead the hook just wrote. The reference hash in expectations.json is re-recorded. With the port the gate matches its recorded judge: 159 pass, the one known-red `B6FPROBE lifecycle suspended-ready`.

## 4. Device control cost rows after the project-switch guard (accepted)

The `dp` gate's results.json moved under Solid 2 (376 differences from the Solid 1 output, which a fresh run on convex-1-51 reproduces). Two changes bring it to 77 differences on 7 rows:

- The harness flushes after each input. A browser runs pending microtasks after each input event's listeners return; the harness dispatched a whole burst synchronously, so Solid 2 key and wheel steps all read the same stale value. With the flush every burst row matches Solid 1.
- `useEffectsPanelAudioSync` reads the local effects view only when it belongs to the current project. After a project switch its compute read the new project id with the previous project's rows, marked the new project synced, and then skipped clearing the old chains from the legacy engine.

Accepted remaining rows:
- compressor, delay and eq `generation-bump-mid-gesture` (legacy): the equal single-instance delivery joins the in-flight chain re-apply instead of being skipped, because Solid 2 starts the re-apply after the flush microtask. The submissions are the same.
- drum-rack and synth `project-switch-mid-gesture` (legacy and native): Solid 2 now clears the old project's track and master state, as effect devices already did on Solid 1. Solid 1 instead installed the old project's committed row under the new project's key, the stale read the guard removes. `engineHeldFinal` records the last tracked sync, which a clear does not reset.
