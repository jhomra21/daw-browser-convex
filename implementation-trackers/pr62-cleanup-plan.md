# PR #62 cleanup plan

Branch `production-dsp-characterization`, head `0a3d1585937bfa86b1ebd59ac1751e7d200fe3bb`, [PR #62](https://github.com/jhomra21/daw-browser-convex/pull/62), base `origin/master` (merge base `7a8e9a0c`).

Inputs: `/tmp/pr62-cleanup/synthesis.md` (cited as **S§n.m**) and `/tmp/pr62-cleanup/reports/*.md` (cited by file name, e.g. `untangle-native`). Every file:line below was re-read at head unless marked **verify**. Line numbers are starting points; a worker re-reads before editing.

Goal: fix every bug in S§1, apply every untangle decision-log fix (S§2), remove dead and test-only code, clean the tests (S§3) and the comments (S§4). Product behavior stays the same except for the bugs fixed.

Rules that apply to every phase (from `AGENTS.md`, `AGENTS-solid.md`, `~/.factory/AGENTS.md`):

- No `as` casts. `type` over `interface`. Functional style, explicit inputs and outputs.
- No new `setTimeout`, `setInterval`, `requestAnimationFrame` or polling unless a code comment justifies it and cleanup is deterministic.
- A helper with one consumer is shaped around that call site. No generic-looking re-export surfaces.
- One concern per commit. Refactor phases move code and do not change behavior; bug phases change behavior and do not move code.
- Use `bun`. Never start the dev server. Do not write unit tests after the code: for a bug phase, write the failing behavior test first (list the ways it can fail), then the fix.
- Comments: delete comments that restate the code; keep comments about an external constraint (SDK rule, OS behavior, realtime rule, wire format). Never reference the PR, a phase label or a reviewer in a comment.

---

## 1. Redesign summary

Eight root fixes remove most of the findings. Each answers the untangle question "should these pieces change together?".

| # | Root fix | Findings it removes | Phases |
|---|---|---|---|
| R1 | Acceptance, benchmark and fuzz observation is an optional observer created at each composition root. Product modules never read `process.env.DAW_AE08_*`, `window.dawDesktop.ae08Mark` or `globalThis.__daw*` themselves, and an observer can never throw into or gate a product path. | S§2.1 (all four untangle reports), bug 13 | P05, P13, P22, P30 |
| R2 | One native publication transaction runner. The publication record is private to `native-processor-state-owner.ts`; the controller sends commands and reads observations. `Execution` is a discriminated union. | S§2.2 (`executePublication`), S§2.6, `thermos-srclib-quality` 1 and 2 | P31 to P35 |
| R3 | One native request broker in the desktop supervisor: a discriminated pending request, one admission path, timeout policy named per request kind. | S§2.2 (`audio-host.ts`), S§2.6, S§2.7 request broker policies | P16, P17 |
| R4 | One desktop recording session owner (admission, binding, completion, release) with one release schema and an atomic manifest writer. | S§2.2 (`main.ts`), S§2.4 `spoolReleaseSchema`, bug 4 | P11, P18, P19 |
| R5 | The native host is the authority for VST attachment reuse. The desktop ledger records what was requested and what the host confirmed. The test-only revision coordinator is deleted. | bugs 2 and 8, S§2.4 parking limits and `loadKey`, S§2.5 | P12, P14, P15 |
| R6 | One effect-chain update transaction shared by the track and master runtimes; routing and metering stay as adapters. | S§2.3, `thermos-ui-quality` 1 | P25 |
| R7 | Each cross-module contract has one definition: graph wire view, processor kind ids, synth live fields, PCM metadata validation, recording spool format, plug-in fault classes, graph-revision offsets. | S§2.4 | P07, P21, P26, P42, P50 |
| R8 | Tests execute behavior through a real entry point. Source-text tests, AST extraction harnesses and private-state witnesses are rewritten or removed. | S§3 | P09, P10, P20, P27, P46 to P49 |

### Target module boundaries

Arrows point from the dependent to the dependency. Nothing on the right may import anything on its left.

```
tools/acceptance, tools/performance  (runners, fixtures, analyzers)
        │ implement / read
        ▼
acceptance observers (one per layer, created only at a composition root)
  apps/desktop/ae08-evidence.ts            -> NativeHostObserver, RendererMarkSink
  src/lib/desktop/ae08-marks.ts            -> PlaybackAcceptanceObserver
  native/audio-host-macos/src/acceptance-observer.h (owns tap, publication snapshot, report)
        ▲ optional, injected
        │
composition roots: apps/desktop/main.ts, apps/desktop/preload.ts,
                   src/components/Timeline.tsx, native/audio-host-macos/src/main.cpp
        │ construct
        ▼
UI owners (src/components, src/hooks)
        ▼
playback orchestration: src/hooks/useTimelinePlayback.ts
        ▼
src/lib/desktop/native-playback-controller.ts  (orchestration only)
   ├─ native-publication-transaction.ts   (NEW: admission, proof loop, rollback, termination)
   ├─ native-schedule-publication.ts      (NEW: schedule resource staging and promotion)
   ├─ native-processor-state-owner.ts     (owns Execution and the publication record)
   └─ native-schedule-coordinator.ts, native-timeline-page-manager.ts
        ▼
packages/audio-engine  (effect-chain-transaction.ts NEW, native-host-wire.ts owns revision offsets)
        ▼
packages/shared, packages/audio-core-contract (generated processorRegistry), packages/desktop-protocol
        ▼  IPC
apps/desktop/main.ts (thin IPC adapter)
   ├─ recording-session-owner.ts          (NEW) -> recording-spool.ts
   ├─ native-request-broker.ts            (NEW) <- audio-host.ts (supervisor)
   └─ native-vst3-coordinator.ts (ledger + preflight) , native-vst3-host-events.ts (NEW, split)
        ▼  stdio frames
native/audio-host-macos (AudioHost) -> graph view decoder from native/audio-core -> audio core
```

Dependency rules the cleanup enforces:

1. `packages/*` and `src/lib/**` never import from `src/components/**`. Today `native-built-in-parameter-mapper.ts:2` and `portable-browser-playback-controller.ts:46` do.
2. Live playback (`src/lib/live-playback-snapshot.ts`) never imports from `src/lib/export/run-export-job.ts`. Both import a new neutral desired-state module.
3. No product module imports a module whose only purpose is acceptance evidence, except a composition root.
4. Test fakes live outside `src/` of a package (`packages/audio-engine/src/fx-runtime-test-audio.ts` moves).

---

## 2. Certification procedure (applies to every phase that names it)

Read before any phase: `tools/certification/fast-cert.ts` (header), `rebase.ts`, `bless-rules.ts`, `expectations.ts`, `tiers.ts`, `test-baseline.ts`, `test-debt.md`.

Facts that constrain refactors:

- `tools/certification/expectations.json` holds 980 mutation arms and 62 gates. An arm applies `spec.changes[]` (`file`, `from`, `to`) through `product-overlay.ts`. `from` must occur **exactly once** in the file whose path ends with `file`, or the arm fails with `Overlay requires one exact anchor`. Anchors include comment text.
- Anchored product files and arm counts: `src/hooks/useTimelinePlayback.ts` 578, `src/lib/desktop/native-playback-controller.ts` 298, `src/lib/desktop/native-processor-state-owner.ts` 136, `src/lib/portable-browser-playback-controller.ts` 66, `src/components/timeline/parameter-gesture-owner.ts` 8, and 2 to 4 each in `create-timeline-effect-commit.ts`, `create-effects-panel-state.ts`, `Timeline.tsx`, `packages/audio-engine/src/native-host-wire.ts`, `src/lib/timeline-audio-import.ts`, `public/audio-worklets/daw-portable-audio-core-host-v2.js`.
- Watched hashes: 45 `manifest.entries` plus `fuzzSources.controller` and `fuzzSources.hook` (these include `apps/desktop/audio-host.ts`, `native/audio-host-macos/src/audio-host.cpp`, `create-processor-edit-registry.ts`, `live-playback-snapshot.ts`, `native-host-wire.ts`, and every `tools/acceptance/ae-08-processor-state-fuzz*.ts`). A drifted hash only selects the tier and jobs. Hashes move only on `--bless --full` (final phase).
- The paired `--rebase … --revert` run cannot be used on this tree (most watched files have drifted from the recorded base; record 50 says so). All recent records are **hand records**, `evidence.mode: "anchor"`.
- `bless-rules.ts` B2: a test count may rise. A count may not fall, a skip may not appear, a control or gate failing set may not move, a mutant must stay killed, native ctest totals (`x-test-native` 17, `x-host-ctest` 7) may not fall. A removed test needs a manifest in `tools/certification/removals/` that cites an existing ruling file; a killer test (named in an arm's `expect.fails` or a gate's `judge.fails`) can never be removed; a deleted test file and a test moved between files are not admissible through the manifest and are proved by a direct name-diff in the hand record (as record 50 did).
- Killer tests that S§3 asks to rewrite (they must keep their exact name and still fail their mutants): `B6a1 retained schedule candidate survives latency and processor-patch promotions` (rc2:257:0, rc2:259:0), `B6a1 structural replacements discard retained schedule candidates` (rc2:260:0), `B6f5 A a mixer, master, automation or instrument edit while playing is adopted by the playing portable session` (ledger:482, ledger:490), `C0G the clip fingerprint names every clip field a playback compile reads, and no name, colour or waveform key` (ledger:502, ledger:509, rc2:404:1), and both `B5c3 known-red simultaneous release …` tests (gates `f-strict-history`, `rc1-i5-strict-history`, recorded as 2 fails).
- `x-wasm-source-hash` pins the hash of `native/CMakeLists.txt`, `native/audio-core/CMakeLists.txt`, `audio_core.h`, `graph_latency.h`, `processor_contract_generated.h`, `audio_core.cpp`, `wasm_entry.cpp` (`native/audio-core/scripts/portable-wasm-source-hash.ts`) and the wasm artifacts. **Any edit to those files, a comment included, needs a wasm rebuild and a re-pin** (record 28 is the precedent). Batch `audio_core.cpp` edits.
- Fuzz seeds are judged by invariants and native-count ceilings (`seed-records.json`). A refactor must keep the native call sequence identical, or seeds move and need `record-seeds.ts` plus a ruling.
- `tools/certification/test-baseline.json` lists 7 known-red tests in 3 files. None of them is touched by this plan unless a phase says so.

### CERT recipe (run by the worker of a phase that touches an anchored, watched or witness file)

1. Record the phase base: `BASE=$(git rev-parse HEAD)` before the first edit.
2. Build the job list: every non-retired arm (`retiredArms` in `tiers.ts`) whose `targets`, `witnesses`, `spec.changes[].file` or fixture `fuzzSources` include a touched file, plus every arm of the same row and its control, plus the gates whose command names a touched test file. Previous rounds used a throwaway script (`/tmp/merge-arms.ts`); P00 adds it as `tools/certification/arms-for.ts`. Job ids are `arm:<id>` and `gate:<name>`.
3. Measure, one job at a time: `caffeinate -dimsu bun tools/certification/fast-cert.ts --only <ids> --jobs 1 --base-commit $BASE --out /tmp/fast-cert/<phase> --measure /tmp/fast-cert/<phase>-measure.json`. Split lists over about 170 ids into several runs.
4. Every arm that fails with `Overlay requires one exact anchor`: re-point `spec.changes[].from` and `to` (and `file` and `targets` when the code moved to another file) so the mutation keeps its meaning. Check each re-pointed arm by applying its changes in order to the file text. Re-run only those arms with their controls.
5. Run the same list again without `--measure` (judged). Required result: `PASS`, `failing (0)`, freeze held.
6. If nothing moved, write no record. Otherwise write the hand record `tools/certification/rebases/<name>.json`: `name`, `sequence` (number of files in `rebases/` plus one; 61 is next), `createdAt`, `revert: []`, `watched: []`, `changes: [{ path, old, new }]`, `seedRecordChanges: []`, `evidence: { mode: "anchor", reason, expectationsSha256 }` where the hash is of `expectations.json` before the change. `reason` states the tree, the job list, what moved and why, in the style of records 53 to 60.
7. Apply it with `applyRebase` from `tools/certification/expectations.ts` and write `expectations.json` as `JSON.stringify(value, null, 1) + "\n"`. Verify that `applyRebase(expectations at $BASE, record)` equals the new file byte for byte. Never edit `expectations.json` by hand.
8. `bun tools/certification/bless-rules.ts` must exit 0.
9. Commit the record separately: `test(certification): hand record <n>, <what moved> (PR 62 cleanup <phase>)`.

Record ownership: only one worktree at a time may write `expectations.json`, `rebases/` or `removals/`. Phases in parallel groups that move a gate count (for example `rc1-i6-desktop` 430/1/0 or an `f-engine` file) do **not** write a record; they report the moved count and the parent writes one integration record after merging the group (phases P24, P29, P45).

### Validation recipes (exact commands; phases cite them by id)

FAST-CERT sets `VITE_CONVEX_URL=https://fixture.convex.cloud VITE_API_BASE_URL=http://localhost:8787`; export both for manual runs.

| Id | Command |
|---|---|
| V-TS | `bun run typecheck` (packages, root, api and `bun tools/typecheck.ts` against `tools/tsc-baseline.txt`; no new diagnostic) |
| V-LINT | `bun run lint`; the summary line must equal `gates / name=g-lint / judge / found` in `expectations.json` (`Found 17 warnings and 5 errors.`) with no new diagnostic |
| V-DESKTOP | `bun test --conditions=browser --timeout 30000 apps/desktop` |
| V-HT | `bun --conditions=browser test --timeout 30000 src/hooks/useTimelinePlayback.test.ts` |
| V-C | `bun test --conditions=browser --timeout 30000 src/lib/desktop/native-playback-controller.test.ts src/lib/desktop/native-built-in-parameter-mapper.test.ts src/lib/desktop/native-live-playback-processors.test.ts` |
| V-COORD | `bun test --conditions=browser --timeout 30000 src/lib/desktop/native-schedule-coordinator.test.ts src/lib/desktop/native-timeline-page-manager.test.ts src/hooks/useTimelineProjectionState.test.ts packages/audio-engine/src/native-host-wire.test.ts` |
| V-PB | `bun test --conditions=browser --timeout 60000 src/hooks/pointer-gesture-ownership.browser.test.ts src/lib/desktop/native-playback-lifecycle.browser.test.ts` (needs `agent-browser` and Chromium) |
| V-PORT | `bun --conditions=browser test --timeout 30000 src/lib/portable-browser-playback-controller.test.ts` |
| V-SYNC | `bun --conditions=browser test --timeout 30000 src/hooks/useEffectsPanelAudioSync.test.ts src/components/timeline/create-persisted-effect-state.test.ts src/components/timeline/create-effects-panel-audio-effects-state.test.ts src/lib/shared-outbox.test.ts` |
| V-BUF | `bun --conditions=browser test --timeout 30000 src/lib/instrument-buffer-sync.test.ts` |
| V-ENGINE | `bun --conditions=browser test --timeout 30000 packages/audio-engine/src` (run `packages/audio-engine/src/portable-wasm-host.test.ts` alone afterwards; it has wall-clock budgets) |
| V-CONVEX | `bun test --conditions=browser --timeout 30000 convex` |
| V-NCORE | `sh native/audio-core/scripts/test-native.sh` (must end `100% tests passed out of 17` or more) |
| V-NHOST | `(cd native && cmake --preset audio-host-macos-debug) && cmake --build native/build/audio-host-macos-debug -j 6 && ctest --test-dir native/build/audio-host-macos-debug --output-on-failure` |
| V-NPLUG | `bun tools/acceptance/run-ae08-test-plugin.ts` |
| V-RTG | `bun --conditions=browser test --timeout 30000 native/audio-host-macos/tests/realtime_callback_guard.test.ts` |
| V-WASM | `bun run build:portable-wasm && bun run validate:portable-wasm && bun native/audio-core/scripts/portable-wasm-source-hash.ts && bun --conditions=browser test --timeout 30000 native/audio-core/tests/wasm_artifact.test.ts native/audio-core/tests/portable-wasm-validation.test.ts native/audio-core/tests/validation_scratch.test.ts` then `bun --conditions=browser test --timeout 30000 packages/audio-engine/src/portable-wasm-protocol.test.ts packages/audio-engine/src/portable-wasm-worklet.test.ts packages/audio-engine/src/backends` |
| V-BUILD | `bun run build` |

---

## 3. Phases

Complexity: **routine**, **complex**, **high-risk** (concurrency or realtime). Tracks: **N** native C++, **D** desktop backend, **X** Convex, **A** audio-engine package, **L** `src/lib` and UI outside the playback core, **K** playback core (anchored files), **T** renderer tests.

### P00. Baseline, tooling and rulings (routine, track K)

- Goal: a recorded green baseline, the arm-selection tool, and the ruling file the removal manifests cite.
- Closes: nothing; precondition for all CERT steps.
- Create `tools/certification/arms-for.ts` (prints `arm:`/`gate:` ids for a list of repository paths, using `expectationsSchema`, `retiredArms`, the row siblings and controls rule of CERT step 2). Create `acceptance-reports/pr62-cleanup/BASELINE.md` (counts of V-HT, V-C, V-COORD, V-DESKTOP, V-ENGINE, V-CONVEX, V-NCORE, V-NHOST, V-PB, V-TS, V-LINT at head; line counts of the files in section 6) and `acceptance-reports/pr62-cleanup/PARENT-RULING-PR62-TEST-CLEANUP.md` (the user's decisions from section 5, written by the parent, not the worker).
- Must not change: any product or test file.
- Risks: baseline suites may already differ from the recorded expectations (records note counts above RC7). Record what is observed; do not fix here.
- Validation: every recipe in the table once; `bun tools/certification/fast-cert.ts --plan`.
- Done when: `BASELINE.md` lists every count, `arms-for.ts src/hooks/useTimelinePlayback.ts` prints the same arm set a manual filter of `expectations.json` gives, V-TS passes.
- Commit: `chore(certification): arms-for lists the arms and gates that reach a path, and the PR 62 cleanup baseline`

### Track N: native

#### P01. Guard the VST attachment map between the control and schedule threads (high-risk, N)

- Goal: `DrainScheduleProgress` never iterates `native_vst_attachments` while the control thread inserts, extracts or erases.
- Closes: S§1.1; `thermos-native-bug` 1.
- Files: `native/audio-host-macos/src/audio-host.cpp` (`DrainScheduleProgress` 5390-5399, `AttachNativeVst` 5451-5483, `ReclaimRetiredNativeVsts` 2455-2469, every other structural mutation of the map, found with `rg -n 'native_vst_attachments\.(emplace|insert|erase|extract|clear)'`), `native/audio-host-macos/tests/audio_host_test.cpp`.
- Shape (recommended, smallest): the control thread publishes the credit total, the schedule thread reads one atomic.

```cpp
// Impl
std::atomic<std::uint32_t> automation_credit_total{0};
void PublishAutomationCredits();  // control thread; called after attach, detach, reclaim, bank swap and segment writes

// DrainScheduleProgress
const auto automation_credits = impl_->automation_credit_total.load(std::memory_order_acquire);
```

  If the used count changes on the callback (verify where `automation.count` is written), use instead a `std::mutex` that only the two non-realtime threads take, around the loop and around each structural mutation. The audio callback must never take it.
- Must not change: `ScheduleProgress` wire layout, parking and retirement semantics, the absence of a `graph_prepared` guard (live attach stays).
- Risks: a stale credit total after a path that mutates banks without republishing. List every writer of `automation_banks[*].count` first.
- Test first: a stress test in `audio_host_test.cpp` that attaches, replaces and reclaims while a second thread calls `DrainScheduleProgress`, built with ThreadSanitizer in a `/tmp` build directory (`-DCMAKE_CXX_FLAGS=-fsanitize=thread`). It must report the race at head.
- Validation: the TSan build of the new test, V-NHOST, V-NPLUG, V-RTG, CERT for `native/audio-host-macos/src/audio-host.cpp` (it is a controller fuzz source).
- Done when: TSan is clean on the new test, ctest total is 7 plus the new registration or unchanged, V-RTG passes.
- Commit: `fix(native): the schedule thread reads a published automation credit total, never the attachment map the control thread edits`

#### P02. Instrument batch validation has no side effect (complex, N)

- Closes: S§1.10; `thermos-native-quality` 3.
- Files: `audio-host.cpp` around 3096-3170 (the `configure(target_core, validate)` lambda) and `RetainAsset` 1963.
- Shape: decode the batch into typed candidates without mutation, validate all, then commit (retain assets, lock memory, apply).

```cpp
struct InstrumentCandidate { /* decoded target, asset slots, config */ };
std::optional<std::vector<InstrumentCandidate>> DecodeInstrumentBatch(std::span<const std::uint8_t>) const;  // no mutation
void CommitInstrumentBatch(const std::vector<InstrumentCandidate>&);                                         // cannot fail
```

- Must not change: accepted and rejected inputs, the reply bytes.
- Test first: a batch whose first instrument is valid and second invalid; assert the first asset's pending retirement is still pending after the rejection.
- Validation: V-NHOST, V-NPLUG, CERT (`audio-host.cpp`).
- Done when: no `RetainAsset` call is reachable in validate mode (the boolean mode is gone) and the new test passes.
- Commit: `fix(native): a rejected instrument batch no longer cancels the retirement of the assets it named`

#### P03. Revalidate effective latency after spectral padding (high-risk, N)

- Closes: S§1.9; `thermos-native-bug` 2.
- Files: `native/audio-core/src/audio_core.cpp` 7036-7048 (padding added), validator 1627-1661, tap history size 4075-4087.
- Shape: after `paths[node]` and the read-head delays are computed with retained compensation, apply the same capacity check the validator uses and return the validator's rejection without touching the live graph.
- Must not change: accepted graphs that fit, the portable (wasm) behavior for graphs that fit.
- Test first: the reviewer's sequence (external latency 60,000 with FFT 4,096; lower to 512 while running; raise external latency to 64,000) through the public prepare API in `audio_core_test.cpp`; expect a rejected prepare and an unchanged live graph.
- Validation: V-NCORE, V-WASM, then re-pin `x-wasm-source-hash` (gate index 60: `judge.value` and the three `judge.files`) and the watched `audio_core.cpp`, wasm and manifest entries stay for the final bless. CERT with `gate:x-wasm-source-hash,gate:x-test-native,gate:x-wasm-artifact,gate:x-validate-wasm,gate:x-portable-wasm`.
- Done when: the new test passes, wasm rebuilt and validated, hand record written.
- Commit: `fix(audio-core): a prepare whose path exceeds the tap history once spectral compensation is added is rejected`

#### P04. An I/O-changed restart re-reads the plug-in's buses (complex, N)

- Closes: S§1.11; `thermos-native-bug` 3.
- Files: `native/plugin-host/src/vst3-worker.cpp` 1202-1243 (`ReactivateComponent`), bus capture in `ConfigureTransport` 848-867.
- Shape: on `kIoChanged`, while inactive, re-enumerate buses with the code `ConfigureTransport` uses (extract one function), and if the arrangement no longer fits the transport, fault the instance instead of resuming.
- Must not change: the restart path for `kLatencyChanged` and parameter restarts; host behavior at `audio-host.cpp` 4612-4618.
- Test first: extend the AE-08 test plug-in (`native/plugin-host/test-plugin`) with an I/O change mode, and a worker test that expects a fault notification (see decision U2 for where it registers).
- Validation: `ctest` for `daw-plugin-host-worker-test` in the host build directory, V-NPLUG, V-NHOST.
- Commit: `fix(plugin-host): a kIoChanged restart re-reads the bus arrangement and faults an instance that no longer fits its transport`

#### P05. Native acceptance observer (complex, N)

- Goal: `AudioHost::Impl`, the worker runtime and the core hold no acceptance state; one observer owns it and is absent when evidence is off.
- Closes: S§2.1 native items; `untangle-native` decision 1 and decision 6 (bridge events).
- Consumers found (so isolate, do not delete): `tools/acceptance/ae-08-prepare-split.ts`, `ae-08-phase-9-matrix.ts`, `ae-08-live-graph.ts`, `analyze-ae-08-continuity.ts`, `native-instrument-paging-packaged.ts`, `packaged-r27-regressions.ts`, `ruler-seek-packaged.ts` read the native evidence files.
- Files: create `native/audio-host-macos/src/acceptance-observer.h` (owns `AcceptanceOutputTap`, the `acceptance_*` atomics at `audio-host.cpp` 1394-1437, the report formatting at 1440, the observed epoch and sequence state at 2212-2223). Change `audio-host.cpp` so the publication snapshot stores at 5848 run only `if (observer)`; name bridge event bit 7 and use one dispatch function for the normal drain (2195) and the shutdown drain (2242, 6221). `native/acceptance-evidence.h`: the directory is read once in `main.cpp` and passed down; `native/plugin-host/src/worker-runtime.cpp:237` forwards the value it was given. `audio_core_native.h:48-58` and `audio_core.cpp:6833`: keep `SetPrepareProfiling` and `LastPrepareProfile` (used by `ae-08-prepare-split.ts`), delete the portable no-op implementation if the wasm entry does not need the symbol (**verify** `wasm_entry.cpp`).

```cpp
class AcceptanceObserver {            // constructed in main.cpp only when the evidence directory is set
 public:
  void PublicationCommitted(const PublicationSnapshot&);
  void DrainTap();
  void ReportPrepare(std::span<const daw::audio_core::PrepareStepTime>);
};
// AudioHost::Impl
AcceptanceObserver* observer = nullptr;   // not owned
```

- Must not change: the evidence file names and JSON fields the runners parse, realtime callback code paths (the tap write on the callback stays lock-free), stereo-only tap (document it at the type, do not generalize).
- Risks: `realtime_callback_guard.test.ts` pins source text of this area; it is rewritten in P09. Run P05 after P09, or update the guard here.
- Validation: V-NHOST, V-NPLUG, V-RTG, V-NCORE and V-WASM if `audio_core.cpp` changed, CERT (`audio-host.cpp`, wasm gates if applicable).
- Done when: `rg -n 'acceptance_|getenv\("DAW_AE08_EVIDENCE_DIR"\)' native --glob '!build/**'` matches only `acceptance-observer.h`, `acceptance-output-tap.h`, `acceptance-evidence.h` and `main.cpp`.
- Commit: `refactor(native): acceptance capture and publication evidence live in one observer the host holds only when evidence is on`

#### P06. One graph publication and source reconciliation transaction (high-risk, N)

- Closes: S§2.7 "reconciliation apply flag and frame-zero mode"; `untangle-native` decision 3.
- Files: `native/audio-core/include/daw/audio_core_native.h:20`, `audio_core.cpp` implementation, `audio-host.cpp` 5808-5843, 2593.
- Shape: replace `ReconcileSampleSources(core, sources, frame, bool apply)` with an admission that returns a token and a commit that cannot fail; export the source declaration limit from the core header and use it at `audio-host.cpp:2593` instead of the literal 256.

```cpp
[[nodiscard]] std::optional<SourceReconciliation> AdmitSampleSources(daw_audio_core_handle, std::span<const daw_audio_sample_source_event>, std::int64_t frame) noexcept;
void CommitSampleSources(daw_audio_core_handle, const SourceReconciliation&) noexcept;
inline constexpr std::size_t kMaximumSourceDeclarations = 256;   // was private at audio_core.cpp:33
```

  Give the frame-zero workflow and the direct-source lane scan their own named functions instead of the `source` boolean on the generic lane helper.
- Must not change: publication ordering observed by the callback, accepted and rejected inputs, wire formats.
- Validation: V-NCORE, V-WASM (core changed, re-pin as P03), V-NHOST, V-NPLUG, V-RTG, CERT (`audio-host.cpp`, wasm gates), fuzz seeds unchanged (`--only` the controller seed shards listed by `fast-cert.ts --plan`).
- Commit: `refactor(native): source reconciliation is an admission and a commit that cannot fail, and the host reads the declaration limit from the core`

#### P07. The host reads graph bytes through the core's decoder (complex, N)

- Closes: S§2.4 "graph wire format parsed by hand"; `thermos-native-quality` 2.
- Files: `audio-host.cpp` 225 (node byte lengths by version), 3031 (routing), 3096 (instrument targets); `audio_core.cpp:6342` decoder; new declarations in `audio_core_native.h`.
- Shape: expose a read-only decoded view from the core (node kind, ids, instrument record span) and derive routing, asset retention and instrument targets from it.
- Must not change: the envelope versions accepted, the bytes. No new allocation on the callback.
- Validation: as P06.
- Done when: `rg -n 'ReadLeU32\(node' native/audio-host-macos/src/audio-host.cpp` has no match and the version-to-length function at 225 is gone.
- Commit: `refactor(native): the host derives routing and instrument targets from the core's decoded graph view`

#### P08. Spectral replacement transition and the parameter checkpoint (high-risk, N)

- Closes: S§2.2 (`audio_core.cpp` spectral replacement); `thermos-native-quality` 1; S§2.7 "parameter delivery + state capture checkpoint"; `untangle-native` decision 5.
- Two commits, same worker:
  1. `audio_core.cpp`: group the five flags at 635 into one `SpectralReplacement` struct with `Prepare` (code now in `prepare_runtime_ownership` 8768) and `RenderStep` (the roughly 175 lines in `render_chain_frame` 5126). Keep it in `audio_core.cpp` (a new source file would have to join `portableWasmBuildInputPaths` and both CMake files; do that only if decision U4 asks for a line target on `audio_core.cpp`).
  2. `audio-host.cpp:4547`, `worker-control-service.cpp:144`, `worker-runtime.cpp:388`, `audio_host_event_scheduler.h:40`: the attachment exposes one `CheckpointState()` that delivers pending parameters then reads state; general worker APIs lose the scheduler-specific parameter.
- Must not change: rendered audio (parity fixtures), the VST3 parameter-flush ordering fixed by commit `96e0f5bb`.
- Validation: V-NCORE, V-WASM with re-pin, V-NHOST, V-NPLUG, `bun --conditions=browser test --timeout 30000 native/audio-core/tests/wasm_artifact.test.ts`, CERT.
- Commits: `refactor(audio-core): the spectral replacement transition has one state struct with a prepare and a render step`; `refactor(native): an attachment checkpoints its own parameters before a state read`

#### P09. Native source-text guards become executable tests (complex, N)

- Closes: S§3 `realtime_callback_guard.test.ts`, `validation_scratch.test.ts`; `untangle-native` section 4 "Source guards"; native comment candidates in the guard file.
- Files: `native/audio-host-macos/tests/realtime_callback_guard.test.ts` (5 tests, gate `x-rtguard` expects 5 pass, and CMake registers it as `daw-realtime-callback-static-guard`), `native/audio-core/tests/validation_scratch.test.ts`.
- Shape: keep one token-blacklist test over the callback translation unit (no lock, wait or wake tokens), delete the assertions on private names, counts (`.enabled` exactly twice at 205) and helper arrangement. Replace `publish, rollback and the callback keep no revision-core branch` (365) and the vacuous ordering at 409 (`indexOf` returning -1 passes) with native tests in `audio_host_test.cpp` that execute publication ownership and reader completion. Replace the `validation_scratch` text checks with an allocation-counting native test of the spectral refresh.
- Certification: removed or renamed tests need a removal manifest `tools/certification/removals/pr62-native-guards.json` citing the ruling from P00, and `x-rtguard` count moves. A test that moves into C++ is a removal plus an addition, not a move.
- Validation: V-RTG, V-NHOST, V-NCORE, CERT with `gate:x-rtguard,gate:x-host-ctest,gate:x-test-native`.
- Commit: `test(native): callback guards execute publication and reader completion instead of matching source text`

#### P10. Native C++ test hygiene and small dead code (complex, N)

- Closes: S§3 private-state C++ tests, sleeps, unbounded polling, env-driven tests; S§2.5 `main.cpp:34`; `untangle-native` section 3 comments (audio_core.cpp 1408, 2277, 2286, 4157, 6834; audio-host.cpp 2417, 2470, 2496).
- Files: `native/audio-core/tests/audio_core_test.cpp` (7250 rewrite through public prepare and render; 9167 rewrite through held-note replacement; 10002 delete the fixture self-check), `native/audio-core/CMakeLists.txt:31-55` (drop the source-including variant once no test needs private state; ctest total must not fall, so each removed registration is replaced by a public-API registration), `native/audio-host-macos/tests/audio_host_test.cpp` (5494 and 3599: replace the 20 ms sleeps with an explicit admission signal; 6466 `MeasureInserts`: bound both polls; 6543-6640 `main`: per decision U2), `native/audio-core/tests/wasm_artifact.test.ts:1403` (compare two partitionings with the same edit boundaries), `native/audio-host-macos/src/main.cpp:34` (drop the unused `istream` parameter).
- Batch the `audio_core.cpp` comment deletions here with one wasm rebuild and re-pin.
- Must not change: what each remaining test proves; `tools/acceptance/run-ae08-test-plugin.ts` must still run the five real-plug-in tests.
- Validation: V-NCORE, V-NHOST, V-NPLUG, V-WASM with re-pin, CERT with the native gates.
- Commit: `test(native): spectral and voice tests go through the public core, host tests wait on signals, real plug-in tests register on their own`

### Track D: desktop backend

#### P11. Recording manifests are published atomically and one bad take does not disable the registry (complex, D)

- Closes: S§1.4; `thermos-desktop-bug` 3; `untangle-desktop-backend` S19.
- Files: `apps/desktop/recording-spool.ts` (`persistManifest` 107-140, `discover` 306-361, `initializeRecordingSpoolRegistry` 507-511), `apps/desktop/recording-spool.test.ts`.
- Shape: write to a private temporary name in the same directory (`O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0o600`), sync, verify identity, `link` or `rename` to the final name only if it does not exist, sync the directory. In `discover`, a take whose receipt or resolved manifest cannot be parsed is registered as retained with a `damaged` reason and never has its source deleted; other takes load. Leftover temporary files are ignored by the `^[a-f0-9]{64}\.json$` filter (keep that).
- Must not change: the fail-closed ownership checks, the receipt-first convergence, the bounded size, the private-file checks.
- Test first (list): crash after open before write; short write; disk full; existing final name; truncated receipt at discovery; truncated resolved manifest; symlinked target.
- Validation: `bun test --conditions=browser --timeout 30000 apps/desktop/recording-spool.test.ts`, V-DESKTOP, V-TS, V-LINT.
- Commit: `fix(desktop): a recording receipt becomes visible only after it is written and synced, and a damaged take no longer disables the registry`

#### P12. A replaced VST instance leaves no stale ledger entry, and a changed state is applied (complex, D)

- Closes: S§1.2, S§1.8; `thermos-desktop-bug` 1 and 2.
- Files: `apps/desktop/native-vst3-coordinator.ts` 761-814 (`reconcile`, `detach`, `rolledBack`), its callers of `ledger.detach` for `replace`, `apps/desktop/native-vst3-coordinator.test.ts`.
- Shape: on a replace detach, delete the `active` entry as well (the host moved the old object aside at `audio-host.cpp` 5461-5464). `rolledBack` then leaves neither a staged nor an active entry for a replaced instance, so the next plan attaches. For bug 8, per decision U1 (recommended option b):

```ts
type LedgerEntry = { plugin: string; binding: string; load: string }
// reconcile
else if (current.plugin !== entry.plugin || current.binding !== entry.binding
  || (current.load !== entry.load && !ledger.capturedFromLive(instanceId, entry.load))) replace.push(instanceId)
```

  where `capturedFromLive` is true when the new state hash is the one the host last captured from that running instance. If U1 is answered "always reload" or "never", implement that instead.
- Must not change: preflight caching, attach ordering, the meaning of `removed` and `dropped`.
- Test first: reorder then roll back then restore the original binding expects an attach; undo of a state change expects a replace; a live capture of the running instance expects no replace.
- Validation: `bun test --conditions=browser --timeout 30000 apps/desktop/native-vst3-coordinator.test.ts`, V-DESKTOP, V-NPLUG, V-TS, V-LINT.
- Commit: `fix(desktop): a replaced VST instance is forgotten when it is detached, and a restored state reloads an unchanged plug-in`

#### P13. Desktop acceptance evidence is a non-throwing observer (complex, D)

- Closes: S§1.13; S§2.1 desktop items (`main.ts:387`, `ipc-channels.ts:68`, `ae08-evidence.ts`); `thermos-desktop-quality` 1; `untangle-desktop-backend` S1 to S3.
- Consumers: `tools/acceptance/ae-08-live-graph.ts`, `ae-08-prepare-split.ts` (reads `inspect-handler-return`), `ae-08-latency-gates.ts`, `ae-08-phase-9-matrix.ts`. Isolate. `DAW_AE08_RENDERER_PROFILE` has no runner consumer (README only): decision U8.
- Files: `apps/desktop/ae08-evidence.ts`, `apps/desktop/audio-host.ts` (five `DAW_AE08` reads, the call inside the reply decoder at 2200), `apps/desktop/main.ts` (387-390 send counter, 1802 and 1810 evidence calls, 2382 `ae08StopTrace`, 1126), `apps/desktop/vst3-preflight.ts`, `packages/desktop-protocol/src/ipc-channels.ts` 68-93, `apps/desktop/preload.ts` 304-305.
- Shape:

```ts
// ae08-evidence.ts
export type HostEvidence = (event: string, fields?: Record<string, string | number | boolean | null>) => void
export const createAe08Evidence = (directory: string | undefined): HostEvidence | undefined   // undefined when off; never throws; counts its own write failures
// audio-host.ts
createNativeAudioHostSupervisor({ ..., evidence?: HostEvidence })   // called after the pending request is settled, never before
```

  Move `ae08RendererMarks` and its channel constant to `packages/desktop-protocol/src/acceptance-marks.ts`. Move `rendererSendCount` into the evidence object (`evidence.rendererSend()`), so `sendRendererMessage` has no acceptance state. In quit, `await ae08StopTrace().catch(log)` so evidence cannot fail shutdown.
- Must not change: event names and fields in `host.jsonl`, mark names, the rule that routine acks are logged only under the evidence switch while a slow hot control ack is always logged (commits `0a3d1585`, `58d3116b`).
- Risks: `audio-host.ts` is a controller fuzz source (watched hash only; no arm anchors in it).
- Validation: `bun test --conditions=browser --timeout 30000 apps/desktop/audio-host.test.ts`, V-DESKTOP, V-TS, V-LINT, `bun tools/typecheck.ts`, CERT with `gate:rc1-g-panel-audiohost,gate:rc1-i6-desktop`.
- Done when: `rg -n 'DAW_AE08_' apps/desktop --glob '!*.test.ts'` matches only `ae08-evidence.ts`, `main.ts` (composition) and `preload.ts`.
- Commit: `refactor(desktop): AE-08 evidence is an optional observer that cannot throw into host control or fail quit`

#### P14. Delete the test-only VST revision coordinator and split the module (routine, D)

- Closes: S§2.5 `createNativeVst3RevisionCoordinator`; `thermos-desktop-quality` 4; comments at `native-vst3-coordinator.ts` 516, 762, 805 and `native-vst3-coordinator.test.ts` 1144, 1156.
- Files: `apps/desktop/native-vst3-coordinator.ts` (delete `createNativeVst3RevisionCoordinator`, its implementation and exclusive helpers, 568-715), move `createNativeVst3HostEventHandlers` (production consumer `main.ts:2492`) to `apps/desktop/native-vst3-host-events.ts`, delete the coordinator's tests in `native-vst3-coordinator.test.ts` (10 references) and rewrite 1411 (`the session ledger starts per transaction…`) to assert attach behavior across transitions.
- Certification: `rc1-i6-desktop` count falls; removal manifest `removals/pr62-desktop.json` (shared by track D phases; the parent integrates in P24).
- Validation: V-DESKTOP, V-TS, V-LINT, `bun run knip`.
- Done when: `native-vst3-coordinator.ts` is under 700 lines and `rg createNativeVst3RevisionCoordinator` has no match.
- Commit: `refactor(desktop): the unused VST revision coordinator is removed and host event routing has its own module`

#### P15. The native host decides attachment reuse (complex, D; depends on P12, P14; decision U6)

- Closes: S§2.4 parking limits and `loadKey` vs `SameLoadedPlugin`; `untangle-desktop-backend` S10, S11 and the insertion-preflight link; S§3 coordinator tests 1012, 1032.
- Files: `native-vst3-coordinator.ts` 717-728, 756-760, 775, 790-804; `apps/desktop/vst3-insertion-preflight.ts:38`; tests.
- Shape (recommended): delete `parked`, `maximumParkedInstances`, `parkedAgeMs`, `loadKey` and `parkedMatches`. Preflight is skipped through the verdict cache (`verdictKey`, `rememberVerdict`), which already exists; the host's `RejoinParkedNativeVst` decides reuse. `release` on a refused detach keeps its current meaning but is expressed as an explicit result, not a caught error class. **Verify first** that the verdict cache covers the case the parked mirror was added for (commit `fc199e12`); if it does not, stop and report (U6).
- Validation: coordinator tests, V-DESKTOP, V-NPLUG, V-NHOST (`TestParkedInstanceRejoinsWithoutAReload`, `TestParkingIsBoundedByCountAndAge` stay the proof of parking).
- Commit: `refactor(desktop): the attachment ledger no longer mirrors the host's parking limits or load comparison`

#### P16. Pending native requests are a discriminated union (complex, D)

- Closes: S§2.6 pending request variants; `thermos-desktop-quality` 3 (first half).
- Files: `apps/desktop/audio-host.ts` (queue entry and pending types, dispatch 2337-2405, decoder branches such as 2194).
- Shape:

```ts
type Reply =
  | { kind: "ack"; expectedAckType: number; resolve: () => void }
  | { kind: "graphRevision"; requestedRevision: number; resolve: (status: GraphRevisionStatus) => void }
  | { kind: "vstState"; instanceId: string; resolve: (state: …) => void }
  | { kind: "editor"; resolve: (reply: …) => void }
  | { kind: "patchStatus"; resolve: (status: …) => void }
type PendingRequest = { requestType: number; requestId: number; enqueuedAt: number; dispatchedAt: number; reason?: string;
  reject: (error: Error) => void; deadline: ReturnType<typeof setTimeout>; stdinBackpressure?: boolean; reply: Reply }
const pendingOf = (next: QueuedRequest, dispatchedAt: number, deadline: …): PendingRequest => ({ …common, reply: next.reply })
```

- Must not change: frame bytes, timeouts (2 s graph revision, `nativeAudioHostControlWatchdogMs` otherwise), log lines, the recording Finish exemption at 1626.
- Validation: `apps/desktop/audio-host.test.ts`, V-DESKTOP, V-TS, V-LINT, CERT gates as P13.
- Commit: `refactor(desktop): a pending native request carries one reply variant instead of optional resolver fields`

#### P17. Extract the native request broker (high-risk, D; depends on P16)

- Closes: S§2.2 `audio-host.ts` size; S§2.7 request broker policies (1580 `sample` plus 1.5 s, 1626, 3176 inventory installs pending directly); S§2.5 `onRecordingBlock` (3464 vs decoder 2096), teardown `reason` (3316); `untangle-desktop-backend` S7 to S9, S20, S21.
- Files: create `apps/desktop/native-request-broker.ts` (queue, admission, dispatch, pending, timeout policy per reply kind, `captureHostStack`); `audio-host.ts` keeps process lifecycle, frame decode and the public supervisor API. `listDevices` (3176) goes through the queue. Delete `onRecordingBlock` and `recordingBlockListeners` (update the mocks in `apps/desktop/audio-host.test.ts`, `src/hooks/useTimelinePlayback.test.ts`, `tools/acceptance/b5c-playback-witness-support.ts`, `tools/acceptance/device-control-cost.browser.test.ts`). `teardownSession()` drops the unused `reason` argument (main already logs it). S20 per decision U7.
- Must not change: ordering of frames on stdin, which timeouts declare host loss, the stack capture on control timeout (justify the existing timer in a comment per AGENTS.md).
- Risks: this is the supervisor's concurrency core. Move code verbatim first, then change `listDevices`, in separate commits.
- Validation: `apps/desktop/audio-host.test.ts` (the watchdog tests at 2747 and 2991 are rewritten in P20; here they must still pass), V-DESKTOP, V-HT, V-TS, V-LINT, `bun tools/typecheck.ts`, CERT with `arms-for.ts apps/desktop/audio-host.ts tools/acceptance/b5c-playback-witness-support.ts` plus fuzz controller seed shards.
- Done when: `audio-host.ts` is under 2,800 lines and no method installs `pending` outside the broker.
- Commits: `refactor(desktop): the native request queue, pending reply and timeout policy move to a request broker`; `refactor(desktop): the device inventory request goes through the request queue`; `refactor(desktop): recording-block listeners and the teardown reason are removed, nothing sends or reads them`

#### P18. Recording contracts and diagnostics stop gating product paths (complex, D)

- Closes: S§2.1 `benchmark-runtime.ts:179`, `recording-start-diagnostic.ts:99`, `recording-spool.ts` 39/483/494; S§2.4 `spoolReleaseSchema` (main.ts:2006 vs recording-spool.ts:75); S§2.5 benchmark `sendBlock`; `untangle-desktop-backend` S4 to S6, S12, S14; S§3 `recording-start-diagnostic.test.ts:61`, `recording-ipc-diagnostics.test.ts:125`.
- Consumers: `DAW_RECORDING_START_*` and the spool order evidence are read by `tools/performance/30-track/native-spool-configure-diagnostic.ts`, `native-spool-acceptance.ts`, `tier-three.ts`, `v3-import-acceptance.ts` (isolate). `sendBlock` has test callers only (delete). `beforeReleaseUnlink` has test callers only (delete).
- Files: `apps/desktop/benchmark-runtime.ts` (delete `sendBlock` and `benchmarkMainArrivalEpochMs`; `recordStatus` returns the evidence beside the status instead of mutating the envelope), `apps/desktop/recording-start-diagnostic.ts` (`start` becomes `observeStart(result)`; the inhibit decision moves to a named `captureInhibited` boolean read by the recording handler), `apps/desktop/recording-spool.ts` (export the release schema once; move `createRecordingSpoolOrderEvidence` to `apps/desktop/recording-spool-evidence.ts`; delete `beforeReleaseUnlink` and drive the three tests through a real concurrent scope change), `apps/desktop/main.ts` 2004-2013 (import the schema), tests.
- Must not change: the release proof, receipt validation, stdout readiness lines the runners parse, the admission answer when capture is inhibited.
- Validation: `bun test --conditions=browser --timeout 30000 apps/desktop/recording-spool.test.ts apps/desktop/recording-start-diagnostic.test.ts apps/desktop/recording-ipc-diagnostics.test.ts`, `bun --conditions=browser test --timeout 120000 tools/performance/30-track/native-spool-wav.test.ts`, V-DESKTOP, V-TS, `bun tools/typecheck.ts`.
- Commit: `refactor(desktop): recording diagnostics observe, the release schema has one definition, and the release test hook leaves production`

#### P19. Desktop recording session owner (high-risk, D; depends on P11, P18)

- Closes: S§2.2 `main.ts` recording split (globals 203-214, configure 1878-1964, stop 1987-2003, completion 2583-2599); `thermos-desktop-quality` 2; `untangle-desktop-backend` S12, S13, S17.
- Files: create `apps/desktop/recording-session-owner.ts`; `apps/desktop/main.ts` keeps only IPC parsing and delegation.

```ts
export const createRecordingSessionOwner = (input: { registry: RecordingSpoolRegistry | undefined; registryFailure: Error | undefined;
  diagnostic: RecordingStartDiagnostic; sendToRenderer: (channel: string, value: unknown) => void }) => ({
  configure(supervisor, request, owner): Promise<RecordingConfigureReply>,   // admission, bind, native configure, readiness
  start(supervisor, …), stop(supervisor, frame): Promise<void>,              // waits for the one completion
  onStatus(status): void,                                                     // completion, terminal resolution, renderer status
  invalidateRenderer(generation): void, waitForSettlement(): Promise<void>,
})
```

  Replace the caller-supplied `spoolImportVersion: 1` literal (main.ts:1890, `native-playback-controller.ts:2954`) with a named protocol constant in `packages/desktop-protocol`. Recording Start failure keeps its thrown error for classification (main.ts:1985).
- Must not change: IPC channel names and reply shapes, the shutdown barrier, which failures retain sources.
- Risks: races between Stop and Complete (S13). Write the interleavings first: Stop before Complete, Complete before Stop, renderer invalidated between them, quit during completion.
- Validation: V-DESKTOP, `apps/desktop/native-session-bridge.test.ts`, V-C (controller recording tests), V-TS, V-LINT, packaged recording acceptance is listed in the final verification, not here.
- Done when: `main.ts` has no `recordingBinding`, `recordingAdmissionPending` or `recordingSpoolRegistry` module variable and is under 2,450 lines.
- Commit: `refactor(desktop): one recording session owner holds admission, binding, completion and release; main only routes IPC`

#### P20. Desktop IPC contracts, close flow and desktop tests (complex, D)

- Closes: S§1.3; S§2.4 graph-revision offsets (`main.ts:1808` vs `native-host-wire.ts:475`); S§2.5 preload five-op map (`preload.ts:391`); S§2.7 failure projections (`main.ts` 1371, 1382, 1985), `application-menu-ipc.ts` 21-31; S§3 desktop tests; desktop comments in `untangle-desktop-backend` section 3 not yet removed.
- Commits, in order:
  1. `fix(desktop): a failed close preparation offers Quit and Discard again; only a recording barrier failure keeps the app open`. `main.ts:2337`: catch the `renderRequest` rejection and return `false`; recording barrier errors still throw to `onError`. Test first in `apps/desktop/close-flow.test.ts` (or the existing close test): renderer rejects, expect `confirmDiscard` called.
  2. `refactor(desktop): the wire serializer stamps the runtime revision, main no longer patches offsets`. Export `stampGraphRevision(bytes, revision)` from `packages/audio-engine/src/native-host-wire.ts` (anchored by 2 arms and watched: CERT) and call it at `main.ts:1806-1809`.
  3. `refactor(desktop): one typed failure projection for native session IPC`. Replace the `instrumentStates` name test (1382) with an allowlisted `detail` on `NativeAudioHostCommandError`; inventory (1371) reports the classified kind.
  4. `refactor(desktop): VST editor state acknowledgments register with the audio host IPC, not the application menu`. Move the ack endpoint out of `apps/desktop/ipc/application-menu-ipc.ts`.
  5. `refactor(desktop): preload passes the five revision channels directly`. **Verify** `createNativeRevisionSession` has a second consumer (`native-live-graph.browser.test.ts`, deleted in P36) before changing its signature.
  6. `test(desktop): session bridge, menu and release tests execute registered handlers instead of matching source text`. Rewrite `native-session-bridge.test.ts` 131-224 (8 tests), `application-menu.test.ts:268`, the source-scanning part of `release.config.test.ts:72`, the `1_500` literal harness in `audio-host.test.ts` 2706-2716/2747/2991 (inject the watchdog clock), and `packages/plugin-host-protocol/src/index.test.ts:478` (done in P50 if generation lands; otherwise keep). Delete the listed restating comments in `audio-host.ts` 170, 1279, 2480, `main.ts:1823`, `recording-spool.ts:435`, `audio-host.test.ts:2655`, `recording-spool.test.ts:275`.
- Validation: V-DESKTOP, `bun test --conditions=browser --timeout 30000 packages/plugin-host-protocol packages/desktop-protocol`, V-COORD (wire), V-TS, V-LINT, CERT for `native-host-wire.ts`.
- Done when: `rg -n 'readFileSync\(.*main\.ts' apps/desktop/*.test.ts` has no match.

### Track X: Convex

#### P21. A project edit owns its revision stamp (complex, X)

- Closes: S§2.7 Convex revision stamp convention; `untangle-desktop-backend` decision 4; S§3 `deviceAutomationRows.phase3b1.test.ts:298`, `projectRows.test.ts:6`; comments in `convex/effects.ts` 236, 369, 563, `control.integration.test.ts` 1889, 1896, `deviceAutomationRows.phase3b1.test.ts` 304-356, `revision.mutation.test.ts` 382-427.
- Files: `convex/projectRows.ts:79`, `convex/controlExecution.ts:135`, `convex/controlRecovery.ts:718`, `convex/effects.ts:237`, `convex/tracks.ts:450`, tests.
- Shape: one edit context created by the owning mutation; row writers take it and cannot compute `revision + 1` themselves; the context advances the project once at the end.

```ts
type ProjectEdit = { revision: number; stamp: () => number }           // the prospective revision, same for every row of this edit
export const withProjectEdit = async <T>(ctx: MutationCtx, projectId: Id<"projects">, run: (edit: ProjectEdit) => Promise<T>): Promise<T>
```

- Must not change: public mutation return shapes (legacy write results), the unstamped-row sentinel `0` at `effects.ts:367` (S22, tested), the control V1 envelopes (`docs/control-platform.md`).
- Validation: V-CONVEX, `bun run test:control-platform`, V-TS, V-LINT, CERT with `gate:rc1-i4-consumers` (it runs `convex/revision.mutation.test.ts`).
- Commit: `refactor(convex): a mutation's project edit stamps its rows and advances the revision once`

### Track A: audio-engine package

#### P22. Test fakes leave product source (routine, A)

- Closes: S§2.1 `audio-param-ramp.ts:40`, `fx-runtime-test-audio.ts`; `untangle-ui-engine` S12, S13.
- Files: `packages/audio-engine/src/audio-param-ramp.ts` 38-44 (delete the non-`AudioParam` branch), move `packages/audio-engine/src/fx-runtime-test-audio.ts` to `packages/audio-engine/test-support/fx-runtime-test-audio.ts` (5 test importers: `live-mixer-runtime.test.ts`, `master-fx-runtime.test.ts`, `create-persisted-effect-state.test.ts`, `useEffectsPanelAudioSync.test.ts`, `instrument-buffer-sync.test.ts`), make the fake parameter implement `setValueAtTime`, `linearRampToValueAtTime`, `cancelScheduledValues` so tests read its value. Delete the `DV01_CAPTURE_GLOBAL_TRANSITIONS` mode if no gate sets it (**verify** in `expectations.json` gate and arm `env`).
- Validation: V-ENGINE, V-SYNC, V-BUF, V-TS (package `check`), `bun run knip`, CERT with `gate:f-audiosync,gate:f-persisted,gate:last-buffer`.
- Commit: `refactor(audio-engine): the fake audio graph is test support and the ramp helper has no fake-parameter branch`

#### P23. A removed send is disconnected when its fade ends (complex, A)

- Closes: S§1.12; `thermos-ui-quality` 2; `untangle-ui-engine` S14; S§3 `apply-live-routing.test.ts:39`.
- Files: `packages/audio-engine/src/mixer/apply-live-routing.ts` 182-194, the caller in `live-mixer-runtime.ts` 1020-1089, tests.
- Shape: the edge runtime gets a retirement that completes on its own and is cancelled when the edge is reused or the runtime is disposed. Prefer an event on the audio clock over a timer: a `ConstantSourceNode` stopped at `fadeEndTime` whose `ended` event disconnects that exact edge. If the worker finds the runtime already owns a cancellable transition scheduler (the one `captureFxTransitions` intercepts), reuse it and add the AGENTS.md justification comment.
- Must not change: the fade length (`LIVE_GAIN_RAMP_SEC`), behavior when the send is re-added during the fade.
- Test first: remove a send, advance the fake clock past the fade without another routing pass, expect the gain and delay disconnected and the map entry gone; re-add during the fade expects no disconnect.
- Validation: `bun --conditions=browser test --timeout 30000 packages/audio-engine/src/mixer/apply-live-routing.test.ts packages/audio-engine/src/live-mixer-runtime.test.ts`, V-ENGINE.
- Commit: `fix(audio-engine): a removed send disconnects when its fade ends, without waiting for another routing pass`

#### P25. One effect-chain update transaction (high-risk, A; depends on P22)

- Closes: S§2.3; S§2.2 `live-mixer-runtime.ts` size; `thermos-ui-quality` 1; `untangle-ui-engine` decision 1 (S1, S2); comments `live-mixer-runtime.ts` 566, 675, 709 and `master-fx-runtime.ts` 353, 425, 462, `chain-admission.ts` 42-48, `delay-chain-state.ts:28`, `reverb-chain-state.ts` 26, 52, `saturator-chain-state.ts:21`, `event-loop-yield.ts:1`.
- Files: create `packages/audio-engine/src/effect-chain-transaction.ts`; `live-mixer-runtime.ts` 556-750 and `master-fx-runtime.ts` 345-503 call it.

```ts
export const createEffectChainTransaction = (host: {
  budget: LiveWorkletBudget
  connect: (chain: ChainNodes) => void          // track or master routing adapter
  publish: (installed: InstalledChain) => void  // metering and bookkeeping adapter
}) => ({ apply(edit: ChainEdit): ChainApplyResult, installed(): ReadonlyMap<string, EffectParams> })
```

  The deferred EQ write (S1) becomes a property of the EQ chain state (`writesAfterCommit`), and compressor recovery failure (S2) is part of the chain-state result, so neither runtime inspects effect internals.
- Must not change: audio node graph produced, write ordering, budget commits, single-edit fast path semantics.
- Risks: correctness-sensitive duplicated code that may have diverged; diff the two implementations line by line first and list every difference in the commit body.
- Validation: V-ENGINE, V-SYNC, V-BUF, V-HT, CERT with `gate:f-audiosync,gate:f-persisted,gate:rc1-i7-engine,gate:last-engine`.
- Done when: `live-mixer-runtime.ts` is under 1,000 lines, `master-fx-runtime.ts` under 650, and `rg -n 'writtenInPlace' packages/audio-engine/src` matches only the transaction module and tests.
- Commit: `refactor(audio-engine): track and master effect chains share one update transaction; routing and metering stay with each runtime`

#### P26. Engine contracts have one definition (complex, A)

- Closes: S§2.4 PCM metadata validation (`packages/shared/src/audio-pcm-source.ts` 63, 101 vs `packages/audio-engine/src/media-pages.ts` 107, 154, 190), legacy synth fallback (`live-native-projection.ts:238` vs `portable-session-compiler.ts:448`); `untangle-ui-engine` S9, S18.
- Shape: `packages/shared` exports the one metadata validator; `media-pages.ts` imports it. Range handling is two named functions, `clampPcmRange` and `requirePcmRange`, each used where it is used today (decision U9 if the user wants one semantics). The AudioBuffer adapter validates `pageFrames` like the encoded path. One `legacySynthFallback` in the engine, imported by both compilers.
- Must not change: `packages/waveforms` must still not depend on decoding (`asset-store.ts:1`).
- Validation: V-ENGINE, `bun test --conditions=browser --timeout 30000 packages/shared packages/waveforms`, V-TS.
- Commit: `refactor(audio-engine): PCM metadata validation and the legacy synth fallback each have one definition`

#### P27. Engine tests execute behavior (complex, A)

- Closes: S§3 `portable-wasm-worklet.test.ts:241`.
- Files: `packages/audio-engine/src/portable-wasm-worklet.test.ts` (watched): replace the source-substring test with host messages and retained audio through the worklet harness the file already has.
- Certification: `x-portable-wasm` count; removal manifest entry if the test name changes.
- Validation: `bun --conditions=browser test --timeout 30000 packages/audio-engine/src/portable-wasm-worklet.test.ts`, V-ENGINE, CERT with `gate:x-portable-wasm`.
- Commit: `test(audio-engine): the portable worklet staging test drives host messages instead of matching source text`

### Integration points for parallel groups

- **P24** (parent, after tracks D and X merge): one hand record for moved desktop and Convex gate counts (`rc1-i6-desktop`, `rc1-g-panel-audiohost`, `rc1-i4-consumers`) with the `removals/pr62-desktop.json` name-diff proof.
- **P29** (parent, after tracks N and A merge): one hand record for native and engine gates (`x-rtguard`, `x-test-native`, `x-host-ctest`, `x-wasm-source-hash`, `x-portable-wasm`, `f-engine` files) if workers did not already record them serially.
- **P45** (parent, after track L merges): one hand record for `f-audiosync`, `f-persisted`, `f-audio-effects`, `rc1-i3-sync`, `rc1-i4-consumers`, `f-portable` counts.

### Track K: playback core (strictly serial; every phase runs CERT)

#### P30. Renderer acceptance observer (complex, K)

- Closes: S§2.1 renderer items; `untangle-src-lib` S1 to S5; `untangle-ui-engine` S7, S8.
- Consumers: marks are read by `tools/acceptance/ae-08-latency-gates.ts`, `ae-08-prepare-split.ts`, `ae-08-phase-9-matrix.ts`; `DAW_AE08_EXTERNAL_NATIVE_SESSION` is set by `tools/acceptance/ae-08-live-graph.ts`; `onProcessorDispatch`, `adoptionWitness`, `liveScheduleCandidates` are read by `tools/acceptance/ae-08-processor-state-fuzz-fixture.ts`; `adoptionFieldsWitness` only by the controller test. All isolate, none delete.
- Files: `src/lib/desktop/ae08-marks.ts`, `src/types/desktop-bridge.ts` 270-275, `apps/desktop/preload.ts` 303-309, `src/lib/live-playback-snapshot.ts:32`, `src/lib/desktop/native-timeline-page-manager.ts:29`, `src/lib/desktop/native-playback-controller.ts` (550, 562, 1063-1068, 1632, 2420, 2532, 2605, 3122, 3528, 4023, 4084, 4154, 4185, 4557, 5059-5064), `src/lib/desktop/native-schedule-coordinator.ts`, `src/lib/desktop/attached-host-controller.ts`, `src/hooks/useTimelinePlayback.ts` 181, 297, 1260, the six `ae08UiMark` callers (`EffectsPanel.tsx`, `external-plugin-card.tsx`, `parameter-gesture-owner.ts:400`, `useTimelineAutomationController.ts` 432 and 441, `useTimelineBrowserController.ts`, `useTimelineHistory.ts`), `tools/acceptance/ae-08-processor-state-fuzz-fixture.ts`.
- Shape:

```ts
// src/lib/desktop/ae08-marks.ts: the only module that reads the bridge
export type PlaybackAcceptanceObserver = {
  ownsNativeSession: boolean                                   // false when DAW_AE08_EXTERNAL_NATIVE_SESSION=1
  ui: (name: UiMark, target: () => string) => void
  adoption: (intentKey: string | undefined) => ((name: AdoptionMark) => void) | undefined
}
export const desktopAcceptanceObserver = (bridge: DesktopBridge | undefined): PlaybackAcceptanceObserver | undefined
// DesktopBridge
acceptance?: { externalNativeSession: boolean; mark?: (name: string, key: string) => void }
// native-playback-controller input and result
observer?: { processorDispatch?: (event: …) => void; adoption?: PlaybackAcceptanceObserver["adoption"]; externalSessionOwner?: boolean }
witness: { adoption, adoptionFields, liveScheduleCandidates }  // one grouped object instead of three top-level members
```

  `Timeline.tsx` creates the observer once and passes it to the hooks and controllers it already constructs. `LivePlaybackCompileContext.mark` and the page manager's `mark` argument take the neutral type `(name: string) => void` so neither imports the AE-08 vocabulary.
- Must not change: mark names, keys and timing points; behavior when the observer is absent (one property read, `target()` never runs).
- Risks: marks sit inside anchored regions of the controller and hook. Expect re-pointed anchors.
- Validation: V-C, V-HT, V-COORD, V-PB, V-SYNC, V-TS, `bun tools/typecheck.ts`, V-LINT, CERT for every touched anchored and fuzz file (`arms-for.ts` on the list above; fuzz fixture is a watched source and its seeds must not move).
- Done when: `rg -n 'dawDesktop\?\.(ae08Mark|acceptance)' src` matches only `ae08-marks.ts`, and `rg -n 'ae08' src/components src/hooks` has no match.
- Commit: `refactor(acceptance): renderer marks, the external session switch and the fuzzer witnesses go through one observer built at the Timeline root`

#### P31. Small dead code in the playback core (routine, K)

- Closes: S§2.5 `planWithWorkerFrames` identical branches (`native-playback-controller.ts` 487-491); `untangle-src-lib` S17; comment candidates in `native-processor-state-owner.ts:1213`, `native-schedule-coordinator.ts:1296`, `native-vst-state-capture.ts:6`.
- `native-playback-inputs.ts:16` is **kept**: besides `Timeline.tsx` it is imported by `tools/acceptance/ae-08-processor-state-fuzz-hook.ts`, `b5c-playback-witness-support.ts` and `device-control-cost.browser.test.ts`. Only its restating comment (line 14) goes. `publishEffectOperation` (`create-effects-panel-audio-effects-state.ts:59`) is handled in P41.
- Before deleting a comment in an anchored file, check that no arm's `from` contains it (`rg -F` the comment text in `expectations.json`).
- Validation: V-C, V-COORD, V-TS, CERT.
- Commit: `refactor(desktop): the attachment plan frames helper has one branch, and restating comments in the playback core are removed`

#### P32. `Execution` is a discriminated union (high-risk, K)

- Closes: S§2.6 `Execution` (`native-processor-state-owner.ts:143`); `thermos-srclib-quality` 2.
- Shape:

```ts
type ExecutionBase = { key: string; editId: string; order: number; kindId?: number; epoch: number; revision: number; rebound?: number; sequence: number; attempt: number; sent: boolean; … }
export type Execution =
  | ExecutionBase & { strategy: { kind: "parameters" } }
  | ExecutionBase & { strategy: { kind: "urgent"; sequence: number } }
  | ExecutionBase & { strategy: { kind: "patch" }; desired: ProcessorDesired; materialized?: ProcessorDesired; claim: "none" | "claimed" | "held" }
type PatchExecution = Extract<Execution, { strategy: { kind: "patch" } }>
```

  `nextPatch` (1317-1322) takes `PatchExecution` and loses the silent skip of a patch without `desired`.
- Must not change: any native request, settlement order, or fuzz invariant. 136 arms anchor here; several survivors in `test-debt.md` mutate these exact lines (rc2:265, 279, 388, 392, 393, 398, 399): retired arms keep stale anchors, as record 53 allowed.
- Validation: V-C, V-HT, V-COORD, V-TS, CERT (`arms-for.ts src/lib/desktop/native-processor-state-owner.ts`, both fuzz fixtures' seed shards).
- Commit: `refactor(desktop): a processor execution is a union by carrier, so a patch always has its desired content`

#### P33. The publication record is private to the state owner (high-risk, K; depends on P32)

- Closes: S§2.6 (record mutated from outside its owner, `native-processor-state-owner.ts:334` vs `native-playback-controller.ts` 3573-3612); `untangle-src-lib` decision "Keep publication state private", S14, S15 (`finishRetirement` 386-390).
- Shape: the owner exports an opaque handle with commands; `PublicationRecord` is no longer exported.

```ts
type Publication = {
  readonly kind: "schedule" | "latency"; readonly phase: PublicationPhase; readonly cancelled: boolean; readonly terminal: Promise<AdoptionOutcome>
  cancel(): void; held(): void; resubmitted(): void                    // throws past the budget of 8
  onProgress(listener): void; onWake(listener): void
}
// inspection result is explicit instead of `undefined` for both "unavailable" and "failed"
type Inspection = { status: "reply"; reply: NativeRevisionReply } | { status: "unavailable" } | { status: "failed"; error: Error }
```

  `finishRetirement` keeps the obligation until `release()` settles and reports a failed release through `reportIncident` instead of `.catch(() => undefined)`.
- Must not change: the phase sequence and every native call.
- Validation and certification: as P32 plus V-PB.
- Commit: `refactor(desktop): the state owner alone moves a publication through its phases; the controller sends commands`

#### P34. Extract the publication transaction runner (high-risk, K; depends on P33)

- Closes: S§2.2 `executePublication` (3523-4524) and its two loops (3876, 4396); `thermos-srclib-quality` 1.
- Step 1 (move only): create `src/lib/desktop/native-publication-transaction.ts` with the setup shared by both paths (3526-3780: capture, `notify`, `cancel`, `current`, `sessionAlive`, progress handling, `inspect`, `classifyPublication`, `finish`). It receives the session facts it needs as one explicit `PublicationSession` argument instead of closing over 30 controller variables.
- Step 2: one loop.

```ts
type PublicationStrategy = {
  prepare(): Promise<Prepared>                      // latency: recapture and prepare; schedule: stage resources and prepare
  submit(binding: RevisionBinding): Promise<void>   // publish request
  changedSinceCapture(): boolean                    // latency inputs or queued patch; schedule: candidate validity
  onPrepared?(binding): Promise<void>               // schedule: cover, stage window, prime
  promote(reply): boolean                           // adoptPublication
}
export const runPublication = (session: PublicationSession, publication: Publication, strategy: PublicationStrategy): Promise<{ outcome?: AdoptionOutcome }>
```

- Step 3: schedule-specific staging (3930-4390) moves to `src/lib/desktop/native-schedule-publication.ts` as the schedule strategy.
- Three commits, each with its own CERT run. Anchors that move to the new files are re-pointed (`file`, `targets`) in the hand record, the mutation unchanged in meaning.
- Must not change: the order and content of every bridge call (fuzz seeds prove it), the resubmit budget of 8, rollback eligibility, detached resolution.
- Risks: the highest in the plan. If seeds move, stop and report rather than re-recording.
- Validation: V-C, V-HT, V-COORD, V-PB, V-PORT, V-TS, `bun tools/typecheck.ts`, V-LINT, CERT with the full arm set of the controller (298 arms plus siblings; about 420 jobs in earlier rounds) and both fuzz fixtures.
- Done when: `executePublication` is under 120 lines and there is one `for (;;)` proof loop for publications.
- Commits: `refactor(desktop): publication setup moves to a transaction module with explicit session inputs`; `refactor(desktop): latency and schedule publication share one proof loop`; `refactor(desktop): schedule staging is the schedule publication strategy`

#### P35. Controller slices that are not publication (complex, K; depends on P34; scope per decision U4)

- Closes: S§2.2 size of `native-playback-controller.ts`.
- Move, without behavior change, to sibling modules with explicit inputs: native meters and spectrum observation (1077-1276), recording session (2855-3027), live MIDI notes (4863-4998), built-in state patches (4753-4862). One commit per slice, CERT after each.
- Done when: `native-playback-controller.ts` is at or under the target agreed in U4 (recommended 3,300).
- Commit pattern: `refactor(desktop): native <slice> moves out of the playback controller`

#### P36. Remove the test-only revision controller (routine, K; decision U5)

- Closes: S§2.5 `src/lib/desktop/native-revision-controller.ts` (55 lines, only consumer `native-live-graph.browser.test.ts`); `thermos-srclib-quality` 4.
- Recommended: delete `native-revision-controller.ts` and `native-live-graph.browser.test.ts`, and remove gate `rc1-g-native-live-graph-browser` (1 pass) by hand record with a direct audit (a whole-file deletion is not admissible through `--allow-removal`). The scenarios (late reply, changed ownership) are covered by the production path in `native-playback-lifecycle.browser.test.ts` and the controller suite; the worker lists the covering tests in the record's `reason`.
- Validation: V-PB, V-C, V-TS, `bun run knip`, CERT.
- Commit: `refactor(desktop): the revision controller only a browser test used is removed with that test`

#### P37. Recording Stop does not overwrite a newer seek (complex, K)

- Closes: S§1.5; `thermos-ui-bug` 1.
- Files: `src/hooks/recording-dispatch.ts` 142-171, `src/hooks/useTimelinePlayback.ts` (`handleStop` near 1155 and the transport intent token it already keeps: `transportIntentToken`), tests.
- Shape: `finishTransport` reserves the transport intent synchronously and the delayed `finish` runs only if no newer intent was reserved.

```ts
const intent = playback.reserveTransportIntent()        // synchronous; a ruler seek and Play reserve the same counter
try { await stopRecording() } catch { /* reported by the settlement */ }
finally { if (!disposed) await finish(intent) }         // playback.stop(intent) keeps the playhead when intent is stale
```

- Must not change: immediate Stop when nothing is recording, pause semantics, Ableton behavior (Stop returns to the start marker only when it is the latest transport action).
- Test first: record, Stop, seek to 20 s while the take saves, expect the playhead at 20 s and transport stopped.
- Validation: `bun --conditions=browser test --timeout 30000 src/hooks/recording-dispatch.test.ts` (**verify** file name), V-HT, V-PB, CERT (`useTimelinePlayback.ts`, 578 arms plus siblings; split into runs of about 170).
- Commit: `fix(recording): a Stop that waited for the take to save no longer resets a playhead the user moved meanwhile`

#### P38. Playback compile identity has one owner (complex, K)

- Closes: S§2.7 "playback compile identity spread" (`Timeline.tsx:461`, `useTimelinePlayback.ts` 2128-2152), `untangle-ui-engine` decision 3 (S6), `Timeline.tsx:2527` instrument-change queue.
- Shape: the compiler module exports `playbackClipFingerprint(clip)` built from the same field list it reads; the hook calls it instead of rebuilding the list and defaulting offsets itself.
- Constraint: the killer test `C0G the clip fingerprint names every clip field…` (`useTimelinePlayback.test.ts:8858`) must keep its name and keep failing ledger:502, ledger:509 and rc2:404:1. Rewrite its assertions around scheduling output changes in P47, not here; here it must still pass unchanged.
- Validation: V-HT, V-C, `bun --conditions=browser test --timeout 30000 src/components/Timeline.test.ts`, CERT (`useTimelinePlayback.ts`, `Timeline.tsx`), `gate:f-c0g`.
- Commit: `refactor(playback): the compiler owns the clip fingerprint the hook used to rebuild field by field`

#### P39. Desired-session reconciliation leaves the hook (high-risk, K; depends on P38)

- Closes: S§2.2 `useTimelinePlayback.ts` size; `thermos-ui-quality` 3; `untangle-ui-engine` S17.
- Files: create `src/hooks/playback-session-reconciliation.ts` holding `previewProjectionBaseline`, `adoptionKey`, the two compiled fingerprints and the paused-preview effect logic (1579-1656, 2272-2310). The native capability checks (`audioHostBridge.session.revisions && …configureInstrumentStates`) stay only in the controller (3537-3544), which returns a backend-neutral outcome the hook consumes.
- Must not change: adoption timing, the Solid reactive graph (effects stay in the hook's owner; the new module exports plain functions and one `create…` that the hook calls once, per `AGENTS-solid.md`).
- Validation: V-HT, V-PB, V-PORT, V-C, V-TS, V-LINT, CERT (hook arms, hook fuzz seed shards, `gate:x-matrix,gate:x-probe160,gate:f-hookwit,gate:f-b6family`).
- Done when: `useTimelinePlayback.ts` is at or under the U4 target (recommended 2,100) and the capability expression appears once in `src`.
- Commit: `refactor(playback): schedule reconciliation state has one owner outside the playback hook, and backend capability checks stay in the controller`

### Track L: `src/lib` and UI outside the playback core

#### P40. Three renderer bugs with local fixes (complex, L)

- Commit 1, S§1.6 (`thermos-ui-bug` 2): `src/hooks/useTimelineAutomationController.ts` 438-473. On a refused re-enable, restore only this operation's keys into the current set:

```ts
setOverriddenAutomationTargetKeys((latest) => new Set([...latest, ...reEnabledTargetKeys]))
```

  and skip the completion when a newer re-enable started (operation counter). Test first: re-enable A, override B while pending, refuse; expect {A, B}.
- Commit 2, S§1.7 (`thermos-srclib-bug`): `src/lib/clip-drag-commit.ts` 142-170. Read each compensation result. Clips whose compensation failed stay at their new position in the projection, get a move history entry (`pushMoveHistory` with only those moves), and `cleanupUnusedAddedTrack` runs only when no remaining clip is on the added track.
- Commit 3, S§2.7 small items: `src/components/timeline/TimelineRuler.tsx` 72-108 (delete the six empty `try/catch` around listener attach and remove), `src/lib/midi/midi-recording-controller.ts` 186, 197 (return the failed stage and reason), `parameter-gesture-owner.ts:303` (report the failed repair as its own outcome; 8 arms anchor in this file: CERT), `local-write-queue.ts` 173-182 (unregister when the project's queue is disposed).
- Validation: `bun --conditions=browser test --timeout 30000 src/hooks/useTimelineAutomationController.test.ts src/lib/clip-drag-commit.test.ts src/lib/midi` (**verify** file names), V-SYNC, V-TS, V-LINT, CERT for `parameter-gesture-owner.ts`.
- Commits: `fix(automation): a refused re-enable restores only its own lanes and keeps overrides made meanwhile`; `fix(timeline): a group clip move whose compensation fails keeps the moved clips undoable`; `fix(timeline): ruler listeners, MIDI cleanup and gesture repair report failures instead of swallowing them`

#### P41. Durable completions are acknowledged, not evicted (complex, L)

- Closes: S§1.15; S§2.7 outbox effects-specific path (`shared-outbox.ts:892`); `untangle-src-lib` decision "durable completion retention"; `untangle-ui-engine` S3 (`parameter-gesture-owner.ts` 4, 27); S§2.5 wrapper `create-effects-panel-audio-effects-state.ts:59`.
- Files: `src/lib/shared-outbox.ts` 890-900, 1092-1110, `src/components/timeline/parameter-gesture-owner.ts` 4, 27, 324-337, `create-effects-panel-audio-effects-state.ts:59`, tests (`shared-outbox.test.ts`, and move the `3B1 admitted panel completions…` scenario out of `native-playback-controller.test.ts:14477` in P48).
- Shape: the cap evicts only completions marked consumed; an unconsumed completion is kept until its owner consumes it or the project is deleted. The gesture owner receives decoded results through the adapter it already accepts and stops importing outbox internals. `publishEffectOperation` is inlined at its one product call site.
- Must not change: `MAX_OUTBOX_COMPLETIONS_PER_USER` as the bound on consumed history; the durable publication result for callers other than effects.
- Test first: 65 admitted writes with none consumed, then consume the first; expect its real result, not `committed-unordered`.
- Validation: V-SYNC, `bun --conditions=browser test --timeout 30000 src/hooks/pointer-gesture-ownership.browser.test.ts`, `bun --conditions=browser tools/acceptance/dv01-boundary-witnesses.ts --out /tmp/dv01-boundary` (it calls `publishDurableEffectsOperation`), V-TS, CERT (`parameter-gesture-owner.ts`, `gate:rc1-i7-boundary,gate:rc1-i4-consumers`).
- Commit: `fix(outbox): a completion its owner has not consumed is never evicted by the history cap`

#### P42. Processor identity and synth live fields have one definition (complex, L)

- Closes: S§2.4 `processorKindId` (`create-processor-edit-registry.ts` 15-35), synth live fields ×3 (`native-built-in-parameter-mapper.ts:153`, `native-schedule-coordinator.ts:129`, `portable-browser-playback-controller.ts:350`); `thermos-ui-quality` 4; `untangle-src-lib` decision 2 (S7); `untangle-ui-engine` S5 (`Timeline.tsx:2569`).
- Files: create `src/lib/processor-edit-semantics.ts` (below the UI): `processorKindId` resolved from the generated `processorRegistry` (`@daw-browser/audio-core-contract/generated`), the synth discriminator, and `SYNTH_LIVE_FIELDS` as one `as const`-free readonly tuple typed with `satisfies`. `native-built-in-parameter-mapper.ts` and `portable-browser-playback-controller.ts` stop importing from `src/components/timeline/**`; `create-processor-edit-registry.ts` imports from the new module. Remove the empty target and instance ids and tempo `120` placeholders at `native-built-in-parameter-mapper.ts:617` by giving the mapper a payload type that does not need them.
- Must not change: every numeric id (assert equality with the old switch in a test written first), the `x-wasm-contract-hash` value.
- Risks: `create-processor-edit-registry.ts`, the mapper and `live-processor-control.ts` are fuzz sources of both fixtures; `portable-browser-playback-controller.ts` has 66 arms.
- Validation: V-C, V-COORD, V-PORT, V-HT, V-SYNC, V-TS, CERT (arms of the portable controller; both fuzz fixtures).
- Commit: `refactor(playback): processor kind ids come from the generated registry and the synth live fields are listed once, below the UI`

#### P43. Desired playback state is captured independently of export, and sampled-instrument preparation is target-scoped (complex, L; two commits)

- Commit 1 closes S§2.7 "export/playback desired-state coupling" (`live-playback-snapshot.ts:4`, `run-export-job.ts` 580, 703, `capture-local-export-render-rows.ts:14` `skipFlush`); `untangle-src-lib` S16. Create `src/lib/desired-playback-state.ts` exporting `resolveDesiredPlaybackFx` and the row snapshot types; `live-playback-snapshot.ts` and `run-export-job.ts` import it. Export flushes pending writes as its own step and then captures; the `skipFlush` option is deleted.
- Commit 2 closes S§2.7 "sampled-instrument native publication callbacks" (`sampler-buffer-sync.ts` 907, 1002, `drum-rack-buffer-sync.ts` 459, 494, `run-export-job.ts:733` `nativeExport`, `create-effects-panel-state.ts:684`); `untangle-src-lib` S8 to S10. One `prepareSampledInstrument(target, policy)` used by both synchronizers; the backend memory policy (`live` or `nativeExport`) is one argument built by the caller, not a flag tested through the loader. `create-effects-panel-state.ts` has 4 arms: CERT.
- Must not change: export output bytes, memory accounting results (the test at `run-export-job.test.ts:1077` is rewritten in P48 and must still pass here), instrument readiness order.
- Validation: `bun --conditions=browser test --timeout 30000 src/lib/export`, V-BUF, V-SYNC, V-HT, V-TS, CERT (`live-playback-snapshot.ts` is a controller fuzz source; `create-effects-panel-state.ts`).
- Commits: `refactor(export): playback and export read one desired-state module; export flushes, then captures`; `refactor(instruments): sampler and drum rack share one target-scoped preparation with an explicit memory policy`

#### P44. Local project deletion, undo structure plan, portable controller obligations, effects ingestion (complex, L; four commits, may be split across two workers by file)

- Commit 1, S§2.2 `local-project-db.ts` (797-1007); `thermos-srclib-quality` 3. Move `startLocalProjectDeletionCleanup`, `recoverAbandonedDirectoryCopies`, `finishLocalProjectDeletion`, `retainedAssetPaths`, `removeDeletedProjectFiles` to `src/lib/local-project-deletion.ts` with explicit catalog, connection-close and root-reference inputs. The directory-reference publication (969) takes the lock handles as arguments so the project→root order is in the signature (`local-assets.ts:313`). Done when `local-project-db.ts` is under 800 lines.
- Commit 2, S§2.7 undo structure interpreter (`src/lib/undo/project-track-structure.ts:35` vs `src/lib/undo/exec.ts` 776, 906; `src/lib/track-recording-target.ts:97`). One `planStructuralTransition(entry, direction)` returns the steps; the recording guard inspects the plan and `exec.ts` executes it.
- Commit 3, S§2.7 swallowed errors in `src/lib/portable-browser-playback-controller.ts` 1431, 2033, 2201, 2230; `untangle-src-lib` S11 to S13. Adoption failures carry `retryable | unsupported`; unsupported content does not enter the eight-resubmit backoff; a failed asset release stays in the due set. 66 arms: CERT.
- Commit 4, S§2.7 local/cloud effect-row ingestion (`useEffectsPanelAudioSync.ts` 165-202, 395; `create-effects-panel-controller.ts:243`; `create-local-effects-view.ts:86`), effect domain identity (`audio-effect-parameter-payload.ts:28`, `create-effects-panel-audio-effects-state.ts:687`), S4 (`create-persisted-effect-state.ts:105`, `create-effects-panel-controller.ts:338`), outbox retry lifecycle (`useTimelinePersistenceController.ts` 99-104, S10, S11). One ingestion function builds the instrument and arpeggiator indexes for both row formats; the publication owner owns readiness; the outbox owns its retry deadline and exposes `onRetryDue`.
- Remaining L comments: `local-timeline-repository.ts:463` (duplicate), `portable-browser-playback-controller.ts` 466, 517, 2214, `run-export-job.ts:580`, `shared-outbox.ts:890`, `undo/builders.ts:511`, `undo/exec.ts:487`, `undo/types.ts:288`, `audio-effect-parameter-payload.ts:17`, `useSteppedValueControl.ts` 56, 68, 102, 149, `useTimelineMidiOverlay.ts` 31, 86.
- Validation: `bun --conditions=browser test --timeout 30000 src/lib/local-project-db.test.ts src/lib/undo src/lib/track-recording-target.test.ts` (**verify** names), V-PORT, V-SYNC, V-HT, V-TS, V-LINT, CERT (portable controller; `gate:f-portable,gate:f-audiosync,gate:rc1-i3-sync`).
- Commits: `refactor(local): project deletion and recovery have their own module`; `refactor(undo): recording guards and undo execution share one structural transition plan`; `fix(playback): the portable controller keeps failed releases as obligations and does not retry unsupported content`; `refactor(effects): local and cloud effect rows share one ingestion and the outbox owns its retry`

### Track T: renderer tests (after track K; serial; every phase runs CERT)

#### P46. Overlapping parameter releases are each undoable (complex, T; decision U3)

- Closes: S§1.14; S§3 known-red B5c3 (`useEffectsPanelAudioSync.test.ts` 1701-1725).
- Recommended: fix the product so two overlapping releases push two history entries, rename the tests to `B5c3 simultaneous releases are each undoable, …`, assert `toHaveLength(2)` unconditionally and delete `DV01_B5_STRICT_HISTORY`.
- Certification: gates `f-strict-history` and `rc1-i5-strict-history` record 2 fails with `-t "B5c3 known-red simultaneous release"`. The hand record changes both gates' `command.argv` filter, `command.env`, and `judge` (exit 0, 2 pass, no fails), citing the P00 ruling (the `--allow-now-passing` rule in `bless-rules.ts` is the precedent). `f-audiosync` and `rc1-i3-sync` counts stay 326.
- Validation: V-SYNC, CERT with `gate:f-strict-history,gate:rc1-i5-strict-history,gate:f-audiosync,gate:rc1-i3-sync`.
- Commit: `fix(effects): overlapping parameter releases each record their own undo entry`

#### P47. Remove the AST and `new Function` extraction harness (high-risk for certification, T)

- Closes: S§3 AST extraction (`useTimelinePlayback.test.ts` 242, 7533, 8858; `portable-browser-playback-controller.test.ts` 49, 59, 1575; `instrument-buffer-sync.test.ts` 1689, 1793; `src/lib/timeline-source-test-support.ts:37`).
- Shape: export the real boundary instead of extracting source. The functions the harness slices out of `Timeline.tsx` (instrument-ready handling, processor delivery wiring) move to a small module (`src/components/timeline/timeline-playback-wiring.ts`, **name to be confirmed by the worker from what is extracted**) that `Timeline.tsx` and the tests both import. Delete `timeline-source-test-support.ts` and the test `3B1 r3 extraction ignores stale commented callbacks…`.
- Killers: `B6f5 A a mixer, master, automation or instrument edit while playing…` (fixture at 7533) and `C0G the clip fingerprint…` (8858) keep their names and must still fail ledger:482, ledger:490, ledger:502, ledger:509, rc2:404:1. `C0G` is rewritten to assert that changing each scheduling field changes the compiled schedule and that name, colour and waveform key do not.
- Certification: removal manifest `removals/pr62-renderer-tests.json`; `Timeline.tsx` anchors (4 arms); the `x-matrix` and `x-probe160` gates preload an overlay that appends to `useTimelinePlayback.test.ts`, so the file must stay loadable by `product-overlay.ts` (keep the `"--conditions=browser", "-e", \`` child-spawn anchor at exactly one occurrence).
- Validation: V-HT, V-PORT, V-BUF, `bun --conditions=browser test --timeout 30000 src/components/Timeline.test.ts`, V-TS, CERT (all hook arms, `gate:x-matrix,gate:x-probe160,gate:f-c0g,gate:f-b6family,gate:last-buffer`).
- Commit: `test(playback): hook and portable tests import the Timeline wiring they exercise instead of extracting its source`

#### P48. Internals witnesses and fixture reimplementations (complex, T)

- Closes: S§3 `native-playback-controller.test.ts` 8905, 8960, 14477; `run-export-job.test.ts:1077`; `create-effects-panel-audio-effects-state.test.ts:441`.
- 8905 and 8960 are killers (rc2:257:0, rc2:259:0, rc2:260:0): keep the names; replace retained-intent keys, candidate counts and the structural counter with bridge observations (release acknowledgements, compile count seen by the compile spy, replacement-session calls) and prove the three mutants still fail. If a mutant cannot be killed by a behavioral assertion, keep the one internal assertion that kills it and say so in the record (do not retire the arm without a ruling).
- 14477 moves to `shared-outbox.test.ts` or the gesture owner test as a public completion-consumption test (a move is recorded as removal plus addition with a name-diff).
- `run-export-job.test.ts:1077`: expected charges come from the mapping and staging allocations the fake records, not from the production rounding formula. `…audio-effects-state.test.ts:441`: use the real identity registry.
- Validation: V-C, V-SYNC, `bun --conditions=browser test --timeout 30000 src/lib/export/run-export-job.test.ts`, CERT (controller arms, `gate:f-controller,gate:rc1-g-controller,gate:f-audio-effects`).
- Commit: `test(desktop): candidate retention and completion tests assert bridge behavior, not controller internals`

#### P49. UI source-text tests and the lifecycle browser fixture (complex, T; decision U5b)

- Closes: S§3 `Timeline.test.ts` 90, 178; `create-effects-panel-device-collapse.test.ts:101`; `useTimelineMidiOverlay.test.ts:122`; `TimelineRuler.browser.test.ts:7`; `native-playback-lifecycle.browser.test.ts` 50, 63, 149.
- `TimelineRuler.browser.test.ts`: the runtime throws when the ruler element is missing (lines 45 and 154 return silently today) and the test requires the expected scenario keys.
- `Timeline.test.ts` 90 and 178, device-collapse 101, MIDI overlay 122: rewrite as rendered-component or hook tests (held preparation with a real callback; dispatched selection clicks; visible notice and accessible status; docked-clip change and live-note cleanup).
- `native-playback-lifecycle.browser.test.ts` (manifest-watched, 4 arms as witness, gate `rc1-i6-browser` 17 pass): replace the source rewrite of `useEffectsPanelAudioSync.ts` at 59-66 with a fixture input (the fixture supplies `roomEffects` so the product condition holds without editing source); remove the historical baseline loaders at 48-58, 68-80 and 148-150 per U5b.
- Validation: V-PB, `bun --conditions=browser test --timeout 30000 src/components/Timeline.test.ts src/components/timeline src/hooks/useTimelineMidiOverlay.test.ts`, CERT (`gate:rc1-i6-browser`, arms witnessed by the lifecycle test and `Timeline.test.ts`).
- Commit: `test(ui): timeline, ruler, MIDI overlay and lifecycle tests render and interact instead of matching or rewriting source`

### Cross-language contracts and close-out

#### P50. Recording format and plug-in fault classes are generated once (complex, after tracks N and D)

- Closes: S§2.4 recording-spool format (`recording-spool.ts` 95-98 literal 2048 vs `native/audio-host-macos/src/recording-spool.cpp` 85, 228), plug-in fault classification (`native-vst3-coordinator.ts:438` vs `native/plugin-host/src/worker-supervisor.h` 360, 368); `untangle-native` decision 4; S§3 `plugin-host-protocol/src/index.test.ts:478`.
- Shape: follow the existing generator precedent (`native/audio-core/scripts/generate-compiled-processors.ts --check`, `native/audio-core/generated/processor_contract_generated.h`): one TypeScript source of truth in `packages/plugin-host-protocol` (fault classes, the zero-diagnostic rule as a named class) and `packages/desktop-protocol` (spool block header bytes, sample bytes, maximum block frames), a generated C++ header, and a `--check` step wired into the same script that `test-native.sh` runs. Each side keeps its own validation at its trust boundary.
- Must not change: the on-disk spool format, fault outcomes.
- Validation: V-NHOST, V-NPLUG, V-NCORE, V-DESKTOP, `bun test --conditions=browser --timeout 30000 packages/plugin-host-protocol`, V-TS.
- Commit: `refactor(protocol): the recording spool format and plug-in fault classes are defined once and generated for the native host`

#### P51. Final sweep, full certification and PR text (complex, parent-led)

See section 6.

---

## 4. Dependencies and parallel groups

Serial chains (arrows mean "before"):

- Native: P09 → P05; P01 → P02 → P06 → P07 → P08 → P10 (all edit `audio-host.cpp` or `audio_core.cpp`; batch wasm re-pins). P03 and P04 can go anywhere in the chain.
- Desktop: P11 → P18 → P19; P12 → P14 → P15; P13 → P16 → P17; P20 last (it touches `main.ts`, `audio-host.ts` and the tests the others change).
- Playback core: P30 → P31 → P32 → P33 → P34 → P35 → P36 → P37 → P38 → P39.
- Renderer tests: P46 → P47 → P48 → P49, after P39 and P45.
- P50 after tracks N and D. P51 last.

Groups that can run in parallel in separate git worktrees because they do not edit the same files (the certification files are written only at the integration points P24, P29, P45 or by track K and T workers, never by two worktrees at once):

| Group | Worktrees that can run at the same time |
|---|---|
| G1 | Track N (P01 to P10) ∥ Track D chain 1 (P11, P18, P19) ∥ Track X (P21) ∥ Track A (P22, P23, P25, P26, P27) ∥ Track K (P30 onward) |
| G2 | Inside track D, after P11: chain P12 → P14 → P15 (`native-vst3-coordinator.ts`) ∥ chain P13 → P16 → P17 (`audio-host.ts`, `ae08-evidence.ts`). Both touch `main.ts` in small, separate regions; merge P13 before P19. |
| G3 | Track L phases P40, P41, P44 commits 1 and 2 can run while track K is in P32 to P36 (no shared files). P42, P43 and P44 commits 3 and 4 touch fuzz sources or anchored files and run when track K is idle, one at a time. |
| G4 | Inside track A: P23 ∥ P26 ∥ P27; P25 after P22. |

Shared-file cautions: P30 edits `apps/desktop/preload.ts` and `src/types/desktop-bridge.ts`, which P13 and P20 also edit (merge P13 first). P17 edits two `tools/acceptance` mocks and `useTimelinePlayback.test.ts` (one line each); land it before track T. P22 changes an import path in three `src` tests; land it before P46.

---

## 5. Decisions for the user

| # | Decision | Recommended | Why |
|---|---|---|---|
| U1 | Must a changed captured VST state for an unchanged plug-in reload it (S§1.8)? Options: (a) always reload when the state hash differs, (b) reload unless the new state is the one the host last captured from that running instance, (c) never, and stop the controller submitting state changes. | (b) | Undo, redo and project load must restore the plug-in's state, which today is silently skipped. A capture taken from the running instance already matches it, so reloading it would glitch audio for no change. |
| U2 | Env-driven real-plug-in native tests (`audio_host_test.cpp` 6548 and the roughly 20 `DAW_AE08_*_ONLY` selectors in `main`). | Register the five real-plug-in tests as their own ctest entry that reports "skipped" when the test bundle is missing; keep `run-ae08-test-plugin.ts` as the runner that builds the bundle; delete the `*_ONLY` selectors no script in `tools/` sets. | A test that silently runs nothing looks green. The selectors are leftovers from bisecting. |
| U3 | B5c3 (S§1.14): fix the product so each overlapping release is its own undo step, or accept one entry and delete the strict mode? | Fix the product. | Ableton records each parameter change as its own undo step; the test already states that contract. |
| U4 | Line-count targets. The reviews apply a 1,000-line rule; `native-playback-controller.ts` was 2,314 lines before this PR. | Targets for this cleanup: controller ≤ 3,300, `audio-host.ts` ≤ 2,800, `main.ts` ≤ 2,450, `useTimelinePlayback.ts` ≤ 2,100, `live-mixer-runtime.ts` < 1,000, `local-project-db.ts` < 800, `native-vst3-coordinator.ts` < 700. `audio_core.cpp` (10,728) and `audio-host.cpp` (6,499) get structure fixes only. | Getting the pre-existing giants under 1,000 lines is a separate project; each extra split costs a full CERT run over hundreds of arms. |
| U5 | `native-revision-controller.ts` and `native-live-graph.browser.test.ts`: delete both and retire gate `rc1-g-native-live-graph-browser`, or rewrite the browser test onto the production controller? | Delete both (P36). | The test exercises a lifecycle policy production does not use; the production path has its own browser test. |
| U5b | Historical baseline modes in `native-playback-lifecycle.browser.test.ts` (`DAW_INSTRUMENT_R20/R21/R22…BASELINE`, `beforeFix` loading archived controllers from `acceptance-reports/`). Acceptance-only tests under `tools/acceptance`. | Remove the baseline modes from the product test; keep `tools/acceptance/*.test.ts` because FAST-CERT gates run them. | The reproductions are archived as evidence; replaying history from a product test ties it to report directories and to source text. |
| U6 | Desktop mirror of native parking (S10, S11): remove it (P15) or keep it and import the limits from the native hello? | Remove, if the verdict cache already avoids the repeated preflight; otherwise carry the limits in the hello. | Two clocks and two comparisons of "same plug-in" will drift. |
| U7 | `audio-host.ts:2049` accepts four schedule-progress payload sizes (S20, need unconfirmed). | Accept only the current size. | The app and host ship together and the hello already requires the current frame protocol version. Confirm no older packaged host is supported. |
| U8 | `DAW_AE08_RENDERER_PROFILE` (renderer CPU profile per commit) has no runner consumer, only a README line. | Delete it and the README line. | The rule for this cleanup is "delete hooks nothing uses"; the Chromium trace switch covers the same need. Keep it if you still use it by hand. |
| U9 | PCM range semantics differ: `audio-pcm-source.ts` clamps, `media-pages.ts` rejects. | Keep both, as two named functions over one validator (P26). | Making them equal changes behavior for one caller, which this cleanup must not do. |
| U10 | Rewritten killer tests (P47, P48): if a mutant can only be killed by an internal assertion, keep that assertion or retire the arm into `test-debt.md`? | Keep the minimal internal assertion. | A retired arm is a known gap; the cleanup should not widen the debt list. |
| U11 | Test removals need a ruling file that the removal manifests cite. | The parent writes `acceptance-reports/pr62-cleanup/PARENT-RULING-PR62-TEST-CLEANUP.md` in P00 from these answers. | `bless-rules.ts` refuses a removal manifest whose ruling file does not exist. |
| U12 | Where the cleanup lands. | A branch stacked on `production-dsp-characterization`, merged into the PR branch after P51. | Keeps PR #62's 350 commits reviewable apart from about 60 cleanup commits, and lets worktrees branch from one base. |
| U13 | `expectations.json` carries a dated note: drop the seed summary hash judge after 2026-11-17 (today). | Drop it in P51's bless. | The note's own end date has arrived; it removes a diagnostic that would otherwise move with every controller refactor. |
| U14 | Packaged AE-08 acceptance (phase 8 and 9 runners) after the cleanup. | Run the phase 9 `--matrix cert` preset once at the end. | Refactors of the publication path are proven by tests and fuzz, but latency gates are only measured in the packaged app. |

---

## 6. Final verification (P51)

1. Suites, all on the merged tree: V-TS, V-LINT, V-BUILD, `bun test` shards as `tools/certification/record-test-baseline.ts` runs them (known reds must equal `test-baseline.json`; re-record only if a known red was fixed on purpose), V-HT, V-C, V-COORD, V-PB, V-PORT, V-SYNC, V-BUF, V-ENGINE, V-CONVEX, V-DESKTOP, `bun run test:control-platform`, `bun run test:control-compat`, `bun run test:anti-slop`, `bun run knip`.
2. Native: V-NCORE, V-NHOST, V-NPLUG, V-RTG, V-WASM, and the audio-core sanitizer preset (`(cd native && cmake --preset audio-core-sanitized && cmake --build --preset audio-core-sanitized)` then its ctest).
3. FAST-CERT: `bun tools/certification/bless-rules.ts`; `caffeinate -dimsu bun tools/certification/fast-cert.ts --full --out /tmp/fast-cert/pr62-final` must print `PASS`; then `bun tools/certification/fast-cert.ts --bless pr62-cleanup --full` to move the watched hashes (it refuses anything `bless-rules.ts` refuses). Confirm `test-debt.md` lists no new arm unless U10 said so. Commit: `chore(certification): bless the PR 62 cleanup tree`.
4. Line counts (`wc -l`), against U4: `native-playback-controller.ts`, `apps/desktop/audio-host.ts`, `apps/desktop/main.ts`, `src/hooks/useTimelinePlayback.ts`, `packages/audio-engine/src/live-mixer-runtime.ts`, `src/lib/local-project-db.ts`, `apps/desktop/native-vst3-coordinator.ts`. Record them beside the P00 baseline.
5. Re-run the searches that produced the findings; each must return nothing or only the listed composition roots:
   - `rg -n 'DAW_AE08_|ae08' apps/desktop src packages native --glob '!*.test.*' --glob '!native/build/**'`
   - `rg -n 'acceptanceExternalNativeSession|__dawRecording|beforeReleaseUnlink|sendBlock\(|onRecordingBlock|createNativeVst3RevisionCoordinator|native-revision-controller|timeline-source-test-support|DV01_B5_STRICT_HISTORY|known-red'`
   - `rg -n 'new Function\(|readFileSync\([^)]*\.(tsx?|cpp|h)["\x27`]' --glob '*.test.ts' src apps packages native` (source-reading tests)
   - `rg -n 'catch \{\s*\}|catch\(\(\) => (undefined|false)\)' src apps packages --glob '!*.test.*'` (each remaining hit has a comment naming the external reason)
   - `rg -n '\bas [A-Z]' ` over the files this cleanup touched (no new casts)
   - Then re-run the thermos bug and quality reviews and the four untangle passes on the cleanup diff only; expected: no finding from the synthesis recurs.
6. Packaged acceptance per U14, with the report under `acceptance-reports/pr62-cleanup/`.
7. Update PR #62: title and description must describe the whole branch (AE-08 native live graph edits, VST3 hosting, recording spool, playback controllers, certification tooling) and this cleanup (bugs fixed with their S§1 numbers, modules added and removed, tests removed with the ruling path, certification records written). S§0 notes the current text describes only the first commit.

## 7. Coverage notes

Findings assigned to a phase but not spelled out above:

- `apps/desktop/native-session-schemas.ts:33` rejecting explicitly undefined optional fields, which forces the special command builder at `src/components/timeline/external-plugin-editor.ts:29` (`untangle-desktop-backend` S15): P20, as one more commit. Share one command encoder between the renderer and the schema; keep the rejection.
- `src/lib/recording/recording-diagnostics.ts` 207-221 globals and `apps/desktop/benchmark-runtime.ts:20` importing the renderer trace (`untangle-src-lib` S6): P18. The globals are read by `tools/performance/30-track/tier-three.ts`, so they move to one adapter module (`src/lib/recording/recording-delivery-evidence.ts`) that the diagnostics module calls through an optional observer; `createRecordingDeliveryTrace` moves to a module both sides may import.
- Acceptance timing scopes at `native/plugin-host/src/vst3-worker.cpp:569` and `native/audio-host-macos/src/main.cpp:950` (`untangle-native` decision 1): P05. They stay, as calls on the observer.
- `native/audio-core/tests/graph-parity-fixtures.ts` 1896 and 2230 (`legacyStartFrame` skips transition prefixes): P10. Add an independent expectation for the transition waveform; keep the existing silence and energy checks.
- Count of restating comment blocks: about 74 (27 desktop and Convex, 12 native, 13 `src/lib`, 22 UI and engine). Each is deleted in the phase that owns its file; P51 step 5 confirms none is left by re-running the untangle comment pass.

Findings deliberately left as they are, with the external reason kept in a comment (the untangle reports list them as constraint-driven): interrupted-syscall retries and no retry on `close` (`recording-spool.cpp` 20, 63), the 100-microsecond realtime bridge poll (`audio-host.cpp:2234`), portable-only FFT stage replacement (`audio_core.cpp:7692`), the one-second patch wait (`revision-publication-wait.h:24`), the wheel-gesture idle timer (`effect-parameter-interaction.tsx:40`), the animation-frame preview coalescing (`parameter-gesture-owner.ts:448`), one-shot loop bound collapse (`portable-session-compiler.ts:185`), the unstamped-row sentinel (`convex/effects.ts:367`), and `native-playback-inputs.ts` (three acceptance fixtures import it).
